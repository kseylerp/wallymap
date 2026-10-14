import { z } from "zod";
import type { BBox } from "@/layers/types";
import { featureBBoxes, findRegion, loadNaturalEarthRegions, regionDisplayName } from "./naturalEarth";
import { lookupRegion, type RegionMatch, type RegionSource } from "./regionNames";

const ENDPOINT = "https://api.mapbox.com/search/geocode/v6/forward";
const FALLBACK_HALF_SPAN_DEG = 0.1;
/** A Mapbox bbox narrower than this in both axes is a town or point, too small to be a named region such as a mountain range. */
const SMALL_BBOX_DEG = 0.5;

export type GeocodeResult = {
  bbox: BBox;
  center: [number, number];
  name: string;
  /**
   * Where the answer came from. Anything but "mapbox" is one of the app's own region sources, used because the name
   * describes a region (a basin, desert, range, national forest) or Mapbox only found a point or town of that name;
   * the bbox is then the region's own extent (see lib/agent/regionNames.ts), not a buffer around a point.
   */
  source: "mapbox" | RegionSource;
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
async function regionResult(place: string): Promise<RegionMatch | null> {
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
 * Names of mountain ranges and similar landforms ("Wind River Range", "Bighorn Mountains", "Sierra Nevada"). Mapbox's
 * place geocoder has no natural features, so for these it answers with a street or a town of the same name: "Wind River
 * Range" was a street in Jacksonville, Florida, and "Wind River Range, Wyoming" the town of Wind River.
 */
const RANGE_LIKE = /\b(?:range|ranges|mountains|mtns|sierra|cordillera|massif|hills|highlands|plateau|icefield|ice field|alps)\b/i;

export function isRangeLike(place: string): boolean {
  return RANGE_LIKE.test(place);
}

/** Place types asked of the place geocoder for a range-like name: areas and settlements, never streets or addresses. */
const RANGE_PLACE_TYPES = "region,district,place,locality";

/**
 * Half the side of the box put around a landform that Mapbox knows only as a point (its POI sits on the high point):
 * about 76 km across, so the core of a range like the Wind Rivers (its glaciers around Gannett Peak) fits under the
 * glacier layer's 8,000 km² cap.
 */
const LANDFORM_HALF_SPAN_KM = 38;

/** A box of LANDFORM_HALF_SPAN_KM around a point, square on the ground. */
function landformBBox([lng, lat]: [number, number]): BBox {
  const dLat = LANDFORM_HALF_SPAN_KM / 110.57;
  const dLng = LANDFORM_HALF_SPAN_KM / (111.32 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

/**
 * A range-like name as a Search Box point of interest of exactly that name (ignoring case, accents and "the"): a natural one (category mountain, peak, ...)
 * first, then one with no category (how Mapbox lists most ranges), never a business that only shares the name, and
 * then Mapbox's own order (which follows `proximity`). Null when none matches or the search fails.
 */
async function landformResult(place: string, proximity: [number, number] | undefined, token: string): Promise<GeocodeResult | null> {
  const name = place.split(",")[0];
  try {
    const found = await fetchCandidates(place, { proximity }, token, "poi");
    const ranked = found
      // Exactly the name, plurals included: "Bighorn Mountain" in Colorado is not the Bighorn Mountains.
      .filter((c) => c.type === "poi" && normalize(c.name) === normalize(name))
      .map((c) => ({ c, rank: isNaturalFeature(c) ? 0 : c.categories.length === 0 ? 1 : 2 }))
      .filter(({ rank }) => rank < 2)
      .sort((a, b) => a.rank - b.rank || a.c.order - b.c.order);
    const best = ranked[0]?.c;
    if (best === undefined) return null;
    return { bbox: landformBBox(best.center), center: best.center, name: best.label, source: "mapbox" };
  } catch {
    return null;
  }
}

/** How long one Mapbox lookup may take before it is abandoned, so a hung call cannot hold a chat step. */
const GEOCODE_TIMEOUT_MS = 15_000;

/** `text` with the token (raw or URL-encoded) replaced by "[token]". */
export function scrubToken(text: string, token: string): string {
  return text.split(token).join("[token]").split(encodeURIComponent(token)).join("[token]");
}

/** The first Natural Earth region among `names`, for lookupRegion. */
async function firstRegion(names: string[]): Promise<RegionMatch | null> {
  for (const name of names) {
    const found = await regionResult(name);
    if (found) return found;
  }
  return null;
}

/**
 * Forward-geocodes a place name with Mapbox Geocoding v6. Never throws. `proximity` ([lng, lat]) biases the
 * match toward that point, so "Emerald Bay" next to Tahoe City is not Laguna Beach's Emerald Bay.
 * A name that describes a region ("Colorado River basin", "Mojave Desert", "Bears Ears National Monument") is looked up
 * in the app's own region sources before Mapbox (lookupRegion), because Mapbox answers it with a town that shares a
 * word, such as the town of Basin, Colorado. The result's `source` says which one answered.
 * When Mapbox finds only a point or a town, a named physical region (Natural Earth) wins, and for a range-like name
 * (isRangeLike) so does a Search Box landform of that exact name, boxed to about 76 km; range-like names also never
 * resolve to streets.
 */
export async function geocode(
  place: string,
  opts: { proximity?: [number, number] } = {},
): Promise<GeocodeResult | GeocodeError> {
  const token = process.env.MAPBOX_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) {
    return { error: "MAPBOX_TOKEN is not set" };
  }

  const named = await lookupRegion(place, opts.proximity, { naturalEarth: firstRegion });
  if (named) return named;

  const url = new URL(ENDPOINT);
  url.searchParams.set("q", place);
  url.searchParams.set("limit", "1");
  const rangeLike = isRangeLike(place);
  if (rangeLike) url.searchParams.set("types", RANGE_PLACE_TYPES);
  if (opts.proximity) url.searchParams.set("proximity", `${opts.proximity[0]},${opts.proximity[1]}`);
  url.searchParams.set("access_token", token);

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS) });
    if (!res.ok) {
      return { error: `Geocoding failed with HTTP ${res.status}` };
    }
    const body = responseSchema.safeParse(await res.json());
    const feature = body.success && body.data.features.length > 0 ? featureSchema.safeParse(body.data.features[0]) : undefined;
    if (!feature?.success) {
      const landform = rangeLike ? await landformResult(place, opts.proximity, token) : null;
      return landform ?? { error: `No match for ${place}` };
    }

    const { name, full_address, bbox, coordinates } = feature.data.properties;
    const center: [number, number] = [coordinates.longitude, coordinates.latitude];

    // Mapbox answers "the Andes" or "Sierra Nevada" with a town or a point; a named physical region is better, and for
    // a range Natural Earth lacks ("Wind River Range"), a landform point of that name.
    if (bbox === undefined || isSmall(bbox)) {
      const region = (await regionResult(place)) ?? (rangeLike && place.includes(",") ? await regionResult(place.split(",")[0]) : null);
      if (region) return region;
      // A town of exactly that name (Beverly Hills) is what the user meant; a town that only shares part of it is not.
      const sameName = name !== undefined && normalize(name) === normalize(place.split(",")[0]);
      const landform = rangeLike && !sameName ? await landformResult(place, opts.proximity, token) : null;
      if (landform) return landform;
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
    // A network error can echo the request URL; never hand the token to the model or the chat.
    return { error: `Geocoding failed: ${scrubToken(String(err), token)}` };
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

async function fetchCandidates(query: string, opts: WaypointOptions, token: string, types = WAYPOINT_TYPES): Promise<Candidate[]> {
  const url = new URL(SEARCH_BOX_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(WAYPOINT_LIMIT));
  url.searchParams.set("types", types);
  if (opts.proximity) url.searchParams.set("proximity", `${opts.proximity[0]},${opts.proximity[1]}`);
  if (opts.bbox) url.searchParams.set("bbox", opts.bbox.join(","));
  url.searchParams.set("access_token", token);
  const res = await fetch(url, { signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS) });
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
