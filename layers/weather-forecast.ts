/**
 * Weather forecast for the next 7 days, hour by hour, at the asked place and across the view (audit R8: "too hot this
 * weekend", "rain in Zion this weekend", "too windy tomorrow" had no forecast to answer from).
 *
 * United States: the National Weather Service gridded forecast (api.weather.gov, keyless, public domain; a User-Agent is
 * required). Verified 2026-10-23 for Zion (37.2982, -113.0263): /points/{lat},{lon} answered SLC 41,25, time zone
 * America/Denver and the nearest town (Springdale, UT, 10.8 km); /gridpoints/SLC/41,25 (196 KB) answered 8 days of
 * temperature (°C), probabilityOfPrecipitation (%), quantitativePrecipitation (mm per period), windSpeed and windGust
 * (km/h), windDirection (degrees from), skyCover (%) and weather (coverage, kind, intensity), each as runs of
 * "start/duration" (PT1H, PT3H, PT6H, P1DT2H). Each run fills every hour it spans; a precipitation amount is spread
 * evenly over its hours so the day's total adds up.
 *
 * Elsewhere, or when the NWS fails: Open-Meteo's forecast API (CC BY 4.0, keyless; the source the wind and surf layers
 * use), one call for every point: hourly temperature_2m, precipitation_probability, precipitation, wind_speed_10m,
 * wind_gusts_10m, wind_direction_10m, cloud_cover and weather_code, in °F, mph and inches, timezone=auto. Verified
 * 2026-10-23: two locations (Zion, Chamonix) answered a JSON array of 168 hours each in America/Denver and Europe/Paris.
 *
 * Points: the asked place (the view's center, what the geocoder answered) and, for a view wider than AREA_MIN_KM, four
 * more halfway to its corners, so "where in the park is it wettest" has an answer. Each point holds every hour from the
 * current one as a series (the scrubber steps hourly; the temperature at the asked place is the linked chart), today's
 * and tomorrow's summary, Saturday's and Sunday's (for "this weekend") and the seven days as a list, in local time.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import {
  defineLayer,
  type Attribute,
  type CardSpec,
  type Citation,
  type FieldHelp,
  type LayerError,
  type LayerResult,
  type LegendSpec,
  type LinkedSeries,
  type QueryContext,
  type SeriesAxis,
} from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { compass, inUs } from "./wind-flow";
import { layerColor } from "@/lib/render/palette";

const NWS = "https://api.weather.gov";
const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";
const USER_AGENT = "WallyMap/0.1 (https://wallymap.vercel.app)";
/** A view wider than this (either way) also gets the four area points. */
export const AREA_MIN_KM = 25;
const HOUR_MS = 3_600_000;

const inputSchema = z.object({
  days: z.number().int().min(1).max(7).default(7).describe("Days of forecast from today, 1 to 7 (default 7)"),
});

/** One hour at one point, in the units people read in the US. */
export type Hour = {
  tempF: number | null;
  precipChance: number | null;
  precipIn: number | null;
  windMph: number | null;
  gustMph: number | null;
  windFromDeg: number | null;
  skyPct: number | null;
  /** Rain, snow, thunder in words when the source names it ("Chance of light rain showers"). */
  weather: string | null;
};

export type PointForecast = {
  coordinates: [number, number];
  /** The point's place in words, when the source says ("near Springdale, UT"). */
  near?: string;
  timeZone: string;
  /** UTC ISO time of each hour, oldest first, one hour apart. */
  times: string[];
  hours: Hour[];
  source: "nws" | "open-meteo";
  issued?: string;
};

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const KMH_TO_MPH = 0.621371;
const MM_TO_IN = 1 / 25.4;

// ---- NWS ----

const NwsPointSchema = z.object({
  properties: z.object({
    forecastGridData: z.string(),
    timeZone: z.string(),
    relativeLocation: z
      .object({ properties: z.object({ city: z.string(), state: z.string() }) })
      .optional(),
  }),
});

const NwsSeriesSchema = z.object({
  uom: z.string().optional(),
  values: z.array(z.object({ validTime: z.string(), value: z.unknown() })),
});

const NwsGridSchema = z.object({
  properties: z
    .object({
      updateTime: z.string().optional(),
      temperature: NwsSeriesSchema,
      probabilityOfPrecipitation: NwsSeriesSchema.optional(),
      quantitativePrecipitation: NwsSeriesSchema.optional(),
      windSpeed: NwsSeriesSchema.optional(),
      windGust: NwsSeriesSchema.optional(),
      windDirection: NwsSeriesSchema.optional(),
      skyCover: NwsSeriesSchema.optional(),
      weather: NwsSeriesSchema.optional(),
    })
    .passthrough(),
});

/** Hours in an ISO 8601 duration as the NWS writes them (PT1H, PT6H, P1D, P1DT2H); 1 when unreadable. */
export function durationHours(d: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(d);
  if (!m) return 1;
  const hours = Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0) + Math.round(Number(m[3] ?? 0) / 60);
  return Math.max(1, hours);
}

/**
 * An NWS run series ("2026-10-23T00:00:00+00:00/PT3H" → value) as one value per hour of `times` (UTC ISO). `spread`
 * divides each run's value over its hours (precipitation amounts), so the hours add up to the run.
 */
export function nwsHourly(series: z.infer<typeof NwsSeriesSchema> | undefined, times: string[], spread = false): unknown[] {
  const out: unknown[] = times.map(() => null);
  if (!series) return out;
  const index = new Map(times.map((t, i) => [Date.parse(t), i]));
  for (const run of series.values) {
    const [start, dur] = run.validTime.split("/");
    const t0 = Date.parse(start);
    if (Number.isNaN(t0)) continue;
    const hours = durationHours(dur ?? "PT1H");
    for (let h = 0; h < hours; h++) {
      const i = index.get(t0 + h * HOUR_MS);
      if (i === undefined) continue;
      out[i] = spread && typeof run.value === "number" ? run.value / hours : run.value;
    }
  }
  return out;
}

const COVERAGE_WORDS: Record<string, string> = {
  slight_chance: "Slight chance of",
  chance: "Chance of",
  likely: "Likely",
  definite: "",
  occasional: "Occasional",
  isolated: "Isolated",
  scattered: "Scattered",
  numerous: "Numerous",
  areas: "Areas of",
  patchy: "Patchy",
  widespread: "Widespread",
  periods: "Periods of",
  frequent: "Frequent",
  intermittent: "Intermittent",
  brief: "Brief",
};

/** The NWS weather cell in words: "Chance of light rain showers; scattered thunderstorms". Null when none. */
export function nwsWeatherWords(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const w of value) {
    if (typeof w !== "object" || w === null) continue;
    const { coverage, weather, intensity } = w as { coverage?: string | null; weather?: string | null; intensity?: string | null };
    if (!weather) continue;
    const kind = weather.replace(/_/g, " ");
    const strength = intensity && intensity !== "moderate" ? `${intensity.replace(/_/g, " ")} ` : "";
    const lead = coverage ? (COVERAGE_WORDS[coverage] ?? coverage.replace(/_/g, " ")) : "";
    parts.push(`${lead ? `${lead} ` : ""}${strength}${kind}`.trim());
  }
  if (parts.length === 0) return null;
  const text = parts.join("; ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The hours from `from` (the current hour, UTC) for `days` days. */
export function hourAxis(from: Date, days: number): string[] {
  const start = Math.floor(from.getTime() / HOUR_MS) * HOUR_MS;
  return Array.from({ length: days * 24 }, (_, i) => new Date(start + i * HOUR_MS).toISOString());
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A parsed NWS gridpoint body as hours on `times`, in °F, mph and inches. Null when it has no temperatures there. */
export function nwsForecast(body: unknown, times: string[]): Omit<PointForecast, "coordinates" | "timeZone" | "near"> | null {
  const parsed = NwsGridSchema.safeParse(body);
  if (!parsed.success) return null;
  const p = parsed.data.properties;
  const tempC = nwsHourly(p.temperature, times);
  const pop = nwsHourly(p.probabilityOfPrecipitation, times);
  const qpf = nwsHourly(p.quantitativePrecipitation, times, true);
  const wind = nwsHourly(p.windSpeed, times);
  const gust = nwsHourly(p.windGust, times);
  const dir = nwsHourly(p.windDirection, times);
  const sky = nwsHourly(p.skyCover, times);
  const wx = nwsHourly(p.weather, times);
  // Wind in km/h unless the series says otherwise (the NWS has served km/h since 2019; m/s would be wmoUnit:m_s-1).
  const windFactor = (s: z.infer<typeof NwsSeriesSchema> | undefined) => (s?.uom?.includes("m_s-1") ? 2.23694 : KMH_TO_MPH);
  const hours: Hour[] = times.map((_, i) => {
    const c = num(tempC[i]);
    const q = num(qpf[i]);
    const w = num(wind[i]);
    const g = num(gust[i]);
    return {
      tempF: c === null ? null : r1((c * 9) / 5 + 32),
      precipChance: num(pop[i]),
      precipIn: q === null ? null : r2(q * MM_TO_IN),
      windMph: w === null ? null : r1(w * windFactor(p.windSpeed)),
      gustMph: g === null ? null : r1(g * windFactor(p.windGust)),
      windFromDeg: num(dir[i]),
      skyPct: num(sky[i]),
      weather: nwsWeatherWords(wx[i]),
    };
  });
  if (!hours.some((h) => h.tempF !== null)) return null;
  return { times, hours, source: "nws", ...(p.updateTime && { issued: p.updateTime }) };
}

async function nwsPoint(ctx: QueryContext, at: [number, number], times: string[]): Promise<PointForecast | null> {
  const headers = { "user-agent": USER_AGENT, accept: "application/geo+json" };
  const lat = at[1].toFixed(4);
  const lon = at[0].toFixed(4);
  try {
    // The grid a point falls in never changes: cache the lookup for a month.
    const pr = await ctx.fetch(`${NWS}/points/${lat},${lon}`, {
      headers,
      cacheKey: `weather-forecast:nws-point:${lat},${lon}`,
      ttlSeconds: 30 * 86_400,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    if (!pr.ok) return null;
    const point = NwsPointSchema.safeParse(await pr.json());
    if (!point.success) return null;
    const grid = point.data.properties.forecastGridData;
    const gr = await ctx.fetch(grid, {
      headers,
      cacheKey: `weather-forecast:nws-grid:${grid}:${times[0].slice(0, 13)}`,
      ttlSeconds: 3_600,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      validate: (b) => b.includes('"temperature"'),
    });
    if (!gr.ok) return null;
    const fc = nwsForecast(await gr.json(), times);
    if (!fc) return null;
    const rel = point.data.properties.relativeLocation?.properties;
    return { ...fc, coordinates: at, timeZone: point.data.properties.timeZone, ...(rel && { near: `near ${rel.city}, ${rel.state}` }) };
  } catch {
    return null;
  }
}

// ---- Open-Meteo ----

const OmSchema = z.object({
  timezone: z.string(),
  hourly: z.object({
    time: z.array(z.string()),
    temperature_2m: z.array(z.number().nullable()),
    precipitation_probability: z.array(z.number().nullable()).optional(),
    precipitation: z.array(z.number().nullable()).optional(),
    wind_speed_10m: z.array(z.number().nullable()).optional(),
    wind_gusts_10m: z.array(z.number().nullable()).optional(),
    wind_direction_10m: z.array(z.number().nullable()).optional(),
    cloud_cover: z.array(z.number().nullable()).optional(),
    weather_code: z.array(z.number().nullable()).optional(),
  }),
});

/** WMO weather codes as Open-Meteo documents them, in words; clear and cloud codes say nothing (sky covers them). */
export function wmoWords(code: number | null | undefined): string | null {
  if (code === null || code === undefined) return null;
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return code >= 56 ? "Freezing drizzle" : "Drizzle";
  if (code >= 61 && code <= 67) return code >= 66 ? "Freezing rain" : code === 65 ? "Heavy rain" : code === 61 ? "Light rain" : "Rain";
  if (code >= 71 && code <= 77) return code === 75 ? "Heavy snow" : "Snow";
  if (code >= 80 && code <= 82) return code === 82 ? "Violent rain showers" : "Rain showers";
  if (code === 85 || code === 86) return "Snow showers";
  if (code >= 95) return code === 95 ? "Thunderstorms" : "Thunderstorms with hail";
  return null;
}

/**
 * Open-Meteo hours on `times`: its local hour strings ("2026-10-23T06:00") turned to UTC with the location's offset,
 * read from `utc_offset_seconds`. Null when nothing lands on the axis.
 */
export function openMeteoForecast(body: unknown, times: string[]): Omit<PointForecast, "coordinates" | "near"> | null {
  const parsed = OmSchema.extend({ utc_offset_seconds: z.number() }).safeParse(body);
  if (!parsed.success) return null;
  const { hourly, timezone, utc_offset_seconds: offset } = parsed.data;
  const at = new Map<number, number>();
  hourly.time.forEach((t, i) => at.set(Date.parse(`${t}:00Z`) - offset * 1000, i));
  const pick = (arr: (number | null)[] | undefined, i: number | undefined) => (i === undefined ? null : num(arr?.[i]));
  const hours: Hour[] = times.map((t) => {
    const i = at.get(Date.parse(t));
    const temp = pick(hourly.temperature_2m, i);
    const p = pick(hourly.precipitation, i);
    const w = pick(hourly.wind_speed_10m, i);
    const g = pick(hourly.wind_gusts_10m, i);
    return {
      tempF: temp === null ? null : r1(temp),
      precipChance: pick(hourly.precipitation_probability, i),
      precipIn: p === null ? null : r2(p),
      windMph: w === null ? null : r1(w),
      gustMph: g === null ? null : r1(g),
      windFromDeg: pick(hourly.wind_direction_10m, i),
      skyPct: pick(hourly.cloud_cover, i),
      weather: wmoWords(pick(hourly.weather_code, i)),
    };
  });
  if (!hours.some((h) => h.tempF !== null)) return null;
  return { times, hours, source: "open-meteo", timeZone: timezone };
}

async function openMeteoPoints(ctx: QueryContext, points: [number, number][], times: string[], days: number): Promise<(PointForecast | null)[]> {
  const params = new URLSearchParams({
    latitude: points.map((p) => p[1].toFixed(4)).join(","),
    longitude: points.map((p) => p[0].toFixed(4)).join(","),
    hourly:
      "temperature_2m,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,wind_direction_10m,cloud_cover,weather_code",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "inch",
    timezone: "auto",
    // One extra day: the axis starts at the current UTC hour, which can be the previous local day.
    forecast_days: String(Math.min(16, days + 1)),
  });
  try {
    const res = await ctx.fetch(`${OPEN_METEO}?${params.toString()}`, {
      cacheKey: `weather-forecast:om:${points.map((p) => p.map((n) => n.toFixed(3)).join(",")).join(";")}:${days}:${times[0].slice(0, 13)}`,
      ttlSeconds: 3_600,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    if (!res.ok) return points.map(() => null);
    const body: unknown = await res.json();
    const rows = Array.isArray(body) ? body : [body];
    return points.map((p, i) => {
      const fc = openMeteoForecast(rows[i], times);
      return fc ? { ...fc, coordinates: p } : null;
    });
  } catch {
    return points.map(() => null);
  }
}

// ---- Words ----

/** Sky cover in the NWS's words (percent of the sky covered by cloud). */
export function skyWords(pct: number | null): string | null {
  if (pct === null) return null;
  if (pct < 10) return "Clear";
  if (pct < 30) return "Mostly clear";
  if (pct < 60) return "Partly cloudy";
  if (pct < 85) return "Mostly cloudy";
  return "Cloudy";
}

function localParts(iso: string, zone: string): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(
    new Date(iso),
  );
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function weekdayOf(day: string): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

/** "7:00 AM MDT": a UTC instant in the point's local time with the zone's abbreviation. */
export function localTime(iso: string, zone: string): string {
  return new Date(iso).toLocaleString("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

export type DaySummary = {
  day: string;
  label: string;
  highF: number | null;
  lowF: number | null;
  precipChance: number | null;
  precipIn: number;
  windMph: number | null;
  gustMph: number | null;
  sky: string | null;
  weather: string | null;
  /** True when the day's first hours are already past (today): its high and low are for the rest of the day. */
  partial: boolean;
};

const maxOf = (xs: (number | null)[]) => xs.reduce<number | null>((m, x) => (x === null ? m : m === null || x > m ? x : m), null);
const minOf = (xs: (number | null)[]) => xs.reduce<number | null>((m, x) => (x === null ? m : m === null || x < m ? x : m), null);

/** The most frequent non-null string, ties to the first seen. */
function mode(xs: (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const x of xs) if (x !== null) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [k, c] of counts) if (c > n) [best, n] = [k, c];
  return best;
}

/** Each local calendar day's high, low, chance and total of rain, top wind and gust, and its daytime sky. */
export function dailySummaries(fc: Pick<PointForecast, "times" | "hours" | "timeZone">): DaySummary[] {
  const byDay = new Map<string, { hours: Hour[]; local: number[] }>();
  fc.times.forEach((t, i) => {
    const { day, hour } = localParts(t, fc.timeZone);
    const entry = byDay.get(day) ?? { hours: [], local: [] };
    entry.hours.push(fc.hours[i]);
    entry.local.push(hour);
    byDay.set(day, entry);
  });
  const out: DaySummary[] = [];
  for (const [day, { hours, local }] of byDay) {
    // A tail day with only a few hours (the axis ends mid-day) would understate its high: left out.
    if (hours.length < 6 && out.length > 0) continue;
    const daytime = hours.filter((_, i) => local[i] >= 8 && local[i] <= 18);
    const amounts = hours.map((h) => h.precipIn).filter((x): x is number => x !== null);
    out.push({
      day,
      label: dayLabel(day),
      highF: maxOf(hours.map((h) => h.tempF)),
      lowF: minOf(hours.map((h) => h.tempF)),
      precipChance: maxOf(hours.map((h) => h.precipChance)),
      precipIn: r2(amounts.reduce((s, x) => s + x, 0)),
      windMph: maxOf(hours.map((h) => h.windMph)),
      gustMph: maxOf(hours.map((h) => h.gustMph)),
      sky: mode((daytime.length > 0 ? daytime : hours).map((h) => skyWords(h.skyPct))),
      weather: mode(hours.map((h) => h.weather)),
      partial: local[0] > 0,
    });
  }
  return out;
}

/** "Sat Oct 25: high 68 °F, low 45 °F; 20% chance of rain, 0.02 in; wind to 8 mph, gusts 18 mph; partly cloudy". */
export function dayText(d: DaySummary): string {
  const parts: string[] = [];
  const temps = [d.highF !== null ? `high ${Math.round(d.highF)} °F` : null, d.lowF !== null ? `low ${Math.round(d.lowF)} °F` : null].filter(Boolean);
  if (temps.length > 0) parts.push(`${d.partial ? "rest of day " : ""}${temps.join(", ")}`);
  if (d.precipChance !== null || d.precipIn > 0) {
    const chance = d.precipChance !== null ? `${Math.round(d.precipChance)}% chance of rain or snow` : "rain or snow";
    parts.push(`${chance}, ${d.precipIn.toFixed(2)} in`);
  }
  if (d.windMph !== null) parts.push(`wind to ${Math.round(d.windMph)} mph${d.gustMph !== null ? `, gusts ${Math.round(d.gustMph)} mph` : ""}`);
  const sky = [d.sky, d.weather].filter(Boolean).join(", ");
  if (sky) parts.push(sky.charAt(0).toLowerCase() + sky.slice(1));
  return `${d.label}: ${parts.join("; ")}`;
}

// ---- Features ----

function coordText([lon, lat]: [number, number]): string {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
}

/** The asked place and, for a wide view, four points halfway from it to the corners. */
export function forecastPoints(bbox: [number, number, number, number]): { at: [number, number]; kind: "here" | "area" }[] {
  const [w, s, e, n] = bbox;
  const c: [number, number] = [(w + e) / 2, (s + n) / 2];
  const out: { at: [number, number]; kind: "here" | "area" }[] = [{ at: c, kind: "here" }];
  const widthKm = (e - w) * 111.32 * Math.cos((c[1] * Math.PI) / 180);
  const heightKm = (n - s) * 110.57;
  if (Math.max(widthKm, heightKm) < AREA_MIN_KM) return out;
  for (const [x, y] of [
    [w, s],
    [e, s],
    [w, n],
    [e, n],
  ] as const) {
    out.push({ at: [Number(((c[0] + x) / 2).toFixed(4)), Number(((c[1] + y) / 2).toFixed(4))], kind: "area" });
  }
  return out;
}

const SERIES_KEYS = ["tempF", "precipChance", "precipIn", "windMph", "gustMph", "skyPct"] as const;

/** One point's feature: the hour of the query under plain keys, every hour under `series`, the days in words. */
export function forecastFeature(fc: PointForecast, kind: "here" | "area", now: number): Feature<Point> {
  const h = fc.hours[now] ?? fc.hours[0];
  const days = dailySummaries(fc);
  const where = fc.near ? `${fc.near} (${coordText(fc.coordinates)})` : coordText(fc.coordinates);
  const series = Object.fromEntries(SERIES_KEYS.map((k) => [k, fc.hours.map((x) => x[k])]));
  const properties: Record<string, unknown> = {
    name: kind === "here" ? `Forecast at the asked place, ${where}` : `Forecast ${where}`,
    kind,
    source: fc.source,
    t: fc.times[now],
    v: h.tempF,
    tempF: h.tempF,
    precipChance: h.precipChance,
    precipIn: h.precipIn,
    windMph: h.windMph,
    gustMph: h.gustMph,
    skyPct: h.skyPct,
    ...(h.windFromDeg !== null && { windFrom: `${compass(h.windFromDeg)} (${Math.round(h.windFromDeg)}°)` }),
    ...((skyWords(h.skyPct) ?? h.weather) && { sky: [skyWords(h.skyPct), h.weather].filter(Boolean).join(", ") }),
    timeZone: fc.timeZone,
    ...(fc.issued && { issued: localTime(fc.issued, fc.timeZone) }),
    days: days.map(dayText),
    series,
  };
  if (days[0]) properties.today = dayText(days[0]);
  if (days[1]) properties.tomorrow = dayText(days[1]);
  // "This weekend": the coming Saturday and Sunday (today when it is one).
  const sat = days.find((d) => weekdayOf(d.day) === 6);
  const sun = days.find((d) => weekdayOf(d.day) === 0 && (!sat || d.day > sat.day));
  if (sat) properties.saturday = dayText(sat);
  if (sun) properties.sunday = dayText(sun);
  for (const k of Object.keys(properties)) if (properties[k] === null) delete properties[k];
  return { type: "Feature", geometry: { type: "Point", coordinates: fc.coordinates }, properties };
}

// ---- Card, legend, attributes ----

const NWS_URL = "https://www.weather.gov/documentation/services-web-api";
const OM_URL = "https://open-meteo.com/en/docs";

const HELP: Record<string, FieldHelp> = {
  tempF: { text: "Air temperature 2 m above the ground at the hour shown.", unit: "°F", source: "NWS forecast (US), else Open-Meteo", url: NWS_URL },
  precipChance: {
    text: "Chance that at least 0.01 in of rain or snow (melted) falls at this point in the forecast period; 30% means 3 days in 10 like this one get some.",
    unit: "%",
    source: "NWS probability of precipitation; Open-Meteo's ensemble probability elsewhere",
    url: NWS_URL,
  },
  precipIn: { text: "Rain or melted snow expected in the hour (the NWS forecasts it in 6-hour blocks, spread evenly over their hours).", unit: "in" },
  windMph: { text: "Sustained wind 10 m above the ground.", unit: "mph" },
  gustMph: { text: "The strongest gusts expected in the hour.", unit: "mph" },
  skyPct: { text: "Share of the sky covered by cloud.", unit: "%" },
  days: { text: "Each day in local time: high and low, the chance and total of rain or snow, top wind and gusts, and the daytime sky. Today covers only the hours left." },
  saturday: { text: "The coming Saturday in local time." },
  sunday: { text: "The coming Sunday in local time." },
};

const CARD: CardSpec = {
  measure: { key: "tempF", label: "Temperature", unit: "°F" },
  facts: [
    { key: "precipChance", label: "Chance of rain or snow", unit: "%", format: "int" },
    { key: "precipIn", label: "Rain or snow this hour", unit: "in" },
    { key: "windMph", label: "Wind", unit: "mph", format: "int" },
    { key: "gustMph", label: "Gusts", unit: "mph", format: "int" },
    { key: "windFrom", label: "Wind from" },
    { key: "sky", label: "Sky" },
    { key: "today", label: "Today" },
    { key: "tomorrow", label: "Tomorrow" },
    { key: "saturday", label: "Saturday" },
    { key: "sunday", label: "Sunday" },
    { key: "days", label: "Next 7 days", format: "list" },
    { key: "issued", label: "Forecast issued" },
    { key: "source", label: "Forecast", values: { nws: "National Weather Service", "open-meteo": "Open-Meteo (blend of national models)" } },
  ],
  hidden: ["series", "v", "kind", "skyPct", "timeZone"],
};

const ATTRIBUTES: Attribute[] = [
  { key: "tempF", type: "measure", label: "Temperature", unit: "°F", aggregate: "mean" },
  { key: "precipChance", type: "measure", label: "Chance of rain or snow", unit: "%", aggregate: "max" },
  { key: "windMph", type: "measure", label: "Wind", unit: "mph", aggregate: "max" },
  { key: "gustMph", type: "measure", label: "Gusts", unit: "mph", aggregate: "max" },
  {
    key: "kind",
    type: "category",
    label: "Point",
    levels: [
      { value: "here", label: "Asked place", help: "The center of the view: the place asked about." },
      { value: "area", label: "Across the view", help: "Halfway from the asked place to a corner of the view." },
    ],
  },
];

const LEGEND: LegendSpec = {
  kind: "ramp",
  title: "Temperature at the hour shown",
  field: "tempF",
  unit: "°F",
  stops: [{ label: "Coldest in view" }, { label: "Warmest in view" }],
  note: "Step the hours with the scrubber; the chart under it is the temperature at the asked place.",
};

const weatherForecast = defineLayer({
  id: "weather-forecast",
  title: "Weather forecast (7 days, hourly)",
  description:
    "Weather forecast for the next 7 days, hour by hour: temperature, chance and amount of rain or snow, wind and gusts, and sky, at the asked place (the center of the view, kind 'here') and, for a view wider than 25 km, four more points across it (kind 'area'). " +
    "United States: the National Weather Service's official gridded forecast (source 'nws', about 2.5 km); elsewhere Open-Meteo's blend of national models (source 'open-meteo'). " +
    "Each point has tempF, precipChance (%), precipIn (inches in the hour), windMph, gustMph, windFrom and sky at the current hour, every hour under series (the scrubber steps hourly and the asked place's temperature is the chart under it), and the days in local time as words: today, tomorrow, saturday and sunday (the coming weekend) and days (all seven), each with high and low in °F, chance and total of rain or snow, top wind and gusts in mph, and the daytime sky. " +
    "Quote the asked day's line for 'will it rain this weekend', 'too hot to climb Saturday', 'too windy tomorrow', 'what's the weather in Zion this week'; give °F and mph in the US. " +
    "Warnings (flash flood, winter storm, red flag) are weather-alerts; a moving picture of the wind field is wind-flow; snow on the ground is snowpack. " +
    "Caveats: a forecast, less certain each day ahead; one point stands for a few kilometres, so a canyon floor and a rim can differ by 10 °F or more; precipChance is the chance of at least 0.01 in, not how much of the day it rains.",
  coverage: "global",
  surface: "any",
  license: "NWS forecasts: public domain (US Government); Open-Meteo: CC BY 4.0",
  requiredEnv: [],
  maxAreaKm2: 2_000_000,
  input: inputSchema,
  style: { geometry: "point", color: layerColor("weather-forecast"), unit: "°F", encode: { color: "tempF" }, series: "hour", basemap: "outdoors" },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  legend: LEGEND,
  time: { shape: "continuous", step: "hour" },
  labels: { field: "name", max: 1 },
  display: { units: "us", timeZone: "local" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const nowDate = new Date();
    const times = hourAxis(nowDate, input.days);
    const points = forecastPoints(ctx.bbox);
    const here = points[0].at;
    const us = inUs(here);
    let forecasts: (PointForecast | null)[] = us
      ? await Promise.all(points.map((p) => nwsPoint(ctx, p.at, times)))
      : points.map(() => null);
    const nwsFailed = us && forecasts.some((f) => f === null);
    const missing = points.flatMap((p, i) => (forecasts[i] === null ? [i] : []));
    if (missing.length > 0) {
      const om = await openMeteoPoints(ctx, missing.map((i) => points[i].at), times, input.days);
      forecasts = forecasts.map((f, i) => f ?? om[missing.indexOf(i)] ?? null);
    }
    if (forecasts.every((f) => f === null)) {
      return {
        error: us ? "The National Weather Service and Open-Meteo forecasts did not answer" : "The Open-Meteo forecast did not answer",
        hint: "upstream",
      };
    }
    const features: Feature<Point>[] = [];
    forecasts.forEach((fc, i) => {
      if (fc) features.push(forecastFeature(fc, points[i].kind, 0));
    });
    const data: FeatureCollection<Point> = { type: "FeatureCollection", features };
    const series: SeriesAxis = { times, step: "hour", now: 0, forecastFrom: 0 };
    const herePoint = forecasts[0];
    const sources = new Set(forecasts.filter((f): f is PointForecast => f !== null).map((f) => f.source));
    const citation: Citation = sources.has("nws")
      ? { source: `National Weather Service gridded forecast (api.weather.gov, public domain)${sources.has("open-meteo") ? "; Open-Meteo forecast API (CC BY 4.0) where the NWS did not answer" : ""}`, url: NWS_URL, retrieved: nowDate.toISOString() }
      : { source: "Open-Meteo forecast API (CC BY 4.0)", url: OM_URL, retrieved: nowDate.toISOString() };
    let linked: LinkedSeries | undefined;
    const notes: string[] = [];
    if (herePoint) {
      const where = herePoint.near ? `${herePoint.near}, ${coordText(here)}` : coordText(here);
      linked = { label: "Temperature", unit: "°F", place: `the asked place (${where})`, times, values: herePoint.hours.map((h) => h.tempF), source: citation };
      const days = dailySummaries(herePoint).map(dayText);
      const issued = herePoint.issued ? `, issued ${localTime(herePoint.issued, herePoint.timeZone)}` : "";
      notes.push(`Forecast at the asked place (${where}; ${herePoint.source === "nws" ? "National Weather Service" : "Open-Meteo"}${issued}; local times): ${days.join(" | ")}`);
    } else {
      notes.push("The asked place's forecast did not answer; the points across the view did");
    }
    if (features.length > 1) notes.push(`${features.length - 1} more points across the view`);
    if (nwsFailed) notes.push("The National Weather Service did not answer for some points; Open-Meteo filled them");
    return {
      kind: "geojson",
      data,
      series,
      ...(linked && { linked }),
      citation,
      coverageNote: notes.join("; "),
      ...(nwsFailed && { sourceStatus: { ok: true } as const }),
    };
  },
});

registerLayer(weatherForecast);

export default weatherForecast;
