/**
 * Snow cover raster tiles: NASA GIBS MODIS daily snow cover (global, over time) or the NOAA NOHRSC snow depth analysis
 * (US, current day only).
 * Verified 2026-10-09:
 *   - GIBS WMTS capabilities (https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml):
 *     MODIS_Terra_NDSI_Snow_Cover ("Snow Cover (Normalized Difference Snow Index, MODIS, Terra)"), daily from 2000-02-24
 *     (with a few gaps) to the present, GoogleMapsCompatible_Level8 (zoom 0 to 8), image/png. This is the near-real-time
 *     "best" id; MODIS_Terra_L3_NDSI_Snow_Cover_Daily is the lagged standard product and is not used.
 *     Live check: z=4 y=3 x=8 returned 200 image/png for 2026-10-07, 2026-10-08 and 2026-10-09 (today), so the newest
 *     day offered is 1 day back.
 *   - SNODAS / NOHRSC depth: nohrsc.noaa.gov has no tile or WMS endpoint of its own, but NOAA publishes the analysis as an
 *     ArcGIS MapServer at https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer
 *     (layer 0 = snow depth, 4 = snow water equivalent; "not time enabled", refreshed 01Z, 05Z, 11Z and 17Z). Its `export`
 *     operation answers 200 image/png for any Web Mercator bbox; over the Cascades (Mount Rainier) it drew coloured depth
 *     pixels, and `identify` there returned a depth value. It is the current analysis only: no date, no scrubber.
 *     Legend classes run in 12 steps from a trace to several metres; their unit is not stated in the service metadata,
 *     so the description does not quote one.
 * No upstream call is made by the layer: it only builds the URL for the map to fetch.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { dateInput } from "./_shared/dated-tiles";
import { gibsDatedResult, type GibsDatedSpec } from "./_shared/gibs-dated";
import { layerColor } from "@/lib/render/palette";

const NOHRSC_SERVICE = "https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer";
const NOHRSC_DEPTH_LAYER = 0;

const inputSchema = z.object({
  date: dateInput,
  depth: z.boolean().default(false),
});

export const MODIS_SPEC: GibsDatedSpec = {
  gibsId: "MODIS_Terra_NDSI_Snow_Cover",
  level: 8,
  from: "2000-02-24",
  daysBack: 1,
  cadence: "daily",
  label: "snow cover",
  citationSource: "NASA GIBS: MODIS Terra snow cover (NDSI), NASA NSIDC DAAC / MODIS (public)",
};

/** Tile template for the NOHRSC snow depth analysis (ArcGIS MapServer export, Web Mercator). */
export function nohrscDepthTileUrl(): string {
  return (
    `${NOHRSC_SERVICE}/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32` +
    `&transparent=true&layers=show:${NOHRSC_DEPTH_LAYER}&f=image`
  );
}

const snowCover = defineLayer({
  id: "snow-cover",
  title: "Snow cover",
  description:
    "Global satellite map of where the ground is snow-covered, from NASA's MODIS sensor on the Terra satellite (Normalized Difference Snow Index): snow and ice show as bright blue-white, on a daily image that goes back to February 2000. " +
    "date (YYYY-MM-DD) picks the day and defaults to yesterday; the day can be moved with the time scrubber or compare to see how snow cover changed between two dates or years. " +
    "Set depth to true for the US snow depth analysis from NOAA's National Operational Hydrologic Remote Sensing Center (SNODAS-style modelled depth, about 1 km, stronger colors for deeper snow); it covers the lower 48 states only, shows the latest analysis (updated four times a day), and has no date. " +
    "Use it for 'snow cover', 'is there snow on the ground', 'how deep is the snow', 'when did the snow line retreat', 'early or late snow year' and similar. " +
    "Example questions: where is there snow in the Sierra today, how does snow cover in the Alps compare with a year ago, how deep is the snowpack in Colorado. " +
    "Caveats: the satellite sees snow only through clear sky, so cloudy days leave gaps or look patchy, forests can hide snow, and a day may be missing; it shows whether snow is there, not how deep or how much water is in it (depth mode and the snowpack layer give amounts). " +
    "The result's coverageNote states which product and day are shown. " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms.",
  coverage: "global",
  license: "NASA GIBS / MODIS (public); NOAA NOHRSC (public)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("snow-cover") },

  async query(_ctx, input): Promise<LayerResult | LayerError> {
    if (!input.depth) return gibsDatedResult(MODIS_SPEC, input.date);
    if (input.date !== undefined) {
      return { error: "Snow depth (depth: true) is only the latest analysis, so it takes no date; omit date, or use depth: false for a past day" };
    }
    return {
      kind: "tiles",
      data: { url: nohrscDepthTileUrl(), minzoom: 0, maxzoom: 10, format: "raster" },
      citation: {
        source: "NOAA National Weather Service, NOHRSC National Snow Analysis (snow depth; public)",
        url: "https://www.nohrsc.noaa.gov/nsa/",
        retrieved: new Date().toISOString(),
      },
      coverageNote: "Latest NOHRSC snow depth analysis (lower 48 states, updated several times a day); not scrubbable",
    };
  },
});

registerLayer(snowCover);

export default snowCover;
