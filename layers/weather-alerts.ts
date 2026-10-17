/**
 * Weather alerts: active National Weather Service warnings, watches and advisories, plus current weather at the
 * centre of the view from Open-Meteo.
 *
 * NWS (https://api.weather.gov, keyless; a User-Agent is required), verified live 2026-10-10 ~02:00 UTC:
 *   - /alerts/active with no filter is every US alert (699 alerts, 5 MB), too big per request. `?point=` is one
 *     point only. `?area=CA,NV` (comma-separated state codes) returned 46 alerts in 284 KB, so the states whose
 *     rough bbox (STATE_BBOXES, padded) touches the view are asked for in one call, cached 5 minutes under a
 *     key shared by every view over the same states. Marine zones (area codes PZ, GM, AN ...) are not asked.
 *   - Most alerts (40 of 46) have geometry null and list `affectedZones` URLs
 *     (https://api.weather.gov/zones/forecast/CAZ072, /zones/fire/..., /zones/county/...); CA+NV alone listed
 *     about 80 zones, too many to fetch shapes for. So the zones in view are found by sampling a 3 x 3 grid with
 *     /points/{lat},{lon} (properties.forecastZone, county, fireWeatherZone as zone URLs; cached 30 days per
 *     point, rounded to 0.01°; a 4xx answer, e.g. open water, is remembered for an hour), and a zone alert is
 *     kept when one of its zones is among them. Only those zones' shapes are fetched (/zones/{type}/{id}: a
 *     GeoJSON Feature, 20-40 KB; `/zones?id=...&include_geometry=true` returned geometry null, so one by one),
 *     at most MAX_ZONE_FETCHES, cached 30 days. Polygon alerts are kept
 *     when their polygon's extent overlaps the view.
 *   - Properties used: event, severity (Extreme/Severe/Moderate/Minor/Unknown), urgency, certainty, headline,
 *     areaDesc, onset, effective, expires, ends, senderName, instruction, @id.
 * Open-Meteo current conditions: https://api.open-meteo.com/v1/forecast?latitude=&longitude=&current=
 * temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation,snowfall,weather_code (15-minute model values;
 * free for non-commercial use, CC BY 4.0). One point at the view's centre, kind "now"; works worldwide.
 *
 * Live smoke 2026-10-10 02:28 UTC, Lake Tahoe box [-120.6,38.6,-119.8,39.3], 9 s cold (1 alerts call, 9 points,
 * 3 zones, rate-limited; cached after): 2 alerts in view: Red Flag Warning (Severe, NWS Reno, 18:00 UTC Oct 10
 * to 04:00 UTC Oct 11) and Lake Wind Advisory for the Greater Lake Tahoe Area (Moderate); now 13.3 °C, wind
 * 14.8 km/h gusting 24.5, clear.
 * Wide smoke through runLayer (2026-10-14), Texas [-106,26,-93,36.5] (1.44 million km²), 5.7 s cold (one alerts call
 * for 6 states, 25 points, zone shapes): 23 alerts in view, Flash Flood Warnings (Severe) first, plus the now point.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Point, Polygon, Position } from "geojson";
import { defineLayer, type BBox, type CardSpec, type FieldHelp, type LayerError, type LayerResult, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { bboxesDisjoint, outsideUs } from "./_shared/coverage";
import { geometryBBox } from "./_shared/geo";
import { createCache, type Cache } from "@/lib/fetch";
import { jsonObjectBody } from "@/lib/fetch/validate";
import { layerColor } from "@/lib/render/palette";

const NWS = "https://api.weather.gov";
const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";
const USER_AGENT = "WallyMap/0.1 (https://wallymap.vercel.app)";
const ALERTS_TTL_SECONDS = 300;
const ZONE_TTL_SECONDS = 30 * 86_400;
const NOW_TTL_SECONDS = 600;
export const MAX_ZONE_FETCHES = 30;
/** Most alerts a wide (over 400,000 km²) result carries, most severe first. */
export const WIDE_LIMIT = 1000;
/**
 * Sample grid side over a wide box: 5 x 5 = 25 /points lookups over up to 1.6 million km² keeps about the density of
 * 3 x 3 over 400,000 km², and with the 30 zone shapes stays near 11 seconds cold under NWS's 5 requests a second.
 */
export const WIDE_GRID = 5;
const STATE_PAD_DEG = 0.25;

/** Rough state and territory extents [west, south, east, north], for choosing which states to ask NWS about. */
export const STATE_BBOXES: Record<string, BBox> = {
  AL: [-88.5, 30.1, -84.9, 35.0], AK: [-180, 51, -129, 71.5], AZ: [-114.9, 31.3, -109.0, 37.0],
  AR: [-94.7, 33.0, -89.6, 36.5], CA: [-124.5, 32.5, -114.1, 42.0], CO: [-109.1, 37.0, -102.0, 41.0],
  CT: [-73.8, 40.9, -71.8, 42.1], DE: [-75.8, 38.4, -75.0, 39.9], DC: [-77.2, 38.8, -76.9, 39.0],
  FL: [-87.7, 24.4, -80.0, 31.0], GA: [-85.7, 30.3, -80.8, 35.0], HI: [-160.3, 18.9, -154.8, 22.3],
  ID: [-117.3, 41.9, -111.0, 49.0], IL: [-91.6, 36.9, -87.0, 42.5], IN: [-88.1, 37.7, -84.8, 41.8],
  IA: [-96.7, 40.3, -90.1, 43.5], KS: [-102.1, 36.9, -94.6, 40.0], KY: [-89.6, 36.4, -81.9, 39.2],
  LA: [-94.1, 28.9, -88.8, 33.0], ME: [-71.1, 43.0, -66.9, 47.5], MD: [-79.5, 37.9, -75.0, 39.8],
  MA: [-73.5, 41.2, -69.9, 42.9], MI: [-90.5, 41.6, -82.1, 48.3], MN: [-97.3, 43.4, -89.5, 49.4],
  MS: [-91.7, 30.1, -88.1, 35.0], MO: [-95.8, 35.9, -89.1, 40.7], MT: [-116.1, 44.3, -104.0, 49.0],
  NE: [-104.1, 39.9, -95.3, 43.0], NV: [-120.0, 35.0, -114.0, 42.0], NH: [-72.6, 42.7, -70.6, 45.3],
  NJ: [-75.6, 38.9, -73.9, 41.4], NM: [-109.1, 31.3, -103.0, 37.0], NY: [-79.8, 40.5, -71.8, 45.0],
  NC: [-84.4, 33.8, -75.4, 36.6], ND: [-104.1, 45.9, -96.5, 49.0], OH: [-84.9, 38.4, -80.5, 42.0],
  OK: [-103.0, 33.6, -94.4, 37.0], OR: [-124.6, 41.9, -116.4, 46.3], PA: [-80.6, 39.7, -74.7, 42.3],
  RI: [-71.9, 41.1, -71.1, 42.0], SC: [-83.4, 32.0, -78.5, 35.2], SD: [-104.1, 42.5, -96.4, 45.9],
  TN: [-90.3, 35.0, -81.6, 36.7], TX: [-106.7, 25.8, -93.5, 36.5], UT: [-114.1, 37.0, -109.0, 42.0],
  VT: [-73.5, 42.7, -71.5, 45.0], VA: [-83.7, 36.5, -75.2, 39.5], WA: [-124.8, 45.5, -116.9, 49.0],
  WV: [-82.7, 37.2, -77.7, 40.6], WI: [-92.9, 42.5, -86.8, 47.1], WY: [-111.1, 41.0, -104.0, 45.0],
  PR: [-67.3, 17.9, -65.2, 18.6], VI: [-65.1, 17.6, -64.5, 18.5], GU: [144.6, 13.2, 145.0, 13.7],
};

const SEVERITY_RANK: Record<string, number> = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1 };

const inputSchema = z.object({
  /** Case-insensitive text to match in the event name, e.g. "red flag", "avalanche", "winter storm". */
  event: z.string().trim().min(1).max(120).optional(),
});

/** State codes whose padded extent touches the bbox, sorted. */
export function statesFor(bbox: BBox): string[] {
  return Object.entries(STATE_BBOXES)
    .filter(([, [w, s, e, n]]) => !bboxesDisjoint(bbox, [w - STATE_PAD_DEG, s - STATE_PAD_DEG, e + STATE_PAD_DEG, n + STATE_PAD_DEG]))
    .map(([code]) => code)
    .sort();
}

const AlertSchema = z.object({
  id: z.string().optional(),
  geometry: z.unknown().nullable(),
  properties: z
    .object({
      "@id": z.string().optional(),
      event: z.string(),
      severity: z.string().nullish(),
      urgency: z.string().nullish(),
      certainty: z.string().nullish(),
      headline: z.string().nullish(),
      areaDesc: z.string().nullish(),
      onset: z.string().nullish(),
      effective: z.string().nullish(),
      expires: z.string().nullish(),
      ends: z.string().nullish(),
      senderName: z.string().nullish(),
      instruction: z.string().nullish(),
      affectedZones: z.array(z.string()).nullish(),
    })
    .passthrough(),
});
export type Alert = z.infer<typeof AlertSchema>;

export function parseAlerts(body: unknown): Alert[] {
  if (typeof body !== "object" || body === null || !("features" in body) || !Array.isArray(body.features)) return [];
  const out: Alert[] = [];
  for (const raw of body.features) {
    const parsed = AlertSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function isArea(g: unknown): g is Polygon | MultiPolygon {
  return typeof g === "object" && g !== null && "type" in g && (g.type === "Polygon" || g.type === "MultiPolygon");
}

function overlaps(g: Geometry, bbox: BBox): boolean {
  const gb = geometryBBox(g);
  return gb !== null && !bboxesDisjoint(gb, bbox);
}

const GRID = 3;

/** Cell centres of a grid x grid sampling (3 x 3 by default) over the bbox as [lat, lon] rounded to 0.01°, deduplicated. */
export function samplePoints([w, s, e, n]: BBox, grid = GRID): [number, number][] {
  const out = new Map<string, [number, number]>();
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const lat = Math.round((s + ((j + 0.5) * (n - s)) / grid) * 100) / 100;
      const lon = Math.round((w + ((i + 0.5) * (e - w)) / grid) * 100) / 100;
      out.set(`${lat},${lon}`, [lat, lon]);
    }
  }
  return [...out.values()];
}

/** Zone URLs (forecast, county, fire weather) from a /points body. */
export function zonesFromPoint(body: unknown): string[] {
  if (typeof body !== "object" || body === null || !("properties" in body)) return [];
  const p = body.properties;
  if (typeof p !== "object" || p === null) return [];
  const out: string[] = [];
  for (const key of ["forecastZone", "county", "fireWeatherZone"]) {
    const v = (p as Record<string, unknown>)[key];
    if (typeof v === "string" && v.startsWith(`${NWS}/zones/`)) out.push(v);
  }
  return out;
}

/** Zone URLs to fetch shapes for: zones in view used by zone-only alerts, most severe alerts first, capped. */
export function zonesToFetch(alerts: Alert[], inView: Set<string>): { urls: string[]; capped: boolean } {
  const ordered = [...alerts]
    .filter((a) => !isArea(a.geometry))
    .sort((a, b) => (SEVERITY_RANK[b.properties.severity ?? ""] ?? 0) - (SEVERITY_RANK[a.properties.severity ?? ""] ?? 0));
  const urls: string[] = [];
  const seen = new Set<string>();
  let capped = false;
  for (const a of ordered) {
    for (const url of a.properties.affectedZones ?? []) {
      if (seen.has(url) || !inView.has(url)) continue;
      seen.add(url);
      if (urls.length >= MAX_ZONE_FETCHES) capped = true;
      else urls.push(url);
    }
  }
  return { urls, capped };
}

function roundRing(ring: Position[]): Position[] {
  return ring.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);
}

function polygonsOf(g: Polygon | MultiPolygon): Position[][][] {
  return g.type === "Polygon" ? [g.coordinates] : g.coordinates;
}

/**
 * Alert areas in view. Polygon alerts are kept when their shape's extent overlaps the view; zone alerts when one
 * of their zones is in `inView`, drawn as the union of those zones' shapes. `unplaced` counts zone alerts in view
 * whose shapes could not be fetched (left out).
 */
export function alertFeatures(
  alerts: Alert[],
  inView: Set<string>,
  zones: Map<string, Polygon | MultiPolygon>,
  bbox: BBox,
  event?: string,
): { features: Feature[]; unplaced: number } {
  const features: Feature[] = [];
  let unplaced = 0;
  const needle = event?.toLowerCase();
  for (const a of alerts) {
    const p = a.properties;
    if (needle !== undefined && !p.event.toLowerCase().includes(needle)) continue;
    let geometry: Polygon | MultiPolygon | null = null;
    if (isArea(a.geometry)) {
      if (overlaps(a.geometry, bbox)) geometry = a.geometry;
    } else {
      const here = (p.affectedZones ?? []).filter((u) => inView.has(u));
      if (here.length === 0) continue;
      const shapes = here.map((u) => zones.get(u)).filter((g) => g !== undefined);
      if (shapes.length === 0) {
        unplaced += 1;
        continue;
      }
      geometry = { type: "MultiPolygon", coordinates: shapes.flatMap(polygonsOf).map((poly) => poly.map(roundRing)) };
    }
    if (geometry === null) continue;
    const props: Record<string, string | number> = {
      kind: p.event,
      event: p.event,
      severity: p.severity ?? "Unknown",
      v: SEVERITY_RANK[p.severity ?? ""] ?? 0,
    };
    const start = p.onset ?? p.effective;
    if (start) props.t = new Date(start).toISOString();
    const end = p.ends ?? p.expires;
    if (end) props.expires = new Date(end).toISOString();
    for (const key of ["headline", "urgency", "certainty", "areaDesc", "senderName", "instruction"] as const) {
      const value = p[key];
      if (typeof value === "string" && value.trim() !== "") props[key] = value.trim();
    }
    if (p["@id"]) props.url = p["@id"];
    features.push({ type: "Feature", geometry, properties: props });
  }
  features.sort((x, y) => Number(y.properties?.v ?? 0) - Number(x.properties?.v ?? 0));
  return { features, unplaced };
}

/** WMO weather code to words (Open-Meteo's table, condensed). */
export function weatherWords(code: number): string {
  if (code === 0) return "clear";
  if (code <= 2) return "partly cloudy";
  if (code === 3) return "overcast";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code >= 61 && code <= 67) return "rain";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 80 && code <= 82) return "rain showers";
  if (code === 85 || code === 86) return "snow showers";
  if (code >= 95) return "thunderstorm";
  return "unknown";
}

const CurrentSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  current: z.object({
    time: z.string(),
    temperature_2m: z.number().nullable(),
    wind_speed_10m: z.number().nullable().optional(),
    wind_gusts_10m: z.number().nullable().optional(),
    precipitation: z.number().nullable().optional(),
    snowfall: z.number().nullable().optional(),
    weather_code: z.number().nullable().optional(),
  }),
});

/** The "now" point from an Open-Meteo current-conditions body, at the requested centre. */
export function nowFeature(body: unknown, centre: [number, number]): Feature<Point> | null {
  const parsed = CurrentSchema.safeParse(body);
  if (!parsed.success || parsed.data.current.temperature_2m === null) return null;
  const c = parsed.data.current;
  const p: Record<string, string | number> = {
    kind: "now",
    name: "Current conditions (model)",
    t: new Date(`${c.time}:00Z`).toISOString(),
    v: c.temperature_2m!,
    temperatureC: c.temperature_2m!,
  };
  if (typeof c.wind_speed_10m === "number") p.windKmh = c.wind_speed_10m;
  if (typeof c.wind_gusts_10m === "number") p.gustKmh = c.wind_gusts_10m;
  if (typeof c.precipitation === "number") p.precipitationMm = c.precipitation;
  if (typeof c.snowfall === "number") p.snowfallCm = c.snowfall;
  if (typeof c.weather_code === "number") {
    p.weatherCode = c.weather_code;
    p.weather = weatherWords(c.weather_code);
  }
  return { type: "Feature", geometry: { type: "Point", coordinates: centre }, properties: p };
}

type Got = { ok: true; body: unknown } | { ok: false; error: string; status?: number };

/** How long a point NWS has no answer for (open water, outside its area: HTTP 404) is skipped. */
const POINT_MISS_TTL_SECONDS = 3_600;

let pointMissCache: Cache | null = null;
/**
 * The fetch cache only keeps 2xx bodies, so failed /points lookups are remembered here. Tests swap in a fresh
 * store; production uses the shared cache (KV when configured).
 */
export function setPointMissCache(cache: Cache | null): void {
  pointMissCache = cache;
}
function missStore(): Cache {
  pointMissCache ??= createCache();
  return pointMissCache;
}

/** A /points lookup that remembers a 4xx answer for an hour so each view does not repeat it. */
async function lookupPoint(ctx: QueryContext, lat: number, lon: number): Promise<Got> {
  const missKey = `weather-alerts:point-miss:${lat},${lon}`;
  try {
    if ((await missStore().get(missKey)) !== null) return { ok: false, error: "NWS has no forecast point here (cached)" };
  } catch {
    // Without the miss cache the lookup is simply repeated.
  }
  const got = await getJson(ctx, `${NWS}/points/${lat},${lon}`, "NWS point", `weather-alerts:point:${lat},${lon}`, ZONE_TTL_SECONDS, true);
  if (!got.ok && got.status !== undefined && got.status >= 400 && got.status < 500) {
    try {
      await missStore().set(missKey, String(got.status), POINT_MISS_TTL_SECONDS);
    } catch {
      // Not remembered this time.
    }
  }
  return got;
}

const JSON_OBJECT_BODY = jsonObjectBody();

async function getJson(ctx: QueryContext, url: string, label: string, cacheKey: string | undefined, ttlSeconds: number, nws: boolean): Promise<Got> {
  try {
    const res = await ctx.fetch(url, {
      cacheKey,
      ttlSeconds,
      // Point and zone answers are shared by every view for a day, so only a JSON object is stored.
      validate: JSON_OBJECT_BODY,
      ...(nws ? { headers: { "user-agent": USER_AGENT, accept: "application/geo+json" } } : {}),
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    if (!res.ok) return { ok: false, error: `${label} returned ${res.status}`, status: res.status };
    return { ok: true, body: await res.json() };
  } catch (err) {
    const timedOut = typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
    return { ok: false, error: timedOut ? `${label} timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds` : `${label} returned no usable response` };
  }
}

const CAP_SOURCE = { source: "National Weather Service alerts (Common Alerting Protocol)", url: "https://www.weather.gov/alerts" };

const HELP: Record<string, FieldHelp> = {
  severity: {
    text: "How great a threat the alert describes, in the National Weather Service's alert terms: Extreme, Severe, Moderate or Minor (Unknown when not given).",
    scale: "Minor, Moderate, Severe, Extreme",
    ...CAP_SOURCE,
  },
  urgency: { text: "How soon people should act, in the alert's own terms: Immediate, Expected, Future or Past.", ...CAP_SOURCE },
  certainty: { text: "How sure the forecaster is that the event will happen, in the alert's own terms: Observed, Likely, Possible or Unlikely.", ...CAP_SOURCE },
  temperatureC: { text: "Air temperature 2 m above the ground now, from the Open-Meteo weather model at the centre of the view (a model value, not a station reading).", unit: "°C" },
  windKmh: { text: "Wind speed 10 m above the ground now, from the Open-Meteo weather model.", unit: "km/h" },
  gustKmh: { text: "Wind gusts 10 m above the ground now, from the Open-Meteo weather model.", unit: "km/h" },
};

const WEATHER_WORDS: Record<string, string> = {
  clear: "Clear",
  "partly cloudy": "Partly cloudy",
  overcast: "Overcast",
  fog: "Fog",
  drizzle: "Drizzle",
  rain: "Rain",
  snow: "Snow",
  "rain showers": "Rain showers",
  "snow showers": "Snow showers",
  thunderstorm: "Thunderstorm",
  unknown: "Unknown",
};

/**
 * One card for both feature kinds: an alert (event, severity, ends ...) and the "now" point (temperature, wind ...).
 * No measure: v is the severity rank on an alert and the temperature on the now point, both shown in words below.
 */
const CARD: CardSpec = {
  facts: [
    { key: "event", label: "Alert" },
    { key: "severity", label: "Severity" },
    { key: "urgency", label: "Urgency" },
    { key: "certainty", label: "Certainty" },
    { key: "expires", label: "Ends", format: "date" },
    { key: "headline", label: "Headline" },
    { key: "areaDesc", label: "Areas" },
    { key: "instruction", label: "What to do" },
    { key: "senderName", label: "Issued by" },
    { key: "weather", label: "Weather", values: WEATHER_WORDS },
    { key: "temperatureC", label: "Temperature", unit: "°C", format: "1dp" },
    { key: "windKmh", label: "Wind", unit: "km/h", format: "1dp" },
    { key: "gustKmh", label: "Gusts", unit: "km/h", format: "1dp" },
    { key: "precipitationMm", label: "Precipitation", unit: "mm", format: "1dp" },
    { key: "snowfallCm", label: "Snowfall", unit: "cm", format: "1dp" },
  ],
  /** Kind repeats the event (or is "now"); the WMO weather code is the Weather row in words. */
  hidden: ["kind", "weatherCode"],
  links: [{ key: "url", label: "Full alert from the National Weather Service" }],
};

const weatherAlerts = defineLayer({
  id: "weather-alerts",
  title: "Weather alerts (NWS, live) and current weather",
  description:
    "Active National Weather Service warnings, watches and advisories in view, plus the weather right now at the centre of the view. User words: warnings, alerts, weather alerts, red flag warning, avalanche warning, winter storm, flood, heat, wind advisory, is there a warning, what's the weather. " +
    "Each alert is an area with kind and event (e.g. 'Red Flag Warning', 'Avalanche Warning', 'Winter Storm Warning', 'Flood Watch', 'Wind Advisory'), severity (Extreme, Severe, Moderate, Minor) and v as its rank (4 to 1), " +
    "t (onset, UTC), expires (when it ends, UTC), headline, urgency, certainty, areaDesc (the named zones), senderName (the NWS office), instruction (what to do) and url. Alerts are sorted most severe first. " +
    "Set event to filter by name, e.g. 'red flag' or 'avalanche'. One extra point, kind 'now', is current conditions from the Open-Meteo model at the view's centre: temperatureC (v), windKmh, gustKmh, precipitationMm, snowfallCm and weather (e.g. 'snow showers'), t = the 15-minute model time. " +
    "Alerts are live (refreshed every 5 minutes). Example questions: 'Are there any red flag warnings near Tahoe?', 'Is there an avalanche warning for the Wasatch?'. " +
    "Caveats: alerts are United States only and land zones only (marine warnings are left out; use surf for sea state); an alert's area is its whole forecast zone, which can be larger than the hazard; " +
    "zones in view are found by sampling 9 points across it, so a small zone between them can be missed; avalanche warnings come from NWS only when an avalanche centre asks for one, so check the local avalanche centre; " +
    "the 'now' point is a model value, not a station reading, free for non-commercial use only. Over 400,000 km² it samples 25 points and keeps the 1,000 most severe alerts.",
  coverage: "global",
  surface: "any",
  license: "Public domain (NOAA NWS); current conditions from Open-Meteo, CC BY 4.0, free for non-commercial use only",
  requiredEnv: [],
  maxAreaKm2: 400_000,
  // Default hard cap (1.6 million km², about Texas plus a neighbour): the alerts call is per state and the
  // /points and zone lookups stay capped (WIDE_GRID, MAX_ZONE_FETCHES), so the cost does not grow past it.
  wide: { orderBy: "severity", limit: WIDE_LIMIT, rank: "most severe" },
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("weather-alerts"), fillOpacity: 0.25, timeField: "t" },
  fieldHelp: HELP,
  card: CARD,

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const now = new Date();
    const [west, south, east, north] = ctx.bbox;
    const centre: [number, number] = [Number(((west + east) / 2).toFixed(4)), Number(((south + north) / 2).toFixed(4))];
    const citation = {
      source: "NOAA National Weather Service active alerts (public domain); Open-Meteo current conditions (CC BY 4.0, non-commercial)",
      url: "https://www.weather.gov/alerts",
      retrieved: now.toISOString(),
    };

    const nowUrl =
      `${OPEN_METEO}?latitude=${centre[1]}&longitude=${centre[0]}` +
      `&current=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation,snowfall,weather_code&timezone=GMT`;
    const nowPromise = getJson(ctx, nowUrl, "Open-Meteo", ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:now`, NOW_TTL_SECONDS, false);

    const notes: string[] = [];
    const features: Feature[] = [];
    const states = outsideUs(ctx.bbox) ? [] : statesFor(ctx.bbox);
    let alertsError: string | null = null;
    let alertTotal: number | undefined;

    if (states.length === 0) {
      notes.push("NWS alerts cover the United States only");
    } else {
      const alertsRes = await getJson(
        ctx,
        `${NWS}/alerts/active?status=actual&area=${states.join(",")}`,
        "NWS alerts",
        `weather-alerts:nws:${states.join(",")}`,
        ALERTS_TTL_SECONDS,
        true,
      );
      if (!alertsRes.ok) {
        alertsError = alertsRes.error;
      } else {
        const alerts = parseAlerts(alertsRes.body);
        const needZones = alerts.some((a) => !isArea(a.geometry));
        const pointBodies = needZones
          ? await Promise.all(
              samplePoints(ctx.bbox, ctx.wide ? WIDE_GRID : GRID).map(([lat, lon]) => lookupPoint(ctx, lat, lon)),
            )
          : [];
        const inView = new Set(pointBodies.flatMap((b) => (b.ok ? zonesFromPoint(b.body) : [])));
        const { urls, capped } = zonesToFetch(alerts, inView);
        const zoneBodies = await Promise.all(
          urls.map((url) => getJson(ctx, url, "NWS zone", `weather-alerts:zone:${url.slice(`${NWS}/zones/`.length)}`, ZONE_TTL_SECONDS, true)),
        );
        const zones = new Map<string, Polygon | MultiPolygon>();
        urls.forEach((url, i) => {
          const z = zoneBodies[i];
          if (z.ok && typeof z.body === "object" && z.body !== null && "geometry" in z.body && isArea(z.body.geometry)) {
            zones.set(url, z.body.geometry);
          }
        });
        const placed = alertFeatures(alerts, inView, zones, ctx.bbox, input.event);
        // Alerts arrive most severe first, so a wide cut keeps the most severe.
        const limit = ctx.wide ? (ctx.wideStrategy?.limit ?? WIDE_LIMIT) : Infinity;
        if (placed.features.length > limit) alertTotal = placed.features.length;
        features.push(...placed.features.slice(0, limit));
        if (placed.features.length === 0) notes.push(input.event ? `No active "${input.event}" alerts in view` : "No active NWS alerts in view");
        if (placed.unplaced > 0) {
          notes.push(
            `${placed.unplaced} alert${placed.unplaced === 1 ? "" : "s"} in view could not be drawn (zone shapes ${capped ? `capped at ${MAX_ZONE_FETCHES}` : "unavailable"})`,
          );
        }
      }
    }

    const current = await nowPromise;
    const point = current.ok ? nowFeature(current.body, centre) : null;
    if (point !== null) features.push(point);
    else notes.push("Current conditions were unavailable");
    // The total counts every feature the source had, so it includes the 'now' point like the shown count does.
    if (alertTotal !== undefined && point !== null) alertTotal += 1;

    if (alertsError !== null) {
      if (point === null) return { error: alertsError, hint: "upstream" };
      notes.unshift(`NWS alerts failed (${alertsError}); showing current conditions only`);
    }

    const data: FeatureCollection = { type: "FeatureCollection", features };
    return {
      kind: "geojson",
      data,
      citation,
      ...(alertTotal !== undefined && { total: alertTotal }),
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(weatherAlerts);

export default weatherAlerts;
