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
 *   - The same glacier is often outlined several times (different image dates and institutions), some under the
 *     same glac_id. Rows are de-duplicated by glac_id keeping the newest src_date; outlines of one glacier made
 *     under different ids can still overlap.
 *   - Outlines are very detailed and WFS 1.0 cannot simplify them: the 5 largest Alaska glaciers were 2.8 MB, 391
 *     outlines over 20 km2 in a 5 x 2 degree box were 35 MB. Hence the small maxAreaKm2, the row cap and the
 *     vertex thinning below. A response is therefore cached only when small.
 * Smoke through runLayer (2026-10-09): Sierra Nevada box -119.6,37.5,-119.0,38.0 returned 211 glaciers in 0.5 s (119 KB after
 * thinning); Eklutna area of Alaska -150,60.9,-149,61.5 returned 123 in 0.4 s (163 KB).
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { layerColor } from "@/lib/render/palette";

const ENDPOINT = "https://www.glims.org/geoserver/ows";
/** Rows requested (largest first); about half again as many as are kept, to survive de-duplication. */
const MAX_ROWS = 450;
/** Glaciers returned after de-duplication, largest first. */
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

type Row = { id: string; srcDate: number; feature: Feature<Geometry> };

/**
 * Converts WFS rows to polygons with name, glacierId, areaKm2, date, t, v (area km2) and institution.
 * Keeps the newest outline per glac_id, orders largest first and caps at MAX_GLACIERS (`truncated` says it did).
 */
export function normalizeGlaciers(json: unknown): { data: FeatureCollection; truncated: boolean } {
  const empty = { data: { type: "FeatureCollection", features: [] } as FeatureCollection, truncated: false };
  if (typeof json !== "object" || json === null || !("features" in json) || !Array.isArray(json.features)) return empty;

  const newest = new Map<string, Row>();
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
    const properties: Record<string, string | number> = {
      name: glacierName(p.glac_name) ?? "Unnamed glacier",
      glacierId: id,
      areaKm2: Math.round(area * 1000) / 1000,
      v: Math.round(area * 1000) / 1000,
    };
    if (Number.isFinite(srcDate)) {
      properties.t = new Date(srcDate).toISOString();
      properties.date = properties.t.slice(0, 10);
    }
    const institution = str(p.chief_affl);
    if (institution !== undefined) properties.institution = institution;

    const row: Row = { id, srcDate: Number.isFinite(srcDate) ? srcDate : 0, feature: { type: "Feature", geometry, properties } };
    const kept = newest.get(id);
    if (kept === undefined || row.srcDate > kept.srcDate) newest.set(id, row);
  }

  const sorted = [...newest.values()].sort((a, b) => Number(b.feature.properties?.v) - Number(a.feature.properties?.v));
  const truncated = sorted.length > MAX_GLACIERS;
  return {
    data: { type: "FeatureCollection", features: sorted.slice(0, MAX_GLACIERS).map((r) => r.feature) },
    truncated,
  };
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
    "Use it to show where glaciers are, which are biggest, and how much ice a range holds, for example 'where are the glaciers near Mount Rainier' or 'the largest glaciers in this part of Alaska'. In 3D the glaciers rise as columns by area. " +
    "Caveats: this is an inventory, not a current survey. The outlines date from about 1970 to the 2020s depending on the glacier, so the date matters and most glaciers have shrunk since; do not read the outline as today's ice edge. " +
    "A glacier can be mapped by several teams, so a few outlines overlap, and only the newest outline per glacier id is kept. Some small ice patches are listed as glaciers and some real glaciers are missing. " +
    "At most the 300 largest glaciers in view are returned and the result says when it trims, so zoom in for the rest. Outlines are simplified for display (details under about 40 m are dropped). " +
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
    if (truncated || rows >= MAX_ROWS) {
      notes.push(`Showing the ${MAX_GLACIERS} largest glaciers in view; zoom in for smaller ones`);
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
