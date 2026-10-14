/**
 * Old-growth and mature forest on US federal land, summed per fireshed (about 250,000-acre accounting units).
 * Service (verified live 2026-10-10, keyless): US Forest Service Washington Office, Fireshed Registry gap analysis,
 *   https://apps.fs.usda.gov/fsgisx02/rest/services/wo_nfs_gstc/WO_OSC_GapAnalysis_OldGrowthAndMatureForests/MapServer/29
 *   "Fireshed Mature and Old Growth Area, Federal Lands Only (polygon)": 2,192 polygons, maxRecordCount 200 (the
 *   service caps well below ArcGIS's usual 2000, and reports exceededTransferLimit when it does).
 * Fields used: Fireshed_Name ("Battle Peak, Oregon"), OLD_GROWTH_ACRES and MATURE_ACRES (integers; plot-based
 * Forest Inventory and Analysis estimates, not a map of stands), OLD_GROWTH_SE_PERC and MATURE_SE_PERC (their standard
 * error in percent), ForestType (dominant type, e.g. "Douglas-fir"). Shape_Area/Trimmed_Area are not used (units unclear).
 * Output properties: name, oldGrowthAcres, matureAcres, v (= oldGrowthAcres), oldGrowthErrorPercent, matureErrorPercent,
 * forestType. Biggest first (OLD_GROWTH_ACRES DESC) so a capped view keeps the oldest forests.
 * Smoke through runLayer (2026-10-10): Oregon Cascades box -122.5,43,-120.5,45 returned 59 firesheds in 0.4 s (235 KB); the McCredie
 * Springs fireshed holds 130,822 acres of old growth, the most in that box. Washington Cascades -123.5,47,-121.5,48.5 returned 26 (62 KB);
 * Utah -110,40,-109,41 returned 19 (121 KB).
 * Smoke wide (2026-10-14): Pacific Northwest -125,42,-116,49 (about 600,000 km²) returned all 390 firesheds of 390 in 2.6 s (1.2 MB:
 * federal-land firesheds carry many small holes, which simplification cannot remove), McCredie Springs first.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { arcgisCount, arcgisQuery, type ArcgisResult } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

const SERVICE_URL =
  "https://apps.fs.usda.gov/fsgisx02/rest/services/wo_nfs_gstc/WO_OSC_GapAnalysis_OldGrowthAndMatureForests/MapServer/29";

const FIELDS = ["Fireshed_Name", "OLD_GROWTH_ACRES", "MATURE_ACRES", "OLD_GROWTH_SE_PERC", "MATURE_SE_PERC", "ForestType"];

/** The service's own page limit. */
const MAX_RECORDS = 200;
/** Estimates are for 2020s inventory cycles and change slowly. */
const TTL_SECONDS = 7 * 86_400;

/** Most firesheds in a wide result: five of the service's 200-row pages, fetched in parallel. */
const WIDE_LIMIT = 1000;

const TRUNCATED_NOTE = "Showing the 200 firesheds with the most old growth in view; zoom in for the rest";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Display simplification in degrees: finer when zoomed in; firesheds are 1,000 km² blocks, so little detail is needed.
 * A wide box (over the soft cap) may go to 0.05 degrees.
 */
export function simplifyOffset(bbox: BBox, wide = false): number {
  const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
  return Math.min(wide ? 0.05 : 0.02, Math.max(0.002, span / 200));
}

/**
 * The same context with `resultOffset` added to every request URL, so arcgisQuery can fetch a later page of an ordered
 * query (the shared helper has no offset parameter and this service pages at 200).
 */
export function pageContext(ctx: QueryContext, offset: number): QueryContext {
  if (offset === 0) return ctx;
  const fetch = ((url: string, init?: Parameters<QueryContext["fetch"]>[1]) =>
    ctx.fetch(`${url}&resultOffset=${offset}`, init)) as QueryContext["fetch"];
  return { ...ctx, fetch };
}

/** Converts service rows to polygons with readable names and `v` = old-growth acres. */
export function normalizeOldGrowth(fc: FeatureCollection): FeatureCollection {
  const features: Feature<Geometry>[] = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const p = f.properties ?? {};
    const properties: Record<string, string | number> = { name: str(p.Fireshed_Name) ?? "Unnamed fireshed" };
    const oldGrowth = num(p.OLD_GROWTH_ACRES);
    const mature = num(p.MATURE_ACRES);
    if (oldGrowth !== undefined) {
      properties.oldGrowthAcres = oldGrowth;
      properties.v = oldGrowth;
    }
    if (mature !== undefined) properties.matureAcres = mature;
    const oldError = num(p.OLD_GROWTH_SE_PERC);
    if (oldError !== undefined) properties.oldGrowthErrorPercent = oldError;
    const matureError = num(p.MATURE_SE_PERC);
    if (matureError !== undefined) properties.matureErrorPercent = matureError;
    const type = str(p.ForestType);
    if (type !== undefined) properties.forestType = type;
    features.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return { type: "FeatureCollection", features };
}

const oldGrowth = defineLayer({
  id: "old-growth",
  title: "Old-growth and mature forest",
  description:
    "How much old-growth and mature forest the US federal government manages, in each fireshed: an accounting block of about 250,000 acres (roughly 1,000 km², the finest unit this data has) covering Forest Service and BLM land, from the Forest Service's 2023 mature and old-growth inventory. " +
    "Each polygon has name (the fireshed, such as Battle Peak, Oregon), v and oldGrowthAcres (acres of old-growth forest on federal land inside it), matureAcres (acres of mature forest that is not yet old growth), forestType (the commonest forest type, for example Douglas-fir) and oldGrowthErrorPercent and matureErrorPercent (the survey's standard error, in percent). " +
    "With 3D on, firesheds rise with their old-growth acres. " +
    "Use it for 'where is old growth', 'which national forests have the most mature forest' or 'how much ancient forest is left near here'. " +
    "Caveats: the figures are sample-based estimates (plots), so small firesheds and rare forest types carry large error, and the polygon is the whole fireshed, not the stands: old growth is not located inside it. " +
    "Only federal land is counted, so private, state and tribal forest are not. At most 200 firesheds are returned, those with the most old growth first, and the result says when it trims. " +
    "United States only. Over 300,000 km² (a 550 km square) it keeps the 1,000 with the most old growth.",
  coverage: "us",
  license: "Public domain (US Forest Service)",
  requiredEnv: [],
  maxAreaKm2: 300_000,
  wide: { orderBy: "old-growth acres", limit: WIDE_LIMIT },
  input: z.object({}),
  style: { geometry: "polygon", color: layerColor("old-growth"), unit: "acres", fillOpacity: 0.35, extrude: "v" },

  async query(ctx): Promise<LayerResult | LayerError> {
    const citation = {
      source: "US Forest Service, Mature and Old-Growth Forest inventory by fireshed (Fireshed Registry; public domain)",
      url: "https://www.fs.usda.gov/managing-land/old-growth-forests",
      retrieved: new Date().toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    // Wide (over 300,000 km²): a count first, then only the ordered pages it calls for (the service pages at 200, at most
    // five for the strategy's 1,000), in parallel and with coarser lines. A failed count fetches every page.
    const wide = ctx.wide === true;
    const total = wide ? await arcgisCount(ctx, SERVICE_URL, { bbox: ctx.bbox, ttlSeconds: TTL_SECONDS, cacheSuffix: "oldgrowth" }) : null;
    const maxPages = wide ? Math.max(1, Math.ceil((ctx.wideStrategy?.limit ?? WIDE_LIMIT) / MAX_RECORDS)) : 1;
    const pages = total === null ? maxPages : Math.min(maxPages, Math.max(1, Math.ceil(total / MAX_RECORDS)));
    const query = (offset: number): Promise<ArcgisResult> =>
      arcgisQuery(pageContext(ctx, offset), SERVICE_URL, {
        outFields: FIELDS,
        bbox: ctx.bbox,
        maxRecords: MAX_RECORDS,
        maxAllowableOffset: simplifyOffset(ctx.bbox, wide),
        orderByFields: "OLD_GROWTH_ACRES DESC",
        ttlSeconds: TTL_SECONDS,
        cacheSuffix: offset === 0 ? "oldgrowth" : `oldgrowth:${offset}`,
      });
    const results = await Promise.all(Array.from({ length: pages }, (_, i) => query(i * MAX_RECORDS)));
    const first = results[0];
    if (!first.ok) return { error: first.error, hint: "upstream" };
    // A later page that fails just shortens the result; the count still says how many there are.
    const features = results.flatMap((r) => (r.ok ? normalizeOldGrowth(r.fc).features : []));

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      ...(total !== null && { total }),
      ...(first.truncated && !wide ? { coverageNote: TRUNCATED_NOTE } : {}),
    };
  },
});

registerLayer(oldGrowth);

export default oldGrowth;
