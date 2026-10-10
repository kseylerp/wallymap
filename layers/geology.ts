/**
 * Bedrock and surface geology from Macrostrat (CC BY 4.0), keyless.
 *
 * Map: vector tiles https://tiles.macrostrat.org/carto/{z}/{x}/{y}.mvt (tilejson at /carto/tilejson.json: zoom 0 to 22, world bounds).
 *   Decoded live on 2026-10-09: two source layers, `units` (polygons; properties map_id, source_id, name, age, lith, descrip, t_int, b_int,
 *   best_age_top, best_age_bottom, color as "#rrggbb", ref_*) and `lines` (faults and other contacts; properties type, name, descrip).
 *   Tiles answer at z0 to z16 and beyond (z8 Tahoe: 927 units; z12: 47; z16: 5); the layer draws `units` only, since a tile result
 *   carries one source layer. The tile server is a public service run by the Macrostrat team; set no key.
 *
 * Identify: https://macrostrat.org/api/v2/geologic_units/map?lat=<lat>&lng=<lon>
 *   Response: { success: { v, license, refs: { <source_id>: citation }, data: [unit, ...] } } with one unit per map scale
 *   ("large" most detailed, then "medium", "small", "tiny"). Unit fields used: map_id, source_id, name, strat_name (formation names,
 *   can be a few KB), lith (text such as "Major:{granodiorite}, Minor:{granite}", sometimes empty), descrip, t_int_name / b_int_name
 *   (youngest / oldest interval), t_age / b_age (Ma), color, scale.
 * Smoke check 2026-10-09 (live, keyless, through runLayer): no point -> vector tile result (tile fetches at z8, z12, z16 over Tahoe all 200);
 *   point (-120.0, 38.9) near Lake Tahoe returned 4 units, most detailed "Till" (Pleistocene, large scale) over Mesozoic granitic
 *   rocks (medium), in 0.2 s; point (-109.55, 38.57) near Moab returned "Stream alluvium" (Late Pleistocene to Holocene).
 */
import { z } from "zod";
import type { Feature, Point } from "geojson";
import { defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { layerColor } from "@/lib/render/palette";

export const GEOLOGY_TILE_URL = "https://tiles.macrostrat.org/carto/{z}/{x}/{y}.mvt";
export const GEOLOGY_SOURCE_LAYER = "units";
const IDENTIFY_URL = "https://macrostrat.org/api/v2/geologic_units/map";
const USER_AGENT = "WildMap/0.1 (open-source outdoor map agent)";
/** Geologic maps do not change from day to day. */
const TTL_SECONDS = 7 * 86_400;

/** Most detailed first. */
const SCALE_ORDER = ["large", "medium", "small", "tiny"];

const CLIP_DESCRIPTION = 400;
const CLIP_STRAT_NAME = 200;
const CLIP_OTHER = 80;

const inputSchema = z.object({
  /** Ask what rock lies under one place instead of drawing the map. */
  point: z
    .object({
      lon: z.number().min(-180).max(180),
      lat: z.number().min(-90).max(90),
    })
    .optional(),
});

const unitSchema = z.object({
  map_id: z.number().optional(),
  source_id: z.number().optional(),
  name: z.string().nullable().optional(),
  strat_name: z.string().nullable().optional(),
  lith: z.string().nullable().optional(),
  descrip: z.string().nullable().optional(),
  t_int_name: z.string().nullable().optional(),
  b_int_name: z.string().nullable().optional(),
  t_age: z.number().nullable().optional(),
  b_age: z.number().nullable().optional(),
  color: z.string().nullable().optional(),
  scale: z.string().nullable().optional(),
});

const identifySchema = z.object({
  success: z.object({
    data: z.array(unitSchema),
    refs: z.record(z.string(), z.string()).optional(),
  }),
});

type Unit = z.infer<typeof unitSchema>;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function scaleRank(unit: Unit): number {
  const i = SCALE_ORDER.indexOf(unit.scale ?? "");
  return i === -1 ? SCALE_ORDER.length : i;
}

/** "Pleistocene", or "Triassic to Cretaceous" (oldest to youngest) when the unit spans intervals. */
function ageText(unit: Unit): string | undefined {
  const young = unit.t_int_name?.trim();
  const old = unit.b_int_name?.trim();
  if (young && old) return young === old ? young : `${old} to ${young}`;
  return young || old || undefined;
}

/** One point feature for the most detailed unit, with the coarser maps summarised in `alsoMapped`. */
export function identifyFeature(
  lon: number,
  lat: number,
  units: Unit[],
  refs: Record<string, string> = {},
): Feature<Point> | null {
  if (units.length === 0) return null;
  const sorted = [...units].sort((a, b) => scaleRank(a) - scaleRank(b));
  const best = sorted[0];
  const properties: Record<string, string | number> = {
    name: best.name?.trim() || "Unnamed unit",
  };
  const age = ageText(best);
  if (age) properties.age = age;
  if (typeof best.t_age === "number") properties.ageTopMa = Math.round(best.t_age * 1000) / 1000;
  if (typeof best.b_age === "number") properties.ageBottomMa = Math.round(best.b_age * 1000) / 1000;
  const lith = best.lith?.trim();
  if (lith) properties.lithology = lith;
  const description = best.descrip?.trim();
  if (description) properties.description = clip(description, CLIP_DESCRIPTION);
  const formations = best.strat_name?.trim();
  if (formations) properties.formations = clip(formations, CLIP_STRAT_NAME);
  if (best.color) properties.color = best.color;
  if (best.scale) properties.mapScale = best.scale;
  const ref = best.source_id === undefined ? undefined : refs[String(best.source_id)];
  if (ref) properties.reference = clip(ref, 240);
  const others = sorted
    .slice(1)
    .filter((u) => u.name)
    .map((u) => `${u.scale ?? "other"} map: ${clip(u.name as string, CLIP_OTHER)}`);
  if (others.length > 0) properties.alsoMapped = others.join("; ");
  return { type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties };
}

const geology = defineLayer({
  id: "geology",
  title: "Geology",
  description:
    "Bedrock and surface geology: the rock units at the ground, from Macrostrat (a compilation of geologic maps; world coverage, most detailed in the United States). " +
    "Without input it draws the geologic map as vector tiles, each polygon coloured by its unit. " +
    "With input point {lon, lat} it instead answers 'what rock is this' for one place and returns a single point whose properties are name (the map unit), age (geologic period or epoch, for example Pleistocene or Triassic to Cretaceous), " +
    "ageTopMa and ageBottomMa (youngest and oldest age in millions of years), lithology (rock types, such as 'Major:{granodiorite}'), description, formations, color, mapScale (large is most detailed), alsoMapped (what coarser maps call the same spot) and reference (the source map). " +
    "Use the point form for 'what rock is this peak made of', 'how old is the ground here', 'is this granite or limestone', or 'geology of this place'; use the map form for 'show the geology', 'where is the volcanic rock', or 'rock types around here'. " +
    "Caveats: geologic maps are drawn at the scale of their source, so edges are generalised and small outcrops are missed; units can be loose ('undivided granitic rocks') and the age is the unit's range, not a date for any one rock; " +
    "colours follow each source map's own scheme, so the same colour in two regions can mean different rock; surface deposits like glacial till or alluvium can hide the bedrock below. " +
    "The map form returns tiles, not features you can count or list, and you cannot see the rendered map: say it is shown, do not claim which rock lies where. Works at any size of region.",
  coverage: "global",
  license: "CC BY 4.0 (Macrostrat; source maps by USGS and geological surveys)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("geology"), fillOpacity: 0.5 },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const citation = {
      source: "Macrostrat geologic map compilation (CC BY 4.0), University of Wisconsin-Madison",
      url: "https://macrostrat.org/",
      retrieved: new Date().toISOString(),
    };

    if (input.point === undefined) {
      return {
        kind: "tiles",
        data: {
          url: GEOLOGY_TILE_URL,
          minzoom: 0,
          maxzoom: 16,
          format: "vector",
          sourceLayer: GEOLOGY_SOURCE_LAYER,
          geometry: "polygon",
        },
        citation,
        coverageNote: "Geologic map units from Macrostrat; detail follows each source map's scale, so it is finest in the United States",
      };
    }

    const { lon, lat } = input.point;
    const url = `${IDENTIFY_URL}?lat=${lat}&lng=${lon}`;
    let res: Response;
    try {
      res = await ctx.fetch(url, {
        cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:identify:${lat},${lon}`,
        ttlSeconds: TTL_SECONDS,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        headers: { "user-agent": USER_AGENT },
      });
    } catch (err) {
      const timedOut = typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
      return {
        error: timedOut
          ? `Macrostrat timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds`
          : "Macrostrat returned no response",
        hint: "upstream",
      };
    }
    if (!res.ok) return { error: `Macrostrat returned ${res.status}`, hint: "upstream" };

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { error: "Macrostrat returned a response that is not JSON", hint: "upstream" };
    }
    const parsed = identifySchema.safeParse(json);
    if (!parsed.success) return { error: "Macrostrat returned an unexpected response", hint: "upstream" };

    const feature = identifyFeature(lon, lat, parsed.data.success.data, parsed.data.success.refs);
    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features: feature ? [feature] : [] },
      citation,
      ...(feature === null ? { coverageNote: "Macrostrat has no geologic map unit at this point" } : {}),
    };
  },
});

registerLayer(geology);

export default geology;
