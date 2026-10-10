/**
 * Surface water history raster tiles from the EC Joint Research Centre Global Surface Water Explorer (Landsat, 1984 to 2021).
 * Tile route (verified 2026-10-09, no key):
 *   https://storage.googleapis.com/global-surface-water/tiles2021/{product}/{z}/{x}/{y}.png
 *   - products that answered 200 image/png at z=6: occurrence, change, seasonality, recurrence, transitions
 *     (extent returned 404). Also 200: z=0 to 3, z=5, z=9 to 13; z=14 returned 404 (so maxzoom is 13).
 *   - tiles2020 exists too; tiles2022 returned 404, so 2021 (the v1.4 release, covering 1984-03 to 2021-12) is the newest.
 *   - Live check of "change" at z=6: 42 KB image of white background with black/red/green water pixels.
 * Static data: no date, so the layer publishes no time block. No upstream call is made by the layer.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { layerColor } from "@/lib/render/palette";

export const PRODUCTS = ["occurrence", "change", "seasonality", "recurrence", "transitions"] as const;
export type Product = (typeof PRODUCTS)[number];

const inputSchema = z.object({
  product: z.enum(PRODUCTS).default("occurrence"),
});

const NOTES: Record<Product, string> = {
  occurrence: "Water occurrence, 1984 to 2021: how often each pixel was water, from rarely (pale blue) to always (dark blue)",
  change: "Water occurrence change: where water was lost (red) or gained (green) comparing 1984-1999 with 2000-2021",
  seasonality: "Water seasonality: how many months a year each pixel holds water, from a few months (light) to all 12 (dark blue)",
  recurrence: "Water recurrence: how often water comes back from year to year, as a share of years",
  transitions: "Water transitions: permanent, seasonal, new, lost and converted water classes between 1984 and 2021",
};

export function waterTileUrl(product: Product): string {
  return `https://storage.googleapis.com/global-surface-water/tiles2021/${product}/{z}/{x}/{y}.png`;
}

const surfaceWater = defineLayer({
  id: "surface-water",
  title: "Surface water history",
  description:
    "Global map of where surface water (lakes, rivers, reservoirs, wetlands, floodplains) has been seen by Landsat satellites over 38 years (1984 to 2021), from the EU Joint Research Centre Global Surface Water Explorer, at 30 m detail. " +
    "It is a static history, not a date: product picks the view. occurrence (default) shows how often a pixel was water, pale for rarely wet to dark blue for always wet. " +
    "change shows where water was lost (red) or gained (green) comparing 1984-1999 with 2000-2021, so it is the one for 'did this lake shrink' or 'where did the reservoir fill'. " +
    "seasonality shows how many months a year there is water (all 12 months is permanent), recurrence shows how reliably water returns year after year, and transitions classes each pixel as permanent, seasonal, new, lost or converted. " +
    "Use it for 'lake shrink', 'is this lake drying up', 'where is the river floodplain', 'seasonal ponds', 'where does water usually stand', or as the baseline to judge whether a recent flood is unusual. " +
    "Example questions: has the Salton Sea shrunk, which reservoirs near here are new, where are the seasonal wetlands. " +
    "To compare two products, such as occurrence with change, call the layer once per product. " +
    "Caveats: it ends in 2021, so it shows nothing about recent years (use flood-extent for current water); clouds, snow, ice and steep terrain shadow leave gaps in the high north and mountains; small streams narrower than about 30 m are missed. " +
    "The result's coverageNote says what the colors in that product mean. " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms.",
  coverage: "global",
  license: "Copernicus / EC JRC Global Surface Water (free and open; cite Pekel et al. 2016, Nature)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("surface-water") },

  async query(_ctx, input): Promise<LayerResult | LayerError> {
    return {
      kind: "tiles",
      data: { url: waterTileUrl(input.product), minzoom: 0, maxzoom: 13, format: "raster" },
      citation: {
        source: "EC Joint Research Centre, Global Surface Water Explorer v1.4 (Pekel et al., Nature 2016); contains modified Copernicus data",
        url: "https://global-surface-water.appspot.com/",
        retrieved: new Date().toISOString(),
      },
      coverageNote: NOTES[input.product],
    };
  },
});

registerLayer(surfaceWater);

export default surfaceWater;
