import type { BBox } from "@/layers/types";
import { type Dem, latToY, loadDem, lonToX, metresPerPixel, TILE_SIZE, type TileSource, xToLon, yToLat } from "./dem";

/**
 * The highest and lowest ground in a box, from AWS Terrain Tiles (lib/terrain/dem.ts), for "highest and lowest points
 * around Death Valley" and the elevation view's note.
 *
 * The highest is the box's raw maximum at a coarse zoom (at most 36 tiles), refined at a finer zoom around the three
 * highest coarse cells, since a summit is a sharp point a coarse tile smooths away (Telescope Peak reads 3,365 m at
 * zoom 11 and 3,369 m at zoom 14; the survey figure is 3,366 m).
 *
 * The lowest is the minimum of block medians (6 by 6 pixels, about 370 m at zoom 11), not of single pixels: the
 * elevation model holds pits that are not ground. Over Death Valley's salt pan (checked 2026-10-23) single pixels read
 * -251 m at zoom 11 and -131 m at zoom 13 in pits 100 to 200 m across, while the floor reads -84 to -86 m and the
 * survey's lowest point (Badwater Basin) is -86 m. A median over a block wider than a pit reads the floor.
 */

export type GroundPoint = { lon: number; lat: number; m: number };
export type Extremes = {
  low: GroundPoint;
  high: GroundPoint;
  /** Metres per pixel of the coarse read. */
  resolutionM: number;
  /** The coarse elevation (metres) at a point of the box, NaN off it: to check a named place's recorded height. */
  groundAt: (lon: number, lat: number) => number;
};

const BLOCK = 6;

/** The pixel range of a box at the DEM's zoom: [x0, y0, x1, y1), whole pixels. */
function pixelRange(dem: Dem, bbox: BBox): [number, number, number, number] {
  return [
    Math.floor(lonToX(bbox[0], dem.z) * TILE_SIZE),
    Math.floor(latToY(bbox[3], dem.z) * TILE_SIZE),
    Math.ceil(lonToX(bbox[2], dem.z) * TILE_SIZE),
    Math.ceil(latToY(bbox[1], dem.z) * TILE_SIZE),
  ];
}

const centre = (dem: Dem, px: number, py: number): [number, number] => [xToLon(px / TILE_SIZE, dem.z), yToLat(py / TILE_SIZE, dem.z)];

/** The highest pixels of a box, at most `k`, each at least `apart` pixels from the others. */
function highestPixels(dem: Dem, bbox: BBox, k: number, apart: number): { px: number; py: number; m: number }[] {
  const [x0, y0, x1, y1] = pixelRange(dem, bbox);
  const top: { px: number; py: number; m: number }[] = [];
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const m = dem.pixel(px, py);
      if (Number.isNaN(m)) continue;
      if (top.length === k && m <= top[k - 1].m) continue;
      const near = top.findIndex((t) => Math.abs(t.px - px) < apart && Math.abs(t.py - py) < apart);
      if (near >= 0) {
        if (m > top[near].m) top[near] = { px, py, m };
      } else {
        top.push({ px, py, m });
      }
      top.sort((a, b) => b.m - a.m);
      if (top.length > k) top.length = k;
    }
  }
  return top;
}

/** The lowest block median of a box: the floor of its lowest ground, at the block's centre. */
function lowestBlock(dem: Dem, bbox: BBox, block = BLOCK): { px: number; py: number; m: number } | null {
  const [x0, y0, x1, y1] = pixelRange(dem, bbox);
  const size = Math.max(1, Math.min(block, Math.floor((x1 - x0) / 2), Math.floor((y1 - y0) / 2)));
  const buf: number[] = [];
  let best: { px: number; py: number; m: number } | null = null;
  for (let by = y0; by < y1; by += size) {
    for (let bx = x0; bx < x1; bx += size) {
      buf.length = 0;
      for (let j = 0; j < size && by + j < y1; j++) {
        for (let i = 0; i < size && bx + i < x1; i++) {
          const m = dem.pixel(bx + i, by + j);
          if (!Number.isNaN(m)) buf.push(m);
        }
      }
      if (buf.length === 0 || buf.length < (size * size) / 2) continue;
      buf.sort((a, b) => a - b);
      const m = buf[buf.length >> 1];
      if (!best || m < best.m) best = { px: bx + size / 2, py: by + size / 2, m };
    }
  }
  return best;
}

/**
 * The highest and lowest ground in `bbox`, or null when no elevation tiles answered. Elevations are metres, rounded to
 * the metre; positions are the summit pixel and the lowest block's centre.
 */
export async function boxExtremes(bbox: BBox, opts: { source?: TileSource; maxTiles?: number } = {}): Promise<Extremes | null> {
  const dem = await loadDem(bbox, { zoom: 12, maxTiles: opts.maxTiles ?? 36, source: opts.source });
  if (dem.tileCount === 0) return null;
  const low = lowestBlock(dem, bbox);
  const tops = highestPixels(dem, bbox, 3, 20);
  if (!low || tops.length === 0) return null;
  // Refine the summit two zooms finer, around each of the three highest coarse cells (inside the box only).
  const fineZoom = Math.min(15, dem.z + 2);
  let high = { lon: 0, lat: 0, m: -Infinity };
  for (const t of tops) {
    const [lon, lat] = centre(dem, t.px + 0.5, t.py + 0.5);
    if (t.m > high.m) high = { lon, lat, m: t.m };
    if (fineZoom === dem.z) continue;
    const r = (2 * 360) / (TILE_SIZE * 2 ** dem.z);
    const around: BBox = [Math.max(bbox[0], lon - r), Math.max(bbox[1], lat - r), Math.min(bbox[2], lon + r), Math.min(bbox[3], lat + r)];
    const fine = await loadDem(around, { zoom: fineZoom, maxTiles: 4, source: opts.source });
    const [best] = fine.tileCount > 0 ? highestPixels(fine, around, 1, 1) : [];
    if (best && best.m > high.m) {
      const [flon, flat] = centre(fine, best.px + 0.5, best.py + 0.5);
      high = { lon: flon, lat: flat, m: best.m };
    }
  }
  const [lowLon, lowLat] = centre(dem, low.px, low.py);
  const round = (v: number) => Math.round(v * 1e5) / 1e5;
  return {
    low: { lon: round(lowLon), lat: round(lowLat), m: Math.round(low.m) },
    high: { lon: round(high.lon), lat: round(high.lat), m: Math.round(high.m) },
    resolutionM: Math.round(metresPerPixel((bbox[1] + bbox[3]) / 2, dem.z)),
    groundAt: (lon, lat) => dem.at(lon, lat),
  };
}

/* ---------- elevation bands (hypsometric tints) ---------- */

const FT = 0.3048;
/** Band steps people read on a topo map, smallest first: feet in the US, metres elsewhere. */
const STEPS_FT = [100, 200, 500, 1_000, 2_000, 5_000];
const STEPS_M = [50, 100, 200, 300, 500, 1_000, 2_000];
/** Most bands a view is split into: past this the step grows (1,000 ft becomes 2,000 ft over Death Valley). */
export const MAX_BANDS = 8;

/**
 * Bands of one step covering [lowM, highM]: the step in metres and in the unit people read, and the index of the lowest
 * and highest band (band k spans k to k+1 steps above sea level, so band edges are round numbers: 4,000 ft, 5,000 ft).
 */
export type Bands = { stepM: number; step: number; unit: "ft" | "m"; lo: number; hi: number };

export function bandsFor(lowM: number, highM: number, usFirst: boolean): Bands {
  const steps = usFirst ? STEPS_FT : STEPS_M;
  const toM = usFirst ? FT : 1;
  const span = Math.max(1, highM - lowM);
  let step = steps[steps.length - 1];
  for (const s of steps) {
    if (span / (s * toM) <= MAX_BANDS) {
      step = s;
      break;
    }
  }
  const stepM = step * toM;
  return { stepM, step, unit: usFirst ? "ft" : "m", lo: Math.floor(lowM / stepM), hi: Math.max(Math.floor(lowM / stepM), Math.floor(highM / stepM)) };
}

/** The band index of an elevation in metres. */
export function bandOf(m: number, stepM: number): number {
  return Math.floor(m / stepM);
}
