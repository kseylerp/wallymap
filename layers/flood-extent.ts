/**
 * Flood and surface water extent raster tiles from NASA GIBS.
 * Verified 2026-10-09 against https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml:
 *   - OPERA_L3_Dynamic_Surface_Water_Extent-HLS ("Dynamic Surface Water Extent (Best, OPERA_L3_DSWx-HLS)"): daily,
 *     GoogleMapsCompatible_Level12 (zoom 0 to 12), image/png. Time intervals: 2016-01-07/2019-09-15, then continuous from
 *     2023-01-01 to 2026-10-07 (a 3-year hole in between, so `from` is 2023-01-01). Latest day 2026-10-07, so the newest
 *     day offered is 3 days back. Live check: 2026-10-05 z=9 Lake Okeechobee 200 image/png (122 KB), Lake Mead z=9
 *     and z=12 200 (157 KB, 141 KB); 2026-10-03 returned 934-byte near-empty tiles for the same places (HLS swaths cover
 *     each place only every few days, so single days are patchy).
 *   - MODIS_Combined_Flood_1-Day ("Flood (1-Day Window, MODIS, Terra + Aqua)"): daily from 2021-01-01 (small gaps) to the
 *     present, GoogleMapsCompatible_Level9, image/png. Live check: 2026-10-07/08/09 z=5/6 200 image/png (10 KB).
 *     Newest day offered is 1 day back.
 * No upstream call is made by the layer: it only builds the URL for the map to fetch.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { dateInput } from "./_shared/dated-tiles";
import { gibsDatedResult, type GibsDatedSpec } from "./_shared/gibs-dated";
import { layerColor } from "@/lib/render/palette";

const inputSchema = z.object({
  source: z.enum(["opera", "modis"]).default("opera"),
  date: dateInput,
});

export const SPECS: Record<"opera" | "modis", GibsDatedSpec> = {
  opera: {
    gibsId: "OPERA_L3_Dynamic_Surface_Water_Extent-HLS",
    level: 12,
    from: "2023-01-01",
    daysBack: 3,
    cadence: "daily",
    label: "surface water maps",
    citationSource: "NASA GIBS: OPERA Dynamic Surface Water Extent from HLS (Landsat 8/9 + Sentinel-2), NASA JPL OPERA (public)",
  },
  modis: {
    gibsId: "MODIS_Combined_Flood_1-Day",
    level: 9,
    from: "2021-01-01",
    daysBack: 1,
    cadence: "daily",
    label: "MODIS flood maps",
    citationSource: "NASA GIBS: MODIS Terra + Aqua combined 1-day flood (NASA LANCE / MODIS; public)",
  },
};

const floodExtent = defineLayer({
  id: "flood-extent",
  title: "Flood and surface water extent",
  description:
    "Global daily satellite maps of open water on the land, for seeing a flood as it happens or where a river or lake has spread. " +
    "source opera (default) is NASA's OPERA surface water extent from Landsat and Sentinel-2: 30 m detail, water classes in blue shades (open water, partial water, with clouds and snow masked), daily maps from 2023 to about 3 days ago; each place is imaged only every few days, so a given day shows patchy swaths and may be empty over your area. " +
    "source modis is the MODIS 1-day flood product from Terra and Aqua: about 250 m, flooded areas drawn in color, daily from 2021 to yesterday, coarser but a wider daily sweep. " +
    "date (YYYY-MM-DD) picks the day and defaults to the newest; use the time scrubber or compare to step through days before and after a flood. " +
    "Use it for 'flooded', 'is it flooded', 'flood extent', 'did the river overflow', 'where is the water now', 'lake level change this week'. " +
    "Example questions: how far did the river spread after the storm, is the Mississippi flooded near Memphis, show the water around this town before and after the hurricane. " +
    "To tell a flood from normal water, pair it with surface-water, which shows where water usually is. " +
    "Caveats: satellites cannot see through cloud, dense forest canopy or heavy urban cover, so floods under storm clouds are often missed and the first sunny pass may come days later; shadows and dark burn scars can look like water; it shows water, not depth or damage. " +
    "Compare two dates works (pick two dates or years in compare). " +
    "The result's coverageNote states the day shown (and when a date was moved to the newest available). " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms.",
  coverage: "global",
  license: "NASA GIBS / OPERA and MODIS (public)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("flood-extent"), raster: { saturation: -0.5, hueRotate: 40, swatch: "#1E5BFF" } },

  async query(_ctx, input): Promise<LayerResult | LayerError> {
    return gibsDatedResult(SPECS[input.source], input.date);
  },
});

registerLayer(floodExtent);

export default floodExtent;
