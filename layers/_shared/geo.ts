/**
 * Small spherical-geometry helpers shared by the computed layers (popularity, remoteness).
 * Positions are GeoJSON order, [lng, lat] in degrees. Distances are kilometres.
 */
import type { Feature, Geometry, Position } from "geojson";

const EARTH_RADIUS_KM = 6371.0088;
const KM_PER_DEG_LAT = 110.57;
const KM_PER_DEG_LON_EQUATOR = 111.32;

/** Allowance for the grid's flat projection drifting from true distance across a view. */
const DISTORTION = 1.1;

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance between two [lng, lat] positions. */
export function haversineKm(a: Position, b: Position): number {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The point halfway along a line by distance; the only vertex for a one-point line; null when empty. */
export function lineMidpoint(coords: Position[]): Position | null {
  if (coords.length === 0) return null;
  if (coords.length === 1) return coords[0];
  const segments: number[] = [];
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = haversineKm(coords[i - 1], coords[i]);
    segments.push(d);
    total += d;
  }
  if (total === 0) return coords[0];
  let remaining = total / 2;
  for (let i = 0; i < segments.length; i++) {
    if (remaining <= segments[i]) {
      const t = segments[i] === 0 ? 0 : remaining / segments[i];
      const a = coords[i];
      const b = coords[i + 1];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    remaining -= segments[i];
  }
  return coords[coords.length - 1];
}

function collectPositions(geometry: Geometry, out: Position[]): void {
  switch (geometry.type) {
    case "Point":
      out.push(geometry.coordinates);
      return;
    case "MultiPoint":
    case "LineString":
      out.push(...geometry.coordinates);
      return;
    case "MultiLineString":
      geometry.coordinates.forEach((line) => out.push(...line));
      return;
    case "Polygon":
      // Outer ring only, without the closing repeat.
      out.push(...geometry.coordinates[0].slice(0, -1));
      return;
    case "MultiPolygon":
      geometry.coordinates.forEach((poly) => out.push(...poly[0].slice(0, -1)));
      return;
    case "GeometryCollection":
      geometry.geometries.forEach((g) => collectPositions(g, out));
      return;
  }
}

/**
 * A representative point: the point itself, the distance midpoint of a line, otherwise the
 * vertex average (outer rings only). Null for a feature with no geometry.
 */
export function centroid(feature: Feature): Position | null {
  const g = feature.geometry;
  if (!g) return null;
  if (g.type === "Point") return g.coordinates;
  if (g.type === "LineString") return lineMidpoint(g.coordinates);
  const all: Position[] = [];
  collectPositions(g, all);
  if (all.length === 0) return null;
  const lng = all.reduce((s, p) => s + p[0], 0) / all.length;
  const lat = all.reduce((s, p) => s + p[1], 0) / all.length;
  return [lng, lat];
}

/** How many of `points` lie within `km` of `point` (inclusive). Linear scan; use GridIndex for large sets. */
export function countWithinKm(point: Position, points: Position[], km: number): number {
  let n = 0;
  for (const p of points) if (haversineKm(point, p) <= km) n += 1;
  return n;
}

/** Distance to the nearest of `points`, or Infinity when there are none. Linear scan. */
export function nearestKm(point: Position, points: Position[]): number {
  let best = Infinity;
  for (const p of points) {
    const d = haversineKm(point, p);
    if (d < best) best = d;
  }
  return best;
}

/**
 * A uniform grid over points for fast radius and nearest-neighbour queries. Cells are
 * `cellKm` square on an equirectangular projection at `refLat`; distances are haversine.
 * Each point carries a payload (an index or id) so callers can count distinct owners.
 */
export class GridIndex<T = number> {
  private readonly cells = new Map<number, { p: Position; value: T }[]>();
  private readonly kmPerDegLon: number;
  private readonly cellKm: number;
  private minCx = Infinity;
  private maxCx = -Infinity;
  private minCy = Infinity;
  private maxCy = -Infinity;
  size = 0;

  constructor(cellKm: number, refLat: number) {
    this.cellKm = cellKm;
    this.kmPerDegLon = KM_PER_DEG_LON_EQUATOR * Math.max(Math.cos(rad(refLat)), 0.01);
  }

  private cx(lng: number): number {
    return Math.floor((lng * this.kmPerDegLon) / this.cellKm);
  }

  private cy(lat: number): number {
    return Math.floor((lat * KM_PER_DEG_LAT) / this.cellKm);
  }

  /** Numeric bucket key; |y| stays far below 1e6 for any cell size over 0.02 km. */
  private static key(x: number, y: number): number {
    return x * 1_000_000 + y;
  }

  add(p: Position, value: T): void {
    const x = this.cx(p[0]);
    const y = this.cy(p[1]);
    const key = GridIndex.key(x, y);
    let bucket = this.cells.get(key);
    if (!bucket) {
      bucket = [];
      this.cells.set(key, bucket);
    }
    bucket.push({ p, value });
    this.size += 1;
    if (x < this.minCx) this.minCx = x;
    if (x > this.maxCx) this.maxCx = x;
    if (y < this.minCy) this.minCy = y;
    if (y > this.maxCy) this.maxCy = y;
  }

  /** Calls `visit` for every indexed point within `km` of `p`. */
  forEachWithin(p: Position, km: number, visit: (value: T, distanceKm: number) => void): void {
    // 10% slack covers the flat projection's error away from refLat.
    const reach = Math.ceil((km * DISTORTION) / this.cellKm);
    const x0 = this.cx(p[0]);
    const y0 = this.cy(p[1]);
    for (let x = Math.max(x0 - reach, this.minCx); x <= Math.min(x0 + reach, this.maxCx); x++) {
      for (let y = Math.max(y0 - reach, this.minCy); y <= Math.min(y0 + reach, this.maxCy); y++) {
        const bucket = this.cells.get(GridIndex.key(x, y));
        if (!bucket) continue;
        for (const entry of bucket) {
          const d = haversineKm(p, entry.p);
          if (d <= km) visit(entry.value, d);
        }
      }
    }
  }

  /** Distance to the nearest indexed point, searching no further than `maxKm`; Infinity when none is that close. */
  nearestKm(p: Position, maxKm: number): number {
    if (this.size === 0) return Infinity;
    const x0 = this.cx(p[0]);
    const y0 = this.cy(p[1]);
    const maxRing = Math.ceil((maxKm * DISTORTION) / this.cellKm);
    let best = Infinity;
    for (let ring = 0; ring <= maxRing; ring++) {
      // Every point in ring r is at least (r - 1) cells away, so stop once that beats the best.
      if (((ring - 1) * this.cellKm) / DISTORTION > Math.min(best, maxKm)) break;
      for (let x = x0 - ring; x <= x0 + ring; x++) {
        for (let y = y0 - ring; y <= y0 + ring; y++) {
          if (Math.max(Math.abs(x - x0), Math.abs(y - y0)) !== ring) continue;
          const bucket = this.cells.get(GridIndex.key(x, y));
          if (!bucket) continue;
          for (const entry of bucket) {
            const d = haversineKm(p, entry.p);
            if (d < best) best = d;
          }
        }
      }
    }
    return best <= maxKm ? best : Infinity;
  }
}

/** Ray-cast test against one ring (closed or open). */
function inRing(point: Position, ring: Position[]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygonRings(point: Position, rings: Position[][]): boolean {
  if (rings.length === 0 || !inRing(point, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (inRing(point, rings[i])) return false;
  return true;
}

/** True when `point` is inside a Polygon or MultiPolygon (holes excluded). Other geometries are never containers. */
export function pointInPolygon(point: Position, geometry: Geometry | null): boolean {
  if (!geometry) return false;
  if (geometry.type === "Polygon") return inPolygonRings(point, geometry.coordinates);
  if (geometry.type === "MultiPolygon") return geometry.coordinates.some((poly) => inPolygonRings(point, poly));
  if (geometry.type === "GeometryCollection") return geometry.geometries.some((g) => pointInPolygon(point, g));
  return false;
}

/** [west, south, east, north] of a geometry's positions (all rings), or null when it has none. */
export function geometryBBox(geometry: Geometry | null): [number, number, number, number] | null {
  if (!geometry) return null;
  const all: Position[] = [];
  const visit = (g: Geometry) => {
    if (g.type === "Polygon") g.coordinates.forEach((r) => all.push(...r));
    else if (g.type === "MultiPolygon") g.coordinates.forEach((poly) => poly.forEach((r) => all.push(...r)));
    else if (g.type === "GeometryCollection") g.geometries.forEach(visit);
    else collectPositions(g, all);
  };
  visit(geometry);
  if (all.length === 0) return null;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lng, lat] of all) {
    if (lng < w) w = lng;
    if (lng > e) e = lng;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [w, s, e, n];
}
