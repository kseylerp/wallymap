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
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
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

type Text = { ok: true; text: string } | { ok: false; error: string };

async function fetchText(
  ctx: QueryContext,
  url: string,
  label: string,
  cacheKey: string | undefined,
  ttlSeconds: number,
): Promise<Text> {
  try {
    const res = await ctx.fetch(url, { cacheKey, ttlSeconds, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
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

const surf = defineLayer({
  id: "surf",
  title: "Surf and waves (NOAA buoys, live)",
  description:
    "Live ocean wave conditions for surf, swell and boating questions. User words: surf, swell, waves, wave height, period, how big is it, is it firing, water temperature, buoy. " +
    "Default: NOAA NDBC wave buoys in view, kind 'buoy', each with name, stationId, t (UTC time of the latest observation, usually under an hour old), v (significant wave height in metres; waveFt is the same in feet), " +
    "periodS (dominant wave period in seconds; longer period means more powerful groundswell, under about 8 s is short-period wind chop), avgPeriodS, directionDeg and directionFrom (where the waves come FROM, e.g. 'WNW'), waterTempC (°C), windMs, gustMs (m/s) and windFrom, and url (the buoy page). " +
    "Set forecast to true for Open-Meteo Marine model points on a 4 x 4 grid over the view (land cells are dropped), kind 'forecast': v is the modelled wave height now, swellM and swellPeriodS the swell part, maxNext48hM and maxAt the biggest waves in the next two days. Use it where there is no buoy or to say whether swell is building. " +
    "Example questions: 'How big is the surf at Ocean Beach right now?', 'What is the swell period off Santa Cruz?', 'Is a bigger swell coming this weekend?'. " +
    "Caveats: buoys sit miles offshore, so breaking waves at a beach can be bigger or much smaller depending on exposure, bathymetry and tide; significant height is the average of the highest third of waves, and sets can be about twice that; " +
    "buoys that have not reported for 12 hours and stations without a wave sensor are left out; the forecast is a coarse model, worst near shore and in bays, and is free for non-commercial use only. " +
    "Global (NDBC plus partner buoys, mostly US waters); zoom in to under 500,000 km².",
  coverage: "global",
  license: "Public domain (NOAA NDBC); forecast from Open-Meteo Marine, CC BY 4.0, free for non-commercial use only",
  requiredEnv: [],
  maxAreaKm2: 500_000,
  input: inputSchema,
  style: { geometry: "point", color: layerColor("surf"), unit: "m", timeField: "t" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const now = new Date();
    const citation = {
      source: input.forecast
        ? "NOAA National Data Buoy Center latest observations (public domain); Open-Meteo Marine forecast (CC BY 4.0, non-commercial)"
        : "NOAA National Data Buoy Center latest observations (public domain)",
      url: "https://www.ndbc.noaa.gov/",
      retrieved: now.toISOString(),
    };

    const obsText = await fetchText(ctx, LATEST_OBS, "NDBC latest observations", "surf:ndbc-latest", OBS_TTL_SECONDS);
    if (!obsText.ok) return { error: obsText.error, hint: "upstream" };
    const inside = parseLatestObs(obsText.text).filter((o) => o.wvht !== undefined && inBbox(o.lon, o.lat, ctx.bbox));

    let names = new Map<string, string>();
    if (inside.length > 0) {
      // Names are a nicety; a failure leaves "NDBC <id>".
      const xml = await fetchText(ctx, STATIONS_XML, "NDBC station list", "surf:ndbc-stations", STATIONS_TTL_SECONDS);
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
