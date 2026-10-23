/**
 * US county outlines for layers that join county statistics (NOAA temperature anomalies, FEMA declarations) by FIPS.
 *
 * Source (since 2026-10-23, audit R15): the US Census Bureau's 2023 cartographic boundary file cb_2023_us_county_5m
 * (1:5,000,000, public domain), saved with the app as layers/_data/us-counties.json, so no server is asked. The Esri
 * Living Atlas service read before was unreachable on the FEMA run and left the disasters answer empty.
 *   https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_5m.zip
 *   3,235 counties and equivalents: the 50 states, DC, Puerto Rico and the island areas. Connecticut is drawn as its
 *   9 planning regions (FIPS 09110 to 09190, Census 2022), not the 8 old counties, as Esri's was.
 * Built 2026-10-23 with ogr2ogr (NAD83 to WGS84) and a small node script: coordinates rounded to 0.001° (about 100 m),
 * repeated points dropped, each ring stored as a Google encoded polyline of [lon, lat] (728 KB). Fields kept: GEOID
 * (5-digit FIPS), STUSPS, NAMELSAD ("Marin County", the same names Esri's NAME carried).
 * Each answer is simplified for its view (Douglas-Peucker at countyOffset, as Esri's maxAllowableOffset did) and
 * rounded to 3 decimals. Refresh by rebuilding from the next GENZ year when county lines change (rare).
 *
 * The Esri helpers below (countiesUrl, parseCounties) stay for the recorded fixtures the layer tests use, and as the
 * fallback should the saved file ever fail to load.
 *   https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Counties_Generalized_Boundaries/FeatureServer/0
 */
import type { Feature, Geometry, Position } from "geojson";
import type { BBox, QueryContext } from "../types";
import { UPSTREAM_TIMEOUT_MS } from "./constants";
import { jsonObjectBody } from "@/lib/fetch/validate";

export const COUNTIES_SERVICE =
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Counties_Generalized_Boundaries/FeatureServer/0";
export const COUNTIES_SOURCE = "US Census Bureau cartographic boundaries (cb_2023_us_county_5m), public domain";
const PAGE_SIZE = 2000;
const MAX_PAGES = 3;
const TTL_SECONDS = 7 * 86_400;

export type County = {
  /** Five-digit state + county FIPS, e.g. "06075". */
  fips: string;
  stateAbbr: string;
  /** Three-digit county FIPS within the state. */
  countyFips: string;
  name: string;
  geometry: Geometry;
};

export type CountiesResult = { ok: true; counties: County[]; truncated: boolean } | { ok: false; error: string };

/** Display simplification in degrees: about 1/400 of the view, between ~100 m and ~2 km. */
export function countyOffset(bbox: BBox): number {
  const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
  return Math.min(0.02, Math.max(0.001, Math.round((span / 400) * 1000) / 1000));
}

// ---------------------------------------------------------------------------------------------------------------
// Saved Census outlines (primary)

/** The saved file's shape: [GEOID, STUSPS, NAMELSAD, polygons of encoded-polyline rings]. */
export type SavedCounties = { scale: number; counties: [string, string, string, string[][]][] };

type Decoded = { fips: string; stateAbbr: string; name: string; polygons: { rings: Position[][]; box: BBox }[] };

/** One Google encoded-polyline ring of [lon, lat] (longitude first) at 1/scale degree. */
export function decodeRing(s: string, scale: number): Position[] {
  const out: Position[] = [];
  let i = 0;
  let x = 0;
  let y = 0;
  const next = () => {
    let shift = 0;
    let result = 0;
    let b: number;
    do {
      b = s.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && i < s.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < s.length) {
    x += next();
    y += next();
    out.push([x / scale, y / scale]);
  }
  return out;
}

function ringBox(ring: Position[], box: BBox): BBox {
  let [w, s, e, n] = box;
  for (const [x, y] of ring) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

/** Every county decoded once, with a box per polygon (the Aleutians straddle 180°, so a county box would span the globe). */
export function decodeCounties(saved: SavedCounties): Decoded[] {
  return saved.counties.map(([fips, stateAbbr, name, polys]) => ({
    fips,
    stateAbbr,
    name,
    polygons: polys.map((rings) => {
      const decoded = rings.map((r) => decodeRing(r, saved.scale));
      return { rings: decoded, box: ringBox(decoded[0], [Infinity, Infinity, -Infinity, -Infinity]) };
    }),
  }));
}

let saved: Promise<Decoded[]> | undefined;

/** The saved outlines, read and decoded on first use (a dynamic import keeps the 728 KB file out of other bundles). */
function savedCounties(): Promise<Decoded[]> {
  saved ??= import("../_data/us-counties.json")
    .then((m) => decodeCounties(((m as { default?: unknown }).default ?? m) as SavedCounties))
    .catch((err: unknown) => {
      saved = undefined;
      throw err;
    });
  return saved;
}

function perpDistSq(p: Position, a: Position, b: Position): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len));
  const ex = a[0] + t * dx - p[0];
  const ey = a[1] + t * dy - p[1];
  return ex * ex + ey * ey;
}

/** Douglas-Peucker on a closed ring, rounded to 3 decimals; a ring that would fall below 4 points stays whole. */
export function simplifyRing(ring: Position[], tolerance: number): Position[] {
  const round = (p: Position): Position => [Math.round(p[0] * 1000) / 1000 || 0, Math.round(p[1] * 1000) / 1000 || 0];
  if (ring.length <= 4 || tolerance <= 0) return ring.map(round);
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  // Split the closed ring at its farthest point from the start, so the two halves are open lines.
  let far = 1;
  let farD = -1;
  for (let i = 1; i < ring.length - 1; i++) {
    const d = (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2;
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  keep[far] = 1;
  const tolSq = tolerance * tolerance;
  const stack: [number, number][] = [
    [0, far],
    [far, ring.length - 1],
  ];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    let idx = -1;
    let max = tolSq;
    for (let i = a + 1; i < b; i++) {
      const d = perpDistSq(ring[i], ring[a], ring[b]);
      if (d > max) {
        max = d;
        idx = i;
      }
    }
    if (idx >= 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = ring.filter((_, i) => keep[i] === 1);
  return out.length >= 4 ? out.map(round) : ring.map(round);
}

function intersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** True when segment p-q enters the box (Liang-Barsky clipping). */
function segmentHitsBox(p: Position, q: Position, [w, s, e, n]: BBox): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  for (const [pk, qk] of [
    [-dx, p[0] - w],
    [dx, e - p[0]],
    [-dy, p[1] - s],
    [dy, n - p[1]],
  ]) {
    if (pk === 0) {
      if (qk < 0) return false;
    } else {
      const r = qk / pk;
      if (pk < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      if (t0 > t1) return false;
    }
  }
  return true;
}

function inRing([x, y]: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True when the polygon's outline crosses the box or one holds the other (as Esri's envelope "intersects" answers). */
export function polygonTouchesBox(outer: Position[], polyBox: BBox, bbox: BBox): boolean {
  if (!intersects(polyBox, bbox)) return false;
  for (let i = 1; i < outer.length; i++) if (segmentHitsBox(outer[i - 1], outer[i], bbox)) return true;
  // No edge enters the box: either the box sits inside the polygon or they are apart.
  return inRing([(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2], outer);
}

/** Counties with any polygon touching the bbox, ordered by FIPS, simplified for the view. */
export function countiesFromSaved(all: Decoded[], bbox: BBox): County[] {
  const tolerance = countyOffset(bbox);
  const out: County[] = [];
  for (const c of all) {
    if (!c.polygons.some((p) => polygonTouchesBox(p.rings[0], p.box, bbox))) continue;
    // Every polygon of the county is kept (a county is one feature), simplified for the view.
    const coords = c.polygons.map((p) => p.rings.map((r) => simplifyRing(r, tolerance)));
    out.push({
      fips: c.fips,
      stateAbbr: c.stateAbbr,
      countyFips: c.fips.slice(2),
      name: c.name,
      geometry: coords.length === 1 ? { type: "Polygon", coordinates: coords[0] } : { type: "MultiPolygon", coordinates: coords },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Esri Living Atlas (fallback)

export function countiesUrl(bbox: BBox, page: number): string {
  const params = new URLSearchParams({
    where: "1=1",
    outFields: "NAME,STATE_ABBR,COUNTY_FIPS,FIPS",
    geometry: bbox.join(","),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    maxAllowableOffset: String(countyOffset(bbox)),
    geometryPrecision: "3",
    orderByFields: "FIPS",
    resultOffset: String(page * PAGE_SIZE),
    resultRecordCount: String(PAGE_SIZE),
    f: "geojson",
  });
  return `${COUNTIES_SERVICE}/query?${params.toString()}`;
}

/** Counties from one page of the service's GeoJSON; rows without a FIPS or geometry are skipped. */
export function parseCounties(body: unknown): { counties: County[]; more: boolean } {
  if (typeof body !== "object" || body === null || !("features" in body) || !Array.isArray(body.features)) {
    return { counties: [], more: false };
  }
  const record = body as { features: Feature[]; exceededTransferLimit?: unknown; properties?: { exceededTransferLimit?: unknown } };
  const counties: County[] = [];
  for (const f of record.features) {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    if (f.geometry === null || typeof p.FIPS !== "string" || typeof p.STATE_ABBR !== "string") continue;
    counties.push({
      fips: p.FIPS,
      stateAbbr: p.STATE_ABBR,
      countyFips: typeof p.COUNTY_FIPS === "string" ? p.COUNTY_FIPS : p.FIPS.slice(2),
      name: typeof p.NAME === "string" ? p.NAME : p.FIPS,
      geometry: f.geometry,
    });
  }
  const more = record.exceededTransferLimit === true || record.properties?.exceededTransferLimit === true;
  return { counties, more };
}

/** The bbox grown outward to 0.01°, so nearby views share one cache entry and the query matches its key exactly. */
export function roundedBbox([w, s, e, n]: BBox): BBox {
  const down = (v: number) => Math.floor(Math.round(v * 1e6) / 1e4) / 100;
  const up = (v: number) => Math.ceil(Math.round(v * 1e6) / 1e4) / 100;
  return [Math.max(-180, down(w)), Math.max(-90, down(s)), Math.min(180, up(e)), Math.min(90, up(n))];
}

/** Every county touching the bbox from Esri, read page by page and cached a week (the fallback). */
export async function countiesFromEsri(ctx: QueryContext, bbox: BBox): Promise<CountiesResult> {
  const rounded = roundedBbox(bbox);
  const key = rounded.map((n) => n.toFixed(2)).join(",");
  const counties: County[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    let body: unknown;
    try {
      const res = await ctx.fetch(countiesUrl(rounded, page), {
        cacheKey: `counties:v1:${key}:${page}`,
        ttlSeconds: TTL_SECONDS,
        validate: jsonObjectBody({ listKey: "features", minLength: 0 }),
        timeoutMs: UPSTREAM_TIMEOUT_MS,
      });
      if (!res.ok) return { ok: false, error: `County outlines (Esri) returned ${res.status}` };
      body = await res.json();
    } catch (err) {
      const timedOut = typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
      return { ok: false, error: timedOut ? `County outlines timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds` : "County outlines returned no usable response" };
    }
    const { counties: rows, more } = parseCounties(body);
    counties.push(...rows);
    if (!more) return { ok: true, counties, truncated: false };
  }
  return { ok: true, counties, truncated: true };
}

/**
 * Every county touching the bbox, from the saved Census outlines (no network); Esri only if the saved file fails to
 * load. Never truncated: the whole country is 3,235 counties.
 */
export async function countiesInBbox(ctx: QueryContext, bbox: BBox): Promise<CountiesResult> {
  let all: Decoded[];
  try {
    all = await savedCounties();
  } catch {
    return countiesFromEsri(ctx, bbox);
  }
  return { ok: true, counties: countiesFromSaved(all, bbox), truncated: false };
}
