/**
 * Tree cover loss tiles from Global Forest Watch (UMD / Hansen et al., via the GFW tile cache).
 * Tile route (verified 2026-10-09 against https://tiles.globalforestwatch.org/openapi.json):
 *   https://tiles.globalforestwatch.org/umd_tree_cover_loss/latest/dynamic/{z}/{x}/{y}.png
 *     ?render_type=true_color&start_year=S&end_year=E&tree_cover_density_threshold=T
 * Notes from live requests:
 *   - Without `render_type=true_color` the route returns an *encoded* tile (year and intensity packed into
 *     the color channels, meant for GFW's own decoder) and ignores the year and threshold filters, so
 *     it looks like red noise on a map. `true_color` returns pink loss pixels, transparent elsewhere.
 *   - The threshold parameter is `tree_cover_density_threshold` (the brief's `tcd` is silently ignored).
 *     Accepted values: 0, 10, 15, 20, 25, 30, 50, 75, 90. Years run 2001 to 2025; 2026 returns 422.
 *   - `latest` answers 307 to the current version (v1.13 at time of writing); fetch and Mapbox follow it.
 *   - Tiles are 512 x 512 PNG, served at z 0 to 22 (z 3 to 16 tested; loss is 30 m so z 12 is plenty).
 * No upstream call is made by the layer: it only builds the URL for the map to fetch.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { FOREST_LOSS_LATEST_YEAR } from "@/lib/time";

const TILE_BASE = "https://tiles.globalforestwatch.org/umd_tree_cover_loss/latest/dynamic/{z}/{x}/{y}.png";

const inputSchema = z.object({
  startYear: z.number().int().min(2001).default(2015),
  endYear: z.number().int().max(FOREST_LOSS_LATEST_YEAR).default(FOREST_LOSS_LATEST_YEAR),
  canopyThreshold: z.enum(["10", "20", "30", "50", "75"]).default("30"),
});

/** The raster tile template for loss between two years, counting only pixels with at least this much canopy in 2000. */
export function lossTileUrl(startYear: number, endYear: number, canopyThreshold: string): string {
  return (
    `${TILE_BASE}?render_type=true_color&start_year=${startYear}&end_year=${endYear}` +
    `&tree_cover_density_threshold=${canopyThreshold}`
  );
}

const forestLoss = defineLayer({
  id: "forest-loss",
  title: "Tree cover loss",
  description:
    "Global map of where tree cover was lost, drawn as pink 30 m pixels from the University of Maryland / Global Forest Watch dataset. " +
    "It is yearly data: each pixel marks a year (2001 to 2025) in which trees were lost, and startYear (default 2015) and endYear (default 2025) pick the range shown. " +
    "canopyThreshold (10, 20, 30, 50 or 75; default 30) is the minimum tree canopy percent in the year 2000 for a pixel to count, so a higher number shows only denser forest. " +
    "Use it to show where forest has disappeared, anywhere in the world. " +
    "Caveats: loss means the tree canopy was removed or died, for any reason: logging, farming, wildfire, storms, plantation harvest, development. " +
    "It does not by itself mean illegal clearing, deforestation or logging, and regrowth is not subtracted. " +
    "Loss is detected once a year, so the newest year is usually published a few months after it ends. " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms. " +
    "Works at any size of region, from the whole world down to a few kilometres.",
  coverage: "global",
  license: "CC BY 4.0 (Hansen/UMD/Google/USGS/NASA via GFW)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: "#E1498C" },

  async query(_ctx, input): Promise<LayerResult | LayerError> {
    if (input.startYear > input.endYear) {
      return { error: `startYear (${input.startYear}) must not be after endYear (${input.endYear})` };
    }
    return {
      kind: "tiles",
      data: {
        url: lossTileUrl(input.startYear, input.endYear, input.canopyThreshold),
        minzoom: 3,
        maxzoom: 12,
        format: "raster",
        tileSize: 512,
      },
      citation: {
        source:
          "Hansen/UMD/Google/USGS/NASA tree cover loss via Global Forest Watch (CC BY 4.0). " +
          "Hansen et al., Science 342 (2013), updated yearly",
        url: "https://www.globalforestwatch.org/",
        retrieved: new Date().toISOString(),
      },
    };
  },
});

registerLayer(forestLoss);

export default forestLoss;
