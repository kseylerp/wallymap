/**
 * Vegetation greenness (NDVI or EVI) raster tiles from NASA GIBS, MODIS on the Terra satellite, 16-day composites.
 * Verified 2026-10-09 against https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml:
 *   - MODIS_Terra_L3_NDVI_16Day ("Vegetation Index (16-Day, MODIS, Terra)") and MODIS_Terra_L3_EVI_16Day
 *     ("Enhanced Vegetation Index (16-Day, MODIS, Terra)"): time dimension P16D from 2000-03-05 to the latest
 *     composite (2026-09-14 at the time of writing); TileMatrixSet GoogleMapsCompatible_Level9 (zoom 0 to 9), image/png.
 *   - The composites restart every 1 January (1 Jan, 17 Jan, ... 14 Sep). GIBS answers any date inside a period with
 *     that period (2026-09-14 and 2026-09-20 returned byte-identical tiles; 2026-09-10 returned the previous period).
 *     `time.cadence` is "16day", which lib/time snaps on the same January grid, so the scrubber steps one composite at
 *     a time. A date after the newest composite is a 404, so the newest day offered is 25 days
 *     behind today (a composite is published within about 25 days of its start).
 *   - Live check: z=4 y=6 x=4 for 2026-09-14 returned 200 image/png (19 KB, NDVI) and 20 KB (EVI).
 *   - The brief's "MODIS_Terra_L3_NDVI_8Day" / EVI 8-day ids do not exist; Terra *_NDVI_8Day / *_EVI_8Day (2025 on) do
 *     but cover only the last year, so they are not used.
 * No upstream call is made by the layer: it only builds the URL for the map to fetch.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { dateInput } from "./_shared/dated-tiles";
import { gibsDatedResult, type GibsDatedSpec } from "./_shared/gibs-dated";
import { layerColor } from "@/lib/render/palette";

const GIBS_IDS = {
  ndvi: "MODIS_Terra_L3_NDVI_16Day",
  evi: "MODIS_Terra_L3_EVI_16Day",
} as const;

/** First composite in the archive. */
export const FROM = "2000-03-05";
/** A composite is published within about this many days of its start; asking later 404s. */
export const DAYS_BACK = 25;

const inputSchema = z.object({
  index: z.enum(["ndvi", "evi"]).default("ndvi"),
  date: dateInput,
});

/** First day of the 16-day composite holding `day`: composites start on 1 January and every 16 days after it. */
export function compositeStart(day: string): string {
  const jan1 = Date.parse(`${day.slice(0, 4)}-01-01T00:00:00Z`);
  const offset = Math.floor((Date.parse(`${day}T00:00:00Z`) - jan1) / (16 * 86_400_000)) * 16;
  return new Date(jan1 + offset * 86_400_000).toISOString().slice(0, 10);
}

export function greennessSpec(index: keyof typeof GIBS_IDS): GibsDatedSpec {
  return {
    gibsId: GIBS_IDS[index],
    level: 9,
    from: FROM,
    daysBack: DAYS_BACK,
    cadence: "16day",
    label: index === "ndvi" ? "vegetation index (NDVI) composites" : "enhanced vegetation index (EVI) composites",
    citationSource: `NASA GIBS: MODIS Terra ${index.toUpperCase()} 16-day (NASA LP DAAC / MODIS; public)`,
  };
}

const greenness = defineLayer({
  id: "greenness",
  title: "Vegetation greenness",
  description:
    "Global satellite map of how green the land is, from NASA's MODIS sensor on the Terra satellite: a vegetation index drawn as a color ramp from brown (bare ground, rock, snow, water) to dark green (dense, healthy leaves). " +
    "It is a 16-day composite, one image per 16-day period (the composites restart every 1 January), published from March 2000 to about 25 days ago; date (YYYY-MM-DD) picks the period containing that day and defaults to the newest. " +
    "index is ndvi (NDVI, the default and classic greenness index, about 0 for bare ground to about 0.9 for dense forest) or evi (EVI, the enhanced vegetation index, which works better over very dense forest and is less washed out by haze). " +
    "Use it for 'how green is it', 'greenness', 'is the vegetation drought-stressed', 'when does spring green-up start', 'green vs brown season', or to compare the same place in two years by moving the date or using compare. " +
    "Example questions: how green is the Sierra this month, did the Amazon dry out compared with last year, when did the Colorado Front Range green up. " +
    "Caveats: it measures greenness of leaves, not tree species or land use; clouds and snow are screened out in a composite so patches can look stale or blank, and evergreen forest barely changes through the year. 250 m to 1 km detail, so it suits regions, not single fields. " +
    "Compare two dates works (pick two dates or years in compare). " +
    "The result's coverageNote names the 16-day composite shown. " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms.",
  coverage: "global",
  license: "NASA GIBS / MODIS (public)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("greenness"), raster: { saturation: -0.5, swatch: "#2E9E3E" } },

  async query(_ctx, input): Promise<LayerResult | LayerError> {
    const r = gibsDatedResult(greennessSpec(input.index), input.date);
    if (!("kind" in r) || r.kind !== "tiles") return r;
    // GIBS answers with the whole composite containing the day, so name its 16 days rather than the requested day.
    const shown = /for (\d{4}-\d{2}-\d{2})/.exec(r.coverageNote ?? "")?.[1];
    if (shown === undefined) return r;
    const start = compositeStart(shown);
    const end = new Date(Date.parse(`${start}T00:00:00Z`) + 15 * 86_400_000).toISOString().slice(0, 10);
    const name = input.index === "ndvi" ? "NDVI" : "EVI";
    const moved = /\((.+)\)$/.exec(r.coverageNote ?? "")?.[1];
    return { ...r, coverageNote: `${name} 16-day composite ${start} to ${end} (the composite containing ${shown})${moved ? `; ${moved}` : ""}` };
  },
});

registerLayer(greenness);

export default greenness;
