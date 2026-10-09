/**
 * Night lights raster tiles from NASA GIBS (VIIRS Day/Night Band, Suomi NPP satellite).
 * Verified 2026-10-09 against https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml:
 *   - Layer id VIIRS_SNPP_DayNightBand_At_Sensor_Radiance ("At Sensor Radiance (Day/Night Band, VIIRS, Suomi NPP)").
 *     It is a daily product with a Time dimension from 2020-11-18 (with small gaps) to the present.
 *     VIIRS_Black_Marble exists too but has only the two yearly dates 2012 and 2016, so it is not used.
 *   - TileMatrixSet GoogleMapsCompatible_Level8 (zoom 0 to 8), format image/png, 256 px tiles.
 *   - Live check: date 3 days ago, z=3 y=3 x=2 returned 200 image/png (33 KB); z=8 returned 200.
 * The newest day or two are often not yet processed, so the default date is 3 days before today (UTC).
 * Days inside a gap in the archive return a 404 for each tile, so the map shows nothing for that date.
 * No upstream call is made by the layer: it only builds the URL for the map to fetch.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { gibsTileUrl } from "./_shared/gibs";

const GIBS_LAYER_ID = "VIIRS_SNPP_DayNightBand_At_Sensor_Radiance";
/** GoogleMapsCompatible_Level8: the finest zoom this layer is published at. */
const GIBS_LEVEL = 8;
/** First day the archive holds. */
const EARLIEST_DATE = "2020-11-18";
const DEFAULT_DAYS_BACK = 3;
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

const nightLights = defineLayer({
  id: "night-lights",
  title: "Night lights",
  description:
    "Global satellite picture of the Earth at night from NASA's VIIRS Day/Night Band, showing artificial light (cities, roads, ports, oil and gas flares, fishing fleets) and also fires, auroras and moonlit clouds. " +
    "It is a daily image of at-sensor radiance (how much light the satellite received), shown as brightness with no unit scale, so compare brightness only, not exact numbers. " +
    "date (YYYY-MM-DD, from 2020-11-18 on) picks the day; it defaults to 3 days ago because the newest days are often not published yet. " +
    "Use it to show where people live and build, how bright a region is, or how lights changed between two dates, anywhere in the world. " +
    "Caveats: a single day can be blotchy because clouds hide the ground, moonlight washes out dark areas, and each strip is captured at a different time of night; " +
    "some days are missing from the archive and show nothing. Bright spots are not always cities: flares, wildfires and snow glare also show up. " +
    "The result's coverageNote states the date shown. " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms.",
  coverage: "global",
  license: "NASA GIBS (public)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: "#F2C14E" },

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
      },
      citation: {
        source: "NASA GIBS: VIIRS Day/Night Band at-sensor radiance, Suomi NPP (NASA / NOAA; public)",
        url: "https://earthdata.nasa.gov/gibs",
        retrieved: new Date(now).toISOString(),
      },
      coverageNote: `Night lights for ${date}`,
    };
  },
});

registerLayer(nightLights);

export default nightLights;
