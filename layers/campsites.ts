/**
 * Campsites and parking lots from OpenStreetMap via one Overpass query:
 *   node/way["tourism"="camp_site"]                         (optionally ["backcountry"="yes"])
 *   node/way["amenity"="parking"]["capacity"]               (only when includeParking)
 * Fixture: layers/__fixtures__/campsites.tahoe.json (Lake Tahoe west shore, recorded 2026-10-09 with
 * `out tags geom`). Tags read: name, backcountry, tents, caravans, fee (yes/no), capacity (integer).
 * Ways are reduced to the area centroid of their geometry (vertex average for open lines).
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { overpassQuery } from "./_shared/overpass";

const inputSchema = z.object({
  backcountryOnly: z.boolean().default(false),
  includeParking: z.boolean().default(true),
});

type CampsitesInput = z.infer<typeof inputSchema>;

/** Most points returned; keeps every campsite and fills the rest with the largest parking lots. */
const MAX_POINTS = 5_000;

type LatLon = { lat: number; lon: number };

const tagsSchema = z.record(z.string(), z.string());

const nodeSchema = z.object({
  type: z.literal("node"),
  id: z.number(),
  lat: z.number(),
  lon: z.number(),
  tags: tagsSchema.optional(),
});

const waySchema = z.object({
  type: z.literal("way"),
  id: z.number(),
  geometry: z.array(z.object({ lat: z.number(), lon: z.number() })),
  tags: tagsSchema.optional(),
});

const responseSchema = z.object({ elements: z.array(z.unknown()) });

/** Overpass QL for campsites (and optionally parking with a capacity). Overpass bbox order is (south,west,north,east). */
export function buildCampsitesQuery(
  bbox: BBox,
  input: Pick<CampsitesInput, "backcountryOnly" | "includeParking">,
): string {
  const [west, south, east, north] = bbox;
  const area = `(${south},${west},${north},${east})`;
  const camp = input.backcountryOnly ? '["tourism"="camp_site"]["backcountry"="yes"]' : '["tourism"="camp_site"]';
  const parts = [`node${camp}${area};`, `way${camp}${area};`];
  if (input.includeParking) {
    parts.push(`node["amenity"="parking"]["capacity"]${area};`, `way["amenity"="parking"]["capacity"]${area};`);
  }
  return `[out:json][timeout:25];(${parts.join("")});out tags geom;`;
}

/**
 * Centre of a way as [lon, lat]: the area centroid of a closed ring, otherwise (open line or a
 * ring with no area) the average of its vertices. Null for an empty geometry.
 */
export function wayCentroid(points: LatLon[]): [number, number] | null {
  if (points.length === 0) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const closed = points.length >= 4 && first.lat === last.lat && first.lon === last.lon;

  if (closed) {
    let twiceArea = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const cross = a.lon * b.lat - b.lon * a.lat;
      twiceArea += cross;
      cx += (a.lon + b.lon) * cross;
      cy += (a.lat + b.lat) * cross;
    }
    if (Math.abs(twiceArea) > 1e-18) return [cx / (3 * twiceArea), cy / (3 * twiceArea)];
  }

  const sumLon = points.reduce((s, p) => s + p.lon, 0);
  const sumLat = points.reduce((s, p) => s + p.lat, 0);
  return [sumLon / points.length, sumLat / points.length];
}

function yesNo(value: string | undefined): boolean | undefined {
  if (value === "yes") return true;
  if (value === "no") return false;
  return undefined;
}

/** A plain whole number ("62"), not a range or free text. */
function wholeNumber(value: string | undefined): number | undefined {
  if (value === undefined || !/^\s*\d{1,6}\s*$/.test(value)) return undefined;
  return Number(value);
}

/** Converts an Overpass `out tags geom` response into point features, skipping anything without a usable position. */
export function normalizeCampsites(json: unknown): FeatureCollection<Point> {
  const features: Feature<Point>[] = [];
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) return { type: "FeatureCollection", features };

  for (const raw of parsed.data.elements) {
    let center: [number, number] | null = null;
    let osmId = "";
    let tags: Record<string, string> = {};

    const node = nodeSchema.safeParse(raw);
    if (node.success) {
      center = [node.data.lon, node.data.lat];
      osmId = `node/${node.data.id}`;
      tags = node.data.tags ?? {};
    } else {
      const way = waySchema.safeParse(raw);
      if (!way.success) continue;
      center = wayCentroid(way.data.geometry);
      osmId = `way/${way.data.id}`;
      tags = way.data.tags ?? {};
    }
    if (center === null) continue;

    const isParking = tags.amenity === "parking";
    const isCamp = tags.tourism === "camp_site";
    if (!isParking && !isCamp) continue;

    const capacity = wholeNumber(tags.capacity);
    // Parking is only drawn with a usable capacity, which is its v.
    if (isCamp === false && (capacity === undefined || capacity <= 0)) continue;

    const properties: Record<string, string | number | boolean> = {
      kind: isCamp ? "camp_site" : "parking",
      osmId,
    };
    if (tags.name) properties.name = tags.name;
    const backcountry = yesNo(tags.backcountry);
    if (backcountry !== undefined) properties.backcountry = backcountry;
    const tents = yesNo(tags.tents);
    if (tents !== undefined) properties.tents = tents;
    const caravans = yesNo(tags.caravans);
    if (caravans !== undefined) properties.caravans = caravans;
    const fee = yesNo(tags.fee);
    if (fee !== undefined) properties.fee = fee;
    if (capacity !== undefined && capacity > 0) properties.capacity = capacity;
    if (!isCamp && capacity !== undefined) properties.v = capacity;

    features.push({ type: "Feature", geometry: { type: "Point", coordinates: center }, properties });
  }
  return { type: "FeatureCollection", features };
}

function capacityOf(feature: Feature): number {
  const v: unknown = feature.properties?.v;
  return typeof v === "number" ? v : 0;
}

const campsites = defineLayer({
  id: "campsites",
  title: "Campsites and trailhead parking",
  description:
    "Campsites and parking lots from OpenStreetMap, anywhere in the world. Each point has kind ('camp_site' or 'parking'), name when mapped, and the tags that are mapped: " +
    "backcountry (true for walk-in or wilderness sites), tents, caravans (true when tents or RVs are allowed), fee (true when it costs money) and capacity (spaces or pitches). " +
    "For parking, v is the number of spaces, so bigger lots draw bigger. Only parking lots with a stated capacity are included. " +
    "Use it to find places to camp or where to leave a car near a trail. " +
    "Set backcountryOnly to true to keep only camp sites tagged as backcountry (it never hides parking); set includeParking to false to get camp sites alone. " +
    "Caveats: OpenStreetMap is volunteer-mapped, so it misses many sites and is not a reservation or availability source; fees, seasons and rules may be out of date or missing; " +
    "free dispersed camping spots are mostly not mapped here (see mvum-dispersed for the roads), and parking is any lot with a capacity, not only trailhead lots. " +
    "Zoom in to a region under 10,000 km² (about a 100 km square) first. At most 5,000 points are returned (all camp sites first, then the largest parking lots) and the result says so when it trims.",
  coverage: "global",
  license: "ODbL (OpenStreetMap contributors)",
  requiredEnv: [],
  optionalEnv: ["OVERPASS_URL"],
  maxAreaKm2: 10_000,
  input: inputSchema,
  style: { geometry: "point", color: "#6B8F5E" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const area = bboxAreaKm2(ctx.bbox);
    if (area > campsites.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${campsites.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    const result = await overpassQuery(ctx, buildCampsitesQuery(ctx.bbox, input), {
      cacheSuffix: "campsites",
    });
    if (!result.ok) return { error: result.error, hint: "upstream" };

    const all = normalizeCampsites(result.json);
    const total = all.features.length;
    let data: FeatureCollection = all;
    if (total > MAX_POINTS) {
      const camps = all.features.filter((f) => f.properties?.kind === "camp_site");
      const parking = all.features
        .filter((f) => f.properties?.kind !== "camp_site")
        .sort((a, b) => capacityOf(b) - capacityOf(a));
      data = {
        type: "FeatureCollection",
        features: [...camps, ...parking].slice(0, MAX_POINTS),
      };
    }

    return {
      kind: "geojson",
      data,
      ...(total > MAX_POINTS
        ? {
            coverageNote: `Showing ${MAX_POINTS.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} sites (all camp sites, then the largest parking lots); zoom in for the rest`,
          }
        : {}),
      citation: {
        source: "OpenStreetMap contributors (ODbL)",
        url: "https://www.openstreetmap.org/copyright",
        retrieved: new Date().toISOString(),
      },
    };
  },
});

registerLayer(campsites);

export default campsites;
