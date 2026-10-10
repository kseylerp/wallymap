/**
 * Mountain-bike trails from OpenStreetMap via one Overpass query:
 *   way["mtb:scale"]  way["mtb:scale:imba"]   (rated ways, `out tags geom`)
 *   relation["route"="mtb"]                   (named MTB routes; `out body` plus only the member ways inside the box, when includeRoutes)
 * Fixture: layers/__fixtures__/mtb-trails.truckee.json (Truckee / Donner Lake, CA, recorded 2026-10-09 and
 * trimmed to 12 vertices per line and 4 relation members; the live box held 151 rated ways and 1 route).
 * Tags read: mtb:scale (Singletrack Scale 0 to 6), mtb:scale:imba (IMBA 0 to 4), mtb:scale:uphill, name, ref,
 * highway, surface, bicycle, operator, check_date (becomes `t`).
 * Live smoke check: Truckee / Donner Lake, CA (39.28,-120.25 to 39.38,-120.1), 2026-10-09: 154 features (72 mtb, 81 imba-only, 1 route), no truncation.
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

/** Most rated ways returned; a dense box holds thousands, each with its full geometry. */
export const MAX_WAYS = 2_000;
/** Most route relations returned. */
export const MAX_ROUTES = 100;
/** Most member ways of those routes fetched, and only the ones inside the box. */
export const MAX_ROUTE_WAYS = 3_000;

const inputSchema = z.object({
  /** Hardest Singletrack Scale rating to keep (0 easiest, 6 hardest). Unrated imba-only ways and routes always stay. */
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
    if (scale !== undefined) properties.v = scale;
    if (tags["mtb:scale"] && tags["mtb:scale"].trim() !== String(scale)) properties.mtbScale = tags["mtb:scale"];
    if (imba !== undefined) properties.imba = imba;
    const uphill = mtbScale(tags["mtb:scale:uphill"]);
    if (uphill !== undefined) properties.uphill = uphill;
    if (tags.highway) properties.highway = tags.highway;
    if (tags.ref) properties.ref = tags.ref;
    if (tags.surface) properties.surface = tags.surface;
    if (tags.bicycle) properties.bicycle = tags.bicycle;
    if (tags.operator) properties.operator = tags.operator;
    const t = checkedOn(tags);
    if (t !== undefined) properties.t = t;

    features.push({ type: "Feature", geometry, properties });
  }
  return { type: "FeatureCollection", features };
}

const mtbTrails = defineLayer({
  id: "mtb-trails",
  title: "Mountain bike trails",
  description:
    "Mountain biking trails (singletrack, flow trails, bike park lines and rated tracks) from OpenStreetMap, anywhere in the world. " +
    "Each line is a rated trail segment: v is the Singletrack Scale rating from 0 (easiest, smooth and wide) to 6 (hardest, almost not rideable), " +
    "imba is the IMBA rating 0 to 4 when only that is mapped, and kind is 'mtb' (has a Singletrack Scale rating), 'imba' (IMBA rating only) or 'route' (a named mountain bike route or trail system made of many segments). " +
    "Also name, ref, surface, operator and the date it was last checked (t) when mapped. " +
    "Use it for questions like: where can I go mountain biking near here, show beginner singletrack (set maxScale to 2), which trails are the hardest, or is there a flow trail or bike park nearby. " +
    "Caveats: ratings exist only where a mapper added them, so many good trails are missing or unrated (osm-trails shows every path, including ones with no mountain bike rating); " +
    "bikes may be banned on a rated trail, so check the land manager (public-lands, forest-roads); the rating describes the trail, not its current condition or closures. " +
    "Zoom in to a region under 2,500 km² first. At most 2,000 rated ways and 100 routes are returned (a route is drawn only where it passes through the box) and the coverage note gives the count and says if it was trimmed.",
  coverage: "global",
  license: "ODbL (OpenStreetMap contributors)",
  requiredEnv: [],
  optionalEnv: ["OVERPASS_URL"],
  maxAreaKm2: 2500,
  input: inputSchema,
  style: { geometry: "line", color: layerColor("mtb-trails") },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const area = bboxAreaKm2(ctx.bbox);
    if (area > mtbTrails.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${mtbTrails.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    const result = await overpassQuery(ctx, buildMtbQuery(ctx.bbox, input), { cacheSuffix: "mtb-trails" });
    if (!result.ok) return { error: result.error, hint: "upstream" };

    const data = normalizeMtb(result.json);
    const fetched = data.features.length;
    const total = Math.max(countedTotal(result.json) ?? fetched, fetched);
    const max = input.maxScale;
    if (max !== undefined) {
      data.features = data.features.filter((f) => {
        const v: unknown = f.properties?.v;
        return typeof v !== "number" || v <= max;
      });
    }

    return {
      kind: "geojson",
      data,
      coverageNote: returnedNote(data.features.length, total, "rated trail ways and routes", "lowest OpenStreetMap ids first", {
        fetched,
        filter: "maxScale",
      }),
      citation: osmCitation(),
    };
  },
});

registerLayer(mtbTrails);

export default mtbTrails;
