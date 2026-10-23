/**
 * Hiking paths and named hiking routes from OpenStreetMap via Overpass. Under PATH_MAX_AREA_KM2 (the soft cap) one query
 * returns the path, footway and track ways; between it and ROUTE_MAX_AREA_KM2 (the hard cap) run.ts calls the layer in
 * wide mode and it answers with named hiking route relations, longest inside the box first (scan, then geometry).
 * It also exports the scan-then-fetch helpers the other OSM line layers (mtb-trails, ski-routes) use for their own
 * wide mode: buildNamedScanQuery, pickNamedByLength, buildNamedGeometryQuery and longestNamedFirst.
 * Live smoke check (wide), 2026-10-14: Utah and Colorado (-112,36 to -106,41, about 290,000 km²): 150 routes kept of 170 named (longest the CDT Colorado Section, 912 km inside the box), 5.7 s.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry, LineString, MultiLineString, Position } from "geojson";
import {
  bboxAreaKm2,
  defineLayer,
  hardMaxAreaKm2,
  type BBox,
  type LayerError,
  type LayerResult,
  type QueryContext,
  type CardSpec,
  type Attribute,
  type FieldHelp,
  type LegendSpec,
} from "./types";
import { SAC_LEVELS, SAC_SCALE, nameAttribute } from "./_shared/bands";
import { registerLayer } from "./registry";
import { overpassQuery } from "./_shared/overpass";
import { haversineKm } from "./_shared/geo";
import { addClimb, mergeHikes } from "./_shared/hikes";
import { SAGE, layerColor } from "@/lib/render/palette";

export { overpassFailure } from "./_shared/overpass";

const SAC_SCALES = [
  "hiking",
  "mountain_hiking",
  "demanding_mountain_hiking",
  "alpine_hiking",
  "demanding_alpine_hiking",
  "difficult_alpine_hiking",
] as const;

/** Most trails returned. A dense 2,500 km² box holds tens of thousands of ways (tens of MB with geometry). */
export const MAX_TRAILS = 2_000;

/** Largest box that gets individual paths (the layer's maxAreaKm2); a wider one gets named hiking routes instead. */
export const PATH_MAX_AREA_KM2 = 2_500;
/** Largest box that gets named hiking routes (the layer's hardMaxAreaKm2); the layer errors above it. */
export const ROUTE_MAX_AREA_KM2 = 400_000;
/** Most routes returned, longest first (the wide strategy's limit). */
export const MAX_ROUTES = 150;
/** Most routes read (tags and bounds only) to pick the longest from; Overpass cuts by id past this. */
export const ROUTE_SCAN_MAX = 5_000;
/**
 * Stop adding routes once their estimated length inside the box adds up to this many km. In a dense box (the Swiss
 * Alps hold 11,000 route relations in 68,000 km²) the 150 longest are 35 MB of geometry; this keeps the answer
 * to a few MB. At least MIN_ROUTES are always taken.
 */
export const ROUTE_KM_BUDGET = 6_000;
const MIN_ROUTES = 20;

/** The coverage note for a capped result: how many are shown of how many ways the box holds. */
export function truncatedNote(shown: number, total: number): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  return `Showing ${fmt(shown)} of ${fmt(total)} trail ways in this box (named first); zoom in for the rest`;
}

const inputSchema = z.object({
  sacScaleMax: z.enum(SAC_SCALES).optional(),
  namedOnly: z.boolean().default(false),
  ways: z.boolean().default(false).describe("True returns OpenStreetMap's ways one by one instead of whole hikes (for layers built on this one)"),
});

type OsmTrailsInput = z.infer<typeof inputSchema>;

const elementSchema = z.object({
  type: z.literal("way"),
  id: z.number(),
  tags: z.record(z.string(), z.string()).optional(),
  geometry: z.array(z.object({ lat: z.number(), lon: z.number() })),
});

const responseSchema = z.object({ elements: z.array(z.unknown()) });

/**
 * Overpass QL for trail-like ways in the bbox. Overpass bbox order is (south,west,north,east).
 * Named and unnamed ways are separate sets so named trails come first and are never cut behind
 * unnamed ones (Overpass returns ways in id order), each set stops at MAX_TRAILS ways so the answer
 * and its cache entry stay bounded, and `out count` reports how many ways the box really holds.
 */
export function buildOverpassQuery(
  bbox: BBox,
  input: Pick<OsmTrailsInput, "namedOnly">,
): string {
  const [west, south, east, north] = bbox;
  const area = `(${south},${west},${north},${east})`;
  const way = `way["highway"~"^(path|footway|track)$"]`;
  const sets = input.namedOnly ? ["named"] : ["named", "unnamed"];
  return (
    `[out:json][timeout:25];` +
    `${way}["name"]${area}->.named;` +
    (input.namedOnly ? "" : `${way}[!"name"]${area}->.unnamed;`) +
    sets.map((set) => `.${set} out count;`).join("") +
    sets.map((set) => `.${set} out geom ${MAX_TRAILS};`).join("")
  );
}

/** The `out count` total of one element type (ways, relations), or null when the body has none. */
function counted(json: unknown, key: "ways" | "relations"): number | null {
  const elements = typeof json === "object" && json !== null ? (json as { elements?: unknown }).elements : undefined;
  if (!Array.isArray(elements)) return null;
  let total: number | null = null;
  for (const el of elements) {
    if (typeof el !== "object" || el === null || (el as { type?: unknown }).type !== "count") continue;
    const n = Number((el as { tags?: Record<string, unknown> }).tags?.[key]);
    if (Number.isFinite(n)) total = (total ?? 0) + n;
  }
  return total;
}

/** Ways in the box according to the `out count` elements, or null when the body has none. */
export function countedWays(json: unknown): number | null {
  return counted(json, "ways");
}

/**
 * The sac_scale value a trail with no difficulty tag carries, so "Not rated" is a chip with a count (two thirds of the
 * ways near Mount Rainier have none) and the legend can name those lines.
 */
export const NOT_RATED = "not_rated";

/** The coverage note when ways were merged into hikes: how many hikes, from how many of the box's ways. */
export function hikesNote(hikes: number, ways: number, total: number, truncated: boolean): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  const from = truncated ? `${fmt(ways)} of ${fmt(total)} trail ways in this box (named first; zoom in for the rest)` : `${fmt(ways)} trail ways`;
  return `${fmt(hikes)} trail${hikes === 1 ? "" : "s"} (the named ways joined into whole hikes) from ${from}`;
}

/** What a path is, from its highway tag: kind "path", "footway" or "track" (routes are kind "route"). */
const PATH_KINDS = new Set(["path", "footway", "track"]);

/**
 * Converts an Overpass `out geom` response into LineString features, skipping malformed ways: kind (path, footway or
 * track), lengthKm along the way, sac_scale (NOT_RATED when untagged) and the other trail tags.
 */
export function normalizeOverpass(json: unknown): FeatureCollection {
  const features: Feature<LineString>[] = [];
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) return { type: "FeatureCollection", features };

  for (const raw of parsed.data.elements) {
    const el = elementSchema.safeParse(raw);
    if (!el.success || el.data.geometry.length < 2) continue;
    const { id, tags = {}, geometry } = el.data;

    const coordinates = geometry.map((p): Position => [p.lon, p.lat]);
    const properties: Record<string, string | number | boolean> = {
      highway: tags.highway ?? "",
      osmId: `way/${id}`,
      informal: tags.informal === "yes",
      lengthKm: Math.round(lineKm(coordinates) * 100) / 100,
    };
    if (PATH_KINDS.has(tags.highway ?? "")) properties.kind = tags.highway;
    if (tags.name !== undefined) properties.name = tags.name;
    properties.sac_scale = tags.sac_scale ?? NOT_RATED;
    if (tags.trail_visibility !== undefined) properties.trail_visibility = tags.trail_visibility;
    if (tags.surface !== undefined) properties.surface = tags.surface;
    if (tags.wikidata !== undefined) properties.wikidata = tags.wikidata;
    if (tags.wikipedia !== undefined) properties.wikipedia = tags.wikipedia;

    features.push({ type: "Feature", geometry: { type: "LineString", coordinates }, properties });
  }
  return { type: "FeatureCollection", features };
}

// ---------------------------------------------------------------------------------------------------------------
// Named hiking routes, for a box too wide for individual paths.
// ---------------------------------------------------------------------------------------------------------------

const ROUTE_SELECTOR = 'relation["route"~"^(hiking|foot)$"]["name"]';

/** The coverage note for a route answer: how many named routes the box holds, and where paths appear. */
export function routesNote(shown: number, total: number): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  const paths = `individual paths appear under ${fmt(PATH_MAX_AREA_KM2)} km²`;
  if (total === 0) return `No named hiking routes are mapped in OpenStreetMap in this box; ${paths}`;
  const head = shown < total ? `Showing ${fmt(shown)} of ${fmt(total)} named hiking routes (longest first)` : `${fmt(total)} named hiking routes`;
  return `${head}; ${paths}`;
}

/** Step 1: every named hiking route relation in the box, tags and bounds only, with an `out count` of how many there are. */
export function buildRouteScanQuery(bbox: BBox): string {
  const [west, south, east, north] = bbox;
  return `[out:json][timeout:25];${ROUTE_SELECTOR}(${south},${west},${north},${east})->.r;.r out count;.r out tags bb ${ROUTE_SCAN_MAX};`;
}

/**
 * Step 2: the chosen relations with member geometry clipped to the box (nodes outside it come back as null), and the
 * relations that hold them (members only, no geometry).
 */
export function buildRouteGeometryQuery(bbox: BBox, ids: number[]): string {
  const [west, south, east, north] = bbox;
  // Then the routes they belong to (a superroute such as the American Discovery Trail), members as ids only, to name a
  // section whose own name is a code ("ADT - California - T - Seg 1").
  return `[out:json][timeout:25];relation(id:${ids.join(",")})->.r;.r out geom(${south},${west},${north},${east});rel(br.r);out body;`;
}

/** A `distance` tag in km ("12", "12.5 km", "12,5", "8 mi"), or undefined when it does not read as one. */
export function distanceTagKm(value: string | undefined): number | undefined {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(km|mi|m)?\s*$/i.exec(value ?? "");
  if (!m) return undefined;
  const n = Number(m[1].replace(",", "."));
  const unit = (m[2] ?? "km").toLowerCase();
  const km = unit === "mi" ? n * 1.609344 : unit === "m" ? n / 1000 : n;
  return Number.isFinite(km) && km > 0 ? km : undefined;
}

type Bounds = { minlat: number; minlon: number; maxlat: number; maxlon: number };

const boundsSchema = z.object({ minlat: z.number(), minlon: z.number(), maxlat: z.number(), maxlon: z.number() });

const scannedRouteSchema = z.object({
  type: z.literal("relation"),
  id: z.number(),
  tags: z.record(z.string(), z.string()).optional(),
  bounds: boundsSchema.optional(),
});

/**
 * A route's full length in km: its `distance` tag when that is believable against the route's extent (mappers
 * sometimes write metres, or a whole trail's length on one stage), otherwise the diagonal of its bounds.
 */
export function routeLengthKm(tags: Record<string, string>, bounds: Bounds | undefined): number {
  const diagonal = bounds ? haversineKm([bounds.minlon, bounds.minlat], [bounds.maxlon, bounds.maxlat]) : 0;
  const tagged = distanceTagKm(tags.distance);
  if (tagged !== undefined && (bounds === undefined || (tagged >= diagonal * 0.7 && tagged <= diagonal * 8 + 10))) return tagged;
  return diagonal;
}

/** The share of a route's bounds that lies inside the box (1 for a route with no extent or no bounds). */
function shareInside(bounds: Bounds | undefined, bbox: BBox): number {
  if (!bounds) return 1;
  const [west, south, east, north] = bbox;
  const w = bounds.maxlon - bounds.minlon;
  const h = bounds.maxlat - bounds.minlat;
  const iw = Math.max(0, Math.min(east, bounds.maxlon) - Math.max(west, bounds.minlon));
  const ih = Math.max(0, Math.min(north, bounds.maxlat) - Math.max(south, bounds.minlat));
  const share = (w > 0 ? iw / w : 1) * (h > 0 ? ih / h : 1);
  return Math.max(0, Math.min(1, share));
}

/**
 * The relation ids to draw from a step-1 body: longest inside the box first (estimated from each route's length and
 * how much of its extent is in the box), up to `max` (MAX_ROUTES by default), stopping once ROUTE_KM_BUDGET km are
 * taken (MIN_ROUTES always). `sacScaleMax` drops routes tagged harder than it.
 */
export function pickRoutes(json: unknown, bbox: BBox, sacScaleMax?: (typeof SAC_SCALES)[number], max = MAX_ROUTES): number[] {
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) return [];
  const ranked: { id: number; km: number }[] = [];
  for (const raw of parsed.data.elements) {
    const el = scannedRouteSchema.safeParse(raw);
    if (!el.success) continue;
    const tags = el.data.tags ?? {};
    if (sacScaleMax !== undefined && !scaleWithin(tags.sac_scale, sacScaleMax)) continue;
    ranked.push({ id: el.data.id, km: routeLengthKm(tags, el.data.bounds) * shareInside(el.data.bounds, bbox) });
  }
  ranked.sort((a, b) => b.km - a.km || a.id - b.id);
  const ids: number[] = [];
  let km = 0;
  for (const route of ranked) {
    if (ids.length >= max || (ids.length >= MIN_ROUTES && km >= ROUTE_KM_BUDGET)) break;
    ids.push(route.id);
    km += route.km;
  }
  return ids;
}

/** Douglas-Peucker in degrees (longitude scaled by the line's latitude), keeping the ends. */
export function simplifyLine(coords: Position[], tolerance: number): Position[] {
  if (coords.length <= 2 || tolerance <= 0) return coords;
  const kx = Math.cos((coords[0][1] * Math.PI) / 180);
  const keep = new Uint8Array(coords.length);
  keep[0] = 1;
  keep[coords.length - 1] = 1;
  const stack: [number, number][] = [[0, coords.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop() as [number, number];
    const ax = coords[a][0] * kx;
    const ay = coords[a][1];
    const dx = coords[b][0] * kx - ax;
    const dy = coords[b][1] - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let index = -1;
    for (let i = a + 1; i < b; i++) {
      const px = coords[i][0] * kx - ax;
      const py = coords[i][1] - ay;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
      const d = (px - t * dx) ** 2 + (py - t * dy) ** 2;
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (index !== -1 && worst > tolerance * tolerance) {
      keep[index] = 1;
      stack.push([a, index], [index, b]);
    }
  }
  return coords.filter((_, i) => keep[i] === 1);
}

/** Display simplification for a box: about 1/4,000 of its width, so a 3 degree box keeps detail to roughly 80 m. */
export function routeTolerance(bbox: BBox): number {
  return Math.max(0.00005, (bbox[2] - bbox[0]) / 4_000);
}

const pointSchema = z.object({ lat: z.number(), lon: z.number() }).nullable();

const routeElementSchema = z.object({
  type: z.literal("relation"),
  id: z.number(),
  tags: z.record(z.string(), z.string()).optional(),
  members: z
    .array(z.object({ type: z.string(), ref: z.number().optional(), geometry: z.array(pointSchema).optional() }))
    .optional(),
});

/**
 * Member ways as runs of points inside the box: a null (a node outside the box) ends a run. A way listed twice (both
 * directions of a loop) counts once. `clipped` is true when any node lay outside the box.
 */
function memberRuns(members: z.infer<typeof routeElementSchema>["members"]): { runs: Position[][]; clipped: boolean } {
  const runs: Position[][] = [];
  const seen = new Set<number>();
  let clipped = false;
  for (const member of members ?? []) {
    if (member.type !== "way") continue;
    if (member.ref !== undefined) {
      if (seen.has(member.ref)) continue;
      seen.add(member.ref);
    }
    let run: Position[] = [];
    for (const p of member.geometry ?? []) {
      if (p === null) {
        clipped = true;
        if (run.length >= 2) runs.push(run);
        run = [];
      } else run.push([p.lon, p.lat]);
    }
    if (run.length >= 2) runs.push(run);
  }
  return { runs, clipped };
}

/** Parts of a coded route name that say where it is: "California" in "ADT - California - T - Seg 1". */
function sectionOf(name: string): string | undefined {
  const parts = name.split(/\s+-\s+/).map((p) => p.trim());
  const place = parts.find((p) => /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ .']{3,}$/.test(p) && p !== p.toUpperCase() && !/^seg(?:ment)?\b/i.test(p));
  const seg = /\bseg(?:ment)?\s*(\d+)\b/i.exec(name)?.[1];
  const words = [place, seg && `segment ${seg}`].filter(Boolean);
  return words.length > 0 ? words.join(" ") : undefined;
}

/** True for a route name that is a code rather than a name: "ADT - California - T - Seg 1", "E1 - 23", its own ref. */
export function isCodedName(name: string, ref?: string): boolean {
  return /\bseg(?:ment)?\s*\d+\b/i.test(name) || (name.match(/\s-\s/g) ?? []).length >= 2 || (ref !== undefined && name.trim() === ref.trim());
}

/**
 * The name a person reads for a route (owner, 2026-10-16: not "ADT - California - T - Seg 1"): its official_name, else
 * for a coded name the route it belongs to with the section ("American Discovery Trail (California segment 1)"), else
 * its name as mapped.
 */
export function routeDisplayName(tags: Record<string, string>, parent?: string): string {
  const name = tags.name ?? "";
  if (tags.official_name && tags.official_name !== name) return tags.official_name;
  if (!isCodedName(name, tags.ref)) return name;
  // The route it belongs to, else its operator's trail ("American Discovery Trail Society" runs the American Discovery Trail).
  const whole = parent ?? /^(.*\bTrail)\b.*$/i.exec(tags.operator ?? "")?.[1];
  if (!whole || isCodedName(whole)) return name;
  const section = sectionOf(name);
  return section ? `${whole} (${section})` : whole;
}

/** Joins runs that continue one another (one's last point is the next one's first), in member order. */
function joinRuns(runs: Position[][]): Position[][] {
  const out: Position[][] = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    const end = last?.[last.length - 1];
    if (last && end && end[0] === run[0][0] && end[1] === run[0][1]) last.push(...run.slice(1));
    else out.push([...run]);
  }
  return out;
}

function lineKm(line: Position[]): number {
  let km = 0;
  for (let i = 1; i < line.length; i++) km += haversineKm(line[i - 1], line[i]);
  return km;
}

const NETWORKS: Record<string, string> = { iwn: "international", nwn: "national", rwn: "regional", lwn: "local" };

/**
 * Converts a step-2 body into route lines, longest inside the box first: kind "route", name, v and lengthKm (km
 * drawn inside the box), distanceKm (the whole route, when its distance tag is believable), network, sac_scale,
 * osmcSymbol, from, to and the wiki links. Routes with no geometry inside the box are skipped.
 */
export function normalizeRoutes(json: unknown, tolerance = 0): FeatureCollection {
  const features: Feature<LineString | MultiLineString>[] = [];
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) return { type: "FeatureCollection", features };

  // The relations that hold others (from `rel(br)`): a child's id to its parent's name.
  const parentOf = new Map<number, string>();
  for (const raw of parsed.data.elements) {
    const el = routeElementSchema.safeParse(raw);
    const name = el.success ? el.data.tags?.name : undefined;
    if (!el.success || name === undefined) continue;
    for (const m of el.data.members ?? []) if (m.type === "relation" && m.ref !== undefined && !parentOf.has(m.ref)) parentOf.set(m.ref, name);
  }

  for (const raw of parsed.data.elements) {
    const el = routeElementSchema.safeParse(raw);
    if (!el.success) continue;
    const tags = el.data.tags ?? {};
    const { runs, clipped } = memberRuns(el.data.members);
    const lines = joinRuns(runs);
    if (lines.length === 0 || tags.name === undefined) continue;
    const km = lines.reduce((sum, line) => sum + lineKm(line), 0);
    const drawn = lines.map((line) => simplifyLine(line, tolerance));
    const inView = Math.round(km * 10) / 10;

    const name = routeDisplayName(tags, parentOf.get(el.data.id));
    const properties: Record<string, string | number> = {
      kind: "route",
      name,
      osmId: `relation/${el.data.id}`,
      route: tags.route ?? "hiking",
      v: inView,
      lengthKm: inView,
    };
    if (name !== tags.name) properties.osmName = tags.name;
    if (tags.ref !== undefined) properties.ref = tags.ref;
    // The whole route never reads shorter than the part in view: a route wholly in the box is as long as it is drawn
    // (ADT California Seg 1 is tagged 29.89 mi, 48.1 km, and maps 50.1 km); a clipped one keeps its tag only when the
    // tag is longer than what is drawn.
    const tagged = distanceTagKm(tags.distance);
    const full = clipped ? (tagged !== undefined && tagged >= km ? tagged : undefined) : Math.max(km, tagged ?? 0);
    if (full !== undefined) properties.distanceKm = Math.max(Math.round(full * 10) / 10, inView);
    if (tags.network !== undefined) properties.network = NETWORKS[tags.network] ?? tags.network;
    properties.sac_scale = tags.sac_scale ?? NOT_RATED;
    if (tags["osmc:symbol"] !== undefined) properties.osmcSymbol = tags["osmc:symbol"];
    for (const key of ["from", "to", "operator", "website", "wikidata", "wikipedia"] as const) {
      if (tags[key] !== undefined) properties[key] = tags[key];
    }

    features.push({
      type: "Feature",
      geometry: drawn.length === 1 ? { type: "LineString", coordinates: drawn[0] } : { type: "MultiLineString", coordinates: drawn },
      properties,
    });
  }
  features.sort((a, b) => Number(b.properties?.v) - Number(a.properties?.v));
  return { type: "FeatureCollection", features };
}

/**
 * Named hiking routes in a box between PATH_MAX_AREA_KM2 and ROUTE_MAX_AREA_KM2: two Overpass calls (scan, then
 * geometry). `total` is the number of named routes in the box. In wide mode run.ts writes the coverage note, so the
 * layer only adds one when the box holds no routes at all.
 */
async function queryRoutes(ctx: QueryContext, input: OsmTrailsInput): Promise<LayerResult | LayerError> {
  const citation = {
    source: "OpenStreetMap contributors (ODbL)",
    url: "https://www.openstreetmap.org/copyright",
    retrieved: new Date().toISOString(),
  };
  const wide = ctx.wide === true;
  const max = Math.min(MAX_ROUTES, (wide ? ctx.wideStrategy?.limit : undefined) ?? MAX_ROUTES);
  const scan = await overpassQuery(ctx, buildRouteScanQuery(ctx.bbox), { cacheSuffix: "osm-trails:routes:scan" });
  if (!scan.ok) return { error: scan.error, hint: "upstream" };

  const ids = pickRoutes(scan.json, ctx.bbox, input.sacScaleMax, max);
  const scanned = responseSchema.safeParse(scan.json).data?.elements.filter((e) => (e as { type?: unknown }).type === "relation").length ?? 0;
  const total = Math.max(counted(scan.json, "relations") ?? scanned, scanned);
  if (ids.length === 0) {
    return { kind: "geojson", data: { type: "FeatureCollection", features: [] }, total, coverageNote: routesNote(0, total), citation };
  }

  const geometry = await overpassQuery(ctx, buildRouteGeometryQuery(ctx.bbox, ids));
  if (!geometry.ok) return { error: geometry.error, hint: "upstream" };
  const data = normalizeRoutes(geometry.json, routeTolerance(ctx.bbox));
  return {
    kind: "geojson",
    data,
    total,
    ...(wide ? {} : { coverageNote: routesNote(data.features.length, total) }),
    citation,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Wide mode for the other OSM line layers (mtb-trails, ski-routes): the longest named features, ranked from a scan.
// ---------------------------------------------------------------------------------------------------------------

/**
 * Step 1 of a wide named answer: every match of `selectors` in the box counted, then the ones carrying any of
 * `nameKeys` counted and listed as ids and bounds only (no tags, no geometry), relations first and at most
 * ROUTE_SCAN_MAX of each: in one list the ways come first, so a box with more named ways than that (Utah and Colorado
 * hold 6,000 rated trails) would cut every route. Read the two counts with overpassCounts (every match, then the named)
 * and pick with pickNamedByLength.
 */
export function buildNamedScanQuery(selectors: string[], nameKeys: string[], bbox: BBox): string {
  const [west, south, east, north] = bbox;
  const area = `(${south},${west},${north},${east})`;
  const named = nameKeys.map((key) => `way.all["${key}"];rel.all["${key}"];`).join("");
  return (
    `[out:json][timeout:25];(${selectors.map((sel) => `${sel}${area};`).join("")})->.all;.all out count;` +
    `(${named})->.named;.named out count;` +
    `rel.named->.nr;.nr out ids bb ${ROUTE_SCAN_MAX};way.named->.nw;.nw out ids bb ${ROUTE_SCAN_MAX};`
  );
}

const scannedSchema = z.object({ type: z.enum(["way", "relation"]), id: z.number(), bounds: boundsSchema.optional() });

/**
 * The way and relation ids to draw from a step-1 scan: longest inside the box first (each one's extent, scaled by
 * how much of it lies in the box), at most `limit` in all and `maxRelations` relations.
 */
export function pickNamedByLength(json: unknown, bbox: BBox, limit: number, maxRelations: number): { ways: number[]; relations: number[] } {
  const ranked: { type: "way" | "relation"; id: number; km: number }[] = [];
  for (const raw of responseSchema.safeParse(json).data?.elements ?? []) {
    const el = scannedSchema.safeParse(raw);
    if (!el.success) continue;
    ranked.push({ ...el.data, km: routeLengthKm({}, el.data.bounds) * shareInside(el.data.bounds, bbox) });
  }
  ranked.sort((a, b) => b.km - a.km || a.id - b.id);
  const ways: number[] = [];
  const relations: number[] = [];
  for (const el of ranked) {
    if (ways.length + relations.length >= limit) break;
    if (el.type === "way") ways.push(el.id);
    else if (relations.length < maxRelations) relations.push(el.id);
  }
  return { ways, relations };
}

/**
 * Step 2: the picked ways with their tags and geometry, and the picked relations with `out body` plus only their
 * member ways inside the box as bare geometry (`out skel geom`, no tags, so a member is never drawn as a feature of
 * its own). The body has the same shape as the layers' normal answers, so their normalizers read it unchanged.
 */
export function buildNamedGeometryQuery(bbox: BBox, picked: { ways: number[]; relations: number[] }, maxRouteWays: number): string {
  const [west, south, east, north] = bbox;
  const area = `(${south},${west},${north},${east})`;
  return (
    `[out:json][timeout:25];` +
    (picked.ways.length > 0 ? `way(id:${picked.ways.join(",")});out tags geom;` : "") +
    (picked.relations.length > 0
      ? `rel(id:${picked.relations.join(",")})->.r;way(r.r)${area}->.rw;.r out body;.rw out skel geom ${maxRouteWays};`
      : "")
  );
}

/** Kilometres drawn by a line or multi-line geometry (0 for anything else). */
export function geometryKm(geometry: Geometry | null): number {
  if (geometry?.type === "LineString") return lineKm(geometry.coordinates);
  if (geometry?.type === "MultiLineString") return geometry.coordinates.reduce((sum, line) => sum + lineKm(line), 0);
  return 0;
}

/** The named features (a `name` property), longest first, at most `limit`. */
export function longestNamedFirst<T extends Feature>(features: T[], limit: number): T[] {
  return features
    .filter((f) => typeof f.properties?.name === "string")
    .map((f) => ({ f, km: geometryKm(f.geometry) }))
    .sort((a, b) => b.km - a.km)
    .slice(0, limit)
    .map(({ f }) => f);
}

/**
 * A line or multi-line feature redrawn with simplifyLine at `tolerance` (anything else unchanged): a wide answer over a
 * region keeps detail only to what its view can show (routeTolerance), which cuts its size several times over.
 */
export function simplifiedFeature<T extends Feature>(feature: T, tolerance: number): T {
  const g = feature.geometry;
  if (g?.type === "LineString") return { ...feature, geometry: { ...g, coordinates: simplifyLine(g.coordinates, tolerance) } };
  if (g?.type === "MultiLineString") {
    return { ...feature, geometry: { ...g, coordinates: g.coordinates.map((line) => simplifyLine(line, tolerance)) } };
  }
  return feature;
}

function osmCitation() {
  return { source: "OpenStreetMap contributors (ODbL); climb from AWS Terrain Tiles", url: "https://www.openstreetmap.org/copyright", retrieved: new Date().toISOString() };
}

/** True when a sac_scale value is absent or not rated, or at or below `max` in difficulty order. */
function scaleWithin(scale: string | undefined, max: (typeof SAC_SCALES)[number]): boolean {
  if (scale === undefined || scale === NOT_RATED) return true;
  const index = SAC_SCALES.findIndex((s) => s === scale);
  return index !== -1 && index <= SAC_SCALES.indexOf(max);
}

/** Keeps trails with no rating, or one at or below `max` in difficulty order. */
function withinSacScale(feature: Feature, max: (typeof SAC_SCALES)[number]): boolean {
  const scale: unknown = feature.properties?.sac_scale;
  return scaleWithin(scale === undefined ? undefined : String(scale), max);
}

const SAC_LABELS: Record<(typeof SAC_SCALES)[number], string> = {
  hiking: "Hiking (T1)",
  mountain_hiking: "Mountain hiking (T2)",
  demanding_mountain_hiking: "Demanding mountain hiking (T3)",
  alpine_hiking: "Alpine hiking (T4)",
  demanding_alpine_hiking: "Demanding alpine (T5)",
  difficult_alpine_hiking: "Difficult alpine (T6)",
};

/** The card's difficulty words: the SAC levels and the ways with none. */
const DIFFICULTY_LABELS: Record<string, string> = { ...SAC_LABELS, [NOT_RATED]: "Not rated" };

/** What each line is, in words: an untitled footway reads "Footpath", a track (an unpaved road) "Track". */
const KIND_LABELS: Record<string, string> = { path: "Path", footway: "Footpath", track: "Track", route: "Named route" };
/** A whole hike's shape: a loop, an out and back (walk it and return), or a network that branches. */
const SHAPE_LABELS: Record<string, string> = { loop: "Loop", "out-and-back": "Out and back", network: "Trail network" };
const KIND_HELP: Record<string, string> = {
  path: "A path for walking and often bikes or horses.",
  footway: "A path mainly for people on foot.",
  track: "An unpaved farm or forest road, open to vehicles in many places; not a hiking trail as such.",
  route: "A named, waymarked hiking route made of many paths (wide views only).",
};

// "Not rated" is not a level: it is not on the difficulty ramp, so its lines keep the plain trail look; the chip
// appears from the data (NOT_RATED) after the six levels.
const ATTRIBUTES: Attribute[] = [
  { key: "sac_scale", type: "ordinal", label: "Difficulty", encode: "color", levels: SAC_LEVELS, scale: SAC_SCALE },
  {
    key: "kind",
    type: "category",
    label: "Kind",
    levels: Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label, help: KIND_HELP[value] })),
  },
  { key: "lengthKm", type: "measure", label: "Length", unit: "km", presets: [{ label: "Short (under 5 km)", max: 5 }, { label: "Half day (5 to 12 km)", min: 5, max: 12 }, { label: "Long (over 12 km)", min: 12 }] },
  { key: "roundTripKm", type: "measure", label: "Round trip", unit: "km" },
  { key: "gainM", type: "measure", label: "Climb", unit: "m", presets: [{ label: "Flat (under 100 m)", max: 100 }, { label: "Big climb (over 600 m)", min: 600 }] },
  { key: "gainPerKm", type: "measure", label: "Climb per km", unit: "m/km" },
  { key: "shape", type: "category", label: "Shape", levels: Object.entries(SHAPE_LABELS).map(([value, label]) => ({ value, label })) },
  nameAttribute(),
];

/** The difficulty ramp the lines are coloured by, and the unrated lines drawn in the plain trail look. */
const LEGEND: LegendSpec = {
  kind: "categories",
  title: "Difficulty",
  field: "sac_scale",
  items: [
    ...SAC_LEVELS.map((l) => ({ label: l.label, value: l.value, symbol: "line" as const, ...(l.help && { help: l.help }) })),
    { label: "Not rated", value: NOT_RATED, color: SAGE, symbol: "line", help: "No difficulty is mapped for this way." },
  ],
  note: "Not rated ways are drawn like T1, sage with grey dashes; informal use trails are sage dots.",
};

const ROUTE_KM: FieldHelp = {
  text: "Kilometres of this named hiking route drawn inside the view, measured by this app along its mapped ways (routes only).",
  unit: "km",
  source: "OpenStreetMap contributors",
};

const HELP: Record<string, FieldHelp> = {
  sac_scale: {
    text:
      "How hard the hike is on the Swiss Alpine Club (SAC) hiking scale, as an OpenStreetMap mapper tagged it: T1 is a trail well cleared " +
      "over level or inclined terrain, T6 includes longer climbing pitches with severe exposure.",
    scale: "T1 (easiest) to T6 (hardest)",
    source: "OpenStreetMap wiki, Key:sac_scale",
    url: "https://wiki.openstreetmap.org/wiki/Key:sac_scale",
  },
  trail_visibility: {
    text: "How easy the path is to see and follow on the ground, as tagged in OpenStreetMap.",
    scale: "excellent, good, intermediate, bad, horrible, no",
    source: "OpenStreetMap wiki, Key:trail_visibility",
    url: "https://wiki.openstreetmap.org/wiki/Key:trail_visibility",
  },
  highway: {
    text:
      "The OpenStreetMap way type: path (a hiking or multi-use path), footway (mainly for people on foot) or track (an unpaved farm or forest " +
      "road).",
    source: "OpenStreetMap wiki, Key:highway",
    url: "https://wiki.openstreetmap.org/wiki/Key:highway",
  },
  informal: {
    text: "True when OpenStreetMap marks the path informal: a social trail made by use, not built or signed by a land manager.",
    source: "OpenStreetMap wiki, Key:informal",
    url: "https://wiki.openstreetmap.org/wiki/Key:informal",
  },
  v: ROUTE_KM,
  lengthKm: {
    text:
      "The whole hike's length in view: every touching way of its name, measured by this app along the mapped lines; for an unnamed path its own length, and for a named hiking route (wide views) the kilometres inside the view.",
    unit: "km",
    source: "OpenStreetMap contributors",
  },
  roundTripKm: { text: "The walk there and back: twice the length for an out and back, the length for a loop.", unit: "km" },
  gainM: {
    text: "How much the hike climbs walking it once from one end to the other, from AWS Terrain Tiles (about 30 m in the US) sampled every 50 m; dips under 4 m are ignored.",
    unit: "m",
    source: "AWS Terrain Tiles (Mapzen Terrarium, open data)",
    url: "https://registry.opendata.aws/terrain-tiles/",
  },
  roundTripGainM: { text: "The climb of the whole round trip: up and back down for an out and back, once round for a loop.", unit: "m" },
  gainPerKm: { text: "Climb per kilometre of trail: under 15 is flat, over 80 steep.", unit: "m/km" },
  shape: { text: "Loop when its ends meet; out and back when it is one line you walk and return on; trail network when it branches." },
  kind: {
    text: "What the line is: a path, a footpath (footway), a track (an unpaved farm or forest road) or, in wide views, a named hiking route.",
    source: "OpenStreetMap wiki, Key:highway",
    url: "https://wiki.openstreetmap.org/wiki/Key:highway",
  },
  distanceKm: {
    text: "The whole route's length: as drawn when it lies wholly in view, else its OpenStreetMap distance tag (never shorter than the part in view).",
    unit: "km",
  },
  network: {
    text: "Which network the route belongs to, from OpenStreetMap's network tag: an international, national, regional or local trail (iwn, nwn, rwn, lwn), as its waymarks are signed.",
    source: "OpenStreetMap wiki, Key:network",
    url: "https://wiki.openstreetmap.org/wiki/Key:network",
  },
  osmcSymbol: {
    text: "The waymark painted along the route, in OpenStreetMap's osmc:symbol code (way colour, background and symbol).",
    source: "OpenStreetMap wiki, Key:osmc:symbol",
    url: "https://wiki.openstreetmap.org/wiki/Key:osmc:symbol",
  },
};

const CARD: CardSpec = {
  measure: { key: "lengthKm", label: "Length", unit: "km" },
  facts: [
    { key: "shape", label: "Shape", values: SHAPE_LABELS },
    { key: "roundTripKm", label: "Round trip", format: "km" },
    { key: "gainM", label: "Climb, end to end", format: "m" },
    { key: "roundTripGainM", label: "Climb, round trip", format: "m" },
    { key: "highM", label: "Highest point", format: "m" },
    { key: "sac_scale", label: "Difficulty", values: DIFFICULTY_LABELS },
    { key: "kind", label: "Kind", values: KIND_LABELS },
    { key: "trail_visibility", label: "Visibility" },
    { key: "surface", label: "Surface" },
    { key: "distanceKm", label: "Full length", format: "km" },
    { key: "network", label: "Network", values: { international: "International trail", national: "National trail", regional: "Regional trail", local: "Local trail" } },
    { key: "ref", label: "Route number" },
    { key: "osmName", label: "Name in OpenStreetMap" },
  ],
  links: [{ key: "website", label: "Website" }],
  hidden: ["osmId", "highway", "route", "ways", "start", "end", "lossM", "lowM", "gainPerKm"],
};

const osmTrails = defineLayer({
  id: "osm-trails",
  title: "OpenStreetMap trails",
  description:
    "Hiking paths, footways and tracks from OpenStreetMap, with difficulty (sac_scale), visibility and surface tags where mapped, plus wikidata or wikipedia when the trail has an article. " +
    "Under 2,500 km² the ways of one name that touch come back as one whole hike: name, lengthKm (the whole hike in view), shape ('loop', 'out-and-back' or 'network'), roundTripKm, gainM (climb end to end, from terrain tiles), roundTripGainM, gainPerKm, highM, start and end; unnamed paths stay one per way. " +
    "Each has kind ('path', 'footway' or 'track'; a track is an unpaved farm or forest road) and sac_scale (the hardest of its ways; 'not_rated' when none is mapped, often most). " +
    "Under 2,500 km² it returns the paths; up to 400,000 km² the 150 longest named hiking routes instead (the note gives the total): kind 'route', name, v = lengthKm (km inside the region), distanceKm, network and sac_scale.",
  coverage: "global",
  surface: "land",
  license: "ODbL (OpenStreetMap contributors)",
  requiredEnv: [],
  optionalEnv: ["OVERPASS_URL"],
  maxAreaKm2: PATH_MAX_AREA_KM2,
  hardMaxAreaKm2: ROUTE_MAX_AREA_KM2,
  wide: { mode: "named", orderBy: "length in km", limit: MAX_ROUTES },
  input: inputSchema,
  style: { geometry: "line", color: layerColor("osm-trails") },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  time: { shape: "none" },
  legend: LEGEND,
  labels: { field: "name", max: 8, rankBy: "lengthKm" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    // run.ts enforces the hard cap; popularity calls this query directly, so it is checked here too.
    const area = bboxAreaKm2(ctx.bbox);
    const hardMax = hardMaxAreaKm2(osmTrails);
    if (area > hardMax) {
      return { error: `Area is ${Math.round(area)} km²; zoom in to under ${hardMax} km²`, hint: "zoom_in" };
    }
    // Wide mode from run.ts; the area test covers a direct call over the path cap.
    if (ctx.wide === true || area > PATH_MAX_AREA_KM2) return queryRoutes(ctx, input);

    const result = await overpassQuery(ctx, buildOverpassQuery(ctx.bbox, input));
    if (!result.ok) {
      return { error: result.error, hint: "upstream" };
    }

    const data = normalizeOverpass(result.json);
    const returned = data.features.length;
    const total = Math.max(countedWays(result.json) ?? returned, returned);
    const max = input.sacScaleMax;
    if (max !== undefined) {
      data.features = data.features.filter((f) => withinSacScale(f, max));
    }

    // Named trails go first (they also come first from Overpass); keep MAX_TRAILS.
    const cut = data.features.length > MAX_TRAILS;
    if (cut) {
      const named = (f: Feature) => (f.properties?.name === undefined ? 1 : 0);
      data.features = [...data.features].sort((a, b) => named(a) - named(b)).slice(0, MAX_TRAILS);
    }
    // Capped when the box holds more ways than came back, or more came back than are kept.
    const truncated = cut || total > returned;
    if (input.ways) {
      return { kind: "geojson", data, ...(truncated ? { coverageNote: truncatedNote(data.features.length, total) } : {}), citation: osmCitation() };
    }

    // Whole hikes: the ways of one name that touch are one trail, with its climb from terrain tiles (tests have no network).
    const ways = data.features.length;
    data.features = mergeHikes(data.features, NOT_RATED);
    if (!process.env.VITEST) await addClimb(data.features);
    const merged = data.features.length < ways;

    return {
      kind: "geojson",
      data,
      ...(truncated || merged ? { coverageNote: merged ? hikesNote(data.features.length, ways, total, truncated) : truncatedNote(data.features.length, total) } : {}),
      citation: {
        source: "OpenStreetMap contributors (ODbL)",
        url: "https://www.openstreetmap.org/copyright",
        retrieved: new Date().toISOString(),
      },
    };
  },
});

registerLayer(osmTrails);

export default osmTrails;
