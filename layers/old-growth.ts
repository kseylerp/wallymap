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
 * 2026-10-18: switched from layer 29 (the federal-land remainder of each fireshed, a checkerboard of slivers that read as a map of
 * federal land) to layer 31 "Fireshed Boundaries (Full)", the same fields (OLD_GROWTH_ACRES, MATURE_ACRES, standard errors,
 * ForestType) on the whole fireshed shape. The acres still count federal land only. Firesheds are filled by old-growth class
 * (OLD_GROWTH_CLASSES, an ordinal on the sage → pink → purple ramp) and old-growth acres is the Rank by and size measure.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { defineLayer, type Attribute, type BBox, type LayerError, type LayerResult, type LegendSpec, type QueryContext, type CardSpec, type FieldHelp } from "./types";
import { registerLayer } from "./registry";
import { arcgisCount, arcgisQuery, type ArcgisResult } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor, PINK, PURPLE, SAGE } from "@/lib/render/palette";
import { interpolateStops, rgbToHex } from "@/lib/render/ramp";

const SERVICE_URL =
  "https://apps.fs.usda.gov/fsgisx02/rest/services/wo_nfs_gstc/WO_OSC_GapAnalysis_OldGrowthAndMatureForests/MapServer/31";

const FIELDS = ["Fireshed_Name", "OLD_GROWTH_ACRES", "MATURE_ACRES", "OLD_GROWTH_SE_PERC", "MATURE_SE_PERC", "ForestType"];

/** The service's own page limit. */
const MAX_RECORDS = 200;
/** Estimates are for 2020s inventory cycles and change slowly. */
const TTL_SECONDS = 7 * 86_400;

/** Most firesheds in a wide result: five of the service's 200-row pages, fetched in parallel. */
const WIDE_LIMIT = 1000;

const TRUNCATED_NOTE = "Showing the 200 firesheds with the most old growth in view; zoom in for the rest";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

/** Old-growth acres in four classes, little to most, on the sage → pink → purple ramp. */
export const OLD_GROWTH_CLASSES: { value: string; label: string; min: number; color: string }[] = [
  { value: "under-5k", label: "Under 5,000 acres of old growth", min: 0, color: SAGE },
  { value: "5k-20k", label: "5,000 to 20,000 acres", min: 5_000, color: rgbToHex(interpolateStops([SAGE, PINK], 0.5)) },
  { value: "20k-50k", label: "20,000 to 50,000 acres", min: 20_000, color: PINK },
  { value: "50k-up", label: "50,000 acres and up", min: 50_000, color: PURPLE },
];

/** The class of an old-growth acreage. */
export function oldGrowthClass(acres: number): string {
  let value = OLD_GROWTH_CLASSES[0].value;
  for (const c of OLD_GROWTH_CLASSES) if (acres >= c.min) value = c.value;
  return value;
}

export const OLD_GROWTH_LEGEND: LegendSpec = {
  kind: "categories",
  title: "Old-growth forest in the fireshed",
  field: "oldGrowthClass",
  unit: "acres",
  items: OLD_GROWTH_CLASSES.map(({ value, label, color }) => ({ label, value, color, symbol: "polygon" as const })),
  note: "Federal land only; a fireshed is about 250,000 acres, and the old growth is somewhere inside it, not across it.",
};

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
      properties.oldGrowthClass = oldGrowthClass(oldGrowth);
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

const FS_URL = "https://www.fs.usda.gov/managing-land/old-growth-forests";
const FS_SOURCE = "US Forest Service, Mature and Old-Growth Forest inventory";

/** What a fireshed card's acres and errors mean (spec §12b). */
const HELP: Record<string, FieldHelp> = {
  v: {
    text:
      "Acres of old-growth forest on federal land inside this fireshed (an accounting block of about 250,000 acres), estimated from Forest " +
      "Inventory and Analysis plots; the polygon is the fireshed, not where the stands are.",
    unit: "acres",
    source: FS_SOURCE,
    url: FS_URL,
  },
  matureAcres: { text: "Acres of mature forest on federal land in the fireshed that is not yet old growth, from the same plot estimate.", unit: "acres", source: FS_SOURCE, url: FS_URL },
  oldGrowthErrorPercent: {
    text: "The survey's standard error for the old-growth acres, in percent: higher means a less certain estimate (small firesheds and rare forest types carry large error).",
    unit: "%",
    source: FS_SOURCE,
    url: FS_URL,
  },
  matureErrorPercent: { text: "The survey's standard error for the mature-forest acres, in percent: higher means a less certain estimate.", unit: "%", source: FS_SOURCE, url: FS_URL },
};

/** The fireshed card: old growth under its own name, mature forest, and how sure the estimates are. */
const ATTRIBUTES: Attribute[] = [
  {
    key: "oldGrowthClass",
    type: "ordinal",
    label: "Old-growth forest",
    scale: "Old-growth acres on federal land in the fireshed",
    levels: OLD_GROWTH_CLASSES.map(({ value, label }) => ({ value, label })),
    encode: "color",
    primary: true,
  },
  {
    key: "oldGrowthAcres",
    type: "measure",
    label: "Old-growth forest",
    unit: "acres",
    encode: "size",
    aggregate: "sum",
    presets: OLD_GROWTH_CLASSES.map((c, i) => ({ label: c.label, min: c.min, ...(i + 1 < OLD_GROWTH_CLASSES.length && { max: OLD_GROWTH_CLASSES[i + 1].min }) })),
  },
  { key: "matureAcres", type: "measure", label: "Mature forest", unit: "acres", aggregate: "sum" },
  { key: "forestType", type: "category", label: "Forest type" },
  { key: "name", type: "name", label: "Fireshed" },
];

const CARD: CardSpec = {
  measure: { key: "v", label: "Old-growth forest", unit: "acres" },
  facts: [
    { key: "matureAcres", label: "Mature forest", unit: "acres", format: "int" },
    { key: "forestType", label: "Forest type" },
    { key: "oldGrowthErrorPercent", label: "Old-growth standard error", unit: "%", format: "int" },
    { key: "matureErrorPercent", label: "Mature standard error", unit: "%", format: "int" },
  ],
  hidden: ["oldGrowthClass", "oldGrowthAcres"],
};

const oldGrowth = defineLayer({
  id: "old-growth",
  title: "Old-growth and mature forest",
  description:
    "How much old-growth and mature forest the US federal government manages, in each fireshed: an accounting block of about 250,000 acres (roughly 1,000 km², the finest unit this data has) covering Forest Service and BLM land, from the Forest Service's 2023 mature and old-growth inventory. " +
    "Each polygon has name (the fireshed, such as Battle Peak, Oregon), v and oldGrowthAcres (acres of old-growth forest on federal land inside it), matureAcres (acres of mature forest that is not yet old growth), forestType (the commonest forest type, for example Douglas-fir) and oldGrowthErrorPercent and matureErrorPercent (the survey's standard error, in percent). " +
    "With 3D on, firesheds rise with their old-growth acres. " +
    "Use it for 'where is old growth', 'which national forests have the most mature forest' or 'how much ancient forest is left near here'. " +
    "The map fills each fireshed by its old-growth class (under 5,000 acres sage, up to 50,000 acres and more purple) with a legend, and Rank by lists the firesheds with the most. " +
    "Caveats: the figures are sample-based estimates (plots), so small firesheds and rare forest types carry large error, and the polygon is the whole fireshed, not the stands: old growth is not located inside it, and the acres count federal land only. " +
    "Only federal land is counted, so private, state and tribal forest are not. At most 200 firesheds are returned, those with the most old growth first, and the result says when it trims. " +
    "United States only. Over 300,000 km² (a 550 km square) it keeps the 1,000 with the most old growth.",
  coverage: "us",
  surface: "land",
  license: "Public domain (US Forest Service)",
  requiredEnv: [],
  maxAreaKm2: 300_000,
  wide: { orderBy: "old-growth acres", limit: WIDE_LIMIT },
  input: z.object({}),
  style: { geometry: "polygon", color: layerColor("old-growth"), unit: "acres", fillOpacity: 0.35, extrude: "v" },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  legend: OLD_GROWTH_LEGEND,
  labels: { field: "name", max: 6, rankBy: "oldGrowthAcres" },
  // One inventory (2023): no time panel.
  time: { shape: "none" },

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
