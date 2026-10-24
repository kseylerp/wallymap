import { z } from "zod";
import type { BBox } from "@/layers/types";
import { famousPlace, featureLookup, isFeatureName } from "./featurePlaces";
import { featureBBoxes, findRegion, loadNaturalEarthRegions, regionDisplayName } from "./naturalEarth";
import { lookupRegion, wikidataFeature, worldRegion, type RegionMatch, type RegionSource } from "./regionNames";

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
    feature_type: z.string().optional(),
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

const US_STATES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho",
  "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota",
  "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina",
  "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas",
  "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming",
];

/** Short names people give ranges that cross state lines, and the range's own name. */
const RANGE_ALIASES: Record<string, string> = {
  rockies: "Rocky Mountains",
  "rocky mountains": "Rocky Mountains",
  cascades: "Cascade Range",
  "cascade range": "Cascade Range",
  "cascade mountains": "Cascade Range",
  appalachians: "Appalachian Mountains",
  "appalachian mountains": "Appalachian Mountains",
  sierra: "Sierra Nevada",
  "sierra nevada": "Sierra Nevada",
  "great basin": "Great Basin",
  "mojave desert": "Mojave Desert",
  "sonoran desert": "Sonoran Desert",
};

/**
 * A state's part of a range ("Colorado Rockies", "the Montana Rockies", "Rocky Mountains, Colorado"): the state and the
 * range, or null. The place geocoder answers "Colorado Rockies" with Colorado Avenue in Seibert, Colorado.
 */
export function stateRange(place: string): { state: string; range: string } | null {
  const text = place.trim().replace(/^the\s+/i, "");
  const state = US_STATES.find((st) => new RegExp(`^${st}(?:'s)?\\s+(?:part\\s+of\\s+)?(?:the\\s+)?`, "i").test(text));
  if (state) {
    const rest = text.replace(new RegExp(`^${state}(?:'s)?\\s+(?:part\\s+of\\s+)?(?:the\\s+)?`, "i"), "").trim().toLowerCase();
    const range = RANGE_ALIASES[rest];
    if (range) return { state, range };
  }
  const [first, ...rest] = text.split(",").map((t) => t.trim());
  const range = RANGE_ALIASES[first.replace(/^the\s+/i, "").toLowerCase()];
  const named = US_STATES.find((st) => st.toLowerCase() === rest.join(", ").toLowerCase());
  return range && named ? { state: named, range } : null;
}

/** Place types asked of the place geocoder for a range-like name: areas and settlements, never streets or addresses. */
const RANGE_PLACE_TYPES = "region,district,place,locality";

/**
 * Half the side of the box put around a landform that Mapbox knows only as a point (its POI sits on the high point):
 * about 76 km across, so the core of a range like the Wind Rivers (its glaciers around Gannett Peak) fits under the
 * glacier layer's 8,000 km² cap.
 */
const LANDFORM_HALF_SPAN_KM = 38;

/**
 * Half the side of the box put around a single named feature (a rock, a peak, a lake) found as a point of interest:
 * about 10 km across, the feature and its surroundings.
 */
const FEATURE_HALF_SPAN_KM = 5;

/** A box of `halfSpanKm` (LANDFORM_HALF_SPAN_KM by default) around a point, square on the ground. */
function landformBBox([lng, lat]: [number, number], halfSpanKm: number = LANDFORM_HALF_SPAN_KM): BBox {
  const dLat = halfSpanKm / 110.57;
  const dLng = halfSpanKm / (111.32 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

/**
 * A range-like name as a Search Box point of interest of exactly that name (ignoring case, accents and "the"): a natural one (category mountain, peak, ...)
 * first, then one with no category (how Mapbox lists most ranges), never a business that only shares the name, and
 * then Mapbox's own order (which follows `proximity`). Null when none matches or the search fails.
 */
async function landformResult(place: string, proximity: [number, number] | undefined, token: string, halfSpanKm: number = LANDFORM_HALF_SPAN_KM): Promise<GeocodeResult | null> {
  const name = place.split(",")[0];
  try {
    const found = await fetchCandidates(place, { proximity }, token, "poi");
    const ranked = found
      // Exactly the name, plurals included: "Bighorn Mountain" in Colorado is not the Bighorn Mountains.
      .filter((c) => c.type === "poi" && normalize(c.name) === normalize(name))
      // "Table Mountain, Cape Town" is not the Table Mountain in California: words after the comma must be in its address.
      .filter((c) => {
        const qualifier = place.split(",").slice(1).join(" ").trim();
        return qualifier === "" || normalize(c.label).includes(normalize(qualifier));
      })
      .map((c) => ({ c, rank: isNaturalFeature(c) ? 0 : c.categories.length === 0 ? 1 : 2 }))
      .filter(({ rank }) => rank < 2)
      .sort((a, b) => a.rank - b.rank || a.c.order - b.c.order);
    const best = ranked[0]?.c;
    if (best === undefined) return null;
    return { bbox: landformBBox(best.center, halfSpanKm), center: best.center, name: best.label, source: "mapbox" };
  } catch {
    return null;
  }
}

/** Candidates asked of the place geocoder: Mapbox's first unless one further down carries exactly the asked name. */
const CANDIDATES = 5;

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
 * resolve to streets. Any other name with no house number that lands on a street or an address ("Half Dome" was Half
 * Dome Court in Florida) is looked up as a point of interest of exactly that name first, boxed to about 10 km.
 */
export async function geocode(
  place: string,
  /** `nearOf`: set on the lookups of a "name, where" retry, so they do not retry again. */
  opts: { proximity?: [number, number]; nearOf?: string } = {},
): Promise<GeocodeResult | GeocodeError> {
  const token = process.env.MAPBOX_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) {
    return { error: "MAPBOX_TOKEN is not set" };
  }

  const polar = worldRegion(place.split(",")[0]);
  if (polar) return polar;
  // A state's part of a range is where the two overlap: "Colorado Rockies" is the Rocky Mountains inside Colorado.
  const part = opts.nearOf ? null : stateRange(place);
  if (part) {
    const [range, state] = await Promise.all([geocode(part.range, { nearOf: place }), geocode(/^(?:Washington|New York)$/.test(part.state) ? `${part.state} State` : part.state, { nearOf: place })]);
    if (!("error" in range) && !("error" in state)) {
      const bbox: BBox = [
        Math.max(range.bbox[0], state.bbox[0]),
        Math.max(range.bbox[1], state.bbox[1]),
        Math.min(range.bbox[2], state.bbox[2]),
        Math.min(range.bbox[3], state.bbox[3]),
      ];
      if (bbox[0] < bbox[2] && bbox[1] < bbox[3]) {
        return { bbox, center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2], name: `${part.state}'s part of the ${range.name.split(",")[0]}`, source: range.source };
      }
    }
  }
  const named = await lookupRegion(place, opts.proximity, { naturalEarth: firstRegion });
  if (named) return named;
  // A natural feature or a named route (a bay, a reservoir, a volcano, a river, a trail): OpenStreetMap's search, then
  // Wikidata, before the place geocoder, which knows only streets and towns of those names (Lake Powell, Victoria;
  // Tomales Bay Street, Las Vegas; Mount Rainier, Maryland). A town of that name more important than any feature stays
  // the place geocoder's (Half Moon Bay).
  if (isFeatureName(place)) {
    const feature = await featureLookup(place, opts.proximity);
    // A landmark with a national park of its name is the park ("Grand Canyon" was the village's 20 km box).
    if (feature && isSmall(feature.bbox) && !opts.nearOf) {
      const park = await lookupRegion(`${place.split(",")[0].trim()} National Park`, feature.center, { naturalEarth: async () => null });
      const [w, s, e, n] = park?.bbox ?? [0, 0, 0, 0];
      if (park && feature.center[0] >= w && feature.center[0] <= e && feature.center[1] >= s && feature.center[1] <= n) return park;
    }
    if (feature) return feature;
  }
  // A river OpenStreetMap does not know is its basin: "Colorado River" was a point on the Colorado of Texas, "Carson
  // River" a street in Wyoming.
  const river = place.split(",")[0].trim();
  if (/\b(?:river|creek|fork)\b/i.test(river)) {
    // "Middle Fork Salmon" is the Middle Fork Salmon River.
    const named = /\b(?:river|creek)$/i.test(river) ? river : `${river} River`;
    const basin = await lookupRegion(`${named} basin`, opts.proximity, { naturalEarth: firstRegion });
    if (basin) return basin;
  }

  const url = new URL(ENDPOINT);
  url.searchParams.set("q", place);
  // A few candidates, so a place of exactly the asked name ("West Texas") beats a town that only starts with it
  // ("West, Texas"), which Mapbox ranks first.
  url.searchParams.set("limit", String(CANDIDATES));
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
    const candidates = body.success ? body.data.features.map((f) => featureSchema.safeParse(f)).filter((f) => f.success) : [];
    const asked = normalize(place.split(",")[0]);
    const feature = candidates.find((f) => f.data.properties.name !== undefined && normalize(f.data.properties.name) === asked) ?? candidates[0];
    if (!feature?.success) {
      const landform = rangeLike ? await landformResult(place, opts.proximity, token) : null;
      return landform ?? { error: `No match for ${place}` };
    }

    const { name, full_address, bbox, coordinates, feature_type } = feature.data.properties;
    const center: [number, number] = [coordinates.longitude, coordinates.latitude];

    // A place that only shares a word of the name ("Grand Staircase-Escalante" was Staircase, a spot near Moab): the
    // named feature itself, from Wikidata or OpenStreetMap, when one is found.
    if (name !== undefined && !/\d/.test(place) && normalize(name) !== asked && normalize(name).split(" ").length < asked.split(" ").length) {
      const named = (await wikidataFeature(place, LANDFORM_HALF_SPAN_KM, opts.proximity)) ?? (await featureLookup(place, opts.proximity));
      if (named) return named;
      // A protected area people name without its kind (Grand Staircase-Escalante National Monument).
      for (const kind of ["National Monument", "National Park"]) {
        const area = await lookupRegion(`${place.split(",")[0].trim()} ${kind}`, opts.proximity, { naturalEarth: async () => null });
        if (area) return area;
      }
    }

    // The place geocoder has no natural features, so "Half Dome" came back as Half Dome Court in Boynton Beach, Florida.
    // A name with no house number that lands on a street or an address is looked up as a point of interest of exactly
    // that name first (a natural one, or one with no category), boxed to about 10 km.
    if ((feature_type === "street" || feature_type === "address") && !/\d/.test(place)) {
      // A river or a canyon runs far from the one point a search knows: boxed like a range, about 76 km across.
      const span = rangeLike || /\b(?:river|creek|stream|canyon|fork)\b/i.test(place) ? LANDFORM_HALF_SPAN_KM : FEATURE_HALF_SPAN_KM;
      const poi = (await landformResult(place, opts.proximity, token, span)) ?? (await wikidataFeature(place, span, opts.proximity)) ?? (await featureLookup(place, opts.proximity));
      if (poi) return poi;
      // "Paradise, Mount Rainier" was Mt Rainier View St in Las Vegas: the words after the comma say where, so the name
      // before it is looked up near that place (Paradise, Washington, on the mountain's south side).
      const [name, ...rest] = place.split(",").map((p) => p.trim());
      if (rest.length > 0 && name.length >= 3 && !opts.nearOf) {
        const near = await geocode(rest.join(", "), { ...opts, nearOf: place });
        if (!("error" in near)) {
          const found = await geocode(name, { proximity: near.center, nearOf: place });
          if (!("error" in found) && distanceKm(found.center, near.center) <= 60) return found;
        }
      }
    }

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

    // With no view and no other place to go by, a town of that name famous elsewhere is the one meant: "Chamonix" is
    // Chamonix-Mont-Blanc, not the suburb of Cape Town that Mapbox lists first.
    if (!opts.proximity && (bbox === undefined || (bbox[2] - bbox[0] < 1.5 && bbox[3] - bbox[1] < 1.5))) {
      const famous = await famousPlace(place, center);
      if (famous) return famous;
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

const REVERSE_ENDPOINT = "https://api.mapbox.com/search/geocode/v6/reverse";

/**
 * The named place at a point (the middle of a "here" view), for follow-ups that name where ("What changed near Detroit
 * since 2015?" rather than "here"): the town, else the locality, else the county; null when nothing answers. Never
 * moves the camera or counts as the question's place.
 */
export async function reverseGeocode([lng, lat]: [number, number], timeoutMs = 4000): Promise<string | null> {
  const token = process.env.MAPBOX_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) return null;
  for (const types of ["place", "locality", "district"]) {
    const url = new URL(REVERSE_ENDPOINT);
    url.searchParams.set("longitude", String(lng));
    url.searchParams.set("latitude", String(lat));
    url.searchParams.set("types", types);
    url.searchParams.set("access_token", token);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      const body = responseSchema.safeParse(await res.json());
      const first = body.success ? body.data.features.map((f) => featureSchema.safeParse(f)).find((f) => f.success) : undefined;
      const name = first?.success ? first.data.properties.name?.trim() : undefined;
      if (name && name.length >= 3) return name;
    } catch {
      return null;
    }
  }
  return null;
}
