/**
 * Tree height from Meta and the World Resources Institute's global canopy height map (Tolan et al., Remote Sensing of
 * Environment 2024; CC BY 4.0): the height of the top of the canopy at about 1 m everywhere on land, from Maxar imagery
 * mostly taken 2018 to 2020.
 *
 * Served through Google Earth Engine (lib/ee/canopyHeight.ts): the map draws a ramp from off-white (under 5 m) through
 * sage to purple (50 m and taller) through our own tile route, open ground left clear. The coverage note gives the
 * median, 90th percentile and tallest canopy of the tree pixels in the box asked and the share of the box under trees;
 * a tap reads the height at the point.
 */
import { z } from "zod";
import { defineLayer, type FieldHelp, type LayerError, type LayerResult, type LegendSpec } from "./types";
import { registerLayer } from "./registry";
import { pointFeature } from "./_shared/identify";
import { createEeClient, EeError, type EeClient } from "@/lib/ee/client";
import { GROUND_M, heightColor, SAGE_M, pointExpression, readPoint, readStats, statsExpression, statsScale, TILE_QUERY, TOP_M, TREE_M, type CanopyStats } from "@/lib/ee/canopyHeight";
import { eeTileTemplate } from "@/lib/ee/tiles";
import { layerColor, SAGE } from "@/lib/render/palette";
import type { BBox } from "./types";

const CITATION_SOURCE = "Global canopy height 1 m, Meta and World Resources Institute (CC BY 4.0); Tolan et al., Remote Sensing of Environment (2024); via Google Earth Engine";
const CITATION_URL = "https://doi.org/10.1016/j.rse.2023.113888";
const CITATION_LABEL = "Meta and WRI (canopy height, CC BY 4.0)";
const LICENSE = "CC BY 4.0 (Meta and World Resources Institute; Tolan et al., Remote Sensing of Environment 2024)";
const IMAGERY = "imagery mostly 2018 to 2020";

const FT_PER_M = 3.28084;
const ft = (m: number) => Math.round(m * FT_PER_M);
/** "56 ft (17 m)" in the US, "17 m (56 ft)" elsewhere. */
export const heightText = (m: number, us: boolean) => (us ? `${ft(m)} ft (${Math.round(m)} m)` : `${Math.round(m)} m (${ft(m)} ft)`);

const stop = (m: number, label: string) => ({ label, value: m, color: heightColor(m) });

export const LEGEND: LegendSpec = {
  kind: "ramp",
  title: "Canopy height",
  field: "heightM",
  unit: "m",
  stops: [
    stop(TREE_M, `Under ${TREE_M} m (${ft(TREE_M)} ft)`),
    stop(15, `15 m (${ft(15)} ft)`),
    stop(SAGE_M, `${SAGE_M} m (${ft(SAGE_M)} ft)`),
    stop(40, `40 m (${ft(40)} ft)`),
    stop(TOP_M, `${TOP_M} m (${ft(TOP_M)} ft) and taller`),
  ],
  note: `Height of the top of the canopy at about 1 m; open ground under ${GROUND_M} m is left clear. Meta and WRI model, ${IMAGERY}.`,
};

const US_BOX: BBox = [-170, 18, -65, 72];
const inUs = ([w, s, e, n]: BBox) => {
  const [x, y] = [(w + e) / 2, (s + n) / 2];
  return x >= US_BOX[0] && x <= US_BOX[2] && y >= US_BOX[1] && y <= US_BOX[3];
};

/** The note's sentence on the trees in a box. */
export function statsSentence(stats: CanopyStats, us: boolean, scale: number): string {
  const share = `${Math.round(stats.treeShare * 100)}%`;
  if (stats.medianM === null) return `no trees ${TREE_M} m (${ft(TREE_M)} ft) or taller in the box (${share})`;
  return (
    `trees (canopy ${heightText(TREE_M, us)} or taller) cover ${share} of the box; their canopy is median ${heightText(stats.medianM, us)} tall, ` +
    `90th percentile ${heightText(stats.p90M, us)}, tallest reading ${heightText(stats.maxM, us)} (heights read on a ${scale} m grid)`
  );
}

const inputSchema = z.object({
  /** The place the box stands for, repeated in the note. */
  place: z.string().max(80).optional(),
});

const FIELD_HELP: Record<string, FieldHelp> = {
  height: { text: "Height of the top of the tree canopy at this point, from a model that reads satellite images at about 1 m.", unit: "m and ft", source: "Meta and WRI global canopy height", url: CITATION_URL },
  imagery: { text: "When the satellite images behind this map were taken; trees cut or burned since then still show.", source: "Meta and WRI global canopy height", url: CITATION_URL },
};

const failure = (error: unknown): LayerError => {
  if (error instanceof EeError) {
    const unset = /not set up/.test(error.sourceStatus.message);
    return { error: error.sourceStatus.message, hint: unset ? "unavailable" : "upstream", sourceStatus: error.sourceStatus };
  }
  return { error: String(error), hint: "upstream" };
};

const client = (env: Record<string, string | undefined>): EeClient => createEeClient({ env });

const canopyHeight = defineLayer({
  id: "canopy-height",
  title: "Canopy height",
  description:
    "How tall the trees are anywhere on land, about 1 m, from Meta and WRI's global canopy height map (a model reading satellite images mostly 2018 to 2020). " +
    "Use it for how tall the trees are, tree height and where the tallest forest is. " +
    "The coverage note gives the median, 90th percentile and tallest canopy of the trees (5 m and taller) in the box in feet and metres, and the share of the box under trees: quote those numbers; place names the place the box stands for. " +
    "It reads low in very tall forest (over about 40 m). " +
    "Returns map tiles drawn on the globe, not features you can count or list.",
  coverage: "global",
  surface: "land",
  license: LICENSE,
  requiredEnv: ["EE_PROJECT"],
  optionalEnv: ["EE_SERVICE_ACCOUNT_JSON", "GOOGLE_APPLICATION_CREDENTIALS"],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("canopy-height"), unit: "m", raster: { saturation: 0, opacity: 0.85, swatch: SAGE } },
  legend: LEGEND,
  fieldHelp: FIELD_HELP,
  card: {
    facts: [
      { key: "height", label: "Canopy height" },
      { key: "imagery", label: "Imagery" },
    ],
    hidden: ["heightM"],
  },
  time: { shape: "none" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const citation = { source: CITATION_SOURCE, url: CITATION_URL, retrieved: new Date().toISOString(), label: CITATION_LABEL };
    let stats: CanopyStats | null;
    try {
      stats = readStats(await client(ctx.env).compute(statsExpression(ctx.bbox)));
    } catch (error) {
      return failure(error);
    }
    const where = input.place ? `in the box asked for ${input.place}` : "in the box asked";
    const body = stats ? statsSentence(stats, inUs(ctx.bbox), statsScale(ctx.bbox)) : "no canopy data in the box (sea, or outside the map)";
    return {
      kind: "tiles",
      data: { url: eeTileTemplate("canopy-height", TILE_QUERY), minzoom: 3, maxzoom: 17, format: "raster" },
      citation,
      coverageNote: `Meta and WRI canopy height (1 m, ${IMAGERY}) ${where}: ${body}. The model reads low in very tall forest`,
      legend: LEGEND,
    };
  },

  async identify(ctx, at) {
    try {
      const m = readPoint(await client(ctx.env).compute(pointExpression(at.lon, at.lat)));
      if (m === null) return null;
      const us = inUs([at.lon, at.lat, at.lon, at.lat]);
      const tree = m >= TREE_M;
      return pointFeature(at, {
        name: m < GROUND_M ? "Open ground" : tree ? `Trees ${heightText(m, us)} tall` : `Low canopy ${heightText(m, us)}`,
        heightM: m,
        height: heightText(m, us),
        imagery: "Mostly 2018 to 2020",
      });
    } catch (error) {
      return failure(error);
    }
  },
});

registerLayer(canopyHeight);

export default canopyHeight;
