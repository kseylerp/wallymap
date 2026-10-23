import type { BBox } from "@/layers/types";
import { DARK_GREY, PINK, PURPLE, SAGE } from "@/lib/render/palette";
import { compass4, hornSlopeAspect, type Period, shadedThrough, SLOPE_CLASSES, slopeClass, sunPath } from "./analysis";
import { type Dem, latToY, loadDem, lonToX, metresPerPixel, TILE_SIZE, type TileSource, xToLon, yToLat } from "./dem";

/**
 * What the terrain layer draws and counts: slope classes (avalanche terrain), the way slopes face, or the ground in
 * its own shade through a morning or an afternoon. One classifier serves the map tiles (app/api/terrain) and the
 * numbers the query returns over a box, so the picture and the note always agree.
 */

export const TERRAIN_MODES = ["slope", "aspect", "shade"] as const;
export type TerrainMode = (typeof TERRAIN_MODES)[number];
export const FACES = ["N", "E", "S", "W"] as const;
export type Face = (typeof FACES)[number];

export type TerrainOptions = {
  mode: TerrainMode;
  /** slope: draw only ground at least this steep (degrees). */
  minSlope?: number;
  /** aspect: draw only these faces. */
  faces?: Face[];
  /** shade: the day (YYYY-MM-DD) and the part of it. */
  date?: string;
  period?: Period;
};

/** Ground flatter than this has no meaningful aspect, and is left undrawn in the aspect view. */
export const ASPECT_MIN_SLOPE = 10;

type Rgba = [number, number, number, number];

function hex(color: string, alpha: number): Rgba {
  const n = parseInt(color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, Math.round(alpha * 255)];
}

/** Slope class colors: clear under 25°, sage, then the 30 to 45° avalanche band in pink, purple over 45°. */
export const SLOPE_COLORS: Rgba[] = [[0, 0, 0, 0], hex(SAGE, 0.55), hex(PINK, 0.5), hex(PINK, 0.85), hex(PURPLE, 0.75)];
export const SLOPE_SWATCHES = [undefined, SAGE, PINK, PINK, PURPLE];
export const FACE_COLORS: Record<Face, Rgba> = { N: hex(PURPLE, 0.6), E: hex(SAGE, 0.65), S: hex(PINK, 0.6), W: hex(DARK_GREY, 0.45) };
export const FACE_SWATCHES: Record<Face, string> = { N: PURPLE, E: SAGE, S: PINK, W: DARK_GREY };
export const SHADE_COLOR: Rgba = hex(DARK_GREY, 0.55);
const CLEAR: Rgba = [0, 0, 0, 0];

/** The sun's path for a shade view: the asked day (else today) at this latitude. */
function pathFor(opts: TerrainOptions, lat: number) {
  const date = opts.date && !Number.isNaN(Date.parse(opts.date)) ? new Date(opts.date) : new Date();
  return sunPath(lat, date, opts.period ?? "afternoon");
}

/**
 * The class of one cell: a slope class index, a face, "shade"/"sun", or null where nothing is drawn. `path` is the
 * sun's path for a shade view (computed once per tile or box).
 */
export function classify(slope: number, aspect: number, opts: TerrainOptions, path?: ReturnType<typeof sunPath>): number | Face | "shade" | "sun" | null {
  if (opts.mode === "slope") return slopeClass(slope);
  if (opts.mode === "aspect") {
    if (slope < ASPECT_MIN_SLOPE) return null;
    const face = compass4(aspect);
    return face === "Flat" ? null : face;
  }
  return shadedThrough(slope, aspect, path ?? []) ? "shade" : "sun";
}

function colorOf(cls: ReturnType<typeof classify>, opts: TerrainOptions): Rgba {
  if (cls === null || cls === "sun") return CLEAR;
  if (cls === "shade") return SHADE_COLOR;
  if (typeof cls === "number") {
    if (opts.minSlope !== undefined && SLOPE_CLASSES[cls].max <= opts.minSlope) return CLEAR;
    return SLOPE_COLORS[cls];
  }
  if (opts.faces && opts.faces.length > 0 && !opts.faces.includes(cls)) return CLEAR;
  return FACE_COLORS[cls];
}

/** The elevation zoom a map tile reads: never coarser than 12 (about 30 m), never past the tiles' 15. */
export function demZoomFor(z: number): number {
  return Math.min(15, Math.max(12, z));
}

/** Slope and aspect at one point of the elevation model, by global pixel coordinates at its zoom. */
function cellAt(dem: Dem, px: number, py: number, spacing: number) {
  const w = [
    dem.atPixel(px - 1, py - 1), dem.atPixel(px, py - 1), dem.atPixel(px + 1, py - 1),
    dem.atPixel(px - 1, py), dem.atPixel(px, py), dem.atPixel(px + 1, py),
    dem.atPixel(px - 1, py + 1), dem.atPixel(px, py + 1), dem.atPixel(px + 1, py + 1),
  ];
  if (w.some(Number.isNaN)) return null;
  return hornSlopeAspect(w, spacing);
}

/** One 256-pixel map tile of the terrain view, as RGBA. Transparent where nothing is drawn or no elevation loaded. */
export async function renderTile(z: number, x: number, y: number, opts: TerrainOptions, source?: TileSource): Promise<Uint8Array> {
  const zd = demZoomFor(z);
  const box: BBox = [xToLon(x, z), yToLat(y + 1, z), xToLon(x + 1, z), yToLat(y, z)];
  const dem = await loadDem(box, { zoom: zd, maxTiles: 36, source });
  const out = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
  if (dem.tileCount === 0) return out;
  const scale = 2 ** (dem.z - z);
  const midLat = (box[1] + box[3]) / 2;
  const path = opts.mode === "shade" ? pathFor(opts, midLat) : undefined;
  for (let j = 0; j < TILE_SIZE; j++) {
    const lat = yToLat(y + (j + 0.5) / TILE_SIZE, z);
    const spacing = metresPerPixel(lat, dem.z);
    for (let i = 0; i < TILE_SIZE; i++) {
      const px = (x * TILE_SIZE + i + 0.5) * scale;
      const py = (y * TILE_SIZE + j + 0.5) * scale;
      const sa = cellAt(dem, px, py, spacing);
      if (!sa) continue;
      const c = colorOf(classify(sa.slope, sa.aspect, opts, path), opts);
      const o = (j * TILE_SIZE + i) * 4;
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = c[3];
    }
  }
  return out;
}

/** Shares of a box by class, for the note. */
export type AreaStats = {
  areaKm2: number;
  /** Metres per elevation sample. */
  resolutionM: number;
  /** Share (0 to 1) of the sampled ground in each class, keyed by class label. */
  shares: Record<string, number>;
  steepestDeg: number;
  /** The sun's azimuth through the period, first and last (shade view). */
  sunAzimuths?: [number, number];
  /** Samples that had elevation. */
  samples: number;
};

/** Counts the box's ground by the view's classes, sampling up to about 200,000 cells of the elevation model. */
export async function areaStats(bbox: BBox, opts: TerrainOptions, source?: TileSource): Promise<AreaStats | null> {
  const dem = await loadDem(bbox, { zoom: 12, maxTiles: 36, source });
  if (dem.tileCount === 0) return null;
  const x0 = lonToX(bbox[0], dem.z) * TILE_SIZE;
  const x1 = lonToX(bbox[2], dem.z) * TILE_SIZE;
  const y0 = latToY(bbox[3], dem.z) * TILE_SIZE;
  const y1 = latToY(bbox[1], dem.z) * TILE_SIZE;
  const step = Math.max(1, Math.sqrt(((x1 - x0) * (y1 - y0)) / 200_000));
  const midLat = (bbox[1] + bbox[3]) / 2;
  const path = opts.mode === "shade" ? pathFor(opts, midLat) : undefined;
  const counts = new Map<string, number>();
  let n = 0;
  let steepest = 0;
  for (let py = y0 + step / 2; py < y1; py += step) {
    const lat = yToLat(py / TILE_SIZE, dem.z);
    const spacing = metresPerPixel(lat, dem.z);
    for (let px = x0 + step / 2; px < x1; px += step) {
      const sa = cellAt(dem, px, py, spacing);
      if (!sa) continue;
      n += 1;
      steepest = Math.max(steepest, sa.slope);
      const cls = classify(sa.slope, sa.aspect, opts, path);
      const label = cls === null ? "Flat" : typeof cls === "number" ? SLOPE_CLASSES[cls].label : cls === "shade" ? "In shade" : cls === "sun" ? "In sun" : cls;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  if (n === 0) return null;
  const shares = Object.fromEntries([...counts].map(([k, v]) => [k, Math.round((v / n) * 1000) / 1000]));
  const widthKm = (bbox[2] - bbox[0]) * 111.32 * Math.cos((midLat * Math.PI) / 180);
  const heightKm = (bbox[3] - bbox[1]) * 110.574;
  return {
    areaKm2: Math.round(widthKm * heightKm),
    resolutionM: Math.round(metresPerPixel(midLat, dem.z)),
    shares,
    steepestDeg: Math.round(steepest),
    ...(path && path.length > 0 && { sunAzimuths: [Math.round(path[0].azimuth), Math.round(path[path.length - 1].azimuth)] as [number, number] }),
    samples: n,
  };
}
