/**
 * Reservoir levels for the big western reservoirs: Bureau of Reclamation HydroData (Colorado River and Rio Grande
 * reservoirs) and California's CDEC (state and federal reservoirs). Both keyless.
 *
 * USBR HydroData, per-site files holding the whole daily record (verified live 2026-10-10):
 *   https://www.usbr.gov/uc/water/hydrodata/reservoir_data/{siteId}/json/{datatype}.json
 *   datatype 49 = pool elevation (ft), 17 = storage (acre-feet). Body: {"columns":["datetime","pool elevation"],
 *   "data":[["1963-12-28",3409.0],...]} oldest first, one row a day, newest 1 to 2 days old. The files are 0.5 to 0.9 MB
 *   for a full history, so the layer asks for just the tail with an HTTP Range request (the server answers 206) and
 *   reads rows with a pattern, which also works when a server ignores Range and sends everything.
 *   The service index is `reservoir_data/meta.csv` (site id, name, lat, longi; 94 sites with storage or elevation data, 764 rows); the folder itself is
 *   403. Coordinates below were copied from it on 2026-10-10. Its last_meas columns are empty, so values come from the files.
 *
 * CDEC JSONDataServlet (verified live 2026-10-10): GET https://cdec.water.ca.gov/dynamicapp/req/JSONDataServlet
 *   ?Stations=SHA,ORO&SensorNums=15&dur_code=D|M&Start=YYYY-MM-DD&End=YYYY-MM-DD, several stations in one call.
 *   Sensor 15 is reservoir storage (acre-feet). Rows: {stationId, SENSOR_NUM, date:"2026-10-1 00:00" (day not zero padded),
 *   value, units:"AF"}; -9999 means no reading yet (the newest day or two). dur_code M gives the end-of-month value
 *   (12 stations x 10 years = 247 KB in 1 s). Station coordinates are from each station's CDEC metadata page.
 *
 * Capacities: official figures, copied 2026-10-10 from the Reclamation Lower Colorado levels page (Mead 26,120,000, Mohave 1,873,648,
 * Havasu 570,253 acre-feet, "available capacity"; https://www.usbr.gov/lc/region/g4000/hourly/levels.html), Reclamation's Lake Powell
 * page (5.14 million acre-feet = 22 percent of live capacity, so about 23.3 million; 23,314,000 used,
 * https://www.usbr.gov/uc/water/crsp/cs/gcd.html) and the CDEC reservoir conditions table (every California reservoir,
 * https://cdec.water.ca.gov/reportapp/javareports?name=RES). Other Reclamation reservoirs have no capacity because no official
 * figure was found on those pages (their pages give only a percent of live capacity); `sizeAf` is a rounded size used only to pick
 * the largest when a view holds more than MAX_USBR_SITES. Reclamation storage is LIVE storage, so pctFull is percent of live capacity.
 *
 * Output: one point per reservoir. v = storage (acre-feet), the one measure every site has and the only one comparable
 * between reservoirs (elevations are not). Props: name, source, storageAf, elevationFt (USBR sites), capacityAf and pctFull
 * (when a nominal capacity is known), lastDate, t (ISO date of the reading), series ({t, v}[] monthly means for up to 10
 * years, yearly means for longer, at most 120 points), seriesUnit ("ft" when elevation is available, else "acre-feet").
 * Smoke check 2026-10-10 (live, through runLayer): Lake Powell elevation 3,519.03 ft and storage 5.208 million acre-feet
 * on 2026-10-08 (22% of live capacity, 23,314,000); Lake Mead 1,037.61 ft, 6.814 million on 2026-10-08; Hetch Hetchy 280,357 acre-feet
 * on 2026-10-08 (78% of 360,000); Shasta 2.406 million on 2026-10-09.
 * Wide (over 3,000,000 km², up to 12,000,000): the same fetch, which is already bounded by the site list and the 6 Reclamation
 * sites; when that cap cuts, the total is every covered reservoir in the box. Smoke 2026-10-14, box -125,30,-100,46 (the West,
 * 3,900,000 km²): 21 of 35 in 9.6 s (the time is the rate limit spacing 14 calls), Lake Mead 6.81 million acre-feet first.
 */
import { z } from "zod";
import type { Feature, Point } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext, type CardSpec, type Attribute, type FieldHelp } from "./types";
import { nameAttribute, timeAttribute } from "./_shared/bands";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { bboxesDisjoint } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

const USBR_BASE = "https://www.usbr.gov/uc/water/hydrodata/reservoir_data";
const CDEC_URL = "https://cdec.water.ca.gov/dynamicapp/req/JSONDataServlet";
const TTL_SECONDS = 6 * 3600;
const DAY_MS = 86_400_000;

/** Most USBR reservoirs fetched per request (two Range calls each); the biggest by capacity win. */
export const MAX_USBR_SITES = 6;
export const DEFAULT_YEARS = 5;
export const MAX_YEARS = 60;
/** Monthly means up to this many years (120 points), yearly means beyond. */
const MONTHLY_YEARS = 10;
/** Bytes of the file tail asked for per year of history (a row is about 23 bytes; this leaves slack). */
const BYTES_PER_YEAR = 9_500;
const READING_STALE_DAYS = 45;
/** Most points kept in a series. */
const MAX_SERIES_POINTS = 120;

export type Site = {
  id: string;
  name: string;
  source: "usbr" | "cdec";
  /** USBR HydroData site id, or CDEC station id. */
  code: string;
  coordinates: [number, number];
  /** Official capacity in acre-feet (see the header); absent when no official figure was checked. */
  capacityAf?: number;
  /** Rounded size in acre-feet, used only to rank sites when a view holds too many; never shown. */
  sizeAf?: number;
  river: string;
};

/** Reservoirs the layer knows. USBR ids and coordinates come from reservoir_data/meta.csv; CDEC ones from station metadata. */
export const SITES: Site[] = [
  { id: "usbr-919", name: "Lake Powell", source: "usbr", code: "919", coordinates: [-111.48396, 36.93649], capacityAf: 23_314_000, river: "Colorado River" },
  { id: "usbr-921", name: "Lake Mead", source: "usbr", code: "921", coordinates: [-114.7374, 36.0163], capacityAf: 26_120_000, river: "Colorado River" },
  { id: "usbr-922", name: "Lake Mohave", source: "usbr", code: "922", coordinates: [-114.5694, 35.1979], capacityAf: 1_873_648, river: "Colorado River" },
  { id: "usbr-923", name: "Lake Havasu", source: "usbr", code: "923", coordinates: [-114.1385, 34.2964], capacityAf: 570_253, river: "Colorado River" },
  { id: "usbr-917", name: "Flaming Gorge Reservoir", source: "usbr", code: "917", coordinates: [-109.42185, 40.91474], sizeAf: 3_750_000, river: "Green River" },
  { id: "usbr-916", name: "Fontenelle Reservoir", source: "usbr", code: "916", coordinates: [-110.06816, 42.02617], sizeAf: 345_000, river: "Green River" },
  { id: "usbr-913", name: "Blue Mesa Reservoir", source: "usbr", code: "913", coordinates: [-107.33677, 38.45305], sizeAf: 829_000, river: "Gunnison River" },
  { id: "usbr-914", name: "Morrow Point Reservoir", source: "usbr", code: "914", coordinates: [-107.53791, 38.45191], sizeAf: 117_000, river: "Gunnison River" },
  { id: "usbr-915", name: "Crystal Reservoir", source: "usbr", code: "915", coordinates: [-107.62374, 38.51046], sizeAf: 25_000, river: "Gunnison River" },
  { id: "usbr-920", name: "Navajo Reservoir", source: "usbr", code: "920", coordinates: [-107.61203, 36.80063], sizeAf: 1_696_000, river: "San Juan River" },
  { id: "usbr-958", name: "McPhee Reservoir", source: "usbr", code: "958", coordinates: [-108.57307, 37.57588], sizeAf: 381_000, river: "Dolores River" },
  { id: "usbr-964", name: "Jordanelle Reservoir", source: "usbr", code: "964", coordinates: [-111.42304, 40.59833], sizeAf: 320_000, river: "Provo River" },
  { id: "usbr-962", name: "Strawberry Reservoir", source: "usbr", code: "962", coordinates: [-111.02659, 40.13564], sizeAf: 1_106_000, river: "Strawberry River" },
  { id: "usbr-953", name: "Deer Creek Reservoir", source: "usbr", code: "953", coordinates: [-111.52908, 40.40837], river: "Provo River" },
  { id: "usbr-946", name: "Pineview Reservoir", source: "usbr", code: "946", coordinates: [-111.84254, 41.25419], river: "Ogden River" },
  { id: "usbr-928", name: "Starvation Reservoir", source: "usbr", code: "928", coordinates: [-110.44722, 40.19324], river: "Strawberry River" },
  { id: "usbr-1119", name: "Elephant Butte Reservoir", source: "usbr", code: "1119", coordinates: [-107.19189, 33.15408], sizeAf: 2_023_000, river: "Rio Grande" },
  { id: "usbr-1094", name: "Caballo Reservoir", source: "usbr", code: "1094", coordinates: [-107.29219, 32.89646], river: "Rio Grande" },
  { id: "usbr-2685", name: "El Vado Lake", source: "usbr", code: "2685", coordinates: [-106.7366, 36.5948], river: "Rio Chama" },
  { id: "usbr-2686", name: "Heron Reservoir", source: "usbr", code: "2686", coordinates: [-106.6992, 36.6973], river: "Rio Chama" },
  { id: "cdec-SHA", name: "Shasta Lake", source: "cdec", code: "SHA", coordinates: [-122.42, 40.718], capacityAf: 4_552_000, river: "Sacramento River" },
  { id: "cdec-ORO", name: "Lake Oroville", source: "cdec", code: "ORO", coordinates: [-121.493, 39.54], capacityAf: 3_424_753, river: "Feather River" },
  { id: "cdec-CLE", name: "Trinity Lake", source: "cdec", code: "CLE", coordinates: [-122.762, 40.801], capacityAf: 2_448_000, river: "Trinity River" },
  { id: "cdec-NML", name: "New Melones Lake", source: "cdec", code: "NML", coordinates: [-120.525, 37.9481], capacityAf: 2_400_000, river: "Stanislaus River" },
  { id: "cdec-SNL", name: "San Luis Reservoir", source: "cdec", code: "SNL", coordinates: [-121.133, 37.033], capacityAf: 2_041_000, river: "San Luis Creek" },
  { id: "cdec-DNP", name: "Don Pedro Reservoir", source: "cdec", code: "DNP", coordinates: [-120.421, 37.702], capacityAf: 2_030_000, river: "Tuolumne River" },
  { id: "cdec-BER", name: "Lake Berryessa", source: "cdec", code: "BER", coordinates: [-122.104, 38.513], capacityAf: 1_602_000, river: "Putah Creek" },
  { id: "cdec-EXC", name: "Lake McClure (New Exchequer)", source: "cdec", code: "EXC", coordinates: [-120.27, 37.585], capacityAf: 1_024_600, river: "Merced River" },
  { id: "cdec-FOL", name: "Folsom Lake", source: "cdec", code: "FOL", coordinates: [-121.183, 38.683], capacityAf: 977_000, river: "American River" },
  { id: "cdec-ISB", name: "Lake Isabella", source: "cdec", code: "ISB", coordinates: [-118.473, 35.646], capacityAf: 568_000, river: "Kern River" },
  { id: "cdec-MIL", name: "Millerton Lake", source: "cdec", code: "MIL", coordinates: [-119.705, 37.001], capacityAf: 520_500, river: "San Joaquin River" },
  { id: "cdec-CMN", name: "Camanche Reservoir", source: "cdec", code: "CMN", coordinates: [-121.021, 38.225], capacityAf: 417_120, river: "Mokelumne River" },
  { id: "cdec-HTH", name: "Hetch Hetchy Reservoir", source: "cdec", code: "HTH", coordinates: [-119.783, 37.95], capacityAf: 360_000, river: "Tuolumne River" },
  { id: "cdec-PNF", name: "Pine Flat Lake", source: "cdec", code: "PNF", coordinates: [-119.325, 36.833], capacityAf: 1_000_000, river: "Kings River" },
  { id: "cdec-CAS", name: "Castaic Lake", source: "cdec", code: "CAS", coordinates: [-118.6101, 34.5152], capacityAf: 325_000, river: "Castaic Creek" },
];

/** The area the sites span with a margin, for a quick "nothing here" answer. */
const SITES_EXTENT: BBox = [-123.5, 32, -104, 43.5];

export type Reading = { date: string; value: number };
export type SeriesPoint = { t: string; v: number };

/** Daily rows `["2026-10-08",3519.03]` found anywhere in text (a whole file or just its tail); null values are skipped. */
export function parseUsbrRows(text: string): Reading[] {
  const rows: Reading[] = [];
  for (const m of text.matchAll(/\["(\d{4}-\d{2}-\d{2})",\s*(-?\d+(?:\.\d+)?)\]/g)) {
    const value = Number(m[2]);
    if (Number.isFinite(value)) rows.push({ date: m[1], value });
  }
  return rows;
}

/** "2026-10-1 00:00" -> "2026-10-01". */
export function cdecDate(raw: string): string | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
}

const cdecRowSchema = z.object({ stationId: z.string(), date: z.string(), value: z.number().nullable() });

/** CDEC rows with a real reading (-9999 and nulls dropped), grouped by station, oldest first. */
export function parseCdec(json: unknown): Map<string, Reading[]> | null {
  if (!Array.isArray(json)) return null;
  const out = new Map<string, Reading[]>();
  for (const raw of json) {
    const parsed = cdecRowSchema.safeParse(raw);
    if (!parsed.success || parsed.data.value === null || parsed.data.value < 0) continue;
    const date = cdecDate(parsed.data.date);
    if (date === null) continue;
    const list = out.get(parsed.data.stationId) ?? [];
    list.push({ date, value: parsed.data.value });
    out.set(parsed.data.stationId, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/**
 * Monthly means ("YYYY-MM") for spans up to MONTHLY_YEARS years, yearly means ("YYYY") beyond, from `since` (a YYYY-MM-DD
 * date) on, oldest first. The newest period is a partial mean of what has been read so far.
 */
export function buildSeries(rows: Reading[], since: string, years: number, places: number): SeriesPoint[] {
  const monthly = years <= MONTHLY_YEARS;
  const sums = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    if (r.date < since) continue;
    const key = monthly ? r.date.slice(0, 7) : r.date.slice(0, 4);
    const cell = sums.get(key) ?? { sum: 0, n: 0 };
    cell.sum += r.value;
    cell.n += 1;
    sums.set(key, cell);
  }
  return [...sums.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, { sum, n }]) => ({ t, v: round(sum / n, places) }))
    .slice(-MAX_SERIES_POINTS);
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

type Fetched = { rows: Reading[] } | { error: string };

async function fetchText(ctx: QueryContext, url: string, suffix: string, headers?: Record<string, string>): Promise<string | null> {
  const res = await ctx.fetch(url, {
    cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:${suffix}`,
    ttlSeconds: TTL_SECONDS,
    timeoutMs: UPSTREAM_TIMEOUT_MS,
    ...(headers ? { headers } : {}),
  });
  // 206 is the Range answer; ctx.fetch hands back whatever status the server used.
  if (!res.ok) return null;
  return res.text();
}

async function usbrRows(ctx: QueryContext, siteCode: string, datatype: 49 | 17, years: number): Promise<Fetched> {
  const url = `${USBR_BASE}/${siteCode}/json/${datatype}.json`;
  try {
    const text = await fetchText(ctx, url, `usbr:${siteCode}:${datatype}:${years}`, {
      range: `bytes=-${Math.min(years * BYTES_PER_YEAR + 4_000, 900_000)}`,
    });
    if (text === null) return { error: `no ${datatype === 49 ? "elevation" : "storage"} file` };
    return { rows: parseUsbrRows(text) };
  } catch {
    return { error: "no response" };
  }
}

type SiteReading = {
  storage: Reading | null;
  elevation: Reading | null;
  series: SeriesPoint[];
  seriesUnit: "ft" | "acre-feet";
};

async function readUsbr(ctx: QueryContext, site: Site, years: number, since: string): Promise<SiteReading | null> {
  const [elevation, storage] = await Promise.all([usbrRows(ctx, site.code, 49, years), usbrRows(ctx, site.code, 17, years)]);
  const elevationRows = "rows" in elevation ? elevation.rows : [];
  const storageRows = "rows" in storage ? storage.rows : [];
  if (elevationRows.length === 0 && storageRows.length === 0) return null;
  const useElevation = elevationRows.length > 0;
  return {
    storage: storageRows.at(-1) ?? null,
    elevation: elevationRows.at(-1) ?? null,
    series: useElevation ? buildSeries(elevationRows, since, years, 2) : buildSeries(storageRows, since, years, 0),
    seriesUnit: useElevation ? "ft" : "acre-feet",
  };
}

async function readCdec(ctx: QueryContext, sites: Site[], years: number, now: number): Promise<Map<string, SiteReading>> {
  const out = new Map<string, SiteReading>();
  if (sites.length === 0) return out;
  const stations = sites.map((s) => s.code).join(",");
  const base = `${CDEC_URL}?Stations=${stations}&SensorNums=15`;
  const dailyUrl = `${base}&dur_code=D&Start=${isoDay(now - 12 * DAY_MS)}&End=${isoDay(now)}`;
  const monthlyUrl = `${base}&dur_code=M&Start=${isoDay(now - years * 365.25 * DAY_MS).slice(0, 7)}-01&End=${isoDay(now)}`;
  const [dailyText, monthlyText] = await Promise.all([
    fetchText(ctx, dailyUrl, `cdec:d:${stations}`).catch(() => null),
    fetchText(ctx, monthlyUrl, `cdec:m:${stations}:${years}`).catch(() => null),
  ]);
  const parse = (text: string | null) => {
    if (text === null) return null;
    try {
      return parseCdec(JSON.parse(text));
    } catch {
      return null;
    }
  };
  const daily = parse(dailyText);
  const monthly = parse(monthlyText);
  const since = isoDay(now - years * 365.25 * DAY_MS);
  for (const site of sites) {
    const dailyRows = daily?.get(site.code) ?? [];
    const monthlyRows = monthly?.get(site.code) ?? [];
    const newest = dailyRows.at(-1) ?? monthlyRows.at(-1) ?? null;
    if (newest === null) continue;
    out.set(site.id, {
      storage: newest,
      elevation: null,
      series: buildSeries(monthlyRows, since, years, 0),
      seriesUnit: "acre-feet",
    });
  }
  return out;
}

function toFeature(site: Site, reading: SiteReading): Feature<Point> | null {
  const storage = reading.storage;
  if (storage === null) return null;
  const properties: Record<string, string | number | { t: string; v: number }[] | null> = {
    name: site.name,
    river: site.river,
    source: site.source === "usbr" ? "Bureau of Reclamation" : "California DWR (CDEC)",
    v: Math.round(storage.value),
    storageAf: Math.round(storage.value),
    lastDate: storage.date,
    t: `${storage.date}T00:00:00.000Z`,
  };
  if (reading.elevation !== null) properties.elevationFt = round(reading.elevation.value, 2);
  if (site.capacityAf !== undefined) {
    properties.capacityAf = site.capacityAf;
    properties.pctFull = Math.round((storage.value / site.capacityAf) * 100);
  }
  if (reading.series.length > 0) {
    properties.series = reading.series;
    properties.seriesUnit = reading.seriesUnit;
  }
  return { type: "Feature", geometry: { type: "Point", coordinates: site.coordinates }, properties };
}

function inBbox([lon, lat]: [number, number], [w, s, e, n]: BBox): boolean {
  return lon >= w && lon <= e && lat >= s && lat <= n;
}

const ATTRIBUTES: Attribute[] = [
  { key: "pctFull", type: "measure", label: "Percent full", unit: "%", encode: "size" },
  { key: "storageAf", type: "measure", label: "Storage", unit: "acre-feet" },
  timeAttribute("Reading"),
  nameAttribute(),
];

const STORAGE: FieldHelp = {
  text: "Water held in the reservoir on the reading date; for Reclamation sites live storage (the water above the lowest outlet). Provisional data.",
  unit: "acre-feet",
  source: "US Bureau of Reclamation; California DWR (CDEC)",
  url: "https://cdec.water.ca.gov/reportapp/javareports?name=RES",
};

const HELP: Record<string, FieldHelp> = {
  storageAf: STORAGE,
  v: STORAGE,
  pctFull: {
    text:
      "Storage as a percent of the reservoir's official capacity (live capacity for Reclamation sites), computed by this app; only where a " +
      "capacity is known.",
    unit: "%",
  },
  capacityAf: { text: "The official capacity used for percent full, from Reclamation's and CDEC's published figures.", unit: "acre-feet" },
  elevationFt: {
    text: "Water surface elevation above sea level, the level quoted for Lake Powell and Lake Mead (Reclamation sites only).",
    unit: "ft",
  },
  series: { text: "Past readings: monthly means for up to 10 years, yearly means beyond; in feet when seriesUnit is ft, else acre-feet." },
};

const CARD: CardSpec = {
  measure: { key: "storageAf", label: "Storage", unit: "acre-feet" },
  facts: [
    { key: "pctFull", label: "Percent full", unit: "%" },
    { key: "capacityAf", label: "Capacity", unit: "acre-feet", format: "int" },
    { key: "elevationFt", label: "Water level", unit: "ft" },
    { key: "lastDate", label: "Reading", format: "date" },
    { key: "river", label: "River" },
    { key: "source", label: "Source" },
  ],
};

const reservoirLevels = defineLayer({
  id: "reservoir-levels",
  title: "Reservoir levels",
  description:
    "Water level and storage of about 35 major western reservoirs (Lake Powell, Lake Mead, Flaming Gorge, Shasta, Oroville, Hetch Hetchy and more) from the Bureau of Reclamation and California's CDEC; provisional data. Each point has v and storageAf (live storage in acre-feet), elevationFt (the level quoted for Powell and Mead; Reclamation sites only), pctFull (percent of official live capacity, where known), lastDate and t (usually 1 to 2 days old), and series ({t, v} points: monthly means for up to 10 years, yearly beyond; feet when seriesUnit is 'ft'). years (1 to 60, default 5) sets the series span; name picks one reservoir. Small lakes are missing and at most 6 Reclamation sites return per view, even over 3,000,000 km².",
  coverage: { bbox: [-123.5, 32, -104, 43.5] },
  surface: "land",
  license: "Public domain (US Bureau of Reclamation, California DWR); provisional data",
  requiredEnv: [],
  maxAreaKm2: 3_000_000,
  wide: { orderBy: "storage in acre-feet", limit: 1_000 },
  input: z.object({
    years: z
      .number()
      .int()
      .min(1)
      .max(MAX_YEARS)
      .default(DEFAULT_YEARS)
      .describe("Years of history in each reservoir's series (1 to 60, default 5)."),
    name: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .optional()
      .describe("Only reservoirs whose name contains this text, case-insensitive (for example 'powell')."),
  }),
  style: { geometry: "point", color: layerColor("reservoir-levels"), unit: "acre-feet", extrude: "v" },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const citation = {
      source: "US Bureau of Reclamation HydroData and California Data Exchange Center (CDEC); provisional data",
      url: "https://www.usbr.gov/uc/water/hydrodata/",
      retrieved: new Date().toISOString(),
    };
    if (bboxesDisjoint(ctx.bbox, SITES_EXTENT)) {
      return {
        kind: "geojson",
        data: { type: "FeatureCollection", features: [] },
        citation,
        coverageNote: "Reservoir levels cover the western United States only (Colorado River basin, Utah, Wyoming, New Mexico, California)",
      };
    }

    const needle = input.name?.toLowerCase();
    const inView = SITES.filter((s) => inBbox(s.coordinates, ctx.bbox) && (!needle || s.name.toLowerCase().includes(needle)));
    const usbrAll = inView.filter((s) => s.source === "usbr").sort((a, b) => (b.capacityAf ?? b.sizeAf ?? 0) - (a.capacityAf ?? a.sizeAf ?? 0));
    // A wide box (over 3,000,000 km²) is answered the same way: the site list is short, but every Reclamation site costs two
    // calls through the layer's rate limit (5 at once, then 1 a second), and all 20 took 38 s on 2026-10-14.
    const usbr = usbrAll.slice(0, MAX_USBR_SITES);
    const cdec = inView.filter((s) => s.source === "cdec");
    const notes: string[] = [];
    if (usbrAll.length > usbr.length) {
      // In a wide view run.ts states the count ("the 21 largest of 35"); this note then only says why and how to get the rest.
      notes.push(
        ctx.wide
          ? `At most ${MAX_USBR_SITES} Reclamation reservoirs (the largest) per request; set name for the others`
          : `Showing the ${MAX_USBR_SITES} largest of ${usbrAll.length} Reclamation reservoirs in view; zoom in or set name for the rest`,
      );
    }
    const total = ctx.wide && usbrAll.length > usbr.length ? inView.length : undefined;
    if (inView.length === 0) {
      notes.push(
        needle
          ? `No reservoir named like '${input.name}' in view; only major western reservoirs are covered`
          : "No major reservoir in this view; only about 35 major western reservoirs are covered",
      );
      return { kind: "geojson", data: { type: "FeatureCollection", features: [] }, citation, coverageNote: notes.join("; ") };
    }

    const now = Date.now();
    const years = input.years;
    const since = isoDay(now - years * 365.25 * DAY_MS);
    const [usbrReadings, cdecReadings] = await Promise.all([
      Promise.all(usbr.map((s) => readUsbr(ctx, s, years, since).catch(() => null))),
      readCdec(ctx, cdec, years, now),
    ]);

    const features: Feature<Point>[] = [];
    const failed: string[] = [];
    usbr.forEach((site, i) => {
      const reading = usbrReadings[i];
      const feature = reading === null ? null : toFeature(site, reading);
      if (feature) features.push(feature);
      else failed.push(site.name);
    });
    for (const site of cdec) {
      const reading = cdecReadings.get(site.id);
      const feature = reading === undefined ? null : toFeature(site, reading);
      if (feature) features.push(feature);
      else failed.push(site.name);
    }
    if (features.length === 0) {
      return { error: "Reservoir data services returned no readings; try again shortly", hint: "upstream" };
    }
    if (failed.length > 0) notes.push(`No reading from ${failed.join(", ")}`);

    const stale = features.filter((f) => {
      const date = f.properties?.lastDate;
      return typeof date === "string" && now - Date.parse(date) > READING_STALE_DAYS * DAY_MS;
    });
    if (stale.length > 0) notes.push(`${stale.length} reservoir(s) have a newest reading older than ${READING_STALE_DAYS} days`);
    notes.push("Provisional data; pctFull is percent of official capacity (live capacity for Reclamation)");

    features.sort((a, b) => Number(b.properties?.v ?? 0) - Number(a.properties?.v ?? 0));
    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      ...(total !== undefined && { total }),
      coverageNote: notes.join("; "),
    };
  },
});

registerLayer(reservoirLevels);

export default reservoirLevels;
