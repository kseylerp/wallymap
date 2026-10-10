import { z } from "zod";
import type { BBox } from "@/layers/types";
import { featureBBoxes, findRegion, loadNaturalEarthRegions, regionDisplayName } from "./naturalEarth";

const ENDPOINT = "https://api.mapbox.com/search/geocode/v6/forward";
const FALLBACK_HALF_SPAN_DEG = 0.1;
/** A Mapbox bbox narrower than this in both axes is a town or point, too small to be a named region such as a mountain range. */
const SMALL_BBOX_DEG = 0.5;

export type GeocodeResult = {
  bbox: BBox;
  center: [number, number];
  name: string;
  /** "natural-earth" when the place is a physical region (range, desert, ...) and Mapbox only found a point or town. */
  source: "mapbox" | "natural-earth";
};
export type GeocodeError = { error: string };

const featureSchema = z.object({
  properties: z.object({
    name: z.string().optional(),
    full_address: z.string().optional(),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    coordinates: z.object({ longitude: z.number(), latitude: z.number() }),
  }),
});

const responseSchema = z.object({ features: z.array(z.unknown()) });

/** How long a failed Natural Earth download is remembered, so lookups during an outage do not each wait out the timeout. */
const REGIONS_RETRY_AFTER_MS = 60_000;
let failedAt: number | undefined;

function isSmall(bbox: BBox): boolean {
  return bbox[2] - bbox[0] < SMALL_BBOX_DEG && bbox[3] - bbox[1] < SMALL_BBOX_DEG;
}

/** The Natural Earth region named `place`, as a geocode result, or null when there is none or the download fails. */
async function regionResult(place: string): Promise<GeocodeResult | null> {
  if (failedAt !== undefined && Date.now() - failedAt < REGIONS_RETRY_AFTER_MS) return null;
  try {
    const fc = await loadNaturalEarthRegions();
    const region = findRegion(place, fc);
    if (!region) return null;
    const bbox = featureBBoxes(fc)[fc.features.indexOf(region)];
    if (!bbox || !bbox.every(Number.isFinite)) return null;
    return {
      bbox,
      center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
      name: regionDisplayName(region),
      source: "natural-earth",
    };
  } catch {
    failedAt = Date.now();
    return null;
  }
}

/**
 * Forward-geocodes a place name with Mapbox Geocoding v6. Never throws. `proximity` ([lng, lat]) biases the
 * match toward that point, so "Emerald Bay" next to Tahoe City is not Laguna Beach's Emerald Bay.
 */
export async function geocode(
  place: string,
  opts: { proximity?: [number, number] } = {},
): Promise<GeocodeResult | GeocodeError> {
  const token = process.env.MAPBOX_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) {
    return { error: "MAPBOX_TOKEN is not set" };
  }

  const url = new URL(ENDPOINT);
  url.searchParams.set("q", place);
  url.searchParams.set("limit", "1");
  if (opts.proximity) url.searchParams.set("proximity", `${opts.proximity[0]},${opts.proximity[1]}`);
  url.searchParams.set("access_token", token);

  try {
    const res = await fetch(url);
    if (!res.ok) {
      return { error: `Geocoding failed with HTTP ${res.status}` };
    }
    const body = responseSchema.safeParse(await res.json());
    if (!body.success || body.data.features.length === 0) {
      return { error: `No match for ${place}` };
    }
    const feature = featureSchema.safeParse(body.data.features[0]);
    if (!feature.success) {
      return { error: `No match for ${place}` };
    }

    const { name, full_address, bbox, coordinates } = feature.data.properties;
    const center: [number, number] = [coordinates.longitude, coordinates.latitude];

    // Mapbox answers "the Andes" or "Sierra Nevada" with a town or a point; a named physical region is better.
    if (bbox === undefined || isSmall(bbox)) {
      const region = await regionResult(place);
      if (region) return region;
    }

    return {
      bbox: bbox ?? [
        center[0] - FALLBACK_HALF_SPAN_DEG,
        center[1] - FALLBACK_HALF_SPAN_DEG,
        center[0] + FALLBACK_HALF_SPAN_DEG,
        center[1] + FALLBACK_HALF_SPAN_DEG,
      ],
      center,
      name: full_address ?? name ?? place,
      source: "mapbox",
    };
  } catch (err) {
    return { error: `Geocoding failed: ${String(err)}` };
  }
}

const SEARCH_BOX_ENDPOINT = "https://api.mapbox.com/search/searchbox/v1/forward";
/**
 * The Geocoding v6 API has no point-of-interest type, so waypoints go through Search Box, which finds waterfalls,
 * trailheads and peaks as well as towns and addresses.
 */
const WAYPOINT_TYPES = "poi,place,locality,neighborhood,street,address";
const WAYPOINT_LIMIT = 8;
const POI_HALF_SPAN_DEG = 0.01;
/** A candidate this far from the bias point is "far": a nearby match of any kind beats it. */
const NEAR_KM = 200;

export type WaypointOptions = {
  /** [lng, lat] to bias toward: the view centre for a first waypoint, the previous resolved waypoint after that. */
  proximity?: [number, number];
  /** Only matches inside this box; the route tool passes the view at zoom 8 and closer, or a tight box on a retry. */
  bbox?: BBox;
  /** A trail, not a stop: "Mist Trail" also matches "Mist Trailhead", so a nearby partial name beats a far exact one. */
  trail?: boolean;
};

const candidateSchema = z.object({
  properties: z.object({
    name: z.string().optional(),
    feature_type: z.string().optional(),
    full_address: z.string().optional(),
    place_formatted: z.string().optional(),
    coordinates: z.object({ longitude: z.number(), latitude: z.number() }),
    poi_category: z.array(z.string()).optional(),
  }),
});

type Candidate = {
  name: string;
  label: string;
  type: string;
  categories: string[];
  center: [number, number];
  order: number;
};

/** Great-circle distance in km. */
export function distanceKm(a: readonly number[], b: readonly number[]): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLng = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 12_742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const normalize = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|of)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** 2 when the names are the same (ignoring "the" and plurals like Falls/Fall), 1 when one holds the other, else 0. */
function nameMatch(query: string, name: string): 0 | 1 | 2 {
  const singular = (text: string) => text.replace(/\b(\w{3,})s\b/g, "$1");
  const q = singular(normalize(query.split(",")[0]));
  const n = singular(normalize(name));
  if (!q || !n) return 0;
  if (q === n) return 2;
  return n.includes(q) || q.includes(n) ? 1 : 0;
}

const NATURAL_CATEGORY =
  /\b(outdoors|waterfalls?|trails?|trailheads?|peaks?|mountains?|summits?|viewpoints?|scenic|park|lake|beach|island|campground|camping|hot spring|river|glacier|canyon|valley|cave|forest|nature reserve|ridge|tourist attraction|natural)\b/;

/** A waterfall, trailhead, peak and the like: the kind of place a hiking route names. */
function isNaturalFeature(c: Candidate): boolean {
  return c.type === "poi" && c.categories.some((category) => NATURAL_CATEGORY.test(category));
}

/** Lower is better: town or natural POI first, then other POIs, then streets and addresses. */
function kindRank(c: Candidate): number {
  if (isNaturalFeature(c)) return 0;
  if (c.type === "place" || c.type === "locality") return 1;
  if (c.type === "poi") return 2;
  if (c.type === "neighborhood") return 3;
  return 4;
}

/**
 * The best candidate for `query`: a name that matches beats one that does not (for a trail, a partial match is as good as an exact one); a candidate within 200 km of the bias
 * point beats a far one; then natural features (waterfalls, trailheads, peaks) beat towns beat other POIs beat
 * streets, and finally the closest to the bias point, then Mapbox's own order.
 */
function rankCandidates(
  candidates: Candidate[],
  query: string,
  proximity?: [number, number],
  trail = false,
): Candidate[] {
  const scored = candidates.map((c) => {
    const km = proximity ? distanceKm(proximity, c.center) : 0;
    const match = nameMatch(query, c.name);
    // A trail is rarely one POI's exact name, so any match counts the same and the streets of that name rank last.
    return { c, match: trail && match > 0 ? 1 : match, far: km > NEAR_KM ? 1 : 0, rank: kindRank(c), km };
  });
  scored.sort((a, b) => b.match - a.match || a.far - b.far || a.rank - b.rank || a.km - b.km || a.c.order - b.c.order);
  return scored.map((s) => s.c);
}

function label(name: string, type: string | undefined, where: string | undefined): string {
  if (!where || where.toLowerCase().startsWith(name.toLowerCase())) return where ?? name;
  return type === "address" ? where : `${name}, ${where}`;
}

async function fetchCandidates(query: string, opts: WaypointOptions, token: string): Promise<Candidate[]> {
  const url = new URL(SEARCH_BOX_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(WAYPOINT_LIMIT));
  url.searchParams.set("types", WAYPOINT_TYPES);
  if (opts.proximity) url.searchParams.set("proximity", `${opts.proximity[0]},${opts.proximity[1]}`);
  if (opts.bbox) url.searchParams.set("bbox", opts.bbox.join(","));
  url.searchParams.set("access_token", token);
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = responseSchema.parse(await res.json());
  const out: Candidate[] = [];
  body.features.forEach((raw, order) => {
    const parsed = candidateSchema.safeParse(raw);
    if (!parsed.success) return;
    const p = parsed.data.properties;
    const name = p.name ?? query;
    out.push({
      name,
      // A POI's full_address is just where it is ("Yosemite National Park, ..."), so lead with its name.
      label: label(name, p.feature_type, p.full_address ?? p.place_formatted),
      type: p.feature_type ?? "",
      categories: (p.poi_category ?? []).map((category) => category.toLowerCase()),
      center: [p.coordinates.longitude, p.coordinates.latitude],
      order,
    });
  });
  return out;
}

/**
 * Geocodes one route waypoint. Searches points of interest as well as places, biased by `proximity` and limited to
 * `bbox` when given, then ranks the matches (see `rankCandidates`). Falls back to the plain place geocoder when the
 * POI search finds nothing. Never throws.
 */
export async function geocodeWaypoint(
  place: string,
  opts: WaypointOptions = {},
): Promise<GeocodeResult | GeocodeError> {
  const token = process.env.MAPBOX_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) return { error: "MAPBOX_TOKEN is not set" };
  try {
    let found = await fetchCandidates(place, opts, token);
    // A box that holds nothing (or the whole qualified name, "Emerald Bay, Lake Tahoe") is not a reason to give up.
    if (found.length === 0 && opts.bbox) found = await fetchCandidates(place, { proximity: opts.proximity }, token);
    const best = rankCandidates(found, place, opts.proximity, opts.trail)[0];
    if (best && nameMatch(place, best.name) > 0) {
      const [lng, lat] = best.center;
      return {
        bbox: [lng - POI_HALF_SPAN_DEG, lat - POI_HALF_SPAN_DEG, lng + POI_HALF_SPAN_DEG, lat + POI_HALF_SPAN_DEG],
        center: best.center,
        name: best.label,
        source: "mapbox",
      };
    }
  } catch {
    // Fall through to the place geocoder; a Search Box outage should not stop a route between two towns.
  }
  return geocode(place, { proximity: opts.proximity });
}
