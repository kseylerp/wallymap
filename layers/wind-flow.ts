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
 */
import { z } from "zod";
import { defineLayer, type Attribute, type CardSpec, type FieldHelp, type LayerError, type LayerResult, type LegendSpec } from "./types";
import { registerLayer } from "./registry";
import { readField } from "./_shared/flowGrid";
import { layerColor } from "@/lib/render/palette";

const FORECAST_API = "https://api.open-meteo.com/v1/forecast";
/** Most grid nodes read: each is one Open-Meteo call (two weeks count once). */
export const MAX_NODES = 360;
/** A box narrower than this each way is widened around its center, so the wind has room to be seen moving. */
export const MIN_SPAN_KM = 150;

const inputSchema = z.object({
  days: z.number().int().min(1).max(7).default(2).describe("Days of hourly wind from today, 1 to 7 (default 2: today and tomorrow)"),
});

const HELP: Record<string, FieldHelp> = {
  speed: {
    text: "Wind speed 10 m above the ground, in metres per second (10 m/s is about 22 mph), from the forecast model Open-Meteo picks for the place.",
    unit: "m/s",
    source: "Open-Meteo forecast API (CC BY 4.0)",
    url: "https://open-meteo.com/en/docs",
  },
  east: { text: "Eastward part of the wind (blowing toward the east); negative blows west.", unit: "m/s" },
  north: { text: "Northward part of the wind; negative blows south.", unit: "m/s" },
  tempC: { text: "Air temperature 2 m above the ground.", unit: "°C", source: "Open-Meteo forecast API", url: "https://open-meteo.com/en/docs" },
};

const CARD: CardSpec = {
  measure: { key: "speed", label: "Wind speed", unit: "m/s" },
  facts: [
    { key: "tempC", label: "Air temperature", unit: "°C", format: "1dp" },
    { key: "east", label: "Eastward", unit: "m/s", format: "1dp" },
    { key: "north", label: "Northward", unit: "m/s", format: "1dp" },
  ],
  hidden: ["series", "node"],
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
    "Wind 10 m above the ground hour by hour, today and the next days, drawn as moving particles: each particle drifts with the wind, and its color and brightness are the speed (m/s; purple is strongest); air temperature (tempC, °C) is on every node too. " +
    "Features are grid nodes named by their position, with speed, east and north (m/s) and tempC at the hour of the query, and a series per hour; the time scrubber steps hourly and the wind speed at the map's center is plotted under it. " +
    "Use it for 'where is the wind strongest over the Sierra tomorrow', 'which way will the wind blow on the lake this afternoon', 'is it too windy to paddle'. " +
    "The summary's story gives the strongest node's low and peak with hours and whether it repeats (a daily cycle about every 24 hours); stats.top names the windiest nodes now. " +
    "Caveats: a forecast model (1 to 11 km), so a ridge or a canyon can blow harder than its grid cell. Boxes up to about 2,000 km across.",
  coverage: "global",
  surface: "any",
  license: "Open-Meteo forecast API, CC BY 4.0",
  requiredEnv: [],
  maxAreaKm2: 4_000_000,
  input: inputSchema,
  // encode stays speed + tempC (temperature the second variable a render can switch to; lib/render/particles.test.ts pins
  // it); the particles themselves color by flow.color, set to speed in query.
  style: { geometry: "point", color: layerColor("wind-flow"), unit: "m/s", encode: { size: "speed", color: "tempC" }, series: "hour", basemap: "outdoors" },
  legend: LEGEND,
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,

  async query(ctx, input): Promise<LayerResult | LayerError> {
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
    return {
      kind: "geojson",
      data: field.data,
      series: field.series,
      // Speed, not temperature, colors the particles: the question is how windy.
      flow: { ...field.flow, color: "speed" },
      citation: { source: "Open-Meteo forecast API (wind 10 m, temperature 2 m), CC BY 4.0", url: "https://open-meteo.com/en/docs", retrieved: new Date().toISOString() },
      coverageNote: `${field.data.features.length} grid nodes, hourly for ${field.series.times.length} hours (forecast models blended by Open-Meteo, 1 to 11 km)`,
    };
  },
});

registerLayer(windFlow);

export default windFlow;
