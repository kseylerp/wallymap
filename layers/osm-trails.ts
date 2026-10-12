import { z } from "zod";
import type { Feature, FeatureCollection, LineString, MultiLineString, Position } from "geojson";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { overpassQuery } from "./_shared/overpass";
import { haversineKm } from "./_shared/geo";
import { layerColor } from "@/lib/render/palette";

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

/** Largest box that gets individual paths; a wider one gets named hiking routes instead. */
export const PATH_MAX_AREA_KM2 = 2_500;
/** Largest box that gets named hiking routes; the layer errors above it. */
export const ROUTE_MAX_AREA_KM2 = 400_000;
/** Most routes returned, longest first. */
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

/** Converts an Overpass `out geom` response into LineString features, skipping malformed ways. */
export function normalizeOverpass(json: unknown): FeatureCollection {
  const features: Feature<LineString>[] = [];
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) return { type: "FeatureCollection", features };

  for (const raw of parsed.data.elements) {
    const el = elementSchema.safeParse(raw);
    if (!el.success || el.data.geometry.length < 2) continue;
    const { id, tags = {}, geometry } = el.data;

    const properties: Record<string, string | boolean> = {
      highway: tags.highway ?? "",
      osmId: `way/${id}`,
      informal: tags.informal === "yes",
    };
    if (tags.name !== undefined) properties.name = tags.name;
    if (tags.sac_scale !== undefined) properties.sac_scale = tags.sac_scale;
    if (tags.trail_visibility !== undefined) properties.trail_visibility = tags.trail_visibility;
    if (tags.surface !== undefined) properties.surface = tags.surface;
    if (tags.wikidata !== undefined) properties.wikidata = tags.wikidata;
    if (tags.wikipedia !== undefined) properties.wikipedia = tags.wikipedia;

    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: geometry.map((p) => [p.lon, p.lat]) },
      properties,
    });
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

/** Step 1: every named hiking route relation in the box, tags and bounds only, with an `out count`. */
export function buildRouteScanQuery(bbox: BBox): string {
  const [west, south, east, north] = bbox;
  return `[out:json][timeout:25];${ROUTE_SELECTOR}(${south},${west},${north},${east})->.r;.r out count;.r out tags bb ${ROUTE_SCAN_MAX};`;
}

/** Step 2: the chosen relations with member geometry clipped to the box (nodes outside it come back as null). */
export function buildRouteGeometryQuery(bbox: BBox, ids: number[]): string {
  const [west, south, east, north] = bbox;
  return `[out:json][timeout:25];relation(id:${ids.join(",")});out geom(${south},${west},${north},${east});`;
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
 * how much of its extent is in the box), up to MAX_ROUTES, stopping once ROUTE_KM_BUDGET km are taken (MIN_ROUTES
 * always). `sacScaleMax` drops routes tagged harder than it.
 */
export function pickRoutes(json: unknown, bbox: BBox, sacScaleMax?: (typeof SAC_SCALES)[number]): number[] {
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
    if (ids.length >= MAX_ROUTES || (ids.length >= MIN_ROUTES && km >= ROUTE_KM_BUDGET)) break;
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
    .array(z.object({ type: z.string(), geometry: z.array(pointSchema).optional() }))
    .optional(),
});

/** Member ways as runs of points inside the box: a null (a node outside the box) ends a run. */
function memberRuns(members: z.infer<typeof routeElementSchema>["members"]): Position[][] {
  const runs: Position[][] = [];
  for (const member of members ?? []) {
    if (member.type !== "way") continue;
    let run: Position[] = [];
    for (const p of member.geometry ?? []) {
      if (p === null) {
        if (run.length >= 2) runs.push(run);
        run = [];
      } else run.push([p.lon, p.lat]);
    }
    if (run.length >= 2) runs.push(run);
  }
  return runs;
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

  for (const raw of parsed.data.elements) {
    const el = routeElementSchema.safeParse(raw);
    if (!el.success) continue;
    const tags = el.data.tags ?? {};
    const lines = joinRuns(memberRuns(el.data.members));
    if (lines.length === 0 || tags.name === undefined) continue;
    const km = lines.reduce((sum, line) => sum + lineKm(line), 0);
    const drawn = lines.map((line) => simplifyLine(line, tolerance));

    const properties: Record<string, string | number> = {
      kind: "route",
      name: tags.name,
      osmId: `relation/${el.data.id}`,
      route: tags.route ?? "hiking",
      v: Math.round(km * 10) / 10,
      lengthKm: Math.round(km * 10) / 10,
    };
    const distance = distanceTagKm(tags.distance);
    if (distance !== undefined) properties.distanceKm = Math.round(distance * 10) / 10;
    if (tags.network !== undefined) properties.network = NETWORKS[tags.network] ?? tags.network;
    if (tags.sac_scale !== undefined) properties.sac_scale = tags.sac_scale;
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

/** Named hiking routes in a box between PATH_MAX_AREA_KM2 and ROUTE_MAX_AREA_KM2: two Overpass calls (scan, then geometry). */
async function queryRoutes(ctx: QueryContext, input: OsmTrailsInput): Promise<LayerResult | LayerError> {
  const citation = {
    source: "OpenStreetMap contributors (ODbL)",
    url: "https://www.openstreetmap.org/copyright",
    retrieved: new Date().toISOString(),
  };
  const scan = await overpassQuery(ctx, buildRouteScanQuery(ctx.bbox), { cacheSuffix: "osm-trails:routes:scan" });
  if (!scan.ok) return { error: scan.error, hint: "upstream" };

  const ids = pickRoutes(scan.json, ctx.bbox, input.sacScaleMax);
  const scanned = responseSchema.safeParse(scan.json).data?.elements.filter((e) => (e as { type?: unknown }).type === "relation").length ?? 0;
  const total = Math.max(counted(scan.json, "relations") ?? scanned, scanned);
  if (ids.length === 0) {
    return { kind: "geojson", data: { type: "FeatureCollection", features: [] }, coverageNote: routesNote(0, total), citation };
  }

  const geometry = await overpassQuery(ctx, buildRouteGeometryQuery(ctx.bbox, ids));
  if (!geometry.ok) return { error: geometry.error, hint: "upstream" };
  const data = normalizeRoutes(geometry.json, routeTolerance(ctx.bbox));
  return { kind: "geojson", data, coverageNote: routesNote(data.features.length, total), citation };
}

/** True when a sac_scale value is absent, or at or below `max` in difficulty order. */
function scaleWithin(scale: string | undefined, max: (typeof SAC_SCALES)[number]): boolean {
  if (scale === undefined) return true;
  const index = SAC_SCALES.findIndex((s) => s === scale);
  return index !== -1 && index <= SAC_SCALES.indexOf(max);
}

/** Keeps trails with no sac_scale, or one at or below `max` in difficulty order. */
function withinSacScale(feature: Feature, max: (typeof SAC_SCALES)[number]): boolean {
  const scale: unknown = feature.properties?.sac_scale;
  return scaleWithin(scale === undefined ? undefined : String(scale), max);
}

const osmTrails = defineLayer({
  id: "osm-trails",
  title: "OpenStreetMap trails",
  description:
    "Hiking paths, footways and tracks from OpenStreetMap, with difficulty (sac_scale), visibility and surface tags where mapped, plus wikidata or wikipedia when the trail has an article. " +
    "Under 2,500 km² it returns the paths; from there up to 400,000 km² it returns named hiking routes instead, longest first (up to 150): kind 'route', name, v = lengthKm (km inside the region), distanceKm, network and sac_scale.",
  coverage: "global",
  license: "ODbL (OpenStreetMap contributors)",
  requiredEnv: [],
  optionalEnv: ["OVERPASS_URL"],
  maxAreaKm2: ROUTE_MAX_AREA_KM2,
  input: inputSchema,
  style: { geometry: "line", color: layerColor("osm-trails") },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const area = bboxAreaKm2(ctx.bbox);
    if (area > osmTrails.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${osmTrails.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }
    if (area > PATH_MAX_AREA_KM2) return queryRoutes(ctx, input);

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

    return {
      kind: "geojson",
      data,
      ...(truncated ? { coverageNote: truncatedNote(data.features.length, total) } : {}),
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
