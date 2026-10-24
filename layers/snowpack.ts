/**
 * Live snowpack from NRCS SNOTEL stations: snow depth, snow water equivalent (SWE), air temperature, 24-hour
 * new snow, density and a snow-type class, via the AWDB REST API
 * (https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1; OpenAPI at /awdbRestApi/v3/api-docs).
 * Verified against the live API on 2026-10-09/10:
 *   - `stations` has NO bounding-box parameters and no `networkCds`: unknown query parameters are
 *     silently ignored and the call returns every station in every network (4,398 rows, 1.6 MB).
 *     The working filter is `stationTriplets=*:*:SNTL` (wildcards allowed in any part of the
 *     `stationId:stateCode:networkCode` triplet) plus `elements=WTEQ&durations=DAILY&activeOnly=true`,
 *     which returns the ~890 active SNOTEL stations (~390 KB), Alaska included. The bbox is applied here.
 *     Station fields used: stationTriplet, name, elevation (feet), latitude, longitude, dataTimeZone (hours
 *     from UTC of the station's clock: -8 for most of the West, even Montana and Colorado; -9 in Alaska).
 *   - `data?stationTriplets=<comma list>&elements=SNWD,WTEQ,TOBS&duration=HOURLY&beginDate=YYYY-MM-DD HH:mm
 *     &endDate=...&returnFlags=false` returns [{ stationTriplet, data: [{ stationElement: { elementCode,
 *     storedUnitCode }, values: [{ date: "2026-10-09 17:00", value }] }] }]. Dates are station local standard
 *     time; SNWD and WTEQ are inches, TOBS °F. Hourly values arrive within about an hour (at 02:00 UTC the
 *     newest was 17:00 PST, i.e. 01:00 UTC). Hours with no reading are simply missing from `values`.
 *     There is no hourly new-snow element, so new24h is the depth gain over the last 24 hours (never below 0).
 *   - Density = SWE / depth x 1000 kg/m3, only when depth >= 2 in (shallower depths make the ratio noise) and
 *     the result is at most 650 (higher means the depth sensor and the snow pillow disagree). Type classes:
 *     powder < 150, settled 150-300, wet/dense > 300; "no snow" when the depth reads 0.
 * The station list is cached a day under one shared key; each view's data call 15 minutes.
 *
 * Live smoke 2026-10-10 ~02:20 UTC: Tahoe box, 17 stations, 0-1 in (no snow yet; Blue Lakes "no snow", 13.6 °C);
 * Alaska Range box [-146.5,62.8,-145,63.6], 2.3 s: Look Eyrie (5,040 ft) 40 in deep, SWE 9.6 in, density 240
 * kg/m3 "settled", -3.3 °C; Fielding Lake 4 in, SWE 1.3 in, 325 kg/m3 "wet/dense", +1 in in 24 h.
 * Wide smoke through runLayer (2026-10-14), whole West [-125,31,-102,49] (3.9 million km²), 11.2 s cold: all 831
 * stations (804 with a depth reading; early-season depths 0-6 in), 9 data calls of up to 100 stations.
 * Normal (added 2026-10-18): `data?...&elements=WTEQ&duration=DAILY&centralTendencyType=MEDIAN` gives each daily SWE
 *   value its 1991-2020 `median` for that day, and `timingCentralTendencies` (medianOnset month/day, medianPeak value):
 *   Mount Hood Test Site 651:OR:SNTL on 2026-03-01 had 16.4 in against a median of 43.6 (38%); on 2026-10-16, 0.0 against
 *   0.0, onset normally 30 Oct, peak 59.4 in. In a view under 400,000 km² the layer asks for it alongside the hourly
 *   data (cached 6 hours) and adds pctMedian (only when the median is 1 in or more, so October's 0/0 is never a
 *   percentage), vsNormal (NRCS-style bands), normalOnset and medianPeakIn. Stations are colored by vsNormal, sized by
 *   depth, and the three deepest are named on the map.
 * The reading time is also given in the station's own time zone (readingLocal, "Oct 17, 5 PM PDT"): `t` is UTC, and its
 *   calendar day was a day ahead of a western viewer in the evening. A data call that answers 5xx is tried once more.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext, type CardSpec, type Attribute, type FieldHelp } from "./types";
import { nameAttribute } from "./_shared/bands";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { OUTSIDE_US_NOTE, WHOLE_US_KM2, bboxesDisjoint, outsideUs } from "./_shared/coverage";
import { jsonArrayBody } from "@/lib/fetch/validate";
import { layerColor } from "@/lib/render/palette";

const AWDB = "https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1";

/** The data call accepts long triplet lists; batches of 100 keep each URL short. */
const BATCH_SIZE = 100;
const HOUR_MS = 3_600_000;
/** Hours of history requested (in UTC, widened for any station clock) so 24-hour change can be computed. */
const WINDOW_BACK_HOURS = 36;
const WINDOW_AHEAD_HOURS = 12;
/** A reading older than this is a station that has stopped reporting; it stays on the map without values. */
const MAX_AGE_HOURS = 48;
const STATIONS_TTL_SECONDS = 86_400;
/** Stations report hourly; 15 minutes keeps the map current. */
const DATA_TTL_SECONDS = 900;
/** Most stations a wide (over 400,000 km²) result carries; the whole active network is about 890. */
export const WIDE_LIMIT = 1000;
const MIN_DEPTH_FOR_DENSITY_IN = 2;
const MAX_PLAUSIBLE_DENSITY = 650;
/** Medians change once a day. */
const MEDIAN_TTL_SECONDS = 6 * 3_600;
/** Below this median SWE (in) a percentage of median says nothing (October: 0 against 0). */
export const MIN_MEDIAN_SWE_IN = 1;

/** NRCS-style bands of percent of median SWE, low to high. */
export const VS_NORMAL = [
  { value: "well-below", label: "Well below normal (under 70%)", max: 70 },
  { value: "below", label: "Below normal (70 to 89%)", max: 90 },
  { value: "near", label: "Near normal (90 to 109%)", max: 110 },
  { value: "above", label: "Above normal (110 to 129%)", max: 130 },
  { value: "well-above", label: "Well above normal (130% and up)", max: Number.POSITIVE_INFINITY },
] as const;

export function vsNormalOf(pct: number): (typeof VS_NORMAL)[number]["value"] {
  return (VS_NORMAL.find((b) => pct < b.max) ?? VS_NORMAL[VS_NORMAL.length - 1]).value;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A station's IANA zone from its standard-time offset and state (Arizona keeps standard time all year). */
export function stationZone(offsetHours: number | undefined, triplet: string): string {
  const state = triplet.split(":")[1];
  if (state === "AZ") return "America/Phoenix";
  if (offsetHours === -9 || state === "AK") return "America/Anchorage";
  if (offsetHours === -7) return "America/Denver";
  return "America/Los_Angeles";
}

/** "Oct 17, 5 PM PDT" in the station's own zone. */
export function localReading(ms: number, zone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", hour: "numeric", timeZoneName: "short" }).format(new Date(ms));
}

const MedianSchema = z.object({
  stationTriplet: z.string(),
  data: z
    .array(
      z.object({
        stationElement: z.object({ elementCode: z.string() }).passthrough().optional(),
        timingCentralTendencies: z
          .object({
            medianPeak: z.object({ value: z.number().nullish() }).passthrough().nullish(),
            medianOnset: z.object({ month: z.number(), day: z.number() }).passthrough().nullish(),
          })
          .passthrough()
          .nullish(),
        values: z.array(z.object({ date: z.string(), value: z.number().nullish(), median: z.number().nullish() })).optional(),
      }),
    )
    .optional(),
});
export type SnotelMedian = z.infer<typeof MedianSchema>;

/** Each station's newest daily SWE against its median for that day, and when snow normally arrives and peaks. */
export type Normal = { swe?: number; median?: number; onset?: string; peakIn?: number };

export function parseMedians(rows: SnotelMedian[]): Map<string, Normal> {
  const out = new Map<string, Normal>();
  for (const row of rows) {
    const block = row.data?.find((d) => d.stationElement?.elementCode === "WTEQ");
    if (!block) continue;
    const n: Normal = {};
    const latest = [...(block.values ?? [])].reverse().find((v) => typeof v.value === "number" && typeof v.median === "number");
    if (latest) {
      n.swe = latest.value as number;
      n.median = latest.median as number;
    }
    const onset = block.timingCentralTendencies?.medianOnset;
    if (onset && onset.month >= 1 && onset.month <= 12) n.onset = `${MONTH_NAMES[onset.month - 1]} ${onset.day}`;
    const peak = block.timingCentralTendencies?.medianPeak?.value;
    if (typeof peak === "number" && Number.isFinite(peak)) n.peakIn = round1(peak);
    out.set(row.stationTriplet, n);
  }
  return out;
}

/** Adds pctMedian and vsNormal (when the median is 1 in or more), normalOnset and medianPeakIn to each station. */
export function addNormals(fc: FeatureCollection, normals: Map<string, Normal>): void {
  for (const f of fc.features) {
    const p = f.properties as Record<string, string | number>;
    const n = normals.get(String(p.stationId));
    if (!n) continue;
    if (n.swe !== undefined && n.median !== undefined && n.median >= MIN_MEDIAN_SWE_IN) {
      p.pctMedian = Math.round((100 * n.swe) / n.median);
      p.vsNormal = vsNormalOf(p.pctMedian);
      p.medianSwe = n.median;
    } else if (n.median !== undefined) {
      // Early in the season the percent means nothing (0 of 0.2 in); the card says so instead of leaving the row out.
      p.normalNote = `Too early in the season to compare: the normal for today is ${n.median} in of snow water${n.onset ? `, and snow normally arrives ${n.onset}` : ""}`;
    }
    if (n.onset) p.normalOnset = n.onset;
    if (n.peakIn !== undefined) p.medianPeakIn = n.peakIn;
  }
}

const WEST_US: BBox = [-125, 31, -102, 49];
const ALASKA: BBox = [-170, 51, -129, 72];

const StationSchema = z.object({
  stationTriplet: z.string(),
  name: z.string(),
  elevation: z.number().optional(),
  latitude: z.number(),
  longitude: z.number(),
  dataTimeZone: z.number().optional(),
});
export type SnotelStation = z.infer<typeof StationSchema>;

const DataSchema = z.object({
  stationTriplet: z.string(),
  data: z
    .array(
      z.object({
        stationElement: z.object({ elementCode: z.string() }).passthrough().optional(),
        values: z.array(z.object({ date: z.string(), value: z.number().nullable().optional() })).optional(),
      }),
    )
    .optional(),
});
export type SnotelData = z.infer<typeof DataSchema>;

const inputSchema = z.object({});

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

/** Parses each row on its own so one malformed station does not discard the rest. */
function parseRows<T>(schema: z.ZodType<T>, rows: unknown[]): T[] {
  const out: T[] = [];
  for (const row of rows) {
    const parsed = schema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function inBbox(s: SnotelStation, [west, south, east, north]: BBox): boolean {
  return s.longitude >= west && s.longitude <= east && s.latitude >= south && s.latitude <= north;
}

type Reading = { time: number; value: number };

/** "2026-10-09 17:00" on a clock `offsetHours` from UTC, as UTC ms. */
function stationTime(date: string, offsetHours: number): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(date);
  if (!m) return NaN;
  const local = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
  return local - offsetHours * HOUR_MS;
}

/** Each element's readings (UTC, ascending), numeric values only. */
function seriesByElement(row: SnotelData | undefined, offsetHours: number): Map<string, Reading[]> {
  const out = new Map<string, Reading[]>();
  for (const block of row?.data ?? []) {
    const code = block.stationElement?.elementCode;
    if (code === undefined) continue;
    const list = out.get(code) ?? [];
    for (const v of block.values ?? []) {
      if (typeof v.value !== "number" || !Number.isFinite(v.value)) continue;
      const time = stationTime(v.date, offsetHours);
      if (Number.isFinite(time)) list.push({ time, value: v.value });
    }
    list.sort((a, b) => a.time - b.time);
    out.set(code, list);
  }
  return out;
}

/** The reading closest to `target` within `toleranceMs`, or undefined. */
function nearest(list: Reading[], target: number, toleranceMs: number): Reading | undefined {
  let best: Reading | undefined;
  for (const r of list) {
    const d = Math.abs(r.time - target);
    if (d <= toleranceMs && (best === undefined || d < Math.abs(best.time - target))) best = r;
  }
  return best;
}

export type SnowType = "no snow" | "powder" | "settled" | "wet/dense";

/** Snow type from density in kg/m3. */
export function snowType(density: number): Exclude<SnowType, "no snow"> {
  if (density < 150) return "powder";
  if (density <= 300) return "settled";
  return "wet/dense";
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Joins stations to their latest hourly readings and keeps those inside `bbox`. v is snow depth (in) at the
 * newest depth reading; swe, density, type, new24h and tempC are added when they can be computed. Stations
 * without a recent depth reading stay on the map with no `v` or `t`.
 */
export function joinSnotel(stations: SnotelStation[], data: SnotelData[], bbox: BBox, now: Date): FeatureCollection {
  const byTriplet = new Map(data.map((row) => [row.stationTriplet, row]));
  const cutoff = now.getTime() - MAX_AGE_HOURS * HOUR_MS;
  const features: Feature<Point>[] = [];
  for (const s of stations) {
    if (!inBbox(s, bbox)) continue;
    const properties: Record<string, string | number> = { name: s.name, stationId: s.stationTriplet };
    if (s.elevation !== undefined) properties.elevationFt = s.elevation;
    const series = seriesByElement(byTriplet.get(s.stationTriplet), s.dataTimeZone ?? -8);
    const depths = (series.get("SNWD") ?? []).filter((r) => r.time >= cutoff);
    const depth = depths[depths.length - 1];
    if (depth !== undefined) {
      properties.t = new Date(depth.time).toISOString();
      properties.readingLocal = localReading(depth.time, stationZone(s.dataTimeZone, s.stationTriplet));
      properties.v = depth.value;
      const swe = nearest(series.get("WTEQ") ?? [], depth.time, 2 * HOUR_MS);
      if (swe !== undefined) properties.swe = swe.value;
      if (depth.value <= 0) {
        properties.type = "no snow";
      } else if (swe !== undefined && depth.value >= MIN_DEPTH_FOR_DENSITY_IN) {
        const density = Math.round((swe.value / depth.value) * 1000);
        if (density <= MAX_PLAUSIBLE_DENSITY) {
          properties.density = density;
          properties.type = snowType(density);
        }
      }
      const dayAgo = nearest(depths, depth.time - 24 * HOUR_MS, 2 * HOUR_MS);
      if (dayAgo !== undefined) properties.new24h = Math.max(0, depth.value - dayAgo.value);
    }
    const temps = (series.get("TOBS") ?? []).filter((r) => r.time >= cutoff);
    const temp = temps[temps.length - 1];
    if (temp !== undefined) properties.tempC = round1(((temp.value - 32) * 5) / 9);
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.longitude, s.latitude] },
      properties,
    });
  }
  return { type: "FeatureCollection", features };
}

/**
 * A wide result's cut: the `limit` stations with the deepest snow (stations without a reading last), and the
 * count before the cut when there was one.
 */
export function keepDeepest(fc: FeatureCollection, limit: number): { data: FeatureCollection; total?: number } {
  if (fc.features.length <= limit) return { data: fc };
  const vOf = (f: Feature) => (typeof f.properties?.v === "number" ? f.properties.v : -Infinity);
  return {
    data: { type: "FeatureCollection", features: [...fc.features].sort((a, b) => vOf(b) - vOf(a)).slice(0, limit) },
    total: fc.features.length,
  };
}

/** The shared station list is cached for a day, so only a non-empty list of station rows is stored. */
export const STATION_LIST_BODY = jsonArrayBody({
  item: (row) => typeof row === "object" && row !== null && "stationTriplet" in row,
});

type Fetched = { ok: true; rows: unknown[] } | { ok: false; error: string };

async function fetchRows(
  ctx: QueryContext,
  url: string,
  label: string,
  cacheKey: string | undefined,
  ttlSeconds: number,
  validate: (body: string) => boolean = jsonArrayBody({ minLength: 0 }),
): Promise<Fetched> {
  try {
    let res = await ctx.fetch(url, { cacheKey, ttlSeconds, validate, timeoutMs: UPSTREAM_TIMEOUT_MS });
    // AWDB answers an occasional 500 that the next call does not (one in three during the 2026-10-17 audit): try once more.
    if (res.status >= 500) res = await ctx.fetch(url, { cacheKey, ttlSeconds, validate, timeoutMs: UPSTREAM_TIMEOUT_MS });
    if (!res.ok) return { ok: false, error: `SNOTEL ${label} returned ${res.status}` };
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return { ok: false, error: `SNOTEL ${label} did not return a list` };
    return { ok: true, rows: body };
  } catch (err) {
    const timedOut =
      typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
    return {
      ok: false,
      error: timedOut
        ? `SNOTEL ${label} timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds`
        : `SNOTEL ${label} returned no usable response`,
    };
  }
}

/** "YYYY-MM-DD HH:mm" in UTC. */
function stamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

const ATTRIBUTES: Attribute[] = [
  {
    key: "type",
    type: "category",
    label: "Snow type",
    levels: [
      { value: "no snow", label: "No snow" },
      { value: "powder", label: "Powder" },
      { value: "settled", label: "Settled" },
      { value: "wet/dense", label: "Wet or dense" },
    ],
  },
  { key: "v", type: "measure", label: "Snow depth", unit: "in", encode: "size" },
  {
    key: "vsNormal",
    type: "ordinal",
    label: "Compared with normal",
    scale: "Percent of the 1991-2020 median snow water equivalent for the day",
    levels: VS_NORMAL.map((b) => ({ value: b.value, label: b.label })),
  },
  { key: "pctMedian", type: "measure", label: "Percent of normal", unit: "%" },
  nameAttribute(),
];

const SNOTEL_URL = "https://wcc.sc.egov.usda.gov/";

const HELP: Record<string, FieldHelp> = {
  v: {
    text:
      "Snow depth at the station's latest hourly reading, measured by the SNOTEL depth sensor over one flat clearing; it jitters by an inch or " +
      "two.",
    unit: "in",
    source: "USDA NRCS SNOTEL",
    url: SNOTEL_URL,
  },
  swe: {
    text: "Snow water equivalent: the water you would get by melting the snow, the standard measure of how much water the snowpack holds.",
    unit: "in",
    source: "USDA NRCS SNOTEL",
    url: SNOTEL_URL,
  },
  density: {
    text: "Snow water equivalent divided by depth, computed by this app: a whole-column average, left out under 2 inches of snow.",
    unit: "kg/m³",
  },
  type: {
    text: "The density as a class, set by this app: powder under 150 kg/m³, settled 150 to 300, wet/dense over 300, no snow when the depth is 0.",
  },
  new24h: { text: "How much the depth rose over the last 24 hours (0 when it settled or melted); 1 to 2 inches may be sensor noise.", unit: "in" },
  tempC: { text: "Air temperature at the latest reading.", unit: "°C" },
  pctMedian: {
    text:
      "Today's snow water equivalent as a share of the station's 1991-2020 median for this day: 100% is a normal year, 50% half the usual water. " +
      "Left out when the median is under 1 inch (early and late season), where a percentage means nothing.",
    unit: "%",
    source: "USDA NRCS SNOTEL (AWDB daily medians)",
    url: SNOTEL_URL,
  },
  vsNormal: { text: "The percent of normal in bands: well below under 70%, below 70 to 89%, near 90 to 109%, above 110 to 129%, well above 130% and up." },
  normalNote: { text: "Why there is no percent of normal yet: the station's 1991-2020 median snow water for the day is under 1 inch, so a percent of it would mean nothing." },
  medianSwe: { text: "The station's 1991-2020 median snow water equivalent for this day of the year.", unit: "in" },
  normalOnset: { text: "The day snow normally starts to stay on the ground at this station (median of past years)." },
  medianPeakIn: { text: "The station's median yearly peak snow water equivalent: how much water a normal winter builds.", unit: "in" },
  readingLocal: { text: "When the latest hourly reading was taken, in the station's own time zone." },
};

const CARD: CardSpec = {
  measure: { key: "v", label: "Snow depth", unit: "in" },
  facts: [
    { key: "swe", label: "Snow water equivalent", unit: "in" },
    { key: "pctMedian", label: "Percent of normal", unit: "%", format: "int" },
    { key: "normalNote", label: "Percent of normal" },
    { key: "vsNormal", label: "Compared with normal", values: Object.fromEntries(VS_NORMAL.map((b) => [b.value, b.label])) },
    { key: "medianSwe", label: "Normal for today", unit: "in" },
    { key: "normalOnset", label: "Snow normally arrives" },
    { key: "medianPeakIn", label: "Normal peak", unit: "in" },
    { key: "new24h", label: "New in 24 h", unit: "in" },
    { key: "type", label: "Snow type" },
    { key: "tempC", label: "Air temperature", unit: "°C" },
    { key: "elevationFt", label: "Elevation", unit: "ft", format: "int" },
    { key: "readingLocal", label: "Reading" },
  ],
  // t is the same reading in UTC, shown as readingLocal.
  hidden: ["t"],
};

const snowpack = defineLayer({
  id: "snowpack",
  title: "Snowpack (SNOTEL, live)",
  description:
    "Live snowpack at NRCS SNOTEL automated mountain stations in the western United States and Alaska, updated hourly. User words: snowpack, snow depth, how much snow, powder, fresh snow, new snow, SWE, snow water equivalent, is it wet or dry snow. " +
    "Each point is a station with name, stationId, elevationFt (feet), t (UTC time of the latest hourly reading, usually under 2 hours old; readingLocal is the same in the station's own time, e.g. 'Oct 17, 5 PM PDT') and v (snow depth in inches). " +
    "pctMedian is today's snow water equivalent as a percent of the station's 1991-2020 median for the day and vsNormal its band ('well-below' under 70, 'below', 'near' 90 to 109, 'above', 'well-above' 130 and up), given only when the median is 1 inch or more (so not in early fall); normalOnset is when snow normally arrives and medianPeakIn a normal year's peak SWE. Use these for 'is it a good snow year'. The map colors stations by vsNormal, sizes them by depth and names the three deepest. " +
    "swe is snow water equivalent in inches (the water you would get by melting the snow, the standard measure of how much water the snowpack holds). " +
    "density is SWE / depth in kg/m³ and type classes it: 'powder' (under 150, light dry snow), 'settled' (150 to 300), 'wet/dense' (over 300, spring or rain-soaked snow), or 'no snow' when the depth is 0. " +
    "new24h is how many inches the depth rose over the last 24 hours (0 when it settled or melted); tempC is air temperature in °C. " +
    "Example questions: 'How much snow is on the ground at Mount Rose?', 'Did it snow overnight in the Wasatch?'. " +
    "Caveats: a station is one flat, sheltered clearing, so ridges and wind-loaded slopes can hold much more or less; hourly depth jitters by an inch or two, so a 1 to 2 inch new24h may be noise; " +
    "density is a whole-column average, so fresh powder on top of old snow still reads 'settled'; it is left out under 2 inches of depth or when the sensors disagree; " +
    "in summer and early fall most stations read 0, which is real (no snow). This is not an avalanche forecast. " +
    "Western United States (roughly California to Colorado and Montana to Arizona) and Alaska only; elsewhere it returns nothing. " +
    "Over 400,000 km² it returns up to 1,000 stations, deepest snow first.",
  coverage: "us",
  surface: "land",
  license: "Public domain (USDA NRCS)",
  requiredEnv: [],
  maxAreaKm2: 400_000,
  // The whole active network is about 890 stations (9 data calls of 100), so even the whole West stays bounded.
  hardMaxAreaKm2: WHOLE_US_KM2,
  wide: { orderBy: "snow depth in inches", limit: WIDE_LIMIT },
  input: inputSchema,
  style: { geometry: "point", color: layerColor("snowpack"), unit: "in", timeField: "t", encode: { size: "v", color: "vsNormal" } },
  // One latest reading per station: say when, never scrub (docs/layer-contract.md).
  time: { shape: "single" },
  labels: { field: "name", max: 3, rankBy: "v" },
  display: { units: "us", timeZone: "local" },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,

  async query(ctx): Promise<LayerResult | LayerError> {
    const now = new Date();
    const citation = {
      source: "USDA NRCS SNOTEL hourly data via the Air and Water Database (AWDB) REST API (public domain; provisional)",
      url: "https://www.nrcs.usda.gov/wps/portal/wcc/home/",
      retrieved: now.toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }
    if (bboxesDisjoint(ctx.bbox, WEST_US) && bboxesDisjoint(ctx.bbox, ALASKA)) {
      return {
        kind: "geojson",
        data: EMPTY,
        citation,
        coverageNote: "SNOTEL stations are only in the western United States and Alaska",
      };
    }

    const stationsUrl = `${AWDB}/stations?stationTriplets=*:*:SNTL&elements=WTEQ&durations=DAILY&activeOnly=true`;
    // The full active-station list is the same for every bbox, so share one cache entry.
    const stationsResult = await fetchRows(ctx, stationsUrl, "station search", "snowpack:stations:WTEQ", STATIONS_TTL_SECONDS, STATION_LIST_BODY);
    if (!stationsResult.ok) return { error: stationsResult.error, hint: "upstream" };

    const inside = parseRows(StationSchema, stationsResult.rows).filter((s) => inBbox(s, ctx.bbox));
    if (inside.length === 0) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: "No SNOTEL stations in this area" };
    }

    const begin = encodeURIComponent(stamp(now.getTime() - WINDOW_BACK_HOURS * HOUR_MS));
    const end = encodeURIComponent(stamp(now.getTime() + WINDOW_AHEAD_HOURS * HOUR_MS));
    const batches: SnotelStation[][] = [];
    for (let i = 0; i < inside.length; i += BATCH_SIZE) batches.push(inside.slice(i, i + BATCH_SIZE));

    // The daily medians ride alongside in a view under 400,000 km² (the wide West would double its nine data calls).
    const dayBegin = encodeURIComponent(stamp(now.getTime() - 2 * 24 * HOUR_MS).slice(0, 10));
    const dayEnd = encodeURIComponent(stamp(now.getTime()).slice(0, 10));
    const medianCalls = ctx.wide
      ? []
      : batches.map((batch, i) =>
          fetchRows(
            ctx,
            `${AWDB}/data?stationTriplets=${batch.map((s) => s.stationTriplet).join(",")}` +
              `&elements=WTEQ&duration=DAILY&beginDate=${dayBegin}&endDate=${dayEnd}&centralTendencyType=MEDIAN&returnFlags=false`,
            "median call",
            ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:snotel-median${batches.length > 1 ? `:${i}` : ""}`,
            MEDIAN_TTL_SECONDS,
          ),
        );
    const [results, medians] = await Promise.all([
      Promise.all(
        batches.map((batch, i) =>
          fetchRows(
            ctx,
            `${AWDB}/data?stationTriplets=${batch.map((s) => s.stationTriplet).join(",")}` +
              `&elements=SNWD,WTEQ,TOBS&duration=HOURLY&beginDate=${begin}&endDate=${end}&returnFlags=false`,
            "data call",
            ctx.cacheKey === undefined
              ? undefined
              : `${ctx.cacheKey}:snotel-hourly${batches.length > 1 ? `:${i}` : ""}`,
            DATA_TTL_SECONDS,
          ),
        ),
      ),
      Promise.all(medianCalls),
    ]);

    const rows: SnotelData[] = [];
    for (const result of results) {
      if (!result.ok) return { error: result.error, hint: "upstream" };
      rows.push(...parseRows(DataSchema, result.rows));
    }

    const joined = joinSnotel(inside, rows, ctx.bbox, now);
    // A failed median call leaves the comparison out; the readings still answer.
    const medianRows = medians.flatMap((m) => (m.ok ? parseRows(MedianSchema, m.rows) : []));
    if (medianRows.length > 0) addNormals(joined, parseMedians(medianRows));
    const { data, total } = ctx.wide ? keepDeepest(joined, ctx.wideStrategy?.limit ?? WIDE_LIMIT) : { data: joined, total: undefined };
    const compared = data.features.filter((f) => typeof f.properties?.pctMedian === "number").length;
    const notes: string[] = [];
    if (compared > 0) notes.push(`${compared} of ${data.features.length} stations compared with their 1991-2020 median snow water for the day`);
    else if (!ctx.wide && medianRows.length > 0) {
      // In season order (a September onset comes before a November one), so the middle one is the typical date.
      const season = (o: string) => ((MONTH_NAMES.indexOf(o.slice(0, 3)) + 4) % 12) * 31 + Number(o.slice(4));
      const onsets = data.features
        .map((f) => f.properties?.normalOnset)
        .filter((o): o is string => typeof o === "string")
        .sort((a, b) => season(a) - season(b));
      notes.push(`Too early in the season to compare with normal (median snow water under 1 inch)${onsets.length > 0 ? `; snow normally arrives around ${onsets[Math.floor(onsets.length / 2)]}` : ""}`);
    }
    return { kind: "geojson", data, citation, ...(total !== undefined && { total }), ...(notes.length > 0 && { coverageNote: notes.join("; ") }) };
  },
});

registerLayer(snowpack);

export default snowpack;
