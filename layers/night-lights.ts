/**
 * Night lights raster tiles from NASA GIBS (VIIRS Day/Night Band, Suomi NPP satellite), moon- and cloud-corrected.
 * Verified 2026-10-18 against https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml:
 *   - Layer id VIIRS_SNPP_GapFilled_BRDF_Corrected_DayNightBand_Radiance ("Gap-Filled BRDF Corrected Radiance (Day/Night
 *     Band, VIIRS, Suomi NPP)", the Black Marble daily product): moonlight removed (BRDF corrected) and cloudy pixels
 *     filled from the nearest clear night, daily from 2012-01-19 (a few gaps) to 2026-10-16, two days behind today.
 *     GoogleMapsCompatible_Level8 (zoom 0 to 8), image/png.
 *   - Until 2026-10-18 the layer drew VIIRS_SNPP_DayNightBand_At_Sensor_Radiance (raw radiance, from 2020-11-18): moonlit
 *     cloud, per-strip capture times and a stale daytime strip showed as stripes, and two raw days were not comparable.
 *   - Colormap VIIRS_DayNightBand_At_Sensor_Radiance.xml (shared by both): grey from black (0) to white (38 nW/(cm² sr)
 *     and brighter), so the legend is that grey ramp in the source's unit.
 *   - Lights change over years, not days, so the scrubber steps one month at a time (the 1st of each month's gap-filled
 *     image), over the 14-year archive; the default stays the newest reliable day.
 * Days inside a gap in the archive return a 404 for each tile, so the map shows nothing for that date.
 * No upstream call is made by the layer: it only builds the URL for the map to fetch.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult, type LegendSpec } from "./types";
import { registerLayer } from "./registry";
import { gibsTileUrl } from "./_shared/gibs";
import { NIGHT_LIGHTS_DAYS_BACK } from "@/lib/time";
import { layerColor } from "@/lib/render/palette";

export const GIBS_LAYER_ID = "VIIRS_SNPP_GapFilled_BRDF_Corrected_DayNightBand_Radiance";
/** GoogleMapsCompatible_Level8: the finest zoom this layer is published at. */
const GIBS_LEVEL = 8;
/** First day the archive holds. */
export const EARLIEST_DATE = "2012-01-19";
const DEFAULT_DAYS_BACK = NIGHT_LIGHTS_DAYS_BACK;
const DAY_MS = 86_400_000;

const inputSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** True when the string is a real calendar day (rejects 2026-02-31, which Date would roll over). */
function isRealDate(day: string): boolean {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) && isoDay(ms) === day;
}

/** GIBS's grey ramp in its own unit (colormap VIIRS_DayNightBand_At_Sensor_Radiance.xml, read 2026-10-18). */
export const LEGEND: LegendSpec = {
  kind: "ramp",
  title: "Night light (radiance)",
  unit: "nW/(cm²·sr)",
  stops: [
    { label: "Dark, under 1", value: 0, color: "#070707" },
    { label: "2 (villages, roads)", value: 2, color: "#515151" },
    { label: "5", value: 5, color: "#7E7E7E" },
    { label: "10 (towns)", value: 10, color: "#A7A7A7" },
    { label: "20 (city suburbs)", value: 20, color: "#D4D4D4" },
    { label: "38 and brighter (city centres)", value: 38, color: "#FFFFFF" },
  ],
  note: "Brighter grey means more light. Flares, fires and fishing fleets glow too.",
};

const nightLights = defineLayer({
  id: "night-lights",
  title: "Night lights",
  description:
    "Global satellite picture of the Earth at night from NASA's VIIRS Day/Night Band (the Black Marble product), showing artificial light (cities, roads, ports, oil and gas flares, fishing fleets) and also fires. " +
    "It is a daily image of light radiance with moonlight removed and cloudy nights filled from the nearest clear one, drawn in grey from black (dark) to white (38 nW/(cm²·sr) and brighter, city centres); compare brightness between places and years, not exact numbers. " +
    "date (YYYY-MM-DD, from 2012-01-19 on) picks the day; it defaults to 3 days ago because the newest days are often not published yet. The time scrubber steps one month at a time, and compare works best with the same month in two years. " +
    "Use it to show where people live and build, how bright a region is, or how lights changed between two years (growth, outages, war), anywhere in the world. " +
    "Caveats: snow and bright desert can still brighten a night, a long cloudy spell is filled with an older night, and some days are missing from the archive and show nothing. Bright spots are not always cities: flares and wildfires also show up. " +
    "The result's coverageNote states the date shown. " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms.",
  coverage: "global",
  surface: "land",
  license: "NASA GIBS (public)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  // As served: the grey ramp is the key, and the dark raster replacing the basemap is the point of this layer.
  style: { geometry: "polygon", color: layerColor("night-lights"), raster: { saturation: 0, opacity: 0.85, swatch: "#D4D4D4" } },
  legend: LEGEND,

  async query(_ctx, input): Promise<LayerResult | LayerError> {
    const now = Date.now();
    const today = isoDay(now);
    const date = input.date ?? isoDay(now - DEFAULT_DAYS_BACK * DAY_MS);

    if (!isRealDate(date)) return { error: `${date} is not a real date; use YYYY-MM-DD` };
    if (date > today) return { error: `${date} is in the future; the latest day available is about ${DEFAULT_DAYS_BACK} days ago` };
    if (date < EARLIEST_DATE) return { error: `Night lights start on ${EARLIEST_DATE}; ${date} is earlier` };

    return {
      kind: "tiles",
      data: {
        url: gibsTileUrl(GIBS_LAYER_ID, date, GIBS_LEVEL),
        minzoom: 0,
        maxzoom: GIBS_LEVEL,
        format: "raster",
        time: {
          template: gibsTileUrl(GIBS_LAYER_ID, "{date}", GIBS_LEVEL),
          cadence: "monthly",
          from: EARLIEST_DATE,
          daysBack: DEFAULT_DAYS_BACK,
        },
      },
      citation: {
        source: "NASA GIBS: VIIRS Day/Night Band gap-filled, moon-corrected radiance (Black Marble), Suomi NPP (NASA / NOAA; public)",
        url: "https://earthdata.nasa.gov/gibs",
        retrieved: new Date(now).toISOString(),
      },
      coverageNote: `Night lights for ${date} (moonlight removed, cloudy nights filled)`,
    };
  },
});

registerLayer(nightLights);

export default nightLights;
