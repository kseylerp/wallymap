/**
 * Ski runs, nordic trails and ski-touring routes from OpenStreetMap via one Overpass query:
 *   way["piste:type"]["area"!="yes"]   (downhill, nordic, skitour, sled and other piste ways, `out tags geom`)
 *   relation["route"="ski"|"piste"]    (named ski routes; `out body` plus only the member ways inside the box)
 * Fixture: layers/__fixtures__/ski-routes.chamonix.json (Chamonix, France, recorded 2026-10-09 and trimmed to
 * 12 vertices per line and 4 relation members; the live box held many piste ways and 3 route=ski relations).
 * Tags read: piste:type, piste:difficulty, piste:name, name, ref, piste:grooming, piste:status, piste:lit,
 * network, check_date (becomes `t`). Closed outline areas (area=yes) are skipped so they do not overdraw the runs.
 * Live smoke check: Chamonix, France (45.85,6.8 to 46,7.05), 2026-10-09: 317 features (151 downhill, 103 nordic, 37 skitour, 26 other), no truncation; Truckee CA nordic only: 260.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, LineString, MultiLineString } from "geojson";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { overpassQuery } from "./_shared/overpass";
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
import { layerColor } from "@/lib/render/palette";

/** Most piste ways returned; a resort-dense box holds thousands, each with its full geometry. */
export const MAX_WAYS = 2_000;
/** Most route relations returned. */
export const MAX_ROUTES = 50;
/** Most member ways of those routes fetched, and only the ones inside the box. */
export const MAX_ROUTE_WAYS = 3_000;

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

/**
 * Overpass QL: piste ways and (optionally) route=ski and route=piste relations whose member ways are clipped to the
 * box (see clippedRelationQuery), each with an `out count` for the coverage note.
 */
export function buildSkiQuery(bbox: BBox, input: Pick<SkiInput, "kind" | "includeRoutes">): string {
  const area = bboxClause(bbox);
  const type = input.kind === undefined ? '["piste:type"]' : `["piste:type"="${input.kind}"]`;
  return (
    `[out:json][timeout:25];` +
    `way${type}["area"!="yes"]${area}->.w;` +
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
    "Zoom in to a region under 2,500 km² first. At most 2,000 piste ways and 50 routes are returned (a route is drawn only where it passes through the box) and the coverage note gives the count and says if it was trimmed.",
  coverage: "global",
  license: "ODbL (OpenStreetMap contributors)",
  requiredEnv: [],
  optionalEnv: ["OVERPASS_URL"],
  maxAreaKm2: 2500,
  input: inputSchema,
  style: { geometry: "line", color: layerColor("ski-routes") },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const area = bboxAreaKm2(ctx.bbox);
    if (area > skiRoutes.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${skiRoutes.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

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
