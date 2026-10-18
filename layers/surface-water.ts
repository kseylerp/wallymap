/**
 * Surface water history raster tiles from the EC Joint Research Centre Global Surface Water Explorer (Landsat, 1984 to 2021).
 * Tile route (verified 2026-10-09, no key):
 *   https://storage.googleapis.com/global-surface-water/tiles2021/{product}/{z}/{x}/{y}.png
 *   - products that answered 200 image/png at z=6: occurrence, change, seasonality, recurrence, transitions
 *     (extent returned 404). Also 200: z=0 to 3, z=5, z=9 to 13; z=14 returned 404 (so maxzoom is 13).
 *   - tiles2020 exists too; tiles2022 returned 404, so 2021 (the v1.4 release, covering 1984-03 to 2021-12) is the newest.
 *   - Live check of "change" at z=6: 42 KB image of white background with black/red/green water pixels.
 * Static data: no date, so the layer publishes no time block. No upstream call is made by the layer.
 * Colors (tiles over Lake Mead read 2026-10-18): occurrence runs faint magenta (rare) to blue (always) with alpha by
 *   occurrence; change is black where water stayed, red for loss, green for gain; seasonality faint light blue to
 *   #0000AA; recurrence orange to light blue; transitions JRC's classes. Drawn as served: the old hueRotate 40 and
 *   saturation -0.5 drew the lost water around Lake Mead brown while the note said red. Each product's key is in LEGENDS.
 * Not done: a recent product. GIBS carries OPERA DSWx (2023 on) per satellite pass, mostly blank on a given day; it needs
 *   imagery-by-date's pass search to be useful.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult, type LegendSpec } from "./types";
import { registerLayer } from "./registry";
import { layerColor } from "@/lib/render/palette";

export const PRODUCTS = ["occurrence", "change", "seasonality", "recurrence", "transitions"] as const;
export type Product = (typeof PRODUCTS)[number];

const inputSchema = z.object({
  product: z.enum(PRODUCTS).default("occurrence"),
});

const NOTES: Record<Product, string> = {
  occurrence: "Water occurrence, 1984 to 2021: how often each pixel was water, from rarely (faint magenta) through purple to always (blue)",
  change:
    "Water occurrence change, 1984-1999 against 2000-2021: red where water was lost (brighter red, more lost), green where it was gained, black where water stayed the same",
  seasonality: "Water seasonality: how many months a year each pixel holds water, from a few months (faint light blue) to all 12 (dark blue)",
  recurrence: "Water recurrence: how reliably water comes back year after year, from rarely (orange) through tan to every year (light blue)",
  transitions:
    "Water transitions 1984 to 2021: blue permanent, red lost permanent, green new permanent, yellow permanent turned seasonal, light blue seasonal, pink lost seasonal, lime new seasonal",
};

/** Each product's key in the JRC tiles' own colors (read from tiles over Lake Mead, z10 x186 y401, 2026-10-18). */
export const LEGENDS: Record<Product, LegendSpec> = {
  occurrence: {
    kind: "categories",
    title: "How often water, 1984 to 2021",
    items: [
      { label: "Always water (100%)", value: 100, color: "#0000FF", symbol: "raster" },
      { label: "About half the time", value: 50, color: "#800080", symbol: "raster" },
      { label: "Rarely water (faint)", value: 10, color: "#E6001A", symbol: "raster" },
    ],
    note: "Fainter where water was seen less often.",
  },
  change: {
    kind: "categories",
    title: "Water change, 1984-1999 to 2000-2021",
    items: [
      { label: "Water lost", value: "lost", color: "#FF0000", symbol: "raster" },
      { label: "No change", value: "same", color: "#000000", symbol: "raster" },
      { label: "Water gained", value: "gained", color: "#00FF00", symbol: "raster" },
    ],
    note: "Brighter red or green means a bigger change; a dark ring is a small one.",
  },
  seasonality: {
    kind: "categories",
    title: "Months a year with water",
    items: [
      { label: "All 12 months", value: 12, color: "#0000AA", symbol: "raster" },
      { label: "A few months (faint)", value: 2, color: "#8CC6E4", symbol: "raster" },
    ],
  },
  recurrence: {
    kind: "categories",
    title: "How reliably water returns each year",
    items: [
      { label: "Every year", value: 100, color: "#99D9EA", symbol: "raster" },
      { label: "Some years", value: 40, color: "#D4A478", symbol: "raster" },
      { label: "Rarely", value: 5, color: "#FF7F27", symbol: "raster" },
    ],
  },
  transitions: {
    kind: "categories",
    title: "Water class change, 1984 to 2021",
    items: [
      { label: "Permanent", value: "permanent", color: "#0000DD", symbol: "raster" },
      { label: "Lost permanent", value: "lost-permanent", color: "#D12D3E", symbol: "raster" },
      { label: "New permanent", value: "new-permanent", color: "#22B14C", symbol: "raster" },
      { label: "Permanent to seasonal", value: "to-seasonal", color: "#FFC90E", symbol: "raster" },
      { label: "Seasonal", value: "seasonal", color: "#99D9EA", symbol: "raster" },
      { label: "Lost seasonal", value: "lost-seasonal", color: "#E6A1AA", symbol: "raster" },
      { label: "New seasonal", value: "new-seasonal", color: "#B5E61D", symbol: "raster" },
    ],
  },
};

export function waterTileUrl(product: Product): string {
  return `https://storage.googleapis.com/global-surface-water/tiles2021/${product}/{z}/{x}/{y}.png`;
}

const surfaceWater = defineLayer({
  id: "surface-water",
  title: "Surface water history",
  description:
    "Global map of where surface water (lakes, rivers, reservoirs, wetlands, floodplains) has been seen by Landsat satellites over 38 years (1984 to 2021), from the EU Joint Research Centre Global Surface Water Explorer, at 30 m detail. " +
    "It is a static history, not a date: product picks the view. occurrence (default) shows how often a pixel was water, faint magenta for rarely wet through purple to blue for always wet. " +
    "change shows where water was lost (red) or gained (green) comparing 1984-1999 with 2000-2021, with unchanged water black, so it is the one for 'did this lake shrink' or 'where did the reservoir fill'. " +
    "seasonality shows how many months a year there is water (all 12 months is permanent), recurrence shows how reliably water returns year after year, and transitions classes each pixel as permanent, seasonal, new, lost or converted. " +
    "Use it for 'lake shrink', 'is this lake drying up', 'where is the river floodplain', 'seasonal ponds', 'where does water usually stand', or as the baseline to judge whether a recent flood is unusual. " +
    "Example questions: has the Salton Sea shrunk, which reservoirs near here are new, where are the seasonal wetlands. " +
    "To compare two products, such as occurrence with change, call the layer once per product. " +
    "Caveats: it ends in 2021, so it shows nothing about recent years (use flood-extent for current water); clouds, snow, ice and steep terrain shadow leave gaps in the high north and mountains; small streams narrower than about 30 m are missed. " +
    "The result's coverageNote says what the colors in that product mean. " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms.",
  coverage: "global",
  surface: "any",
  license: "Copernicus / EC JRC Global Surface Water (free and open; cite Pekel et al. 2016, Nature)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  // As served: the old hue turn and desaturation drew lost water brown while the words said red.
  style: { geometry: "polygon", color: layerColor("surface-water"), raster: { saturation: 0, opacity: 0.85, swatch: "#0000FF" } },
  legend: LEGENDS.occurrence,
  time: { shape: "none" },

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
