/**
 * Glacier outlines from GLIMS (Global Land Ice Measurements from Space, NSIDC / University of Arizona).
 * Service (verified live 2026-10-09, keyless, no access constraints in the capabilities document):
 *   https://www.glims.org/geoserver/ows  (GeoServer WFS 1.0.0, outputFormat=application/json)
 *   feature type GLIMS:GLIMS_Glacier_Outlines, polygons in EPSG:4326, geometry field entity_geom.
 * Fields read: glac_id (glacier id, e.g. "G240577E37693N"), glac_name (often just a region code such as "CA"
 * or null), db_area (outline area, km2), src_date (date of the source image, ISO), line_type ("glac_bound" is the
 * glacier outline; other types are internal rock and debris lines, filtered out), chief_affl (analysing institution).
 * Query used: cql_filter=BBOX(entity_geom,w,s,e,n,'EPSG:4326') AND line_type='glac_bound', sortBy=db_area D,
 * maxFeatures=MAX_ROWS. `sortBy` works on this server (checked: Columbia Glacier first at 943 km2).
 * Notes from live requests:
 *   - The same glacier is often outlined several times (different image dates and institutions), usually under the
 *     same glac_id. Every dated outline is kept, de-duplicated by glac_id plus src_date (the larger outline wins a tie),
 *     with `t` = src_date, so the time scrubber plays the retreat. Lyell and Maclure Glaciers (Yosemite, box
 *     -119.30,37.70,-119.20,37.78, 86 outlines) have 1984 and 2014 outlines under one id each (Lyell G240728E37743N 0.369 km2
 *     in 1984 to 0.253 in 2014; Maclure G240720E37746N 0.263 to 0.142), and the small ice patches around them 1975, 1984 and 2013/2014.
 *     Outlines of one glacier made under different ids can still overlap.
 *   - Outlines are very detailed and WFS 1.0 cannot simplify them: the 5 largest Alaska glaciers were 2.8 MB, 391
 *     outlines over 20 km2 in a 5 x 2 degree box were 35 MB. Hence the small maxAreaKm2, the row cap and the
 *     vertex thinning below. A response is therefore cached only when small.
 * Smoke through runLayer (2026-10-09, one outline per glacier): Sierra Nevada box -119.6,37.5,-119.0,38.0 returned 211 glaciers in 0.5 s (119 KB
 * after thinning); Eklutna area of Alaska -150,60.9,-149,61.5 returned 123 in 0.4 s (163 KB).
 * Smoke after keeping every dated outline (2026-10-10): Lyell/Maclure box -119.30,37.70,-119.20,37.78 returned 86 outlines in 3.3 s
 * (54 KB); Sierra box above 249 outlines in 1.1 s (151 KB); Eklutna box 141 in 0.8 s (225 KB); Mount Rainier box -121.9,46.7,-121.5,47.0
 * 440 outlines in 0.7 s (627 KB).
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { layerColor } from "@/lib/render/palette";

const ENDPOINT = "https://www.glims.org/geoserver/ows";
/**
 * Rows requested, largest outline first. Every dated outline of a glacier is a row, so this is about three times
 * MAX_GLACIERS; a view that fills it may be missing later (smaller) outlines of its smaller glaciers.
 */
const MAX_ROWS = 900;
/** Glaciers returned, largest first; each comes with all of its dated outlines. */
const MAX_GLACIERS = 300;
/** Outlines change on the scale of years. */
const TTL_SECONDS = 7 * 86_400;
/** Largest response body written to the shared cache. */
const MAX_CACHED_CHARS = 4_000_000;
/** Vertices closer than this (degrees, about 40 m) to the last kept one are dropped from the display geometry. */
const MIN_VERTEX_STEP_DEG = 0.0004;

const inputSchema = z.object({});

const GENERIC_NAMES = new Set(["", "none", "null", "unnamed", "unknown"]);

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A readable name, or undefined when the record only holds a region code ("CA") or a placeholder. */
function glacierName(raw: unknown): string | undefined {
  const name = str(raw);
  if (name === undefined) return undefined;
  if (GENERIC_NAMES.has(name.toLowerCase())) return undefined;
  if (name.length <= 2) return undefined;
  return name;
}

/** WFS request URL for outlines inside a bbox. */
export function glimsUrl(bbox: BBox): string {
  const [west, south, east, north] = bbox;
  const search = new URLSearchParams({
    service: "WFS",
    version: "1.0.0",
    request: "GetFeature",
    typeName: "GLIMS:GLIMS_Glacier_Outlines",
    outputFormat: "application/json",
    maxFeatures: String(MAX_ROWS),
    sortBy: "db_area D",
    cql_filter: `BBOX(entity_geom,${west},${south},${east},${north},'EPSG:4326') AND line_type='glac_bound'`,
  });
  return `${ENDPOINT}?${search.toString()}`;
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Drops vertices within MIN_VERTEX_STEP_DEG of the last kept one; a ring that collapses below 4 positions is dropped. */
function thinRing(ring: Position[]): Position[] | null {
  if (ring.length < 4) return null;
  const out: Position[] = [[round4(ring[0][0]), round4(ring[0][1])]];
  for (let i = 1; i < ring.length - 1; i++) {
    const last = out[out.length - 1];
    const p: Position = [round4(ring[i][0]), round4(ring[i][1])];
    if (Math.abs(p[0] - last[0]) >= MIN_VERTEX_STEP_DEG || Math.abs(p[1] - last[1]) >= MIN_VERTEX_STEP_DEG) out.push(p);
  }
  out.push(out[0]);
  return out.length >= 4 ? out : null;
}

function thinPolygon(rings: Position[][]): Position[][] | null {
  const [outer, ...holes] = rings;
  const thinnedOuter = outer ? thinRing(outer) : null;
  if (thinnedOuter === null) return null;
  const thinnedHoles = holes.map(thinRing).filter((r): r is Position[] => r !== null);
  return [thinnedOuter, ...thinnedHoles];
}

/** Display geometry with the vertex count cut by thinning; null when nothing is left. */
export function thinGeometry(geometry: Geometry | null): Geometry | null {
  if (geometry === null) return null;
  if (geometry.type === "Polygon") {
    const rings = thinPolygon(geometry.coordinates);
    return rings === null ? null : { type: "Polygon", coordinates: rings };
  }
  if (geometry.type === "MultiPolygon") {
    const polygons = geometry.coordinates.map(thinPolygon).filter((p): p is Position[][] => p !== null);
    return polygons.length === 0 ? null : { type: "MultiPolygon", coordinates: polygons };
  }
  return null;
}

type Row = { id: string; area: number; time: number; feature: Feature<Geometry> };

/**
 * Converts WFS rows to polygons with name, glacierId, areaKm2, date, t (the source image date), v (area km2) and
 * institution. Every dated outline is kept, de-duplicated by glacier id plus date (the larger outline wins a tie), so a
 * glacier mapped in 1984 and 2014 comes back twice. The `truncated` flag is set when more than MAX_GLACIERS glaciers
 * were present: the largest by any outline are kept, with all of their outlines, oldest first.
 */
export function normalizeGlaciers(json: unknown): { data: FeatureCollection; truncated: boolean } {
  const empty = { data: { type: "FeatureCollection", features: [] } as FeatureCollection, truncated: false };
  if (typeof json !== "object" || json === null || !("features" in json) || !Array.isArray(json.features)) return empty;

  const outlines = new Map<string, Row>();
  let anonymous = 0;
  for (const raw of json.features as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const f = raw as { geometry?: Geometry | null; properties?: Record<string, unknown> | null };
    const p = f.properties ?? {};
    if (str(p.line_type) !== undefined && p.line_type !== "glac_bound") continue;
    const area = num(p.db_area);
    if (area === undefined) continue;
    const geometry = thinGeometry(f.geometry ?? null);
    if (geometry === null) continue;

    const id = str(p.glac_id) ?? `row-${anonymous++}`;
    const srcDate = typeof p.src_date === "string" ? Date.parse(p.src_date) : Number.NaN;
    const dated = Number.isFinite(srcDate);
    const properties: Record<string, string | number> = {
      name: glacierName(p.glac_name) ?? "Unnamed glacier",
      glacierId: id,
      areaKm2: Math.round(area * 1000) / 1000,
      v: Math.round(area * 1000) / 1000,
    };
    if (dated) {
      properties.t = new Date(srcDate).toISOString();
      properties.date = properties.t.slice(0, 10);
    }
    const institution = str(p.chief_affl);
    if (institution !== undefined) properties.institution = institution;

    const row: Row = { id, area, time: dated ? srcDate : 0, feature: { type: "Feature", geometry, properties } };
    const key = `${id}|${dated ? srcDate : "undated"}`;
    const kept = outlines.get(key);
    if (kept === undefined || row.area > kept.area) outlines.set(key, row);
  }

  // A glacier ranks by its biggest outline, so a shrinking glacier keeps its place whichever year is shown.
  const biggest = new Map<string, number>();
  for (const r of outlines.values()) biggest.set(r.id, Math.max(biggest.get(r.id) ?? 0, r.area));
  const ranked = [...biggest.entries()].sort((a, b) => b[1] - a[1]);
  const truncated = ranked.length > MAX_GLACIERS;
  const keep = new Set(ranked.slice(0, MAX_GLACIERS).map(([id]) => id));
  const order = new Map(ranked.map(([id], i) => [id, i]));

  const rows = [...outlines.values()]
    .filter((r) => keep.has(r.id))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0) || a.time - b.time);
  return { data: { type: "FeatureCollection", features: rows.map((r) => r.feature) }, truncated };
}

function isTimeout(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
}

const glaciers = defineLayer({
  id: "glaciers",
  title: "Glaciers",
  description:
    "Outlines of the world's glaciers and ice caps from GLIMS (Global Land Ice Measurements from Space), drawn as polygons. " +
    "Each polygon has name (many glaciers are unnamed), glacierId, v and areaKm2 (the glacier's area in square kilometres), t and date (when the satellite image behind that outline was taken) and institution (who mapped it). " +
    "A glacier mapped more than once comes back once per image date with the same glacierId, so the time scrubber plays its retreat: Lyell and Maclure Glaciers in Yosemite shrink between 1984 and 2014 (Lyell from 0.37 to 0.25 km², Maclure from 0.26 to 0.14 km²). Compare v across dates of one glacierId to say how much ice it lost. " +
    "Use it to show where glaciers are, which are biggest, how much ice a range holds, and how glaciers have shrunk, for example 'where are the glaciers near Mount Rainier', 'the largest glaciers in this part of Alaska' or 'show how Lyell Glacier has retreated'. With 3D on, the map can raise glaciers by area. " +
    "Caveats: this is an inventory, not a current survey. The outlines date from about 1970 to the 2020s depending on the glacier, so the date matters and most glaciers have shrunk since; do not read the newest outline as today's ice edge. Many glaciers have only one date, and different teams and image dates make some outline changes partly mapping differences, not melt. " +
    "A glacier can also be mapped under more than one id, so a few outlines overlap. Some small ice patches are listed as glaciers and some real glaciers are missing. " +
    "At most the 300 largest glaciers in view are returned (each with all its dated outlines) and the result says when it trims, so zoom in for the rest. Outlines are simplified for display (details under about 40 m are dropped). " +
    "Works anywhere in the world, but only for areas under 8,000 km² (about a 90 km square), so zoom in to a range or a single mountain first.",
  coverage: "global",
  license: "Free to use, cite GLIMS (NSIDC / University of Arizona)",
  requiredEnv: [],
  maxAreaKm2: 8_000,
  input: inputSchema,
  style: {
    geometry: "polygon",
    color: layerColor("glaciers"),
    fillOpacity: 0.3,
    extrude: "v",
  },

  async query(ctx): Promise<LayerResult | LayerError> {
    const area = bboxAreaKm2(ctx.bbox);
    if (area > glaciers.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${glaciers.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    let body: unknown;
    try {
      const res = await ctx.fetch(glimsUrl(ctx.bbox), {
        cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:glims`,
        ttlSeconds: TTL_SECONDS,
        shouldCache: (text) => text.length <= MAX_CACHED_CHARS && text.trimStart().startsWith("{"),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!res.ok) return { error: `GLIMS returned ${res.status}`, hint: "upstream" };
      const text = await res.text();
      try {
        body = JSON.parse(text);
      } catch {
        // GeoServer reports bad requests as an XML ServiceExceptionReport with a 200.
        return { error: "GLIMS returned a response that is not GeoJSON", hint: "upstream" };
      }
    } catch (err) {
      return {
        error: isTimeout(err)
          ? `GLIMS timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds`
          : "GLIMS returned no response",
        hint: "upstream",
      };
    }

    const { data, truncated } = normalizeGlaciers(body);
    const rows =
      typeof body === "object" && body !== null && "features" in body && Array.isArray(body.features) ? body.features.length : 0;
    const notes: string[] = [];
    if (truncated) {
      notes.push(`Showing the ${MAX_GLACIERS} largest glaciers in view; zoom in for smaller ones`);
    } else if (rows >= MAX_ROWS) {
      notes.push(`Showing the ${MAX_ROWS} biggest outlines in view; some later outlines of smaller glaciers may be missing, so zoom in`);
    }

    return {
      kind: "geojson",
      data,
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
      citation: {
        source: "GLIMS Glacier Database (Raup et al.; NSIDC / University of Arizona), outlines from many contributing institutions",
        url: "https://www.glims.org/",
        retrieved: new Date().toISOString(),
      },
    };
  },
});

registerLayer(glaciers);

export default glaciers;
