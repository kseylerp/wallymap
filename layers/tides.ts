/**
 * Tides from NOAA CO-OPS (Tides and Currents): the next high and low tide at each station, and the water level
 * measured right now where the station has a live sensor.
 *
 * Verified live 2026-10-10 ~02:15 UTC:
 *   - Stations: https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions
 *     ({ count: 3502, stations: [{ id, name, lat, lng, state, type: "R" | "S", reference_id }] }, 2 MB) and
 *     ?type=waterlevels (302 stations with a live gauge, 777 KB). Neither takes a bbox, so both are cached for a
 *     day under shared keys and filtered here. Type "R" (harmonic) does NOT mean a live sensor: 9414317 (R)
 *     answered "No data was found" for water_level, so the waterlevels list decides who gets an observation.
 *   - Predictions: https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&interval=hilo
 *     &station=ID&begin_date=yyyyMMdd HH:mm&range=30&datum=MLLW&units=english&time_zone=gmt&format=json
 *     -> { predictions: [{ t: "2026-10-10 06:49", v: "5.265", type: "H" | "L" }] } (UTC, feet above MLLW).
 *     Works for subordinate ("S") stations too.
 *   - Observed: same endpoint, product=water_level&date=latest -> { metadata, data: [{ t, v, s, f, q }] }.
 *   - Failures are HTTP 200 with { error: { message } } (bad station, no data, "no MLLW").
 * Each station is one or two calls, so at most MAX_STATIONS stations are queried (live gauges first, then the
 * nearest to the view's centre), each cached under a per-station key shared across views.
 *
 * Live smoke 2026-10-10 02:20 UTC, San Francisco Bay box [-122.7,37.6,-122.2,38.0]: 38 stations in view, 8
 * queried (8 s cold, rate-limited; cached after); San Francisco (Golden Gate, 9414290) next high 5.27 ft at
 * 06:49 UTC then low 1.22 ft at 12:19, observed 2.50 ft above MLLW at 02:06 UTC. 3 of the 8 had a live gauge.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { haversineKm } from "./_shared/geo";
import { layerColor } from "@/lib/render/palette";

const MDAPI = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json";
const DATAGETTER = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
const APPLICATION = "WildMap";

export const MAX_STATIONS = 8;
const STATIONS_TTL_SECONDS = 86_400;
/** Predictions are fixed in advance; 15 minutes keeps "next tide" from going stale. */
const PREDICTIONS_TTL_SECONDS = 900;
/** Live gauges report every 6 minutes. */
const OBSERVED_TTL_SECONDS = 360;
const RANGE_HOURS = 30;
const EVENTS_KEPT = 4;

const inputSchema = z.object({});

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const StationSchema = z.object({
  id: z.string(),
  name: z.string(),
  lat: z.number(),
  lng: z.number(),
  state: z.string().nullish(),
  type: z.string().nullish(),
});
export type TideStation = z.infer<typeof StationSchema>;

const PredictionsSchema = z.object({
  predictions: z.array(z.object({ t: z.string(), v: z.string(), type: z.string() })),
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

/** Stations to query: live gauges first, then nearest the view's centre, capped at MAX_STATIONS. */
export function pickStations(stations: TideStation[], live: Set<string>, bbox: BBox): TideStation[] {
  const centre: [number, number] = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  return stations
    .filter((s) => inBbox(s, bbox))
    .map((s) => ({ s, live: live.has(s.id), d: haversineKm(centre, [s.lng, s.lat]) }))
    .sort((a, b) => Number(b.live) - Number(a.live) || a.d - b.d)
    .slice(0, MAX_STATIONS)
    .map((x) => x.s);
}

/** "2026-10-10 06:49" in UTC to ms. */
function gmt(t: string): number {
  return Date.parse(`${t.replace(" ", "T")}:00Z`);
}

export type TideEvent = { time: number; height: number; type: "high" | "low" };

/** Upcoming high and low tides from a predictions body, soonest first. */
export function upcomingEvents(body: unknown, now: Date): TideEvent[] {
  const parsed = PredictionsSchema.safeParse(body);
  if (!parsed.success) return [];
  return parsed.data.predictions
    .map((p) => ({ time: gmt(p.t), height: Number(p.v), type: p.type === "H" ? ("high" as const) : ("low" as const) }))
    .filter((e) => Number.isFinite(e.time) && Number.isFinite(e.height) && e.time >= now.getTime())
    .sort((a, b) => a.time - b.time);
}

/** A gauge reading older than this is a sensor that has gone quiet. */
const OBSERVED_MAX_AGE_MS = 3 * 3_600_000;

/** The latest observed water level, or undefined for an error body, no data or a reading over 3 hours old. */
export function observedLevel(body: unknown, now: Date): { time: number; height: number } | undefined {
  const parsed = ObservedSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const last = parsed.data.data[parsed.data.data.length - 1];
  const height = Number(last.v);
  const time = gmt(last.t);
  if (last.v.trim() === "" || !Number.isFinite(height) || !Number.isFinite(time)) return undefined;
  if (now.getTime() - time > OBSERVED_MAX_AGE_MS) return undefined;
  return { time, height };
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/** One station's point; null when it has no upcoming prediction. */
export function tideFeature(
  station: TideStation,
  events: TideEvent[],
  observed: { time: number; height: number } | undefined,
): Feature<Point> | null {
  const next = events[0];
  if (next === undefined) return null;
  const p: Record<string, string | number> = {
    name: station.name,
    stationId: station.id,
    kind: next.type,
    nextType: next.type,
    t: new Date(next.time).toISOString(),
    v: next.height,
    url: `https://tidesandcurrents.noaa.gov/stationhome.html?id=${station.id}`,
    upcoming: events
      .slice(0, EVENTS_KEPT)
      .map((e) => `${e.type} ${e.height.toFixed(1)} ft at ${hhmm(e.time)} UTC ${new Date(e.time).toISOString().slice(5, 10)}`)
      .join("; "),
  };
  const then = events[1];
  if (then !== undefined) {
    p.thenType = then.type;
    p.thenT = new Date(then.time).toISOString();
    p.thenV = then.height;
  }
  if (observed !== undefined) {
    p.observedNow = observed.height;
    p.observedAt = new Date(observed.time).toISOString();
  }
  if (station.state) p.state = station.state;
  return { type: "Feature", geometry: { type: "Point", coordinates: [station.lng, station.lat] }, properties: p };
}

function gmtStamp(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)} ${iso.slice(11, 16)}`;
}

type Got = { ok: true; body: unknown } | { ok: false; error: string };

async function getJson(
  ctx: QueryContext,
  url: string,
  label: string,
  cacheKey: string,
  ttlSeconds: number,
  cacheErrors = false,
): Promise<Got> {
  try {
    const res = await ctx.fetch(url, {
      cacheKey,
      ttlSeconds,
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

const tides = defineLayer({
  id: "tides",
  title: "Tides (NOAA, next high and low)",
  description:
    "Tide times and heights at NOAA tide stations on US coasts, for beach walking, tide pooling, fishing, surfing, kayaking and launching boats. User words: tide, high tide, low tide, tide pools, tide chart, when is low tide. " +
    "Each point is a station with name, stationId, t (UTC time of the next high or low tide), v (its predicted height in feet above mean lower low water, MLLW, the chart datum; negative means an unusually low tide), " +
    "nextType and kind ('high' or 'low', which comes next), thenType, thenT and thenV (the one after), upcoming (the next four highs and lows as text, times in UTC), and url (the station page). " +
    "Stations with a live gauge also have observedNow (water level measured within the last few minutes, feet above MLLW) and observedAt; when observedNow differs from the prediction by a foot or more, wind or a storm surge is pushing the water. " +
    "Predictions are astronomical and published in advance; convert UTC to local time when answering. " +
    "Example questions: 'When is low tide at Half Moon Bay tomorrow?', 'Is the tide coming in at the Golden Gate right now?', 'Good time for tide pooling this weekend?'. " +
    "Caveats: at most 8 stations are queried per view (live gauges first, then the closest to the centre), so zoom in for a specific beach; " +
    "subordinate stations are offsets from a nearby reference station and less exact; a station's tide can differ a lot from a bay or river mouth a few miles away. " +
    "US coasts and territories only; zoom in to under 50,000 km².",
  coverage: "us",
  license: "Public domain (NOAA CO-OPS)",
  requiredEnv: [],
  maxAreaKm2: 50_000,
  input: inputSchema,
  style: { geometry: "point", color: layerColor("tides"), unit: "ft", timeField: "t" },

  async query(ctx): Promise<LayerResult | LayerError> {
    const now = new Date();
    const citation = {
      source: "NOAA CO-OPS Tides and Currents, predictions and observed water levels (public domain)",
      url: "https://tidesandcurrents.noaa.gov/",
      retrieved: now.toISOString(),
    };
    if (outsideUs(ctx.bbox)) return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };

    const [predStations, liveStations] = await Promise.all([
      getJson(ctx, `${MDAPI}?type=tidepredictions`, "NOAA tide station list", "tides:stations:predictions", STATIONS_TTL_SECONDS),
      getJson(ctx, `${MDAPI}?type=waterlevels`, "NOAA water level station list", "tides:stations:waterlevels", STATIONS_TTL_SECONDS),
    ]);
    if (!predStations.ok) return { error: predStations.error, hint: "upstream" };
    // Without the live list every station is treated as predictions-only.
    const live = new Set(liveStations.ok ? parseStations(liveStations.body).map((s) => s.id) : []);
    const all = parseStations(predStations.body);
    const inView = all.filter((s) => inBbox(s, ctx.bbox)).length;
    if (inView === 0) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: "No NOAA tide stations in this view" };
    }
    const chosen = pickStations(all, live, ctx.bbox);
    const begin = encodeURIComponent(gmtStamp(new Date(now.getTime() - 60_000)));

    const results = await Promise.all(
      chosen.map(async (station) => {
        const common = `&station=${station.id}&datum=MLLW&units=english&time_zone=gmt&format=json&application=${APPLICATION}`;
        const [pred, obs] = await Promise.all([
          getJson(
            ctx,
            `${DATAGETTER}?product=predictions&interval=hilo&begin_date=${begin}&range=${RANGE_HOURS}${common}`,
            "NOAA tide predictions",
            `tides:hilo:${station.id}`,
            PREDICTIONS_TTL_SECONDS,
          ),
          live.has(station.id)
            ? getJson(ctx, `${DATAGETTER}?product=water_level&date=latest${common}`, "NOAA water level", `tides:wl:${station.id}`, OBSERVED_TTL_SECONDS, true)
            : Promise.resolve<Got>({ ok: false, error: "no live gauge" }),
        ]);
        return { station, pred, obs };
      }),
    );

    const features: Feature<Point>[] = [];
    let failed = 0;
    for (const { station, pred, obs } of results) {
      if (!pred.ok) {
        failed += 1;
        continue;
      }
      const f = tideFeature(station, upcomingEvents(pred.body, now), obs.ok ? observedLevel(obs.body, now) : undefined);
      if (f !== null) features.push(f);
    }
    if (features.length === 0 && failed > 0) {
      return { error: "NOAA tide predictions failed for every station in view", hint: "upstream" };
    }

    const notes: string[] = [];
    if (inView > chosen.length) notes.push(`Showing ${chosen.length} of ${inView} tide stations in view; zoom in for the rest`);
    if (failed > 0) notes.push(`${failed} station${failed === 1 ? "" : "s"} did not answer`);
    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(tides);

export default tides;
