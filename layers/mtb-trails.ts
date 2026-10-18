/**
 * Mountain-bike trails from OpenStreetMap via one Overpass query:
 *   way["mtb:scale"]  way["mtb:scale:imba"]   (rated ways, `out tags geom`)
 *   relation["route"="mtb"]                   (named MTB routes; `out body` plus only the member ways inside the box, when includeRoutes)
 * Fixture: layers/__fixtures__/mtb-trails.truckee.json (Truckee / Donner Lake, CA, recorded 2026-10-09 and
 * trimmed to 12 vertices per line and 4 relation members; the live box held 151 rated ways and 1 route).
 * Tags read: mtb:scale (Singletrack Scale 0 to 6), mtb:scale:imba (IMBA 0 to 4), mtb:scale:uphill, name, ref,
 * highway, surface, bicycle, access, operator, check_date (becomes `t`).
 * v is the Singletrack Scale, else the IMBA rating when only that is mapped: IMBA 0 to 4 fall in the same Easy (0, 1),
 * Moderate (2), Hard (3) and Expert (4) bands, so an IMBA-only trail sits on the difficulty ramp instead of reading
 * unrated. Live check, Moab (38.5,-109.65 to 38.68,-109.4), 2026-10-18: 122 features (43 Singletrack, 64 IMBA only, 15
 * routes); before this, 77 drew with no difficulty, now only the 15 routes (drawn as routes) have none.
 * Live smoke check: Truckee / Donner Lake, CA (39.28,-120.25 to 39.38,-120.1), 2026-10-09: 154 features (72 mtb, 81 imba-only, 1 route), no truncation.
 * Wide mode (over 2,500 km², up to WIDE_MAX_AREA_KM2, 100,000): a scan of the named rated ways and routes (ids and
 * bounds), then the geometry of the 1,000 longest inside the box (see buildNamedScanQuery in osm-trails), simplified to
 * what the view can show, with `total` every rated way and route.
 * Live smoke check (wide), 2026-10-14: central Utah (-112.5,38 to -111.5,39, about 9,700 km²): 63 named of 72, 2.1 s;
 * Moab (-110,38.3 to -109.2,38.9): 373 named of 444 (27 routes, Kokopelli's Trail first), 3.0 s.
 * Live smoke check (wide), 2026-10-16, for the 100,000 km² cap: around Moab (-110.5,38 to -108.9,39.2, about 18,500 km²):
 * 420 named of 536 (27 routes, Kokopelli's Trail first), 2.9 s; south-east Utah (-112,37 to -109,39.5, about 72,500 km²):
 * 528 of 996, 3.5 to 9.2 s, 0.2 MB once simplified (2.4 MB before); Colorado Front Range (-107.5,38.5 to -104.5,40.8, about 65,000 km²): 1,000 of 4,779 (70 routes,
 * the Great Divide Mountain Bike Route first), 9.5 s, 0.5 MB (6.6 before); Utah and Colorado (-112,36 to -106,41, about 290,000 km²): 1,000 of
 * 6,891, 9.7 s. The cost is the box's rated ways, not its area: Switzerland (6,45.8 to 10.5,47.8, about 76,000 km²) holds
 * 65,000 and its scan took 14 s once and timed out at 25 s twice, so the densest Alpine regions still need a smaller box.
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
import { MTB_LEVELS, MTB_SCALE, nameAttribute } from "./_shared/bands";
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
import { PURPLE, layerColor } from "@/lib/render/palette";

/** Most rated ways returned; a dense box holds thousands, each with its full geometry. */
export const MAX_WAYS = 2_000;
/** Most route relations returned. */
export const MAX_ROUTES = 100;
/** Most member ways of those routes fetched, and only the ones inside the box. */
export const MAX_ROUTE_WAYS = 3_000;
/** Most named trails and routes in a wide answer (the wide strategy's limit). */
export const WIDE_LIMIT = 1_000;
/**
 * Largest box the layer answers (its hardMaxAreaKm2), with the named trails longest first: a region such as south-east
 * Utah (about 72,500 km²) instead of a "zoom in". Measured in the header: 3 to 10 s in the US.
 */
export const WIDE_MAX_AREA_KM2 = 100_000;

const inputSchema = z.object({
  /** Hardest rating to keep on the Singletrack Scale (0 easiest, 6 hardest; an IMBA-only trail by its IMBA number). Routes always stay. */
  maxScale: z.number().int().min(0).max(6).optional(),
  /** Include `route=mtb` relations (named trail systems and loops). */
  includeRoutes: z.boolean().default(true),
});

type MtbInput = z.infer<typeof inputSchema>;

/**
 * Overpass QL: rated ways, and (optionally) route=mtb relations whose member ways are clipped to the box
 * (see clippedRelationQuery), each with an `out count` for the coverage note.
 */
export function buildMtbQuery(bbox: BBox, input: Pick<MtbInput, "includeRoutes">): string {
  const area = bboxClause(bbox);
  return (
    `[out:json][timeout:25];` +
    `way["mtb:scale"]${area}->.s;way["mtb:scale:imba"]${area}->.i;(.s;.i;)->.w;` +
    `.w out count;.w out tags geom ${MAX_WAYS};` +
    (input.includeRoutes
      ? clippedRelationQuery("r", ['rel["route"="mtb"]'], bbox, { routes: MAX_ROUTES, ways: MAX_ROUTE_WAYS })
      : "")
  );
}

/** Singletrack Scale from "mtb:scale": "2" and "2+" are 2, a range ("1-2") is its harder end; undefined otherwise. */
export function mtbScale(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const m = /^\s*([0-6])\s*[+-]?\s*(?:[-–]\s*([0-6])\s*[+-]?)?\s*$/.exec(value);
  if (!m) return undefined;
  return m[2] === undefined ? Number(m[1]) : Math.max(Number(m[1]), Number(m[2]));
}

/** IMBA trail difficulty from "mtb:scale:imba" (0 to 4). */
export function imbaScale(value: string | undefined): number | undefined {
  const m = value === undefined ? null : /^\s*([0-4])\s*$/.exec(value);
  return m ? Number(m[1]) : undefined;
}

type Line = LineString | MultiLineString;

/**
 * Whether bikes may ride the trail, from the bicycle tag, else an access tag that closes it to everyone (no, private);
 * undefined when OpenStreetMap says nothing.
 */
export function bikesAllowed(tags: Record<string, string>): string | undefined {
  const bicycle = tags.bicycle?.trim().toLowerCase();
  if (bicycle) return bicycle;
  const access = tags.access?.trim().toLowerCase();
  return access === "no" || access === "private" ? access : undefined;
}

/** Converts an Overpass response into line features, skipping malformed elements and unrated, unrelated ones. */
export function normalizeMtb(json: unknown): FeatureCollection<Line> {
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
    } else {
      const rel = relationElementSchema.safeParse(raw);
      if (!rel.success) continue;
      geometry = relationLine(rel.data.members, routeWays);
      osmId = `relation/${rel.data.id}`;
      tags = rel.data.tags ?? {};
      isRoute = true;
    }
    // A rated way can arrive twice: in the rated set and as a member of a route.
    if (geometry === null || seen.has(osmId)) continue;
    seen.add(osmId);

    const scale = mtbScale(tags["mtb:scale"]);
    const imba = imbaScale(tags["mtb:scale:imba"]);
    if (!isRoute && scale === undefined && imba === undefined) continue;

    const properties: Record<string, string | number | boolean> = {
      kind: isRoute ? "route" : scale !== undefined ? "mtb" : "imba",
      osmId,
    };
    if (tags.name) properties.name = tags.name;
    // An unnamed segment is titled by what it is, not by how it is rated.
    else if (!isRoute) properties.heading = tags.highway === "track" ? "Unnamed track" : "Unnamed trail";
    // v: the Singletrack Scale, else the IMBA rating (same bands: 0 and 1 easy, 2 moderate, 3 hard, 4 expert).
    if (scale !== undefined) {
      properties.v = scale;
      properties.singletrack = scale;
    } else if (imba !== undefined) properties.v = imba;
    if (tags["mtb:scale"] && tags["mtb:scale"].trim() !== String(scale)) properties.mtbScale = tags["mtb:scale"];
    if (imba !== undefined) properties.imba = imba;
    const uphill = mtbScale(tags["mtb:scale:uphill"]);
    if (uphill !== undefined) properties.uphill = uphill;
    if (tags.highway) properties.highway = tags.highway;
    if (tags.ref) properties.ref = tags.ref;
    if (tags.surface) properties.surface = tags.surface;
    if (tags.bicycle) properties.bicycle = tags.bicycle;
    const bikes = bikesAllowed(tags);
    if (bikes !== undefined) properties.bikes = bikes;
    if (tags.operator) properties.operator = tags.operator;
    const t = checkedOn(tags);
    if (t !== undefined) properties.t = t;

    features.push({ type: "Feature", geometry, properties });
  }
  return { type: "FeatureCollection", features };
}

/** Keeps ways rated at or below `max` (v: Singletrack, else IMBA); routes with no rating always stay. */
function withinScale(features: Feature<Line>[], max: number | undefined): Feature<Line>[] {
  if (max === undefined) return features;
  return features.filter((f) => {
    const v: unknown = f.properties?.v;
    return typeof v !== "number" || v <= max;
  });
}

/**
 * Wide mode: the longest named rated ways and route=mtb relations in the box, from a scan (counts, ids, bounds) and a
 * geometry fetch of the picked ones. `total` counts every rated way and route in the box, named or not; run.ts writes
 * the coverage note.
 */
async function queryWide(ctx: QueryContext, input: MtbInput): Promise<LayerResult | LayerError> {
  const limit = ctx.wideStrategy?.limit ?? WIDE_LIMIT;
  const selectors = ['way["mtb:scale"]', 'way["mtb:scale:imba"]', ...(input.includeRoutes ? ['rel["route"="mtb"]'] : [])];
  const scan = await overpassQuery(ctx, buildNamedScanQuery(selectors, ["name"], ctx.bbox), { cacheSuffix: "mtb-trails:scan" });
  if (!scan.ok) return { error: scan.error, hint: "upstream" };
  // Every rated way and route in the box, named or not, so the note can say how many were left out.
  const total = overpassCounts(scan.json)[0];

  const picked = pickNamedByLength(scan.json, ctx.bbox, limit, MAX_ROUTES);
  let features: Feature<Line>[] = [];
  if (picked.ways.length + picked.relations.length > 0) {
    const body = await overpassQuery(ctx, buildNamedGeometryQuery(ctx.bbox, picked, MAX_ROUTE_WAYS));
    if (!body.ok) return { error: body.error, hint: "upstream" };
    const tolerance = routeTolerance(ctx.bbox);
    features = longestNamedFirst(normalizeMtb(body.json).features, limit).map((f) => simplifiedFeature(f, tolerance));
  }
  const kept = withinScale(features, input.maxScale);
  const hidden = features.length - kept.length;

  return {
    kind: "geojson",
    data: { type: "FeatureCollection", features: kept },
    ...(total !== undefined && { total }),
    ...(hidden > 0 && { coverageNote: `The difficulty limit hid ${hidden.toLocaleString("en-US")} of the named trails` }),
    citation: osmCitation(),
  };
}

const KIND_LABELS: Record<string, string> = { mtb: "Singletrack rated", imba: "IMBA rated only", route: "Named route" };

/** The card's Singletrack Scale row: the number and its band ("3, Hard"). */
const SINGLETRACK_WORDS: Record<string, string> = Object.fromEntries(MTB_LEVELS.map((l) => [String(l.value), `${l.value}, ${l.label}`]));

/** The card's IMBA row: the number, its band and the trail sign ("3, Hard (black diamond)"). */
const IMBA_WORDS: Record<string, string> = {
  "0": "0, Easy (white circle)",
  "1": "1, Easy (green circle)",
  "2": "2, Moderate (blue square)",
  "3": "3, Hard (black diamond)",
  "4": "4, Expert (double black diamond)",
};

/** Whether bikes may ride the trail, in words, from the bicycle tag (or an access tag that closes it). */
const BIKE_WORDS: Record<string, string> = {
  yes: "Allowed",
  designated: "Allowed, signed as a bike trail",
  permissive: "Allowed by the landowner",
  destination: "Only to reach a place on it",
  customers: "Customers only",
  dismount: "Walk your bike",
  use_sidepath: "Use the side path",
  no: "Not allowed",
  private: "Private, not allowed",
};

/** The difficulty bands the trails are coloured by, and the named routes, drawn in the route gradient with no rating. */
const LEGEND: LegendSpec = {
  kind: "categories",
  title: "Difficulty",
  field: "v",
  items: [
    ...MTB_LEVELS.filter((l, i) => MTB_LEVELS.findIndex((m) => m.label === l.label) === i).map((l) => ({
      label: l.label,
      value: l.value,
      symbol: "line" as const,
    })),
    { label: "Named route, not rated", color: PURPLE, symbol: "line", help: "A named mountain bike route made of many trails, drawn purple to pink." },
  ],
  note: "Difficulty is the Singletrack Scale, or the IMBA rating where only that is mapped.",
};

const ATTRIBUTES: Attribute[] = [
  { key: "v", type: "ordinal", label: "Difficulty", encode: "color", levels: MTB_LEVELS, scale: MTB_SCALE },
  { key: "kind", type: "category", label: "Kind", levels: Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })) },
  nameAttribute(),
];

const SINGLETRACK: FieldHelp = {
  text:
    "How hard the trail is to ride on the Singletrack Scale (mtb:scale), as an OpenStreetMap mapper tagged it: 0 is gravel or packed earth " +
    "with no particular difficulties, 6 is not rideable at all; a + or - or a range like 1-2 counts as its harder end.",
  scale: "0 (easiest) to 6 (hardest)",
  source: "OpenStreetMap wiki, Key:mtb:scale",
  url: "https://wiki.openstreetmap.org/wiki/Key:mtb:scale",
};

const HELP: Record<string, FieldHelp> = {
  v: {
    ...SINGLETRACK,
    text: `${SINGLETRACK.text} Where only an IMBA rating is mapped, v is that rating (0 to 4), which falls in the same Easy, Moderate, Hard and Expert bands.`,
  },
  singletrack: SINGLETRACK,
  bikes: {
    text:
      "Whether bikes may ride the trail, from OpenStreetMap's bicycle tag (or an access tag that closes the trail to everyone); blank when nothing is " +
      "mapped. Check the land manager: closures and seasonal rules are not here.",
    source: "OpenStreetMap wiki, Key:bicycle",
    url: "https://wiki.openstreetmap.org/wiki/Key:bicycle",
  },
  mtbScale: {
    ...SINGLETRACK,
    text: "The Singletrack Scale rating exactly as tagged (for example 2+ or 1-2), shown when it differs from the number.",
  },
  imba: {
    text: "The IMBA trail difficulty rating (mtb:scale:imba) as tagged in OpenStreetMap, used mostly on purpose-built and bike park trails.",
    scale: "0 (easiest) to 4 (hardest)",
    source: "OpenStreetMap wiki, Key:mtb:scale:imba",
    url: "https://wiki.openstreetmap.org/wiki/Key:mtb:scale:imba",
  },
  uphill: {
    text:
      "How hard the trail is to ride uphill (mtb:scale:uphill): 0 is a firm surface almost any rider can climb, 5 is too steep or rough to ride " +
      "up.",
    scale: "0 (easiest) to 5 (push or carry)",
    source: "OpenStreetMap wiki, Key:mtb:scale",
    url: "https://wiki.openstreetmap.org/wiki/Key:mtb:scale",
  },
  kind: {
    text:
      "mtb: a segment rated on the Singletrack Scale; imba: a segment with only an IMBA rating; route: a named mountain bike route made of many " +
      "segments.",
  },
  bicycle: {
    text: "Whether bikes are allowed, from the OpenStreetMap bicycle tag (yes, designated, permissive, no and so on); check the land manager too.",
    source: "OpenStreetMap wiki, Key:bicycle",
    url: "https://wiki.openstreetmap.org/wiki/Key:bicycle",
  },
  t: { text: "The date a mapper last checked the trail on the ground (check_date), when tagged." },
};

// The rating in words ("3, Hard"), not a bare number; v, the raw bicycle tag and the id stay off the card.
const CARD: CardSpec = {
  facts: [
    { key: "singletrack", label: "Singletrack Scale", values: SINGLETRACK_WORDS },
    { key: "imba", label: "IMBA rating", values: IMBA_WORDS },
    { key: "bikes", label: "Bikes", values: BIKE_WORDS },
    { key: "kind", label: "Kind", values: KIND_LABELS },
    { key: "uphill", label: "Uphill rating" },
    { key: "surface", label: "Surface" },
    { key: "operator", label: "Operator" },
    { key: "t", label: "Last checked", format: "date" },
  ],
  hidden: ["osmId", "bicycle"],
};

const mtbTrails = defineLayer({
  id: "mtb-trails",
  title: "Mountain bike trails",
  description:
    "Mountain biking trails (singletrack, flow trails, bike park lines and rated tracks) from OpenStreetMap, anywhere in the world. " +
    "Each line is a rated trail segment: v is the Singletrack Scale rating from 0 (easiest, smooth and wide) to 6 (hardest, almost not rideable), or the IMBA rating 0 to 4 when only that is mapped (both read 0-1 easy, 2 moderate, 3 hard, 4 and up expert); " +
    "singletrack and imba hold each scale as mapped, and kind is 'mtb' (has a Singletrack Scale rating), 'imba' (IMBA rating only) or 'route' (a named mountain bike route or trail system made of many segments). " +
    "bikes says whether bikes are allowed, from the bicycle or access tag (yes, designated, permissive, no, private, dismount), when mapped. " +
    "Also name, ref, surface, operator and the date it was last checked (t) when mapped. " +
    "Use it for questions like: where can I go mountain biking near here, show beginner singletrack (set maxScale to 2), which trails are the hardest, or is there a flow trail or bike park nearby. " +
    "Caveats: ratings exist only where a mapper added them, so many good trails are missing or unrated (osm-trails shows every path, including ones with no mountain bike rating); " +
    "bikes may be banned on a rated trail where bikes is not mapped, so check the land manager (public-lands, forest-roads); the rating describes the trail, not its current condition or closures. " +
    "At most 2,000 rated ways and 100 routes are returned (a route is drawn only where it crosses the box) and the note gives the count; over 2,500 km² (up to 100,000 km², a whole region) the 1,000 longest named ones.",
  coverage: "global",
  surface: "land",
  license: "ODbL (OpenStreetMap contributors)",
  requiredEnv: [],
  optionalEnv: ["OVERPASS_URL"],
  maxAreaKm2: 2500,
  hardMaxAreaKm2: WIDE_MAX_AREA_KM2,
  wide: { mode: "named", orderBy: "length in km", limit: WIDE_LIMIT },
  input: inputSchema,
  style: { geometry: "line", color: layerColor("mtb-trails") },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  // Mapped trails, not conditions: the check_date in `t` is when a mapper looked, not a time to scrub.
  time: { shape: "none" },
  legend: LEGEND,
  labels: { field: "name", max: 8, rankBy: "v" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    if (ctx.wide === true) return queryWide(ctx, input);

    const result = await overpassQuery(ctx, buildMtbQuery(ctx.bbox, input), { cacheSuffix: "mtb-trails" });
    if (!result.ok) return { error: result.error, hint: "upstream" };

    const data = normalizeMtb(result.json);
    const fetched = data.features.length;
    const total = Math.max(countedTotal(result.json) ?? fetched, fetched);
    data.features = withinScale(data.features, input.maxScale);

    return {
      kind: "geojson",
      data,
      coverageNote: returnedNote(data.features.length, total, "rated trail ways and routes", "lowest OpenStreetMap ids first", {
        fetched,
        filter: "the difficulty limit",
      }),
      citation: osmCitation(),
    };
  },
});

registerLayer(mtbTrails);

export default mtbTrails;
