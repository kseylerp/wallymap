/**
 * Air quality at the asked place, now and for the next days, hour by hour (docs/top-10-use-cases.md T02, "smoke now and
 * tomorrow ... Open-Meteo air quality PM2.5 forecast at the point"): the US Air Quality Index and fine particles (PM2.5,
 * what wildfire smoke is made of) from Open-Meteo's air quality API, keyless, CC BY 4.0, built on the Copernicus
 * Atmosphere Monitoring Service (CAMS) model, which carries wildfire smoke from satellite fire detections.
 * Verified 2026-10-23 for Yosemite Valley (37.74, -119.59): hourly pm2_5 and us_aqi for 5 days (120 hours) in
 * America/Los_Angeles, current US AQI 37 and PM2.5 3.6 µg/m³, 0.8 ms generation time.
 * One point: the asked place (the place found, else the middle of the view), its hours as a series (the scrubber steps
 * them) and each local day's worst hour in words (today, tomorrow, saturday, sunday), so "will it be smoky this weekend"
 * reads off one line. The smoke and weather-forecast layers quote the same numbers (airQualityAt).
 */
import { z } from "zod";
import type { Feature, Point } from "geojson";
import { defineLayer, type CardSpec, type FieldHelp, type LayerError, type LayerResult, type LegendSpec, type QueryContext, type SeriesAxis } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { layerColor } from "@/lib/render/palette";

export const AIR_QUALITY_API = "https://air-quality-api.open-meteo.com/v1/air-quality";
const DOCS_URL = "https://open-meteo.com/en/docs/air-quality-api";
const FORECAST_DAYS = 5;

/** The US EPA's Air Quality Index categories (AirNow), upper bound inclusive. */
export const AQI_BANDS: { max: number; label: string }[] = [
  { max: 50, label: "Good" },
  { max: 100, label: "Moderate" },
  { max: 150, label: "Unhealthy for sensitive groups" },
  { max: 200, label: "Unhealthy" },
  { max: 300, label: "Very unhealthy" },
  { max: Infinity, label: "Hazardous" },
];

export function aqiCategory(aqi: number): string {
  return AQI_BANDS.find((b) => aqi <= b.max)?.label ?? "Hazardous";
}

export type AirQuality = {
  at: [number, number];
  /** UTC ISO hours, oldest first. */
  times: string[];
  aqi: (number | null)[];
  pm25: (number | null)[];
  /** Seconds east of UTC of the place's clock (Open-Meteo's timezone=auto). */
  utcOffset: number;
  timeZone: string;
  /** The index of the hour now. */
  now: number;
};

const OmSchema = z.object({
  utc_offset_seconds: z.number(),
  timezone: z.string(),
  hourly: z.object({ time: z.array(z.string()), pm2_5: z.array(z.number().nullable()), us_aqi: z.array(z.number().nullable()) }),
});

/** Parses Open-Meteo's answer into hours on a UTC axis; null when it does not read. */
export function parseAirQuality(json: unknown, at: [number, number], nowMs: number): AirQuality | null {
  const parsed = OmSchema.safeParse(json);
  if (!parsed.success) return null;
  const { utc_offset_seconds: offset, timezone, hourly } = parsed.data;
  // Local wall-clock times ("2026-10-23T19:00") back to UTC instants.
  const times = hourly.time.map((t) => new Date(Date.parse(`${t}:00Z`) - offset * 1000).toISOString());
  if (times.length === 0) return null;
  let now = times.findIndex((t) => Date.parse(t) > nowMs) - 1;
  if (now < 0) now = Date.parse(times[0]) > nowMs ? 0 : times.length - 1;
  return { at, times, aqi: hourly.us_aqi, pm25: hourly.pm2_5, utcOffset: offset, timeZone: timezone, now };
}

/** The place's air quality from Open-Meteo, or null when it does not answer. */
export async function airQualityAt(ctx: Pick<QueryContext, "fetch">, at: [number, number], now = new Date()): Promise<AirQuality | null> {
  const lat = at[1].toFixed(3);
  const lon = at[0].toFixed(3);
  const url = `${AIR_QUALITY_API}?latitude=${lat}&longitude=${lon}&hourly=pm2_5,us_aqi&timezone=auto&forecast_days=${FORECAST_DAYS}`;
  try {
    const res = await ctx.fetch(url, { cacheKey: `air-quality:${lat},${lon}`, ttlSeconds: 3_600, timeoutMs: UPSTREAM_TIMEOUT_MS });
    if (!res.ok) return null;
    return parseAirQuality(await res.json(), at, now.getTime());
  } catch {
    return null;
  }
}

export type AirDay = { day: string; label: string; worstAqi: number | null; maxPm25: number | null; partial: boolean };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Each local day from the hour now: its worst hour's index and its highest PM2.5. */
export function airDays(aq: AirQuality): AirDay[] {
  const byDay = new Map<string, { aqi: number[]; pm: number[]; first: number }>();
  for (let i = aq.now; i < aq.times.length; i++) {
    const local = new Date(Date.parse(aq.times[i]) + aq.utcOffset * 1000);
    const day = local.toISOString().slice(0, 10);
    const e = byDay.get(day) ?? { aqi: [], pm: [], first: local.getUTCHours() };
    if (aq.aqi[i] !== null) e.aqi.push(aq.aqi[i] as number);
    if (aq.pm25[i] !== null) e.pm.push(aq.pm25[i] as number);
    byDay.set(day, e);
  }
  return [...byDay].map(([day, e]) => {
    const d = new Date(`${day}T12:00:00Z`);
    return {
      day,
      label: `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`,
      worstAqi: e.aqi.length > 0 ? Math.max(...e.aqi) : null,
      maxPm25: e.pm.length > 0 ? Math.round(Math.max(...e.pm) * 10) / 10 : null,
      partial: e.first > 0,
    };
  });
}

/** "Sat Oct 25: air quality good, worst hour US AQI 42, PM2.5 up to 9.1 µg/m³". */
export function airDayText(d: AirDay): string {
  if (d.worstAqi === null) return `${d.label}: no air quality forecast`;
  const pm = d.maxPm25 !== null ? `, PM2.5 up to ${d.maxPm25} µg/m³` : "";
  return `${d.label}: air quality ${aqiCategory(d.worstAqi).toLowerCase()}, worst ${d.partial ? "hour left" : "hour"} US AQI ${Math.round(d.worstAqi)}${pm}`;
}

/** The line the smoke and forecast notes quote: now, then each day. */
export function airQualityNote(aq: AirQuality, where: string): string {
  const aqi = aq.aqi[aq.now];
  const pm = aq.pm25[aq.now];
  const now = aqi !== null ? `now US AQI ${Math.round(aqi)} (${aqiCategory(aqi).toLowerCase()})${pm !== null ? `, PM2.5 ${pm} µg/m³` : ""}` : "no reading now";
  return `Air quality at ${where} (Open-Meteo, CAMS model; smoke included): ${now} | ${airDays(aq).map(airDayText).join(" | ")}`;
}

/** Saturday and Sunday ahead (today when it is one), as the forecast layer finds them. */
function weekend(days: AirDay[]): { sat?: AirDay; sun?: AirDay } {
  const sat = days.find((d) => new Date(`${d.day}T12:00:00Z`).getUTCDay() === 6);
  const sun = days.find((d) => new Date(`${d.day}T12:00:00Z`).getUTCDay() === 0 && (!sat || d.day > sat.day));
  return { sat, sun };
}

function coordText([lon, lat]: [number, number]): string {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
}

export function airQualityFeature(aq: AirQuality): Feature<Point> {
  const aqi = aq.aqi[aq.now];
  const days = airDays(aq);
  const { sat, sun } = weekend(days);
  const properties: Record<string, unknown> = {
    name: `Air quality at the asked place, ${coordText(aq.at)}`,
    t: aq.times[aq.now],
    ...(aqi !== null && { v: aqi, usAqi: aqi, category: aqiCategory(aqi) }),
    ...(aq.pm25[aq.now] !== null && { pm25: aq.pm25[aq.now] }),
    ...(days[0] && { today: airDayText(days[0]) }),
    ...(days[1] && { tomorrow: airDayText(days[1]) }),
    ...(sat && { saturday: airDayText(sat) }),
    ...(sun && { sunday: airDayText(sun) }),
    days: days.map(airDayText),
    series: { usAqi: aq.aqi, pm25: aq.pm25 },
  };
  return { type: "Feature", geometry: { type: "Point", coordinates: aq.at }, properties };
}

const HELP: Record<string, FieldHelp> = {
  usAqi: {
    text: "The US Air Quality Index at the hour shown, from the modelled pollutants (fine particles, ozone and others): 0 to 50 good, 51 to 100 moderate, 101 to 150 unhealthy for sensitive groups, 151 to 200 unhealthy, over 200 very unhealthy. Wildfire smoke raises it through PM2.5.",
    scale: "0 to 500 (US EPA)",
    source: "Open-Meteo air quality API (CAMS model)",
    url: DOCS_URL,
  },
  pm25: { text: "Fine particles under 2.5 micrometres near the ground, what wildfire smoke is mostly made of; the US daily standard is 35 µg/m³.", unit: "µg/m³", source: "Open-Meteo air quality API (CAMS model)", url: DOCS_URL },
  today: { text: "The rest of today in local time: the worst hour's index and the highest PM2.5." },
  saturday: { text: "The coming Saturday in local time: the worst hour's index and the highest PM2.5." },
  sunday: { text: "The coming Sunday in local time: the worst hour's index and the highest PM2.5." },
};

const CARD: CardSpec = {
  measure: { key: "usAqi", label: "Air quality index (US)" },
  facts: [
    { key: "category", label: "Air quality" },
    { key: "pm25", label: "Fine particles (PM2.5)", unit: "µg/m³", format: "1dp" },
    { key: "today", label: "Today" },
    { key: "tomorrow", label: "Tomorrow" },
    { key: "saturday", label: "Saturday" },
    { key: "sunday", label: "Sunday" },
    { key: "days", label: "Next days", format: "list" },
  ],
  hidden: ["series", "v", "t"],
};

const LEGEND: LegendSpec = {
  kind: "ramp",
  title: "Air quality index (US) at the hour shown",
  field: "usAqi",
  stops: AQI_BANDS.slice(0, 5).map((b, i) => ({ label: b.label, value: i === 0 ? 0 : AQI_BANDS[i - 1].max + 1 })),
  note: "Step the hours with the scrubber; PM2.5 from wildfire smoke drives the index on smoky days.",
};

const inputSchema = z.object({
  at: z.tuple([z.number(), z.number()]).optional().describe("The asked place as [lon, lat]; set by the app from the place found"),
});

const airQuality = defineLayer({
  id: "air-quality",
  title: "Air quality and smoke (forecast)",
  description:
    "Air quality at the asked place, now and for the next 5 days, hour by hour: the US Air Quality Index (usAqi, 0 to 500, with its category: good, moderate, unhealthy for sensitive groups, unhealthy, very unhealthy, hazardous) and fine particles (pm25 in µg/m³, what wildfire smoke is mostly made of). " +
    "From Open-Meteo's air quality API, a model (Copernicus CAMS) that carries wildfire smoke, worldwide. One point; today, tomorrow, saturday and sunday give each day's worst hour in words. " +
    "Quote it for 'is it smoky', 'air quality this weekend', 'will smoke clear by Saturday'; the smoke layer draws where the plumes are, this layer says how bad the air is at the place. " +
    "Caveats: a model about 10 to 40 km across, not a monitor reading; a nearby fire's smoke in a valley can be worse than it says.",
  coverage: "global",
  surface: "any",
  license: "CC BY 4.0 (Open-Meteo; Copernicus Atmosphere Monitoring Service)",
  requiredEnv: [],
  maxAreaKm2: 2_000_000,
  input: inputSchema,
  style: { geometry: "point", color: layerColor("air-quality"), unit: "US AQI", encode: { color: "usAqi" }, series: "hour", basemap: "outdoors", samplesView: true },
  fieldHelp: HELP,
  card: CARD,
  attributes: [
    { key: "usAqi", type: "measure", label: "Air quality index (US)", aggregate: "max" },
    { key: "pm25", type: "measure", label: "Fine particles (PM2.5)", unit: "µg/m³", aggregate: "max" },
  ],
  legend: LEGEND,
  time: { shape: "continuous", step: "hour" },
  labels: { field: "name", max: 1 },
  display: { timeZone: "local" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const [w, s, e, n] = ctx.bbox;
    const inside = input.at !== undefined && input.at[0] >= w && input.at[0] <= e && input.at[1] >= s && input.at[1] <= n;
    const at: [number, number] = inside && input.at ? input.at : [Number(((w + e) / 2).toFixed(4)), Number(((s + n) / 2).toFixed(4))];
    const aq = await airQualityAt(ctx, at);
    if (!aq) return { error: "The Open-Meteo air quality forecast did not answer", hint: "upstream" };
    const series: SeriesAxis = { times: aq.times, step: "hour", now: aq.now, forecastFrom: aq.now + 1 };
    const citation = { source: "Open-Meteo air quality API (CC BY 4.0), Copernicus Atmosphere Monitoring Service model", url: DOCS_URL, retrieved: new Date().toISOString() };
    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features: [airQualityFeature(aq)] },
      series,
      linked: { label: "Air quality index (US)", unit: "US AQI", place: `the asked place (${coordText(at)})`, times: aq.times, values: aq.aqi, source: citation },
      citation,
      coverageNote: airQualityNote(aq, `the asked place (${coordText(at)}; local times)`),
    };
  },
});

registerLayer(airQuality);

export default airQuality;
