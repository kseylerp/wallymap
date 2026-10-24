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
 *   - true_color draws loss pink (228,70,146), fainter where a pixel holds less loss at the zoom (alpha), checked 2026-10-18
 *     over Rondonia z8; the tiles draw as served so the key's color is the map's.
 * The map fetches the tiles itself. The numbers (km² lost per year, by driver, in the asked state or country's outline
 * when the box is one, else in the box) come from Earth Engine (lib/ee/forestLoss.ts) when it is set up here
 * (EE_PROJECT); without it, or when it fails, the layer still draws and says the totals are missing.
 */
import { z } from "zod";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult, type LegendSpec } from "./types";
import { registerLayer } from "./registry";
import { FOREST_LOSS_LATEST_YEAR } from "@/lib/time";
import { layerColor } from "@/lib/render/palette";
import { createEeClient, EeError } from "@/lib/ee/client";
import {
  boxLossExpression,
  driverShares,
  haText,
  km2Text,
  lossScale,
  matchRegion,
  MIN_MATCH_KM2,
  readLoss,
  readRegions,
  regionLossExpression,
  regionsExpression,
  topYears,
  type LossTotals,
  type Region,
} from "@/lib/ee/forestLoss";

/** One color: GFW's loss pink (the tiles' own). */
export const LEGEND: LegendSpec = {
  kind: "categories",
  title: "Tree cover loss",
  items: [{ label: "Tree cover lost in the years shown", color: "#E44692", symbol: "raster", help: "Canopy removed or killed, for any reason (logging, farming, fire, storms, harvest)." }],
  note: "Paler where only part of the area was lost at this zoom; regrowth is not subtracted.",
};

const TILE_BASE = "https://tiles.globalforestwatch.org/umd_tree_cover_loss/latest/dynamic/{z}/{x}/{y}.png";

const inputSchema = z.object({
  startYear: z.number().int().min(2001).default(2015),
  endYear: z.number().int().max(FOREST_LOSS_LATEST_YEAR).default(FOREST_LOSS_LATEST_YEAR),
  canopyThreshold: z.enum(["10", "20", "30", "50", "75"]).default("30"),
});

/** The raster tile template for loss between two years, counting only pixels with at least this much canopy in 2000. */
export function lossTileUrl(startYear: number, endYear: number | "{year}", canopyThreshold: string): string {
  return (
    `${TILE_BASE}?render_type=true_color&start_year=${startYear}&end_year=${endYear}` +
    `&tree_cover_density_threshold=${canopyThreshold}`
  );
}

/** The totals and where they were summed: a matched state or country, or the box. */
export type LossAnswer = { totals: LossTotals; region: Region | null; scaleM: number };

/**
 * Sums loss over the region the box stands for (a state, province or country, from geoBoundaries) or else the box.
 * The region match and the box sums run together; a match adds one more sum over its outline.
 */
export async function lossTotals(env: Record<string, string | undefined>, bbox: BBox, startYear: number, endYear: number, threshold: number): Promise<LossAnswer | null> {
  const ee = createEeClient({ env });
  const tryMatch = bboxAreaKm2(bbox) >= MIN_MATCH_KM2;
  const [box, adm1, adm0] = await Promise.all([
    ee.compute(boxLossExpression(bbox, startYear, endYear, threshold)),
    tryMatch ? ee.compute(regionsExpression("ADM1", bbox)).catch(() => null) : null,
    tryMatch ? ee.compute(regionsExpression("ADM0", bbox)).catch(() => null) : null,
  ]);
  const region = tryMatch ? matchRegion([...readRegions("ADM0", adm0), ...readRegions("ADM1", adm1)]) : null;
  if (region) {
    const inRegion = await ee.compute(regionLossExpression(region.level, region.id, region.areaKm2, startYear, endYear, threshold)).catch(() => null);
    const totals = readLoss(inRegion, startYear, endYear);
    if (totals) return { totals, region, scaleM: lossScale(region.areaKm2) };
  }
  const totals = readLoss(box, startYear, endYear);
  return totals ? { totals, region: null, scaleM: lossScale(bboxAreaKm2(bbox)) } : null;
}

/** The note's sentence: how much was lost, where, in which years most, and what drove it. */
export function totalsSentence(a: LossAnswer, startYear: number, endYear: number, threshold: string): string {
  const t = a.totals;
  const where = a.region ? `in ${a.region.name} (${a.region.level === "ADM0" ? "the country's" : "the state or province's"} outline)` : "in the box asked";
  const share = t.forestKm2 > 0 ? `, ${((100 * t.totalKm2) / t.forestKm2).toFixed(1)}% of the ${km2Text(t.forestKm2)} with at least ${threshold}% canopy in 2000` : "";
  const years = topYears(t)
    .map((y) => `${y.year} ${km2Text(y.km2)}`)
    .join(", ");
  const drivers = driverShares(t)
    .map((d) => `${d.driver.label.toLowerCase()} ${Math.round(d.share * 100)}% (${km2Text(d.km2)})`)
    .join(", ");
  return (
    `Tree cover lost ${startYear}–${endYear} ${where}: about ${km2Text(t.totalKm2)} (${haText(t.totalKm2)})${share}` +
    (years ? `; most in ${years}` : "") +
    (drivers ? `; what drove it (WRI and Google DeepMind drivers of forest loss, the dominant driver of each 1 km cell): ${drivers}` : "") +
    `; estimated from Hansen v1.13 on a ${a.scaleM} m grid`
  );
}

/** The key with the total on it and the drivers under it, when the totals are known. */
function totalsLegend(a: LossAnswer, startYear: number, endYear: number): LegendSpec {
  const drivers = driverShares(a.totals);
  const top = drivers.slice(0, 3).map((d) => `${d.driver.label.toLowerCase()} ${Math.round(d.share * 100)}%`);
  return {
    ...LEGEND,
    title: `Tree cover loss ${startYear}–${endYear}`,
    items: [{ ...LEGEND.items![0], label: `Lost ${startYear}–${endYear}: ${km2Text(a.totals.totalKm2)}${a.region ? ` in ${a.region.name}` : " in the box asked"}` }],
    note: (top.length > 0 ? `Driven by ${top.join(", ")} (WRI and Google DeepMind). ` : "") + LEGEND.note,
  };
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
    "Loss is detected once a year, so the newest year is usually published a few months after it ends; for what was cleared just now (the last days or weeks) use forest-alerts in the tropics or disturbance anywhere. " +
    "Returns map tiles drawn on the globe, not features you can list; the coverage note gives the numbers: km² and hectares lost in the years asked, the share of the year-2000 forest, the years with most loss, and what drove it (WRI and Google DeepMind's drivers of forest loss: permanent agriculture, hard commodities such as mining, shifting cultivation, logging, wildfire, settlements, other natural disturbances). " +
    "When the box is one state, province or country, the numbers are for its outline and name it; else for the box. Quote those numbers and drivers; never name a driver the note does not give. " +
    "Works at any size of region, from the whole world down to a few kilometres.",
  coverage: "global",
  surface: "land",
  license: "CC BY 4.0 (Hansen/UMD/Google/USGS/NASA via GFW; drivers of loss WRI and Google DeepMind; outlines geoBoundaries)",
  requiredEnv: [],
  // Earth Engine for the totals (lib/ee): the service account key in production, local gcloud credentials in dev.
  optionalEnv: ["EE_PROJECT", "EE_SERVICE_ACCOUNT_JSON", "GOOGLE_APPLICATION_CREDENTIALS"],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("forest-loss"), raster: { saturation: 0, opacity: 0.9, swatch: "#E44692" } },
  legend: LEGEND,
  time: { shape: "continuous", step: "year" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    if (input.startYear > input.endYear) {
      return { error: `startYear (${input.startYear}) must not be after endYear (${input.endYear})` };
    }
    const drawn = `Tree cover lost ${input.startYear}–${input.endYear}, where canopy was at least ${input.canopyThreshold}% in 2000`;
    // The totals need Earth Engine; it is asked only where it is set up (EE_PROJECT), and a failure keeps the picture.
    let answer: LossAnswer | null = null;
    let missing: string | null = null;
    if (ctx.env.EE_PROJECT) {
      try {
        answer = await lossTotals(ctx.env, ctx.bbox, input.startYear, input.endYear, Number(input.canopyThreshold));
        if (!answer) missing = "Earth Engine returned no totals";
      } catch (error) {
        missing = error instanceof EeError ? error.sourceStatus.message : "Earth Engine did not answer";
      }
    }
    const coverageNote = answer
      ? totalsSentence(answer, input.startYear, input.endYear, input.canopyThreshold)
      : missing
        ? `${drawn}; the areas lost and their drivers could not be computed (${missing}), so give no numbers`
        : drawn;
    return {
      kind: "tiles",
      data: {
        url: lossTileUrl(input.startYear, input.endYear, input.canopyThreshold),
        minzoom: 3,
        maxzoom: 12,
        format: "raster",
        tileSize: 512,
        time: {
          template: lossTileUrl(input.startYear, "{year}", input.canopyThreshold),
          cadence: "yearly",
          // The scrubber spans the years asked for, so its window and the row's "lost 2015–2025" agree.
          from: String(input.startYear),
          to: String(FOREST_LOSS_LATEST_YEAR),
        },
      },
      citation: {
        source:
          "Hansen/UMD/Google/USGS/NASA tree cover loss via Global Forest Watch (CC BY 4.0). " +
          "Hansen et al., Science 342 (2013), updated yearly" +
          (answer ? "; drivers of forest loss v1.3, WRI and Google DeepMind (CC BY 4.0); region outlines geoBoundaries (CC BY 4.0); totals via Google Earth Engine" : ""),
        url: "https://www.globalforestwatch.org/",
        retrieved: new Date().toISOString(),
      },
      // The years and canopy drawn, so the row says what the map holds (audit 2026-10-17), and the totals when known.
      coverageNote,
      ...(answer && { legend: totalsLegend(answer, input.startYear, input.endYear) }),
    };
  },
});

registerLayer(forestLoss);

export default forestLoss;
