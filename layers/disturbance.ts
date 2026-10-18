/**
 * Vegetation disturbance alerts (where plant cover was just lost), worldwide, from the UMD GLAD DIST-ALERT product
 * (built on NASA OPERA's land surface disturbance alerts from Landsat and Sentinel-2, 30 m) as Global Forest Watch serves it.
 *
 * Source since 2026-10-18 (verified live ~06:40 UTC): GFW tile cache, keyless,
 *   https://tiles.globalforestwatch.org/umd_glad_dist_alerts/latest/dynamic/{z}/{x}/{y}.png
 *     ?render_type=true_color&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 *   - `latest` answers 307 to the newest version (v20261017 that day). true_color draws alert pixels pink, darker for
 *     high confidence, transparent everywhere else; tiles are 256 px. Jaru, Rondonia z8 (30 days): 101 alert pixels;
 *     northern California z8: 97; Oregon z7: 316, so it covers the temperate zone too, unlike forest-alerts.
 *   - One URL holds every alert between start_date and end_date, so the map shows a window (default the last 30 days)
 *     instead of one patchy satellite day.
 *   - The newest alert day is the latest version's date, read from the GFW data API (cached 6 hours):
 *     https://data-api.globalforestwatch.org/dataset/umd_glad_dist_alerts -> data.versions [..., "v20261017"]. GFW
 *     publishes a version about weekly and keeps the most recent two years of alerts.
 * Replaced: NASA GIBS OPERA_L3_DIST-ALERT-HLS_Color_Index (daily single-day swaths). GIBS draws its "no disturbance"
 * class near-black and its finished classes grey and white, all opaque, so on a day with imagery the map was covered
 * in dark squares (audit 2026-10-17), and its archive ended a week behind the 3-day lag the layer assumed.
 * The layer makes one small metadata call; the map fetches the tiles itself.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult, type LegendSpec, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { DAY_MS, dateInput, isoDay, resolveTileDate } from "./_shared/dated-tiles";
import { layerColor } from "@/lib/render/palette";

const TILE_BASE = "https://tiles.globalforestwatch.org/umd_glad_dist_alerts/latest/dynamic/{z}/{x}/{y}.png";
export const VERSIONS_URL = "https://data-api.globalforestwatch.org/dataset/umd_glad_dist_alerts";
/** GFW keeps about two years of alerts. */
const KEEP_DAYS = 730;
/** Used when the data API does not say: GFW publishes about weekly. */
const FALLBACK_LAG_DAYS = 7;

const inputSchema = z.object({
  /** Last day of alerts shown (YYYY-MM-DD); defaults to the newest GFW has published. */
  date: dateInput,
  /** How many days of alerts up to `date` to show. */
  days: z.number().int().min(1).max(365).default(30),
  /** `high` keeps only alerts confirmed over several satellite passes. */
  confidence: z.enum(["all", "high"]).default("all"),
});

/** The tile URL for alerts from `start` to `end` (YYYY-MM-DD, or `{date}` for the scrubber). */
export function distTileUrl(start: string, end: string, confidence: "all" | "high"): string {
  return `${TILE_BASE}?render_type=true_color&start_date=${start}&end_date=${end}${confidence === "high" ? "&alert_confidence=high" : ""}`;
}

/** "v20261017" → "2026-10-17": the newest version's date from the data API's dataset answer, or null. */
export function newestVersionDay(body: unknown): string | null {
  const versions = (body as { data?: { versions?: unknown } } | null)?.data?.versions;
  if (!Array.isArray(versions)) return null;
  const days = versions
    .filter((v): v is string => typeof v === "string" && /^v\d{8}$/.test(v))
    .map((v) => `${v.slice(1, 5)}-${v.slice(5, 7)}-${v.slice(7, 9)}`)
    .sort();
  return days.length > 0 ? days[days.length - 1] : null;
}

async function newestDay(ctx: QueryContext): Promise<string | null> {
  try {
    const res = await ctx.fetch(VERSIONS_URL, {
      cacheKey: "disturbance:gfw-versions",
      ttlSeconds: 6 * 3_600,
      validate: (body) => body.includes("versions"),
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    if (!res.ok) return null;
    return newestVersionDay(await res.json());
  } catch {
    return null;
  }
}

/** GFW's two true-color shades: darker pink for alerts confirmed over several passes, lighter for a first sighting. */
export const LEGEND: LegendSpec = {
  kind: "categories",
  title: "Vegetation loss alert",
  items: [
    { label: "Confirmed (high confidence)", color: "#DC6699", symbol: "raster", help: "Loss seen again on later satellite passes." },
    { label: "Possible (low confidence)", color: "#EDA4C2", symbol: "raster", help: "Loss seen once so far; may be cloud, harvest or a passing change." },
  ],
  note: "Each pixel is 30 m; transparent where no loss was seen in the days shown. Fainter pixels are smaller patches at this zoom.",
};

const disturbance = defineLayer({
  id: "disturbance",
  title: "Vegetation disturbance alerts",
  description:
    "Global alerts for places where vegetation was just lost or damaged, from the University of Maryland GLAD DIST-ALERT product built on NASA's OPERA land disturbance alerts (Landsat and Sentinel-2, 30 m), served by Global Forest Watch. " +
    "A pixel is flagged when plant cover drops sharply compared with its usual seasonal level; the map draws every alert in a window of days (default the last 30, days 1 to 365) ending on date, pink where vegetation was lost (darker when confirmed by later passes, lighter for a first sighting) and transparent elsewhere. " +
    "date (YYYY-MM-DD) is the window's last day and defaults to the newest GFW has published (GFW updates it weekly, so the newest alerts are a few days to a week old); confidence 'high' keeps only confirmed alerts. The time scrubber moves the window's end, so playing it shows the alerts appear day by day. GFW keeps about the last two years. " +
    "Use it for 'where was vegetation lost recently', 'new clearing', 'burn scar appearing', 'storm or flood damage to forest', 'is this forest being cut', a quick look at fresh change anywhere on Earth, including the US, Canada and Europe. " +
    "Example questions: any new forest loss near this Amazon road, did the wildfire strip the vegetation here, where did the hurricane flatten the forest. " +
    "For a yearly picture of tree loss use forest-loss; for confirmed burns use fire-perimeters or burn-severity; in the tropics forest-alerts adds radar alerts that see through cloud. " +
    "Caveats: an alert means vegetation dropped, whatever the cause (logging, fire, flood, drought, crop harvest, mowing, snow), so it does not prove deforestation; cloud and haze delay alerts. " +
    "The result's coverageNote states the days shown. " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms.",
  coverage: "global",
  surface: "land",
  license: "CC BY 4.0 (UMD GLAD DIST-ALERT and NASA OPERA, via Global Forest Watch)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  // GFW's pink is already the palette's hazard tone: drawn as served, so single 30 m pixels stay visible.
  style: { geometry: "polygon", color: layerColor("disturbance"), raster: { saturation: 0, opacity: 0.95, swatch: "#DC6699" } },
  legend: LEGEND,
  time: { shape: "continuous", step: "day" },
  display: { timeZone: "utc" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const now = Date.now();
    const published = await newestDay(ctx);
    const newest = published ?? isoDay(now - FALLBACK_LAG_DAYS * DAY_MS);
    const from = isoDay(Date.parse(`${newest}T00:00:00Z`) - KEEP_DAYS * DAY_MS);
    const choice = resolveTileDate(input.date, { from, to: newest, latestOffsetDays: 0, label: "disturbance alerts" }, now);
    if (!choice.ok) return { error: choice.error };
    const start = isoDay(Math.max(Date.parse(`${from}T00:00:00Z`), Date.parse(`${choice.date}T00:00:00Z`) - (input.days - 1) * DAY_MS));
    const notes = [`Vegetation loss alerts from ${start} to ${choice.date}${input.confidence === "high" ? ", confirmed only" : ""}`];
    if (choice.note) notes.push(choice.note);
    if (published === null) notes.push("GFW did not say its newest day, so it was taken as a week ago");
    return {
      kind: "tiles",
      data: {
        url: distTileUrl(start, choice.date, input.confidence),
        minzoom: 3,
        maxzoom: 12,
        format: "raster",
        // The scrubber moves the window's end from its start to the newest day: playing it adds the alerts day by day.
        time: { template: distTileUrl(start, "{date}", input.confidence), cadence: "daily", from: start, to: newest, daysBack: 0 },
      },
      citation: {
        source: "UMD GLAD DIST-ALERT (Hansen et al.; NASA OPERA DIST-ALERT-HLS) via Global Forest Watch (CC BY 4.0)",
        url: "https://www.globalforestwatch.org/",
        retrieved: new Date(now).toISOString(),
      },
      coverageNote: notes.join("; "),
    };
  },
});

registerLayer(disturbance);

export default disturbance;
