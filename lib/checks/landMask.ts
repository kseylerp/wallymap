import { readFileSync } from "node:fs";

/**
 * Land or sea at a point, and how far the coastline is: Natural Earth 1:50m land, simplified (data/land-50m.json,
 * built by scripts/land-mask.mts). Server and eval only (it reads the file from disk). Lakes the mask leaves as land
 * (most of them) read as land; the Caspian reads as sea.
 */

type Poly = { rings: Float64Array[]; bbox: [number, number, number, number] };
type Segment = [number, number, number, number];

type Mask = { polys: Poly[]; cells: Map<number, Segment[]> };

/** Grid cell size for the coastline index, in degrees. */
const CELL = 1;

let mask: Mask | undefined;

function cellKey(ix: number, iy: number): number {
  return (iy + 90) * 1000 + (ix + 180);
}

function load(): Mask {
  if (mask) return mask;
  const raw = JSON.parse(readFileSync(new URL("../../data/land-50m.json", import.meta.url), "utf8")) as { polygons: number[][][] };
  const polys: Poly[] = [];
  const cells = new Map<number, Segment[]>();
  for (const p of raw.polygons) {
    const rings = p.map((r) => Float64Array.from(r));
    const outer = rings[0];
    const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < outer.length; i += 2) {
      bbox[0] = Math.min(bbox[0], outer[i]);
      bbox[1] = Math.min(bbox[1], outer[i + 1]);
      bbox[2] = Math.max(bbox[2], outer[i]);
      bbox[3] = Math.max(bbox[3], outer[i + 1]);
    }
    polys.push({ rings, bbox });
    for (const ring of rings) {
      for (let i = 0; i + 3 < ring.length; i += 2) {
        const seg: Segment = [ring[i], ring[i + 1], ring[i + 2], ring[i + 3]];
        const x0 = Math.floor(Math.min(seg[0], seg[2]) / CELL);
        const x1 = Math.floor(Math.max(seg[0], seg[2]) / CELL);
        const y0 = Math.floor(Math.min(seg[1], seg[3]) / CELL);
        const y1 = Math.floor(Math.max(seg[1], seg[3]) / CELL);
        for (let ix = x0; ix <= x1; ix++) {
          for (let iy = y0; iy <= y1; iy++) {
            const key = cellKey(ix, iy);
            const list = cells.get(key);
            if (list) list.push(seg);
            else cells.set(key, [seg]);
          }
        }
      }
    }
  }
  mask = { polys, cells };
  return mask;
}

function inRing(ring: Float64Array, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i];
    const yi = ring[i + 1];
    const xj = ring[j];
    const yj = ring[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True when the point is on land (inside a land polygon and outside its holes). */
export function isLand(lon: number, lat: number): boolean {
  for (const p of load().polys) {
    const [w, s, e, n] = p.bbox;
    if (lon < w || lon > e || lat < s || lat > n) continue;
    if (!inRing(p.rings[0], lon, lat)) continue;
    if (p.rings.slice(1).some((hole) => inRing(hole, lon, lat))) continue;
    return true;
  }
  return false;
}

const KM_PER_DEG_LAT = 110.57;
const KM_PER_DEG_LON = 111.32;

/** Distance from the point to the nearest coastline in km, or `maxKm` when none is that close. */
export function coastDistanceKm(lon: number, lat: number, maxKm: number): number {
  const { cells } = load();
  const kx = KM_PER_DEG_LON * Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  const dx = maxKm / kx;
  const dy = maxKm / KM_PER_DEG_LAT;
  let best = maxKm;
  const seen = new Set<Segment>();
  for (let ix = Math.floor((lon - dx) / CELL); ix <= Math.floor((lon + dx) / CELL); ix++) {
    for (let iy = Math.floor((lat - dy) / CELL); iy <= Math.floor((lat + dy) / CELL); iy++) {
      for (const seg of cells.get(cellKey(ix, iy)) ?? []) {
        if (seen.has(seg)) continue;
        seen.add(seg);
        const ax = (seg[0] - lon) * kx;
        const ay = (seg[1] - lat) * KM_PER_DEG_LAT;
        const bx = (seg[2] - lon) * kx;
        const by = (seg[3] - lat) * KM_PER_DEG_LAT;
        const vx = bx - ax;
        const vy = by - ay;
        const len = vx * vx + vy * vy;
        const t = len === 0 ? 0 : Math.max(0, Math.min(1, -(ax * vx + ay * vy) / len));
        const d = Math.hypot(ax + t * vx, ay + t * vy);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

/**
 * Where a point sits against the coast, signed: positive km inland, negative km out at sea, capped at ±`maxKm`
 * (default 60 km, as far as the checks look).
 */
export function shoreOffsetKm(lon: number, lat: number, maxKm = 60): number {
  const d = coastDistanceKm(lon, lat, maxKm);
  return isLand(lon, lat) ? d : -d;
}
