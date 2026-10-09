import { z } from "zod";
import type { Feature, FeatureCollection, LineString } from "geojson";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { overpassQuery } from "./_shared/overpass";

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
/** Overpass stops after this many ways, so the upstream answer and its cache entry stay bounded too. */
export const OVERPASS_WAY_LIMIT = 2 * MAX_TRAILS;
const TRUNCATED_NOTE = `Showing ${MAX_TRAILS.toLocaleString("en-US")} trails, named ones first; zoom in for the rest`;

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

/** Overpass QL for trail-like ways in the bbox. Overpass bbox order is (south,west,north,east). */
export function buildOverpassQuery(
  bbox: BBox,
  input: Pick<OsmTrailsInput, "namedOnly">,
): string {
  const [west, south, east, north] = bbox;
  const name = input.namedOnly ? '["name"]' : "";
  return (
    `[out:json][timeout:25];` +
    `way["highway"~"^(path|footway|track)$"]${name}(${south},${west},${north},${east});` +
    `out geom ${OVERPASS_WAY_LIMIT};`
  );
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

/** Number of elements in an Overpass body (0 when it has none). */
function elementCount(json: unknown): number {
  const elements = typeof json === "object" && json !== null ? (json as { elements?: unknown }).elements : undefined;
  return Array.isArray(elements) ? elements.length : 0;
}

/** Keeps trails with no sac_scale, or one at or below `max` in difficulty order. */
function withinSacScale(feature: Feature, max: (typeof SAC_SCALES)[number]): boolean {
  const scale: unknown = feature.properties?.sac_scale;
  if (scale === undefined) return true;
  const index = SAC_SCALES.findIndex((s) => s === scale);
  return index !== -1 && index <= SAC_SCALES.indexOf(max);
}

const osmTrails = defineLayer({
  id: "osm-trails",
  title: "OpenStreetMap trails",
  description:
    "Hiking paths, footways and tracks from OpenStreetMap, with difficulty (sac_scale), visibility and surface tags where mapped, plus wikidata or wikipedia when the trail has an article.",
  coverage: "global",
  license: "ODbL (OpenStreetMap contributors)",
  requiredEnv: [],
  optionalEnv: ["OVERPASS_URL"],
  maxAreaKm2: 2500,
  input: inputSchema,
  style: { geometry: "line", color: "#2F3A44" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const area = bboxAreaKm2(ctx.bbox);
    if (area > osmTrails.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${osmTrails.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    const result = await overpassQuery(ctx, buildOverpassQuery(ctx.bbox, input));
    if (!result.ok) {
      return { error: result.error, hint: "upstream" };
    }

    const data = normalizeOverpass(result.json);
    const max = input.sacScaleMax;
    if (max !== undefined) {
      data.features = data.features.filter((f) => withinSacScale(f, max));
    }

    // Capped when Overpass stopped at its limit or more trails came back than are kept; named trails go first.
    const truncated = elementCount(result.json) >= OVERPASS_WAY_LIMIT || data.features.length > MAX_TRAILS;
    if (data.features.length > MAX_TRAILS) {
      const named = (f: Feature) => (f.properties?.name === undefined ? 1 : 0);
      data.features = [...data.features].sort((a, b) => named(a) - named(b)).slice(0, MAX_TRAILS);
    }

    return {
      kind: "geojson",
      data,
      ...(truncated ? { coverageNote: TRUNCATED_NOTE } : {}),
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
