/**
 * Ski runs, nordic trails and ski-touring routes from OpenStreetMap via one Overpass query:
 *   way["piste:type"]["area"!="yes"]   (downhill, nordic, skitour, sled and other piste ways, `out tags geom`)
 *   relation["route"="ski"|"piste"]    (named ski routes; `out body` plus only the member ways inside the box)
 * Fixture: layers/__fixtures__/ski-routes.chamonix.json (Chamonix, France, recorded 2026-10-09 and trimmed to
 * 12 vertices per line and 4 relation members; the live box held many piste ways and 3 route=ski relations).
 * Tags read: piste:type, piste:difficulty, piste:name, name, ref, piste:grooming, piste:status, piste:lit,
 * network, check_date (becomes `t`). Closed outline areas (area=yes) are skipped so they do not overdraw the runs.
 * Live smoke check: Chamonix, France (45.85,6.8 to 46,7.05), 2026-10-09: 317 features (151 downhill, 103 nordic, 37 skitour, 26 other), no truncation; Truckee CA nordic only: 260.
 * Wide mode (over 2,500 km², up to WIDE_MAX_AREA_KM2, 100,000): a scan of the named piste ways and ski routes (ids and
 * bounds), then the geometry of the 1,000 longest inside the box (see buildNamedScanQuery in osm-trails), simplified to
 * what the view can show, with `total` every piste way and route.
 * Live smoke check (wide), 2026-10-14: Valais and Aosta (6.5,45.5 to 7.5,46.3, about 8,700 km²): 1,000 kept of 7,657
 * (4,621 named), 9.0 s.
 * Live smoke check (wide), 2026-10-16, for the 100,000 km² cap: Wasatch (-112.5,40 to -110.5,41.5, about 28,000 km²): 999
 * named of 2,905, 3.8 s, 0.3 MB; Colorado resorts (-108,38.5 to -104.5,40.5, about 66,500 km²): 1,000 of 5,097, 3.7 s,
 * 0.3 MB; Switzerland (6,45.8 to 10.5,47.8, about 76,000 km², 35,000 piste ways, the densest anywhere): 1,000 of 35,360,
 * 9.5 to 16.7 s, 0.4 MB. A 128,000 km² Alpine box took 21 s, too near the 25 s Overpass limit, hence 100,000.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, LineString, MultiLineString } from "geojson";
import {
  defineLayer,
  type BBox,
  type LayerError,
  type LayerResult,
  type QueryContext,
  type CardSpec,
  type Attribute,
  type FieldHelp,
  type LegendSpec,
} from "./types";
import { PISTE_LEVELS, PISTE_SCALE, nameAttribute } from "./_shared/bands";
import { registerLayer } from "./registry";
import { overpassCounts, overpassQuery } from "./_shared/overpass";
import {
  buildNamedGeometryQuery,
  buildNamedScanQuery,
  longestNamedFirst,
  pickNamedByLength,
  routeTolerance,
  simplifiedFeature,
} from "./osm-trails";
import {
  bboxClause,
  returnedNote,
  checkedOn,
  clippedRelationQuery,
  countedTotal,
  osmCitation,
  overpassBodySchema,
  relationElementSchema,
  relationLine,
  wayElementSchema,
  wayGeometryById,
  wayLine,
} from "./_shared/osm-features";
import { SAGE, layerColor } from "@/lib/render/palette";

/** Most piste ways returned; a resort-dense box holds thousands, each with its full geometry. */
export const MAX_WAYS = 2_000;
/** Most route relations returned. */
export const MAX_ROUTES = 50;
/** Most member ways of those routes fetched, and only the ones inside the box. */
export const MAX_ROUTE_WAYS = 3_000;
/** Most named pistes and routes in a wide answer (the wide strategy's limit). */
export const WIDE_LIMIT = 1_000;
/**
 * Largest box the layer answers (its hardMaxAreaKm2), with the named pistes and routes longest first: a ski region
 * (Colorado's resorts, the Wasatch, the Valais) instead of a "zoom in". Measured in the header.
 */
export const WIDE_MAX_AREA_KM2 = 100_000;

export const PISTE_KINDS = ["downhill", "nordic", "skitour", "sled"] as const;

const inputSchema = z.object({
  /** Only this kind of piste: downhill runs, nordic (cross-country) trails, ski-touring routes or sled runs. */
  kind: z.enum(PISTE_KINDS).optional(),
  /** Include `route=ski` relations (named ski routes made of many segments). */
  includeRoutes: z.boolean().default(true),
});

type SkiInput = z.infer<typeof inputSchema>;

/**
 * Selectors for route relations. With a kind set, the relations that name that kind plus the ones that name none
 * (route=ski relations often have no piste:type), so a kind filter never hides an untyped route.
 */
function relationSelectors(kind: SkiInput["kind"]): string[] {
  const route = '["route"~"^(ski|piste)$"]';
  return kind === undefined ? [`rel${route}`] : [`rel${route}["piste:type"="${kind}"]`, `rel${route}[!"piste:type"]`];
}

/** Selector for piste ways (of one kind when set), leaving out closed outline areas. */
function waySelector(kind: SkiInput["kind"]): string {
  return `way${kind === undefined ? '["piste:type"]' : `["piste:type"="${kind}"]`}["area"!="yes"]`;
}

/**
 * Overpass QL: piste ways and (optionally) route=ski and route=piste relations whose member ways are clipped to the
 * box (see clippedRelationQuery), each with an `out count` for the coverage note.
 */
export function buildSkiQuery(bbox: BBox, input: Pick<SkiInput, "kind" | "includeRoutes">): string {
  const area = bboxClause(bbox);
  return (
    `[out:json][timeout:25];` +
    `${waySelector(input.kind)}${area}->.w;` +
    `.w out count;.w out tags geom ${MAX_WAYS};` +
    (input.includeRoutes
      ? clippedRelationQuery("r", relationSelectors(input.kind), bbox, { routes: MAX_ROUTES, ways: MAX_ROUTE_WAYS })
      : "")
  );
}

/** piste:difficulty as a rank: novice 1, easy 2, intermediate 3, advanced 4, expert 5, freeride and extreme 6. */
const DIFFICULTY_RANK: Record<string, number> = {
  novice: 1,
  easy: 2,
  intermediate: 3,
  advanced: 4,
  expert: 5,
  freeride: 6,
  extreme: 6,
};

export function difficultyRank(value: string | undefined): number | undefined {
  return value === undefined ? undefined : DIFFICULTY_RANK[value.trim().toLowerCase()];
}

type Line = LineString | MultiLineString;

/** Converts an Overpass response into line features, skipping malformed elements and areas. */
export function normalizeSki(json: unknown, kind?: (typeof PISTE_KINDS)[number]): FeatureCollection<Line> {
  const features: Feature<Line>[] = [];
  const parsed = overpassBodySchema.safeParse(json);
  if (!parsed.success) return { type: "FeatureCollection", features };
  const routeWays = wayGeometryById(parsed.data.elements);
  const seen = new Set<string>();

  for (const raw of parsed.data.elements) {
    let geometry: Line | null = null;
    let osmId = "";
    let tags: Record<string, string> = {};
    let isRoute = false;

    const way = wayElementSchema.safeParse(raw);
    if (way.success) {
      geometry = wayLine(way.data.geometry);
      osmId = `way/${way.data.id}`;
      tags = way.data.tags ?? {};
      if (tags["piste:type"] === undefined || tags.area === "yes") continue;
    } else {
      const rel = relationElementSchema.safeParse(raw);
      if (!rel.success) continue;
      geometry = relationLine(rel.data.members, routeWays);
      osmId = `relation/${rel.data.id}`;
      tags = rel.data.tags ?? {};
      if (tags.route !== "ski" && tags.route !== "piste") continue;
      if (kind !== undefined && tags["piste:type"] !== undefined && tags["piste:type"] !== kind) continue;
      isRoute = true;
    }
    // A piste way can arrive twice: in the piste set and as a member of a route.
    if (geometry === null || seen.has(osmId)) continue;
    seen.add(osmId);

    const properties: Record<string, string | number | boolean> = {
      kind: tags["piste:type"] ?? "route",
      osmId,
    };
    if (isRoute) properties.route = true;
    const name = tags["piste:name"] ?? tags.name;
    if (name) properties.name = name;
    const ref = tags["piste:ref"] ?? tags.ref;
    if (ref) properties.ref = ref;
    if (tags["piste:difficulty"]) properties.difficulty = tags["piste:difficulty"];
    const rank = difficultyRank(tags["piste:difficulty"]);
    if (rank !== undefined) properties.v = rank;
    if (tags["piste:grooming"]) properties.grooming = tags["piste:grooming"];
    if (tags["piste:status"]) properties.status = tags["piste:status"];
    if (tags["piste:lit"] === "yes") properties.lit = true;
    else if (tags["piste:lit"] === "no") properties.lit = false;
    if (tags.network) properties.network = tags.network;
    const t = checkedOn(tags);
    if (t !== undefined) properties.t = t;

    features.push({ type: "Feature", geometry, properties });
  }
  return { type: "FeatureCollection", features };
}

/**
 * Wide mode: the longest named piste ways and ski routes in the box (a name or piste:name), from a scan (counts, ids,
 * bounds) and a geometry fetch of the picked ones. `total` counts every piste way and route in the box, named or not;
 * run.ts writes the coverage note.
 */
async function queryWide(ctx: QueryContext, input: SkiInput): Promise<LayerResult | LayerError> {
  const limit = ctx.wideStrategy?.limit ?? WIDE_LIMIT;
  const selectors = [waySelector(input.kind), ...(input.includeRoutes ? relationSelectors(input.kind) : [])];
  const scan = await overpassQuery(ctx, buildNamedScanQuery(selectors, ["name", "piste:name"], ctx.bbox), {
    cacheSuffix: "ski-routes:scan",
  });
  if (!scan.ok) return { error: scan.error, hint: "upstream" };
  const total = overpassCounts(scan.json)[0];

  const picked = pickNamedByLength(scan.json, ctx.bbox, limit, MAX_ROUTES);
  let features: Feature<Line>[] = [];
  if (picked.ways.length + picked.relations.length > 0) {
    const body = await overpassQuery(ctx, buildNamedGeometryQuery(ctx.bbox, picked, MAX_ROUTE_WAYS));
    if (!body.ok) return { error: body.error, hint: "upstream" };
    const tolerance = routeTolerance(ctx.bbox);
    features = longestNamedFirst(normalizeSki(body.json, input.kind).features, limit).map((f) => simplifiedFeature(f, tolerance));
  }

  return {
    kind: "geojson",
    data: { type: "FeatureCollection", features },
    ...(total !== undefined && { total }),
    citation: osmCitation(),
  };
}

/** piste:type in words: the four the input filters on, named routes, and the other types OpenStreetMap uses. */
const KIND_LABELS: Record<string, string> = {
  nordic: "Nordic",
  downhill: "Downhill",
  skitour: "Ski touring",
  sled: "Sled",
  route: "Named ski route",
  hike: "Winter hiking",
  snow_park: "Terrain park",
  connection: "Connector",
  playground: "Beginner area",
  sleigh: "Sleigh ride",
  ice_skate: "Ice skating",
  fatbike: "Fat bike",
};
const DIFFICULTY_LABELS: Record<string, string> = {
  novice: "Novice",
  easy: "Easy",
  intermediate: "Intermediate",
  advanced: "Advanced",
  expert: "Expert",
  freeride: "Freeride",
  extreme: "Extreme",
};

/** piste:grooming values in words, the combined ones included ("classic+skating"). */
const GROOMING_LABELS: Record<string, string> = {
  classic: "Classic",
  skating: "Skating",
  "classic+skating": "Classic and skating",
  "skating+classic": "Classic and skating",
  "classic;skating": "Classic and skating",
  mogul: "Moguls",
  backcountry: "Not groomed (backcountry)",
  scooter: "Packed by snowmobile",
};

// Kind first: "nordic or downhill?" is the first question; difficulty colours the lines and is the second chip set.
const ATTRIBUTES: Attribute[] = [
  { key: "kind", type: "category", label: "Kind", primary: true, levels: Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })) },
  { key: "v", type: "ordinal", label: "Difficulty", encode: "color", levels: PISTE_LEVELS, scale: PISTE_SCALE },
  { key: "lit", type: "flag", label: "Lit at night" },
  nameAttribute(),
];

const HELP: Record<string, FieldHelp> = {
  difficulty: {
    text:
      "The difficulty of the ski run as tagged in OpenStreetMap (piste:difficulty): on downhill runs it follows the local colours " +
      "(novice and easy green, intermediate blue, advanced black, expert double black, freeride orange or yellow); on ski tours the SAC ski " +
      "scale L to EX.",
    scale: "novice, easy, intermediate, advanced, expert, freeride, extreme",
    source: "OpenStreetMap wiki, Key:piste:difficulty",
    url: "https://wiki.openstreetmap.org/wiki/Key:piste:difficulty",
  },
  v: {
    text: "The piste:difficulty tag as a rank, computed by this app: 1 novice, 2 easy, 3 intermediate, 4 advanced, 5 expert, 6 freeride or extreme.",
    scale: "1 (easiest) to 6 (hardest)",
    source: "OpenStreetMap wiki, Key:piste:difficulty",
    url: "https://wiki.openstreetmap.org/wiki/Key:piste:difficulty",
  },
  kind: {
    text:
      "The piste type (piste:type): downhill, nordic (cross-country), skitour (ski touring), sled, or route for a named ski route made of many " +
      "segments; other types such as snow_park also appear.",
    source: "OpenStreetMap wiki, Key:piste:type",
    url: "https://wiki.openstreetmap.org/wiki/Key:piste:type",
  },
  grooming: {
    text: "How the trail is groomed (piste:grooming), for nordic trails classic, skating or both; backcountry means not groomed.",
    source: "OpenStreetMap wiki, Key:piste:grooming",
    url: "https://wiki.openstreetmap.org/wiki/Key:piste:grooming",
  },
  status: { text: "The piste:status tag as mapped (for example open or closed); it is not a live conditions report." },
  lit: { text: "Whether the piste is lit for night skiing (piste:lit)." },
  route: { text: "Yes when the line is a named ski route (an OpenStreetMap route relation made of many segments), not a single piste." },
  network: { text: "The trail system the piste belongs to, from the OpenStreetMap network tag." },
  t: { text: "The date a mapper last checked the piste on the ground (check_date), when tagged." },
};

/** The difficulty bands the lines are coloured by, easiest first, and the lines with no difficulty mapped. */
const LEGEND: LegendSpec = {
  kind: "categories",
  title: "Difficulty",
  field: "v",
  items: [
    ...PISTE_LEVELS.filter((l, i) => PISTE_LEVELS.findIndex((m) => m.label === l.label) === i).map((l) => ({
      label: l.label,
      value: l.value,
      symbol: "line" as const,
    })),
    { label: "Not rated", color: SAGE, symbol: "line", help: "No difficulty is mapped for this line (common on nordic trails and ski tours)." },
  ],
  note: "On the ground easy is green (or blue in Europe), moderate blue (red in Europe), hard black and expert double black.",
};

// The difficulty word is the card's first row; the rank v and the OpenStreetMap id stay off the card.
const CARD: CardSpec = {
  facts: [
    { key: "difficulty", label: "Difficulty", values: DIFFICULTY_LABELS },
    { key: "kind", label: "Kind", values: KIND_LABELS },
    { key: "grooming", label: "Grooming", format: "list", values: GROOMING_LABELS },
    { key: "network", label: "Trail system" },
    { key: "lit", label: "Lit at night" },
    { key: "status", label: "Status" },
    { key: "t", label: "Last checked", format: "date" },
    { key: "ref", label: "Run number" },
    { key: "route", label: "Named ski route", values: { true: "Yes" } },
  ],
  hidden: ["osmId"],
};

const skiRoutes = defineLayer({
  id: "ski-routes",
  title: "Ski runs, nordic trails and ski touring routes",
  description:
    "Ski pistes and routes from OpenStreetMap, anywhere in the world: downhill runs at resorts, nordic (cross-country) trails, ski touring and backcountry skiing routes, and sled runs. " +
    "Each line has kind ('downhill', 'nordic', 'skitour', 'sled', or 'route' for a named multi-segment ski route; other piste types such as 'snow_park' or 'connection' also appear), " +
    "difficulty as mapped and v as a rank from 1 (novice) through 2 (easy), 3 (intermediate), 4 (advanced) and 5 (expert) to 6 (freeride or extreme), plus name, ref, grooming (nordic: classic, skating), network (the trail system), status and the date last checked (t) when mapped. " +
    "Use it for questions like: where is the cross-country skiing near here, show the groomed nordic trails, which downhill runs are black or expert (v of 4 or more), where are ski touring routes, or is there a ski area in this valley. " +
    "Set kind to focus on one type. " +
    "Caveats: this is volunteer mapping of marked pistes, not avalanche terrain or a conditions report (backcountry skiing routes are sparsely mapped outside the Alps; combine with snowpack for snow depth); " +
    "difficulty colors differ by country, lifts and open or closed status are not included, and trails may be closed or ungroomed. " +
    "At most 2,000 piste ways and 50 routes are returned (a route is drawn only where it crosses the box) and the note gives the count; over 2,500 km² (up to 100,000 km², a whole ski region) the 1,000 longest named ones.",
  coverage: "global",
  surface: "land",
  license: "ODbL (OpenStreetMap contributors)",
  requiredEnv: [],
  optionalEnv: ["OVERPASS_URL"],
  maxAreaKm2: 2500,
  hardMaxAreaKm2: WIDE_MAX_AREA_KM2,
  wide: { mode: "named", orderBy: "length in km", limit: WIDE_LIMIT },
  input: inputSchema,
  style: { geometry: "line", color: layerColor("ski-routes") },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  // Mapped pistes, not conditions: the check_date in `t` is when a mapper looked, not a time to scrub.
  time: { shape: "none" },
  legend: LEGEND,
  labels: { field: "name", max: 8 },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    if (ctx.wide === true) return queryWide(ctx, input);

    const result = await overpassQuery(ctx, buildSkiQuery(ctx.bbox, input), { cacheSuffix: "ski-routes" });
    if (!result.ok) return { error: result.error, hint: "upstream" };

    const data = normalizeSki(result.json, input.kind);
    const returned = data.features.length;
    const total = Math.max(countedTotal(result.json) ?? returned, returned);

    return {
      kind: "geojson",
      data,
      coverageNote: returnedNote(returned, total, "piste ways and routes", "lowest OpenStreetMap ids first"),
      citation: osmCitation(),
    };
  },
});

registerLayer(skiRoutes);

export default skiRoutes;
