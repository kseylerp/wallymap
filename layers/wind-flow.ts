/**
 * Wind hour by hour, drawn as moving particles (spec §13a: "any vector field ... animates as particles advected along
 * the field"): each particle drifts with the 10 m wind, its color and brightness are the speed (air temperature stays on
 * every node for the card and as the second variable a render can switch to), played hourly; the wind speed at the map's
 * center is plotted under the scrubber.
 * Color (2026-10-18): the audit found temperature-colored pink-on-green streaks vanishing on Topo while the question is
 * how windy; the particles now color by speed (flow.color = "speed", encode color speed) on the sage → pink → purple ramp.
 *
 * Field: Open-Meteo forecast API (https://api.open-meteo.com/v1/forecast), hourly wind_speed_10m (m/s with
 * wind_speed_unit=ms), wind_direction_10m (degrees the wind comes FROM) and temperature_2m (°C), the best model for each
 * place (HRRR, ICON, ECMWF and others blended by Open-Meteo, 1 to 11 km). Verified 2026-10-17: two Sierra points answered
 * 48 hours in m/s. Read on a grid of at most MAX_NODES nodes over the box (layers/_shared/flowGrid.ts), cached 1 hour.
 *
 * Units (2026-10-23, audit R12): US users got m/s ("is it too windy to climb at Joshua Tree tomorrow"). The layer declares
 * `display: { units: "us" }`, so the card reads "22 mph (10 m/s)" (display is per layer, so a box abroad reads mph first
 * too, with m/s beside it); every node also carries `speedMph` and the direction the wind comes from in words.
 * The asked place: the grid's windiest node is not the place asked about, so one more Open-Meteo call reads the box's
 * center (the place the geocoder answered) with wind_gusts_10m, in its local time zone (timezone=auto); the coverage
 * note gives the wind there now and each day's peak wind and gust with its hour, mph first in the US and km/h first
 * elsewhere. Verified 2026-10-23: the point call answers wind_gusts_10m in m/s beside wind_speed_10m.
 */
import { z } from "zod";
import { defineLayer, type Attribute, type BBox, type CardSpec, type FieldHelp, type LayerError, type LayerResult, type LegendSpec, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { readField } from "./_shared/flowGrid";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { layerColor } from "@/lib/render/palette";

const FORECAST_API = "https://api.open-meteo.com/v1/forecast";
/** Most grid nodes read: each is one Open-Meteo call (two weeks count once). */
export const MAX_NODES = 360;
/** A box narrower than this each way is widened around its center, so the wind has room to be seen moving. */
export const MIN_SPAN_KM = 150;

/** m/s to mph and to km/h. */
export const MS_TO_MPH = 2.23694;
const MS_TO_KMH = 3.6;

/** True for a point in the 50 states (rough boxes): US units first there. */
export function inUs([lon, lat]: [number, number]): boolean {
  const boxes: BBox[] = [
    [-125, 24, -66, 49.5],
    [-170, 51, -129, 72],
    [-161, 18, -154, 23],
  ];
  return boxes.some(([w, s, e, n]) => lon >= w && lon <= e && lat >= s && lat <= n);
}

const POINTS = ["north", "north-northeast", "northeast", "east-northeast", "east", "east-southeast", "southeast", "south-southeast", "south", "south-southwest", "southwest", "west-southwest", "west", "west-northwest", "northwest", "north-northwest"];

/** "west-southwest": a bearing in degrees as one of 16 compass words. */
export function compass(deg: number): string {
  return POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/** A wind speed held in m/s, in the reader's units first: "22 mph (10.0 m/s)" in the US, "36 km/h (10.0 m/s)" elsewhere. */
export function windText(ms: number, us: boolean): string {
  const metric = `${(Math.round(ms * 10) / 10).toFixed(1)} m/s`;
  return us ? `${Math.round(ms * MS_TO_MPH)} mph (${metric})` : `${Math.round(ms * MS_TO_KMH)} km/h (${metric})`;
}

/** One place's hourly wind from Open-Meteo, in local time (timezone=auto). */
const PointSchema = z.object({
  timezone: z.string().optional(),
  utc_offset_seconds: z.number(),
  hourly: z.object({
    time: z.array(z.string()),
    wind_speed_10m: z.array(z.number().nullable()),
    wind_gusts_10m: z.array(z.number().nullable()).optional(),
    wind_direction_10m: z.array(z.number().nullable()),
  }),
});
export type PointBody = z.infer<typeof PointSchema>;

function hourText(localIso: string): string {
  const h = Number(localIso.slice(11, 13));
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;
}

function dayText(localDay: string): string {
  return new Date(`${localDay}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function zoneAbbr(zone: string | undefined, at: Date): string {
  if (!zone) return "";
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName");
    return part ? part.value : "";
  } catch {
    return "";
  }
}

/** Index of the largest number in `values` over `indices`, or -1. */
function peak(values: (number | null)[] | undefined, indices: number[]): number {
  let best = -1;
  for (const i of indices) {
    const v = values?.[i];
    if (typeof v === "number" && (best < 0 || v > (values?.[best] as number))) best = i;
  }
  return best;
}

/**
 * The wind at the asked place in words: now (speed, direction, gust) and each day's peak wind and gust with its local
 * hour, from the current hour on. Null when the body has no usable hours.
 */
export function hereNote(body: PointBody, place: [number, number], now: Date, us: boolean): string | null {
  const { time, wind_speed_10m: speed, wind_gusts_10m: gusts, wind_direction_10m: dir } = body.hourly;
  if (time.length === 0) return null;
  const localNow = new Date(now.getTime() + body.utc_offset_seconds * 1000).toISOString().slice(0, 13);
  let k = time.findLastIndex((t) => t.slice(0, 13) <= localNow);
  if (k < 0) k = 0;
  const parts: string[] = [];
  const s = speed[k];
  const d = dir[k];
  const g = gusts?.[k];
  if (typeof s === "number") {
    const from = typeof d === "number" ? ` from the ${compass(d)}` : "";
    const gust = typeof g === "number" ? `, gusts ${windText(g, us)}` : "";
    parts.push(`now ${windText(s, us)}${from}${gust}`);
  }
  for (const day of [...new Set(time.map((t) => t.slice(0, 10)))]) {
    const hours = time.flatMap((t, i) => (t.startsWith(day) && i >= k ? [i] : []));
    const best = peak(speed, hours);
    if (best < 0) continue;
    const bestGust = peak(gusts, hours);
    const gust = bestGust >= 0 ? `, gusts to ${windText(gusts?.[bestGust] as number, us)} at ${hourText(time[bestGust])}` : "";
    parts.push(`${dayText(day)} peak ${windText(speed[best] as number, us)} at ${hourText(time[best])}${gust}`);
  }
  if (parts.length === 0) return null;
  const where = `${Math.abs(place[1]).toFixed(2)}°${place[1] >= 0 ? "N" : "S"} ${Math.abs(place[0]).toFixed(2)}°${place[0] >= 0 ? "E" : "W"}`;
  const zone = zoneAbbr(body.timezone, now);
  return `Wind at the asked place (${where}, the center of the view; local times${zone ? `, ${zone}` : ""}): ${parts.join("; ")}`;
}

/** The wind at the box's center: one Open-Meteo call with gusts, in local time; null when it fails. */
async function windHere(ctx: QueryContext, place: [number, number], days: number): Promise<PointBody | null> {
  const params = new URLSearchParams({
    latitude: place[1].toFixed(4),
    longitude: place[0].toFixed(4),
    hourly: "wind_speed_10m,wind_gusts_10m,wind_direction_10m",
    wind_speed_unit: "ms",
    forecast_days: String(days),
    timezone: "auto",
  });
  try {
    const res = await ctx.fetch(`${FORECAST_API}?${params.toString()}`, {
      cacheKey: `wind-flow:here:${place.map((n) => n.toFixed(3)).join(",")}:${days}:${new Date().toISOString().slice(0, 13)}`,
      ttlSeconds: 3_600,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    if (!res.ok) return null;
    const parsed = PointSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const inputSchema = z.object({
  days: z.number().int().min(1).max(7).default(2).describe("Days of hourly wind from today, 1 to 7 (default 2: today and tomorrow)"),
});

const HELP: Record<string, FieldHelp> = {
  speed: {
    text: "Wind speed 10 m above the ground at the hour of the query (10 m/s is about 22 mph or 36 km/h), from the forecast model Open-Meteo picks for the place.",
    unit: "m/s",
    source: "Open-Meteo forecast API (CC BY 4.0)",
    url: "https://open-meteo.com/en/docs",
  },
  east: { text: "Eastward part of the wind (blowing toward the east); negative blows west.", unit: "m/s" },
  north: { text: "Northward part of the wind; negative blows south.", unit: "m/s" },
  tempC: { text: "Air temperature 2 m above the ground.", unit: "°C", source: "Open-Meteo forecast API", url: "https://open-meteo.com/en/docs" },
  from: { text: "The direction the wind blows from, in compass words and degrees." },
  speedMph: { text: "Wind speed in miles per hour (the speed in m/s × 2.237).", unit: "mph" },
};

const CARD: CardSpec = {
  measure: { key: "speed", label: "Wind speed", unit: "m/s" },
  facts: [
    { key: "from", label: "From" },
    { key: "tempC", label: "Air temperature", unit: "°C", format: "1dp" },
  ],
  // east and north drive the particles; speedMph repeats the measure the card already shows in mph.
  hidden: ["series", "node", "east", "north", "speedMph"],
};

const ATTRIBUTES: Attribute[] = [
  { key: "speed", type: "measure", label: "Wind speed", unit: "m/s", encode: "size", aggregate: "max" },
  { key: "tempC", type: "measure", label: "Air temperature", unit: "°C" },
];

/** Particles colored and brightened by speed over the range in view (lib/render/particles.ts). */
export const LEGEND: LegendSpec = {
  kind: "ramp",
  title: "Wind speed, 10 m above the ground",
  field: "speed",
  unit: "m/s",
  stops: [{ label: "Calmest in view" }, { label: "Windiest in view" }],
  note: "Streaks move with the wind; brighter and purple is stronger. 5 m/s is about 11 mph, 10 m/s 22 mph, 15 m/s 34 mph.",
};

const windFlow = defineLayer({
  id: "wind-flow",
  title: "Wind (hourly, moving)",
  description:
    "Wind 10 m above the ground hour by hour, today and the next days, drawn as moving particles: each particle drifts with the wind, and its color and brightness are the speed (purple is strongest); air temperature (tempC, °C) is on every node too. " +
    "Features are grid nodes named by their position, with speed, east and north (m/s), speedMph, from (the direction the wind comes from) and tempC at the hour of the query, and a series per hour; the time scrubber steps hourly and the wind speed at the map's center is plotted under it. " +
    "The coverage note gives the wind at the asked place (the center of the view) now and each day's peak wind and gust with its local hour, mph first in the US and km/h first elsewhere: quote that for a named place, not the windiest node. " +
    "Answer US questions in mph (1 m/s = 2.237 mph), others in km/h, the other unit in brackets. " +
    "Use it for 'where is the wind strongest over the Sierra tomorrow', 'which way will the wind blow on the lake this afternoon', 'is it too windy to paddle'. " +
    "The summary's story gives the strongest node's low and peak with hours and whether it repeats (a daily cycle about every 24 hours); stats.top names the windiest nodes now. " +
    "Caveats: a forecast model (1 to 11 km), so a ridge or a canyon can blow harder than its grid cell. Boxes up to about 2,000 km across.",
  coverage: "global",
  surface: "any",
  license: "Open-Meteo forecast API, CC BY 4.0",
  requiredEnv: [],
  maxAreaKm2: 4_000_000,
  input: inputSchema,
  // mph first with m/s second on the card (R12); display is per layer, so it holds abroad too.
  display: { units: "us" },
  // encode stays speed + tempC (temperature the second variable a render can switch to; lib/render/particles.test.ts pins
  // it); the particles themselves color by flow.color, set to speed in query.
  style: { geometry: "point", color: layerColor("wind-flow"), unit: "m/s", encode: { size: "speed", color: "tempC" }, series: "hour", basemap: "outdoors" },
  legend: LEGEND,
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const [w, s, e, n] = ctx.bbox;
    const place: [number, number] = [(w + e) / 2, (s + n) / 2];
    // The asked place first: one location, so the grid's many cannot use up Open-Meteo's minute limit before it.
    const hereP = windHere(ctx, place, input.days);
    const field = await readField(
      ctx,
      {
        url: FORECAST_API,
        speed: "wind_speed_10m",
        direction: "wind_direction_10m",
        color: "temperature_2m",
        params: { wind_speed_unit: "ms" },
        speedUnit: "m/s",
        directionIs: "from",
        pastDays: 0,
        forecastDays: input.days,
        cacheKey: `wind-flow:${ctx.bbox.map((n) => n.toFixed(2)).join(",")}:${input.days}:${new Date().toISOString().slice(0, 13)}`,
        ttlSeconds: 3_600,
      },
      MAX_NODES,
      "tempC",
      MIN_SPAN_KM,
    );
    if ("error" in field) return { error: field.error, hint: "upstream" };
    for (const f of field.data.features) {
      const p = f.properties as Record<string, unknown>;
      if (typeof p.speed === "number") p.speedMph = Math.round(p.speed * MS_TO_MPH * 10) / 10;
      // east and north point where the wind goes; it comes from the opposite bearing.
      if (typeof p.east === "number" && typeof p.north === "number" && (p.east !== 0 || p.north !== 0)) {
        const fromDeg = Math.round(((Math.atan2(-p.east, -p.north) * 180) / Math.PI + 360) % 360) % 360;
        p.from = `${compass(fromDeg)} (${fromDeg}°)`;
      }
    }
    const here = await hereP;
    const hereText = here ? hereNote(here, place, new Date(), inUs(place)) : null;
    return {
      kind: "geojson",
      data: field.data,
      series: field.series,
      // Speed, not temperature, colors the particles: the question is how windy.
      flow: { ...field.flow, color: "speed" },
      citation: { source: "Open-Meteo forecast API (wind 10 m, temperature 2 m), CC BY 4.0", url: "https://open-meteo.com/en/docs", retrieved: new Date().toISOString() },
      // The field answered; a failed call for the asked place only drops its line from the note, not the layer.
      sourceStatus: { ok: true },
      coverageNote: [
        ...(hereText ? [hereText] : []),
        `${field.data.features.length} grid nodes, hourly for ${field.series.times.length} hours (forecast models blended by Open-Meteo, 1 to 11 km)`,
      ].join("; "),
    };
  },
});

registerLayer(windFlow);

export default windFlow;
