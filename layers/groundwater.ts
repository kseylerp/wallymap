/**
 * Groundwater levels in wells: the newest manual (field) measurement of depth to water at USGS monitoring wells.
 * Service (USGS Water Data API, OGC API - Features; verified live 2026-10-10, keyless, an optional USGS_API_KEY raises the limits):
 *   GET https://api.waterdata.usgs.gov/ogcapi/v1/collections/latest-field-measurements/items
 *     ?parameter_code=72019&bbox=W,S,E,N&time=YYYY-01-01T00:00:00Z/..&limit=N&f=json&properties=...
 *   72019 is "Depth to water level, feet below land surface". One feature per well and parameter, the newest measurement.
 *   Properties used: monitoring_location_id ("USGS-410517100144901"), value (a STRING such as "91.17"; negative means the water
 *   stands above the land surface, as in a flowing artesian well), unit_of_measure ("ft"), time (ISO 8601 with offset),
 *   qualifier (list: "Static" for an undisturbed level, "ForeignSubstance", "Pumping", ...), observing_procedure, approval_status.
 *   Geometry is the well point. There is no well name in this collection (names are in `monitoring-locations`; not fetched here).
 *   A 1 x 2 degree box over central Nebraska with the 2015+ filter returned 970 wells in 8.6 s (466 KB with `properties`), which is why
 *   the area limit is modest. The same data are what the USGS Groundwater Watch pages show.
 * Output: v = depth to water in feet below land surface, t = measurement time, plus site (the USGS id), siteNo, depthFt, date,
 *   kind ("static" for an undisturbed level, "other" for pumping or other conditions, "unspecified" when none is given), method, approval, url.
 * Smoke check 2026-10-10 (live, through runLayer): box -100.5,40.5,-99.5,41.5 (central Nebraska) returned 327 wells measured since 2021 in 0.7 s
 *   (first: well 410517100144901, 91.17 ft, 2021-04-26, Static, steel tape); the Kearney box -100.2,40.6,-99.8,40.9 with sinceYear 2024 returned 92 wells.
 * Wide (over 40,000 km², up to 160,000): one page of 2,000 in the API's own order (sortby=-value sorts the text values, nulls
 *   first, so it cannot rank by depth; hence rank "first" and no orderBy), shown deepest first, plus `resulttype=hits` for the
 *   total (numberMatched). Smoke 2026-10-14, box -102,39,-98,43 (central Nebraska, 150,000 km²): 1,999 wells of 2,492 in 1.6 s.
 * Context (added 2026-10-18): one reading cannot say whether the water is high or low, so for a box under 12,000 km² the
 *   layer also reads each well's earlier manual readings from the same API's `field-measurements` collection (same
 *   parameter and bbox, the last 20 years, `skipGeometry`, three properties). Central Nebraska [-100.5,40.5,-99.5,41.5]:
 *   11,924 readings, 3 MB, 4.2 s; Kearney [-100.2,40.6,-99.8,40.9]: 2,733 readings in 2.5 s. A well with 10 or more earlier
 *   readings over 5 or more years gets `pct`, the share of its earlier readings when the water stood deeper than now (high
 *   = water high), and the USGS Groundwater Watch class for it (`level`: much below normal under 10, below 10 to 24, normal
 *   25 to 75, above 76 to 90, much above over 90). Manual readings are seasonal, so it is a guide, not USGS's own
 *   percentile of daily values. A page that hits the limit is not used (its wells' records would be cut).
 * Time: one latest reading per well (`time: single`): the date is said on the card, never scrubbed. The map colors wells
 *   by depth to water (the sage → pink → purple ramp over the wells in view) and labels the three deepest.
 * Depths over 1,500 ft are kept but flagged (`check`): central Nebraska's 2,977 ft well among readings of 2 to 315 ft is a
 *   data entry error, and no US water table that deep is mapped in this collection's areas.
 * `observing_procedure` is the method code's short form ("GW level, estim, report, observ"); the card says it in words
 *   from `observing_procedure_code` (S steel tape, T electric tape, V calibrated electric tape, O reported or estimated).
 */
import { z } from "zod";
import type { Feature, Point } from "geojson";
import { bboxAreaKm2, defineLayer, type Attribute, type BBox, type LayerError, type LayerResult, type LegendSpec, type QueryContext, type CardSpec, type FieldHelp } from "./types";
import { nameAttribute } from "./_shared/bands";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

const ENDPOINT = "https://api.waterdata.usgs.gov/ogcapi/v1/collections/latest-field-measurements/items";
export const PARAMETER_CODE = "72019";
export const LIMIT = 1_000;
/** Wells in a wide view: one unordered page (the API sorts `value` as text, so it cannot rank by depth); 2,000 took 3.3 s. */
export const WIDE_LIMIT = 2_000;
export const DEFAULT_YEARS_BACK = 5;
/** New measurements land daily, but a view's wells change slowly. */
const TTL_SECONDS = 6 * 3600;
const PROPERTIES = "monitoring_location_id,value,time,unit_of_measure,qualifier,observing_procedure,observing_procedure_code,approval_status";

const HISTORY_ENDPOINT = "https://api.waterdata.usgs.gov/ogcapi/v1/collections/field-measurements/items";
/** Years of earlier readings each well is compared with. */
export const HISTORY_YEARS = 20;
/** Largest box whose wells' records are read (central Nebraska's 1° box, 9,300 km², is 3 MB of readings). */
export const HISTORY_MAX_KM2 = 12_000;
export const HISTORY_LIMIT = 20_000;
/** Earlier readings, and distinct years among them, a well needs before its percentile means anything. */
export const MIN_HISTORY_READINGS = 10;
export const MIN_HISTORY_YEARS = 5;
/** A depth to water past this is flagged as a probable error. */
export const IMPLAUSIBLE_FT = 1_500;
const HISTORY_TTL_SECONDS = 24 * 3600;

/** USGS Groundwater Watch classes of a percentile, low water to high. */
export const LEVELS = [
  { value: "much-below", label: "Much below normal", max: 10, help: "Water lower than at 90% of the well's earlier readings." },
  { value: "below", label: "Below normal", max: 25, help: "Water lower than at 75 to 90% of earlier readings." },
  { value: "normal", label: "Normal", max: 76, help: "Within the middle half of the well's earlier readings." },
  { value: "above", label: "Above normal", max: 91, help: "Water higher than at 75 to 90% of earlier readings." },
  { value: "much-above", label: "Much above normal", max: 101, help: "Water higher than at 90% of earlier readings." },
] as const;

/** The method code in words (USGS water-level method codes). */
export const METHODS: Record<string, string> = {
  S: "Steel tape",
  T: "Electric tape",
  V: "Calibrated electric tape",
  O: "Reported or estimated (no tape reading)",
  R: "Reported by the owner or driller",
  E: "Estimated",
  A: "Airline gauge",
  B: "Chart recorder",
  F: "Pressure transducer",
  G: "Pressure gauge",
  H: "Calibrated pressure gauge",
  L: "Geophysical log",
  M: "Manometer",
  N: "Non-recording gauge",
  X: "Uncalibrated pressure transducer",
};

const EMPTY = { type: "FeatureCollection" as const, features: [] as Feature<Point>[] };

/**
 * How many wells match (`resulttype=hits` answers `numberMatched` without features), or undefined on any failure; a wide
 * result's total.
 */
async function countWells(ctx: QueryContext, params: URLSearchParams, cacheKey: string | undefined, headers?: Record<string, string>): Promise<number | undefined> {
  const search = new URLSearchParams(params);
  search.set("resulttype", "hits");
  search.set("limit", "1");
  search.set("skipGeometry", "true");
  search.delete("properties");
  try {
    const res = await ctx.fetch(`${ENDPOINT}?${search.toString()}`, { cacheKey, ttlSeconds: TTL_SECONDS, timeoutMs: UPSTREAM_TIMEOUT_MS, ...(headers ? { headers } : {}) });
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    const n = typeof body === "object" && body !== null && "numberMatched" in body ? body.numberMatched : undefined;
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** First measurement year to include: the current year minus `yearsBack`, or the caller's `sinceYear`. */
export function sinceYear(now: Date, input: { sinceYear?: number }): number {
  return input.sinceYear ?? now.getUTCFullYear() - DEFAULT_YEARS_BACK;
}

/** Wells as points: v is depth to water in feet, t the measurement time; unusable rows (no point, no number, wrong unit) are dropped. */
export function normalizeWells(body: unknown): Feature<Point>[] {
  if (typeof body !== "object" || body === null || !("features" in body) || !Array.isArray(body.features)) return [];
  const seen = new Set<string>();
  const out: Feature<Point>[] = [];
  for (const raw of body.features as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const f = raw as { geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> };
    const p = f.properties ?? {};
    const coords = f.geometry?.type === "Point" ? f.geometry.coordinates : undefined;
    if (!Array.isArray(coords) || typeof coords[0] !== "number" || typeof coords[1] !== "number") continue;
    const depth = Number(p.value);
    const unit = str(p.unit_of_measure);
    if (!Number.isFinite(depth) || str(p.value) === undefined || (unit !== undefined && unit !== "ft")) continue;
    const site = str(p.monitoring_location_id);
    if (site !== undefined) {
      if (seen.has(site)) continue;
      seen.add(site);
    }
    const time = str(p.time);
    const ms = time === undefined ? NaN : Date.parse(time);
    const qualifiers = Array.isArray(p.qualifier) ? p.qualifier.filter((q): q is string => typeof q === "string") : [];

    const rounded = Math.round(depth * 100) / 100;
    const properties: Record<string, string | number> = {
      name: site === undefined ? "Well" : `Well ${site.replace(/^USGS-/, "")}`,
      v: rounded,
      depthFt: rounded,
      kind: qualifiers.length === 0 ? "unspecified" : qualifiers.includes("Static") ? "static" : "other",
    };
    if (site !== undefined) {
      properties.site = site;
      properties.siteNo = site.replace(/^USGS-/, "");
      properties.url = `https://waterdata.usgs.gov/monitoring-location/${site}/`;
    }
    if (Number.isFinite(ms)) {
      properties.t = new Date(ms).toISOString();
      properties.date = new Date(ms).toISOString().slice(0, 10);
    }
    if (qualifiers.length > 0) properties.condition = qualifiers.join(", ");
    const code = str(p.observing_procedure_code)?.toUpperCase();
    const method = (code !== undefined ? METHODS[code] : undefined) ?? str(p.observing_procedure)?.replace(/^GW level, /i, "");
    if (method !== undefined && method.toLowerCase() !== "none") properties.method = method.charAt(0).toUpperCase() + method.slice(1);
    // A flagged depth gets no map label, so the labels never name a probable error as the deepest well.
    if (rounded > IMPLAUSIBLE_FT) properties.check = "Unusually deep for a water level; probably a data entry error";
    else properties.depthLabel = `${Math.round(rounded).toLocaleString("en-US")} ft`;
    const approval = str(p.approval_status);
    if (approval !== undefined) properties.approval = approval;
    out.push({ type: "Feature", geometry: { type: "Point", coordinates: [coords[0], coords[1]] }, properties });
  }
  return out;
}

/** Each well's earlier readings (depth in ft and ISO date) from a field-measurements page; null when it is not one. */
export function parseHistory(body: unknown): Map<string, { t: string; d: number }[]> | null {
  if (typeof body !== "object" || body === null || !("features" in body) || !Array.isArray(body.features)) return null;
  const out = new Map<string, { t: string; d: number }[]>();
  for (const raw of body.features as unknown[]) {
    const p = (raw as { properties?: Record<string, unknown> } | null)?.properties;
    const site = str(p?.monitoring_location_id);
    const t = str(p?.time);
    const d = Number(p?.value);
    if (site === undefined || t === undefined || str(p?.value) === undefined || !Number.isFinite(d)) continue;
    const list = out.get(site) ?? [];
    list.push({ t: t.slice(0, 10), d });
    out.set(site, list);
  }
  return out;
}

/**
 * Where the newest depth sits in the well's earlier readings, as the share of them when the water stood deeper (0 to
 * 100; high = water high), with the median depth and the first year; undefined without enough record.
 */
export function waterLevelPercentile(depth: number, date: string | undefined, history: { t: string; d: number }[]): { pct: number; medianFt: number; since: number; readings: number } | undefined {
  const earlier = history.filter((h) => date === undefined || h.t < date.slice(0, 10));
  const years = new Set(earlier.map((h) => h.t.slice(0, 4)));
  if (earlier.length < MIN_HISTORY_READINGS || years.size < MIN_HISTORY_YEARS) return undefined;
  let deeper = 0;
  let same = 0;
  for (const h of earlier) {
    if (h.d > depth) deeper++;
    else if (h.d === depth) same++;
  }
  const sorted = earlier.map((h) => h.d).sort((a, b) => a - b);
  const mid = sorted.length / 2;
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[Math.floor(mid)];
  return {
    pct: Math.round((100 * (deeper + same / 2)) / earlier.length),
    medianFt: Math.round(median * 10) / 10,
    since: Math.min(...[...years].map(Number)),
    readings: earlier.length,
  };
}

/** The Groundwater Watch class of a percentile. */
export function levelOf(pct: number): (typeof LEVELS)[number]["value"] {
  return (LEVELS.find((l) => pct < l.max) ?? LEVELS[LEVELS.length - 1]).value;
}

/** The earlier readings of every well in the box (one page), or null when the box is too big, the page was cut, or the call failed. */
async function readHistory(ctx: QueryContext, bbox: BBox, now: Date, headers?: Record<string, string>): Promise<Map<string, { t: string; d: number }[]> | null> {
  const from = now.getUTCFullYear() - HISTORY_YEARS;
  const params = new URLSearchParams({
    parameter_code: PARAMETER_CODE,
    bbox: bbox.join(","),
    time: `${from}-01-01T00:00:00Z/..`,
    limit: String(HISTORY_LIMIT),
    f: "json",
    skipGeometry: "true",
    properties: "monitoring_location_id,value,time",
  });
  try {
    const res = await ctx.fetch(`${HISTORY_ENDPOINT}?${params.toString()}`, {
      cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:groundwater:history:${from}`,
      ttlSeconds: HISTORY_TTL_SECONDS,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      ...(headers ? { headers } : {}),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const rows = typeof body === "object" && body !== null && "features" in body && Array.isArray(body.features) ? body.features.length : 0;
    if (rows >= HISTORY_LIMIT) return null;
    return parseHistory(body);
  } catch {
    return null;
  }
}

/** Adds pct, level, medianFt, recordSince and readings to each well with enough earlier readings; returns how many got them. */
export function addContext(wells: Feature<Point>[], history: Map<string, { t: string; d: number }[]>): number {
  let n = 0;
  for (const w of wells) {
    const p = w.properties as Record<string, string | number>;
    const site = typeof p.site === "string" ? p.site : undefined;
    const record = site === undefined ? undefined : history.get(site);
    if (!record || p.check !== undefined) continue;
    const c = waterLevelPercentile(Number(p.v), typeof p.date === "string" ? p.date : undefined, record);
    if (!c) continue;
    p.pct = c.pct;
    p.level = levelOf(c.pct);
    p.medianFt = c.medianFt;
    p.recordSince = c.since;
    p.readings = c.readings;
    n++;
  }
  return n;
}

const WELLS_URL = "https://api.waterdata.usgs.gov/ogcapi/v1/collections/latest-field-measurements";

/** What a well card's depth and status mean (spec §12b). */
const HELP: Record<string, FieldHelp> = {
  v: {
    text:
      "How far below the land surface the water stood in the well at the newest manual measurement; negative means the water stands above the " +
      "ground, as in a flowing well. The newest reading per well; the comparison with its earlier readings says whether that is high or low.",
    unit: "ft below land surface",
    source: "USGS Water Data API, latest field measurements (parameter 72019)",
    url: WELLS_URL,
  },
  level: {
    text:
      "How the newest reading compares with the well's own manual readings over the last 20 years, in the classes USGS Groundwater Watch uses. " +
      "Manual readings are taken a few times a year, so this is a guide, not USGS's official percentile.",
    scale: "Much below normal (under 10th percentile), below (10 to 24), normal (25 to 75), above (76 to 90), much above (over 90)",
    source: "USGS Water Data API, field measurements",
    url: "https://api.waterdata.usgs.gov/ogcapi/v1/collections/field-measurements",
  },
  pct: { text: "Share of the well's earlier readings when the water stood deeper than now: 90 means the water is higher than at 90% of them.", unit: "percentile" },
  medianFt: { text: "The middle of the well's earlier readings: a typical depth to water there.", unit: "ft below land surface" },
  recordSince: { text: "First year of the earlier readings the comparison uses (up to 20 years back)." },
  readings: { text: "How many earlier manual readings the comparison uses." },
  kind: { text: "Whether the well was measured undisturbed: static is the resting water level; otherwise it was pumped or disturbed." },
  condition: { text: "The qualifiers the USGS recorded with the measurement, such as Static (undisturbed) or Pumping." },
  method: { text: "How the depth was measured: a steel or electric tape lowered into the well, or a level reported by the owner or estimated." },
  approval: { text: "Whether the USGS has approved the measurement or it is still provisional and may be revised." },
  check: { text: "This app flags depths over 1,500 ft: far outside the water levels around it and probably a typing error at the source." },
};

const LEVEL_WORDS = Object.fromEntries(LEVELS.map((l) => [l.value, l.label]));

/** The well card: depth to water, how it compares with the well's record, when and how it was measured. */
const CARD: CardSpec = {
  measure: { key: "v", label: "Depth to water", unit: "ft" },
  facts: [
    { key: "date", label: "Measured", format: "date" },
    { key: "level", label: "Compared with its record", values: LEVEL_WORDS },
    { key: "pct", label: "Percentile", format: "int" },
    { key: "medianFt", label: "Typical depth (median)", unit: "ft", format: "1dp" },
    { key: "recordSince", label: "Record since" },
    { key: "readings", label: "Earlier readings", format: "int" },
    { key: "check", label: "Check" },
    { key: "kind", label: "Water level", values: { static: "Static (undisturbed)", other: "Pumped or otherwise disturbed", unspecified: "Condition not given" } },
    { key: "condition", label: "Conditions noted" },
    { key: "method", label: "Method" },
    { key: "approval", label: "Review status" },
    { key: "site", label: "USGS site" },
  ],
  links: [
    { key: "url", label: "USGS well page" },
  ],
  // siteNo repeats site without its prefix; depthLabel is the map label, the measure already says it.
  hidden: ["siteNo", "depthLabel"],
};

const ATTRIBUTES: Attribute[] = [
  {
    key: "v",
    type: "measure",
    label: "Depth to water",
    unit: "ft",
    presets: [
      { label: "Shallow, under 25 ft", max: 25 },
      { label: "25 to 100 ft", min: 25, max: 100 },
      { label: "100 to 300 ft", min: 100, max: 300 },
      { label: "Deep, 300 ft and more", min: 300 },
    ],
  },
  {
    key: "level",
    type: "ordinal",
    label: "Compared with its record",
    scale: "USGS Groundwater Watch percentile classes",
    levels: LEVELS.map((l) => ({ value: l.value, label: l.label, help: l.help })),
  },
  {
    key: "kind",
    type: "category",
    label: "Water level",
    levels: [
      { value: "static", label: "Static" },
      { value: "other", label: "Pumped or disturbed" },
      { value: "unspecified", label: "Not given" },
    ],
  },
  nameAttribute("Well"),
];

/** Wells are colored by depth over the wells in view (lib/render/encode.ts): sage shallow to purple deep. */
const LEGEND: LegendSpec = {
  kind: "ramp",
  title: "Depth to water",
  field: "v",
  unit: "ft below land surface",
  stops: [{ label: "Shallowest in view" }, { label: "Deepest in view" }],
  note: "Newest manual reading per well; the three deepest are labelled. The card says whether the level is above or below the well's normal.",
};

const groundwater = defineLayer({
  id: "groundwater",
  title: "Groundwater levels",
  description:
    "How deep the water table is, from the newest manual measurement at each USGS monitoring well, colored by depth (the three deepest labelled). Each point has v and depthFt (feet below land surface; negative means water above ground, as in a flowing well), t and date, site and siteNo (the USGS well id), kind ('static' undisturbed, 'other' pumped or disturbed), method, approval and url. " +
    "In a view under 12,000 km², a well with 10 or more earlier readings over 5 or more years also has pct (0 to 100: the share of its readings over the last 20 years when the water stood deeper than now, so high means the water is high), level ('much-below', 'below', 'normal', 'above', 'much-above', USGS Groundwater Watch classes), medianFt (its typical depth) and recordSince. " +
    "check marks a depth over 1,500 ft that is probably a data error; leave it out of any answer. sinceYear (default five years back) hides older wells. " +
    "It is one reading per well, so it cannot show a trend over time: never say a level is rising or falling; say above or below the well's normal only from level. Values can be months old; wells have numbers, not names. At most 1,000 wells in no order (2,000 over 40,000 km², with the total).",
  coverage: "us",
  surface: "land",
  license: "Public domain (USGS)",
  requiredEnv: [],
  optionalEnv: ["USGS_API_KEY"],
  maxAreaKm2: 40_000,
  wide: { limit: WIDE_LIMIT, rank: "first" },
  input: z.object({
    sinceYear: z
      .number()
      .int()
      .min(1900)
      .max(2100)
      .optional()
      .describe("Only wells measured in this year or later (default: five years back)."),
  }),
  style: { geometry: "point", color: layerColor("groundwater"), unit: "ft", extrude: "v", heat: true, encode: { color: "v" } },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  // One latest reading per well: say the date, never scrub (docs/layer-contract.md).
  time: { shape: "single" },
  legend: LEGEND,
  labels: { field: "depthLabel", max: 3, rankBy: "v" },
  display: { units: "us" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const citation = {
      source: "USGS Water Data API, latest field measurements of depth to water (parameter 72019)",
      url: "https://api.waterdata.usgs.gov/ogcapi/v1/collections/latest-field-measurements",
      retrieved: new Date().toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    const since = sinceYear(new Date(), input);
    // Wide (over 40,000 km², up to 160,000): one bigger page, which the API returns in no useful order, plus a count of
    // every well in the box. run.ts writes the note ("the 2,000 first of N").
    const wideLimit = ctx.wide ? ctx.wideStrategy?.limit : undefined;
    const limit = wideLimit ?? LIMIT;
    const params = new URLSearchParams({
      parameter_code: PARAMETER_CODE,
      bbox: ctx.bbox.join(","),
      time: `${since}-01-01T00:00:00Z/..`,
      limit: String(limit),
      f: "json",
      properties: PROPERTIES,
    });
    const apiKey = ctx.env.USGS_API_KEY;
    const headers = apiKey ? { "X-Api-Key": apiKey } : undefined;
    const counting =
      wideLimit === undefined
        ? Promise.resolve(undefined)
        : countWells(ctx, params, ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:groundwater:${since}:count`, headers);
    // Each well's own record, read alongside, for a box small enough that one page holds every reading.
    const withHistory = wideLimit === undefined && bboxAreaKm2(ctx.bbox) <= HISTORY_MAX_KM2;
    const history = withHistory ? readHistory(ctx, ctx.bbox, new Date(), headers) : Promise.resolve(null);

    let res: Response;
    try {
      res = await ctx.fetch(`${ENDPOINT}?${params.toString()}`, {
        cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:groundwater:${since}`,
        ttlSeconds: TTL_SECONDS,
        timeoutMs: UPSTREAM_TIMEOUT_MS,
        ...(headers ? { headers } : {}),
      });
    } catch (err) {
      const timedOut = typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
      return {
        error: timedOut
          ? `USGS Water Data API timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds; zoom in and try again`
          : "USGS Water Data API returned no response",
        hint: "upstream",
      };
    }
    if (res.status === 429) {
      return { error: "USGS Water Data API is rate-limiting requests; try again in a minute", hint: "upstream" };
    }
    if (!res.ok) return { error: `USGS Water Data API returned ${res.status}`, hint: "upstream" };

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { error: "USGS Water Data API returned a response that is not JSON", hint: "upstream" };
    }
    if (typeof body !== "object" || body === null || !("features" in body) || !Array.isArray(body.features)) {
      return { error: "USGS Water Data API did not return a FeatureCollection", hint: "upstream" };
    }

    const features = normalizeWells(body);
    // A wide page is unordered, so show its deepest wells first.
    if (wideLimit !== undefined) features.sort((a, b) => Number(b.properties?.v) - Number(a.properties?.v));
    const total = await counting;
    const notes: string[] = [];
    if (wideLimit === undefined && body.features.length >= LIMIT) notes.push(`Showing ${LIMIT} wells, in no particular order; zoom in for the rest`);
    if (features.length === 0) notes.push(`No wells measured since ${since} in this area; ask for an earlier start year to include older measurements`);
    else notes.push(`Latest manual measurement per well since ${since}; depth is feet below land surface`);
    const record = await history;
    if (features.length > 0) {
      if (record) {
        const compared = addContext(features, record);
        notes.push(`${compared} of ${features.length} wells compared with their own readings since ${new Date().getUTCFullYear() - HISTORY_YEARS}`);
      } else if (!withHistory) {
        notes.push(`zoom in under ${HISTORY_MAX_KM2.toLocaleString("en-US")} km² to compare each well with its own record`);
      }
    }
    const flagged = features.filter((f) => f.properties?.check !== undefined).length;
    if (flagged > 0) notes.push(`${flagged} reading${flagged === 1 ? "" : "s"} over ${IMPLAUSIBLE_FT.toLocaleString("en-US")} ft flagged as a probable data error`);
    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      ...(total !== undefined && { total }),
      coverageNote: notes.join("; "),
    };
  },
});

registerLayer(groundwater);

export default groundwater;
