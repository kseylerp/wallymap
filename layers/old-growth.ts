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
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

const SERVICE_URL =
  "https://apps.fs.usda.gov/fsgisx02/rest/services/wo_nfs_gstc/WO_OSC_GapAnalysis_OldGrowthAndMatureForests/MapServer/29";

const FIELDS = ["Fireshed_Name", "OLD_GROWTH_ACRES", "MATURE_ACRES", "OLD_GROWTH_SE_PERC", "MATURE_SE_PERC", "ForestType"];

/** The service's own page limit. */
const MAX_RECORDS = 200;
/** Estimates are for 2020s inventory cycles and change slowly. */
const TTL_SECONDS = 7 * 86_400;

const TRUNCATED_NOTE = "Showing the 200 firesheds with the most old growth in view; zoom in for the rest";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Display simplification in degrees: finer when zoomed in; firesheds are 1,000 km² blocks, so little detail is needed. */
export function simplifyOffset(bbox: BBox): number {
  const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
  return Math.min(0.02, Math.max(0.002, span / 200));
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
    "United States only. Zoom in to a region under 300,000 km² (about a 550 km square) first.",
  coverage: "us",
  license: "Public domain (US Forest Service)",
  requiredEnv: [],
  maxAreaKm2: 300_000,
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

    const area = bboxAreaKm2(ctx.bbox);
    if (area > oldGrowth.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${oldGrowth.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    const res = await arcgisQuery(ctx, SERVICE_URL, {
      outFields: FIELDS,
      bbox: ctx.bbox,
      maxRecords: MAX_RECORDS,
      maxAllowableOffset: simplifyOffset(ctx.bbox),
      orderByFields: "OLD_GROWTH_ACRES DESC",
      ttlSeconds: TTL_SECONDS,
      cacheSuffix: "oldgrowth",
    });
    if (!res.ok) return { error: res.error, hint: "upstream" };

    return {
      kind: "geojson",
      data: normalizeOldGrowth(res.fc),
      citation,
      ...(res.truncated ? { coverageNote: TRUNCATED_NOTE } : {}),
    };
  },
});

registerLayer(oldGrowth);

export default oldGrowth;
