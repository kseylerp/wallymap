import type { Feature, Geometry, MultiPolygon, Polygon, Position } from "geojson";
import type { BBox } from "@/layers/types";

/**
 * Small geometry helpers for joining two layers (lib/spatial/combine.ts): distances on a local flat projection,
 * point in polygon, geodesic areas, and bounding boxes. Polygon clipping itself is polygon-clipping (pinned in
 * package.json); everything here is plain arithmetic so it runs the same on the server and in tests.
 */

const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

/** Great-circle distance in metres between two [lon, lat] points. */
export function haversineM(a: Position, b: Position): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A flat projection in metres around a latitude (equirectangular): good to well under 1% across a few hundred
 * kilometres, which is the scale of every join the agent asks for (a trail and its campsites, a forest and its fires).
 */
export type Projection = { x(lon: number): number; y(lat: number): number };

export function localProjection(lat0: number): Projection {
  const kx = EARTH_RADIUS_M * RAD * Math.cos(lat0 * RAD);
  const ky = EARTH_RADIUS_M * RAD;
  return { x: (lon) => lon * kx, y: (lat) => lat * ky };
}

/** Squared distance from point p to segment ab, all in projected metres. */
export function segmentDistance2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

/** True when [lon, lat] lies inside a ring (ray casting; on the edge counts either way). */
export function inRing(p: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True when [lon, lat] lies inside a polygon's outer ring and outside its holes. */
export function inPolygonRings(p: Position, rings: Position[][]): boolean {
  if (rings.length === 0 || !inRing(p, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (inRing(p, rings[k])) return false;
  return true;
}

/** The polygons of an area geometry as rings (a Polygon is one, a MultiPolygon many); other geometries have none. */
export function polygonsOf(geometry: Geometry | null | undefined): Position[][][] {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  if (geometry.type === "GeometryCollection") return geometry.geometries.flatMap(polygonsOf);
  return [];
}

/** True when the point lies in any of the area geometry's polygons. */
export function inArea(p: Position, geometry: Geometry | null | undefined): boolean {
  return polygonsOf(geometry).some((rings) => inPolygonRings(p, rings));
}

/** The lines of a geometry as vertex lists: a line, each part of a multi-line, or each ring of an area. */
export function pathsOf(geometry: Geometry | null | undefined): Position[][] {
  if (!geometry) return [];
  switch (geometry.type) {
    case "LineString":
      return [geometry.coordinates];
    case "MultiLineString":
      return geometry.coordinates;
    case "Polygon":
      return geometry.coordinates;
    case "MultiPolygon":
      return geometry.coordinates.flat();
    case "GeometryCollection":
      return geometry.geometries.flatMap(pathsOf);
    default:
      return [];
  }
}

/** Every vertex of a geometry (a point is its own one). */
export function verticesOf(geometry: Geometry | null | undefined): Position[] {
  if (!geometry) return [];
  switch (geometry.type) {
    case "Point":
      return [geometry.coordinates];
    case "MultiPoint":
      return geometry.coordinates;
    case "GeometryCollection":
      return geometry.geometries.flatMap(verticesOf);
    default:
      return pathsOf(geometry).flat();
  }
}

/** The bounding box of a geometry, or null when it has no coordinates. */
export function bboxOf(geometry: Geometry | null | undefined): BBox | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [x, y] of verticesOf(geometry)) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return w <= e ? [w, s, e, n] : null;
}

/** The smallest box holding every feature, or null when none has coordinates. */
export function bboxOfFeatures(features: Feature[]): BBox | null {
  let box: BBox | null = null;
  for (const f of features) {
    const b = bboxOf(f.geometry);
    if (!b) continue;
    box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b;
  }
  return box;
}

/** True when two boxes overlap, each grown by `pad` degrees. */
export function boxesTouch(a: BBox, b: BBox, pad = 0): boolean {
  return a[0] - pad <= b[2] && b[0] - pad <= a[2] && a[1] - pad <= b[3] && b[1] - pad <= a[3];
}

/**
 * A ring's area on the sphere in m² (the formula turf's `area` uses, after Chamberlain and Duquette, "Some algorithms
 * for polygons on a sphere", JPL 2007). Always positive.
 */
export function ringAreaM2(ring: Position[]): number {
  const n = ring.length;
  if (n < 3) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const lower = ring[i];
    const middle = ring[(i + 1) % n];
    const upper = ring[(i + 2) % n];
    total += (upper[0] * RAD - lower[0] * RAD) * Math.sin(middle[1] * RAD);
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

/** A polygon's area in m²: its outer ring less its holes. */
export function polygonAreaM2(rings: Position[][]): number {
  if (rings.length === 0) return 0;
  return Math.max(0, ringAreaM2(rings[0]) - rings.slice(1).reduce((sum, r) => sum + ringAreaM2(r), 0));
}

/** An area geometry's area in km² (0 for points and lines). */
export function areaKm2(geometry: Geometry | null | undefined): number {
  return polygonsOf(geometry).reduce((sum, rings) => sum + polygonAreaM2(rings), 0) / 1e6;
}

/** A line geometry's length in km (each part summed; areas count their rings). */
export function lengthKm(geometry: Geometry | null | undefined): number {
  let m = 0;
  for (const path of pathsOf(geometry)) for (let i = 1; i < path.length; i++) m += haversineM(path[i - 1], path[i]);
  return m / 1000;
}

/** A representative point: a point itself, a line's middle vertex, an area's box centre when inside it, else its first vertex. */
export function anchorOf(geometry: Geometry | null | undefined): Position | null {
  if (!geometry) return null;
  if (geometry.type === "Point") return geometry.coordinates;
  if (geometry.type === "LineString") return geometry.coordinates[Math.floor(geometry.coordinates.length / 2)] ?? null;
  const box = bboxOf(geometry);
  if (!box) return null;
  const centre: Position = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
  if (polygonsOf(geometry).length > 0 && !inArea(centre, geometry)) return verticesOf(geometry)[0] ?? null;
  return centre;
}

/** A Polygon or MultiPolygon from polygon-clipping's output, or null when it is empty. */
export function areaGeometry(multi: Position[][][]): Polygon | MultiPolygon | null {
  if (multi.length === 0) return null;
  return multi.length === 1 ? { type: "Polygon", coordinates: multi[0] } : { type: "MultiPolygon", coordinates: multi };
}

export const KM2_TO_ACRES = 247.105381;
