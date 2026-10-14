/**
 * Whitewater rapids, river sections, put-ins and take-outs, and canoe routes from OpenStreetMap via one Overpass query:
 *   node/way["whitewater"]  ["whitewater:rapid_grade"]  ["waterway"="rapids"]   (rapids, access points, hazards; `out tags geom`)
 *   way["whitewater:section_grade"|"whitewater:section_name"]                    (graded river sections as lines)
 *   relation["route"="canoe"]                                                   (named canoe and kayak trails; `out body` plus only the member ways inside the box)
 * Fixtures (recorded 2026-10-09, geometry trimmed to 12 vertices): layers/__fixtures__/paddling.trentino.json
 * (Avisio valley, Trentino, Italy: graded rapids, sections, put-ins) and layers/__fixtures__/paddling.bern.json
 * (Aare near Bern, Switzerland: a route=canoe relation and whitewater access points).
 * Tags read: whitewater (rapid, put_in, egress, hazard, portage_way, ...), whitewater:rapid_grade,
 * whitewater:rapid_name, whitewater:section_grade, whitewater:section_name, name, distance, ref, network, check_date (becomes `t`).
 * Live smoke check: Avisio valley, Trentino, Italy (46.1,11 to 46.4,11.6), 2026-10-09: 51 features (32 rapid, 4 access, 15 section); Aare near Bern, Switzerland (46.75,7.35 to 46.98,7.65): 13 (3 access, 4 rapid, 5 section, 1 canoe route). No truncation.
 * Wide mode (over 2,500 km², up to 10,000): one query for the named features only (a name, whitewater:rapid_name or
 * whitewater:section_name), the first 1,000 by OpenStreetMap id plus up to 50 named canoe routes clipped to the box,
 * with `total` every paddling feature in the box. Points have no length, so there is no ranking.
 * Live smoke check (wide), 2026-10-14: Aare from Bern to Thun (7,46.3 to 8.2,47, about 7,200 km²): 46 named of 59
 * (26 access, 17 section, 2 rapid, 1 canoe route), 8.3 s.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext, type CardSpec, type Facet, type FieldHelp } from "./types";
import { registerLayer } from "./registry";
import { overpassCounts, overpassQuery } from "./_shared/overpass";
import {
  bboxClause,
  returnedNote,
  checkedOn,
  clippedRelationQuery,
  countedTotal,
  gradeNumber,
  nodeElementSchema,
  osmCitation,
  overpassBodySchema,
  relationElementSchema,
  relationLine,
  wayElementSchema,
  wayCenter,
  wayGeometryById,
  wayLine,
} from "./_shared/osm-features";
import { layerColor } from "@/lib/render/palette";

/** Most feature ways or nodes returned for each of the two element sets (points and sections). */
export const MAX_PER_SET = 1_500;
/** Most canoe route relations returned. */
export const MAX_ROUTES = 50;
/** Most member ways of those routes fetched, and only the ones inside the box. */
export const MAX_ROUTE_WAYS = 3_000;
/** Most named features in a wide answer (the wide strategy's limit). */
export const WIDE_LIMIT = 1_000;
/** Tags that name a paddling feature, for the wide answer's named filter. */
const NAME_KEYS = ["name", "whitewater:rapid_name", "whitewater:section_name"];

const inputSchema = z.object({
  /** Leave out flatwater canoe trails (route=canoe relations); keep rapids, sections and access points. */
  whitewaterOnly: z.boolean().default(false),
  /** Keep only features with a whitewater grade of at least this class (1 to 6); ungraded ones are dropped. */
  minGrade: z.number().min(1).max(6).optional(),
});

type PaddlingInput = z.infer<typeof inputSchema>;

const POINT_SELECTORS = ['nw["whitewater"]', 'nw["whitewater:rapid_grade"]', 'nw["waterway"="rapids"]'];
const SECTION_SELECTORS = ['way["whitewater:section_grade"]', 'way["whitewater:section_name"]'];

/**
 * Overpass QL for wide mode: every paddling feature counted, then only the named ones (see NAME_KEYS) counted and sent,
 * nodes and ways at most `limit` by id, and named canoe routes (unless whitewaterOnly) with only their member ways
 * inside the box as bare geometry. Read the two counts with overpassCounts (every feature, then the named).
 */
export function buildWidePaddlingQuery(bbox: BBox, input: Pick<PaddlingInput, "whitewaterOnly">, limit: number): string {
  const a = bboxClause(bbox);
  const selectors = [...POINT_SELECTORS, ...SECTION_SELECTORS, ...(input.whitewaterOnly ? [] : ['rel["route"="canoe"]'])];
  const named = NAME_KEYS.map((key) => `node.all["${key}"];way.all["${key}"];rel.all["${key}"];`).join("");
  return (
    `[out:json][timeout:25];(${selectors.map((sel) => `${sel}${a};`).join("")})->.all;.all out count;` +
    `(${named})->.named;.named out count;` +
    `(node.named;way.named;)->.nw;.nw out tags geom ${limit};` +
    (input.whitewaterOnly ? "" : `rel.named->.r;way(r.r)${a}->.rw;.r out body ${MAX_ROUTES};.rw out skel geom ${MAX_ROUTE_WAYS};`)
  );
}

/** Keeps features graded at least `min`; with no minimum, all of them. */
function atLeastGrade(features: Feature<Geometry>[], min: number | undefined): Feature<Geometry>[] {
  if (min === undefined) return features;
  return features.filter((f) => {
    const v: unknown = f.properties?.v;
    return typeof v === "number" && v >= min;
  });
}

/**
 * Wide mode: the named paddling features in the box from one bounded query, at most the strategy's limit. `total`
 * counts every paddling feature in the box, named or not; run.ts writes the coverage note.
 */
async function queryWide(ctx: QueryContext, input: PaddlingInput): Promise<LayerResult | LayerError> {
  const limit = ctx.wideStrategy?.limit ?? WIDE_LIMIT;
  const result = await overpassQuery(ctx, buildWidePaddlingQuery(ctx.bbox, input, limit), { cacheSuffix: "paddling:wide" });
  if (!result.ok) return { error: result.error, hint: "upstream" };
  const total = overpassCounts(result.json)[0];

  const named = normalizePaddling(result.json)
    .features.filter((f) => typeof f.properties?.name === "string")
    .slice(0, limit);
  const kept = atLeastGrade(named, input.minGrade);
  const hidden = named.length - kept.length;

  return {
    kind: "geojson",
    data: { type: "FeatureCollection", features: kept },
    ...(total !== undefined && { total }),
    ...(hidden > 0 && { coverageNote: `minGrade hid ${hidden.toLocaleString("en-US")} of the named features` }),
    citation: osmCitation(),
  };
}

/**
 * Overpass QL: rapids and access points, graded sections, and (optionally) canoe routes whose member ways are clipped
 * to the box (see clippedRelationQuery), each with an `out count` for the coverage note.
 */
export function buildPaddlingQuery(bbox: BBox, input: Pick<PaddlingInput, "whitewaterOnly">): string {
  const a = bboxClause(bbox);
  return (
    `[out:json][timeout:25];` +
    `(${POINT_SELECTORS.map((sel) => `${sel}${a};`).join("")})->.p;` +
    `(${SECTION_SELECTORS.map((sel) => `${sel}${a};`).join("")})->.s;` +
    `.p out count;.s out count;` +
    `.p out tags geom ${MAX_PER_SET};.s out tags geom ${MAX_PER_SET};` +
    (input.whitewaterOnly
      ? ""
      : clippedRelationQuery("r", ['rel["route"="canoe"]'], bbox, { routes: MAX_ROUTES, ways: MAX_ROUTE_WAYS }))
  );
}

/** Whether an element carries any of the tags the point and section queries select on. */
function isPaddlingTagged(tags: Record<string, string>): boolean {
  return (
    tags.whitewater !== undefined ||
    tags["whitewater:rapid_grade"] !== undefined ||
    tags["whitewater:section_grade"] !== undefined ||
    tags["whitewater:section_name"] !== undefined ||
    tags.waterway === "rapids"
  );
}

export type PaddlingKind = "rapid" | "access" | "hazard" | "portage" | "feature" | "section" | "route";

const ACCESS = /^(put[_-]?in|egress|take[_-]?out|put_in_out|launch)/i;

/** What a tagged element is for a paddler. */
export function paddlingKind(tags: Record<string, string>, shape: "route" | "section" | "other"): PaddlingKind {
  if (shape === "route") return "route";
  if (shape === "section") return "section";
  const ww = tags.whitewater?.toLowerCase();
  if (ww === "rapid" || tags["whitewater:rapid_grade"] !== undefined) return "rapid";
  if (ww && ACCESS.test(ww)) return "access";
  if (ww === "hazard" || ww === "weir" || ww === "dam") return "hazard";
  if (ww === "portage_way" || ww === "portage") return "portage";
  if (tags.waterway === "rapids") return "rapid";
  return "feature";
}

type Props = Record<string, string | number | boolean>;

/** Converts an Overpass response into mixed point and line features, skipping malformed elements. */
export function normalizePaddling(json: unknown): FeatureCollection<Geometry> {
  const features: Feature<Geometry>[] = [];
  const parsed = overpassBodySchema.safeParse(json);
  if (!parsed.success) return { type: "FeatureCollection", features };
  const routeWays = wayGeometryById(parsed.data.elements);
  const seen = new Set<string>();

  for (const raw of parsed.data.elements) {
    let geometry: Geometry | null = null;
    let osmId = "";
    let tags: Record<string, string> = {};
    let shape: "route" | "section" | "other" = "other";

    const node = nodeElementSchema.safeParse(raw);
    if (node.success) {
      geometry = { type: "Point", coordinates: [node.data.lon, node.data.lat] };
      osmId = `node/${node.data.id}`;
      tags = node.data.tags ?? {};
    } else {
      const way = wayElementSchema.safeParse(raw);
      if (way.success) {
        osmId = `way/${way.data.id}`;
        tags = way.data.tags ?? {};
        const line = wayLine(way.data.geometry);
        if (line === null) continue;
        shape =
          tags["whitewater:section_grade"] !== undefined || tags["whitewater:section_name"] !== undefined
            ? "section"
            : "other";
        // Sections and rapids are drawn as lines; piers, slipways and other small ways as a point at their middle.
        const isLine = shape === "section" || tags.whitewater === "rapid" || tags.waterway === "rapids";
        const mid = isLine ? null : wayCenter(way.data.geometry);
        geometry = mid === null ? line : { type: "Point", coordinates: mid };
      } else {
        const rel = relationElementSchema.safeParse(raw);
        if (!rel.success || rel.data.tags?.route !== "canoe") continue;
        geometry = relationLine(rel.data.members, routeWays);
        osmId = `relation/${rel.data.id}`;
        tags = rel.data.tags;
        shape = "route";
      }
    }
    // Member ways of a canoe route come back as bare ways; only tagged paddling features are features.
    if (geometry === null || seen.has(osmId) || (shape !== "route" && !isPaddlingTagged(tags))) continue;
    seen.add(osmId);

    const kind = paddlingKind(tags, shape);
    const properties: Props = { kind, osmId };
    const gradeText = shape === "section" ? tags["whitewater:section_grade"] : tags["whitewater:rapid_grade"];
    const name =
      shape === "section"
        ? (tags["whitewater:section_name"] ?? tags.name)
        : (tags["whitewater:rapid_name"] ?? tags.name);
    if (name) properties.name = name;
    if (shape === "section" && tags.name && tags.name !== name) properties.river = tags.name;
    if (tags.whitewater) properties.whitewater = tags.whitewater;
    if (gradeText) {
      properties.grade = gradeText;
      const v = gradeNumber(gradeText);
      if (v !== undefined) properties.v = v;
    }
    if (shape === "route") {
      const km = Number(tags.distance);
      if (Number.isFinite(km) && km > 0) properties.distanceKm = km;
      if (tags.ref) properties.ref = tags.ref;
      if (tags.network) properties.network = tags.network;
    }
    const t = checkedOn(tags);
    if (t !== undefined) properties.t = t;

    features.push({ type: "Feature", geometry, properties });
  }
  return { type: "FeatureCollection", features };
}

/** Class numbers gradeNumber can emit, each under its class (a + or - half step stays in the class it is written with). */
const CLASS_VALUES: [number, string][] = [
  [0.5, "Class I"],
  [1, "Class I"],
  [1.5, "Class I"],
  [2, "Class II"],
  [2.5, "Class II"],
  [3, "Class III"],
  [3.5, "Class III"],
  [4, "Class IV"],
  [4.5, "Class IV"],
  [5, "Class V"],
  [5.5, "Class V"],
  [6, "Class VI"],
  [6.5, "Class VI"],
];

const KIND_LABELS: Record<PaddlingKind, string> = {
  rapid: "Rapid",
  section: "Section",
  access: "Put-in or take-out",
  hazard: "Hazard",
  portage: "Portage",
  route: "Canoe route",
  feature: "Other feature",
};

const FACETS: Facet[] = [
  { key: "v", label: "Class", kind: "category", encode: "color", values: CLASS_VALUES.map(([value, label]) => ({ value, label })) },
  { key: "kind", label: "Kind", kind: "category", values: Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })) },
];

const SCALE_URL = "https://americanwhitewater.org/content/Wiki/safety:internation_scale_of_river_difficulty";

const HELP: Record<string, FieldHelp> = {
  grade: {
    text:
      "The whitewater grade as tagged in OpenStreetMap (whitewater:rapid_grade or whitewater:section_grade), on the International Scale of River " +
      "Difficulty: Class I easy, II novice, III intermediate, IV advanced, V expert, VI extreme and exploratory; ratings change with water level.",
    scale: "Class I (easiest) to Class VI (hardest)",
    source: "American Whitewater, International Scale of River Difficulty",
    url: SCALE_URL,
  },
  v: {
    text:
      "The grade as a number, computed by this app: the class (Roman or Arabic), plus a half for + or minus a half for -, " +
      "and a range such as III-IV counts as its harder end.",
    scale: "1 (Class I) to 6 (Class VI)",
    source: "American Whitewater, International Scale of River Difficulty",
    url: SCALE_URL,
  },
  kind: {
    text:
      "What the feature is for a paddler: a rapid, a graded river section, an access point (put-in or take-out), a hazard such as a weir, " +
      "a portage, a canoe route, or another feature such as a play wave.",
  },
  whitewater: {
    text: "The raw OpenStreetMap whitewater tag (for example rapid, put_in, egress, hazard, portage_way).",
    source: "OpenStreetMap wiki, Key:whitewater",
    url: "https://wiki.openstreetmap.org/wiki/Key:whitewater",
  },
  distanceKm: { text: "The canoe route's length from its OpenStreetMap distance tag.", unit: "km" },
  river: { text: "The river's name, when the section carries its own section name." },
  t: { text: "The date a mapper last checked the feature on the ground (check_date), when tagged." },
};

const CARD: CardSpec = {
  measure: { key: "v", label: "Whitewater class" },
  facts: [
    { key: "grade", label: "Grade as tagged" },
    { key: "kind", label: "Kind", values: KIND_LABELS },
    { key: "river", label: "River" },
    { key: "distanceKm", label: "Length", format: "km" },
    { key: "network", label: "Network" },
    { key: "t", label: "Last checked", format: "date" },
  ],
};

const paddling = defineLayer({
  id: "paddling",
  title: "Whitewater rapids, put-ins and canoe routes",
  description:
    "Whitewater and paddling features from OpenStreetMap, anywhere in the world: rapids, graded river sections, put-ins and take-outs, hazards and portages, and named canoe and kayak routes. " +
    "Each feature has kind: 'rapid' (a point or short line), 'section' (a river reach drawn as a line), 'access' (a put-in or take-out, where to launch), 'hazard' (weirs, low-head dams and other dangers), 'portage', 'route' (a flatwater canoe trail or kayaking route, with distanceKm when mapped) or 'feature' (a play wave or other spot). " +
    "v is the whitewater class on a 1 to 6 scale (3 is class III, 3.5 is III+, a range like III-IV counts as its harder end; 6 is unrunnable) with grade holding the original text; many rapids, access points and routes have no grade and so no v. " +
    "Use it for questions like: where can I go whitewater kayaking or rafting near here, find class III and harder rapids (set minGrade to 3), where are the put-ins and take-outs on this river, is there a canoe trail nearby, or show weirs and hazards on a river. " +
    "Set whitewaterOnly to true to skip flatwater canoe routes. " +
    "Caveats: coverage is uneven, strongest in the Alps and parts of Europe and thin in many whitewater regions (the US West is sparse); a river with no features here may still be a famous run, so treat it as a lead and not a guide; " +
    "grades are volunteer-entered and change with water level and year, and nothing here reports current flow, so combine with streamflow (cfs) before paddling or rafting; closures, permits and dam releases are not included. " +
    "Each of the two element sets is cut at 1,500 and canoe routes at 50 (a route is drawn only where it crosses the box) and the note gives the count; over 2,500 km² only the first 1,000 named features. " +
    "Features are a mix of points and lines; switch the display mode to points to see them all as symbols.",
  coverage: "global",
  license: "ODbL (OpenStreetMap contributors)",
  requiredEnv: [],
  optionalEnv: ["OVERPASS_URL"],
  maxAreaKm2: 2500,
  // Rapids and access points have no length, so the wide answer keeps the named ones in OpenStreetMap id order.
  wide: { mode: "named", limit: WIDE_LIMIT },
  input: inputSchema,
  style: { geometry: "line", color: layerColor("paddling"), facets: FACETS },
  fieldHelp: HELP,
  card: CARD,

  async query(ctx, input): Promise<LayerResult | LayerError> {
    if (ctx.wide === true) return queryWide(ctx, input);

    const result = await overpassQuery(ctx, buildPaddlingQuery(ctx.bbox, input), { cacheSuffix: "paddling" });
    if (!result.ok) return { error: result.error, hint: "upstream" };

    const data = normalizePaddling(result.json);
    const fetched = data.features.length;
    const total = Math.max(countedTotal(result.json) ?? fetched, fetched);
    data.features = atLeastGrade(data.features, input.minGrade);

    return {
      kind: "geojson",
      data,
      coverageNote: returnedNote(data.features.length, total, "paddling features", "lowest OpenStreetMap ids first", {
        fetched,
        filter: "minGrade",
      }),
      citation: osmCitation(),
    };
  },
});

registerLayer(paddling);

export default paddling;
