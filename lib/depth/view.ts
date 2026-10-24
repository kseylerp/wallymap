import type { BBox } from "@/layers/types";
import { DARK_GREY, OFF_WHITE } from "@/lib/render/palette";
import { hexToRgb, rampColor, type Rgb } from "@/lib/render/ramp";
import { latToY, lonToX, xToLon, yToLat, TILE_SIZE } from "@/lib/terrain/dem";
import { fetchGrid, isWater, type BinaryFetch, type Grid } from "./ncei";

/**
 * The water-depth picture and its numbers (layers/water-depth.ts): NOAA NCEI elevations below sea level as depth, on a
 * ramp from off-white (shallow) through purple to dark grey at the deepest the view holds, with contour lines every
 * `stepM` (50 ft in the US, 10 m elsewhere, wider for deep views) and the deepest point ringed. Land is left clear.
 *
 * Dry ground below sea level (Death Valley -85 m, the Imperial Valley, Dutch polders) reads below 0 in ETOPO too, so
 * inland (more than INLAND_KM from the Natural Earth coast, lakes counted as land) only surveyed water counts: those
 * blocks are asked again without ETOPO, which keeps the Great Lakes and Lake Washington and drops the dry basins.
 */

/** Ground this far inside the Natural Earth coastline counts as inland. */
export const INLAND_KM = 2;
/** Side of the blocks the inland test runs on, in grid pixels. */
const BLOCK = 16;

export type LandTest = { isLand: (lon: number, lat: number) => boolean; coastDistanceKm: (lon: number, lat: number, maxKm: number) => number };

let landTest: Promise<LandTest | null> | undefined;
/** The Natural Earth land mask (lib/checks/landMask.ts), loaded on first use; null where its file cannot load. */
export function loadLandTest(): Promise<LandTest | null> {
  landTest ??= import("@/lib/checks/landMask")
    .then((m) => {
      m.isLand(0, 0);
      return { isLand: m.isLand, coastDistanceKm: m.coastDistanceKm };
    })
    .catch(() => null);
  return landTest;
}

/** Where each grid pixel sits, by its centre. */
export type Locate = (i: number, j: number) => [number, number];

/**
 * Masks dry ground below sea level: in blocks whose centre is inland and that hold values below 0, takes the
 * surveys-only grid's value (NaN where no survey). `surveyed` is fetched only when some block needs it.
 */
export async function maskInland(grid: Grid, locate: Locate, land: LandTest | null, surveyed: () => Promise<Grid | null>): Promise<{ masked: number }> {
  if (!land) return { masked: 0 };
  const { width, height, values } = grid;
  const blocks: [number, number][] = [];
  for (let bj = 0; bj < height; bj += BLOCK) {
    for (let bi = 0; bi < width; bi += BLOCK) {
      let below = false;
      for (let j = bj; j < Math.min(height, bj + BLOCK) && !below; j++) {
        for (let i = bi; i < Math.min(width, bi + BLOCK); i++) {
          if (isWater(values[j * width + i])) {
            below = true;
            break;
          }
        }
      }
      if (!below) continue;
      const [lon, lat] = locate(Math.min(width - 1, bi + BLOCK / 2), Math.min(height - 1, bj + BLOCK / 2));
      if (land.isLand(lon, lat) && land.coastDistanceKm(lon, lat, INLAND_KM + 1) >= INLAND_KM) blocks.push([bi, bj]);
    }
  }
  if (blocks.length === 0) return { masked: 0 };
  const other = await surveyed();
  let masked = 0;
  for (const [bi, bj] of blocks) {
    for (let j = bj; j < Math.min(height, bj + BLOCK); j++) {
      for (let i = bi; i < Math.min(width, bi + BLOCK); i++) {
        const k = j * width + i;
        if (!isWater(values[k])) continue;
        const v = other ? other.values[k] : NaN;
        if (!isWater(v)) masked++;
        values[k] = v;
      }
    }
  }
  return { masked };
}

/* ---------- the picture ---------- */

export type DepthTileOptions = {
  /** The depth the ramp ends at (dark grey), in metres. */
  maxM: number;
  /** Contour interval in metres; none when 0. */
  stepM: number;
  /** The deepest point to ring, [lon, lat]. */
  deepest?: [number, number];
};

/** Extra grid pixels around a tile, so contours and the inland test see across its edges (a multiple of 4 keeps rows whole bytes). */
const PAD = 4;
const SIDE = TILE_SIZE + 2 * PAD;
const WEB_MERCATOR_HALF = 20_037_508.342_789_244;
const ALPHA = 225;
/** Every fifth contour is an index contour, drawn stronger. */
const INDEX_EVERY = 5;

const OFF = hexToRgb(OFF_WHITE);
const DARK = hexToRgb(DARK_GREY);

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** The ramp color for a depth: off-white at the surface, dark grey at `maxM` and deeper. */
export function depthColor(depthM: number, maxM: number): Rgb {
  return rampColor("depth", maxM > 0 ? depthM / maxM : 0);
}

/** A contour over a ramp color: mixed toward dark grey on the light half of the ramp, toward off-white on the dark half. */
function contourColor(base: Rgb, strength: number): Rgb {
  const light = 0.2126 * base[0] + 0.7152 * base[1] + 0.0722 * base[2] > 120;
  return mix(base, light ? DARK : OFF, strength);
}

/** The tile's box in web mercator metres, padded by PAD pixels. */
export function tileMercatorBox(z: number, x: number, y: number): BBox {
  const span = (2 * WEB_MERCATOR_HALF) / 2 ** z;
  const px = span / TILE_SIZE;
  const west = -WEB_MERCATOR_HALF + x * span;
  const north = WEB_MERCATOR_HALF - y * span;
  return [west - PAD * px, north - span - PAD * px, west + span + PAD * px, north + PAD * px];
}

/** Draws one 256-pixel tile from a padded grid (SIDE by SIDE): ramp, contours and the deepest point's ring. */
export function drawTile(grid: Grid, z: number, x: number, y: number, opts: DepthTileOptions): Uint8Array {
  const out = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
  const { values, width } = grid;
  const depthAt = (i: number, j: number) => {
    const v = values[(j + PAD) * width + (i + PAD)];
    return isWater(v) ? -v : NaN;
  };
  const band = (d: number) => Math.floor(d / opts.stepM);
  for (let j = 0; j < TILE_SIZE; j++) {
    for (let i = 0; i < TILE_SIZE; i++) {
      const d = depthAt(i, j);
      if (Number.isNaN(d)) continue;
      let c = depthColor(d, opts.maxM);
      if (opts.stepM > 0) {
        // A contour where a neighbour to the right or below lies in another band; the line sits on the shallower side.
        const b = band(d);
        let crossed = -1;
        for (const [di, dj] of [[1, 0], [0, 1]] as const) {
          const n = depthAt(i + di, j + dj);
          if (!Number.isNaN(n) && band(n) !== b) crossed = Math.max(crossed, Math.max(b, band(n)));
        }
        if (crossed > 0) c = contourColor(c, crossed % INDEX_EVERY === 0 ? 0.6 : 0.35);
      }
      const o = (j * TILE_SIZE + i) * 4;
      out[o] = Math.round(c[0]);
      out[o + 1] = Math.round(c[1]);
      out[o + 2] = Math.round(c[2]);
      out[o + 3] = ALPHA;
    }
  }
  if (opts.deepest) ringPoint(out, z, x, y, opts.deepest);
  return out;
}

/** The deepest point as a point symbol: an off-white disc with a dark grey ring, drawn where it falls in this tile. */
function ringPoint(out: Uint8Array, z: number, x: number, y: number, [lon, lat]: [number, number]) {
  const cx = (lonToX(lon, z) - x) * TILE_SIZE;
  const cy = (latToY(lat, z) - y) * TILE_SIZE;
  const r = 5;
  if (cx < -r - 2 || cy < -r - 2 || cx > TILE_SIZE + r + 2 || cy > TILE_SIZE + r + 2) return;
  for (let j = Math.floor(cy - r - 2); j <= Math.ceil(cy + r + 2); j++) {
    for (let i = Math.floor(cx - r - 2); i <= Math.ceil(cx + r + 2); i++) {
      if (i < 0 || j < 0 || i >= TILE_SIZE || j >= TILE_SIZE) continue;
      const d = Math.hypot(i + 0.5 - cx, j + 0.5 - cy);
      const c = d <= r - 1.5 ? OFF : d <= r + 0.5 ? DARK : null;
      if (!c) continue;
      const o = (j * TILE_SIZE + i) * 4;
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = 255;
    }
  }
}

/** One map tile of water depth, as RGBA, clear where the ground is dry; null when the mosaic did not answer. */
export async function renderDepthTile(z: number, x: number, y: number, opts: DepthTileOptions, deps: { fetch?: BinaryFetch; land?: LandTest | null } = {}): Promise<Uint8Array | null> {
  const box = tileMercatorBox(z, x, y);
  const grid = await fetchGrid(box, 3857, SIDE, SIDE, { fetch: deps.fetch });
  if (!grid) return null;
  const land = deps.land === undefined ? await loadLandTest() : deps.land;
  const locate: Locate = (i, j) => [xToLon(x + (i - PAD + 0.5) / TILE_SIZE, z), yToLat(y + (j - PAD + 0.5) / TILE_SIZE, z)];
  await maskInland(grid, locate, land, () => fetchGrid(box, 3857, SIDE, SIDE, { surveysOnly: true, fetch: deps.fetch }));
  return drawTile(grid, z, x, y, opts);
}

/* ---------- the numbers ---------- */

export type DepthStats = {
  /** Metres between samples (east-west at the box's middle latitude). */
  spacingM: number;
  /** Share of the sampled box that is water with a depth (0 to 1). */
  waterShare: number;
  /** The deepest sample: depth in metres and where. */
  deepest?: { depthM: number; lon: number; lat: number };
  /** The median depth of the water samples, in metres. */
  medianM?: number;
  /** Samples below sea level dropped as dry inland ground. */
  maskedInland: number;
};

/** Grid sides (multiples of 8) for a box: about `long` samples on its longer side, true to its shape on the ground. */
export function gridSize(bbox: BBox, long = 512): [number, number] {
  const midLat = ((bbox[1] + bbox[3]) / 2) * (Math.PI / 180);
  const wide = (bbox[2] - bbox[0]) * Math.cos(midLat);
  const tall = bbox[3] - bbox[1];
  const r8 = (n: number) => Math.max(8, Math.round(n / 8) * 8);
  return wide >= tall ? [r8(long), r8((long * tall) / wide)] : [r8((long * wide) / tall), r8(long)];
}

/** Samples the box (about 512 samples on its longer side) for its deepest point, median depth and water share. */
export async function depthStats(bbox: BBox, deps: { fetch?: BinaryFetch; land?: LandTest | null } = {}): Promise<DepthStats | null> {
  const [w, h] = gridSize(bbox);
  const grid = await fetchGrid(bbox, 4326, w, h, { fetch: deps.fetch });
  if (!grid) return null;
  const dx = (bbox[2] - bbox[0]) / w;
  const dy = (bbox[3] - bbox[1]) / h;
  const locate: Locate = (i, j) => [bbox[0] + (i + 0.5) * dx, bbox[3] - (j + 0.5) * dy];
  const land = deps.land === undefined ? await loadLandTest() : deps.land;
  const { masked } = await maskInland(grid, locate, land, () => fetchGrid(bbox, 4326, w, h, { surveysOnly: true, fetch: deps.fetch }));
  const depths: number[] = [];
  let deepest: DepthStats["deepest"];
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const v = grid.values[j * w + i];
      if (!isWater(v)) continue;
      depths.push(-v);
      if (!deepest || -v > deepest.depthM) {
        const [lon, lat] = locate(i, j);
        deepest = { depthM: -v, lon, lat };
      }
    }
  }
  depths.sort((a, b) => a - b);
  const midLat = (bbox[1] + bbox[3]) / 2;
  return {
    spacingM: Math.round(dx * 111_320 * Math.cos((midLat * Math.PI) / 180)),
    waterShare: depths.length / (w * h),
    ...(deepest && { deepest }),
    ...(depths.length > 0 && { medianM: depths[Math.floor(depths.length / 2)] }),
    maskedInland: masked,
  };
}

/* ---------- scale ---------- */

const FT = 0.3048;
const STEPS_FT = [50, 100, 250, 500, 1_000, 2_500, 5_000];
const STEPS_M = [10, 20, 50, 100, 200, 500, 1_000, 2_000];
/** Most contour lines a view's depth range gets. */
const MAX_CONTOURS = 25;

/** The contour interval for a view whose deepest point is `maxM`: 50 ft (US) or 10 m, wider when that would draw too many lines. */
export function contourStep(maxM: number, usFirst: boolean): { stepM: number; label: string } {
  if (usFirst) {
    const ft = STEPS_FT.find((s) => (maxM / FT) / s <= MAX_CONTOURS) ?? STEPS_FT[STEPS_FT.length - 1];
    return { stepM: ft * FT, label: `${ft.toLocaleString("en-US")} ft` };
  }
  const m = STEPS_M.find((s) => maxM / s <= MAX_CONTOURS) ?? STEPS_M[STEPS_M.length - 1];
  return { stepM: m, label: `${m.toLocaleString("en-US")} m` };
}

/** Where the ramp ends: the view's deepest point rounded up to a whole contour, at least one contour deep. */
export function rampMax(deepestM: number, stepM: number): number {
  return Math.max(stepM, Math.ceil(deepestM / stepM) * stepM);
}
