import type { Feature, LineString, Position } from "geojson";
import type { LoadedLayer, RenderOp } from "@/lib/render/state";
import { lengthMeters, positionAtMeters } from "@/lib/render/wally/playback";

/**
 * Samples along a route for the elevation profile (components/ElevationProfile.tsx): evenly spaced points, and
 * for each visible GeoJSON layer whose features carry a numeric `v` (fire acres, popularity score, snow depth),
 * the value of the nearest feature within 200 m of each point. Pure; terrain heights are read by the map.
 */

export const SAMPLE_STEP_M = 50;
export const NEAREST_WITHIN_M = 200;
export const MAX_SERIES = 3;
/** Never more than this many samples, so a 300 km drive does not make 6,000 terrain queries. */
export const MAX_SAMPLES = 1200;

export type Series = { layerId: string; title: string; unit?: string; values: (number | null)[] };
export type Samples = { distancesM: number[]; points: [number, number][]; series: Series[] };

/** The step actually used for a line: `stepM`, widened so a long line stays under `MAX_SAMPLES`. */
export function sampleStep(line: LineString, stepM = SAMPLE_STEP_M): number {
  const total = lengthMeters(line);
  return Math.max(stepM, total / (MAX_SAMPLES - 1));
}

/** Points every `stepM` along the line, always including both ends. */
export function samplePoints(line: LineString, stepM = SAMPLE_STEP_M): { distancesM: number[]; points: [number, number][] } {
  const total = lengthMeters(line);
  const step = sampleStep(line, stepM);
  const distancesM: number[] = [];
  for (let d = 0; d < total; d += step) distancesM.push(d);
  distancesM.push(total);
  return { distancesM, points: distancesM.map((d) => positionAtMeters(line, d)) };
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/** A local flat projection around `origin`, in meters. */
function projector(origin: Position) {
  const kx = 111_320 * Math.cos(rad(origin[1]));
  const ky = 110_574;
  return (p: Position): [number, number] => [(p[0] - origin[0]) * kx, (p[1] - origin[1]) * ky];
}

function segmentDistance(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
}

function ringContains(ring: [number, number][], p: [number, number]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance in meters from `p` (projected) to a geometry's lines and points; 0 inside a polygon. */
function distanceTo(feature: Feature, project: (p: Position) => [number, number], p: [number, number]): number {
  const g = feature.geometry;
  if (!g) return Infinity;
  const lineDist = (coords: Position[]) => {
    let best = Infinity;
    const pts = coords.map(project);
    if (pts.length === 1) return Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]);
    for (let i = 1; i < pts.length; i++) best = Math.min(best, segmentDistance(p, pts[i - 1], pts[i]));
    return best;
  };
  const polygonDist = (rings: Position[][]) => {
    const [outer, ...holes] = rings.map((r) => r.map(project));
    if (outer && ringContains(outer, p) && !holes.some((h) => ringContains(h, p))) return 0;
    return Math.min(...rings.map(lineDist));
  };
  switch (g.type) {
    case "Point":
      return lineDist([g.coordinates]);
    case "MultiPoint":
      return Math.min(...g.coordinates.map((c) => lineDist([c])));
    case "LineString":
      return lineDist(g.coordinates);
    case "MultiLineString":
      return Math.min(...g.coordinates.map(lineDist));
    case "Polygon":
      return polygonDist(g.coordinates);
    case "MultiPolygon":
      return Math.min(...g.coordinates.map(polygonDist));
    default:
      return Infinity;
  }
}

type BBox = [number, number, number, number];

function bboxOf(feature: Feature): BBox | null {
  const out: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      out[0] = Math.min(out[0], c[0]);
      out[1] = Math.min(out[1], c[1]);
      out[2] = Math.max(out[2], c[0]);
      out[3] = Math.max(out[3], c[1]);
      return;
    }
    c.forEach(visit);
  };
  const g = feature.geometry;
  if (g && "coordinates" in g) visit(g.coordinates);
  return Number.isFinite(out[0]) ? out : null;
}

/** `bbox` grown by `meters` on every side (degrees of latitude and of longitude at its middle). */
function grow([w, s, e, n]: BBox, meters: number): BBox {
  const dLat = meters / 110_574;
  const dLng = meters / (111_320 * Math.max(0.01, Math.cos(rad((s + n) / 2))));
  return [w - dLng, s - dLat, e + dLng, n + dLat];
}

const within = (p: Position, [w, s, e, n]: BBox) => p[0] >= w && p[0] <= e && p[1] >= s && p[1] <= n;
const overlaps = (a: BBox, b: BBox) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** The value of the nearest feature (with a numeric `v`) within `maxM` of each point, or null. */
export function nearestValues(points: [number, number][], features: Feature[], maxM = NEAREST_WITHIN_M): (number | null)[] {
  const candidates: { feature: Feature; v: number; bbox: BBox }[] = [];
  for (const feature of features) {
    const v = feature.properties?.v;
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const bbox = bboxOf(feature);
    if (bbox) candidates.push({ feature, v, bbox: grow(bbox, maxM) });
  }
  return points.map((point) => {
    const project = projector(point);
    let best = maxM;
    let value: number | null = null;
    for (const c of candidates) {
      if (!within(point, c.bbox)) continue;
      const d = distanceTo(c.feature, project, [0, 0]);
      if (d <= best) {
        best = d;
        value = c.v;
      }
    }
    return value;
  });
}

function lineBBox(points: [number, number][]): BBox {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * Samples along `line` every `stepM`, with one series per visible GeoJSON layer (in draw order, top first) that
 * has a numeric `v` near the route: at most three, and only layers with at least one value along the line.
 */
export function sampleAlong(
  line: LineString,
  layers: Record<string, LoadedLayer>,
  renderOps: RenderOp[] = [],
  stepM = SAMPLE_STEP_M,
): Samples {
  const { distancesM, points } = samplePoints(line, stepM);
  const series: Series[] = [];
  if (points.length === 0) return { distancesM, points, series };
  const area = grow(lineBBox(points), NEAREST_WITHIN_M);
  const visible = renderOps.length > 0 ? [...renderOps].reverse().filter((op) => op.visible).map((op) => op.layerId) : Object.keys(layers);
  for (const id of visible) {
    if (series.length >= MAX_SERIES) break;
    const layer = layers[id];
    if (!layer || layer.result.kind !== "geojson") continue;
    const near = layer.result.data.features.filter((f) => {
      const b = bboxOf(f);
      return b !== null && overlaps(b, area) && typeof f.properties?.v === "number";
    });
    if (near.length === 0) continue;
    const values = nearestValues(points, near);
    if (values.some((v) => v !== null)) series.push({ layerId: id, title: layer.title, unit: layer.style.unit, values });
  }
  return { distancesM, points, series };
}

/** Total climb and descent in meters, ignoring wiggles under `noiseM` (DEM noise would otherwise add up). */
export function gainLoss(elevations: (number | null)[], noiseM = 3): { gain: number; loss: number } {
  let gain = 0;
  let loss = 0;
  let anchor: number | null = null;
  for (const e of elevations) {
    if (e === null || !Number.isFinite(e)) continue;
    if (anchor === null) {
      anchor = e;
      continue;
    }
    const d = e - anchor;
    if (d >= noiseM) {
      gain += d;
      anchor = e;
    } else if (d <= -noiseM) {
      loss -= d;
      anchor = e;
    }
  }
  return { gain, loss };
}
