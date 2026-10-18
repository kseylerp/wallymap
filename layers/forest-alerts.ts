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
 *   - Colors (checked 2026-10-18 over Rondonia z8): low confidence light pink (237,164,194), high pink (220,102,153), highest
 *     (several systems agree) deep pink (201,42,109); alpha drops for isolated pixels at low zoom. Drawn as served.
 *   - end_date={date} in the template lets the time scrubber move the window's end between its start and today, so
 *     playing it adds alerts week by week (audit 2026-10-17: a fixed 90 days with no way to tell July from yesterday).
 * No upstream call is made by the layer: it only builds the URL for the map to fetch.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult, type LegendSpec } from "./types";
import { registerLayer } from "./registry";
import { layerColor } from "@/lib/render/palette";

const TILE_BASE = "https://tiles.globalforestwatch.org/gfw_integrated_alerts/latest/dynamic/{z}/{x}/{y}.png";

const DAY_MS = 86_400_000;

const OUTSIDE_TROPICS_NOTE =
  "Alerts cover the tropics only (about 30°S to 30°N), so the part of this view outside them is empty; " +
  "for recent clearing there query disturbance (worldwide), and forest-loss for yearly loss";

const inputSchema = z.object({
  /** How many days of alerts up to today to show. */
  days: z.number().int().min(7).max(365).default(90),
});

/** The raster tile template for alerts from `startDate` up to `endDate` (YYYY-MM-DD, or `{date}` for the scrubber). */
export function alertTileUrl(startDate: string, endDate?: string): string {
  return `${TILE_BASE}?render_type=true_color&start_date=${startDate}${endDate ? `&end_date=${endDate}` : ""}`;
}

/** The three confidence shades GFW draws (the tiles' own colors). */
export const LEGEND: LegendSpec = {
  kind: "categories",
  title: "Forest disturbance alert",
  items: [
    { label: "Highest confidence (several systems agree)", color: "#C92A6D", symbol: "raster" },
    { label: "High confidence", color: "#DC6699", symbol: "raster" },
    { label: "Low confidence (one sighting)", color: "#EDA4C2", symbol: "raster" },
  ],
  note: "Each pixel is 10 to 30 m, so zoom in to a forest to see them; paler at low zoom where alerts are scattered.",
};

const forestAlerts = defineLayer({
  id: "forest-alerts",
  title: "Forest disturbance alerts",
  description:
    "Recent forest disturbance alerts from Global Forest Watch's integrated alert system, drawn as pink pixels (10 to 30 m) on the tropical forest. " +
    "Satellites compare new images with older ones and flag places where tree cover just changed; the map shows alerts from the last days (default 90, 7 to 365) up to today, in three shades: deep pink where several systems agree, pink for high and light pink for low confidence. The time scrubber moves the window's end, so playing it shows the alerts appear. " +
    "It is weekly data: alerts are added about once a week and can lag the satellite pass by several days up to a couple of weeks. " +
    "Use it to show where forest is being cleared or damaged right now in the tropics (Amazon, Congo Basin, Southeast Asia, Central America, and so on). " +
    "Caveats: an alert means tree cover changed, not that the cause is logging; it can also be fire, storm damage, floods, mining or farming. " +
    "Some alerts are false positives, especially under clouds, and confidence is mixed. " +
    "Coverage is the tropics only (about 30°S to 30°N); nothing is available for Europe, North America or higher latitudes (for fresh clearing anywhere else use disturbance, which is worldwide; for yearly loss use forest-loss). " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms. " +
    "Works at any size of region; it is most useful zoomed in to a forest area.",
  coverage: { bbox: [-180, -30, 180, 30] },
  surface: "land",
  license: "CC BY 4.0 (GFW integrated alerts: UMD GLAD, WUR RADD)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  // GFW's pinks as served, at full strength: the alerts are single small pixels and fade into the basemap otherwise.
  style: { geometry: "polygon", color: layerColor("forest-alerts"), raster: { saturation: 0, opacity: 1, swatch: "#DC6699" } },
  legend: LEGEND,
  time: { shape: "continuous", step: "day" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    // A box wholly outside the tropics holds no alerts: say so and name the layer that does cover it, instead of drawing
    // an empty layer ("where has forest just been cleared in British Columbia?" ended on one).
    if (ctx.bbox[1] > 30 || ctx.bbox[3] < -30) {
      return { error: `No forest alerts here: they cover the tropics only (about 30°S to 30°N). For recent clearing here query disturbance (worldwide).`, hint: "unavailable" };
    }
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const startDate = new Date(now.getTime() - (input.days - 1) * DAY_MS).toISOString().slice(0, 10);
    const notes = [`Alerts from ${startDate} to ${today}`];
    if (ctx.bbox[1] < -30 || ctx.bbox[3] > 30) notes.push(OUTSIDE_TROPICS_NOTE);
    return {
      kind: "tiles",
      data: {
        url: alertTileUrl(startDate, today),
        minzoom: 3,
        maxzoom: 12,
        format: "raster",
        time: { template: alertTileUrl(startDate, "{date}"), cadence: "daily", from: startDate, to: today, daysBack: 0 },
      },
      citation: {
        source: "Global Forest Watch integrated deforestation alerts (UMD GLAD-L/S2 and WUR RADD; CC BY 4.0)",
        url: "https://www.globalforestwatch.org/",
        retrieved: now.toISOString(),
      },
      coverageNote: notes.join("; "),
    };
  },
});

registerLayer(forestAlerts);

export default forestAlerts;
