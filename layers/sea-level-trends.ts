/**
 * Long-term relative sea level trends at tide gauges, from NOAA CO-OPS (Tides and Currents), US and worldwide.
 *
 * Sources, checked live 2026-10-18:
 *   - Primary: NOAA's own published tables, one per network, in mm/yr with the 95% confidence interval:
 *     https://tidesandcurrents.noaa.gov/sltrends/data/USStationsLinearSeaLevelTrends.csv (144 stations, 12 KB) and
 *     https://tidesandcurrents.noaa.gov/sltrends/data/GlobalStationsLinearSeaLevelTrends.csv (365 stations, 31 KB). Header:
 *     "Station ID, Station Name, First Year, Last Year, Year Range, % Complete, MSL Trends (mm/yr), +/- 95% CI (mm/yr) ,
 *     MSL Trend (ft/century), +/- 95% CI (ft/century), Latitude, Longitude". The unit is read from the header: a table whose
 *     trend column is not "(mm/yr)" is rejected, never relabelled.
 *   - Fallback: https://api.tidesandcurrents.noaa.gov/dpapi/prod/webapi/product/sealvltrends.json. Since about 2026-10-17
 *     it ignores `units=metric`, `affil` and `station`, answers the 144 US stations only, and gives `trend` in
 *     "inches/decade" (Port Isabel 1.71 in/decade = 4.35 mm/yr). Each row's `trendUnits` is converted (inches/decade x 2.54
 *     = mm/yr); a row in a unit this file does not know is dropped. Its `trendError` is a standard error, not the 95%
 *     range (Galveston 0.04 in/decade, 0.10 mm/yr, against the table's +/-0.21), so it is shown as 1.96 x the error.
 *     Until 2026-10-18 this layer labelled the inch values mm/yr, 2.54 times too low, and cached them a week under
 *     `sea-level-trends:all`; the cache keys now carry `v2`, so that list is never read again.
 *   - Station pages: sltrends_station.shtml?id=9414290 (US), sltrends_global_station.shtml?stnid=010-001 (global).
 * Trends are recomputed about once a year, so each table is cached for a week, shared by every view, and filtered here.
 *
 * Live smoke 2026-10-18, Gulf Coast box [-98,25,-88,31]: Eagle Point TX 12.19 +/-1.33 mm/yr (4 ft per century),
 * Grand Isle LA 9.13, Galveston Pier 21 6.63, Port Isabel 4.35; San Francisco 1.99 +/-0.17, 1897-2025.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import {
  defineLayer,
  type Attribute,
  type BBox,
  type CardSpec,
  type FieldHelp,
  type LayerError,
  type LayerResult,
  type LegendSpec,
  type QueryContext,
} from "./types";
import { nameAttribute } from "./_shared/bands";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { jsonObjectBody, textBody } from "@/lib/fetch/validate";
import { layerColor } from "@/lib/render/palette";

/** Fewer US stations than this means NOAA sent a broken answer (the US table holds 144). */
export const MIN_STATIONS = 100;
/** Fewer global stations than this means a broken global table (it holds 365). */
export const MIN_GLOBAL_STATIONS = 200;

export const US_CSV_URL = "https://tidesandcurrents.noaa.gov/sltrends/data/USStationsLinearSeaLevelTrends.csv";
export const GLOBAL_CSV_URL = "https://tidesandcurrents.noaa.gov/sltrends/data/GlobalStationsLinearSeaLevelTrends.csv";
export const TRENDS_URL = "https://api.tidesandcurrents.noaa.gov/dpapi/prod/webapi/product/sealvltrends.json?units=metric";
/** Bumped when a cached list could hold wrong values (v1, `sea-level-trends:all`, cached inches per decade labelled mm/yr). */
export const CACHE_VERSION = "v2";
const TTL_SECONDS = 7 * 86_400;
export const MAX_STATIONS = 300;
/** Most stations in a wide view: more than the whole list (509 on 2026-10-18), so a wide view shows every gauge in it. */
const WIDE_LIMIT = 1_000;
const MM_PER_FOOT = 304.8;
/** A normal distribution's 95% range is 1.96 standard errors either side. */
const Z95 = 1.96;

/** Millimetres per year in one unit of each trend unit NOAA has used; a row in any other unit is rejected. */
export const MM_PER_YEAR: Record<string, number> = {
  "mm/yr": 1,
  "mm/year": 1,
  "inches/decade": 2.54,
  "in/decade": 2.54,
  "inches/yr": 25.4,
  "ft/century": MM_PER_FOOT / 100,
  "feet/century": MM_PER_FOOT / 100,
};

const inputSchema = z.object({});

/** One station's trend, always in mm/yr; `ci95` is the plus or minus 95% range in mm/yr. */
export type Trend = {
  stationId: string;
  stationName: string;
  affil: "US" | "Global";
  latitude: number;
  longitude: number;
  trend: number;
  ci95?: number;
  startYear?: number;
  endYear?: number;
  annotation?: string;
};

const JsonTrendSchema = z.object({
  stationId: z.string(),
  stationName: z.string(),
  affil: z.string().nullish(),
  annotation: z.string().nullish(),
  trendUnits: z.string().nullish(),
  latitude: z.coerce.number(),
  longitude: z.coerce.number(),
  trend: z.number(),
  trendError: z.number().nullish(),
  startDate: z.string().nullish(),
  endDate: z.string().nullish(),
});

/** "12/15/2025" -> 2025. */
function year(date: string | null | undefined): number | undefined {
  const m = date?.match(/(\d{4})\s*$/);
  return m ? Number(m[1]) : undefined;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Rows of NOAA's JSON trend list, converted to mm/yr by each row's `trendUnits`; a row without a known unit, or that
 * does not parse, is skipped (a unit change must never pass through relabelled).
 */
export function parseTrends(body: unknown): Trend[] {
  if (typeof body !== "object" || body === null || !("SeaLvlTrends" in body) || !Array.isArray(body.SeaLvlTrends)) return [];
  const out: Trend[] = [];
  for (const raw of body.SeaLvlTrends) {
    const parsed = JsonTrendSchema.safeParse(raw);
    if (!parsed.success) continue;
    const t = parsed.data;
    const factor = MM_PER_YEAR[(t.trendUnits ?? "").trim().toLowerCase()];
    if (factor === undefined || !Number.isFinite(t.latitude) || !Number.isFinite(t.longitude)) continue;
    const start = year(t.startDate);
    const end = year(t.endDate);
    out.push({
      stationId: t.stationId,
      stationName: t.stationName.trim(),
      affil: t.affil === "US" ? "US" : "Global",
      latitude: t.latitude,
      longitude: t.longitude,
      trend: round2(t.trend * factor),
      ...(typeof t.trendError === "number" && { ci95: round2(t.trendError * factor * Z95) }),
      ...(start !== undefined && { startYear: start }),
      ...(end !== undefined && { endYear: end }),
      ...(t.annotation && { annotation: t.annotation }),
    });
  }
  return out;
}

/** One CSV line split on commas outside double quotes, each cell trimmed. */
function csvCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

/**
 * Rows of one of NOAA's trend tables (US or global). Columns are found by their header names; the trend and its range
 * must be headed "(mm/yr)", else nothing is returned. "Reykjavik, Iceland, " loses its trailing comma.
 */
export function parseTrendsCsv(text: string, affil: "US" | "Global"): Trend[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];
  const header = csvCells(lines[0]).map((h) => h.toLowerCase());
  const col = (re: RegExp) => header.findIndex((h) => re.test(h));
  const id = col(/^station id$/);
  const name = col(/^station name$/);
  const first = col(/^first year$/);
  const last = col(/^last year$/);
  const trend = col(/^msl trends?\b/);
  const ci = col(/^\+\/- 95% ci/);
  const lat = col(/^latitude$/);
  const lon = col(/^longitude$/);
  if ([id, name, trend, lat, lon].some((i) => i < 0)) return [];
  if (!/\(mm\/yr\)/.test(header[trend]) || (ci >= 0 && !/\(mm\/yr\)/.test(header[ci]))) return [];
  const out: Trend[] = [];
  for (const line of lines.slice(1)) {
    const c = csvCells(line);
    if (!c[id] || !c[lat] || !c[lon] || !c[trend]) continue;
    const [la, lo, tr] = [Number(c[lat]), Number(c[lon]), Number(c[trend])];
    if (![la, lo, tr].every(Number.isFinite)) continue;
    const ci95 = ci >= 0 && c[ci] ? Number(c[ci]) : NaN;
    const start = first >= 0 ? Number(c[first]) : NaN;
    const end = last >= 0 ? Number(c[last]) : NaN;
    out.push({
      stationId: c[id],
      stationName: (c[name] || c[id]).replace(/[,\s]+$/, ""),
      affil,
      latitude: la,
      longitude: lo,
      trend: tr,
      ...(Number.isFinite(ci95) && { ci95 }),
      ...(Number.isInteger(start) && start > 1000 && { startYear: start }),
      ...(Number.isInteger(end) && end > 1000 && { endYear: end }),
    });
  }
  return out;
}

function stationUrl(t: Trend): string {
  return t.affil === "US"
    ? `https://tidesandcurrents.noaa.gov/sltrends/sltrends_station.shtml?id=${t.stationId}`
    : `https://tidesandcurrents.noaa.gov/sltrends/sltrends_global_station.shtml?stnid=${t.stationId}`;
}

/** Points in the bbox, fastest rise first: `v` mm/yr, trendError (the 95% range), startYear/endYear, ftPerCentury, inPerDecade. */
export function trendFeatures(trends: Trend[], [w, s, e, n]: BBox): Feature<Point>[] {
  return trends
    .filter((t) => t.longitude >= w && t.longitude <= e && t.latitude >= s && t.latitude <= n)
    .sort((a, b) => b.trend - a.trend)
    .map((t) => {
      const p: Record<string, string | number> = {
        name: t.stationName,
        stationId: t.stationId,
        v: t.trend,
        kind: t.trend < 0 ? "falling" : "rising",
        ftPerCentury: Math.round((t.trend * 100 * 100) / MM_PER_FOOT) / 100,
        // Four decimals, not two: the card shows it back in cm per decade (x 2.54), which must equal the mm/yr shown.
        inPerDecade: Math.round((t.trend / 2.54) * 10_000) / 10_000,
        network: t.affil === "US" ? "US" : "global",
        url: stationUrl(t),
      };
      if (t.ci95 !== undefined) p.trendError = t.ci95;
      if (t.startYear !== undefined) p.startYear = t.startYear;
      if (t.endYear !== undefined) p.endYear = t.endYear;
      if (t.annotation) p.annotation = t.annotation;
      return { type: "Feature", geometry: { type: "Point", coordinates: [t.longitude, t.latitude] }, properties: p };
    });
}

/** The body of one source, or null when it failed, timed out or is not the shape this layer reads. */
async function fetchText(ctx: QueryContext, url: string, key: string, validate: (body: string) => boolean): Promise<string | null> {
  try {
    const res = await ctx.fetch(url, { cacheKey: key, ttlSeconds: TTL_SECONDS, validate, timeoutMs: UPSTREAM_TIMEOUT_MS });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

const CSV_BODY = textBody({ markers: [/^Station ID,/, /MSL Trends \(mm\/yr\)/], minChars: 2_000 });

/**
 * Every station NOAA publishes, in mm/yr: the two tables first; when the US table fails, the JSON list (US only since
 * 2026-10-17, converted from its own unit). `fallback` says the JSON answered for the US stations; `missing` names a
 * network neither source gave.
 */
export async function loadTrends(ctx: QueryContext): Promise<{ trends: Trend[]; fallback: boolean; missing: ("US" | "Global")[] }> {
  const [usText, globalText] = await Promise.all([
    fetchText(ctx, US_CSV_URL, `sea-level-trends:${CACHE_VERSION}:us-csv`, CSV_BODY),
    fetchText(ctx, GLOBAL_CSV_URL, `sea-level-trends:${CACHE_VERSION}:global-csv`, CSV_BODY),
  ]);
  let us = usText === null ? [] : parseTrendsCsv(usText, "US");
  let global = globalText === null ? [] : parseTrendsCsv(globalText, "Global");
  if (global.length < MIN_GLOBAL_STATIONS) global = [];
  let fallback = false;
  if (us.length < MIN_STATIONS) {
    const json = await fetchText(ctx, TRENDS_URL, `sea-level-trends:${CACHE_VERSION}:json`, jsonObjectBody({ listKey: "SeaLvlTrends", minLength: MIN_STATIONS }));
    let rows: Trend[] = [];
    if (json !== null) {
      try {
        rows = parseTrends(JSON.parse(json));
      } catch {
        rows = [];
      }
    }
    us = rows.filter((t) => t.affil === "US");
    if (us.length < MIN_STATIONS) us = [];
    if (global.length === 0) global = rows.filter((t) => t.affil === "Global");
    fallback = us.length > 0;
  }
  const missing: ("US" | "Global")[] = [];
  if (us.length === 0) missing.push("US");
  if (global.length === 0) missing.push("Global");
  return { trends: [...us, ...global], fallback, missing };
}

const ATTRIBUTES: Attribute[] = [
  {
    key: "kind",
    type: "category",
    label: "Direction",
    levels: [
      { value: "falling", label: "Falling" },
      { value: "rising", label: "Rising" },
    ],
  },
  {
    key: "v",
    type: "measure",
    label: "Sea level trend",
    unit: "mm/yr",
    presets: [
      { label: "Falling (land rising)", max: 0 },
      { label: "Typical, 0 to 4 mm/yr", min: 0, max: 4 },
      { label: "Fast, 4 to 7 mm/yr", min: 4, max: 7 },
      { label: "Very fast, 7 mm/yr and up", min: 7 },
    ],
  },
  nameAttribute(),
];

const HELP: Record<string, FieldHelp> = {
  v: {
    text:
      "NOAA's straight-line fit to the station's whole record of monthly mean sea level, relative to the land under the gauge (ocean rise plus " +
      "land sinking or rising); a past trend, not a forecast. 1 mm/yr is about 4 inches per century.",
    unit: "mm/yr",
    source: "NOAA CO-OPS (Tides and Currents), Sea Level Trends",
    url: "https://tidesandcurrents.noaa.gov/sltrends/",
  },
  trendError: { text: "Plus or minus range of the trend at 95% confidence; a wide range or a short record means an uncertain trend.", unit: "mm/yr" },
  ftPerCentury: { text: "The same trend as feet per 100 years, as NOAA also states it.", unit: "ft per century" },
  inPerDecade: { text: "The same trend as inches per 10 years.", unit: "in per decade" },
  annotation: { text: "NOAA's note on the station's record, for example a datum shift or an earthquake that moved the gauge." },
  network: { text: "US for NOAA's own stations, global for the international stations NOAA also analyses." },
};

const CARD: CardSpec = {
  measure: { key: "v", label: "Sea level trend", unit: "mm/yr" },
  facts: [
    { key: "ftPerCentury", label: "Per century", unit: "ft" },
    { key: "inPerDecade", label: "Per decade", unit: "in" },
    { key: "trendError", label: "Uncertainty (±)", unit: "mm/yr" },
    { key: "startYear", label: "Record from" },
    { key: "endYear", label: "Record to" },
    { key: "annotation", label: "NOAA note" },
  ],
  links: [{ key: "url", label: "NOAA station trend page" }],
};

/** The key: color runs over the trends in view on the sage → pink → purple ramp (lib/render/encode.ts). */
const LEGEND: LegendSpec = {
  kind: "ramp",
  title: "Sea level trend",
  field: "v",
  unit: "mm/yr",
  stops: [{ label: "Slowest in view (falling below 0)" }, { label: "Fastest rise in view" }],
  note: "About 3 mm/yr is typical; 5 to 10 where the land sinks (Louisiana, Texas, Chesapeake Bay); below 0 where it rebounds (Alaska). The three fastest are named.",
};

const seaLevelTrends = defineLayer({
  id: "sea-level-trends",
  title: "Sea level trends (NOAA tide gauges)",
  description:
    "The measured long-term rate of sea level change at about 500 NOAA tide gauges on US coasts and worldwide: v in millimetres per year (mm/yr, negative where it falls), a straight-line fit to the past record (relative to the land, so sinking land adds to it), not a forecast. " +
    "Each point is a station with name, v (the trend, mm/yr), trendError (plus or minus, the 95% confidence range, mm/yr), " +
    "startYear and endYear (the record the trend is fitted to), ftPerCentury (the same rate as feet per 100 years), inPerDecade (inches per 10 years), kind ('rising' or 'falling'), network ('US' or 'global'), annotation (NOAA's warning, e.g. a datum shift) and url (the station's trend page). " +
    "The rate is relative sea level: ocean rise plus the land sinking or rising under the gauge, which is what matters at that shore. " +
    "So it differs a lot between places: about 3 mm/yr is typical, 5 to 10 where the land sinks (Galveston 6.6, Grand Isle 9.1, Eagle Point TX 12.2), and negative where land rebounds after the ice age (Juneau -13.5). " +
    "1 mm/yr is about 4 inches per century. The map colors each station by its trend and names the three fastest. Example questions: 'How fast is the sea rising in San Francisco?', 'Where is sea level rising fastest on the Gulf Coast?', 'Is sea level falling anywhere?'. " +
    "User words: sea level, sea level trend, rising seas. " +
    "Caveats: it is a straight-line fit to the past, not a forecast, and it does not show the recent speed-up; a short record (under 30 years) or a wide trendError is uncertain. " +
    "For a map of what a given rise would flood, use sea-level-rise. Shows up to 300 stations, fastest rise first (1,000 over 30,000,000 km²).",
  coverage: "global",
  surface: "coast",
  license: "Public domain (NOAA CO-OPS)",
  requiredEnv: [],
  maxAreaKm2: 30_000_000,
  wide: { orderBy: "trend in mm/yr", rank: "fastest-rising", limit: WIDE_LIMIT },
  input: inputSchema,
  style: { geometry: "point", color: layerColor("sea-level-trends"), unit: "mm/yr", encode: { color: "v" } },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  time: { shape: "none" },
  legend: LEGEND,
  labels: { field: "name", max: 3, rankBy: "v" },

  async query(ctx): Promise<LayerResult | LayerError> {
    const citation = {
      source: "NOAA CO-OPS (Tides and Currents) relative sea level trends (public domain)",
      url: "https://tidesandcurrents.noaa.gov/sltrends/",
      retrieved: new Date().toISOString(),
    };
    const { trends, fallback, missing } = await loadTrends(ctx);
    if (trends.length === 0) {
      return { error: "NOAA sea level trends did not answer with its station tables; try again later", hint: "upstream" };
    }
    const all = trendFeatures(trends, ctx.bbox);
    // Wide (over 30,000,000 km², up to 120,000,000): the same list, fastest rise first, up to the strategy's limit; run.ts writes the note.
    const wideLimit = ctx.wide ? ctx.wideStrategy?.limit : undefined;
    const features = all.slice(0, wideLimit ?? MAX_STATIONS);
    const notes: string[] = ["Measured long-term sea level rates at tide gauges, mm/yr relative to the land; past trends, not a forecast"];
    if (wideLimit === undefined && all.length > features.length) {
      notes.push(`Showing the ${MAX_STATIONS} fastest-rising of ${all.length} stations; zoom in for the rest`);
    }
    if (missing.includes("Global")) notes.push("NOAA's international stations could not be loaded, so only US stations show");
    if (missing.includes("US")) notes.push("NOAA's US stations could not be loaded, so only international stations show");
    if (features.length === 0) notes.push("No NOAA sea level trend stations in this view; they sit on coasts");
    const data: FeatureCollection = { type: "FeatureCollection", features };
    return {
      kind: "geojson",
      data,
      citation,
      ...(wideLimit !== undefined && { total: all.length }),
      coverageNote: notes.join("; "),
      // The JSON list answered after the US table failed: the stations shown are right, so the source counts as answering.
      ...(fallback && missing.length === 0 && { sourceStatus: { ok: true as const } }),
    };
  },
});

registerLayer(seaLevelTrends);

export default seaLevelTrends;
