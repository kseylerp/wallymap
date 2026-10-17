/**
 * Builds data/land-10m.json, the land mask the eval's map checks use (lib/checks/landMask.ts), from Natural Earth's
 * 1:10m land polygons (public domain). The 1:50m land left out small islands, so tide stations on Swans Island, Maine
 * read 10 km out to sea (2026-10-17):
 *
 *   curl -sSLo /tmp/ne/ne_10m_land.geojson \
 *     https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson
 *   pnpm exec tsx scripts/land-mask.mts /tmp/ne/ne_10m_land.geojson
 *
 * Each ring is simplified (Douglas-Peucker, 0.005°, about 500 m, well inside the checks' 2 km coast tolerance) and its
 * coordinates rounded to 3 decimals, then stored flat: `{ polygons: [[ring, hole, ...], ...] }` with each ring as
 * [lon, lat, lon, lat, ...].
 */
import { readFileSync, writeFileSync } from "node:fs";

const TOLERANCE = 0.005;

type Ring = [number, number][];

function perpendicular(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function simplify(ring: Ring): Ring {
  if (ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    let worst = -1;
    let at = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpendicular(ring[i], ring[lo], ring[hi]);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > TOLERANCE) {
      keep[at] = 1;
      stack.push([lo, at], [at, hi]);
    }
  }
  return ring.filter((_, i) => keep[i]);
}

const input = process.argv[2];
if (!input) throw new Error("usage: tsx scripts/land-mask.mts <ne_50m_land.geojson>");
const fc = JSON.parse(readFileSync(input, "utf8")) as { features: { geometry: { type: string; coordinates: unknown } }[] };
const polygons: number[][][] = [];
for (const f of fc.features) {
  const polys = (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates) as Ring[][];
  for (const poly of polys) {
    const rings = poly.map(simplify).filter((r) => r.length >= 4);
    if (rings.length === 0) continue;
    polygons.push(rings.map((r) => r.flatMap(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000])));
  }
}
const out = JSON.stringify({ source: "Natural Earth 1:50m land (public domain), simplified 0.005°", polygons });
writeFileSync(new URL("../data/land-10m.json", import.meta.url), out);
console.log(`${polygons.length} polygons, ${polygons.flat().reduce((n, r) => n + r.length / 2, 0)} points, ${(out.length / 1024).toFixed(0)} KB`);
