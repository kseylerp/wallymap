/**
 * Tides from NOAA CO-OPS (Tides and Currents): every tide station in view, the next highs and lows in local time at
 * the stations nearest the centre, the water level measured right now where the station has a live gauge, the tide
 * height hour by hour for the next 48 hours (the time scrubber plays it), and the central station's own hourly curve
 * for the linked chart under the scrubber.
 *
 * Verified live 2026-10-10 and 2026-10-18:
 *   - Stations: https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions
 *     ({ count: 3502, stations: [{ id, name, lat, lng, state, type: "R" | "S", reference_id, timezonecorr }] }, 2 MB)
 *     and ?type=waterlevels (302 stations with a live gauge). Neither takes a bbox, so both are cached for a day under
 *     shared keys and filtered here. Type "R" (harmonic) does NOT mean a live sensor: the waterlevels list decides who
 *     gets an observation. `timezonecorr` is the station's standard offset from UTC in hours (-8 on the Pacific coast).
 *   - Highs and lows: https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&interval=hilo
 *     &station=ID&begin_date=yyyyMMdd&range=H&datum=MLLW&units=english&time_zone=lst_ldt&format=json
 *     -> { predictions: [{ t: "2026-10-18 00:53", v: "0.653", type: "H" | "L" }] }: feet above MLLW, times in the
 *     station's local standard or daylight time (lst_ldt), so "12:53 am" is what NOAA's own page prints. Works for
 *     subordinate ("S") stations too. Asked from local midnight yesterday for 108 hours, one key per station and local
 *     day, cached 6 hours: predictions are fixed in advance, so any view that day reuses them.
 *   - Hourly heights: same endpoint with interval=h, harmonic ("R") stations only: a subordinate station answers
 *     "No Predictions data was found" (9414305, 2026-10-18), because NOAA publishes only its highs and lows.
 *   - Observed: product=water_level&date=latest -> { metadata, data: [{ t, v, s, f, q }] }, local time too.
 *   - Failures are HTTP 200 with { error: { message } } (bad station, no data, "no MLLW").
 * NOAA calls go through a shared 5-per-second bucket (lib/fetch HOST_RATES), so tide times are fetched for at most
 * TIMED_STATIONS stations per view, nearest the centre first (about 5 s cold for San Francisco Bay, instant once
 * cached); every other station in view is drawn without times.
 *
 * Hour-by-hour heights between highs and lows use NOAA's own cosine rule (Tide Tables, Table 3, "height of tide at any
 * time"): h = (h1 + h2) / 2 + (h1 - h2) / 2 * cos(pi * (t - t1) / (t2 - t1)). The linked curve uses NOAA's own hourly
 * predictions at the harmonic station nearest the centre, else the interpolated curve of the nearest timed station.
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
  type LinkedSeries,
  type QueryContext,
  type SeriesAxis,
} from "./types";
import { nameAttribute } from "./_shared/bands";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { OUTSIDE_US_NOTE, WHOLE_US_KM2, outsideUs } from "./_shared/coverage";
import { haversineKm } from "./_shared/geo";
import { jsonObjectBody } from "@/lib/fetch/validate";
import { layerColor } from "@/lib/render/palette";

const MDAPI = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json";
const DATAGETTER = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
const APPLICATION = "WildMap";

/**
 * Stations per view that get tide times: one call each (plus one for a live gauge's level) through NOAA's shared
 * 5-per-second bucket, so 24 costs about 5 s cold and nothing once cached.
 */
export const TIMED_STATIONS = 24;
/** Most stations a wide (over 50,000 km²) result lists; only TIMED_STATIONS of them carry tide times. */
export const WIDE_LIMIT = 1000;
/** Hourly frames the scrubber plays, from the current hour. */
export const FRAMES = 48;
const STATIONS_TTL_SECONDS = 86_400;
/** Predictions are fixed in advance and asked per local day, so they keep for hours. */
const PREDICTIONS_TTL_SECONDS = 6 * 3600;
/** Live gauges report every 6 minutes. */
const OBSERVED_TTL_SECONDS = 360;
/** From local midnight yesterday: the last tide before now through the first one after the 48th frame. */
const HILO_RANGE_HOURS = 108;
const HOURLY_RANGE_HOURS = 72;
const EVENTS_LISTED = 4;
const HOUR_MS = 3_600_000;

const inputSchema = z.object({});

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const StationSchema = z.object({
  id: z.string(),
  name: z.string(),
  lat: z.number(),
  lng: z.number(),
  state: z.string().nullish(),
  type: z.string().nullish(),
  timezonecorr: z.number().nullish(),
});
export type TideStation = z.infer<typeof StationSchema>;

const PredictionsSchema = z.object({
  predictions: z.array(z.object({ t: z.string(), v: z.string(), type: z.string().optional() })),
});
const ObservedSchema = z.object({
  data: z.array(z.object({ t: z.string(), v: z.string() })).min(1),
});

export function parseStations(body: unknown): TideStation[] {
  if (typeof body !== "object" || body === null || !("stations" in body) || !Array.isArray(body.stations)) return [];
  const out: TideStation[] = [];
  for (const raw of body.stations) {
    const parsed = StationSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function inBbox(s: TideStation, [w, so, e, n]: BBox): boolean {
  return s.lng >= w && s.lng <= e && s.lat >= so && s.lat <= n;
}

/** Stations in the bbox, nearest the view's centre first. */
export function orderedStations(stations: TideStation[], bbox: BBox): TideStation[] {
  const centre: [number, number] = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  return stations
    .filter((s) => inBbox(s, bbox))
    .map((s) => ({ s, d: haversineKm(centre, [s.lng, s.lat]) }))
    .sort((a, b) => a.d - b.d)
    .map((x) => x.s);
}

/** Live gauges among the timed stations at least: they measure the water now and are the main reference stations. */
export const LIVE_FIRST = 8;

/**
 * The stations that get tide times, nearest the centre first: the LIVE_FIRST nearest live gauges, then the nearest
 * others up to TIMED_STATIONS. `ordered` is nearest first (orderedStations), and so is the answer.
 */
export function pickTimed(ordered: TideStation[], live: Set<string>): TideStation[] {
  const ids = new Set(ordered.filter((s) => live.has(s.id)).slice(0, LIVE_FIRST).map((s) => s.id));
  for (const s of ordered) {
    if (ids.size >= TIMED_STATIONS) break;
    ids.add(s.id);
  }
  return ordered.filter((s) => ids.has(s.id));
}

/* ---------- Local time ---------- */

/**
 * The IANA zone a station keeps, from its standard offset (`timezonecorr`, else its longitude) and state: the zone whose
 * daylight rule matches what NOAA's lst_ldt applies there.
 */
export function zoneOf(s: Pick<TideStation, "timezonecorr" | "state" | "lng">): string {
  const corr = s.timezonecorr ?? Math.round(s.lng / 15);
  switch (corr) {
    case -4:
      return "America/Puerto_Rico";
    case -5:
      return "America/New_York";
    case -6:
      return "America/Chicago";
    case -7:
      return "America/Denver";
    case -8:
      return "America/Los_Angeles";
    case -9:
      return "America/Anchorage";
    case -10:
      return s.state === "AK" ? "America/Adak" : "Pacific/Honolulu";
    case -11:
      return "Pacific/Pago_Pago";
    case 10:
      return "Pacific/Guam";
    default:
      return corr === 0 ? "Etc/GMT" : `Etc/GMT${corr < 0 ? "+" : "-"}${Math.abs(corr)}`;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsIn(zone: string, ms: number): Record<string, string> {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });
    formatters.set(zone, f);
  }
  return Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
}

/** The zone's offset from UTC at an instant, in ms. */
function offsetMs(zone: string, ms: number): number {
  const p = partsIn(zone, ms);
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute)) - Math.floor(ms / 60_000) * 60_000;
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/;

/** "2026-10-18 00:53" on the clocks of `zone` as a UTC instant (ms); NaN when it is not such a time. */
export function wallToUtc(wall: string, zone: string): number {
  const m = WALL.exec(wall.trim());
  if (!m) return Number.NaN;
  const asUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const guess = asUtc - offsetMs(zone, asUtc);
  return asUtc - offsetMs(zone, guess);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "12:53 am PDT Sun": NOAA's own local clock reading, with the zone's abbreviation at that instant and the weekday. */
export function localLabel(wall: string, zone: string, ms: number): string {
  const m = WALL.exec(wall.trim());
  if (!m) return wall;
  const hour = Number(m[4]);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const day = DAYS[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()];
  return `${h12}:${m[5]} ${hour < 12 ? "am" : "pm"} ${partsIn(zone, ms).timeZoneName} ${day}`;
}

/** yyyyMMdd of an instant on the clocks of `zone`, `daysBack` days earlier. */
function localDate(ms: number, zone: string, daysBack = 0): string {
  const p = partsIn(zone, ms);
  const d = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) - daysBack * 86_400_000);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/* ---------- Tides ---------- */

export type TideEvent = { time: number; height: number; type: "high" | "low"; local: string };

/** Every high and low in a predictions body (local times on the station's clock), oldest first. */
export function tideEvents(body: unknown, zone: string): TideEvent[] {
  const parsed = PredictionsSchema.safeParse(body);
  if (!parsed.success) return [];
  return parsed.data.predictions
    .filter((p) => p.type === "H" || p.type === "L")
    .map((p) => {
      const time = wallToUtc(p.t, zone);
      return { time, height: Number(p.v), type: p.type === "H" ? ("high" as const) : ("low" as const), local: localLabel(p.t, zone, time) };
    })
    .filter((e) => Number.isFinite(e.time) && Number.isFinite(e.height))
    .sort((a, b) => a.time - b.time);
}

/** Highs and lows from now on, soonest first. */
export function upcomingEvents(events: TideEvent[], now: Date): TideEvent[] {
  return events.filter((e) => e.time >= now.getTime());
}

/** The tide height at `ms` between the highs and lows around it (NOAA's cosine rule), or null outside them. */
export function heightAt(events: TideEvent[], ms: number): number | null {
  for (let i = 0; i + 1 < events.length; i++) {
    const a = events[i];
    const b = events[i + 1];
    if (ms < a.time || ms > b.time) continue;
    const phase = b.time === a.time ? 0 : (ms - a.time) / (b.time - a.time);
    const h = (a.height + b.height) / 2 + ((a.height - b.height) / 2) * Math.cos(Math.PI * phase);
    return Math.round(h * 100) / 100;
  }
  return null;
}

/** The scrubber's frames: FRAMES hours from the start of the current hour, as ISO times. */
export function frameTimes(now: Date): string[] {
  const start = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  return Array.from({ length: FRAMES }, (_, k) => new Date(start + k * HOUR_MS).toISOString());
}

/** NOAA's hourly predictions (local times) on the frames; null where a frame has none. */
export function hourlyOnFrames(body: unknown, zone: string, times: string[]): (number | null)[] {
  const parsed = PredictionsSchema.safeParse(body);
  if (!parsed.success) return times.map(() => null);
  const byMs = new Map<number, number>();
  for (const p of parsed.data.predictions) {
    const ms = wallToUtc(p.t, zone);
    const v = Number(p.v);
    if (Number.isFinite(ms) && Number.isFinite(v)) byMs.set(ms, Math.round(v * 100) / 100);
  }
  return times.map((t) => byMs.get(Date.parse(t)) ?? null);
}

/** A gauge reading older than this is a sensor that has gone quiet. */
const OBSERVED_MAX_AGE_MS = 3 * HOUR_MS;

/** The latest observed water level (local time on the station's clock), or undefined for an error body, no data or a reading over 3 hours old. */
export function observedLevel(body: unknown, zone: string, now: Date): { time: number; height: number; local: string } | undefined {
  const parsed = ObservedSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const last = parsed.data.data[parsed.data.data.length - 1];
  const height = Number(last.v);
  const time = wallToUtc(last.t, zone);
  if (last.v.trim() === "" || !Number.isFinite(height) || !Number.isFinite(time)) return undefined;
  if (now.getTime() - time > OBSERVED_MAX_AGE_MS) return undefined;
  return { time, height, local: localLabel(last.t, zone, time) };
}

const TIDE_WORD = { high: "High", low: "Low" } as const;

/** "Low 0.6 ft at 12:24 am PDT Sat". */
export function eventText(e: TideEvent): string {
  return `${TIDE_WORD[e.type]} ${e.height.toFixed(1)} ft at ${e.local}`;
}

const stationUrl = (id: string) => `https://tidesandcurrents.noaa.gov/stationhome.html?id=${id}`;

/** A station without tide times: where it is, what kind of gauge, and why there are no times. */
export function stationFeature(station: TideStation, live: boolean, why = "Not loaded for this view; zoom in nearer this station for its times"): Feature<Point> {
  const p: Record<string, string | number> = {
    name: station.name,
    stationId: station.id,
    kind: live ? "live" : "prediction",
    noTimes: why,
    url: stationUrl(station.id),
  };
  if (station.state) p.state = station.state;
  return { type: "Feature", geometry: { type: "Point", coordinates: [station.lng, station.lat] }, properties: p };
}

/**
 * One station's point with times: the height now and per frame (`series.level`), the next four highs and lows as card
 * rows, and the live level. Null when it has no upcoming high or low.
 */
export function tideFeature(
  station: TideStation,
  live: boolean,
  events: TideEvent[],
  observed: { time: number; height: number; local: string } | undefined,
  now: Date,
  times: string[],
): Feature<Point> | null {
  const upcoming = upcomingEvents(events, now);
  const next = upcoming[0];
  if (next === undefined) return null;
  const p: Record<string, unknown> = {
    name: station.name,
    stationId: station.id,
    kind: live ? "live" : "prediction",
    nextType: next.type,
    nextAt: new Date(next.time).toISOString(),
    v: next.height,
    trend: next.type === "high" ? "Rising toward high tide" : "Falling toward low tide",
    url: stationUrl(station.id),
    series: { level: times.map((t) => heightAt(events, Date.parse(t))) },
  };
  const level = heightAt(events, now.getTime());
  if (level !== null) p.level = level;
  upcoming.slice(0, EVENTS_LISTED).forEach((e, i) => (p[`tide${i + 1}`] = eventText(e)));
  const then = upcoming[1];
  if (then !== undefined) {
    p.thenType = then.type;
    p.thenAt = new Date(then.time).toISOString();
    p.thenV = then.height;
  }
  if (observed !== undefined) {
    p.observedNow = observed.height;
    p.observedAt = new Date(observed.time).toISOString();
    p.observedLocal = observed.local;
  }
  if (station.state) p.state = station.state;
  return { type: "Feature", geometry: { type: "Point", coordinates: [station.lng, station.lat] }, properties: p as Feature["properties"] };
}

/**
 * A wide result: the timed stations, then every other station in view without times (nearest the centre first), cut at
 * `limit`, with the count before the cut.
 */
export function wideStations(
  timed: Feature<Point>[],
  others: TideStation[],
  live: Set<string>,
  limit: number,
): { features: Feature<Point>[]; total?: number } {
  const all = [...timed, ...others.map((s) => stationFeature(s, live.has(s.id), "Not loaded over a view this wide; zoom in for its times"))];
  return all.length > limit ? { features: all.slice(0, limit), total: all.length } : { features: all };
}

const JSON_OBJECT_BODY = jsonObjectBody();
/** Station lists are shared by every view for a day, so only a body with a non-empty stations array is stored. */
export const STATION_LIST_BODY = jsonObjectBody({ listKey: "stations" });

type Got = { ok: true; body: unknown } | { ok: false; error: string };

async function getJson(
  ctx: QueryContext,
  url: string,
  label: string,
  cacheKey: string,
  ttlSeconds: number,
  cacheErrors = false,
  validate: (body: string) => boolean = JSON_OBJECT_BODY,
): Promise<Got> {
  try {
    const res = await ctx.fetch(url, {
      cacheKey,
      ttlSeconds,
      validate,
      // A "no data" answer for a station stays true for the TTL, so caching it saves a call per view.
      ...(cacheErrors ? { shouldCache: () => true } : {}),
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    if (!res.ok) return { ok: false, error: `${label} returned ${res.status}` };
    return { ok: true, body: await res.json() };
  } catch (err) {
    const timedOut = typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
    return {
      ok: false,
      error: timedOut ? `${label} timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds` : `${label} returned no usable response`,
    };
  }
}

const common = (id: string) => `&station=${id}&datum=MLLW&units=english&time_zone=lst_ldt&format=json&application=${APPLICATION}`;

/** The station's highs and lows from local midnight yesterday, one cache entry per station and local day. */
function hiloRequest(ctx: QueryContext, station: TideStation, now: Date): Promise<Got> {
  const begin = localDate(now.getTime(), zoneOf(station), 1);
  return getJson(
    ctx,
    `${DATAGETTER}?product=predictions&interval=hilo&begin_date=${begin}&range=${HILO_RANGE_HOURS}${common(station.id)}`,
    "NOAA tide predictions",
    `tides:hilo:v2:${station.id}:${begin}`,
    PREDICTIONS_TTL_SECONDS,
  );
}

/** NOAA's hourly predictions from local midnight today (harmonic stations only). */
function hourlyRequest(ctx: QueryContext, station: TideStation, now: Date): Promise<Got> {
  const begin = localDate(now.getTime(), zoneOf(station));
  return getJson(
    ctx,
    `${DATAGETTER}?product=predictions&interval=h&begin_date=${begin}&range=${HOURLY_RANGE_HOURS}${common(station.id)}`,
    "NOAA hourly tide predictions",
    `tides:hourly:v1:${station.id}:${begin}`,
    PREDICTIONS_TTL_SECONDS,
    true,
  );
}

const COOPS_URL = "https://tidesandcurrents.noaa.gov/";

/** What each height on a station card means (spec §12b): all are feet above the chart datum, MLLW. */
const HELP: Record<string, FieldHelp> = {
  level: {
    text:
      "Predicted tide height now, in feet above mean lower low water (MLLW), the chart datum, read between NOAA's predicted highs and lows " +
      "with NOAA's cosine rule. The map plays it hour by hour.",
    unit: "ft above MLLW",
    source: "NOAA CO-OPS tide predictions",
    url: COOPS_URL,
  },
  v: {
    text: "Predicted height of the next high or low tide, in feet above MLLW; a negative height is an unusually low tide.",
    unit: "ft above MLLW",
    source: "NOAA CO-OPS tide predictions",
    url: COOPS_URL,
  },
  tide1: { text: "The next predicted high or low tide: height in feet above MLLW and the time on the station's local clock." },
  observedNow: {
    text:
      "Water level measured by the station's live gauge within the last few minutes. When it differs from the prediction by a foot or more, " +
      "wind or a storm surge is pushing the water.",
    unit: "ft above MLLW",
    source: "NOAA CO-OPS water levels",
    url: COOPS_URL,
  },
  kind: { text: "A live gauge measures the water every 6 minutes as well as predicting it; the other stations have predictions only." },
};

/** The station card: the height now, then the next four highs and lows as their own rows, then the live level. */
const CARD: CardSpec = {
  measure: { key: "level", label: "Tide height now", unit: "ft" },
  facts: [
    { key: "tide1", label: "Next tide" },
    { key: "tide2", label: "Then" },
    { key: "tide3", label: "After that" },
    { key: "tide4", label: "Later" },
    { key: "trend", label: "Tide is" },
    { key: "observedNow", label: "Measured now", unit: "ft", format: "1dp" },
    { key: "observedLocal", label: "Measured at" },
    { key: "noTimes", label: "Tide times" },
    { key: "kind", label: "Station", values: { live: "Live water-level gauge and predictions", prediction: "Predictions only" } },
    { key: "state", label: "State" },
  ],
  links: [{ key: "url", label: "NOAA station page" }],
  // Codes, and the numbers the rows above already print.
  hidden: ["stationId", "nextType", "nextAt", "v", "thenType", "thenAt", "thenV", "observedAt", "series"],
};

const ATTRIBUTES: Attribute[] = [
  {
    key: "kind",
    type: "category",
    label: "Station",
    primary: true,
    levels: [
      { value: "live", label: "Live gauge", help: "Measures the water level every 6 minutes, and has predictions." },
      { value: "prediction", label: "Predictions only" },
    ],
  },
  {
    key: "nextType",
    type: "category",
    label: "Next tide",
    levels: [
      { value: "high", label: "High next (rising)" },
      { value: "low", label: "Low next (falling)" },
    ],
  },
  { key: "level", type: "measure", label: "Tide height", unit: "ft", encode: "size" },
  nameAttribute(),
];

const LEGEND: LegendSpec = {
  kind: "size",
  title: "Tide height",
  field: "level",
  unit: "ft above MLLW",
  stops: [
    { label: "0 ft (low)", value: 0 },
    { label: "3 ft", value: 3 },
    { label: "6 ft (high)", value: 6 },
  ],
  note: "Stations without times for this view are drawn at the smallest size.",
};

const tides = defineLayer({
  id: "tides",
  title: "Tides (NOAA, next high and low)",
  description:
    "Tide times and heights at NOAA tide stations on US coasts, for beach walking, tide pooling, fishing, surfing, kayaking and launching boats. User words: tide, high tide, low tide, tide pools, tide chart, when is low tide. " +
    "Every station in view is a point with name, stationId and kind ('live' for a live water-level gauge, 'prediction' for predictions only). 24 of them (live gauges first, then nearest the centre) also have tide1 to tide4 (the next four highs and lows as text in the station's local time, 'Low 0.6 ft at 12:24 am PDT Sun'), " +
    "nextType ('high' or 'low', which comes next), nextAt (its UTC time) and v (its predicted height in feet above mean lower low water, MLLW, the chart datum; negative means an unusually low tide), thenType, thenAt and thenV (the one after), level (the predicted height now) and series.level (the height each hour for 48 hours, which the map plays). " +
    "Live gauges also have observedNow (water level measured within the last few minutes, feet above MLLW) and observedLocal; when observedNow differs from level by a foot or more, wind or a storm surge is pushing the water. " +
    "The answer's linked curve is the hourly tide at the harmonic station nearest the centre. Quote times as tide1 to tide4 give them (local time), not UTC. " +
    "Example questions: 'When is low tide at Half Moon Bay tomorrow?', 'Is the tide coming in at the Golden Gate right now?'. " +
    "Caveats: the other stations have noTimes instead, so zoom in for a specific beach; over 50,000 km² the rest (up to 1,000) are listed without times; " +
    "subordinate stations are offsets from a nearby reference station and less exact, and their hourly heights are read between highs and lows; a station's tide can differ a lot from a bay or river mouth a few miles away. " +
    "US coasts and territories only.",
  coverage: "us",
  surface: "coast",
  license: "Public domain (NOAA CO-OPS)",
  requiredEnv: [],
  maxAreaKm2: 50_000,
  // The station list is national and tide times stay capped at 24 stations, so any US box answers.
  hardMaxAreaKm2: WHOLE_US_KM2,
  wide: { orderBy: "distance from the centre", limit: WIDE_LIMIT, rank: "nearest" },
  input: inputSchema,
  style: { geometry: "point", color: layerColor("tides"), unit: "ft", series: "hour", encode: { size: "level" } },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  // Hourly frames over the next 48 hours (result.series), with the central station's curve linked under the scrubber.
  time: { shape: "continuous", step: "hour" },
  legend: LEGEND,
  // Features come nearest the centre first, so the first six named are the ones the view is about.
  labels: { field: "name", max: 6 },
  display: { units: "us", timeZone: "local" },

  async query(ctx): Promise<LayerResult | LayerError> {
    const now = new Date();
    const citation = {
      source: "NOAA CO-OPS Tides and Currents, predictions and observed water levels (public domain)",
      url: COOPS_URL,
      retrieved: now.toISOString(),
    };
    if (outsideUs(ctx.bbox)) return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };

    const [predStations, liveStations] = await Promise.all([
      getJson(ctx, `${MDAPI}?type=tidepredictions`, "NOAA tide station list", "tides:stations:predictions", STATIONS_TTL_SECONDS, false, STATION_LIST_BODY),
      getJson(ctx, `${MDAPI}?type=waterlevels`, "NOAA water level station list", "tides:stations:waterlevels", STATIONS_TTL_SECONDS, false, STATION_LIST_BODY),
    ]);
    if (!predStations.ok) return { error: predStations.error, hint: "upstream" };
    // Without the live list every station is treated as predictions-only.
    const live = new Set(liveStations.ok ? parseStations(liveStations.body).map((s) => s.id) : []);
    const ordered = orderedStations(parseStations(predStations.body), ctx.bbox);
    if (ordered.length === 0) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: "No NOAA tide stations in this view" };
    }
    const chosen = pickTimed(ordered, live);
    const curveStation = ordered.find((s) => s.type === "R");
    const times = frameTimes(now);

    const [results, hourly] = await Promise.all([
      Promise.all(
        chosen.map(async (station) => {
          const zone = zoneOf(station);
          const [pred, obs] = await Promise.all([
            hiloRequest(ctx, station, now),
            live.has(station.id)
              ? getJson(ctx, `${DATAGETTER}?product=water_level&date=latest${common(station.id)}`, "NOAA water level", `tides:wl:v2:${station.id}`, OBSERVED_TTL_SECONDS, true)
              : Promise.resolve<Got>({ ok: false, error: "no live gauge" }),
          ]);
          return { station, zone, pred, obs };
        }),
      ),
      curveStation ? hourlyRequest(ctx, curveStation, now) : Promise.resolve<Got>({ ok: false, error: "no harmonic station in view" }),
    ]);

    const timed: Feature<Point>[] = [];
    const timedIds = new Set<string>();
    let failed = 0;
    for (const { station, zone, pred, obs } of results) {
      if (!pred.ok) {
        failed += 1;
        continue;
      }
      const f = tideFeature(station, live.has(station.id), tideEvents(pred.body, zone), obs.ok ? observedLevel(obs.body, zone, now) : undefined, now, times);
      if (f !== null) {
        timed.push(f);
        timedIds.add(station.id);
      }
    }
    if (timed.length === 0 && failed > 0) {
      return { error: "NOAA tide predictions failed for every station asked", hint: "upstream" };
    }

    // The linked curve: NOAA's own hourly heights at the central harmonic station, else the nearest timed station's.
    let linked: LinkedSeries | undefined;
    if (curveStation && hourly.ok) {
      const values = hourlyOnFrames(hourly.body, zoneOf(curveStation), times);
      if (values.some((v) => v !== null)) linked = { label: "Tide height", unit: "ft", place: curveStation.name, times, values, source: citation };
    }
    if (!linked && timed.length > 0) {
      const values = (timed[0].properties?.series as { level: (number | null)[] }).level;
      if (values.some((v) => v !== null)) linked = { label: "Tide height", unit: "ft", place: String(timed[0].properties?.name), times, values, source: citation };
    }

    const others = ordered.filter((s) => !timedIds.has(s.id));
    const notes: string[] = [];
    let features: Feature<Point>[];
    let total: number | undefined;
    if (ctx.wide) {
      const wide = wideStations(timed, others, live, ctx.wideStrategy?.limit ?? WIDE_LIMIT);
      features = wide.features;
      total = wide.total;
    } else {
      features = [...timed, ...others.map((s) => stationFeature(s, live.has(s.id)))];
    }
    if (others.length > 0) {
      notes.push(`Tide times at the ${timed.length} stations nearest the centre (live gauges first); the other ${others.length} are drawn without times`);
    }
    if (failed > 0) notes.push(`${failed} station${failed === 1 ? "" : "s"} did not answer`);
    if (linked) notes.push(`the chart under the scrubber is the hourly tide at ${linked.place}`);

    const series: SeriesAxis = { times, step: "hour", now: 0 };
    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      series,
      ...(linked && { linked }),
      ...(total !== undefined && { total }),
      ...(notes.length > 0 ? { coverageNote: notes.join("; ").replace(/^./, (c) => c.toUpperCase()) } : {}),
    };
  },
});

registerLayer(tides);

export default tides;
