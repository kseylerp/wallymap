/**
 * Climate normals: what a place is usually like each month (spec T10 "Monthly temperature and precipitation normals"),
 * one point with twelve monthly values per variable, the deciding facts in words, and the monthly strip under the map.
 *
 * Primary, United States: NOAA NCEI U.S. Climate Normals 1991–2020, monthly, by station (public domain), keyless:
 *   - Stations near the place: https://www.ncei.noaa.gov/access/services/search/v1/data?dataset=normals-monthly-1991-2020
 *     &bbox=N,W,S,E&dataTypes=MLY-TMAX-NORMAL&limit=100 (bbox order north, west, south, east). JSON `results[]`, each
 *     with `stations[0].{id,name}` ("USC00048758", "TAHOE CITY, CA US"), `boundingPoints[0].coordinates` [lon, lat]
 *     and `stations[0].dataTypes[].id` (the station's normals: 104 at Tahoe City, 58 at Tahoma, which has no snowfall).
 *     The dataTypes filter keeps stations with temperature normals (precipitation-only SNOTEL sites drop out).
 *   - The normals: https://www.ncei.noaa.gov/access/services/data/v1?dataset=normals-monthly-1991-2020&stations=ID
 *     &format=json&dataTypes=MLY-TMAX-NORMAL,MLY-TMIN-NORMAL,MLY-PRCP-NORMAL,MLY-SNOW-NORMAL,MLY-SNWD-AVGNDS-GE001WI
 *     &includeStationName=true&includeStationLocation=1: twelve rows, DATE "01".."12", values as padded strings
 *     ("    78.0"), °F and inches; MLY-SNWD-AVGNDS-GE001WI is the average number of days with at least 1 inch of snow on
 *     the ground; ELEVATION in metres. -7777 is a trace (counted as 0), -9999 and -8888 are missing.
 *   - Verified live 2026-10-23: Tahoe City (USC00048758, 1,899 m) July 78.0 / 46.0 °F, January 39.6 / 20.6 °F and
 *     6.21 in, snowfall 9.4 in in November and 36.2 in in December, snow on the ground 27 days in January.
 * Fallback, anywhere (no station with temperature normals within MAX_STATION_KM, outside the US, or NCEI down):
 * TerraClimate 1991–2020 on Earth Engine (lib/ee/terraclimate.ts), about 4 km, with snow water at the end of each
 * month instead of snowfall.
 */
import { z } from "zod";
import type { Feature } from "geojson";
import { defineLayer, type CardSpec, type Citation, type FieldHelp, type LayerError, type LayerResult, type MonthlyRow, type MonthlyStrip, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { US_EXTENT } from "./_shared/coverage";
import { amountText, DAYS_IN_MONTH, highestMonth, lowestMonth, MONTH_NAMES, MONTH_SHORT, seasonSpan } from "./_shared/months";
import { titleCase } from "./_shared/names";
import { createEeClient, eeConfigured, EeError } from "@/lib/ee/client";
import { normalsExpression, NORMALS_FROM, NORMALS_TO, readNormals, type TerraNormals } from "@/lib/ee/terraclimate";
import { layerColor } from "@/lib/render/palette";

const SEARCH_URL = "https://www.ncei.noaa.gov/access/services/search/v1/data";
const DATA_URL = "https://www.ncei.noaa.gov/access/services/data/v1";
const DATASET = "normals-monthly-1991-2020";
const NORMALS_PAGE = "https://www.ncei.noaa.gov/products/land-based-station/us-climate-normals";
const TERRACLIMATE_PAGE = "https://www.climatologylab.org/terraclimate.html";
export const DATA_TYPES = ["MLY-TMAX-NORMAL", "MLY-TMIN-NORMAL", "MLY-PRCP-NORMAL", "MLY-SNOW-NORMAL", "MLY-SNWD-AVGNDS-GE001WI"];
/** The normals never change (the next set is 2001–2030): a month of cache. */
const TTL_SECONDS = 30 * 86_400;
/** A station farther than this from the place does not stand for it; TerraClimate answers instead. */
export const MAX_STATION_KM = 40;
/** A month with at least this much snowfall (inches) is in the snow season. */
export const SNOWFALL_SEASON_IN = 3;
/** A month with snow on the ground at least this share of its days is in the snow season. */
export const GROUND_SEASON_SHARE = 1 / 3;
/** TerraClimate: snow water at the month's end of at least this much (mm) is snow on the ground. */
export const SWE_SEASON_MM = 10;
const PERIOD = `${NORMALS_FROM}–${NORMALS_TO}`;

const inputSchema = z.object({
  lon: z.number().min(-180).max(180).optional(),
  lat: z.number().min(-90).max(90).optional(),
  name: z.string().trim().min(1).max(80).optional(),
});

type Months = (number | null)[];

/** Monthly normals in US units (°F, inches), from a station or the grid. */
export type Normals = {
  highF: Months;
  lowF: Months;
  precipIn: Months;
  /** Station only: normal monthly snowfall, inches. */
  snowIn?: Months;
  /** Station only: average days with at least 1 inch of snow on the ground. */
  snowDays?: Months;
  /** Grid only: snow water on the ground at the month's end, inches. */
  sweIn?: Months;
};

export type Station = { id: string; name: string; lon: number; lat: number; distanceKm: number; hasSnow: boolean; elevationM?: number };

// ---- NOAA station normals ----

const SearchSchema = z.object({
  results: z.array(
    z.object({
      boundingPoints: z.array(z.object({ coordinates: z.tuple([z.number(), z.number()]) })).min(1),
      stations: z.array(z.object({ id: z.string(), name: z.string(), dataTypes: z.array(z.object({ id: z.string() })).optional() })).min(1),
    }),
  ),
});

export function kmBetween(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "TAHOE CITY, CA US" → "Tahoe City, CA". */
export function stationName(raw: string): string {
  const spell = (name: string) =>
    titleCase(
      name
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\bRGNL\b/g, "REGIONAL")
        .replace(/\bINTL\b/g, "INTERNATIONAL")
        .replace(/\bAP\b/g, "AIRPORT")
        .replace(/\bMTN\b/g, "MOUNTAIN")
        .replace(/\bNP\b/g, "NATIONAL PARK"),
    );
  const m = /^(.*?),\s*([A-Z]{2})\s+US\s*$/.exec(raw.trim());
  if (m) return `${spell(m[1])}, ${m[2]}`;
  return spell(raw.replace(/\s+US\s*$/, ""));
}

/**
 * The station that stands for the place: the nearest with temperature normals, unless it keeps no snow normals and one
 * that does is nearly as near (within 1.6 times the distance or 10 km more), since snow is half the question in winter
 * country. Null when none is within MAX_STATION_KM.
 */
export function pickStation(body: unknown, at: [number, number]): Station | null {
  const parsed = SearchSchema.safeParse(body);
  if (!parsed.success) return null;
  const stations = parsed.data.results
    .map((r) => {
      const s = r.stations[0];
      const [lon, lat] = r.boundingPoints[0].coordinates;
      const types = new Set((s.dataTypes ?? []).map((d) => d.id));
      return { id: s.id, name: stationName(s.name), lon, lat, distanceKm: kmBetween(at, [lon, lat]), hasSnow: types.has("MLY-SNOW-NORMAL") || types.has("MLY-SNWD-AVGNDS-GE001WI") };
    })
    .filter((s) => s.distanceKm <= MAX_STATION_KM)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  const nearest = stations[0];
  if (!nearest) return null;
  if (nearest.hasSnow) return nearest;
  const snowy = stations.find((s) => s.hasSnow && s.distanceKm <= Math.max(nearest.distanceKm * 1.6, nearest.distanceKm + 10));
  return snowy ?? nearest;
}

/** A normals value: a trace (-7777) is 0, other flagged values (-9999, -8888) and blanks are missing. */
function normalValue(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const v = Number(String(raw).trim());
  if (String(raw).trim() === "" || !Number.isFinite(v)) return null;
  if (v === -7777) return 0;
  if (v <= -6666) return null;
  return v;
}

/** Twelve rows (DATE "01".."12") into the station's normals and elevation; null when it has no temperatures. */
export function readStationNormals(body: unknown): { normals: Normals; elevationM?: number } | null {
  if (!Array.isArray(body)) return null;
  const byMonth = (key: string): Months => {
    const out: Months = Array.from({ length: 12 }, () => null);
    for (const row of body as Record<string, unknown>[]) {
      const m = Number(row?.DATE);
      if (Number.isInteger(m) && m >= 1 && m <= 12) out[m - 1] = normalValue(row[key]);
    }
    return out;
  };
  const highF = byMonth("MLY-TMAX-NORMAL");
  if (highF.every((v) => v === null)) return null;
  const snowIn = byMonth("MLY-SNOW-NORMAL");
  const snowDays = byMonth("MLY-SNWD-AVGNDS-GE001WI");
  const elevation = Number((body as Record<string, unknown>[])[0]?.ELEVATION);
  return {
    normals: {
      highF,
      lowF: byMonth("MLY-TMIN-NORMAL"),
      precipIn: byMonth("MLY-PRCP-NORMAL"),
      ...(snowIn.some((v) => v !== null) && { snowIn }),
      ...(snowDays.some((v) => v !== null) && { snowDays }),
    },
    ...(Number.isFinite(elevation) && { elevationM: elevation }),
  };
}

// ---- TerraClimate (grid) ----

const cToF = (c: number | null) => (c === null ? null : c * 1.8 + 32);
const mmToIn = (mm: number | null) => (mm === null ? null : mm / 25.4);

export function gridNormals(t: TerraNormals): Normals {
  return { highF: t.highC.map(cToF), lowF: t.lowC.map(cToF), precipIn: t.precipMm.map(mmToIn), sweIn: t.sweMm.map(mmToIn) };
}

// ---- The facts in words ----

const fToC = (f: number) => ((f - 32) * 5) / 9;
const round1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

/** A temperature as the place reads it: °F (US), or °C with °F after. */
function deg(f: number, us: boolean): string {
  return us ? `${Math.round(f)} °F` : `${Math.round(fToC(f))} °C (${Math.round(f)} °F)`;
}

/** An amount of water as the place reads it: inches (US), or mm with inches after. */
function water(inches: number, us: boolean): string {
  return us ? `${amountText(inches)} in` : `${Math.round(inches * 25.4).toLocaleString("en-US")} mm (${amountText(inches)} in)`;
}

const sum = (xs: Months) => (xs.some((v) => v !== null) ? xs.reduce<number>((s, v) => s + (v ?? 0), 0) : null);

export type SnowSeason = { arrives?: number; goneBy?: number; allYear?: boolean; sentence?: string };

/**
 * When snow usually comes and goes. A station: the first month (from August) with SNOWFALL_SEASON_IN of snowfall or
 * snow on the ground a third of its days, and gone by the month after the last such month. The grid: snow water at
 * the month's end of SWE_SEASON_MM or more.
 */
export function snowSeason(n: Normals, us: boolean): SnowSeason {
  const groundShare = n.snowDays?.map((d, m) => (d === null ? null : d / DAYS_IN_MONTH[m]));
  const byFall = n.snowIn ? seasonSpan(n.snowIn, SNOWFALL_SEASON_IN) : undefined;
  const byGround = groundShare ? seasonSpan(groundShare, GROUND_SEASON_SHARE) : undefined;
  const bySwe = n.sweIn ? seasonSpan(n.sweIn, SWE_SEASON_MM / 25.4) : undefined;
  // Where the station counts snow on the ground and it never lies a third of a month, snowfall alone is no season.
  const fall = groundShare && !byGround ? undefined : byFall;
  const spans = [fall, byGround, bySwe].filter((s): s is NonNullable<typeof s> => s !== undefined);
  const order = (m: number) => (m - 7 + 12) % 12;
  if (spans.length === 0) {
    const snowiest = n.snowIn ? highestMonth(n.snowIn) : undefined;
    if (snowiest && snowiest.value >= 0.1) {
      const year = sum(n.snowIn ?? []);
      const yearly = year !== null && year >= 1 ? `about ${water(year, us)} a year, ` : "";
      return { sentence: `Snow is occasional here: ${yearly}most in ${MONTH_NAMES[snowiest.month]} (${water(snowiest.value, us)}), and it seldom stays on the ground` };
    }
    if (n.snowIn || n.snowDays || n.sweIn) return { sentence: "Snow is rare here" };
    return {};
  }
  if (spans.some((s) => s.allYear)) return { allYear: true, sentence: "Snow lies on the ground all year" };
  const arrives = spans.map((s) => s.arrives).sort((a, b) => order(a) - order(b))[0];
  const goneBy = spans.map((s) => s.goneBy).sort((a, b) => order(b) - order(a))[0];
  const what = n.sweIn ? "Snow usually lies on the ground from" : "Snow usually arrives in";
  return { arrives, goneBy, sentence: `${what} ${MONTH_NAMES[arrives]} and is gone by ${MONTH_NAMES[goneBy]}` };
}

/** The facts the card, the note and the strip share. */
export function normalsFacts(n: Normals, us: boolean) {
  const warm = highestMonth(n.highF);
  const cold = lowestMonth(n.highF);
  const wet = highestMonth(n.precipIn);
  const dry = lowestMonth(n.precipIn);
  const pair = (m: number) => `${deg(n.highF[m] ?? NaN, us)} by day and ${deg(n.lowF[m] ?? NaN, us)} at night`;
  return {
    warm,
    cold,
    wet,
    dry,
    warmest: warm ? `${MONTH_NAMES[warm.month]}: ${pair(warm.month)}` : undefined,
    coldest: cold ? `${MONTH_NAMES[cold.month]}: ${pair(cold.month)}` : undefined,
    wettest: wet ? `${MONTH_NAMES[wet.month]}: ${water(wet.value, us)}` : undefined,
    driest: dry ? `${MONTH_NAMES[dry.month]}: ${water(dry.value, us)}` : undefined,
    yearPrecip: sum(n.precipIn),
    yearSnow: n.snowIn ? sum(n.snowIn) : null,
    snow: snowSeason(n, us),
  };
}

/** "Jan 40/21 °F, 6.2 in; Feb ...": every month in one line for the note. */
export function monthsLine(n: Normals, us: boolean): string {
  return MONTH_SHORT.map((m, i) => {
    const hi = n.highF[i];
    const lo = n.lowF[i];
    const p = n.precipIn[i];
    const t = hi === null || lo === null ? "–" : us ? `${Math.round(hi)}/${Math.round(lo)}` : `${Math.round(fToC(hi))}/${Math.round(fToC(lo))}`;
    const w = p === null ? "–" : us ? amountText(p) : String(Math.round(p * 25.4));
    return `${m} ${t}, ${w}`;
  }).join("; ");
}

/** The monthly strip: temperature band, precipitation bars, and a snow row when there is snow to show. */
export function normalsStrip(n: Normals, us: boolean, place: string, period: string, source: string): MonthlyStrip {
  const toC = (xs: Months) => xs.map((v) => (v === null ? null : Math.round(fToC(v) * 10) / 10));
  const rows: MonthlyRow[] = [
    {
      kind: "band",
      key: "temperature",
      label: "Temperature",
      unit: us ? "°F" : "°C",
      high: us ? n.highF.map(round1) : toC(n.highF),
      low: us ? n.lowF.map(round1) : toC(n.lowF),
      legend: `Band: normal daily high and low temperature, ${period}`,
    },
    {
      kind: "bars",
      key: "precipitation",
      label: "Precipitation",
      unit: us ? "in" : "mm",
      values: n.precipIn.map((v) => (v === null ? null : us ? Math.round(v * 100) / 100 : Math.round(v * 25.4))),
      legend: `Bars: normal monthly precipitation (rain and melted snow), ${period}`,
    },
  ];
  if (n.snowDays && n.snowDays.some((v) => (v ?? 0) > 0)) {
    rows.push({
      kind: "cells",
      key: "snowGround",
      label: "Snow on the ground",
      unit: "share of days",
      values: n.snowDays.map((d, m) => (d === null ? null : Math.round(Math.min(1, d / DAYS_IN_MONTH[m]) * 100) / 100)),
      max: 1,
      legend: "Shade: share of days with at least 1 inch of snow on the ground",
    });
  } else if (n.snowIn && n.snowIn.some((v) => (v ?? 0) > 0)) {
    rows.push({ kind: "cells", key: "snowfall", label: "Snowfall", unit: "in", values: n.snowIn.map(round1), legend: `Shade: normal monthly snowfall, ${period}` });
  } else if (n.sweIn && n.sweIn.some((v) => (v ?? 0) > 0.05)) {
    rows.push({
      kind: "cells",
      key: "snowWater",
      label: "Snow water",
      unit: us ? "in" : "mm",
      values: n.sweIn.map((v) => (v === null ? null : us ? Math.round(v * 10) / 10 : Math.round(v * 25.4))),
      legend: "Shade: snow water on the ground at the end of the month (melted depth)",
    });
  }
  return { place, period, rows, source };
}

// ---- The layer ----

const NOAA_SOURCE = "NOAA NCEI U.S. Climate Normals 1991–2020, monthly station normals (public domain)";
const TERRA_SOURCE = "TerraClimate monthly climate 1991–2020 (Abatzoglou et al. 2018, University of Idaho; CC0), via Google Earth Engine";

const HELP: Record<string, FieldHelp> = {
  warmest: { text: "The month with the highest normal daily high, with its normal high and low (the average over 1991–2020 of each day's highest and lowest temperature).", source: "NOAA NCEI", url: NORMALS_PAGE },
  coldest: { text: "The month with the lowest normal daily high, with its normal high and low.", source: "NOAA NCEI", url: NORMALS_PAGE },
  wettest: { text: "The month with the most precipitation on average: rain plus melted snow.", source: "NOAA NCEI", url: NORMALS_PAGE },
  snowSeason: { text: "When snow usually comes and goes: from the first month after summer with 3 inches of snowfall or snow on the ground a third of the days, to the month after the last such month. On the 4 km grid, from snow water left on the ground at the month's end.", source: "NOAA NCEI; TerraClimate" },
  source: { text: "Where the numbers were read: the NOAA weather station that stands for the place (the nearest with temperature normals, within 40 km), or TerraClimate's 4 km grid where no station is near." },
};

const CARD: CardSpec = {
  facts: [
    { key: "warmest", label: "Warmest month" },
    { key: "coldest", label: "Coldest month" },
    { key: "wettest", label: "Wettest month" },
    { key: "driest", label: "Driest month" },
    { key: "yearPrecipIn", label: "Precipitation a year", unit: "in", format: "1dp" },
    { key: "yearSnowIn", label: "Snowfall a year", unit: "in", format: "int" },
    { key: "snowSeason", label: "Snow season" },
    { key: "source", label: "Normals from" },
    { key: "distanceKm", label: "From the place asked", unit: "km", format: "1dp" },
    { key: "period", label: "Years averaged" },
  ],
  hidden: ["highF", "lowF", "precipIn", "snowIn", "snowDays", "sweIn", "stationId", "elevationM", "place"],
};

const errorOf = (error: unknown): LayerError =>
  error instanceof EeError
    ? { error: error.sourceStatus.message, hint: /not set up/.test(error.sourceStatus.message) ? "unavailable" : "upstream", sourceStatus: error.sourceStatus }
    : { error: String(error), hint: "upstream" };

async function fetchJson(ctx: QueryContext, url: string, key: string): Promise<unknown | null> {
  try {
    const res = await ctx.fetch(url, {
      cacheKey: `climate-normals:${key}`,
      ttlSeconds: TTL_SECONDS,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/** A box of about `km` around a point, in the search service's order: north, west, south, east. */
function searchBox([lon, lat]: [number, number], km: number): string {
  const dLat = km / 110.57;
  const dLon = km / (111.32 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const f = (v: number) => v.toFixed(4);
  return `${f(Math.min(90, lat + dLat))},${f(Math.max(-180, lon - dLon))},${f(Math.max(-90, lat - dLat))},${f(Math.min(180, lon + dLon))}`;
}

function insideUs([lon, lat]: [number, number]): boolean {
  const [w, s, e, n] = US_EXTENT;
  return lon >= w && lon <= e && lat >= s && lat <= n;
}

/** The nearest station's normals, or null (none near, or the service did not answer). */
async function stationNormals(ctx: QueryContext, at: [number, number]): Promise<{ station: Station; normals: Normals } | null> {
  const search = await fetchJson(ctx, `${SEARCH_URL}?dataset=${DATASET}&bbox=${searchBox(at, MAX_STATION_KM)}&dataTypes=MLY-TMAX-NORMAL&limit=100`, `search:${at.map((v) => v.toFixed(3)).join(",")}`);
  const station = search === null ? null : pickStation(search, at);
  if (!station) return null;
  const body = await fetchJson(
    ctx,
    `${DATA_URL}?dataset=${DATASET}&stations=${station.id}&format=json&dataTypes=${DATA_TYPES.join(",")}&includeStationName=true&includeStationLocation=1`,
    `data:${station.id}`,
  );
  const read = body === null ? null : readStationNormals(body);
  if (!read) return null;
  return { station: { ...station, ...(read.elevationM !== undefined && { elevationM: read.elevationM }) }, normals: read.normals };
}

const climateNormals = defineLayer({
  id: "climate-normals",
  title: "Climate normals by month",
  description:
    "Typical weather at a place for each month of the year: 1991–2020 normals (daily high and low, precipitation, snowfall, snow on the ground) from the nearest NOAA station, or TerraClimate's 4 km grid worldwide. " +
    "Give lon, lat and name of the place (a town, a lake shore, a trailhead); without them it reads the centre of the view. " +
    "For 'typical temperature by month', 'when does the snow arrive', 'what is July like', 'best month to visit'; a forecast is not typical. " +
    "The coverageNote gives the warmest and coldest month, the wettest, when snow comes and goes, and every month: lead with those numbers. " +
    "Draws the station and a monthly strip under the map (temperature band, precipitation bars, snow row). " +
    "Caveats: a station stands for its own spot; mountains a few miles away can be much colder and snowier.",
  coverage: "global",
  surface: "any",
  license: "NOAA NCEI U.S. Climate Normals (public domain); TerraClimate (CC0, University of Idaho)",
  requiredEnv: [],
  // TerraClimate, the fallback, runs on Earth Engine: the service account key in production, local ADC in development.
  optionalEnv: ["EE_PROJECT", "EE_SERVICE_ACCOUNT_JSON", "GOOGLE_APPLICATION_CREDENTIALS"],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "point", color: layerColor("climate-normals") },
  fieldHelp: HELP,
  card: CARD,
  labels: { field: "name", max: 1 },
  legend: { kind: "symbol", title: "Climate normals", items: [{ label: "Where the normals were read (station or grid point)", symbol: "point" }], note: "The months are in the strip under the map." },
  time: { shape: "none" },
  display: { units: "us" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const [w, s, e, n] = ctx.bbox;
    const at: [number, number] = input.lon !== undefined && input.lat !== undefined ? [input.lon, input.lat] : [(w + e) / 2, (s + n) / 2];
    const asked = input.name ?? (input.lon !== undefined ? undefined : "the centre of the view");
    const retrieved = new Date().toISOString();

    let normals: Normals;
    let feature: Feature;
    let citation: Citation;
    let where: string;
    const us = insideUs(at);
    const fromStation = us ? await stationNormals(ctx, at) : null;
    if (fromStation) {
      const { station } = fromStation;
      normals = fromStation.normals;
      citation = { source: NOAA_SOURCE, url: NORMALS_PAGE, retrieved, label: "NOAA NCEI (U.S. Climate Normals 1991–2020)" };
      const elevation = station.elevationM !== undefined ? `, ${Math.round(station.elevationM * 3.28084).toLocaleString("en-US")} ft` : "";
      const away = station.distanceKm >= 1 ? `, ${Math.round(station.distanceKm)} km from ${asked ?? "the place asked"}` : "";
      where = `${station.name} (NOAA weather station${elevation}${away})`;
      feature = {
        type: "Feature",
        geometry: { type: "Point", coordinates: [station.lon, station.lat] },
        properties: {
          name: station.name,
          stationId: station.id,
          source: `NOAA station ${station.name} (${station.id})`,
          distanceKm: Math.round(station.distanceKm * 10) / 10,
          ...(station.elevationM !== undefined && { elevationM: station.elevationM }),
        },
      };
    } else {
      if (!ctx.env.EE_PROJECT || !eeConfigured(ctx.env)) {
        return {
          error: us
            ? `No NOAA weather station with 1991–2020 normals within ${MAX_STATION_KM} km answered, and the worldwide fallback (TerraClimate on Earth Engine) is not set up on this server`
            : "Climate normals outside the United States come from TerraClimate on Earth Engine, which is not set up on this server",
          hint: "unavailable",
        };
      }
      let grid: TerraNormals | null;
      try {
        grid = readNormals(await createEeClient({ env: ctx.env }).compute(normalsExpression(at[0], at[1])));
      } catch (error) {
        return errorOf(error);
      }
      if (!grid) return { error: "TerraClimate has no climate data at this point (open sea or outside the grid)", hint: "upstream" };
      normals = gridNormals(grid);
      citation = { source: TERRA_SOURCE, url: TERRACLIMATE_PAGE, retrieved, label: "TerraClimate (University of Idaho, CC0)" };
      const name = input.name ?? `${Math.abs(at[1]).toFixed(2)}°${at[1] >= 0 ? "N" : "S"} ${Math.abs(at[0]).toFixed(2)}°${at[0] >= 0 ? "E" : "W"}`;
      where = `${name} (TerraClimate 4 km grid${us ? "; no NOAA station with normals within 40 km" : ""})`;
      feature = { type: "Feature", geometry: { type: "Point", coordinates: at }, properties: { name, source: "TerraClimate 4 km grid cell" } };
    }

    const facts = normalsFacts(normals, us);
    const place = String(feature.properties?.name);
    Object.assign(feature.properties ?? {}, {
      ...(input.name && input.name !== place && { place: input.name }),
      ...(facts.warmest && { warmest: facts.warmest }),
      ...(facts.coldest && { coldest: facts.coldest }),
      ...(facts.wettest && { wettest: facts.wettest }),
      ...(facts.driest && { driest: facts.driest }),
      ...(facts.yearPrecip !== null && { yearPrecipIn: Math.round(facts.yearPrecip * 10) / 10 }),
      ...(facts.yearSnow !== null && { yearSnowIn: Math.round(facts.yearSnow) }),
      ...(facts.snow.sentence && { snowSeason: facts.snow.sentence }),
      period: PERIOD,
      highF: normals.highF.map(round1),
      lowF: normals.lowF.map(round1),
      precipIn: normals.precipIn.map((v) => (v === null ? null : Math.round(v * 100) / 100)),
      ...(normals.snowIn && { snowIn: normals.snowIn.map(round1) }),
      ...(normals.snowDays && { snowDays: normals.snowDays.map(round1) }),
      ...(normals.sweIn && { sweIn: normals.sweIn.map(round1) }),
    });

    const parts: string[] = [];
    if (facts.warm && facts.cold) {
      const hi = (m: number) => deg(normals.highF[m] ?? NaN, us);
      const lo = (m: number) => deg(normals.lowF[m] ?? NaN, us);
      parts.push(
        `At ${where}, the ${PERIOD} normals: ${MONTH_NAMES[facts.warm.month]} is warmest, averaging ${hi(facts.warm.month)} by day and ${lo(facts.warm.month)} at night; ` +
          `${MONTH_NAMES[facts.cold.month]} is coldest at ${hi(facts.cold.month)} / ${lo(facts.cold.month)}`,
      );
    }
    if (facts.wet && facts.dry) {
      const year = facts.yearPrecip !== null ? `; ${water(facts.yearPrecip, us)} of precipitation a year` : "";
      const snowYear = facts.yearPrecip !== null && facts.yearSnow !== null && facts.yearSnow >= 1 ? `, with ${water(facts.yearSnow, us)} of snowfall` : "";
      parts.push(`the wettest month is ${MONTH_NAMES[facts.wet.month]} with ${water(facts.wet.value, us)} and the driest ${MONTH_NAMES[facts.dry.month]} with ${water(facts.dry.value, us)}${year}${snowYear}`);
    }
    const lead = parts.join("; ");
    const snow = facts.snow.sentence ? `. ${facts.snow.sentence}` : "";
    const line = `. By month (high/low ${us ? "°F" : "°C"}, precipitation ${us ? "in" : "mm"}): ${monthsLine(normals, us)}`;
    const strip = normalsStrip(normals, us, place, PERIOD, citation.label ?? citation.source);
    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features: [feature] },
      citation,
      coverageNote: `${lead}${snow}${line}`,
      months: strip,
      title: `Climate normals at ${place}`,
    };
  },
});

registerLayer(climateNormals);

export default climateNormals;
