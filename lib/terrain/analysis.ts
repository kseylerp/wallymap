import type { Position } from "geojson";
import { haversineM } from "@/lib/spatial/geo";
import { type Dem, latToY, lonToX, metresPerPixel, TILE_SIZE } from "./dem";

/**
 * Slope, aspect, sun and climb from an elevation model (lib/terrain/dem.ts). Slope and aspect use Horn's 3x3 method
 * (the one GDAL and ArcGIS use); the sun's position uses the standard declination and hour-angle formulas, good to
 * about a degree, which is finer than any face the elevation model can resolve.
 */

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/** Slope in degrees (0 flat, 90 vertical) and aspect in degrees clockwise from north: the way the ground faces downhill. */
export type SlopeAspect = { slope: number; aspect: number };

/**
 * Horn's slope and aspect from a 3x3 window of elevations, row by row from the north-west, `spacing` metres apart.
 * Aspect is NaN on flat ground.
 */
export function hornSlopeAspect(w: ArrayLike<number>, spacing: number): SlopeAspect {
  const [a, b, c, d, , f, g, h, i] = Array.from(w);
  const dzdx = (c + 2 * f + i - (a + 2 * d + g)) / (8 * spacing);
  const dzdn = (a + 2 * b + c - (g + 2 * h + i)) / (8 * spacing);
  const slope = Math.atan(Math.hypot(dzdx, dzdn)) * DEG;
  const aspect = dzdx === 0 && dzdn === 0 ? NaN : (Math.atan2(-dzdx, -dzdn) * DEG + 360) % 360;
  return { slope, aspect };
}

/**
 * Slope and aspect at a point. `spanM` is the distance between the window's rows (default one pixel): 50 m reads the
 * general lie of a hillside over about 100 m, as for a crag; one pixel reads the steepest local ground.
 */
export function slopeAspectAt(dem: Dem, lon: number, lat: number, spanM?: number): SlopeAspect | null {
  const mpp = metresPerPixel(lat, dem.z);
  const step = spanM === undefined ? 1 : Math.max(1, spanM / mpp);
  const px = lonToX(lon, dem.z) * TILE_SIZE;
  const py = latToY(lat, dem.z) * TILE_SIZE;
  const w: number[] = [];
  for (const dy of [-step, 0, step]) for (const dx of [-step, 0, step]) w.push(dem.atPixel(px + dx, py + dy));
  if (w.some(Number.isNaN)) return null;
  return hornSlopeAspect(w, step * mpp);
}

/**
 * The face of the steepest ground near a point, for a crag: a crag's mapped point often sits at the base of its wall
 * (a road, a river bench), where the ground is flat. Samples about every pixel within `radiusM`, keeps the steepest
 * fifth, and averages their downhill directions weighted by slope. `slope` is the steepest sample. Null without data.
 */
export function steepestFaceNear(dem: Dem, lon: number, lat: number, radiusM = 150): SlopeAspect | null {
  const mpp = metresPerPixel(lat, dem.z);
  const step = Math.max(mpp, 10);
  const n = Math.ceil(radiusM / step);
  const dLat = step / 111_195;
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  const samples: SlopeAspect[] = [];
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      if ((i * i + j * j) * step * step > radiusM * radiusM) continue;
      const sa = slopeAspectAt(dem, lon + i * dLon, lat + j * dLat);
      if (sa && !Number.isNaN(sa.aspect)) samples.push(sa);
    }
  }
  if (samples.length === 0) return null;
  samples.sort((a, b) => b.slope - a.slope);
  const top = samples.slice(0, Math.max(1, Math.ceil(samples.length / 5)));
  let x = 0;
  let y = 0;
  for (const s of top) {
    x += s.slope * Math.sin(s.aspect * RAD);
    y += s.slope * Math.cos(s.aspect * RAD);
  }
  return { slope: top[0].slope, aspect: x === 0 && y === 0 ? NaN : (Math.atan2(x, y) * DEG + 360) % 360 };
}

/** The eight compass words for an aspect, or "Flat" for NaN. */
export function compass8(aspect: number): string {
  if (Number.isNaN(aspect)) return "Flat";
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(aspect / 45) % 8];
}

/** The four faces (N, E, S, W) for an aspect, or "Flat". */
export function compass4(aspect: number): "N" | "E" | "S" | "W" | "Flat" {
  if (Number.isNaN(aspect)) return "Flat";
  return (["N", "E", "S", "W"] as const)[Math.round(aspect / 90) % 4];
}

/* ---------- slope classes (avalanche terrain) ---------- */

/** The standard slope classes, low to high; 30 to 45° is where most slab avalanches start. */
export const SLOPE_CLASSES = [
  { key: "under25", label: "Under 25°", min: 0, max: 25 },
  { key: "25to30", label: "25 to 30°", min: 25, max: 30 },
  { key: "30to35", label: "30 to 35°", min: 30, max: 35 },
  { key: "35to45", label: "35 to 45°", min: 35, max: 45 },
  { key: "over45", label: "Over 45°", min: 45, max: 90 },
] as const;

export function slopeClass(slope: number): number {
  for (let k = SLOPE_CLASSES.length - 1; k >= 0; k--) if (slope >= SLOPE_CLASSES[k].min) return k;
  return 0;
}

/* ---------- the sun ---------- */

/** The sun's declination in degrees on a date (Spencer's Fourier series, within about 0.1°). */
export function declination(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const g = (2 * Math.PI * ((date.getTime() - start) / 86_400_000)) / 365;
  const rad =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);
  return rad * DEG;
}

/**
 * The sun at a latitude and hour angle (degrees from solar noon, afternoon positive): altitude above the horizon and
 * azimuth clockwise from north, both in degrees.
 */
export function sunPosition(lat: number, decl: number, hourAngle: number): { altitude: number; azimuth: number } {
  const phi = lat * RAD;
  const d = decl * RAD;
  const h = hourAngle * RAD;
  const altitude = Math.asin(Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.cos(h)) * DEG;
  const fromSouth = Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(phi) - Math.tan(d) * Math.cos(phi)) * DEG;
  return { altitude, azimuth: (fromSouth + 180 + 360) % 360 };
}

/** Morning is 8 to 12 solar time, afternoon 1 to 5 pm (hour angles in degrees, 15 per hour), sampled every half hour. */
export const PERIODS = { morning: [-60, 0], afternoon: [15, 75] } as const;
export type Period = keyof typeof PERIODS;

/** The sun's positions above the horizon through a period of a day at a latitude. */
export function sunPath(lat: number, date: Date, period: Period): { altitude: number; azimuth: number }[] {
  const decl = declination(date);
  const [h0, h1] = PERIODS[period];
  const out: { altitude: number; azimuth: number }[] = [];
  for (let h = h0; h <= h1; h += 7.5) {
    const p = sunPosition(lat, decl, h);
    if (p.altitude > 0) out.push(p);
  }
  return out;
}

/** Cosine of the sun's angle of incidence on ground of this slope and aspect: 0 or less means the face is in shade. */
export function incidence(slope: number, aspect: number, sun: { altitude: number; azimuth: number }): number {
  const zen = (90 - sun.altitude) * RAD;
  const s = slope * RAD;
  const rel = Number.isNaN(aspect) ? 0 : (sun.azimuth - aspect) * RAD;
  return Math.cos(zen) * Math.cos(s) + Math.sin(zen) * Math.sin(s) * Math.cos(rel);
}

/**
 * True when ground of this slope and aspect faces away from the sun for at least `share` of the period's sunlit
 * samples (self-shade only: a ridge's cast shadow is not modelled). A crag passes `slope` 90, a vertical wall.
 */
export function shadedThrough(slope: number, aspect: number, path: { altitude: number; azimuth: number }[], share = 0.75): boolean {
  if (path.length === 0) return true;
  const shaded = path.filter((sun) => incidence(slope, aspect, sun) <= 0.05).length;
  return shaded / path.length >= share;
}

/* ---------- along a line ---------- */

export type Profile = {
  /** Climb and descent in metres, counting only changes past the noise threshold. */
  gainM: number;
  lossM: number;
  minM: number;
  maxM: number;
  /** Steepest ground under the line, degrees (Horn slope of the terrain, not the path's grade). */
  maxSlopeDeg: number;
  /** Samples that fell off the loaded tiles. */
  missing: number;
  samples: number;
};

/** Points every `stepM` metres along a path, ends included. */
export function resample(path: Position[], stepM: number): Position[] {
  if (path.length < 2) return path.slice();
  const out: Position[] = [path[0]];
  let carry = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const seg = haversineM(a, b);
    let t = stepM - carry;
    while (t < seg) {
      const k = t / seg;
      out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]);
      t += stepM;
    }
    carry = seg - (t - stepM);
  }
  const last = path[path.length - 1];
  const tail = out[out.length - 1];
  if (tail[0] !== last[0] || tail[1] !== last[1]) out.push(last);
  return out;
}

/**
 * Climb and descent with a hysteresis threshold: the running elevation only moves once it has changed by more than
 * `thresholdM`, so the elevation model's noise on flat ground does not add up to phantom climbing.
 */
export function gainLoss(elevations: number[], thresholdM = 3): { gain: number; loss: number } {
  let gain = 0;
  let loss = 0;
  let ref = NaN;
  for (const e of elevations) {
    if (Number.isNaN(e)) continue;
    if (Number.isNaN(ref)) {
      ref = e;
      continue;
    }
    const d = e - ref;
    if (d > thresholdM) {
      gain += d;
      ref = e;
    } else if (d < -thresholdM) {
      loss -= d;
      ref = e;
    }
  }
  return { gain, loss };
}

/** The elevation profile of one or more paths (a trail's parts), sampled about every pixel and at least every 30 m. */
export function profileOf(dem: Dem, paths: Position[][], opts: { slope?: boolean } = {}): Profile | null {
  let gain = 0;
  let loss = 0;
  let min = Infinity;
  let max = -Infinity;
  let maxSlope = 0;
  let missing = 0;
  let samples = 0;
  for (const path of paths) {
    if (path.length < 2) continue;
    const lat = path[0][1];
    const step = Math.min(30, Math.max(10, metresPerPixel(lat, dem.z)));
    const points = resample(path, step);
    const elev = points.map(([lon, la]) => dem.at(lon, la));
    for (const e of elev) {
      samples += 1;
      if (Number.isNaN(e)) {
        missing += 1;
        continue;
      }
      min = Math.min(min, e);
      max = Math.max(max, e);
    }
    const gl = gainLoss(elev);
    gain += gl.gain;
    loss += gl.loss;
    if (opts.slope) {
      for (let k = 0; k < points.length; k += 2) {
        const sa = slopeAspectAt(dem, points[k][0], points[k][1]);
        if (sa && sa.slope > maxSlope) maxSlope = sa.slope;
      }
    }
  }
  if (samples === 0 || missing / samples > 0.5) return null;
  return { gainM: Math.round(gain), lossM: Math.round(loss), minM: Math.round(min), maxM: Math.round(max), maxSlopeDeg: Math.round(maxSlope), missing, samples };
}
