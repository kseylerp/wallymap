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
    `out geom;`
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

    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: geometry.map((p) => [p.lon, p.lat]) },
      properties,
    });
  }
  return { type: "FeatureCollection", features };
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
    "Hiking paths, footways and tracks from OpenStreetMap, with difficulty (sac_scale), visibility and surface tags where mapped.",
  coverage: "global",
  license: "ODbL (OpenStreetMap contributors)",
  requiredEnv: [],
  optionalEnv: ["OVERPASS_URL"],
  maxAreaKm2: 2500,
  input: inputSchema,
  style: { geometry: "line", color: "#D97757" },

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

    return {
      kind: "geojson",
      data,
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
