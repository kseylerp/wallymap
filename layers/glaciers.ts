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
 * Wide mode (over 8,000 km², up to the default hard cap of 32,000 km²): the 1,500 largest outline rows (sortBy db_area D, maxFeatures),
 * every glacier among them kept with the one-outline-per-date series, thinned to about 400 m, plus a WFS 1.1 hits count quoted when the
 * row limit cut some off. Smoke wide 2026-10-14 (through runLayer): Chugach -149,60.6,-145,61.8 (about 28,600 km²) returned 1,134 outlines
 * of 6,621 in 5.2 s (2.2 MB out; GLIMS sent about 37 MB raw), Columbia Glacier first.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext, type CardSpec, type Attribute, type FieldHelp } from "./types";
import { nameAttribute, timeAttribute } from "./_shared/bands";
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
/** Most outlines a wide result (over 8,000 km²) carries, the largest by area. */
const WIDE_LIMIT = 1_500;
/** Coarser thinning for a wide view (about 400 m), seen at a scale where 40 m detail is far below a pixel. */
const WIDE_VERTEX_STEP_DEG = 0.004;

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

function outlineFilter(bbox: BBox): string {
  const [west, south, east, north] = bbox;
  return `BBOX(entity_geom,${west},${south},${east},${north},'EPSG:4326') AND line_type='glac_bound'`;
}

/** WFS request URL for outlines inside a bbox, largest first, at most `rows` of them. */
export function glimsUrl(bbox: BBox, rows: number = MAX_ROWS): string {
  const search = new URLSearchParams({
    service: "WFS",
    version: "1.0.0",
    request: "GetFeature",
    typeName: "GLIMS:GLIMS_Glacier_Outlines",
    outputFormat: "application/json",
    maxFeatures: String(rows),
    sortBy: "db_area D",
    cql_filter: outlineFilter(bbox),
  });
  return `${ENDPOINT}?${search.toString()}`;
}

/** WFS 1.1 `resultType=hits` URL: the number of outlines in the box (`numberOfFeatures` in a small XML answer), no geometry. */
export function glimsCountUrl(bbox: BBox): string {
  const search = new URLSearchParams({
    service: "WFS",
    version: "1.1.0",
    request: "GetFeature",
    typeName: "GLIMS:GLIMS_Glacier_Outlines",
    resultType: "hits",
    cql_filter: outlineFilter(bbox),
  });
  return `${ENDPOINT}?${search.toString()}`;
}

/** The outline count from a hits answer, or undefined on any failure. */
async function glimsCount(ctx: QueryContext, bbox: BBox): Promise<number | undefined> {
  try {
    const res = await ctx.fetch(glimsCountUrl(bbox), {
      cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:glims:count`,
      ttlSeconds: TTL_SECONDS,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const m = /numberOfFeatures="(\d+)"/.exec(await res.text());
    return m === null ? undefined : Number(m[1]);
  } catch {
    return undefined;
  }
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Drops vertices within `step` degrees of the last kept one; a ring that collapses below 4 positions is dropped. */
function thinRing(ring: Position[], step: number): Position[] | null {
  if (ring.length < 4) return null;
  const out: Position[] = [[round4(ring[0][0]), round4(ring[0][1])]];
  for (let i = 1; i < ring.length - 1; i++) {
    const last = out[out.length - 1];
    const p: Position = [round4(ring[i][0]), round4(ring[i][1])];
    if (Math.abs(p[0] - last[0]) >= step || Math.abs(p[1] - last[1]) >= step) out.push(p);
  }
  out.push(out[0]);
  return out.length >= 4 ? out : null;
}

function thinPolygon(rings: Position[][], step: number): Position[][] | null {
  const [outer, ...holes] = rings;
  const thinnedOuter = outer ? thinRing(outer, step) : null;
  if (thinnedOuter === null) return null;
  const thinnedHoles = holes.map((r) => thinRing(r, step)).filter((r): r is Position[] => r !== null);
  return [thinnedOuter, ...thinnedHoles];
}

/** Display geometry with the vertex count cut by thinning (MIN_VERTEX_STEP_DEG by default); null when nothing is left. */
export function thinGeometry(geometry: Geometry | null, step: number = MIN_VERTEX_STEP_DEG): Geometry | null {
  if (geometry === null) return null;
  if (geometry.type === "Polygon") {
    const rings = thinPolygon(geometry.coordinates, step);
    return rings === null ? null : { type: "Polygon", coordinates: rings };
  }
  if (geometry.type === "MultiPolygon") {
    const polygons = geometry.coordinates.map((p) => thinPolygon(p, step)).filter((p): p is Position[][] => p !== null);
    return polygons.length === 0 ? null : { type: "MultiPolygon", coordinates: polygons };
  }
  return null;
}

type Row = {
  id: string;
  area: number;
  time: number;
  /** The glacier's name when it has a real one (not a region code or placeholder). */
  name: string | undefined;
  center: [number, number];
  feature: Feature<Geometry>;
};

/** Two outlines of the same name and date whose centres are closer than this (degrees, about 2 km) are one glacier mapped twice. */
const SAME_PLACE_DEG = 0.02;

function centerOf(geometry: Geometry): [number, number] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number") {
      west = Math.min(west, c[0]);
      east = Math.max(east, c[0]);
      south = Math.min(south, c[1] as number);
      north = Math.max(north, c[1] as number);
    } else c.forEach(visit);
  };
  visit((geometry as { coordinates?: unknown }).coordinates);
  return [(west + east) / 2, (south + north) / 2];
}

/**
 * Converts WFS rows to polygons with name, glacierId, areaKm2, date, t (the source image date), v (area km2) and
 * institution. Every dated outline is kept, so a glacier mapped in 1984 and 2014 comes back twice. Duplicates go two ways:
 * the same glacier id and date keeps the larger outline, and so does a named glacier with the same date and a near-identical
 * position under a different id (GLIMS gives Lyell Glacier two ids), whose ids are then merged under the larger one's id so
 * the dates form one series. The `truncated` flag is set when more than `maxGlaciers` glaciers were present: the largest by
 * any outline are kept, with all of their outlines, oldest first. A wide view passes no glacier cap (its row limit bounds it)
 * and a coarser vertex step.
 */
export function normalizeGlaciers(
  json: unknown,
  options: { maxGlaciers?: number; stepDeg?: number } = {},
): { data: FeatureCollection; truncated: boolean } {
  const maxGlaciers = options.maxGlaciers ?? MAX_GLACIERS;
  const empty = { data: { type: "FeatureCollection", features: [] } as FeatureCollection, truncated: false };
  if (typeof json !== "object" || json === null || !("features" in json) || !Array.isArray(json.features)) return empty;

  const rows: Row[] = [];
  let anonymous = 0;
  for (const raw of json.features as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const f = raw as { geometry?: Geometry | null; properties?: Record<string, unknown> | null };
    const p = f.properties ?? {};
    if (str(p.line_type) !== undefined && p.line_type !== "glac_bound") continue;
    const area = num(p.db_area);
    if (area === undefined) continue;
    const geometry = thinGeometry(f.geometry ?? null, options.stepDeg);
    if (geometry === null) continue;

    const id = str(p.glac_id) ?? `row-${anonymous++}`;
    const srcDate = typeof p.src_date === "string" ? Date.parse(p.src_date) : Number.NaN;
    const dated = Number.isFinite(srcDate);
    const name = glacierName(p.glac_name);
    const properties: Record<string, string | number> = {
      name: name ?? "Unnamed glacier",
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

    rows.push({ id, area, time: dated ? srcDate : 0, name, center: centerOf(geometry), feature: { type: "Feature", geometry, properties } });
  }
  rows.sort((a, b) => b.area - a.area);

  // Ids that turn out to be one glacier map to the id of the larger outline.
  const parent = new Map<string, string>();
  const root = (id: string): string => {
    let r = id;
    while (parent.has(r)) r = parent.get(r) as string;
    return r;
  };

  const seen = new Set<string>();
  const byNameDate = new Map<string, Row[]>();
  const unique: Row[] = [];
  for (const r of rows) {
    const key = `${r.id}|${r.time || "undated"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.name !== undefined && r.time !== 0) {
      const group = byNameDate.get(`${r.name}|${r.time}`) ?? [];
      const twin = group.find((o) => Math.abs(o.center[0] - r.center[0]) < SAME_PLACE_DEG && Math.abs(o.center[1] - r.center[1]) < SAME_PLACE_DEG);
      if (twin !== undefined) {
        if (root(twin.id) !== root(r.id)) parent.set(root(r.id), root(twin.id));
        continue;
      }
      group.push(r);
      byNameDate.set(`${r.name}|${r.time}`, group);
    }
    unique.push(r);
  }

  // Merged ids now share a root, so the same date can appear twice under it: the larger outline wins.
  const outlines = new Map<string, Row>();
  for (const r of unique) {
    const id = root(r.id);
    if (id !== r.id && r.feature.properties) r.feature.properties.glacierId = id;
    r.id = id;
    const key = `${id}|${r.time || "undated"}`;
    if (!outlines.has(key)) outlines.set(key, r);
  }

  // A glacier ranks by its biggest outline, so a shrinking glacier keeps its place whichever year is shown.
  const biggest = new Map<string, number>();
  for (const r of outlines.values()) biggest.set(r.id, Math.max(biggest.get(r.id) ?? 0, r.area));
  const ranked = [...biggest.entries()].sort((a, b) => b[1] - a[1]);
  const truncated = ranked.length > maxGlaciers;
  const keep = new Set(ranked.slice(0, maxGlaciers).map(([id]) => id));
  const order = new Map(ranked.map(([id], i) => [id, i]));

  const kept = [...outlines.values()]
    .filter((r) => keep.has(r.id))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0) || a.time - b.time);
  return { data: { type: "FeatureCollection", features: kept.map((r) => r.feature) }, truncated };
}

function isTimeout(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
}

const ATTRIBUTES: Attribute[] = [{ key: "areaKm2", type: "measure", label: "Area", unit: "km²", encode: "size" }, timeAttribute("Mapped"), nameAttribute()];

const AREA: FieldHelp = {
  text: "The glacier's area in this outline as GLIMS records it (db_area), for the date of the image it was mapped from.",
  unit: "km²",
  source: "GLIMS Glacier Database (NSIDC / University of Arizona)",
  url: "https://www.glims.org/",
};

const HELP: Record<string, FieldHelp> = {
  areaKm2: AREA,
  v: AREA,
  date: { text: "When the satellite or aerial image behind this outline was taken; the ice has usually changed since." },
  glacierId: { text: "The GLIMS glacier id; outlines of one glacier from different dates share it." },
  institution: { text: "The team that mapped this outline for GLIMS." },
};

const CARD: CardSpec = {
  measure: { key: "areaKm2", label: "Area", unit: "km²" },
  facts: [
    { key: "date", label: "Mapped from image of", format: "date" },
    { key: "institution", label: "Mapped by" },
    { key: "glacierId", label: "GLIMS id" },
  ],
};

const glaciers = defineLayer({
  id: "glaciers",
  title: "Glaciers",
  description:
    "Outlines of the world's glaciers and ice caps from GLIMS (Global Land Ice Measurements from Space), drawn as polygons. " +
    "Each polygon has name (many glaciers are unnamed), glacierId, v and areaKm2 (the glacier's area in square kilometres), t and date (when the satellite image behind that outline was taken) and institution (who mapped it). " +
    "A glacier mapped more than once comes back once per image date with the same glacierId, so the time scrubber plays its retreat: Lyell and Maclure Glaciers in Yosemite shrink between 1984 and 2014 (Lyell from 0.37 to 0.25 km², Maclure from 0.26 to 0.14 km²). Compare v across dates of one glacierId to say how much ice it lost. " +
    "Use it to show where glaciers are, which are biggest, how much ice a range holds, and how glaciers have shrunk, for example 'where are the glaciers near Mount Rainier', 'the largest glaciers in this part of Alaska' or 'show how Lyell Glacier has retreated'. With 3D on, the map can raise glaciers by area. " +
    "Caveats: this is an inventory, not a current survey. The outlines date from about 1970 to the 2020s depending on the glacier, so the date matters and most glaciers have shrunk since; do not read the newest outline as today's ice edge. Many glaciers have only one date, and different teams and image dates make some outline changes partly mapping differences, not melt. " +
    "GLIMS sometimes gives one glacier two ids (Lyell Glacier has two); named glaciers with the same date and place are merged under one glacierId, but unnamed ones can still overlap. Some small ice patches are listed as glaciers and some real glaciers are missing. " +
    "At most the 300 largest glaciers in view are returned (each with all its dated outlines). Outlines are simplified for display (details under about 40 m are dropped). " +
    "Works worldwide. Over 8,000 km² (about a 90 km square) it returns the 1,500 largest outlines, drawn coarser (about 400 m).",
  coverage: "global",
  surface: "land",
  license: "Free to use, cite GLIMS (NSIDC / University of Arizona)",
  requiredEnv: [],
  maxAreaKm2: 8_000,
  wide: { orderBy: "area in km²", limit: WIDE_LIMIT },
  input: inputSchema,
  style: {
    geometry: "polygon",
    color: layerColor("glaciers"),
    unit: "km²",
    fillOpacity: 0.3,
    extrude: "v",
  },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,

  async query(ctx): Promise<LayerResult | LayerError> {
    // Wide (over 8,000 km², up to the hard cap): the largest outlines by area, server-sorted and capped at the strategy's
    // limit, with a parallel hits count. GLIMS has no simplification, so the raw answer stays large (about 37 MB for 1,500
    // Alaska outlines) and is thinned to about 400 m here.
    const wideRows = ctx.wide ? Math.min(WIDE_LIMIT, ctx.wideStrategy?.limit ?? WIDE_LIMIT) : undefined;
    const counting = wideRows === undefined ? Promise.resolve(undefined) : glimsCount(ctx, ctx.bbox);

    let body: unknown;
    try {
      const res = await ctx.fetch(glimsUrl(ctx.bbox, wideRows ?? MAX_ROWS), {
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

    const { data, truncated } =
      wideRows === undefined ? normalizeGlaciers(body) : normalizeGlaciers(body, { maxGlaciers: Infinity, stepDeg: WIDE_VERTEX_STEP_DEG });
    const rows =
      typeof body === "object" && body !== null && "features" in body && Array.isArray(body.features) ? body.features.length : 0;
    // The count is of outline rows (repeats included), so it is only quoted when the row limit cut some off.
    const count = await counting;
    const total = wideRows !== undefined && rows >= wideRows && count !== undefined && count > data.features.length ? count : undefined;
    const notes: string[] = [];
    const years = [...new Set(data.features.map((f) => String(f.properties?.date ?? "").slice(0, 4)).filter((y) => y !== ""))].sort();
    if (years.length > 0) {
      notes.push(
        `Outlines exist only for the dates glaciers were mapped (years in view: ${years.slice(0, 8).join(", ")}${years.length > 8 ? " and more" : ""}); the ice between those dates is not shown`,
      );
    }
    if (wideRows !== undefined) {
      // run.ts writes the "showing the N largest" note.
    } else if (truncated) {
      notes.push(`Showing the ${MAX_GLACIERS} largest glaciers in view; zoom in for smaller ones`);
    } else if (rows >= MAX_ROWS) {
      notes.push(`Showing the ${MAX_ROWS} biggest outlines in view; some later outlines of smaller glaciers may be missing, so zoom in`);
    }

    return {
      kind: "geojson",
      data,
      ...(total !== undefined && { total }),
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
