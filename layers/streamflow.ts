/**
 * Live stream gauges: USGS NWIS instantaneous values (primary), USGS Water Data API (fallback), and GloFAS
 * modelled river discharge via the Open-Meteo flood API outside the United States.
 *
 * Primary (US): https://waterservices.usgs.gov/nwis/iv/ (see layers/_shared/usgs.ts), parameterCd=00060,00010
 * (discharge cfs + water temperature C) or 00065,00010 (gage height ft). Cached 10 minutes.
 *
 * Flow vs. normal (US, discharge only): https://waterservices.usgs.gov/nwis/stat/?format=rdb&sites=...
 * &statReportType=daily&statTypeCd=all&parameterCd=00060. Verified live 2026-10-09: it has NO bBox (HTTP 400)
 * and takes at most 10 sites per call (11 gave HTTP 400 "max=[10]"); tab-separated RDB, `#` comment lines, a
 * header row, a column-width row, then rows of agency_cd, site_no, parameter_cd, ts_id, loc_web_ds, month_nu,
 * day_nu, begin_yr, end_yr, count_nu, max_va_yr, max_va, min_va_yr, min_va, mean_va, p05_va ... p95_va (the
 * daily means for that calendar day over count_nu years). Checked 2026-10-18: Truckee at Farad (10346000) on
 * Oct 18 min 43, p10 82, p25 362, p50 409, p75 463, p90 544, max 1040 cfs; about 40 KB per site; asking for a
 * subset (min,max,p10,...,p90) returned p90_va blank, so `all` is asked. Every gauge with a discharge reading is
 * looked up (up to STAT_SITE_CAP, largest first), 10 per call, cached for a week under a key shared across bboxes
 * (the statistics change once a year), and classed in USGS WaterWatch's percentile classes (FLOW_CLASSES;
 * WaterWatch was retired in 2025, the classes are hyswap's "WaterWatch" schema and the National Water Dashboard's).
 *
 * Fallback (US): when the IV service fails, the Water Data API (OGC API - Features), base
 * https://api.waterdata.usgs.gov/ogcapi/v0/collections, as before M4:
 *   - `latest-continuous`: one row per time series with its newest value. Query: bbox, parameter_code,
 *     site_type_code=ST, f=json, limit (up to 10000). Row properties used: monitoring_location_id
 *     ("USGS-10338000"), time (ISO 8601 with offset), value (a STRING such as "70.3"). Point geometry.
 *   - `monitoring-locations`: `id=USGS-1,USGS-2,...&properties=id,monitoring_location_name` for names.
 *   Stale rows (discontinued gauges back to 1991) are dropped after 7 days; newest reading per site wins.
 *   Throttled hard without a key; an optional USGS_API_KEY is sent as X-Api-Key.
 *
 * Outside the US: OSM `waterway=river` ways with a name in the bbox (Overpass `out center tags`), the
 * RIVER_POINTS longest rivers (by segment count) each sampled at the segment centre nearest its middle, then
 * https://flood-api.open-meteo.com/v1/flood?latitude=a,b&longitude=c,d&daily=river_discharge&past_days=1
 * &forecast_days=1 (multi-location: a JSON array, one object per point, daily.time + daily.river_discharge
 * in m3/s). GloFAS is a 0.05° (about 5 km) model, daily, not a gauge. Live check: the Rhone point east of Lyon
 * read 0.26 m3/s in its own cell and 326-329 m3/s one cell over, so each river samples its 3 x 3 cells and
 * keeps the largest. `river_discharge_median` in that API is the ensemble median, not a climatology, so no
 * percent of median is given there.
 *
 * Live smoke 2026-10-09 ~02:05 UTC: Tahoe box, 18 discharge gauges; W FK Carson at Woodfords 19.4 cfs,
 * 84% of the 23 cfs Oct 9 median; Upper Truckee at South Lake Tahoe 5.42 cfs, 49% of median, 14.9 C.
 * Lyon box [4.7,45.6,6.3,46.3] (outside US): 8 rivers; Le Rhone 328.6 m3/s = 11,605 cfs modelled.
 * Wide smoke through runLayer (2026-10-14): Colorado [-109,37,-102,41] (268,000 km², under the soft cap) 321 gauges
 * in 7.2 s; [-112,36,-102,42] (574,000 km², 3 strips) all 535 gauges in 10.9 s; [-90,35,-75,44] (1.28 million km²,
 * 6 strips) kept the 1,000 highest flows of total 2,316 in 8.3 s (Mississippi at New Madrid 378,000 cfs first).
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { defineLayer, type Attribute, type Citation, type LayerError, type LayerResult, type LegendSpec, type QueryContext, type CardSpec, type FieldHelp } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { outsideUs } from "./_shared/coverage";
import { overpassQuery } from "./_shared/overpass";
import { fetchIv, ivStrips, parseIv, type IvSite } from "./_shared/usgs";
import { isAllCaps } from "./_shared/names";
import { CATEGORY_WORDS, joinRiverForecasts, releaseFeatures } from "./_shared/river-forecast";
import { layerColor, OFF_WHITE } from "@/lib/render/palette";

const BASE = "https://api.waterdata.usgs.gov/ogcapi/v0/collections";

const MAX_AGE_DAYS = 7;
const DAY_MS = 86_400_000;
const LATEST_LIMIT = 10_000;
/** Site ids per name lookup; keeps each URL near 1.5 KB. */
const NAME_BATCH_SIZE = 100;
/** Gauges report every 15 minutes, so ten minutes of cache keeps the map current. */
const LATEST_TTL_SECONDS = 600;
/** Most gauges a wide (over 400,000 km²) result carries. */
export const WIDE_LIMIT = 1000;
/**
 * Most IV strips (one request each, at most 25 square degrees) a query may make. The 1.6 million km² hard cap is
 * about 7 strips in the lower 48; a far-north box of the same area needs more, so it is refused here.
 */
export const MAX_IV_STRIPS = 10;

const inputSchema = z.object({
  parameter: z.enum(["00060", "00065"]).default("00060"),
});

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const ReadingRowSchema = z.object({
  geometry: z
    .object({ type: z.literal("Point"), coordinates: z.array(z.number()).min(2) })
    .nullable()
    .optional(),
  properties: z.object({
    monitoring_location_id: z.string(),
    time: z.string(),
    value: z.union([z.string(), z.number()]).nullable().optional(),
  }),
});

const NameRowSchema = z.object({
  properties: z.object({
    id: z.string(),
    monitoring_location_name: z.string().nullable().optional(),
  }),
});

type Reading = { siteId: string; coordinates: [number, number]; time: number; value: number };

function rowsOf(body: unknown): unknown[] {
  if (typeof body === "object" && body !== null && "features" in body && Array.isArray(body.features)) {
    return body.features;
  }
  return [];
}

/** Recent, numeric readings from a `latest-continuous` body, newest per site. */
function latestReadings(body: unknown, now: Date): Reading[] {
  const newest = new Map<string, Reading>();
  const cutoff = now.getTime() - MAX_AGE_DAYS * DAY_MS;
  for (const row of rowsOf(body)) {
    const parsed = ReadingRowSchema.safeParse(row);
    if (!parsed.success || !parsed.data.geometry) continue;
    const { properties, geometry } = parsed.data;
    const raw = properties.value;
    const value = typeof raw === "number" ? raw : raw == null || raw.trim() === "" ? NaN : Number(raw);
    const time = Date.parse(properties.time);
    if (!Number.isFinite(value) || !Number.isFinite(time) || time < cutoff) continue;
    const current = newest.get(properties.monitoring_location_id);
    if (current === undefined || time > current.time) {
      newest.set(properties.monitoring_location_id, {
        siteId: properties.monitoring_location_id,
        coordinates: [geometry.coordinates[0], geometry.coordinates[1]],
        time,
        value,
      });
    }
  }
  return [...newest.values()];
}

/** US state and territory codes: the last word of a USGS station name ("TRUCKEE R A FARAD CA") is often one. */
const STATE_CODES = new Set(
  ("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX " +
    "UT VT VA WA WV WI WY PR VI GU AS MP").split(" "),
);

/** USGS station-name abbreviations, spelled out ("TRUCKEE R A FARAD CA" is the Truckee River at Farad). */
const GAUGE_WORDS: Record<string, string> = {
  R: "River",
  RV: "River",
  RIV: "River",
  C: "Creek",
  CR: "Creek",
  CK: "Creek",
  CRK: "Creek",
  FK: "Fork",
  NF: "North Fork",
  SF: "South Fork",
  EF: "East Fork",
  WF: "West Fork",
  MF: "Middle Fork",
  TRIB: "Tributary",
  BR: "Branch",
  CYN: "Canyon",
  SPGS: "Springs",
  SPG: "Spring",
  LK: "Lake",
  RES: "Reservoir",
  SL: "Slough",
  CNL: "Canal",
  DIV: "Diversion",
  MTN: "Mountain",
  HWY: "Highway",
  RD: "Road",
  LN: "Lane",
  NR: "near",
  A: "at",
  AB: "above",
  ABV: "above",
  BL: "below",
  BLW: "below",
  BTWN: "between",
};

/** Single letters that are a direction when a word follows ("W FK CARSON RV", "S UPPER TRUCKEE RD"). */
const DIRECTIONS: Record<string, string> = { N: "North", S: "South", E: "East", W: "West", M: "Middle" };

/** Words written in lower case inside a gauge name ("Cache Creek near Jackson"). */
const GAUGE_SMALL = new Set(["near", "at", "above", "below", "between", "of", "the", "and", "in", "on", "to", "by", "mouth"]);

/** Names that stay in capitals inside a gauge name ("Old US 395"). */
const GAUGE_ACRONYMS = new Set(["US", "USFS", "USGS", "BLM", "NPS", "USBR", "USACE", "TVA", "NWR"]);

function gaugeWordCase(word: string): string {
  if (/\d/.test(word) || GAUGE_ACRONYMS.has(word)) return word;
  return word
    .toLowerCase()
    .replace(/(^|[-/])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
    .replace(/^Mc(\p{L})/u, (_m, ch: string) => `Mc${ch.toUpperCase()}`);
}

/**
 * A USGS station name in plain words: abbreviations spelled out (R River, C and CK Creek, NR near, A at, AB above, BL
 * below, FK Fork, TRIB Tributary, a leading N, S, E or W a direction), ordinary capitals, and a trailing state code kept
 * as the state after a comma: "TRUCKEE R A FARAD CA" is "Truckee River at Farad, CA". A name not in capitals is kept.
 */
export function gaugeName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!isAllCaps(name)) return name;
  const tokens = name.split(" ").map((t) => {
    const m = /^([("]*)(.*?)([),.;:"]*)$/.exec(t);
    return { pre: m?.[1] ?? "", core: m?.[2] ?? t, post: m?.[3] ?? "" };
  });
  let state: string | undefined;
  const last = tokens[tokens.length - 1];
  if (tokens.length > 1 && STATE_CODES.has(last.core) && last.pre === "" && last.post.replace(/[.,]/g, "") === "") {
    state = last.core;
    tokens.pop();
  }
  const words = tokens.map((t, i) => {
    const next = tokens[i + 1]?.core;
    const prev = tokens[i - 1]?.core;
    let word: string;
    if (DIRECTIONS[t.core] !== undefined && next !== undefined && (t.core !== "M" || /^(F|FK|FORK)$/.test(next))) word = DIRECTIONS[t.core];
    else if (t.core === "F" && prev !== undefined && DIRECTIONS[prev] !== undefined) word = "Fork";
    else if (GAUGE_WORDS[t.core] !== undefined && (t.core.length > 1 || i > 0)) word = GAUGE_WORDS[t.core];
    else word = gaugeWordCase(t.core);
    if (i > 0 && GAUGE_SMALL.has(word.toLowerCase())) word = word.toLowerCase();
    // An abbreviation's point goes with it ("NR." is "near"); commas and brackets stay.
    const post = word !== gaugeWordCase(t.core) ? t.post.replace(/\./g, "") : t.post;
    return `${t.pre}${word}${post}`;
  });
  const body = words.join(" ").replace(/[,;]\s*$/, "");
  return state === undefined ? body : `${body}, ${state}`;
}

/** A gauge's name properties: the plain name, and the station name as USGS writes it when that differs (kept off the card). */
function gaugeNames(raw: string): { name: string; nameInSource?: string } {
  const name = gaugeName(raw);
  return name === raw ? { name } : { name, nameInSource: raw };
}

function namesFrom(bodies: unknown[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const body of bodies) {
    for (const row of rowsOf(body)) {
      const parsed = NameRowSchema.safeParse(row);
      const name = parsed.success ? parsed.data.properties.monitoring_location_name?.trim() : undefined;
      if (parsed.success && name) names.set(parsed.data.properties.id, name);
    }
  }
  return names;
}

function toFeatures(readings: Reading[], names: Map<string, string>): FeatureCollection {
  const features: Feature<Point>[] = readings.map((r) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: r.coordinates },
    properties: {
      ...gaugeNames(names.get(r.siteId) ?? r.siteId),
      siteId: r.siteId,
      t: new Date(r.time).toISOString(),
      v: r.value,
    },
  }));
  return { type: "FeatureCollection", features };
}

/**
 * Joins a `latest-continuous` body and `monitoring-locations` body into gauge points: recent readings only,
 * newest per site, named by site id (the id itself when no name is known).
 */
export function joinGauges(latestBody: unknown, locationsBody: unknown, now: Date): FeatureCollection {
  return toFeatures(latestReadings(latestBody, now), namesFrom([locationsBody]));
}

type Fetched = { ok: true; body: unknown } | { ok: false; error: string };

async function fetchJson(
  ctx: QueryContext,
  url: string,
  label: string,
  suffix: string,
  ttlSeconds?: number,
): Promise<Fetched> {
  const apiKey = ctx.env.USGS_API_KEY;
  try {
    const res = await ctx.fetch(url, {
      cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:${suffix}`,
      ttlSeconds,
      ...(apiKey ? { headers: { "X-Api-Key": apiKey } } : {}),
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    if (!res.ok) return { ok: false, error: `USGS ${label} returned ${res.status}` };
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null || !("features" in body) || !Array.isArray(body.features)) {
      return { ok: false, error: `USGS ${label} did not return a FeatureCollection` };
    }
    return { ok: true, body };
  } catch (err) {
    const timedOut =
      typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
    return {
      ok: false,
      error: timedOut
        ? `USGS ${label} timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds`
        : `USGS ${label} returned no usable response`,
    };
  }
}

function hasNextPage(body: unknown): boolean {
  if (typeof body !== "object" || body === null || !("links" in body) || !Array.isArray(body.links)) return false;
  return body.links.some((l: unknown) => typeof l === "object" && l !== null && "rel" in l && l.rel === "next");
}

/**
 * A wide result's cut: the `limit` features with the largest v (features without v last), and the count before
 * the cut when there was one.
 */
export function keepLargest(fc: FeatureCollection, limit: number): { data: FeatureCollection; total?: number } {
  if (fc.features.length <= limit) return { data: fc };
  const vOf = (f: Feature) => (typeof f.properties?.v === "number" ? f.properties.v : -Infinity);
  const features = [...fc.features].sort((a, b) => vOf(b) - vOf(a)).slice(0, limit);
  return { data: { type: "FeatureCollection", features }, total: fc.features.length };
}

// ---- Live IV path (primary) ----

const STAT_URL = "https://waterservices.usgs.gov/nwis/stat/";
/** The statistics service rejects more than 10 sites per call. */
const STAT_BATCH = 10;
/**
 * Most gauges a query looks statistics up for (largest flow first), 10 per call: every gauge of any view under the
 * area cap seen so far (Colorado's 321), and the 400 largest of a wide box. The host takes 5 calls a second, so 40
 * calls is about 8 seconds on a cold cache; the week's cache makes the next view of the same gauges free.
 */
export const STAT_SITE_CAP = 400;
const STAT_TTL_SECONDS = 7 * 86_400;
const CFS_PER_M3S = 35.3147;
/** The highest percent of median shown: beyond 100 times the median the number says nothing more. */
export const MAX_PCT_OF_MEDIAN = 10_000;

/**
 * One calendar day's statistics at a gauge, from the daily mean flows of every year on record (cfs): the record low
 * and high, the 10th, 25th, 50th (median), 75th and 90th percentiles, and the years they cover. A field is absent
 * when USGS leaves it blank (short records get no percentiles).
 */
export type DayStats = {
  min?: number;
  p10?: number;
  p25?: number;
  p50?: number;
  p75?: number;
  p90?: number;
  max?: number;
  beginYr?: number;
  endYr?: number;
  years?: number;
};

const STAT_COLUMNS: [keyof DayStats, string][] = [
  ["min", "min_va"],
  ["p10", "p10_va"],
  ["p25", "p25_va"],
  ["p50", "p50_va"],
  ["p75", "p75_va"],
  ["p90", "p90_va"],
  ["max", "max_va"],
  ["beginYr", "begin_yr"],
  ["endYr", "end_yr"],
  ["years", "count_nu"],
];

/**
 * Daily statistics by site number and "MM-DD", from a stat-service RDB body (statTypeCd=all): `#` comment lines, a
 * header row, a column-width row, then one row per site, time series and calendar day. Days without a median are
 * left out.
 */
export function parseDailyStats(rdb: string): Map<string, Map<string, DayStats>> {
  const out = new Map<string, Map<string, DayStats>>();
  let header: string[] | null = null;
  let skippedWidths = false;
  for (const line of rdb.split(/\r?\n/)) {
    if (line.startsWith("#") || line.trim() === "") continue;
    const cols = line.split("\t");
    if (header === null) {
      header = cols;
      continue;
    }
    if (!skippedWidths) {
      skippedWidths = true;
      continue;
    }
    const row = Object.fromEntries(header.map((h, i) => [h, cols[i] ?? ""]));
    const month = Number(row.month_nu);
    const day = Number(row.day_nu);
    if (row.parameter_cd !== "00060" || !Number.isInteger(month) || !Number.isInteger(day)) continue;
    const stats: DayStats = {};
    for (const [key, col] of STAT_COLUMNS) {
      const raw = row[col];
      const n = Number(raw);
      if (raw !== undefined && raw.trim() !== "" && Number.isFinite(n)) stats[key] = n;
    }
    if (stats.p50 === undefined) continue;
    const key = `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    let site = out.get(row.site_no);
    if (site === undefined) {
      site = new Map();
      out.set(row.site_no, site);
    }
    // A site with several time series keeps the first seen for the day.
    if (!site.has(key)) site.set(key, stats);
  }
  return out;
}

/**
 * How a flow compares with the date's record, in USGS WaterWatch's percentile classes (which the USGS National Water
 * Dashboard still draws): under the 10th percentile of the daily mean flows for this calendar day is much below
 * normal, 10th to 24th below, 25th to 75th normal, 76th to 90th above, over the 90th much above; below the lowest or
 * above the highest daily mean ever recorded on the date are WaterWatch's "Low" and "High". Low to high, the ramp's order.
 */
export const FLOW_CLASSES = [
  { value: "record_low", label: "Lowest on record for the date", help: "Below every daily mean flow recorded on this calendar day (USGS WaterWatch calls it Low)." },
  { value: "much_below", label: "Much below normal", help: "Under the 10th percentile of the daily mean flows recorded on this calendar day." },
  { value: "below", label: "Below normal", help: "From the 10th to the 24th percentile of the daily mean flows recorded on this calendar day." },
  { value: "normal", label: "Normal", help: "From the 25th to the 75th percentile of the daily mean flows recorded on this calendar day." },
  { value: "above", label: "Above normal", help: "From the 76th to the 90th percentile of the daily mean flows recorded on this calendar day." },
  { value: "much_above", label: "Much above normal", help: "Over the 90th percentile of the daily mean flows recorded on this calendar day." },
  { value: "record_high", label: "Highest on record for the date", help: "Above every daily mean flow recorded on this calendar day (USGS WaterWatch calls it High)." },
] as const;

export type FlowClass = (typeof FLOW_CLASSES)[number]["value"];

/** The flow's class for the date (FLOW_CLASSES); undefined when USGS publishes no percentiles for the day. */
export function flowClass(cfs: number, s: DayStats): FlowClass | undefined {
  if (s.p10 === undefined || s.p25 === undefined || s.p75 === undefined || s.p90 === undefined) return undefined;
  if (s.min !== undefined && cfs < s.min) return "record_low";
  if (s.max !== undefined && cfs > s.max) return "record_high";
  if (cfs < s.p10) return "much_below";
  if (cfs < s.p25) return "below";
  if (cfs <= s.p75) return "normal";
  if (cfs <= s.p90) return "above";
  return "much_above";
}

/** The coarse word the model reads: below normal or lower is low, above normal or higher is high. */
function vsNormal(cls: FlowClass): "low" | "normal" | "high" {
  if (cls === "record_low" || cls === "much_below" || cls === "below") return "low";
  if (cls === "normal") return "normal";
  return "high";
}

/** A flow in cfs as people write it: whole numbers from 10 up, two significant figures below. */
function cfsText(n: number): string {
  if (n >= 10) return Math.round(n).toLocaleString("en-US");
  return String(Number(n.toPrecision(2)));
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Water temperature with °F first and °C second ("57 °F (14.0 °C)"), for US cards. */
export function waterTempText(c: number): string {
  return `${Math.round((c * 9) / 5 + 32)} °F (${c.toFixed(1)} °C)`;
}

/**
 * Gauge points from parsed IV sites. `main` is the parameter that becomes `v` (00060 or 00065); sites without it but
 * with a water temperature are kept with only the temperature. Statistics (when given) add, for the reading's local
 * calendar day: flowClass (FLOW_CLASSES), vsNormal, pctOfMedian, medianCfs, normalRange (the 25th to 75th percentile
 * in cfs) and recordYears.
 */
export function ivFeatures(
  sites: IvSite[],
  main: "00060" | "00065",
  stats: Map<string, Map<string, DayStats>>,
): FeatureCollection<Point> {
  const features: Feature<Point>[] = [];
  for (const site of sites) {
    const reading = site.readings[main];
    const temp = site.readings["00010"];
    if (reading === undefined && temp === undefined) continue;
    const properties: Record<string, string | number> = {
      ...gaugeNames(site.name),
      siteId: site.siteId,
      kind: "gauge",
    };
    if (reading !== undefined) {
      properties.t = new Date(reading.time).toISOString();
      properties.v = reading.value;
      // The published local time's date is the calendar day the statistics are keyed by.
      const monthDay = reading.local.slice(5, 10);
      const day = main === "00060" ? stats.get(site.siteNo)?.get(monthDay) : undefined;
      if (day !== undefined) {
        // A median under 1 cfs (a creek that is nearly dry on this date) makes the percent meaningless (19,777,778% seen).
        if (day.p50 !== undefined && day.p50 >= 1) {
          properties.pctOfMedian = Math.min(Math.round((reading.value / day.p50) * 100), MAX_PCT_OF_MEDIAN);
          properties.medianCfs = day.p50;
        }
        const cls = flowClass(reading.value, day);
        if (cls !== undefined) {
          properties.flowClass = cls;
          properties.vsNormal = vsNormal(cls);
        }
        if (day.p25 !== undefined && day.p75 !== undefined) properties.normalRange = `${cfsText(day.p25)} to ${cfsText(day.p75)} cfs`;
        if (day.beginYr !== undefined && day.endYr !== undefined) {
          properties.recordYears = `${day.beginYr} to ${day.endYr}${day.years !== undefined ? ` (${day.years} years)` : ""}`;
        }
      }
    } else if (temp !== undefined) {
      properties.t = new Date(temp.time).toISOString();
    }
    if (temp !== undefined) {
      properties.tempC = temp.value;
      properties.tempF = round1((temp.value * 9) / 5 + 32);
      properties.waterTemp = waterTempText(temp.value);
    }
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: site.coordinates }, properties });
  }
  return { type: "FeatureCollection", features };
}

/** Site numbers that get a statistics lookup: every gauge with a discharge reading, largest flow first, capped. */
export function statSites(sites: IvSite[], cap = STAT_SITE_CAP): string[] {
  return sites
    .filter((s) => s.readings["00060"] !== undefined)
    .sort((a, b) => (b.readings["00060"]?.value ?? 0) - (a.readings["00060"]?.value ?? 0))
    .slice(0, cap)
    .map((s) => s.siteNo)
    .sort();
}

async function fetchStats(
  ctx: QueryContext,
  siteNos: string[],
): Promise<{ stats: Map<string, Map<string, DayStats>>; failedBatches: number }> {
  const batches: string[][] = [];
  for (let i = 0; i < siteNos.length; i += STAT_BATCH) batches.push(siteNos.slice(i, i + STAT_BATCH));
  const bodies = await Promise.all(
    batches.map(async (batch) => {
      try {
        // statTypeCd=all (about 40 KB a site): a shorter list (min,max,p10,...,p90) came back with p90_va blank (2026-10-18).
        const res = await ctx.fetch(
          `${STAT_URL}?format=rdb&sites=${batch.join(",")}&statReportType=daily&statTypeCd=all&parameterCd=00060`,
          {
            // Statistics do not depend on the bbox, so the key is the site list alone.
            cacheKey: `streamflow:stat-all:${batch.join(",")}`,
            ttlSeconds: STAT_TTL_SECONDS,
            shouldCache: (body) => body.includes("p50_va"),
            timeoutMs: UPSTREAM_TIMEOUT_MS,
          },
        );
        return res.ok ? await res.text() : null;
      } catch {
        // Statistics are an extra; a failure leaves the class out (drawn as "No reading", with a note).
        return null;
      }
    }),
  );
  const stats = new Map<string, Map<string, DayStats>>();
  let failedBatches = 0;
  for (const body of bodies) {
    if (body === null || !body.includes("p50_va")) {
      failedBatches += 1;
      continue;
    }
    for (const [site, days] of parseDailyStats(body)) stats.set(site, days);
  }
  return { stats, failedBatches };
}

// ---- Outside the US: GloFAS via Open-Meteo ----

const FLOOD_API = "https://flood-api.open-meteo.com/v1/flood";
/** Rivers sampled outside the US (at most this many per view); one multi-location flood call covers them all. */
export const RIVER_POINTS = 12;
/** Most river ways read from Overpass; plenty to rank rivers by segment count, and bounds the response. */
export const RIVER_WAY_LIMIT = 3_000;

/** How many distinct named rivers an Overpass body holds. */
export function namedRiverCount(overpassJson: unknown): number {
  const elements =
    typeof overpassJson === "object" && overpassJson !== null && "elements" in overpassJson && Array.isArray(overpassJson.elements)
      ? overpassJson.elements
      : [];
  const names = new Set<string>();
  for (const raw of elements) {
    const parsed = RiverElementSchema.safeParse(raw);
    if (parsed.success && parsed.data.tags.name.trim() !== "") names.add(parsed.data.tags.name.trim());
  }
  return names.size;
}

const RiverElementSchema = z.object({
  type: z.literal("way"),
  id: z.number(),
  center: z.object({ lat: z.number(), lon: z.number() }),
  tags: z.object({ name: z.string() }).catchall(z.string()),
});

export type RiverPoint = { name: string; coordinates: [number, number] };

/**
 * One sample point per named river: the RIVER_POINTS rivers with the most way segments in the bbox (a proxy
 * for length), each at the segment centre closest to the mean of that river's segment centres.
 */
export function riverSamplePoints(overpassJson: unknown): RiverPoint[] {
  const elements =
    typeof overpassJson === "object" && overpassJson !== null && "elements" in overpassJson && Array.isArray(overpassJson.elements)
      ? overpassJson.elements
      : [];
  const byName = new Map<string, [number, number][]>();
  for (const raw of elements) {
    const parsed = RiverElementSchema.safeParse(raw);
    if (!parsed.success) continue;
    const name = parsed.data.tags.name.trim();
    if (name === "") continue;
    const list = byName.get(name) ?? [];
    list.push([parsed.data.center.lon, parsed.data.center.lat]);
    byName.set(name, list);
  }
  return [...byName.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, RIVER_POINTS)
    .map(([name, centres]) => {
      const mx = centres.reduce((s, c) => s + c[0], 0) / centres.length;
      const my = centres.reduce((s, c) => s + c[1], 0) / centres.length;
      let best = centres[0];
      let bestD = Infinity;
      for (const c of centres) {
        const d = (c[0] - mx) ** 2 + (c[1] - my) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      return { name, coordinates: best };
    });
}

const FloodSchema = z.object({
  daily: z.object({
    time: z.array(z.string()),
    river_discharge: z.array(z.number().nullable()),
  }),
});

/** Offsets in degrees around each river point; GloFAS cells are 0.05°, so this covers the 3 x 3 cells around it. */
const NEIGHBOUR_OFFSETS: [number, number][] = [-0.05, 0, 0.05].flatMap((dy) =>
  [-0.05, 0, 0.05].map((dx): [number, number] => [dx, dy]),
);

/** The flood-API sample locations: NEIGHBOUR_OFFSETS around each river point, in point order. */
export function floodSampleLocations(points: RiverPoint[]): [number, number][] {
  return points.flatMap((p) =>
    NEIGHBOUR_OFFSETS.map(([dx, dy]): [number, number] => [
      Number((p.coordinates[0] + dx).toFixed(4)),
      Number((p.coordinates[1] + dy).toFixed(4)),
    ]),
  );
}

function newestDischarge(row: unknown, today: string): { date: string; m3s: number } | undefined {
  const parsed = FloodSchema.safeParse(row);
  if (!parsed.success) return undefined;
  const { time, river_discharge } = parsed.data.daily;
  let best: { date: string; m3s: number } | undefined;
  time.forEach((date, j) => {
    const m3s = river_discharge[j];
    if (typeof m3s !== "number" || date > today) return;
    if (best === undefined || date > best.date) best = { date, m3s };
  });
  return best;
}

/**
 * Modelled points from a flood-API body for `floodSampleLocations(points)`. An OSM river point rarely falls in
 * the model cell that carries the river, and neighbouring cells hold only local runoff, so each river takes the
 * largest discharge among its 3 x 3 cells (newest day up to today).
 */
export function floodFeatures(points: RiverPoint[], body: unknown, now: Date): FeatureCollection<Point> {
  const rows = Array.isArray(body) ? body : [body];
  const today = now.toISOString().slice(0, 10);
  const features: Feature<Point>[] = [];
  points.forEach((point, i) => {
    let best: { date: string; m3s: number } | undefined;
    for (let k = 0; k < NEIGHBOUR_OFFSETS.length; k++) {
      const reading = newestDischarge(rows[i * NEIGHBOUR_OFFSETS.length + k], today);
      if (reading !== undefined && (best === undefined || reading.m3s > best.m3s)) best = reading;
    }
    if (best === undefined) return;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: point.coordinates },
      properties: {
        name: point.name,
        kind: "model",
        t: new Date(`${best.date}T00:00:00Z`).toISOString(),
        v: Math.round(best.m3s * CFS_PER_M3S),
        dischargeM3s: best.m3s,
      },
    });
  });
  return { type: "FeatureCollection", features };
}

async function queryOutsideUs(ctx: QueryContext, now: Date): Promise<LayerResult | LayerError> {
  const citation: Citation = {
    source: "GloFAS river discharge via the Open-Meteo flood API (CC BY 4.0, non-commercial use free); river names from OpenStreetMap (ODbL)",
    url: "https://open-meteo.com/en/docs/flood-api",
    retrieved: now.toISOString(),
  };
  const [west, south, east, north] = ctx.bbox;
  const rivers = await overpassQuery(
    ctx,
    `[out:json][timeout:25];way["waterway"="river"]["name"](${south},${west},${north},${east});out center tags ${RIVER_WAY_LIMIT};`,
    { cacheSuffix: "osm-rivers" },
  );
  if (!rivers.ok) return { error: rivers.error, hint: "upstream" };
  const points = riverSamplePoints(rivers.json);
  if (points.length === 0) {
    return { kind: "geojson", data: EMPTY, citation, coverageNote: "No named rivers in OpenStreetMap here" };
  }
  const locations = floodSampleLocations(points);
  const url =
    `${FLOOD_API}?latitude=${locations.map((l) => l[1]).join(",")}` +
    `&longitude=${locations.map((l) => l[0]).join(",")}` +
    `&daily=river_discharge&past_days=1&forecast_days=1&timezone=GMT`;
  let body: unknown;
  try {
    const res = await ctx.fetch(url, {
      cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:glofas`,
      ttlSeconds: 3_600,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    if (!res.ok) return { error: `Open-Meteo flood API returned ${res.status}`, hint: "upstream" };
    body = await res.json();
  } catch {
    return { error: "Open-Meteo flood API returned no usable response", hint: "upstream" };
  }
  const notes = ["Outside the United States: modelled daily river discharge (GloFAS, 5 km grid), not gauge readings; one point per major river"];
  const riverCount = namedRiverCount(rivers.json);
  const more = riverCount > points.length;
  // In wide mode run.ts writes the "showing N of M" note from `total`.
  if (more && !ctx.wide) notes.push(`Showing the ${points.length} longest of ${riverCount} named rivers in view; zoom in for the rest`);
  return {
    kind: "geojson",
    data: floodFeatures(points, body, now),
    citation,
    coverageNote: notes.join("; "),
    ...(more && ctx.wide ? { total: riverCount } : {}),
  };
}

// ---- Water Data API fallback ----

async function queryWaterDataApi(
  ctx: QueryContext,
  parameter: "00060" | "00065",
  now: Date,
  citation: Citation,
): Promise<LayerResult | LayerError> {
  const [west, south, east, north] = ctx.bbox;
  const latestUrl =
    `${BASE}/latest-continuous/items?bbox=${west},${south},${east},${north}` +
    `&parameter_code=${parameter}&site_type_code=ST&f=json&limit=${LATEST_LIMIT}`;
  const latest = await fetchJson(ctx, latestUrl, "latest values", "usgs-latest", LATEST_TTL_SECONDS);
  if (!latest.ok) return { error: latest.error, hint: "upstream" };

  if (rowsOf(latest.body).length === 0) {
    return { kind: "geojson", data: EMPTY, citation, coverageNote: "No USGS gauges in this area" };
  }

  const readings = latestReadings(latest.body, now);
  if (readings.length === 0) {
    return {
      kind: "geojson",
      data: EMPTY,
      citation,
      coverageNote: `No USGS gauges here have reported in the last ${MAX_AGE_DAYS} days`,
    };
  }

  const batches: string[][] = [];
  const ids = readings.map((r) => r.siteId);
  for (let i = 0; i < ids.length; i += NAME_BATCH_SIZE) batches.push(ids.slice(i, i + NAME_BATCH_SIZE));
  const named = await Promise.all(
    batches.map((batch, i) =>
      fetchJson(
        ctx,
        `${BASE}/monitoring-locations/items?id=${batch.join(",")}&f=json&limit=${NAME_BATCH_SIZE}` +
          `&properties=id,monitoring_location_name`,
        "site names",
        batches.length > 1 ? `usgs-names:${i}` : "usgs-names",
      ),
    ),
  );
  const bodies: unknown[] = [];
  for (const result of named) {
    if (!result.ok) return { error: result.error, hint: "upstream" };
    bodies.push(result.body);
  }

  const notes = ["Live USGS service unavailable; latest values from the USGS Water Data API without percent of median or water temperature"];
  if (hasNextPage(latest.body) && !ctx.wide) {
    notes.push(`Showing only the first ${LATEST_LIMIT.toLocaleString("en-US")} gauges, not all of them; zoom in for the rest`);
  }
  const all = toFeatures(readings, namesFrom(bodies));
  const { data, total } = ctx.wide ? keepLargest(all, ctx.wideStrategy?.limit ?? WIDE_LIMIT) : { data: all, total: undefined };
  return { kind: "geojson", data, citation, coverageNote: notes.join("; "), ...(total !== undefined && { total }) };
}

const USGS_WATER_URL = "https://waterservices.usgs.gov/";
const USGS_STATS_URL = "https://waterservices.usgs.gov/docs/statistics/";

/** What each number on a gauge card means (spec §12b), in the layer's own terms. */
const HELP: Record<string, FieldHelp> = {
  v: {
    text:
      "Discharge: the volume of water passing the gauge, in cubic feet per second (cfs); US readings are provisional. Outside the US it is the " +
      "GloFAS model's daily estimate converted to cfs, not a measurement. When the layer is asked for gage height instead, this number is the " +
      "water level in feet, whose zero point differs from gauge to gauge.",
    unit: "cubic feet per second (cfs)",
    source: "USGS; GloFAS via Open-Meteo outside the US",
    url: USGS_WATER_URL,
  },
  flowClass: {
    text:
      "Today's flow against every year on record for this calendar day, in the classes USGS WaterWatch used: much below normal is under the " +
      "10th percentile, below normal the 10th to 24th, normal the 25th to 75th, above normal the 76th to 90th, much above normal over the 90th; " +
      "lowest or highest on record is beyond every day recorded on this date. It compares one live reading with daily means, so a dam release " +
      "or the day's snowmelt can move it.",
    scale: "USGS WaterWatch percentile classes for the day of the year",
    source: "USGS NWIS daily statistics",
    url: USGS_STATS_URL,
  },
  pctOfMedian: {
    text: "Today's flow as a percent of the median daily flow for this calendar day over the gauge's years of record: 100% is a typical day for the date.",
    unit: "%",
    source: "USGS NWIS daily statistics",
    url: USGS_STATS_URL,
  },
  medianCfs: {
    text: "The median of the daily mean flows for this calendar day over the gauge's years of record.",
    unit: "cfs",
    source: "USGS NWIS daily statistics",
    url: USGS_STATS_URL,
  },
  normalRange: {
    text: "The middle half of the daily mean flows recorded on this calendar day (the 25th to 75th percentile): a flow in this range is normal for the date.",
    unit: "cfs",
    source: "USGS NWIS daily statistics",
    url: USGS_STATS_URL,
  },
  recordYears: { text: "The years of daily flow the statistics for this date are computed from, and how many of them have a value for the date." },
  waterTemp: {
    text: "Water temperature where the gauge measures it, in °F with °C after it; trout feed best around 50 to 64 °F (10 to 18 °C) and are stressed above about 68 °F (20 °C).",
    source: "USGS NWIS instantaneous values",
    url: USGS_WATER_URL,
  },
  tempF: { text: "Water temperature where the gauge measures it; trout get stressed above about 68 °F (20 °C).", unit: "°F" },
  tempC: { text: "Water temperature where the gauge measures it; trout get stressed above about 20 °C.", unit: "°C" },
  dischargeM3s: { text: "The GloFAS model's daily discharge in its own unit; a rough estimate, not a gauge reading.", unit: "cubic metres per second" },
  floodCategory: {
    text: "Where the river stands against the NWS flood categories for this gauge: below flood stage, action stage (near flooding, when the NWS starts watching), minor, moderate or major flooding.",
    source: "NOAA National Water Prediction Service",
    url: "https://water.noaa.gov/",
  },
  floodStatus: { text: "The water level now (stage, in feet at this gauge's own zero) against the level where the river floods here.", source: "NOAA National Water Prediction Service", url: "https://water.noaa.gov/" },
  forecastCrest: { text: "The highest level in the NWS river forecast for the next days, when it comes, and its flood category.", source: "NOAA National Water Prediction Service", url: "https://water.noaa.gov/" },
  forecastDays: { text: "Each day's highest forecast level and flow, in local time.", source: "NOAA National Water Prediction Service", url: "https://water.noaa.gov/" },
  releaseForecast: { text: "The Army Corps of Engineers' forecast release from the dam, each day's highest, in local time; schedules change.", source: "USACE Corps Water Management System", url: "https://water.usace.army.mil/" },
};

/** Plain words for each class on the card, with the percentile band it stands for. */
const CLASS_WORDS: Record<FlowClass, string> = {
  record_low: "Lowest on record for the date",
  much_below: "Much below normal (under the 10th percentile for the date)",
  below: "Below normal (10th to 24th percentile for the date)",
  normal: "Normal (25th to 75th percentile for the date)",
  above: "Above normal (76th to 90th percentile for the date)",
  much_above: "Much above normal (over the 90th percentile for the date)",
  record_high: "Highest on record for the date",
};

/** The gauge card: the flow under its own name, then how it compares with the date's record. */
const CARD: CardSpec = {
  measure: { key: "v", label: "Flow", unit: "cfs" },
  facts: [
    { key: "flowClass", label: "Running", values: CLASS_WORDS },
    { key: "pctOfMedian", label: "Flow vs. the date's median", unit: "%", format: "int" },
    { key: "medianCfs", label: "Median flow for the date", unit: "cfs" },
    { key: "normalRange", label: "Normal range for the date" },
    { key: "recordYears", label: "Years of record" },
    { key: "waterTemp", label: "Water temperature" },
    { key: "floodStatus", label: "Flood stage" },
    { key: "floodCategory", label: "Flooding now", values: CATEGORY_WORDS },
    { key: "forecastCrest", label: "Forecast high" },
    { key: "forecastCategory", label: "Forecast flooding", values: CATEGORY_WORDS },
    { key: "forecastDays", label: "River forecast", format: "list" },
    { key: "forecastIssued", label: "Forecast issued" },
    { key: "releaseForecast", label: "Release forecast", format: "list" },
    { key: "releaseNote", label: "About the release" },
    { key: "dischargeM3s", label: "Flow in cubic metres", unit: "m³/s", format: "1dp" },
    { key: "kind", label: "Reading", values: { gauge: "Measured at a USGS gauge", model: "Modelled by GloFAS (a rough estimate)", nws: "Measured at an NWS river gauge", release: "Dam release, Army Corps of Engineers" } },
    { key: "siteId", label: "USGS site" },
    { key: "nwsId", label: "NWS gauge" },
  ],
  links: [
    { key: "nwsLink", label: "NWS river forecast page" },
    { key: "cwmsLink", label: "Corps of Engineers water data" },
  ],
  // The title is the station name in plain words; USGS's own abbreviated capitals stay off the card.
  hidden: ["vsNormal", "tempC", "tempF", "nameInSource", "stageFt", "actionStageFt", "floodStageFt", "moderateStageFt", "majorStageFt"],
};

/** NWS flood categories, lowest first. */
const FLOOD_LEVELS = [
  { value: "no_flooding", label: "Below flood stage" },
  { value: "action", label: "Action stage", help: "Near flooding: the NWS starts watching the river." },
  { value: "minor", label: "Minor flooding" },
  { value: "moderate", label: "Moderate flooding" },
  { value: "major", label: "Major flooding" },
];

/**
 * The class for the date colors each gauge on the ordinal ramp (lowest on record at the low end, highest at the high
 * end) and flow sizes it; a gauge without statistics for the date draws off-white ("No reading"). Water temperature
 * is the second color a person can switch to.
 */
const ATTRIBUTES: Attribute[] = [
  {
    key: "flowClass",
    type: "ordinal",
    label: "Flow vs. normal for the date",
    levels: FLOW_CLASSES.map((c) => ({ value: c.value, label: c.label, help: c.help })),
    scale: "USGS WaterWatch percentile classes for the day of the year",
    primary: true,
  },
  { key: "v", type: "measure", label: "Flow", unit: "cfs", encode: "size", aggregate: "sum" },
  { key: "pctOfMedian", type: "measure", label: "Flow vs. the date's median", unit: "%" },
  { key: "tempF", type: "measure", label: "Water temperature", unit: "°F", aggregate: "mean" },
  {
    key: "kind",
    type: "category",
    label: "Reading",
    levels: [
      { value: "gauge", label: "USGS gauge", help: "Measured at a USGS stream gauge (United States)." },
      { value: "model", label: "Modelled river", help: "GloFAS model estimate outside the United States; a rough figure, not a measurement." },
      { value: "nws", label: "NWS river gauge", help: "A National Weather Service river gauge with no USGS gauge beside it (stage, sometimes flow)." },
      { value: "release", label: "Dam release", help: "The Army Corps of Engineers' measured release below a dam." },
    ],
  },
  {
    key: "floodCategory",
    type: "ordinal",
    label: "Flooding now",
    levels: FLOOD_LEVELS,
    scale: "NWS flood categories for the gauge",
  },
  {
    key: "forecastCategory",
    type: "ordinal",
    label: "Forecast flooding",
    levels: FLOOD_LEVELS,
    scale: "NWS flood categories, the highest in the river forecast",
  },
];

/** The key: one entry per class on the ramp, then the gauges the ramp cannot place. */
const LEGEND: LegendSpec = {
  kind: "categories",
  title: "Flow vs. normal for the date",
  field: "flowClass",
  items: [
    ...FLOW_CLASSES.map((c) => ({ label: c.label, value: c.value, symbol: "point" as const, help: c.help })),
    {
      label: "No reading",
      color: OFF_WHITE,
      symbol: "point" as const,
      help: "No long-term statistics for this gauge on this date (a short record, gage height asked, or a modelled river outside the US).",
    },
  ],
  note: "Symbol size is the flow in cfs.",
};

const streamflow = defineLayer({
  id: "streamflow",
  title: "Stream flow (USGS gauges, live)",
  description:
    "Live river and stream flow: how much water is running right now and whether that is high or low for the date. User words: CFS, flow, river level, running high, running low, blown out, water temperature. " +
    "In the United States each point is a USGS gauge with name (the station name with USGS abbreviations spelled out; nameInSource is USGS's own spelling), siteId, t (UTC time of the reading, usually 15 to 60 minutes old), v and kind 'gauge'. " +
    "parameter 00060 (default): v is discharge in cubic feet per second (cfs), the volume of water passing the gauge. parameter 00065: v is gage height in feet, the water level at the gauge; its zero point is arbitrary per gauge, so compare it only to the same gauge. " +
    "flowClass compares today's flow with every year on record for this calendar day in the USGS WaterWatch percentile classes: record_low (lowest on record for the date), much_below (under the 10th percentile), below (10th to 24th), normal (25th to 75th), above (76th to 90th), much_above (over the 90th), record_high; use it to say a river is running high or low. " +
    "pctOfMedian is today's flow as a percent of the median for the date (medianCfs, in cfs), normalRange the 25th to 75th percentile in cfs, recordYears the years behind them, vsNormal the coarse word (low, normal or high). Every gauge in view gets them (up to the 400 largest in a very wide box); a gauge whose record is too short has none. " +
    "tempC and tempF are water temperature where the gauge measures it (useful for fishing: trout get stressed above about 68 °F, 20 °C). " +
    "Outside the United States, points are modelled, not measured: kind 'model', one per major river, v is the GloFAS model's daily discharge converted to cfs (dischargeM3s is the original in m³/s), t is the day; treat it as a rough estimate, and a small river right beside a big one can show the big one's flow. " +
    "Flood stage and forecasts (US, from the NOAA National Water Prediction Service): gauges the NWS watches carry nwsId, stageFt (water level now), floodStageFt and actionStageFt, floodStatus ('Stage 1.2 ft; flood stage 9.5 ft: 8.3 ft below flood stage'), floodCategory (no_flooding, action, minor, moderate, major), and where the NWS forecasts the river, forecastCrest (the highest level coming and when), forecastCategory and forecastDays (each day's highest level and flow); kind 'nws' is an NWS gauge with no USGS gauge beside it. For 'is the river going to flood' compare stage to flood stage and quote the forecast, not the percent of median. " +
    "Dam releases: kind 'release' is the Army Corps of Engineers' measured release below a dam people paddle (the Gauley below Summersville Dam), v in cfs, releaseForecast by day; for 'is the Gauley running' quote it. " +
    "Runnable ranges for paddling are not in the data (American Whitewater's ranges have no open licence): give the flow and say the range is not known here; never call a run runnable. " +
    "Example questions: 'What is the Truckee running at?', 'Which rivers near here are running high?', 'Is the French Broad going to flood?', 'Is the Gauley running?'. " +
    "Caveats: US readings are provisional and can be revised; ice, debris or a dry channel can give 0 or odd values; gauges silent for 7 days are left out; " +
    "the class compares one instantaneous reading to daily means, so it swings with dam releases and daily snowmelt cycles. " +
    "Over 400,000 km² it returns up to 1,000 gauges, highest flow first.",
  coverage: "global",
  surface: "land",
  license: "Public domain (USGS); outside the US GloFAS via Open-Meteo, CC BY 4.0, free for non-commercial use only",
  requiredEnv: [],
  optionalEnv: ["USGS_API_KEY", "OVERPASS_URL"],
  maxAreaKm2: 400_000,
  // Default hard cap (1.6 million km²): about 7 IV strips in the lower 48, fetched in parallel.
  wide: { orderBy: "current flow or gage height", limit: WIDE_LIMIT },
  input: inputSchema,
  style: { geometry: "point", color: layerColor("streamflow"), unit: "cfs", encode: { size: "v", color: "flowClass" } },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  // One latest reading per gauge: say its time, no scrubber.
  time: { shape: "single" },
  legend: LEGEND,
  labels: { field: "name", max: 5, rankBy: "v" },
  // USGS data in cfs and feet; temperatures in °F first.
  display: { units: "us", timeZone: "local" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const now = new Date();
    if (outsideUs(ctx.bbox)) return queryOutsideUs(ctx, now);

    const liveCitation: Citation = {
      source: "USGS NWIS instantaneous values and daily statistics (public domain; provisional data)",
      url: "https://waterservices.usgs.gov/",
      retrieved: now.toISOString(),
    };
    const strips = ivStrips(ctx.bbox).length;
    if (strips > MAX_IV_STRIPS) {
      return {
        error: `This box needs ${strips} USGS requests (at most ${MAX_IV_STRIPS}); zoom in`,
        hint: "zoom_in",
      };
    }
    const iv = await fetchIv(ctx, [input.parameter, "00010"], "usgs-iv", LATEST_TTL_SECONDS);
    if (!iv.ok) {
      return queryWaterDataApi(ctx, input.parameter, now, {
        source: "USGS Water Data API, latest continuous values (public domain; provisional data)",
        url: "https://api.waterdata.usgs.gov/",
        retrieved: now.toISOString(),
      });
    }
    const sites = parseIv(iv.bodies, now);
    if (sites.length === 0) {
      return { kind: "geojson", data: EMPTY, citation: liveCitation, coverageNote: "No active USGS stream gauges in this area" };
    }

    const statFor = input.parameter === "00060" ? statSites(sites) : [];
    const looked =
      statFor.length > 0 ? await fetchStats(ctx, statFor) : { stats: new Map<string, Map<string, DayStats>>(), failedBatches: 0 };
    const all = ivFeatures(sites, input.parameter, looked.stats);
    const notes: string[] = [];
    let citation = liveCitation;
    if (!ctx.wide) {
      // Dam releases first, so the NWS gauge at the dam's outlet joins the release instead of drawing twice.
      const releases = await releaseFeatures(ctx, ctx.bbox, now);
      all.features.push(...releases);
      const river = await joinRiverForecasts(ctx, all.features, now);
      all.features.push(...river.added);
      if (river.note) notes.push(river.note);
      const withStages = all.features.filter((f) => f.properties?.floodStatus !== undefined).length;
      if (withStages + river.forecasts > 0) {
        const flooding = all.features.filter((f) => ["minor", "moderate", "major"].includes(String(f.properties?.floodCategory))).length;
        const forecastFlooding = all.features.filter((f) => ["minor", "moderate", "major"].includes(String(f.properties?.forecastCategory))).length;
        notes.push(
          `${withStages} gauges show stage against NWS flood stage and ${river.forecasts} carry an NWS river forecast; ` +
            `${flooding} at or above flood stage now, ${forecastFlooding} forecast to reach it`,
        );
      }
      if (releases.length > 0) {
        notes.push(`dam release from the Corps of Engineers: ${releases.map((r) => `${r.properties?.name} ${Number(r.properties?.v).toLocaleString("en-US")} cfs`).join("; ")}`);
      }
      citation = {
        ...liveCitation,
        source: `${liveCitation.source}; NOAA National Water Prediction Service stages, flood stages and river forecasts (public domain)${releases.length > 0 ? "; USACE CWMS dam releases (public domain)" : ""}`,
      };
    }
    const { data, total } = ctx.wide ? keepLargest(all, ctx.wideStrategy?.limit ?? WIDE_LIMIT) : { data: all, total: undefined };
    const withFlow = sites.filter((s) => s.readings[input.parameter] !== undefined).length;
    if (looked.failedBatches > 0) {
      notes.push(
        looked.stats.size === 0
          ? "The USGS statistics service did not answer, so no gauge says whether it is running high or low"
          : "The USGS statistics service failed for some gauges, so they show no reading against normal",
      );
    }
    if (input.parameter === "00060" && withFlow > STAT_SITE_CAP) {
      notes.push(`Flow against normal is given for the ${STAT_SITE_CAP} largest-flow gauges of ${withFlow}; zoom in for the rest`);
    }
    if (input.parameter === "00065") notes.push("Gage height has no statistics for the date, so no gauge is classed against normal");
    return {
      kind: "geojson",
      data,
      citation,
      ...(total !== undefined && { total }),
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(streamflow);

export default streamflow;
