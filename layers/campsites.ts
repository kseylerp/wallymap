/**
 * Campsites and parking lots from OpenStreetMap via one Overpass query:
 *   node/way["tourism"="camp_site"]                         (optionally ["backcountry"="yes"])
 *   node/way["tourism"="caravan_site"]                      (RV parks; left out with backcountryOnly)
 *   node/way["amenity"="parking"]["capacity"]               (only when includeParking)
 * Fixture: layers/__fixtures__/campsites.tahoe.json (Lake Tahoe west shore, recorded 2026-10-09 with
 * `out tags geom`). Tags read: name, backcountry, tents, caravans, fee (yes/no), capacity (integer), wikidata, wikipedia (passed through for the popularity layer).
 * Ways are reduced to the area centroid of their geometry (vertex average for open lines).
 * Wide (over 25,000 km², up to 1,500,000 km²): camp sites only, through the shared namedOverpassQuery (`out tags center`,
 * at most 2,000 named sites after an `out count` of every camp site and of the named ones); parking is left out at that scale.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import {
  defineLayer,
  type Attribute,
  type AttributeLevel,
  type BBox,
  type CardSpec,
  type FieldHelp,
  type LayerError,
  type LayerResult,
  type LegendSpec,
} from "./types";
import { registerLayer } from "./registry";
import { nameAttribute } from "./_shared/bands";
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

/** RV and caravan parks (OpenStreetMap tourism=caravan_site). */
const CARAVAN = '["tourism"="caravan_site"]';

/** Overpass QL for campsites (and optionally parking with a capacity). Overpass bbox order is (south,west,north,east). */
export function buildCampsitesQuery(
  bbox: BBox,
  input: Pick<CampsitesInput, "backcountryOnly" | "includeParking">,
): string {
  const [west, south, east, north] = bbox;
  const area = `(${south},${west},${north},${east})`;
  const camp = input.backcountryOnly ? '["tourism"="camp_site"]["backcountry"="yes"]' : '["tourism"="camp_site"]';
  const parts = [`node${camp}${area};`, `way${camp}${area};`];
  // RV and caravan parks are never backcountry.
  if (!input.backcountryOnly) parts.push(`node${CARAVAN}${area};`, `way${CARAVAN}${area};`);
  if (input.includeParking) {
    parts.push(`node["amenity"="parking"]["capacity"]${area};`, `way["amenity"="parking"]["capacity"]${area};`);
  }
  return `[out:json][timeout:25];(${parts.join("")});out tags geom;`;
}

/** Overpass QL for a wide box: named camp sites only (no parking), at most `limit`, after counts of all and of the named. */
export function buildWideCampsitesQuery(bbox: BBox, input: Pick<CampsitesInput, "backcountryOnly">, limit: number): string {
  const camp = input.backcountryOnly ? '["tourism"="camp_site"]["backcountry"="yes"]' : '["tourism"="camp_site"]';
  const selectors = input.backcountryOnly ? [`nwr${camp}`] : [`nwr${camp}`, `nwr${CARAVAN}`];
  return namedOverpassQuery({ selectors, bbox, geometry: "point", limit });
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
    const isCaravan = tags.tourism === "caravan_site";
    const isCamp = tags.tourism === "camp_site" || isCaravan;
    if (!isParking && !isCamp) continue;

    const capacity = wholeNumber(tags.capacity);
    // Parking is only drawn with a usable capacity, which is its v.
    if (isCamp === false && (capacity === undefined || capacity <= 0)) continue;

    const properties: Record<string, string | number | boolean> = {
      kind: isCaravan ? "caravan_site" : isCamp ? "camp_site" : "parking",
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
    properties.feeStatus = fee === undefined ? "unknown" : fee ? "fee" : "free";
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

/** Each kind as one thing, for card titles ("Camp site near Slickrock Trailhead"). */
const KIND_ONE: Record<string, string> = { camp_site: "Camp site", caravan_site: "RV or caravan site", parking: "Parking lot" };

const KIND_ORDER = ["camp_site", "caravan_site", "parking"];

/** Unnamed points within this distance of a named one are titled after it. */
export const NEAR_KM = 5;

/**
 * Ready for the map and the card: unnamed points get a heading from the nearest named point within NEAR_KM ("Camp site
 * near Big Bend Campground", else "Camp site"), also as `title`, which the top-10 rows read (they showed "Unnamed"; `name`
 * stays unset, since popularity counts a mapped name as a signal), and the points are listed named first, camp sites
 * before RV sites before parking, so the on-map labels name camps, not parking lots.
 */
export function presentCampsites(features: Feature<Point>[]): Feature<Point>[] {
  const named = features.filter((f) => typeof f.properties?.name === "string");
  const km = (a: Feature<Point>, b: Feature<Point>) => {
    const [x1, y1] = a.geometry.coordinates;
    const [x2, y2] = b.geometry.coordinates;
    return Math.hypot((x2 - x1) * 111.32 * Math.cos((y1 * Math.PI) / 180), (y2 - y1) * 110.57);
  };
  const out = features.map((f) => {
    if (typeof f.properties?.name === "string") return f;
    let best: { name: string; d: number } | null = null;
    for (const n of named) {
      const d = km(f, n);
      if (d <= NEAR_KM && (best === null || d < best.d)) best = { name: String(n.properties?.name), d };
    }
    const noun = KIND_ONE[String(f.properties?.kind)] ?? "Camp site";
    const heading = best ? `${noun} near ${best.name}` : noun;
    return { ...f, properties: { ...f.properties, heading, title: heading } };
  });
  const rank = (f: Feature) => (typeof f.properties?.name === "string" ? 0 : 3) + Math.max(0, KIND_ORDER.indexOf(String(f.properties?.kind)));
  return out
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f) - rank(b.f) || standing(a.f) - standing(b.f) || a.i - b.i)
    .map(({ f }) => f);
}

/** A pitch inside a campground ("Group Site A", "Site 12", "#4"), not a place to label on the map. */
const PITCH_NAME = /^(group\s+)?(camp\s*)?site\b|^site\s*#?\d|^#?\d+[a-z]?$|\bsite\s*#?\d+[a-z]?$/i;

/** Among named points of one kind: those with a website, operator, capacity or Wikidata first, single pitches last. */
function standing(f: Feature): number {
  const p = f.properties ?? {};
  if (PITCH_NAME.test(String(p.name ?? ""))) return 2;
  return p.website || p.operator || p.capacity || p.wikidata ? 0 : 1;
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
  feeStatus: {
    text: "Whether the site charges, from OpenStreetMap's fee tag; most sites have no fee tag, which says nothing either way, so check before you go.",
    source: "OpenStreetMap wiki, Key:fee",
    url: "https://wiki.openstreetmap.org/wiki/Key:fee",
  },
};

const YES_NO = { true: "Yes", false: "No" };

const KIND_LEVELS: AttributeLevel[] = [
  { value: "camp_site", label: "Camp sites", help: "Campgrounds and single pitches for tents; drawn as triangles." },
  { value: "caravan_site", label: "RV and caravan sites", help: "Sites for RVs, campervans and caravans; drawn as triangles." },
  { value: "parking", label: "Parking lots", help: "Car parks with a mapped number of spaces; drawn as squares, bigger for more spaces." },
];

const FEE_LEVELS: AttributeLevel[] = [
  { value: "free", label: "Free" },
  { value: "fee", label: "Fee" },
  { value: "unknown", label: "Fee not mapped", help: "OpenStreetMap has no fee tag for the site." },
];

const ATTRIBUTES: Attribute[] = [
  { key: "kind", type: "category", label: "Kind", primary: true, levels: KIND_LEVELS },
  { key: "feeStatus", type: "category", label: "Fee", levels: FEE_LEVELS, help: FIELD_HELP.feeStatus },
  { key: "backcountry", type: "flag", label: "Backcountry (walk-in)", help: FIELD_HELP.backcountry },
  { key: "tents", type: "flag", label: "Tents allowed" },
  { key: "caravans", type: "flag", label: "RVs allowed" },
  { key: "capacity", type: "measure", label: "Capacity", unit: "pitches or spaces", help: FIELD_HELP.capacity },
  nameAttribute(),
];

/** Camp and RV sites are triangles, parking lots squares (lib/render/wally/pins.ts); the key says so. */
const LEGEND: LegendSpec = {
  kind: "categories",
  title: "Kind",
  field: "kind",
  items: [
    { label: "Camp sites (triangles)", value: "camp_site", symbol: "point", help: KIND_LEVELS[0].help },
    { label: "RV and caravan sites (triangles)", value: "caravan_site", symbol: "point", help: KIND_LEVELS[1].help },
    { label: "Parking lots (squares)", value: "parking", symbol: "point", help: KIND_LEVELS[2].help },
  ],
};

/** The inspect card (coordinator, 2026-10-16: "Kind: camp site" read as a code): kinds in words, then what OSM knows. */
const CARD: CardSpec = {
  // Parking only: its v is the number of spaces.
  measure: { key: "v", label: "Parking spaces" },
  facts: [
    { key: "kind", label: "Type", values: KIND_ONE },
    { key: "capacity", label: "Capacity", format: "int" },
    { key: "feeStatus", label: "Fee", values: { fee: "Yes, costs money", free: "Free", unknown: "Fee not mapped" } },
    { key: "tents", label: "Tents allowed", values: YES_NO },
    { key: "caravans", label: "RVs allowed", values: YES_NO },
    { key: "backcountry", label: "Backcountry (walk-in)", values: YES_NO },
    { key: "reservation", label: "Booking", values: { yes: "Possible", required: "Required", recommended: "Recommended", no: "Not taken" } },
    { key: "toilets", label: "Toilets", values: YES_NO },
    { key: "drinkingWater", label: "Drinking water", values: YES_NO },
    { key: "operator", label: "Run by" },
  ],
  links: [{ key: "website", label: "Website" }],
  // The OpenStreetMap id is plumbing; the fee boolean is shown as feeStatus; title repeats the card's own title.
  hidden: ["osmId", "fee", "title"],
};

const campsites = defineLayer({
  id: "campsites",
  title: "Campsites and parking lots",
  description:
    "Campsites, RV parks and parking lots from OpenStreetMap, anywhere in the world. Each point has kind ('camp_site', 'caravan_site' for RV and caravan parks, or 'parking'), name when mapped (an unnamed point has title instead, its kind and the nearest named point within 5 km: 'Camp site near Big Bend Campground'), and the tags that are mapped: " +
    "backcountry (true for walk-in or wilderness sites), tents, caravans (true when tents or RVs are allowed), fee (true when it costs money), feeStatus ('free', 'fee', or 'unknown' when no fee is mapped, which is most sites) and capacity (spaces or pitches). " +
    "For parking, v is the number of spaces, so bigger lots draw bigger. Only parking lots with a stated capacity are included. " +
    "Use it to find places to camp or where to leave a car near a trail. " +
    "Set backcountryOnly to true to keep only camp sites tagged as backcountry (it drops RV parks and never hides parking); set includeParking to false to get camp and RV sites alone. " +
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
  attributes: ATTRIBUTES,
  time: { shape: "none" },
  legend: LEGEND,
  // The first named points, which presentCampsites puts camp sites first in: camps are labelled, parking lots rarely.
  labels: { field: "name", max: 6 },

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
        data: { type: "FeatureCollection", features: presentCampsites(normalizeCampsites(wide.json).features) },
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
    let features = all.features;
    if (total > MAX_POINTS) {
      const camps = all.features.filter((f) => f.properties?.kind !== "parking");
      const parking = all.features
        .filter((f) => f.properties?.kind === "parking")
        .sort((a, b) => capacityOf(b) - capacityOf(a));
      features = [...camps, ...parking].slice(0, MAX_POINTS);
    }

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features: presentCampsites(features) },
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
