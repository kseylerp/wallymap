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

/** Ways in the box according to the `out count` elements, or null when the body has none. */
export function countedWays(json: unknown): number | null {
  const elements = typeof json === "object" && json !== null ? (json as { elements?: unknown }).elements : undefined;
  if (!Array.isArray(elements)) return null;
  let total: number | null = null;
  for (const el of elements) {
    if (typeof el !== "object" || el === null || (el as { type?: unknown }).type !== "count") continue;
    const ways = Number((el as { tags?: { ways?: unknown } }).tags?.ways);
    if (Number.isFinite(ways)) total = (total ?? 0) + ways;
  }
  return total;
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
