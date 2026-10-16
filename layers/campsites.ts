/**
 * Campsites and parking lots from OpenStreetMap via one Overpass query:
 *   node/way["tourism"="camp_site"]                         (optionally ["backcountry"="yes"])
 *   node/way["amenity"="parking"]["capacity"]               (only when includeParking)
 * Fixture: layers/__fixtures__/campsites.tahoe.json (Lake Tahoe west shore, recorded 2026-10-09 with
 * `out tags geom`). Tags read: name, backcountry, tents, caravans, fee (yes/no), capacity (integer), wikidata, wikipedia (passed through for the popularity layer).
 * Ways are reduced to the area centroid of their geometry (vertex average for open lines).
 * Wide (over 25,000 km², up to 1,500,000 km²): camp sites only, through the shared namedOverpassQuery (`out tags center`,
 * at most 2,000 named sites after an `out count` of every camp site and of the named ones); parking is left out at that scale.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { defineLayer, type BBox, type CardSpec, type FieldHelp, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { namedOverpassQuery, overpassCounts, overpassQuery } from "./_shared/overpass";
import { layerColor } from "@/lib/render/palette";

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

/** A way or relation from `out tags center` (the wide query): Overpass's own centre instead of the geometry. */
const centeredSchema = z.object({
  type: z.enum(["way", "relation"]),
  id: z.number(),
  center: z.object({ lat: z.number(), lon: z.number() }),
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

/** Overpass QL for a wide box: named camp sites only (no parking), at most `limit`, after counts of all and of the named. */
export function buildWideCampsitesQuery(bbox: BBox, input: Pick<CampsitesInput, "backcountryOnly">, limit: number): string {
  const camp = input.backcountryOnly ? '["tourism"="camp_site"]["backcountry"="yes"]' : '["tourism"="camp_site"]';
  return namedOverpassQuery({ selectors: [`nwr${camp}`], bbox, geometry: "point", limit });
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
    // Work relative to the first vertex: raw lon/lat products lose most of their precision on small rings.
    let twiceArea = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const ax = points[i].lon - first.lon;
      const ay = points[i].lat - first.lat;
      const bx = points[i + 1].lon - first.lon;
      const by = points[i + 1].lat - first.lat;
      const cross = ax * by - bx * ay;
      twiceArea += cross;
      cx += (ax + bx) * cross;
      cy += (ay + by) * cross;
    }
    if (Math.abs(twiceArea) > 1e-18) {
      return [first.lon + cx / (3 * twiceArea), first.lat + cy / (3 * twiceArea)];
    }
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

/**
 * Converts an Overpass `out tags geom` (or, for the wide query, `out tags center`) response into point features,
 * skipping anything without a usable position.
 */
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
      const centered = way.success ? null : centeredSchema.safeParse(raw);
      if (way.success) {
        center = wayCentroid(way.data.geometry);
        osmId = `way/${way.data.id}`;
        tags = way.data.tags ?? {};
      } else if (centered?.success) {
        center = [centered.data.center.lon, centered.data.center.lat];
        osmId = `${centered.data.type}/${centered.data.id}`;
        tags = centered.data.tags ?? {};
      } else {
        continue;
      }
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
    if (tags.wikidata) properties.wikidata = tags.wikidata;
    if (tags.wikipedia) properties.wikipedia = tags.wikipedia;
    const website = tags.website ?? tags["contact:website"] ?? tags.url;
    if (website && /^https?:\/\//.test(website)) properties.website = website;
    if (tags.operator) properties.operator = tags.operator;
    const reservation = tags.reservation;
    if (reservation) properties.reservation = reservation;
    if (tags.toilets) properties.toilets = yesNo(tags.toilets) ?? tags.toilets;
    if (tags.drinking_water) properties.drinkingWater = yesNo(tags.drinking_water) ?? tags.drinking_water;
    if (!isCamp && capacity !== undefined) properties.v = capacity;

    features.push({ type: "Feature", geometry: { type: "Point", coordinates: center }, properties });
  }
  return { type: "FeatureCollection", features };
}

function capacityOf(feature: Feature): number {
  const v: unknown = feature.properties?.v;
  return typeof v === "number" ? v : 0;
}

/** What the card's facts mean (spec §12b), in OpenStreetMap's terms. */
const FIELD_HELP: Record<string, FieldHelp> = {
  capacity: { text: "How many pitches (camp sites) or spaces (parking) the mapper counted, from OpenStreetMap's capacity tag.", source: "OpenStreetMap wiki, Key:capacity", url: "https://wiki.openstreetmap.org/wiki/Key:capacity" },
  backcountry: { text: "A walk-in or wilderness site with no road to it, from OpenStreetMap's backcountry tag.", source: "OpenStreetMap wiki, Key:backcountry", url: "https://wiki.openstreetmap.org/wiki/Key:backcountry" },
  reservation: { text: "Whether pitches can or must be booked ahead, from OpenStreetMap's reservation tag.", source: "OpenStreetMap wiki, Key:reservation", url: "https://wiki.openstreetmap.org/wiki/Key:reservation" },
};

const YES_NO = { true: "Yes", false: "No" };

/** The inspect card (coordinator, 2026-10-16: "Kind: camp site" read as a code): kinds in words, then what OSM knows. */
const CARD: CardSpec = {
  facts: [
    { key: "kind", label: "Type", values: { camp_site: "Campsite", parking: "Parking" } },
    { key: "capacity", label: "Capacity", format: "int" },
    { key: "fee", label: "Fee", values: { true: "Yes, costs money", false: "Free" } },
    { key: "tents", label: "Tents allowed", values: YES_NO },
    { key: "caravans", label: "RVs allowed", values: YES_NO },
    { key: "backcountry", label: "Backcountry (walk-in)", values: YES_NO },
    { key: "reservation", label: "Booking", values: { yes: "Possible", required: "Required", recommended: "Recommended", no: "Not taken" } },
    { key: "toilets", label: "Toilets", values: YES_NO },
    { key: "drinkingWater", label: "Drinking water", values: YES_NO },
    { key: "operator", label: "Run by" },
  ],
  links: [{ key: "website", label: "Website" }],
};

const campsites = defineLayer({
  id: "campsites",
  title: "Campsites and parking lots",
  description:
    "Campsites and parking lots from OpenStreetMap, anywhere in the world. Each point has kind ('camp_site' or 'parking'), name when mapped, and the tags that are mapped: " +
    "backcountry (true for walk-in or wilderness sites), tents, caravans (true when tents or RVs are allowed), fee (true when it costs money) and capacity (spaces or pitches). " +
    "For parking, v is the number of spaces, so bigger lots draw bigger. Only parking lots with a stated capacity are included. " +
    "Use it to find places to camp or where to leave a car near a trail. " +
    "Set backcountryOnly to true to keep only camp sites tagged as backcountry (it never hides parking); set includeParking to false to get camp sites alone. " +
    "Caveats: OpenStreetMap is volunteer-mapped, so it misses many sites and is not a reservation or availability source; fees, seasons and rules may be out of date or missing; " +
    "free dispersed camping spots are mostly not mapped here (see forest-roads for the drivable Forest Service roads). " +
    "Over 25,000 km² (about a 160 km square) it returns up to 2,000 named camp sites (no parking) and how many there are in all. At most 5,000 points are returned (all camp sites first, then the largest parking lots) and the result says so when it trims.",
  coverage: "global",
  surface: "land",
  license: "ODbL (OpenStreetMap contributors)",
  requiredEnv: [],
  optionalEnv: ["OVERPASS_URL"],
  maxAreaKm2: 25_000,
  // A named-only Overpass listing with counts stays bounded over a whole US state or a small country.
  hardMaxAreaKm2: 1_500_000,
  wide: { mode: "named", limit: 2000 },
  input: inputSchema,
  style: { geometry: "point", color: layerColor("campsites") },
  fieldHelp: FIELD_HELP,
  card: CARD,

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const citation = {
      source: "OpenStreetMap contributors (ODbL)",
      url: "https://www.openstreetmap.org/copyright",
      retrieved: new Date().toISOString(),
    };

    // Wide: named camp sites only, bounded by the strategy's limit; the first count (every camp site) is the total.
    if (ctx.wide) {
      const limit = ctx.wideStrategy?.limit ?? 2000;
      const wide = await overpassQuery(ctx, buildWideCampsitesQuery(ctx.bbox, input, limit), { cacheSuffix: "campsites:named" });
      if (!wide.ok) return { error: wide.error, hint: "upstream" };
      const [all] = overpassCounts(wide.json);
      return {
        kind: "geojson",
        data: normalizeCampsites(wide.json),
        citation,
        ...(all !== undefined && { total: all }),
        ...(input.includeParking ? { coverageNote: "Parking lots are left out at this scale" } : {}),
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
      citation,
    };
  },
});

registerLayer(campsites);

export default campsites;
