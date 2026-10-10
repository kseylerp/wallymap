/**
 * Whitewater rapids, river sections, put-ins and take-outs, and canoe routes from OpenStreetMap via one Overpass query:
 *   node/way["whitewater"]  ["whitewater:rapid_grade"]  ["waterway"="rapids"]   (rapids, access points, hazards; `out tags geom`)
 *   way["whitewater:section_grade"|"whitewater:section_name"]                    (graded river sections as lines)
 *   relation["route"="canoe"]                                                   (named canoe and kayak trails, `out geom`)
 * Fixtures (recorded 2026-10-09, geometry trimmed to 12 vertices): layers/__fixtures__/paddling.trentino.json
 * (Avisio valley, Trentino, Italy: graded rapids, sections, put-ins) and layers/__fixtures__/paddling.bern.json
 * (Aare near Bern, Switzerland: a route=canoe relation and whitewater access points).
 * Tags read: whitewater (rapid, put_in, egress, hazard, portage_way, ...), whitewater:rapid_grade,
 * whitewater:rapid_name, whitewater:section_grade, whitewater:section_name, name, distance, ref, network, check_date (becomes `t`).
 * Live smoke check: Avisio valley, Trentino, Italy (46.1,11 to 46.4,11.6), 2026-10-09: 51 features (32 rapid, 4 access, 15 section); Aare near Bern, Switzerland (46.75,7.35 to 46.98,7.65): 13 (3 access, 4 rapid, 5 section, 1 canoe route). No truncation.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { overpassQuery } from "./_shared/overpass";
import {
  bboxClause,
  returnedNote,
  checkedOn,
  countedTotal,
  gradeNumber,
  nodeElementSchema,
  osmCitation,
  overpassBodySchema,
  relationElementSchema,
  relationLine,
  wayElementSchema,
  wayCenter,
  wayLine,
} from "./_shared/osm-features";
import { layerColor } from "@/lib/render/palette";

/** Most feature ways or nodes returned for each of the two element sets (points and sections). */
export const MAX_PER_SET = 1_500;
/** Most canoe route relations returned; each carries all its member ways' geometry. */
export const MAX_ROUTES = 50;

const inputSchema = z.object({
  /** Leave out flatwater canoe trails (route=canoe relations); keep rapids, sections and access points. */
  whitewaterOnly: z.boolean().default(false),
  /** Keep only features with a whitewater grade of at least this class (1 to 6); ungraded ones are dropped. */
  minGrade: z.number().min(1).max(6).optional(),
});

type PaddlingInput = z.infer<typeof inputSchema>;

/** Overpass QL: rapids and access points, graded sections, and (optionally) canoe routes, each with a count. */
export function buildPaddlingQuery(bbox: BBox, input: Pick<PaddlingInput, "whitewaterOnly">): string {
  const a = bboxClause(bbox);
  const routes = !input.whitewaterOnly;
  return (
    `[out:json][timeout:25];` +
    `(nw["whitewater"]${a};nw["whitewater:rapid_grade"]${a};nw["waterway"="rapids"]${a};)->.p;` +
    `(way["whitewater:section_grade"]${a};way["whitewater:section_name"]${a};)->.s;` +
    (routes ? `rel["route"="canoe"]${a}->.r;` : "") +
    `.p out count;.s out count;` +
    (routes ? `.r out count;` : "") +
    `.p out tags geom ${MAX_PER_SET};.s out tags geom ${MAX_PER_SET};` +
    (routes ? `.r out geom ${MAX_ROUTES};` : "")
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
        geometry = relationLine(rel.data.members);
        osmId = `relation/${rel.data.id}`;
        tags = rel.data.tags;
        shape = "route";
      }
    }
    if (geometry === null) continue;

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
    "Zoom in to a region under 2,500 km² first. Each of the two element sets is cut at 1,500 and canoe routes at 50, and the result says so when it trims. " +
    "Features are a mix of points and lines; switch the display mode to points to see them all as symbols.",
  coverage: "global",
  license: "ODbL (OpenStreetMap contributors)",
  requiredEnv: [],
  optionalEnv: ["OVERPASS_URL"],
  maxAreaKm2: 2500,
  input: inputSchema,
  style: { geometry: "line", color: layerColor("paddling") },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const area = bboxAreaKm2(ctx.bbox);
    if (area > paddling.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${paddling.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    const result = await overpassQuery(ctx, buildPaddlingQuery(ctx.bbox, input), { cacheSuffix: "paddling" });
    if (!result.ok) return { error: result.error, hint: "upstream" };

    const data = normalizePaddling(result.json);
    const returned = data.features.length;
    const total = Math.max(countedTotal(result.json) ?? returned, returned);
    const min = input.minGrade;
    if (min !== undefined) {
      data.features = data.features.filter((f) => {
        const v: unknown = f.properties?.v;
        return typeof v === "number" && v >= min;
      });
    }

    return {
      kind: "geojson",
      data,
      coverageNote: returnedNote(returned, total, "paddling features", "lowest OpenStreetMap ids first"),
      citation: osmCitation(),
    };
  },
});

registerLayer(paddling);

export default paddling;
