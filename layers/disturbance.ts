/**
 * Vegetation disturbance alerts (where plant cover was just lost) raster tiles from NASA GIBS, OPERA DIST-ALERT.
 * Verified 2026-10-09 against https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml:
 *   - OPERA_L3_DIST-ALERT-HLS_Color_Index ("Vegetation Disturbance Status (Color Index, OPERA_L3_DIST-ALERT-HLS)"):
 *     daily, continuous from 2023-01-01 (a few one-day holes) to 2026-10-07; GoogleMapsCompatible_Level12 (zoom 0 to 12),
 *     image/png. Latest day 2026-10-07, so the newest day offered is 3 days back.
 *   - Live check: 2026-10-05 z=9 northern California 200 image/png (4 KB) and Rondonia, Brazil 200 (2 KB);
 *     2026-10-07 Rondonia 200 (23 KB); other day/place combinations were 934-byte near-empty tiles (each place is
 *     covered by an HLS swath only every few days, and tiles with no alert are transparent).
 * No upstream call is made by the layer: it only builds the URL for the map to fetch.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { dateInput } from "./_shared/dated-tiles";
import { gibsDatedResult, type GibsDatedSpec } from "./_shared/gibs-dated";
import { layerColor } from "@/lib/render/palette";

const inputSchema = z.object({ date: dateInput });

export const SPEC: GibsDatedSpec = {
  gibsId: "OPERA_L3_DIST-ALERT-HLS_Color_Index",
  level: 12,
  from: "2023-01-01",
  daysBack: 3,
  cadence: "daily",
  label: "vegetation disturbance alerts",
  citationSource: "NASA GIBS: OPERA Land Surface Disturbance Alert from HLS (Landsat 8/9 + Sentinel-2), NASA JPL OPERA (public)",
};

const disturbance = defineLayer({
  id: "disturbance",
  title: "Vegetation disturbance alerts",
  description:
    "Global near-real-time alerts for places where vegetation was just lost or damaged, from NASA's OPERA land disturbance product built on Landsat and Sentinel-2 images at 30 m. " +
    "A pixel is flagged when plant cover drops sharply compared with its usual seasonal level; colors run from yellow and orange (partial loss, early or provisional alert) to red (heavy loss, or confirmed over several passes), and clear ground stays transparent; the color legend is NASA's 'Vegetation Disturbance Status'. " +
    "It is daily, from 2023 to about 3 days ago; date (YYYY-MM-DD) picks the day and defaults to the newest, and the time scrubber or compare steps through days. Each place is imaged only every few days, so one day shows patchy strips. " +
    "Use it for 'where was vegetation lost recently', 'new clearing', 'burn scar appearing', 'storm or flood damage to forest', 'is this forest being cut', a quick look at fresh change anywhere on Earth. " +
    "Example questions: any new forest loss near this Amazon road, did the wildfire strip the vegetation here, where did the hurricane flatten the forest. " +
    "For a yearly picture of tree loss use forest-loss; for confirmed burns use fire-perimeters or burn-severity. " +
    "Caveats: an alert means vegetation dropped, whatever the cause (logging, fire, flood, drought, harvest, mowing, snow, clouds missed by the filter), so it does not prove deforestation; seasonal die-back and crop harvest can trigger alerts; cloud and haze hide the ground. " +
    "Compare two dates works (pick two dates or years in compare). " +
    "The result's coverageNote states the day shown (and when a date was moved to the newest available). " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms.",
  coverage: "global",
  surface: "land",
  license: "NASA GIBS / OPERA (public)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("disturbance"), raster: { saturation: -0.35, swatch: "#E8503A" } },

  async query(_ctx, input): Promise<LayerResult | LayerError> {
    return gibsDatedResult(SPEC, input.date);
  },
});

registerLayer(disturbance);

export default disturbance;
