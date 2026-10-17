/**
 * Ocean currents hour by hour, drawn as moving particles (spec §13a, after mapped.earth's "Cook Inlet, a Week of
 * Currents"): color is the water temperature and brightness the speed, played hourly, with the tide at the nearest NOAA
 * station plotted under the scrubber so the reversals line up with high and low water.
 *
 * Field: Open-Meteo Marine (https://marine-api.open-meteo.com/v1/marine), hourly ocean_current_velocity (km/h),
 * ocean_current_direction (degrees the water flows toward) and sea_surface_temperature (°C), from Météo-France's SMOC
 * (surface currents with tides, 0.08°, about 8 km). Verified 2026-10-17: three Cook Inlet points answered 168 hours with
 * speeds of 0.2 to 4.5 km/h turning through 180° with the tide; land points answer nulls. Read on a grid of at most
 * MAX_NODES nodes over the box (layers/_shared/flowGrid.ts), cached 3 hours.
 *
 * Linked curve: NOAA CO-OPS hourly tide predictions (https://api.tidesandcurrents.noaa.gov/api/prod/datagetter,
 * product=predictions&interval=h, feet above MLLW, verified 2026-10-17 for Anchorage 9455920) at the prediction station
 * nearest the box's center within the box; outside NOAA's stations the model's sea level at the center
 * (sea_level_height_msl, metres) instead.
 *
 * NOAA's Operational Forecast Systems (CIOFS for Cook Inlet, SFBOFS and the others) resolve narrow inlets far better,
 * but serve NetCDF on curvilinear grids through THREDDS; reading them is a follow-up.
 */
import { z } from "zod";
import { defineLayer, type Attribute, type BBox, type CardSpec, type FieldHelp, type LayerError, type LayerResult, type LinkedSeries, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { readField, waterMask } from "./_shared/flowGrid";
import { haversineKm } from "./_shared/geo";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { parseStations } from "./tides";
import { layerColor } from "@/lib/render/palette";

const MARINE_API = "https://marine-api.open-meteo.com/v1/marine";
const MDAPI = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json";
const DATAGETTER = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
/** Most grid nodes read: each is one Open-Meteo call (a week counts once), so a query stays far under the minute limit. */
export const MAX_NODES = 360;
/** A box narrower than this each way is widened around its center: a bay geocoded to a point still shows its tides. */
export const MIN_SPAN_KM = 350;
/** The tide station plotted is the one nearest the field's center within this distance. */
const TIDE_STATION_KM = 200;

const inputSchema = z.object({
  days: z.number().int().min(1).max(7).default(7).describe("Days of hourly currents from today, 1 to 7 (default 7, this week)"),
  pastDays: z.number().int().min(0).max(3).default(0).describe("Days before today to include, 0 to 3"),
});

/** The Natural Earth land test (lib/checks/landMask.ts), loaded only when a query needs it; null where it cannot load. */
async function landTest(): Promise<((lon: number, lat: number) => boolean) | null> {
  try {
    const { isLand } = await import("@/lib/checks/landMask");
    return isLand;
  } catch {
    return null;
  }
}

const PredSchema = z.object({ predictions: z.array(z.object({ t: z.string(), v: z.string() })) });

/** The hourly tide at the NOAA prediction station nearest the box's center (inside the box), on the field's hours. */
async function noaaTide(ctx: QueryContext, bbox: BBox, times: string[]): Promise<LinkedSeries | null> {
  try {
    const list = await ctx.fetch(`${MDAPI}?type=tidepredictions`, { cacheKey: "tides:stations:predictions", ttlSeconds: 86_400, timeoutMs: UPSTREAM_TIMEOUT_MS });
    if (!list.ok) return null;
    const [w, s, e, n] = bbox;
    const center: [number, number] = [(w + e) / 2, (s + n) / 2];
    const station = parseStations(await list.json())
      .map((st) => ({ st, d: haversineKm(center, [st.lng, st.lat]) }))
      .filter((x) => x.d <= TIDE_STATION_KM)
      .sort((a, b) => a.d - b.d)[0]?.st;
    if (!station) return null;
    const first = times[0];
    const begin = encodeURIComponent(`${first.slice(0, 4)}${first.slice(5, 7)}${first.slice(8, 10)} ${first.slice(11, 16)}`);
    const url = `${DATAGETTER}?product=predictions&interval=h&station=${station.id}&begin_date=${begin}&range=${times.length}&datum=MLLW&units=english&time_zone=gmt&format=json&application=WildMap`;
    const res = await ctx.fetch(url, { cacheKey: `ocean-currents:tide:${station.id}:${first.slice(0, 13)}:${times.length}`, ttlSeconds: 6 * 3_600, timeoutMs: UPSTREAM_TIMEOUT_MS });
    if (!res.ok) return null;
    const parsed = PredSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    const byHour = new Map(parsed.data.predictions.map((p) => [p.t.slice(0, 13).replace(" ", "T"), Number(p.v)]));
    const values = times.map((t) => {
      const v = byHour.get(t.slice(0, 13));
      return v !== undefined && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
    });
    if (!values.some((v) => v !== null)) return null;
    return {
      label: "Tide height",
      unit: "ft",
      place: station.name,
      times,
      values,
      source: { source: "NOAA CO-OPS tide predictions (public domain)", url: `https://tidesandcurrents.noaa.gov/stationhome.html?id=${station.id}`, retrieved: new Date().toISOString() },
    };
  } catch {
    return null;
  }
}

/** The model's sea level (with tides) at the box's center, when no NOAA station is in the box. */
async function modelTide(ctx: QueryContext, bbox: BBox, times: string[], days: number, pastDays: number): Promise<LinkedSeries | null> {
  const [w, s, e, n] = bbox;
  const url = `${MARINE_API}?latitude=${((s + n) / 2).toFixed(3)}&longitude=${((w + e) / 2).toFixed(3)}&hourly=sea_level_height_msl&forecast_days=${days}&past_days=${pastDays}&timezone=GMT`;
  try {
    const res = await ctx.fetch(url, { ttlSeconds: 3 * 3_600, timeoutMs: UPSTREAM_TIMEOUT_MS });
    if (!res.ok) return null;
    const body = (await res.json()) as { hourly?: { time?: string[]; sea_level_height_msl?: (number | null)[] } };
    const byHour = new Map((body.hourly?.time ?? []).map((t, k) => [t.slice(0, 13), body.hourly?.sea_level_height_msl?.[k] ?? null]));
    const values = times.map((t) => byHour.get(t.slice(0, 13)) ?? null);
    if (!values.some((v) => v !== null)) return null;
    return { label: "Sea level (model)", unit: "m", place: "the center of the view", times, values };
  } catch {
    return null;
  }
}

const HELP: Record<string, FieldHelp> = {
  speed: {
    text:
      "Speed of the surface current, in metres per second (1 m/s is about 2 knots), tides included, from Météo-France's SMOC model " +
      "(about 8 km) via Open-Meteo; narrow channels run faster than an 8 km model can show.",
    unit: "m/s",
    source: "Météo-France SMOC via Open-Meteo Marine (CC BY 4.0)",
    url: "https://open-meteo.com/en/docs/marine-weather-api",
  },
  east: { text: "Eastward part of the current; negative flows west.", unit: "m/s" },
  north: { text: "Northward part of the current; negative flows south.", unit: "m/s" },
  sst: { text: "Sea surface temperature at the grid node.", unit: "°C", source: "Open-Meteo Marine", url: "https://open-meteo.com/en/docs/marine-weather-api" },
};

const CARD: CardSpec = {
  measure: { key: "speed", label: "Current speed", unit: "m/s" },
  facts: [
    { key: "sst", label: "Water temperature", unit: "°C", format: "1dp" },
    { key: "east", label: "Eastward", unit: "m/s", format: "1dp" },
    { key: "north", label: "Northward", unit: "m/s", format: "1dp" },
  ],
  hidden: ["series", "node"],
};

const ATTRIBUTES: Attribute[] = [
  { key: "speed", type: "measure", label: "Current speed", unit: "m/s", encode: "size", aggregate: "max" },
  { key: "sst", type: "measure", label: "Water temperature", unit: "°C" },
];

const oceanCurrents = defineLayer({
  id: "ocean-currents",
  title: "Ocean currents (hourly, moving)",
  description:
    "Surface ocean and tidal currents hour by hour for a few days, drawn as moving particles: each particle drifts with the current, its color is the water temperature (sst, °C) and its brightness the speed (m/s). " +
    "Features are grid nodes named by their position, with speed, east and north (m/s) and sst at the hour of the query, and a series per hour; the time scrubber steps hourly. " +
    "For a coast in the United States the tide at the nearest NOAA station is plotted under the scrubber in sync (elsewhere the model's sea level). " +
    "Use it for 'show the currents in Cook Inlet this week', 'when does the current turn in the Golden Gate', 'where does the current help a paddle trip'. " +
    "The summary's story gives the strongest current's low and peak with times, how often it repeats (tides about every 12.4 hours) and the tide's biggest swing. " +
    "Caveats: an 8 km model (Météo-France SMOC via Open-Meteo), so narrow channels and rips are smoothed; land has no values. NOAA's harbour models are a follow-up. Boxes up to about 2,000 km across.",
  coverage: "global",
  surface: "water",
  license: "Open-Meteo Marine (Météo-France SMOC), CC BY 4.0; NOAA CO-OPS tide predictions, public domain",
  requiredEnv: [],
  maxAreaKm2: 4_000_000,
  input: inputSchema,
  style: { geometry: "point", color: layerColor("ocean-currents"), unit: "m/s", encode: { size: "speed", color: "sst" }, series: "hour" },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const field = await readField(
      ctx,
      {
        url: MARINE_API,
        speed: "ocean_current_velocity",
        direction: "ocean_current_direction",
        color: "sea_surface_temperature",
        speedUnit: "km/h",
        directionIs: "toward",
        pastDays: input.pastDays,
        forecastDays: input.days,
        cacheKey: `ocean-currents:${ctx.bbox.map((n) => n.toFixed(2)).join(",")}:${input.days}:${input.pastDays}:${new Date().toISOString().slice(0, 13)}`,
        ttlSeconds: 3 * 3_600,
      },
      MAX_NODES,
      "sst",
      MIN_SPAN_KM,
    );
    if ("error" in field) return { error: field.error, hint: "upstream" };
    const times = field.series.times;
    // A finer water mask than the 8 km model grid, so particles stay off the land between its nodes.
    const water = await landTest().then((isLand) => (isLand ? waterMask(field.flow.bbox, isLand) : null)).catch(() => null);
    const linked = (await noaaTide(ctx, field.flow.bbox, times)) ?? (await modelTide(ctx, field.flow.bbox, times, input.days, input.pastDays));
    const wet = field.data.features.filter((f) => typeof f.properties?.speed === "number").length;
    const notes = [
      `${wet} of ${field.data.features.length} grid nodes at sea, hourly for ${times.length} hours (Météo-France SMOC, about 8 km)`,
      ...(linked ? [`${linked.label} at ${linked.place} plotted under the scrubber`] : []),
    ];
    return {
      kind: "geojson",
      // Land nodes carry nothing to draw or count.
      data: { ...field.data, features: field.data.features.filter((f) => (f.properties?.series as { speed?: unknown[] } | undefined)?.speed?.some((v) => v !== null)) },
      series: field.series,
      flow: { ...field.flow, ...(water && { water }) },
      ...(linked && { linked }),
      citation: { source: "Open-Meteo Marine API (Météo-France SMOC currents), CC BY 4.0", url: "https://open-meteo.com/en/docs/marine-weather-api", retrieved: new Date().toISOString() },
      coverageNote: notes.join("; "),
    };
  },
});

registerLayer(oceanCurrents);

export default oceanCurrents;
