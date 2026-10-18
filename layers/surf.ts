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
 * Forecast (input forecast: true): modelled waves at named surf spots, added on top of the buoys. Spots come from
 * OpenStreetMap (Overpass: named places tagged sport=surfing or surfing=yes, not shops, schools or wave pools) and
 * Wikidata (surf spot Q2368508, surf break Q3482498, with coordinates), merged with the named spots saved in
 * layers/_data/surf-spots.json so a failed lookup never empties the forecast, deduplicated within 1 km, at most 40,
 * Wikidata first then OSM-tagged then name matches, nearest the view's centre first. Overpass goes to OVERPASS_URL first. https://marine-api.open-meteo.com/v1/marine
 * takes comma-separated latitude/longitude lists (one JSON object per point in an array, one object for a single point)
 * with hourly=wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period, forecast_days=2, timezone=GMT.
 * The model grid is 1/12 degree (about 9 km) and a coastal point snaps to a nearby sea cell, so neighbouring spots can
 * share a value; land-locked points return null for every hour (Lake Tahoe), and those are tried 1, 2 and 3 km away
 * on four bearings before the spot is dropped. A regular grid over the bbox is never drawn: it put 16 symbols in open
 * ocean off Monterey for a Half Moon Bay question. Open-Meteo is free for non-commercial use only (CC BY 4.0 data).
 *
 * Live smoke 2026-10-10 02:15 UTC, San Francisco box [-123.2,37.3,-122.3,38.0], 0.4 s: 2 buoys; 46012 Half
 * Moon Bay 2.2 m (7.2 ft) at 11 s, water 16.3 °C; 46237 San Francisco Bar 1.8 m at 11 s from the W (261°).
 * 46026 was in view but its newest row had no wave height (MM), so it was left out.
 * Season smoke (season: true), Oahu box [-158.4,21.2,-157.6,21.75], 14 s cold (18 files of ~1.5 MB through the
 * rate limiter): 6 buoys, October means 2023-2025: Mokapu Point 1.62 m, Waimea Bay 1.58 m (January 2.40 m, p90
 * 3.57 m: the north shore's winter season), Kaneohe 1.47 m, Barbers Point 1.07 m, Pearl Harbor 0.82 m.
 * Wide smoke through runLayer (2026-10-14), eastern Pacific [-130,20,-110,45] (5.2 million km²): 44 buoys in 0.4 s
 * (one global file, so wide costs nothing extra); forecast: true 40 spots at most; season: true 6 summarised plus
 * 37 listed as kind 'station' in 15.3 s cold.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import {
  defineLayer,
  type BBox,
  type LayerError,
  type LayerResult,
  type QueryContext,
  type CardSpec,
  type Attribute,
  type FieldHelp,
  type LegendSpec,
  type SourceStatus,
} from "./types";
import { nameAttribute, timeAttribute } from "./_shared/bands";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { WHOLE_US_KM2 } from "./_shared/coverage";
import { haversineKm } from "./_shared/geo";
import { overpassQuery } from "./_shared/overpass";
import { wikimediaFetch } from "./_shared/wikimedia";
import { createCache, type Cache } from "@/lib/fetch";
import { textBody } from "@/lib/fetch/validate";
import { layerColor } from "@/lib/render/palette";
import SAVED_SPOTS from "./_data/surf-spots.json";

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
const M_TO_FT = 3.28084;
const MS_TO_KT = 1.94384;
const MS_TO_MPH = 2.23694;
/** Most points a wide (over 500,000 km²) result carries; NDBC has about 200 wave buoys worldwide, so rarely reached. */
export const WIDE_LIMIT = 1000;

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

const COMPASS_WORDS = [
  "North",
  "North-northeast",
  "Northeast",
  "East-northeast",
  "East",
  "East-southeast",
  "Southeast",
  "South-southeast",
  "South",
  "South-southwest",
  "Southwest",
  "West-southwest",
  "West",
  "West-northwest",
  "Northwest",
  "North-northwest",
];

const compassWord = (deg: number) => COMPASS_WORDS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

/** "West-northwest (292°)": where the waves come from, in words and degrees. */
export function directionText(deg: number): string {
  return `${compassWord(deg)} (${Math.round(((deg % 360) + 360) % 360)}°)`;
}

/**
 * The time zone a point at sea keeps, coarsely: the US coasts and lakes by region (Puerto Rico, Hawaii, Alaska, the
 * Pacific, the Gulf, the Great Lakes, Atlantic Canada, the Atlantic), else the nautical zone of its longitude
 * ("Etc/GMT+8" is UTC-8). Good enough to print a reading time in local time; a buoy near a zone line can be an hour off.
 */
export function zoneAt(lon: number, lat: number): string {
  if (lat >= 17 && lat <= 19.5 && lon >= -68 && lon <= -64) return "America/Puerto_Rico";
  if (lat >= 15 && lat < 30 && lon >= -179 && lon <= -150) return "Pacific/Honolulu";
  if (lat >= 50 && lon <= -169) return "America/Adak";
  if (lat >= 50 && lon <= -129) return "America/Anchorage";
  if (lat >= 20 && lat < 50 && lon > -135 && lon <= -114) return "America/Los_Angeles";
  if (lat >= 24 && lat < 31 && lon > -98 && lon < -85.2) return "America/Chicago";
  if (lat >= 41 && lat < 49.5 && lon > -93 && lon < -86.5) return "America/Chicago";
  if (lat >= 43 && lat < 60 && lon >= -67 && lon <= -50) return "America/Halifax";
  if (lat >= 24 && lat < 50 && lon >= -86.5 && lon <= -60) return "America/New_York";
  const n = Math.round(-lon / 15);
  return n === 0 ? "Etc/GMT" : `Etc/GMT${n > 0 ? "+" : "-"}${Math.abs(n)}`;
}

/** "6:50 pm PDT Sat": an instant in a time zone, with the zone's abbreviation and the weekday. */
export function localTime(ms: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
    weekday: "short",
    timeZoneName: "short",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")} ${get("dayPeriod").toLowerCase()} ${get("timeZoneName")} ${get("weekday")}`;
}

const ft = (m: number) => Math.round(m * M_TO_FT * 10) / 10;

/** "12 knots (14 mph) from the northwest, gusts 18 knots": the wind in a sailor's and a driver's units. */
export function windText(ms: number, fromDeg: number | undefined, gustMs: number | undefined): string {
  const kt = Math.round(ms * MS_TO_KT);
  const from = fromDeg === undefined ? "" : ` from the ${compassWord(fromDeg).toLowerCase()}`;
  const gust = gustMs === undefined ? "" : `, gusts ${Math.round(gustMs * MS_TO_KT)} knots`;
  return `${kt} knot${kt === 1 ? "" : "s"} (${Math.round(ms * MS_TO_MPH)} mph)${from}${gust}`;
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
      readAt: localTime(o.time, zoneAt(o.lon, o.lat)),
      v: o.wvht,
      waveFt: ft(o.wvht),
      url: `https://www.ndbc.noaa.gov/station_page.php?station=${encodeURIComponent(o.id.toLowerCase())}`,
    };
    if (o.dpd !== undefined) p.periodS = o.dpd;
    if (o.apd !== undefined) p.avgPeriodS = o.apd;
    if (o.mwd !== undefined) {
      p.directionDeg = o.mwd;
      p.directionFrom = compass(o.mwd);
      p.swellFrom = directionText(o.mwd);
    }
    if (o.wtmp !== undefined) {
      p.waterTempC = o.wtmp;
      p.waterTempF = Math.round((o.wtmp * 9) / 5 + 32);
    }
    if (o.wspd !== undefined) {
      p.windMs = o.wspd;
      p.windKt = Math.round(o.wspd * MS_TO_KT);
      p.wind = windText(o.wspd, o.wdir, o.gst);
    }
    if (o.gst !== undefined) {
      p.gustMs = o.gst;
      p.gustKt = Math.round(o.gst * MS_TO_KT);
    }
    if (o.wdir !== undefined) p.windFrom = compass(o.wdir);
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: [o.lon, o.lat] }, properties: p });
  }
  return { type: "FeatureCollection", features };
}

/**
 * A wide result's cut: the `limit` points with the largest wave height v, and the count before the cut when there
 * was one.
 */
export function keepLargest(features: Feature<Point>[], limit: number): { features: Feature<Point>[]; total?: number } {
  if (features.length <= limit) return { features };
  const vOf = (f: Feature) => (typeof f.properties?.v === "number" ? f.properties.v : -Infinity);
  return { features: [...features].sort((a, b) => vOf(b) - vOf(a)).slice(0, limit), total: features.length };
}

// ---- Forecast at named surf spots ----

/** A place people surf: a name and a coordinate. `rank` 0 is Wikidata's surf spot, 1 an OSM-tagged surf spot, 2 a beach whose name suggests surf. */
export type Spot = { name: string; lat: number; lon: number; source: "OpenStreetMap" | "Wikidata"; rank: number };

type SavedSpot = { name: string; lat: number; lon: number; source: string; byName?: boolean };

/**
 * Named surf spots saved with the app (layers/_data/surf-spots.json, built 2026-10-18 from OpenStreetMap places tagged
 * sport=surfing or surfing=yes, beaches whose name says surf or reef, and Wikidata surf spots; 435 worldwide after the
 * same 1 km merge). They are merged with the live lookup every time, so an Overpass or Wikidata failure never empties
 * the forecast, and a live answer adds spots tagged since.
 */
export function savedSpots(bbox: BBox, saved: SavedSpot[] = (SAVED_SPOTS as { spots: SavedSpot[] }).spots): Spot[] {
  return saved
    .filter((s) => inBbox(s.lon, s.lat, bbox))
    .map((s) => ({
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      source: s.source === "Wikidata" ? ("Wikidata" as const) : ("OpenStreetMap" as const),
      rank: s.source === "Wikidata" ? 0 : s.byName ? 2 : 1,
    }));
}

/** Most forecast spots a result carries. */
export const SPOT_CAP = 40;
/** Spots closer than this are one break. */
const SPOT_DEDUPE_KM = 1;
/** Seaward nudges tried when the model has no value at a spot: 1, 2 then 3 km. */
export const NUDGE_STEPS_KM = [1, 2, 3];
/** Directions tried at each nudge distance, west first (the Pacific and Atlantic-facing US coasts) then the rest. */
const NUDGE_BEARINGS = [270, 180, 90, 0];
/** Points per Open-Meteo request, which keeps the URL short. */
const MARINE_CHUNK = 40;
const SPOTS_TTL_SECONDS = 7 * 86_400;
const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";

/**
 * Overpass QL for surf places in the bbox: anything tagged sport=surfing or surfing=yes. `out center` gives ways one
 * position. Beaches matched by name are not searched live: a name regex over every beach from New Jersey to Long Island
 * ran 48 s and failed on the server (2026-10-18), and it found bay beaches like Coyote Point; the saved list carries
 * beaches whose name says surf or reef instead.
 */
export function surfSpotsQuery([west, south, east, north]: BBox): string {
  const box = `(${south},${west},${north},${east})`;
  return `[out:json][timeout:25];(nwr["sport"="surfing"]${box};nwr["surfing"="yes"]${box};);out tags center 300;`;
}

const NOT_A_BREAK_LEISURE = new Set(["sports_centre", "water_park", "swimming_pool", "fitness_centre"]);
const NOT_A_BREAK_NAME = /school|lesson|academy|shop|rental|hire|camp\b|club|wave ?pool|surf ?park|flowhouse|flowrider|hotel|hostel|lodge/i;

const osmElementSchema = z.object({
  type: z.string(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

/**
 * Named surf places from an Overpass body. Unnamed elements are dropped (no name, no feature), and so are places that
 * are not a break: shops, schools, clubs, hotels, buildings, wave pools and sports centres (in New Jersey the only two
 * sport=surfing places were a wave pool and a surf school).
 */
export function parseOsmSpots(json: unknown): Spot[] {
  const elements = typeof json === "object" && json !== null ? (json as { elements?: unknown }).elements : undefined;
  if (!Array.isArray(elements)) return [];
  const out: Spot[] = [];
  for (const raw of elements) {
    const parsed = osmElementSchema.safeParse(raw);
    if (!parsed.success) continue;
    const { lat, lon, center, tags } = parsed.data;
    const name = tags?.name?.trim();
    const at = lat !== undefined && lon !== undefined ? { lat, lon } : center;
    if (!name || !at || tags === undefined) continue;
    if (tags.shop || tags.amenity || tags.tourism || tags.office || tags.craft || tags.club || tags.building) continue;
    if (tags.leisure !== undefined && NOT_A_BREAK_LEISURE.has(tags.leisure) && tags.natural === undefined) continue;
    if (NOT_A_BREAK_NAME.test(name)) continue;
    const tagged = tags.sport === "surfing" || tags.surfing === "yes";
    out.push({ name, lat: at.lat, lon: at.lon, source: "OpenStreetMap", rank: tagged ? 1 : 2 });
  }
  return out;
}

/**
 * Wikidata's surf spots (Q2368508) and surf breaks (Q3482498) with coordinates in the bbox. Direct instances only: the
 * subclass walk (wdt:P31/wdt:P279*) took 15 s for Half Moon Bay to Santa Cruz and found the same two spots (2026-10-18).
 */
export function surfSpotsSparql([west, south, east, north]: BBox): string {
  return `SELECT ?item ?label ?coord WHERE {
  SERVICE wikibase:box {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point(${west} ${south})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point(${east} ${north})"^^geo:wktLiteral .
  }
  VALUES ?class { wd:Q2368508 wd:Q3482498 }
  ?item wdt:P31 ?class .
  ?item rdfs:label ?label . FILTER(LANG(?label) = "en")
}
LIMIT 200`;
}

const sparqlSchema = z.object({
  results: z.object({
    bindings: z.array(z.object({ label: z.object({ value: z.string() }), coord: z.object({ value: z.string() }) })),
  }),
});

/** Spots from a SPARQL JSON body; `Point(lon lat)` coordinates. */
export function parseWikidataSpots(json: unknown): Spot[] {
  const parsed = sparqlSchema.safeParse(json);
  if (!parsed.success) return [];
  const out: Spot[] = [];
  for (const b of parsed.data.results.bindings) {
    const m = /^Point\(\s*(-?[\d.]+(?:e-?\d+)?)\s+(-?[\d.]+(?:e-?\d+)?)\s*\)$/i.exec(b.coord.value.trim());
    if (!m) continue;
    const lon = Number(m[1]);
    const lat = Number(m[2]);
    const name = b.label.value.trim();
    if (name && Number.isFinite(lon) && Number.isFinite(lat)) out.push({ name, lat, lon, source: "Wikidata", rank: 0 });
  }
  return out;
}

/**
 * Up to `cap` distinct spots: best source first (Wikidata, OSM-tagged, name fallback), nearest the bbox centre within a
 * source, and a spot within a kilometre of one already kept is the same break. Returns the kept spots and how many
 * distinct spots there were before the cap.
 */
export function pickSpots(spots: Spot[], bbox: BBox, cap = SPOT_CAP): { spots: Spot[]; distinct: number } {
  const centre: [number, number] = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  const dist = (s: Spot) => haversineKm(centre, [s.lon, s.lat]);
  const ordered = spots.filter((s) => inBbox(s.lon, s.lat, bbox)).sort((a, b) => a.rank - b.rank || dist(a) - dist(b));
  const kept: Spot[] = [];
  for (const s of ordered) {
    if (kept.every((k) => haversineKm([k.lon, k.lat], [s.lon, s.lat]) >= SPOT_DEDUPE_KM)) kept.push(s);
  }
  return { spots: kept.slice(0, cap), distinct: kept.length };
}

/** [lat, lon] `km` away from the point on a compass bearing (small distances, flat-earth maths). */
export function offsetKm(lat: number, lon: number, bearingDeg: number, km: number): [number, number] {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (km * Math.cos(rad)) / 111.32;
  const dLon = (km * Math.sin(rad)) / (111.32 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  return [Number((lat + dLat).toFixed(5)), Number((lon + dLon).toFixed(5))];
}

const MarineSchema = z.object({
  hourly: z.object({
    time: z.array(z.string()),
    wave_height: z.array(z.number().nullable()),
    wave_period: z.array(z.number().nullable()).optional(),
    wave_direction: z.array(z.number().nullable()).optional(),
    swell_wave_height: z.array(z.number().nullable()).optional(),
    swell_wave_period: z.array(z.number().nullable()).optional(),
  }),
});

/** A modelled sea state now plus the biggest wave height in the forecast; no `name` or position (the spot owns those). */
export type Marine = Record<string, string | number>;

/**
 * One marine-API point's properties: `t`/`v` for the current hour, the largest wave height in the forecast and when it
 * comes. Null when the model has no wave height now (land, or a cell it does not cover).
 */
export function marineProps(raw: unknown, now: Date): Marine | null {
  const parsed = MarineSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { hourly } = parsed.data;
  const hourStart = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  const times = hourly.time.map((t) => Date.parse(`${t}:00Z`));
  let nowIdx = times.findIndex((t) => t >= hourStart);
  if (nowIdx < 0) nowIdx = times.length - 1;
  const height = hourly.wave_height[nowIdx];
  if (typeof height !== "number") return null;
  let maxIdx = nowIdx;
  for (let i = nowIdx; i < times.length; i++) {
    const h = hourly.wave_height[i];
    if (typeof h === "number" && h > (hourly.wave_height[maxIdx] ?? -1)) maxIdx = i;
  }
  const p: Marine = {
    t: new Date(times[nowIdx]).toISOString(),
    v: height,
    waveFt: ft(height),
    maxNext48hM: hourly.wave_height[maxIdx] ?? height,
    maxNext48hFt: ft(hourly.wave_height[maxIdx] ?? height),
    maxAt: new Date(times[maxIdx]).toISOString(),
  };
  const period = hourly.wave_period?.[nowIdx];
  if (typeof period === "number") p.periodS = period;
  const dir = hourly.wave_direction?.[nowIdx];
  if (typeof dir === "number") {
    p.directionDeg = dir;
    p.directionFrom = compass(dir);
    p.swellFrom = directionText(dir);
  }
  const swell = hourly.swell_wave_height?.[nowIdx];
  if (typeof swell === "number") {
    p.swellM = swell;
    p.swellFt = ft(swell);
  }
  const swellPeriod = hourly.swell_wave_period?.[nowIdx];
  if (typeof swellPeriod === "number") p.swellPeriodS = swellPeriod;
  return p;
}

/** The marine API's rows in request order: an array for several points, one object for a single point. */
export function marineRows(body: unknown): unknown[] {
  return Array.isArray(body) ? body : [body];
}

/** A forecast point for a surf spot, drawn at the spot; `nudgedKm` says the model value is from that far away. */
export function spotFeature(spot: Spot, marine: Marine, nudgedKm: number): Feature<Point> {
  const p: Record<string, string | number> = { name: spot.name, kind: "forecast", spotSource: spot.source, ...marine };
  const zone = zoneAt(spot.lon, spot.lat);
  if (typeof marine.t === "string") p.readAt = localTime(Date.parse(marine.t), zone);
  if (typeof marine.maxAt === "string") p.maxAtLocal = localTime(Date.parse(marine.maxAt), zone);
  if (nudgedKm > 0) p.nudgedKm = nudgedKm;
  return { type: "Feature", geometry: { type: "Point", coordinates: [spot.lon, spot.lat] }, properties: p };
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

/** A failed source as a SourceStatus: a timeout or no answer is offline, a 429 rate-limited, anything else a server error. */
export function statusFor(error: string, message: string): Extract<SourceStatus, { ok: false }> {
  const reason = / 429\b/.test(error) ? "rate-limited" : /timed out|no usable response|no response/i.test(error) ? "offline" : "server-error";
  return { ok: false, reason, message };
}

type SpotLookup = { spots: Spot[]; failures: string[] };

/** Surf spots in the bbox from OpenStreetMap and Wikidata; a source that fails is reported, not fatal. */
async function lookupSpots(ctx: QueryContext): Promise<SpotLookup> {
  const wikidata = async (): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> => {
    try {
      const res = await wikimediaFetch(ctx.fetch, SPARQL_ENDPOINT, {
        method: "POST",
        headers: { accept: "application/sparql-results+json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ query: surfSpotsSparql(ctx.bbox) }).toString(),
        cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:surf-wikidata`,
        ttlSeconds: SPOTS_TTL_SECONDS,
      });
      if (!res.ok) return { ok: false, error: `Wikidata returned ${res.status}` };
      return { ok: true, json: await res.json() };
    } catch {
      return { ok: false, error: "Wikidata returned no usable response" };
    }
  };
  const [osm, wd] = await Promise.all([overpassQuery(ctx, surfSpotsQuery(ctx.bbox), { cacheSuffix: "surf-spots" }), wikidata()]);
  const spots: Spot[] = [];
  const failures: string[] = [];
  if (osm.ok) spots.push(...parseOsmSpots(osm.json));
  else failures.push(osm.error);
  if (wd.ok) spots.push(...parseWikidataSpots(wd.json));
  else failures.push(wd.error);
  return { spots, failures };
}

type MarineBatch = { values: (Marine | null)[]; failed: boolean[]; error?: string };

/** The model's sea state at each [lat, lon], in order; `failed` marks points whose request did not answer (as opposed to land, which is null). */
async function marineBatch(ctx: QueryContext, points: [number, number][], keyPart: string, now: Date): Promise<MarineBatch> {
  const values: (Marine | null)[] = points.map(() => null);
  const failed: boolean[] = points.map(() => false);
  let error: string | undefined;
  const chunks: number[] = [];
  for (let i = 0; i < points.length; i += MARINE_CHUNK) chunks.push(i);
  await Promise.all(
    chunks.map(async (start, c) => {
      const part = points.slice(start, start + MARINE_CHUNK);
      const url =
        `${MARINE_API}?latitude=${part.map((p) => p[0]).join(",")}&longitude=${part.map((p) => p[1]).join(",")}` +
        `&hourly=wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period&forecast_days=2&timezone=GMT`;
      const res = await fetchText(
        ctx,
        url,
        "Open-Meteo Marine",
        ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:marine:${keyPart}:${c}`,
        FORECAST_TTL_SECONDS,
      );
      let rows: unknown[] | null = null;
      if (res.ok) {
        try {
          rows = marineRows(JSON.parse(res.text));
        } catch {
          rows = null;
        }
      } else {
        error = res.error;
      }
      if (rows === null) {
        error ??= "Open-Meteo Marine returned no usable response";
        part.forEach((_, i) => (failed[start + i] = true));
        return;
      }
      part.forEach((_, i) => (values[start + i] = marineProps(rows[i], now)));
    }),
  );
  return { values, failed, ...(error !== undefined && { error }) };
}

/**
 * Forecast points at the spots, drawn at each spot. A spot the model has no value for (it answers null on land) is tried
 * 1, 2 then 3 km away on four compass bearings, the first with a value standing in; with none it is dropped.
 */
export async function forecastAtSpots(
  ctx: QueryContext,
  spots: Spot[],
  now: Date,
): Promise<{ features: Feature<Point>[]; dropped: number; nudged: number; error?: string }> {
  const first = await marineBatch(ctx, spots.map((s) => [s.lat, s.lon]), "0", now);
  const values = [...first.values];
  const nudgedKm = spots.map(() => 0);
  const failed = first.failed;
  for (const [round, km] of NUDGE_STEPS_KM.entries()) {
    const pending = values.flatMap((v, i) => (v === null && !failed[i] ? [i] : []));
    if (pending.length === 0) break;
    const points = pending.flatMap((i) => NUDGE_BEARINGS.map((b) => offsetKm(spots[i].lat, spots[i].lon, b, km)));
    const res = await marineBatch(ctx, points, String(round + 1), now);
    pending.forEach((spotIndex, p) => {
      for (let b = 0; b < NUDGE_BEARINGS.length; b++) {
        const v = res.values[p * NUDGE_BEARINGS.length + b];
        if (v !== null) {
          values[spotIndex] = v;
          nudgedKm[spotIndex] = km;
          return;
        }
      }
    });
  }
  const features: Feature<Point>[] = [];
  let dropped = 0;
  values.forEach((v, i) => {
    if (v !== null) features.push(spotFeature(spots[i], v, nudgedKm[i]));
    else if (!failed[i]) dropped += 1;
  });
  return { features, dropped, nudged: nudgedKm.filter((k) => k > 0).length, ...(first.error !== undefined && { error: first.error }) };
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

/** Up to SEASON_BUOY_CAP stations in the bbox, nearest its centre first; `others` are the rest in view, in the same order. */
export function seasonStations(
  stations: BuoyStation[],
  bbox: BBox,
): { chosen: BuoyStation[]; inView: number; others: BuoyStation[] } {
  const centre: [number, number] = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  const inView = stations
    .filter((s) => inBbox(s.lon, s.lat, bbox))
    .sort((a, b) => haversineKm(centre, [a.lon, a.lat]) - haversineKm(centre, [b.lon, b.lat]));
  return { chosen: inView.slice(0, SEASON_BUOY_CAP), inView: inView.length, others: inView.slice(SEASON_BUOY_CAP) };
}

/** A wide seasonal result's point for a buoy that was not summarised: where it is, kind 'station', no v. */
export function buoySiteFeature(station: BuoyStation): Feature<Point> {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [station.lon, station.lat] },
    properties: {
      name: station.name,
      stationId: station.id,
      kind: "station",
      url: `https://www.ndbc.noaa.gov/station_page.php?station=${encodeURIComponent(station.id.toLowerCase())}`,
    },
  };
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
    waveFt: ft(m.meanM),
    p90M: m.p90M,
    p90Ft: ft(m.p90M),
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
    p.swellFrom = directionText(m.directionDeg);
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
  const { chosen, inView, others } = seasonStations(buoys, ctx.bbox);
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
  if (ctx.wide) {
    // Wide: the other wave buoys in view are listed without values (up to the limit), so the count is honest.
    const limit = ctx.wideStrategy?.limit ?? WIDE_LIMIT;
    features.push(...others.slice(0, Math.max(0, limit - features.length)).map(buoySiteFeature));
    if (inView > chosen.length) notes.push(`Only the ${chosen.length} wave buoys nearest the centre are summarised; the others are shown as stations without values`);
  } else if (inView > chosen.length) {
    notes.push(`Only the ${chosen.length} wave buoys nearest the centre of ${inView} in view are summarised; zoom in for others`);
  }
  if (noHistory > 0) notes.push(`${noHistory} buoy${noHistory === 1 ? "" : "s"} had no wave history for that month`);
  // Summarised buoys plus every other wave buoy in view: the count when the limit cut the list.
  const candidates = chosen.length - noHistory + others.length;
  const total = ctx.wide && features.length < candidates ? candidates : undefined;
  return {
    kind: "geojson",
    data: { type: "FeatureCollection", features },
    citation,
    coverageNote: notes.join("; "),
    ...(total !== undefined && { total }),
  };
}

const ATTRIBUTES: Attribute[] = [
  {
    key: "kind",
    type: "category",
    label: "Kind",
    primary: true,
    levels: [
      { value: "buoy", label: "Buoy", help: "Measured now at a NOAA wave buoy, usually miles offshore." },
      { value: "forecast", label: "Spot forecast", help: "Modelled waves now at a named surf spot (Open-Meteo Marine)." },
      { value: "climatology", label: "Typical month", help: "The month's average at a buoy over the last 3 years." },
      { value: "station", label: "Buoy, no summary" },
    ],
  },
  {
    key: "waveFt",
    type: "measure",
    label: "Wave height",
    unit: "ft",
    encode: "size",
    presets: [
      { label: "Small: under 3 ft", max: 3 },
      { label: "Fun: 3 to 6 ft", min: 3, max: 6 },
      { label: "Big: 6 to 10 ft", min: 6, max: 10 },
      { label: "Huge: 10 ft and up", min: 10 },
    ],
  },
  { key: "periodS", type: "measure", label: "Period", unit: "s" },
  timeAttribute("Reading"),
  nameAttribute(),
];

const NDBC_URL = "https://www.ndbc.noaa.gov/";

const HELP: Record<string, FieldHelp> = {
  v: {
    text:
      "Significant wave height: the average height of the highest third of the waves, the standard NOAA buoy measure (sets can be about twice it); " +
      "for forecast spots the model value now (modelled, not measured), for seasonal points the month's mean over the last 3 years.",
    unit: "m",
    source: "NOAA National Data Buoy Center; Open-Meteo Marine for forecasts",
    url: NDBC_URL,
  },
  waveFt: {
    text:
      "Significant wave height in feet: the average height of the highest third of the waves, the standard NOAA buoy measure (sets can be about twice it); " +
      "for spot forecasts the model value now (modelled, not measured), for typical-month points the month's mean over the last 3 years.",
    unit: "ft",
    source: "NOAA National Data Buoy Center; Open-Meteo Marine for forecasts",
    url: NDBC_URL,
  },
  swellFrom: { text: "The direction the dominant waves come from, in words and compass degrees (0 is north, 90 east, 180 south, 270 west)." },
  readAt: { text: "When the buoy measured these waves, or the forecast hour, in the local time of the spot." },
  wind: { text: "Wind at the buoy in knots and miles per hour, the direction it blows from, and the strongest gust.", source: "NOAA National Data Buoy Center", url: NDBC_URL },
  waterTempF: { text: "Sea surface temperature at the buoy.", unit: "°F" },
  swellFt: { text: "Height of the swell part of the modelled waves (not the local wind sea).", unit: "ft" },
  maxNext48hFt: { text: "The biggest modelled wave height in the next 48 hours.", unit: "ft" },
  p90Ft: { text: "The 90th percentile of wave height for the month at this buoy over the last 3 years: a big day.", unit: "ft" },
  periodS: {
    text: "Dominant wave period: seconds between the most energetic waves; longer means more powerful groundswell, under about 8 s is wind chop.",
    unit: "s",
    source: "NOAA National Data Buoy Center",
    url: NDBC_URL,
  },
  avgPeriodS: { text: "Average period of all the waves, in seconds.", unit: "s" },
  directionFrom: { text: "The compass direction the dominant waves come from." },
  p90M: { text: "The 90th percentile of wave height for the month at this buoy over the last 3 years: a big day.", unit: "m" },
  directionDeg: { text: "The direction the dominant waves come from, in compass degrees: 0 is north, 90 east, 180 south, 270 west." },
  swellM: { text: "Height of the swell part of the modelled waves (not the local wind sea).", unit: "m" },
  swellPeriodS: { text: "Period of the swell part of the modelled waves, in seconds.", unit: "s" },
  nudgedKm: { text: "Present when the model has no waves at the spot itself: the forecast was read this many kilometres out to sea.", unit: "km" },
  maxNext48hM: { text: "The biggest modelled wave height in the next 48 hours, at maxAt.", unit: "m" },
};

const CARD: CardSpec = {
  measure: { key: "waveFt", label: "Wave height", unit: "ft" },
  facts: [
    { key: "readAt", label: "Time" },
    { key: "periodS", label: "Period", unit: "s" },
    { key: "swellFrom", label: "Swell from" },
    { key: "v", label: "In metres", unit: "m", format: "1dp" },
    { key: "avgPeriodS", label: "Average period", unit: "s" },
    { key: "swellFt", label: "Swell part", unit: "ft" },
    { key: "swellPeriodS", label: "Swell period", unit: "s" },
    { key: "waterTempF", label: "Water temperature", unit: "°F" },
    { key: "wind", label: "Wind" },
    { key: "maxNext48hFt", label: "Biggest in 48 hours", unit: "ft" },
    { key: "maxAtLocal", label: "Biggest at" },
    { key: "nudgedKm", label: "Read out to sea", unit: "km", format: "1dp" },
    { key: "p90Ft", label: "Big day (90th percentile)", unit: "ft" },
    { key: "month", label: "Month" },
    { key: "years", label: "Years averaged" },
    { key: "samples", label: "Readings averaged", format: "int" },
    {
      key: "kind",
      label: "Reading",
      values: {
        buoy: "Measured at a NOAA buoy",
        forecast: "Modelled forecast (Open-Meteo Marine)",
        climatology: "Typical for the month",
        station: "Buoy, no summary",
      },
    },
    { key: "spotSource", label: "Surf spot listed in" },
  ],
  links: [{ key: "url", label: "NOAA buoy page" }],
  // Codes and repeats of rows the card already shows in feet, knots, °F and local time.
  hidden: [
    "stationId",
    "t",
    "directionDeg",
    "directionFrom",
    "waterTempC",
    "windMs",
    "gustMs",
    "windKt",
    "gustKt",
    "windFrom",
    "swellM",
    "maxNext48hM",
    "maxAt",
    "p90M",
    "monthlyMeanM",
    "monthlyP90M",
  ],
};

/** Wave height sets the symbol size; the legend says so in feet. */
const LEGEND: LegendSpec = {
  kind: "size",
  title: "Wave height",
  field: "waveFt",
  unit: "ft",
  stops: [
    { label: "Under 3 ft", value: 1 },
    { label: "3 to 6 ft", value: 4 },
    { label: "6 to 10 ft", value: 8 },
    { label: "10 ft and up", value: 12 },
  ],
  note: "Buoys are measured, usually miles offshore; spot forecasts are modelled at named breaks.",
};

const surf = defineLayer({
  id: "surf",
  title: "Surf and waves (NOAA buoys, live)",
  description:
    "Live ocean wave conditions for surf, swell and boating questions. User words: surf, swell, waves, wave height, period, how big is it, is it firing, water temperature, buoy. " +
    "Default: NOAA NDBC wave buoys in view, kind 'buoy', each with name, stationId, t (UTC time of the latest observation, usually under an hour old) and readAt (the same in local time, '6:50 pm PDT Sat'), waveFt (significant wave height in feet, which sizes the symbol; v is the same in metres), " +
    "periodS (dominant wave period in seconds; longer period means more powerful groundswell, under about 8 s is short-period wind chop), avgPeriodS, swellFrom ('West-northwest (292°)', where the waves come FROM; directionDeg and directionFrom are the same as numbers and a compass code), waterTempF (°F; waterTempC in °C), wind (text: knots, mph, direction, gusts; windKt and gustKt as numbers), and url (the buoy page). " +
    "Set forecast to true to add Open-Meteo Marine forecasts at up to 40 named surf spots in view (OpenStreetMap, Wikidata and a saved list), kind 'forecast': waveFt is the modelled height now, swellFt the swell part, maxNext48hFt and maxAtLocal the biggest in two days. " +
    "Set season to true (optionally month 1-12, default this month) for what is typical this time of year: kind 'climatology', the 6 buoys nearest the centre, waveFt the month's mean over the last 3 years, p90Ft a big day, monthlyMeanM and monthlyP90M the 12-month curves in metres (January first). " +
    "Forecasts are modelled at named surf spots, buoys are measured; buoys are always included and the forecast spots come on top; nudgedKm says a forecast was read 1 to 3 km out to sea. The model grid is about 9 km, so neighbouring spots can share values. Use it for a named break, where there is no buoy, or to say whether swell is building. " +
    "A cold seasonal query downloads several years of buoy files and can take 10 to 20 seconds. " +
    "Answer US questions in feet, knots or mph and local time. " +
    "Example questions: 'How big is the surf at Ocean Beach right now?', 'Where is the surf best on Oahu this time of year?'. " +
    "Caveats: buoys sit miles offshore, so breaking waves at a beach can be bigger or much smaller depending on exposure, bathymetry and tide; significant height is the average of the highest third of waves, and sets can be about twice that; " +
    "buoys that have not reported for 12 hours and stations without a wave sensor are left out; seasonal averages describe the buoy's exposure, so a north-facing and a south-facing buoy on the same island show which shore gets the swell in each season; the forecast is a coarse 9 km model, worst near shore and in bays, and shows open-water waves, not what breaks on the reef or sandbar, and is free for non-commercial use only. " +
    "Global (NDBC plus partner buoys, mostly US waters); over 500,000 km² up to 1,000 buoys, biggest waves first.",
  coverage: "global",
  surface: { key: "kind", by: { buoy: "water", station: "water", climatology: "water" }, default: "coast" },
  license: "Public domain (NOAA NDBC); forecast from Open-Meteo Marine, CC BY 4.0, free for non-commercial use only",
  requiredEnv: [],
  // The spot lookup goes through overpassQuery, which tries OVERPASS_URL first (the public server answers 406 to some hosts).
  optionalEnv: ["OVERPASS_URL"],
  maxAreaKm2: 500_000,
  // One global buoy file, at most 40 forecast spots and 6 seasonal buoys at most, so the cost does not grow with the box.
  hardMaxAreaKm2: WHOLE_US_KM2,
  wide: { orderBy: "wave height in metres", limit: WIDE_LIMIT },
  input: inputSchema,
  style: { geometry: "point", color: layerColor("surf"), unit: "m", timeField: "t", encode: { size: "waveFt" } },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  // One latest reading per buoy (or the forecast hour now, or a typical month): say when, no scrubber.
  time: { shape: "single" },
  legend: LEGEND,
  labels: { field: "name", max: 6, rankBy: "waveFt" },
  // NDBC is almost all US waters: feet, knots and mph first, times in the spot's local time.
  display: { units: "us", timeZone: "local" },

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

    let sourceStatus: SourceStatus | undefined;
    if (input.forecast) {
      const lookup = await lookupSpots(ctx);
      const { spots, distinct } = pickSpots([...lookup.spots, ...savedSpots(ctx.bbox)], ctx.bbox);
      const lookupFailed = lookup.failures.length > 0;
      if (spots.length === 0) {
        notes.push("No named surf spots in view");
        if (lookupFailed) {
          sourceStatus = statusFor(lookup.failures[0], "The surf spot lookup (OpenStreetMap and Wikidata) did not answer, and no saved spot is in view.");
          if (lookup.failures.length === 2 && features.length === 0) return { error: sourceStatus.message, hint: "upstream", sourceStatus };
        }
      } else {
        // The saved list answered for the live lookup: the spots are there, so the source is fine for this answer.
        if (lookupFailed) sourceStatus = { ok: true };
        const forecast = await forecastAtSpots(ctx, spots, now);
        if (forecast.features.length === 0 && forecast.error !== undefined) {
          sourceStatus = statusFor(forecast.error, "The Open-Meteo wave forecast did not answer, so only the buoys are shown.");
          if (features.length === 0) return { error: "The Open-Meteo wave forecast did not answer and no buoy is in view.", hint: "upstream", sourceStatus };
        } else {
          features.push(...forecast.features);
          notes.push(
            `${buoys.features.length} NOAA buoy${buoys.features.length === 1 ? "" : "s"} (measured) and ${forecast.features.length} surf spot${forecast.features.length === 1 ? "" : "s"} (modelled forecast)`,
          );
          if (forecast.nudged > 0) notes.push(`${forecast.nudged} spot${forecast.nudged === 1 ? "" : "s"} read from the model up to 3 km out to sea`);
          if (forecast.dropped > 0) notes.push(`${forecast.dropped} spot${forecast.dropped === 1 ? "" : "s"} left out: the model has no waves within 3 km`);
          if (distinct > spots.length) notes.push(`Showing ${spots.length} of ${distinct} surf spots in view (nearest the centre first); zoom in for the rest`);
          if (lookupFailed) notes.push("Surf spots come from the list saved with the app, because the live spot lookup did not answer");
        }
      }
    } else if (buoys.features.length === 0) {
      notes.push("No reporting NDBC wave buoys in this view; ask again with forecast true for modelled waves at named surf spots");
    }

    const kept = ctx.wide ? keepLargest(features, ctx.wideStrategy?.limit ?? WIDE_LIMIT) : { features, total: undefined };
    return {
      kind: "geojson",
      data: kept.features.length === 0 ? EMPTY : { type: "FeatureCollection", features: kept.features },
      citation,
      ...(kept.total !== undefined && { total: kept.total }),
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
      ...(sourceStatus !== undefined && { sourceStatus }),
    };
  },
});

registerLayer(surf);

export default surf;
