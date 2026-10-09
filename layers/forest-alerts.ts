/**
 * Forest disturbance alerts tiles from Global Forest Watch (GFW integrated deforestation alerts:
 * GLAD-L, GLAD-S2 and RADD, merged). Tile route (verified 2026-10-09 against
 * https://tiles.globalforestwatch.org/openapi.json and live tiles):
 *   https://tiles.globalforestwatch.org/gfw_integrated_alerts/latest/dynamic/{z}/{x}/{y}.png
 *     ?render_type=true_color&start_date=YYYY-MM-DD
 * Notes from live requests:
 *   - The `default` route in the task brief returns a pre-built tile that is almost white (the data is
 *     encoded in the color channels for GFW's own decoder) and ignores every query parameter, so it is
 *     not used. `dynamic` with `render_type=true_color` returns pink alert pixels, transparent elsewhere,
 *     and honors `start_date` / `end_date` / `alert_confidence` (low, high, highest).
 *   - Tiles are 256 x 256 PNG. `latest` answers 307 to the current dated version.
 *   - The dataset only has tiles inside the tropics: every tile checked at latitudes above about 30 N
 *     (including Europe, e.g. z6 x33 y21) answers HTTP 500. GFW's separate `gfw_integrated_dist_alerts`
 *     dataset does cover Europe and North America, but it is a different product and is not used here.
 * No upstream call is made by the layer: it only builds the URL for the map to fetch.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";

const TILE_BASE = "https://tiles.globalforestwatch.org/gfw_integrated_alerts/latest/dynamic/{z}/{x}/{y}.png";

/** How far back the alerts shown reach. */
const WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;

const COVERAGE_NOTE =
  "Alerts cover the tropics only (about 30°S to 30°N); there are no alerts here for Europe or North America, " +
  "where this alert set is not published";

/** The raster tile template for alerts on or after `startDate` (YYYY-MM-DD). */
export function alertTileUrl(startDate: string): string {
  return `${TILE_BASE}?render_type=true_color&start_date=${startDate}`;
}

const forestAlerts = defineLayer({
  id: "forest-alerts",
  title: "Forest disturbance alerts",
  description:
    "Recent forest disturbance alerts from Global Forest Watch's integrated alert system, drawn as pink pixels (10 to 30 m) on the tropical forest. " +
    "Satellites compare new images with older ones and flag places where tree cover just changed; the map shows alerts from roughly the last 90 days. " +
    "It is weekly data: alerts are added about once a week and can lag the satellite pass by several days up to a couple of weeks. " +
    "Use it to show where forest is being cleared or damaged right now in the tropics (Amazon, Congo Basin, Southeast Asia, Central America, and so on). " +
    "Caveats: an alert means tree cover changed, not that the cause is logging; it can also be fire, storm damage, floods, mining or farming. " +
    "Some alerts are false positives, especially under clouds, and confidence is mixed. " +
    "Coverage is the tropics only (about 30°S to 30°N); nothing is available for Europe, North America or higher latitudes (use forest-loss for yearly loss anywhere). " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms. " +
    "Works at any size of region; it is most useful zoomed in to a forest area.",
  coverage: { bbox: [-180, -30, 180, 30] },
  license: "CC BY 4.0 (GFW integrated alerts: UMD GLAD, WUR RADD)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: z.object({}),
  style: { geometry: "polygon", color: "#E1498C" },

  async query(): Promise<LayerResult | LayerError> {
    const now = new Date();
    const startDate = new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
    return {
      kind: "tiles",
      data: {
        url: alertTileUrl(startDate),
        minzoom: 3,
        maxzoom: 12,
        format: "raster",
      },
      citation: {
        source: "Global Forest Watch integrated deforestation alerts (UMD GLAD-L/S2 and WUR RADD; CC BY 4.0)",
        url: "https://www.globalforestwatch.org/",
        retrieved: now.toISOString(),
      },
      coverageNote: COVERAGE_NOTE,
    };
  },
});

registerLayer(forestAlerts);

export default forestAlerts;
