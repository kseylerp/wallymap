import type { Position } from "geojson";
import { haversineM } from "@/lib/spatial/geo";
import { gainLoss, resample } from "./analysis";
import { type Dem, loadDemTiles, metresPerPixel, MAX_DEM_ZOOM, tileKeyOf, type TileSource } from "./dem";

/**
 * A cross-section along a straight line (or a few joined straight lines) from the elevation model: the ground's height
 * every 10 to 30 m, the climb and descent, the highest and lowest ground, and the steepest stretch over about 100 m.
 * The elevation-profile layer (layers/elevation-profile.ts) answers with it and the chart under the map draws it
 * (components/CrossSection.tsx).
 */

/** The steepest stretch is measured over at least this much ground, so one noisy sample does not make a cliff. */
export const STEEP_WINDOW_M = 100;
/** Most elevation tiles one profile reads; a longer line reads a coarser zoom. */
const MAX_TILES = 64;

export type Steepest = {
  /** Where the stretch starts and ends, metres from the line's start. */
  fromM: number;
  toM: number;
  /** Rise over run, as a percentage (100% is 45°), and the same slope in degrees. */
  gradePct: number;
  deg: number;
  /** Whether the line climbs or descends there, going from start to end. */
  direction: "climbing" | "descending";
  /** The stretch's middle. */
  at: [number, number];
};

export type CrossSection = {
  /** Every sample, from the start: distance along the line (m), elevation (m, NaN where no tile loaded), position. */
  distancesM: number[];
  elevationsM: number[];
  positions: [number, number][];
  lengthM: number;
  startM: number;
  endM: number;
  high: { m: number; atM: number; at: [number, number] };
  low: { m: number; atM: number; at: [number, number] };
  climbM: number;
  descentM: number;
  steepest: Steepest | null;
  /** Metres between samples, and the elevation tiles' zoom. */
  stepM: number;
  zoom: number;
  /** Samples that fell off the loaded tiles. */
  missing: number;
};

/** The length of a path in metres. */
export function pathLengthM(path: Position[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += haversineM(path[i - 1], path[i]);
  return total;
}

/** Sample spacing for a line this long: about every 10 m on a short line, up to 30 m, so a profile holds a few thousand samples at most. */
export function stepFor(lengthM: number): number {
  return Math.min(30, Math.max(10, Math.round(lengthM / 2_000)));
}

/** The steepest stretch of at least `windowM` along a profile, or null when the profile is shorter than that. */
export function steepestStretch(distancesM: number[], elevationsM: number[], positions: [number, number][], windowM = STEEP_WINDOW_M): Steepest | null {
  let best: { i: number; j: number; grade: number } | null = null;
  let j = 0;
  for (let i = 0; i < distancesM.length; i++) {
    if (Number.isNaN(elevationsM[i])) continue;
    if (j <= i) j = i + 1;
    while (j < distancesM.length && distancesM[j] - distancesM[i] < windowM - 0.5) j++;
    if (j >= distancesM.length) break;
    if (Number.isNaN(elevationsM[j])) continue;
    const grade = (elevationsM[j] - elevationsM[i]) / (distancesM[j] - distancesM[i]);
    if (!best || Math.abs(grade) > Math.abs(best.grade)) best = { i, j, grade };
  }
  if (!best) return null;
  const mid = positions[Math.round((best.i + best.j) / 2)];
  return {
    fromM: Math.round(distancesM[best.i]),
    toM: Math.round(distancesM[best.j]),
    gradePct: Math.round(Math.abs(best.grade) * 100),
    deg: Math.round((Math.atan(Math.abs(best.grade)) * 180) / Math.PI),
    direction: best.grade >= 0 ? "climbing" : "descending",
    at: [Math.round(mid[0] * 1e5) / 1e5, Math.round(mid[1] * 1e5) / 1e5],
  };
}

/** The cross-section of a path over a loaded elevation model, sampled every `stepM`. Null when most samples had no elevation. */
export function crossSectionOf(path: Position[], dem: Dem, stepM: number): CrossSection | null {
  const points = resample(path, stepM) as [number, number][];
  const distancesM: number[] = [0];
  for (let i = 1; i < points.length; i++) distancesM.push(distancesM[i - 1] + haversineM(points[i - 1], points[i]));
  const elevationsM = points.map(([lon, lat]) => dem.at(lon, lat));
  const missing = elevationsM.filter(Number.isNaN).length;
  if (points.length < 2 || missing / points.length > 0.5) return null;
  let hi = -1;
  let lo = -1;
  elevationsM.forEach((e, i) => {
    if (Number.isNaN(e)) return;
    if (hi < 0 || e > elevationsM[hi]) hi = i;
    if (lo < 0 || e < elevationsM[lo]) lo = i;
  });
  const known = (from: number, dir: 1 | -1) => {
    for (let i = from; i >= 0 && i < elevationsM.length; i += dir) if (!Number.isNaN(elevationsM[i])) return elevationsM[i];
    return NaN;
  };
  const { gain, loss } = gainLoss(elevationsM);
  const r = (n: number) => Math.round(n);
  return {
    distancesM: distancesM.map((d) => Math.round(d * 10) / 10),
    elevationsM: elevationsM.map((e) => (Number.isNaN(e) ? NaN : Math.round(e * 10) / 10)),
    positions: points,
    lengthM: r(distancesM[distancesM.length - 1]),
    startM: r(known(0, 1)),
    endM: r(known(elevationsM.length - 1, -1)),
    high: { m: r(elevationsM[hi]), atM: r(distancesM[hi]), at: points[hi] },
    low: { m: r(elevationsM[lo]), atM: r(distancesM[lo]), at: points[lo] },
    climbM: r(gain),
    descentM: r(loss),
    steepest: steepestStretch(distancesM, elevationsM, points),
    stepM,
    zoom: dem.z,
    missing,
  };
}

/**
 * Reads the elevation tiles a path touches (only those, so a long thin line stays cheap) at a zoom whose pixels are
 * about the sample spacing, lowered until the line needs at most 64 tiles, and returns its cross-section.
 */
export async function crossSection(path: Position[], opts: { source?: TileSource } = {}): Promise<CrossSection | null> {
  const lengthM = pathLengthM(path);
  const stepM = stepFor(lengthM);
  const lat = path[0][1];
  let z = MAX_DEM_ZOOM;
  while (z > 8 && metresPerPixel(lat, z) < stepM / 1.5) z--;
  const points = resample(path, stepM);
  const keysAt = (zoom: number) => new Set(points.map(([lon, la]) => tileKeyOf(lon, la, zoom)));
  let keys = keysAt(z);
  while (z > 6 && keys.size > MAX_TILES) keys = keysAt(--z);
  const dem = await loadDemTiles(z, keys, opts.source);
  if (dem.tileCount === 0) return null;
  return crossSectionOf(path, dem, stepM);
}
