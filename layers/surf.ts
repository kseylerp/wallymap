/**
 * Surf: live wave buoys from NOAA NDBC, plus an optional Open-Meteo Marine forecast.
 *
 * Buoys (verified live 2026-10-10 ~02:00 UTC):
 *   - https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt: one whitespace-separated row per station with
 *     its newest observation (844 rows, 100 KB; 211 with a wave height). Two `#` header lines; columns
 *     STN LAT LON YYYY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES PTDY ATMP WTMP DEWP VIS TIDE, time in
 *     UTC, "MM" for missing. Units: WVHT m (significant wave height), DPD s (dominant period), APD s (average
 *     period), MWD degrees true the dominant waves come FROM, WSPD/GST m/s, WDIR degrees, WTMP °C. The file
 *     is global and does not depend on the bbox, so it is cached once for 10 minutes under a shared key and
 *     filtered to the bbox here. Stations without a wave height (land and met-only stations) are left out.
 *   - https://www.ndbc.noaa.gov/activestations.xml (273 KB, 1,354 stations) for names: `<station id="46026"
 *     ... name="SAN FRANCISCO - 18NM West of San Francisco, CA" .../>`. Cached a day, shared key.
 * Forecast (input forecast: true): https://marine-api.open-meteo.com/v1/marine with comma-separated
 * latitude/longitude lists (one JSON object per point in an array) and hourly=wave_height,wave_period,
 * wave_direction,swell_wave_height,swell_wave_period, forecast_days=2, timezone=GMT. Land cells return null
 * for every hour (Lake Tahoe returned nulls; a Bay point 0.56 m), so a 4 x 4 grid over the bbox is sampled and
 * only cells with waves are kept. Open-Meteo is free for non-commercial use only (CC BY 4.0 data).
 *
 * Live smoke 2026-10-10 02:15 UTC, San Francisco box [-123.2,37.3,-122.3,38.0], 0.4 s: 2 buoys; 46012 Half
 * Moon Bay 2.2 m (7.2 ft) at 11 s, water 16.3 °C; 46237 San Francisco Bar 1.8 m at 11 s from the W (261°).
 * 46026 was in view but its newest row had no wave height (MM), so it was left out. forecast: true added 16
 * cells (1 s): 2.0-2.9 m now, up to 4.3 m by 2026-10-11 09:00 UTC.
 * Season smoke (season: true), Oahu box [-158.4,21.2,-157.6,21.75], 14 s cold (18 files of ~1.5 MB through the
 * rate limiter): 6 buoys, October means 2023-2025: Mokapu Point 1.62 m, Waimea Bay 1.58 m (January 2.40 m, p90
 * 3.57 m: the north shore's winter season), Kaneohe 1.47 m, Barbers Point 1.07 m, Pearl Harbor 0.82 m.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { haversineKm } from "./_shared/geo";
import { createCache, type Cache } from "@/lib/fetch";
import { textBody } from "@/lib/fetch/validate";
import { layerColor } from "@/lib/render/palette";

const LATEST_OBS = "https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt";
const STATIONS_XML = "https://www.ndbc.noaa.gov/activestations.xml";
const MARINE_API = "https://marine-api.open-meteo.com/v1/marine";

/** Buoys report hourly (some every 30 minutes); ten minutes of cache keeps the map current. */
const OBS_TTL_SECONDS = 600;
const STATIONS_TTL_SECONDS = 86_400;
const FORECAST_TTL_SECONDS = 1_800;
/** Observations older than this are a buoy that has gone quiet. */
const MAX_OBS_AGE_HOURS = 12;
const HOUR_MS = 3_600_000;
const GRID = 4;
const M_TO_FT = 3.28084;

const inputSchema = z.object({
  forecast: z.boolean().default(false),
  season: z.boolean().default(false),
  month: z.number().int().min(1).max(12).optional(),
});

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

export type BuoyObs = {
  id: string;
  lat: number;
  lon: number;
  time: number;
  wvht?: number;
  dpd?: number;
  apd?: number;
  mwd?: number;
  wdir?: number;
  wspd?: number;
  gst?: number;
  wtmp?: number;
};

const COLUMNS = ["STN", "LAT", "LON", "YYYY", "MM", "DD", "hh", "mm", "WDIR", "WSPD", "GST", "WVHT", "DPD", "APD", "MWD", "PRES", "PTDY", "ATMP", "WTMP", "DEWP", "VIS", "TIDE"];

function num(token: string | undefined): number | undefined {
  if (token === undefined || token === "MM") return undefined;
  const n = Number(token);
  return Number.isFinite(n) ? n : undefined;
}

/** Rows of latest_obs.txt. Column positions come from the header line so a reordered file still parses. */
export function parseLatestObs(text: string): BuoyObs[] {
  const lines = text.split(/\r?\n/);
  const headerLine = lines.find((l) => l.startsWith("#STN"));
  const header = headerLine ? headerLine.slice(1).trim().split(/\s+/) : COLUMNS;
  const at = (name: string) => header.indexOf(name);
  const out: BuoyObs[] = [];
  for (const line of lines) {
    if (line.startsWith("#") || line.trim() === "") continue;
    const t = line.trim().split(/\s+/);
    const get = (name: string) => (at(name) >= 0 ? t[at(name)] : undefined);
    const lat = num(get("LAT"));
    const lon = num(get("LON"));
    const [y, mo, d, h, mi] = ["YYYY", "MM", "DD", "hh", "mm"].map((c) => num(get(c)));
    const id = get("STN");
    if (id === undefined || lat === undefined || lon === undefined) continue;
    if ([y, mo, d, h, mi].some((v) => v === undefined)) continue;
    const time = Date.UTC(y!, mo! - 1, d!, h!, mi!);
    out.push({
      id,
      lat,
      lon,
      time,
      wvht: num(get("WVHT")),
      dpd: num(get("DPD")),
      apd: num(get("APD")),
      mwd: num(get("MWD")),
      wdir: num(get("WDIR")),
      wspd: num(get("WSPD")),
      gst: num(get("GST")),
      wtmp: num(get("WTMP")),
    });
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Station id to name from activestations.xml. */
export function parseStationNames(xml: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of xml.matchAll(/<station\b[^>]*>/g)) {
    const tag = m[0];
    const id = /\bid="([^"]*)"/.exec(tag)?.[1];
    const name = /\bname="([^"]*)"/.exec(tag)?.[1];
    if (id && name) names.set(id, decodeEntities(name).replace(/\s+/g, " ").trim());
  }
  return names;
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

/** "WNW" for 292°. */
export function compass(deg: number): string {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

function inBbox(lon: number, lat: number, [w, s, e, n]: BBox): boolean {
  return lon >= w && lon <= e && lat >= s && lat <= n;
}

/** Buoy points inside the bbox that report a wave height within the last 12 hours. */
export function buoyFeatures(obs: BuoyObs[], names: Map<string, string>, bbox: BBox, now: Date): FeatureCollection<Point> {
  const cutoff = now.getTime() - MAX_OBS_AGE_HOURS * HOUR_MS;
  const features: Feature<Point>[] = [];
  for (const o of obs) {
    if (o.wvht === undefined || o.time < cutoff || !inBbox(o.lon, o.lat, bbox)) continue;
    const p: Record<string, string | number> = {
      name: names.get(o.id) ?? `NDBC ${o.id}`,
      stationId: o.id,
      kind: "buoy",
      t: new Date(o.time).toISOString(),
      v: o.wvht,
      waveFt: Math.round(o.wvht * M_TO_FT * 10) / 10,
      url: `https://www.ndbc.noaa.gov/station_page.php?station=${encodeURIComponent(o.id.toLowerCase())}`,
    };
    if (o.dpd !== undefined) p.periodS = o.dpd;
    if (o.apd !== undefined) p.avgPeriodS = o.apd;
    if (o.mwd !== undefined) {
      p.directionDeg = o.mwd;
      p.directionFrom = compass(o.mwd);
    }
    if (o.wtmp !== undefined) p.waterTempC = o.wtmp;
    if (o.wspd !== undefined) p.windMs = o.wspd;
    if (o.gst !== undefined) p.gustMs = o.gst;
    if (o.wdir !== undefined) p.windFrom = compass(o.wdir);
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: [o.lon, o.lat] }, properties: p });
  }
  return { type: "FeatureCollection", features };
}

/** Cell centres of a GRID x GRID sampling of the bbox, as [lon, lat]. */
export function forecastGrid([w, s, e, n]: BBox): [number, number][] {
  const out: [number, number][] = [];
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      out.push([
        Number((w + ((i + 0.5) * (e - w)) / GRID).toFixed(4)),
        Number((s + ((j + 0.5) * (n - s)) / GRID).toFixed(4)),
      ]);
    }
  }
  return out;
}

const MarineSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  hourly: z.object({
    time: z.array(z.string()),
    wave_height: z.array(z.number().nullable()),
    wave_period: z.array(z.number().nullable()).optional(),
    wave_direction: z.array(z.number().nullable()).optional(),
    swell_wave_height: z.array(z.number().nullable()).optional(),
    swell_wave_period: z.array(z.number().nullable()).optional(),
  }),
});

/**
 * Forecast points from a marine-API body: one per distinct sea cell (land cells are all null), `t`/`v` for
 * the current hour, plus the largest wave height in the forecast and when it comes.
 */
export function forecastFeatures(body: unknown, now: Date): FeatureCollection<Point> {
  const rows = Array.isArray(body) ? body : [body];
  const seen = new Set<string>();
  const features: Feature<Point>[] = [];
  const hourStart = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  for (const raw of rows) {
    const parsed = MarineSchema.safeParse(raw);
    if (!parsed.success) continue;
    const { latitude, longitude, hourly } = parsed.data;
    const key = `${latitude},${longitude}`;
    if (seen.has(key)) continue;
    const times = hourly.time.map((t) => Date.parse(`${t}:00Z`));
    let nowIdx = times.findIndex((t) => t >= hourStart);
    if (nowIdx < 0) nowIdx = times.length - 1;
    const height = hourly.wave_height[nowIdx];
    if (typeof height !== "number") continue;
    seen.add(key);
    let maxIdx = nowIdx;
    for (let i = nowIdx; i < times.length; i++) {
      const h = hourly.wave_height[i];
      if (typeof h === "number" && h > (hourly.wave_height[maxIdx] ?? -1)) maxIdx = i;
    }
    const p: Record<string, string | number> = {
      name: `Forecast ${latitude.toFixed(2)}, ${longitude.toFixed(2)}`,
      kind: "forecast",
      t: new Date(times[nowIdx]).toISOString(),
      v: height,
      waveFt: Math.round(height * M_TO_FT * 10) / 10,
      maxNext48hM: hourly.wave_height[maxIdx] ?? height,
      maxAt: new Date(times[maxIdx]).toISOString(),
    };
    const period = hourly.wave_period?.[nowIdx];
    if (typeof period === "number") p.periodS = period;
    const dir = hourly.wave_direction?.[nowIdx];
    if (typeof dir === "number") {
      p.directionDeg = dir;
      p.directionFrom = compass(dir);
    }
    const swell = hourly.swell_wave_height?.[nowIdx];
    if (typeof swell === "number") p.swellM = swell;
    const swellPeriod = hourly.swell_wave_period?.[nowIdx];
    if (typeof swellPeriod === "number") p.swellPeriodS = swellPeriod;
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: [longitude, latitude] }, properties: p });
  }
  return { type: "FeatureCollection", features };
}

/** NDBC files shared by every view: the latest-observations table starts with its #STN header, the station list is <stations> XML. */
export const LATEST_OBS_BODY = textBody({ markers: [/^\s*#STN/] });
export const STATION_LIST_BODY = textBody({ markers: [/<stations[\s>]/, /<station\s/] });

type Text = { ok: true; text: string } | { ok: false; error: string };

async function fetchText(
  ctx: QueryContext,
  url: string,
  label: string,
  cacheKey: string | undefined,
  ttlSeconds: number,
  validate?: (body: string) => boolean,
): Promise<Text> {
  try {
    const res = await ctx.fetch(url, { cacheKey, ttlSeconds, validate, timeoutMs: UPSTREAM_TIMEOUT_MS });
    if (!res.ok) return { ok: false, error: `${label} returned ${res.status}` };
    return { ok: true, text: await res.text() };
  } catch (err) {
    const timedOut = typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
    return {
      ok: false,
      error: timedOut ? `${label} timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds` : `${label} returned no usable response`,
    };
  }
}

// ---- Seasonal mode (season: true) ----

/**
 * NDBC historical standard meteorological files, one per buoy-year. The gzip is ~170 KB
 * (https://www.ndbc.noaa.gov/data/historical/stdmet/{id}h{year}.txt.gz), but the cached fetch wrapper stores
 * bodies as text, which would corrupt gzip, so the plain-text view NDBC serves for the same file is used
 * (~1.5 MB, 0.2 s; checked 2026-10-10 for 51201h2025). Rows: "YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD ...",
 * every 30 minutes, missing values 99.00 (WVHT, DPD) and 999 (MWD). Raw files are not cached (too big for
 * KV); each buoy's computed 12-month climatology (a few hundred bytes) is cached for a week instead. Only
 * buoys with a wave sensor are summarised: the station list has no wave flag, so a buoy qualifies when its row in
 * the live latest_obs file carries any wave column (WVHT, DPD, APD or MWD).
 */
const HISTORY_URL = "https://www.ndbc.noaa.gov/view_text_file.php";
export const SEASON_BUOY_CAP = 6;
export const SEASON_YEARS = 3;
/** A buoy's multi-year monthly climatology barely moves; a week of cache saves re-reading ~4.5 MB per buoy. */
const CLIMATOLOGY_TTL_SECONDS = 7 * 86_400;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

let climatologyCache: Cache | null = null;
/** Tests swap in a fresh store; production uses the shared fetch cache (KV when configured). */
export function setClimatologyCache(cache: Cache | null): void {
  climatologyCache = cache;
}
function cacheStore(): Cache {
  climatologyCache ??= createCache();
  return climatologyCache;
}

export type MonthStats = { meanM: number; p90M: number; periodS: number | null; directionDeg: number | null; n: number };
export type Climatology = { months: (MonthStats | null)[]; years: number[] };

/** Accumulates one year file's wave rows into per-month samples (mutates `acc`). */
export function addHistoryYear(text: string, acc: { h: number[]; p: number[]; d: number[] }[]): void {
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("#") || line.trim() === "") continue;
    const t = line.trim().split(/\s+/);
    if (t.length < 12) continue;
    const month = Number(t[1]);
    const h = Number(t[8]);
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isFinite(h) || h >= 99 || h < 0) continue;
    const slot = acc[month - 1];
    slot.h.push(h);
    const p = Number(t[9]);
    if (Number.isFinite(p) && p > 0 && p < 99) slot.p.push(p);
    const d = Number(t[11]);
    if (Number.isFinite(d) && d >= 0 && d <= 360) slot.d.push(d);
  }
}

function percentile(sorted: number[], q: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Monthly mean and 90th-percentile wave height, mean dominant period and circular-mean direction. */
export function climatologyFrom(acc: { h: number[]; p: number[]; d: number[] }[], years: number[]): Climatology {
  const months = acc.map((m): MonthStats | null => {
    if (m.h.length === 0) return null;
    const sorted = [...m.h].sort((a, b) => a - b);
    const meanM = m.h.reduce((s, x) => s + x, 0) / m.h.length;
    let direction: number | null = null;
    if (m.d.length > 0) {
      const sx = m.d.reduce((s, x) => s + Math.sin((x * Math.PI) / 180), 0);
      const cx = m.d.reduce((s, x) => s + Math.cos((x * Math.PI) / 180), 0);
      direction = Math.round(((Math.atan2(sx, cx) * 180) / Math.PI + 360) % 360);
    }
    return {
      meanM: round2(meanM),
      p90M: round2(percentile(sorted, 0.9)),
      periodS: m.p.length > 0 ? Math.round((m.p.reduce((s, x) => s + x, 0) / m.p.length) * 10) / 10 : null,
      directionDeg: direction,
      n: m.h.length,
    };
  });
  return { months, years };
}

export type BuoyStation = { id: string; name: string; lon: number; lat: number };

/**
 * Moored buoys (type="buoy") with coordinates from activestations.xml. Fixed shore stations (tide gauges,
 * reserves) are left out: they carry no wave sensor (in the Oahu box 6 of 12 stations were fixed).
 */
export function parseStationList(xml: string): BuoyStation[] {
  const out: BuoyStation[] = [];
  for (const m of xml.matchAll(/<station\b[^>]*>/g)) {
    const tag = m[0];
    const id = /\bid="([^"]*)"/.exec(tag)?.[1];
    const name = /\bname="([^"]*)"/.exec(tag)?.[1];
    const lat = Number(/\blat="([^"]*)"/.exec(tag)?.[1]);
    const lon = Number(/\blon="([^"]*)"/.exec(tag)?.[1]);
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (/\btype="([^"]*)"/.exec(tag)?.[1] !== "buoy") continue;
    out.push({ id, name: decodeEntities(name ?? id).replace(/\s+/g, " ").trim(), lat, lon });
  }
  return out;
}

/** Ids of stations whose latest observation carries any wave column (WVHT, DPD, APD or MWD). */
export function waveStationIds(obs: BuoyObs[]): Set<string> {
  return new Set(
    obs
      .filter((o) => o.wvht !== undefined || o.dpd !== undefined || o.apd !== undefined || o.mwd !== undefined)
      .map((o) => o.id.toUpperCase()),
  );
}

/** Up to SEASON_BUOY_CAP stations in the bbox, nearest its centre first. */
export function seasonStations(stations: BuoyStation[], bbox: BBox): { chosen: BuoyStation[]; inView: number } {
  const centre: [number, number] = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  const inView = stations
    .filter((s) => inBbox(s.lon, s.lat, bbox))
    .sort((a, b) => haversineKm(centre, [a.lon, a.lat]) - haversineKm(centre, [b.lon, b.lat]));
  return { chosen: inView.slice(0, SEASON_BUOY_CAP), inView: inView.length };
}

/** One buoy's climatology: from the day cache, else the last SEASON_YEARS complete years' files. */
async function buoyClimatology(ctx: QueryContext, id: string, now: Date): Promise<Climatology | null> {
  const last = now.getUTCFullYear() - 1;
  const years = Array.from({ length: SEASON_YEARS }, (_, i) => last - SEASON_YEARS + 1 + i);
  const key = `surf:clim:v1:${id}:${years[0]}-${last}`;
  try {
    const hit = await cacheStore().get(key);
    if (hit !== null) return JSON.parse(hit) as Climatology;
  } catch {
    // A cache outage only costs a refetch.
  }
  const acc = Array.from({ length: 12 }, () => ({ h: [] as number[], p: [] as number[], d: [] as number[] }));
  const got: number[] = [];
  for (const year of years) {
    try {
      const res = await ctx.fetch(
        `${HISTORY_URL}?filename=${encodeURIComponent(id.toLowerCase())}h${year}.txt.gz&dir=data/historical/stdmet/`,
        { shouldCache: () => false, timeoutMs: UPSTREAM_TIMEOUT_MS },
      );
      if (!res.ok) continue;
      const text = await res.text();
      // A missing year comes back as a short HTML/error page, not a data file.
      if (!text.startsWith("#YY")) continue;
      addHistoryYear(text, acc);
      got.push(year);
    } catch {
      continue;
    }
  }
  if (got.length === 0) return null;
  const clim = climatologyFrom(acc, got);
  try {
    await cacheStore().set(key, JSON.stringify(clim), CLIMATOLOGY_TTL_SECONDS);
  } catch {
    // Not cached this time.
  }
  return clim;
}

/** A climatology point for `month` (1-12); null when the buoy has no wave data that month. */
export function seasonFeature(station: BuoyStation, clim: Climatology, month: number): Feature<Point> | null {
  const m = clim.months[month - 1];
  if (m === null) return null;
  const p: Record<string, string | number | (number | null)[]> = {
    name: station.name,
    stationId: station.id,
    kind: "climatology",
    month: MONTHS[month - 1],
    v: m.meanM,
    waveFt: Math.round(m.meanM * M_TO_FT * 10) / 10,
    p90M: m.p90M,
    years: `${clim.years[0]}-${clim.years[clim.years.length - 1]}`,
    samples: m.n,
    monthlyMeanM: clim.months.map((x) => (x === null ? null : x.meanM)),
    monthlyP90M: clim.months.map((x) => (x === null ? null : x.p90M)),
    url: `https://www.ndbc.noaa.gov/station_page.php?station=${encodeURIComponent(station.id.toLowerCase())}`,
  };
  if (m.periodS !== null) p.periodS = m.periodS;
  if (m.directionDeg !== null) {
    p.directionDeg = m.directionDeg;
    p.directionFrom = compass(m.directionDeg);
  }
  return { type: "Feature", geometry: { type: "Point", coordinates: [station.lon, station.lat] }, properties: p };
}

async function querySeason(ctx: QueryContext, month: number, now: Date): Promise<LayerResult | LayerError> {
  const citation = {
    source: "NOAA National Data Buoy Center historical standard meteorological data (public domain)",
    url: "https://www.ndbc.noaa.gov/historical_data.shtml",
    retrieved: now.toISOString(),
  };
  const [xml, obsText] = await Promise.all([
    fetchText(ctx, STATIONS_XML, "NDBC station list", "surf:ndbc-stations", STATIONS_TTL_SECONDS, STATION_LIST_BODY),
    fetchText(ctx, LATEST_OBS, "NDBC latest observations", "surf:ndbc-latest", OBS_TTL_SECONDS, LATEST_OBS_BODY),
  ]);
  if (!xml.ok) return { error: xml.error, hint: "upstream" };
  let buoys = parseStationList(xml.text);
  const notes = [`Average waves in ${MONTHS[month - 1]} over the last ${SEASON_YEARS} complete years of buoy records`];
  if (obsText.ok) {
    const waves = waveStationIds(parseLatestObs(obsText.text));
    buoys = buoys.filter((b) => waves.has(b.id.toUpperCase()));
  } else {
    notes.push("Could not check which buoys measure waves (live file unavailable), so every moored buoy was tried");
  }
  const { chosen, inView } = seasonStations(buoys, ctx.bbox);
  if (chosen.length === 0) {
    return { kind: "geojson", data: EMPTY, citation, coverageNote: "No NDBC wave buoys in this view to build a seasonal picture from" };
  }
  const features: Feature<Point>[] = [];
  let noHistory = 0;
  const climatologies = await Promise.all(chosen.map((station) => buoyClimatology(ctx, station.id, now)));
  chosen.forEach((station, i) => {
    const clim = climatologies[i];
    const f = clim === null ? null : seasonFeature(station, clim, month);
    if (f === null) noHistory += 1;
    else features.push(f);
  });
  if (inView > chosen.length) notes.push(`Only the ${chosen.length} wave buoys nearest the centre of ${inView} in view are summarised; zoom in for others`);
  if (noHistory > 0) notes.push(`${noHistory} buoy${noHistory === 1 ? "" : "s"} had no wave history for that month`);
  return { kind: "geojson", data: { type: "FeatureCollection", features }, citation, coverageNote: notes.join("; ") };
}

const surf = defineLayer({
  id: "surf",
  title: "Surf and waves (NOAA buoys, live)",
  description:
    "Live ocean wave conditions for surf, swell and boating questions. User words: surf, swell, waves, wave height, period, how big is it, is it firing, water temperature, buoy. " +
    "Default: NOAA NDBC wave buoys in view, kind 'buoy', each with name, stationId, t (UTC time of the latest observation, usually under an hour old), v (significant wave height in metres; waveFt is the same in feet), " +
    "periodS (dominant wave period in seconds; longer period means more powerful groundswell, under about 8 s is short-period wind chop), avgPeriodS, directionDeg and directionFrom (where the waves come FROM, e.g. 'WNW'), waterTempC (°C), windMs, gustMs (m/s) and windFrom, and url (the buoy page). " +
    "Set forecast to true for Open-Meteo Marine model points on a 4 x 4 grid over the view (land cells are dropped), kind 'forecast': v is the modelled wave height now, swellM and swellPeriodS the swell part, maxNext48hM and maxAt the biggest waves in the next two days. Use it where there is no buoy or to say whether swell is building. " +
    "Set season to true (optionally month 1-12, default this month) for what is typical this time of year instead of today: kind 'climatology', one point per buoy (the 6 nearest the view's centre), v is the mean significant wave height for that month over the last 3 complete years (metres), p90M the 90th percentile (a big day), periodS and directionFrom the usual period and swell direction, and monthlyMeanM and monthlyP90M the 12-month curves (January first) to say which season a coast is best. A cold seasonal query downloads several years of buoy files and can take 10 to 20 seconds. " +
    "Example questions: 'How big is the surf at Ocean Beach right now?', 'What is the swell period off Santa Cruz?', 'Is a bigger swell coming this weekend?', 'Where is the surf best on Oahu this time of year?'. " +
    "Caveats: buoys sit miles offshore, so breaking waves at a beach can be bigger or much smaller depending on exposure, bathymetry and tide; significant height is the average of the highest third of waves, and sets can be about twice that; " +
    "buoys that have not reported for 12 hours and stations without a wave sensor are left out; seasonal averages describe the buoy's exposure, so a north-facing and a south-facing buoy on the same island show which shore gets the swell in each season; the forecast is a coarse model, worst near shore and in bays, and is free for non-commercial use only. " +
    "Global (NDBC plus partner buoys, mostly US waters); zoom in to under 500,000 km².",
  coverage: "global",
  license: "Public domain (NOAA NDBC); forecast from Open-Meteo Marine, CC BY 4.0, free for non-commercial use only",
  requiredEnv: [],
  maxAreaKm2: 500_000,
  input: inputSchema,
  style: { geometry: "point", color: layerColor("surf"), unit: "m", timeField: "t" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const now = new Date();
    if (input.season) return querySeason(ctx, input.month ?? now.getUTCMonth() + 1, now);
    const citation = {
      source: input.forecast
        ? "NOAA National Data Buoy Center latest observations (public domain); Open-Meteo Marine forecast (CC BY 4.0, non-commercial)"
        : "NOAA National Data Buoy Center latest observations (public domain)",
      url: "https://www.ndbc.noaa.gov/",
      retrieved: now.toISOString(),
    };

    const obsText = await fetchText(ctx, LATEST_OBS, "NDBC latest observations", "surf:ndbc-latest", OBS_TTL_SECONDS, LATEST_OBS_BODY);
    if (!obsText.ok) return { error: obsText.error, hint: "upstream" };
    const inside = parseLatestObs(obsText.text).filter((o) => o.wvht !== undefined && inBbox(o.lon, o.lat, ctx.bbox));

    let names = new Map<string, string>();
    if (inside.length > 0) {
      // Names are a nicety; a failure leaves "NDBC <id>".
      const xml = await fetchText(ctx, STATIONS_XML, "NDBC station list", "surf:ndbc-stations", STATIONS_TTL_SECONDS, STATION_LIST_BODY);
      if (xml.ok) names = parseStationNames(xml.text);
    }
    const buoys = buoyFeatures(inside, names, ctx.bbox, now);
    const features = [...buoys.features];
    const notes: string[] = [];

    if (input.forecast) {
      const grid = forecastGrid(ctx.bbox);
      const url =
        `${MARINE_API}?latitude=${grid.map((g) => g[1]).join(",")}&longitude=${grid.map((g) => g[0]).join(",")}` +
        `&hourly=wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period&forecast_days=2&timezone=GMT`;
      const marine = await fetchText(
        ctx,
        url,
        "Open-Meteo Marine",
        ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:marine`,
        FORECAST_TTL_SECONDS,
      );
      if (!marine.ok) {
        if (features.length === 0) return { error: marine.error, hint: "upstream" };
        notes.push(`The wave forecast failed (${marine.error}); showing buoys only`);
      } else {
        let body: unknown = null;
        try {
          body = JSON.parse(marine.text);
        } catch {
          body = null;
        }
        const forecast = forecastFeatures(body, now);
        features.push(...forecast.features);
        if (forecast.features.length === 0) notes.push("The wave model has no sea cells in this view (all land)");
      }
    } else if (buoys.features.length === 0) {
      notes.push("No reporting NDBC wave buoys in this view; ask again with forecast true for modelled waves");
    }

    return {
      kind: "geojson",
      data: features.length === 0 ? EMPTY : { type: "FeatureCollection", features },
      citation,
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(surf);

export default surf;
