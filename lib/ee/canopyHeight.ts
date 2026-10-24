/**
 * Meta and WRI global canopy height on Earth Engine: the picture and numbers the canopy-height layer draws and reads
 * (docs/top-10-use-cases.md T09). Tolan et al., Remote Sensing of Environment (2024); CC BY 4.0.
 *
 * Asset (read 2026-10-23 with the project's credentials): `projects/meta-forest-monitoring-okw37/assets/CanopyHeight`,
 * an IMAGE_COLLECTION of 170 tiles, one band `cover_code`: the height of the top of the canopy in whole metres at about
 * 1 m, from Maxar imagery mostly 2018 to 2020 (0 where there is no canopy). Zoomed out Earth Engine reads its pyramid,
 * which averages; the medians it gives at a 30 to 600 m grid match a native 1 m random sample within a metre or two
 * (checked over the Smokies, Mount Hood, Bend, the Hoh and the Colorado Rockies), while the tallest reading comes out a
 * few metres low, so the note names the grid. The model is known to read low in very tall forest (the Hoh's sampled
 * 1 m maximum was 51 m where Sitka spruce reach 70 to 90 m).
 */
import { call, gte, loadCollection, mosaic, point, rectangle, reduceRegion, select, updateMask, visualize, type EeNode } from "./expr";
import { OFF_WHITE, PURPLE, SAGE } from "@/lib/render/palette";
import { hexToRgb, rgbToHex, type Rgb } from "@/lib/render/ramp";
import type { BBox } from "@/layers/types";

export const CANOPY_COLLECTION = "projects/meta-forest-monitoring-okw37/assets/CanopyHeight";
export const CANOPY_BAND = "cover_code";
/** A pixel this tall or taller is a tree (the usual forest definition, and the ramp's first step). */
export const TREE_M = 5;
/** The ramp's top: everything taller draws the darkest purple. */
export const TOP_M = 50;
/** Pixels lower than this are open ground and left clear, so the map under them shows. */
export const GROUND_M = 1;
/** The height drawn in plain sage, the middle of the ramp. */
export const SAGE_M = 30;

/** Straight RGB blend of two colors: sage to purple through a grey lavender, never the cyan an OKLCH hue turn passes. */
function blend(a: string, b: string, t: number): string {
  const [x, y] = [hexToRgb(a), hexToRgb(b)];
  return rgbToHex(x.map((c, i) => Math.round(c + (y[i] - c) * t)) as Rgb);
}

/** The ramp's color at a height (m): off-white under 5 m, sage at 30 m, purple at 50 m and over. */
export function heightColor(m: number): string {
  if (m <= TREE_M) return OFF_WHITE;
  const mid = SAGE_M;
  if (m <= mid) return blend(OFF_WHITE, SAGE, 0.15 + (0.85 * (m - TREE_M)) / (mid - TREE_M));
  return blend(SAGE, PURPLE, (Math.min(m, TOP_M) - mid) / (TOP_M - mid));
}

/** One palette entry per metre from 0 to 50 m, for Earth Engine's visualize. */
export const PALETTE: string[] = Array.from({ length: TOP_M + 1 }, (_, m) => heightColor(m));

export const height = (): EeNode => select(mosaic(loadCollection(CANOPY_COLLECTION)), [CANOPY_BAND]);

/** The height ramp as an RGB picture, open ground clear. */
export function heightTiles(): EeNode {
  const h = height();
  return updateMask(visualize(h, { min: 0, max: TOP_M, palette: PALETTE }), gte(h, GROUND_M));
}

function widthMetres([w, s, e, n]: BBox): number {
  return (e - w) * 111_320 * Math.cos((((s + n) / 2) * Math.PI) / 180);
}

/** The grid (m) the box's heights are read on: about 600 across, never finer than 10 m. */
export function statsScale(bbox: BBox): number {
  return Math.max(10, Math.round(widthMetres(bbox) / 600));
}

/**
 * The median, 90th percentile and tallest canopy over the tree pixels (5 m and taller) in the box, and the share of the
 * box with trees, in one request: keys `h_p50`, `h_p90`, `h_p100` and `treeShare`.
 */
export function statsExpression(bbox: BBox): EeNode {
  const h = height();
  const region = rectangle(bbox);
  const scale = statsScale(bbox);
  const percentiles = call("Image.reduceRegion", {
    image: updateMask(call("Image.rename", { input: h, names: ["h"] }), gte(h, TREE_M)),
    reducer: call("Reducer.percentile", { percentiles: [50, 90, 100] }),
    geometry: region,
    scale,
    maxPixels: 2e6,
    bestEffort: true,
  });
  const share = reduceRegion(call("Image.rename", { input: gte(h, TREE_M), names: ["treeShare"] }), region, "mean", { scale, maxPixels: 2e6, bestEffort: true });
  return call("Dictionary.combine", { first: percentiles, second: share });
}

export type CanopyStats = { medianM: number; p90M: number; maxM: number; treeShare: number } | { medianM: null; p90M: null; maxM: null; treeShare: number };

export function readStats(result: Record<string, unknown> | null | undefined): CanopyStats | null {
  if (!result) return null;
  const share = typeof result.treeShare === "number" ? result.treeShare : null;
  if (share === null) return null;
  const n = (k: string) => (typeof result[k] === "number" ? Math.round(result[k] as number) : null);
  const [p50, p90, p100] = [n("h_p50"), n("h_p90"), n("h_p100")];
  if (p50 === null || p90 === null || p100 === null) return { medianM: null, p90M: null, maxM: null, treeShare: share };
  return { medianM: p50, p90M: p90, maxM: p100, treeShare: share };
}

/** The canopy height at one point, at the data's own 1 m. */
export function pointExpression(lon: number, lat: number): EeNode {
  return reduceRegion(height(), point(lon, lat), "first", { scale: 1 });
}

export function readPoint(result: Record<string, unknown> | null | undefined): number | null {
  const v = result?.[CANOPY_BAND];
  return typeof v === "number" ? v : null;
}

export const TILE_QUERY = "view=height&v=1";
export const TILE_KEY = "canopy-height:height:v1";

export function parseTileQuery(q: URLSearchParams): true | null {
  return q.get("view") === "height" && q.get("v") === "1" ? true : null;
}
