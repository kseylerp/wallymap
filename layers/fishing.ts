/**
 * Fishing: where to fish and launch, what has been caught or seen lately, and how warm the water is.
 * Four keyless sources, queried in parallel; any one may fail without sinking the others:
 *   - OpenStreetMap via Overpass (`out center tags`): `leisure=fishing` (kind access), `leisure=slipway`
 *     (boat ramps, kind ramp) and `man_made=pier` tagged `fishing=yes|designated` (kind pier). Nodes carry
 *     lat/lon, ways and relations a `center`. Tags read: name, access, fee, fishing, boat, operator.
 *   - USFS recreation areas that list a fishing activity: EDW_RecreationAreaActivities_01/MapServer/0
 *     (https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RecreationAreaActivities_01/MapServer/0), checked
 *     2026-10-10: point layer with recareaname, recareaid, recareaurl, forestname, activityname
 *     ("Lake and Pond Fishing", "River and Stream Fishing", ...), parentactivityname ("Fishing"), openstatus.
 *     One row per area x activity, so rows are grouped by recareaid (kind access, source USFS). US only.
 *     No BLM service exposing a fishing activity was found keylessly (BLM recreation sites live in RIDB, which
 *     needs a key), so BLM fishing sites are not included.
 *   - iNaturalist fish observations (iconic_taxa=Actinopterygii, ray-finned fish) in the last `days` days,
 *     verifiable only, 1 page of 200, newest first; obscured locations dropped (kind sighting, `t` = when seen).
 *   - USGS water temperature (NWIS instantaneous values, parameter 00010; see _shared/usgs.ts): each access,
 *     ramp and pier point gets the nearest gauge's reading within 30 km (waterTempC, waterTempSite,
 *     waterTempKm, waterTempAt), its trout band (TROUT_BANDS: cold under 10 °C, good 10 to 18, warm 18 to 20,
 *     too warm above), a verdict in °F first, and whether the gauge's stream (read from the USGS station name)
 *     is the water the spot's own name names (gaugeMatch). US only.
 *   - Montana Fish, Wildlife & Parks fishing access sites (MT_FWP_FAS, keyless MapServer, checked live 2026-10-18:
 *     NAME, BOAT_FAC "Ramp (Concrete)", CAMPING, WEB_PAGE on myfwp.mt.gov), when the box touches Montana.
 * Wide (over 50,000 km², up to 1,500,000 km²), each source stays bounded: OpenStreetMap through the shared namedOverpassQuery (at
 * most 2,000 named places, with counts), USFS at most 2,000 activity rows, iNaturalist its one page of 200 newest, and
 * water temperature only while the box needs at most WIDE_TEMP_STRIPS USGS strips. No total is set: the sources count
 * different things (OSM elements, USFS activity rows, sightings), so no honest sum exists.
 * Fish stocking reports are published separately by each state wildlife agency with no common API; they are
 * not included, and the description says so.
 *
 * Live smoke 2026-10-10 02:20 UTC, Lake Tahoe box [-120.6,38.6,-119.8,39.3], 3.8 s: 119 points: 48 OSM ramps (no
 * leisure=fishing or fishing piers mapped there), 47 USFS fishing areas (57 activity rows), 24 fish sightings
 * in 30 days (4 hidden left out; Brook Trout 2026-10-07, Brown and Rainbow Trout 10-04); 69 places got a water
 * temperature from 8 gauges (e.g. a ramp 23 km from Blackwood Creek at 13.1 °C).
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point, Position } from "geojson";
import { defineLayer, type Attribute, type BBox, type CardSpec, type FieldHelp, type LayerError, type LayerResult, type LegendSpec, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { bboxesDisjoint, outsideUs } from "./_shared/coverage";
import { namedOverpassQuery, overpassCounts, overpassQuery } from "./_shared/overpass";
import { arcgisQuery } from "./_shared/arcgis";
import { haversineKm } from "./_shared/geo";
import { fetchIv, ivStrips, parseIv, type IvSite } from "./_shared/usgs";
import { LICENSE_LABELS, normalizeObservations } from "./species";
import { layerColor, OFF_WHITE } from "@/lib/render/palette";

const USFS_ACTIVITIES =
  "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RecreationAreaActivities_01/MapServer/0";
/** Montana FWP's fishing access site points (keyless MapServer; fields NAME, BOAT_FAC, CAMPING, WEB_PAGE). */
const MT_FWP_FAS = "https://fwp-gis.mt.gov/arcgis/rest/services/fwplnd/fwpLands/MapServer/1";
/** Montana's extent: the FWP source is asked only when the box touches it. */
export const MONTANA: BBox = [-116.05, 44.35, -104.04, 49.0];
const INAT = "https://api.inaturalist.org/v1/observations";
const DAY_MS = 86_400_000;
/** Most OSM elements and iNaturalist sightings read per view; the result says when either cap is hit. */
export const OSM_LIMIT = 2_000;
export const INAT_LIMIT = 200;
const WATER_TEMP_MAX_KM = 30;
/** In a wide box, water temperature is fetched only when the box splits into at most this many 25 square degree strips. */
export const WIDE_TEMP_STRIPS = 4;
/** Recreation sites and OSM tags change slowly. */
const PLACES_TTL_SECONDS = 86_400;
const SIGHTINGS_TTL_SECONDS = 3_600;
const TEMP_TTL_SECONDS = 900;

const inputSchema = z.object({
  days: z.number().int().min(1).max(365).default(30),
});

type Props = Record<string, string | number | boolean>;

const OSM_SELECTORS = ['nwr["leisure"="fishing"]', 'nwr["leisure"="slipway"]', 'nwr["man_made"="pier"]["fishing"~"^(yes|designated)$"]'];

/** Overpass QL for fishing spots, boat ramps and fishing piers; bbox order (south,west,north,east). */
export function buildFishingQuery([west, south, east, north]: BBox): string {
  const a = `(${south},${west},${north},${east})`;
  return `[out:json][timeout:25];(${OSM_SELECTORS.map((sel) => `${sel}${a};`).join("")});out center tags ${OSM_LIMIT};`;
}

/** Overpass QL for a wide box: the named fishing places only, at most `limit`, after counts of all and of the named. */
export function buildWideFishingQuery(bbox: BBox, limit: number): string {
  return namedOverpassQuery({ selectors: OSM_SELECTORS, bbox, geometry: "point", limit });
}

const OsmSchema = z.object({
  type: z.enum(["node", "way", "relation"]),
  id: z.number(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

/** Access points, ramps and piers from an Overpass body. */
export function osmFeatures(json: unknown): Feature<Point>[] {
  const elements =
    typeof json === "object" && json !== null && "elements" in json && Array.isArray(json.elements) ? json.elements : [];
  const out: Feature<Point>[] = [];
  for (const raw of elements) {
    const parsed = OsmSchema.safeParse(raw);
    if (!parsed.success) continue;
    const el = parsed.data;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    const tags = el.tags ?? {};
    const kind =
      tags.leisure === "slipway" ? "ramp" : tags.man_made === "pier" ? "pier" : tags.leisure === "fishing" ? "access" : null;
    if (kind === null) continue;
    const p: Props = { kind, source: "OpenStreetMap", osmId: `${el.type}/${el.id}` };
    p.name = tags.name ?? (kind === "ramp" ? "Boat ramp" : kind === "pier" ? "Fishing pier" : "Fishing spot");
    for (const key of ["access", "fee", "operator", "boat"] as const) if (tags[key]) p[key] = tags[key];
    out.push({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: p });
  }
  return out;
}

/** USFS recreation areas with a fishing activity, one point per area listing its fishing activities. */
export function usfsFeatures(fc: FeatureCollection): Feature<Point>[] {
  const byArea = new Map<string, Feature<Point>>();
  for (const f of fc.features) {
    if (f.geometry?.type !== "Point") continue;
    const props = f.properties ?? {};
    const id = String(props.recareaid ?? props.recareaname ?? f.geometry.coordinates.join(","));
    const activity = typeof props.activityname === "string" ? props.activityname : undefined;
    const existing = byArea.get(id);
    if (existing) {
      const p = existing.properties as Props;
      if (activity && !String(p.activities).split("; ").includes(activity)) {
        p.activities = p.activities ? `${p.activities}; ${activity}` : activity;
      }
      continue;
    }
    const p: Props = {
      kind: "access",
      source: "USFS",
      name: typeof props.recareaname === "string" ? props.recareaname : "Forest Service fishing site",
    };
    if (activity) p.activities = activity;
    if (typeof props.forestname === "string") p.forest = props.forestname;
    if (typeof props.recareaurl === "string") p.url = props.recareaurl;
    if (typeof props.openstatus === "string") p.status = props.openstatus;
    byArea.set(id, { type: "Feature", geometry: { type: "Point", coordinates: f.geometry.coordinates }, properties: p });
  }
  return [...byArea.values()];
}

/** Montana Fish, Wildlife & Parks fishing access sites as access points (kind access, source Montana FWP). */
export function montanaFeatures(fc: FeatureCollection): Feature<Point>[] {
  const out: Feature<Point>[] = [];
  for (const f of fc.features) {
    if (f.geometry?.type !== "Point") continue;
    const props = f.properties ?? {};
    const name = typeof props.NAME === "string" && props.NAME.trim() ? props.NAME.trim() : null;
    const p: Props = { kind: "access", source: "Montana FWP", name: name ? `${name} Fishing Access Site` : "Fishing Access Site" };
    if (typeof props.BOAT_FAC === "string" && props.BOAT_FAC.trim()) p.boatLaunch = props.BOAT_FAC.trim();
    if (typeof props.CAMPING === "string" && props.CAMPING.trim()) p.camping = props.CAMPING.trim();
    if (typeof props.WEB_PAGE === "string" && /^https:\/\//.test(props.WEB_PAGE)) p.url = props.WEB_PAGE;
    out.push({ type: "Feature", geometry: { type: "Point", coordinates: f.geometry.coordinates }, properties: p });
  }
  return out;
}

/** Elements in an Overpass body, not counting `out count` rows. */
function elementCount(json: unknown): number {
  const elements = typeof json === "object" && json !== null && "elements" in json && Array.isArray(json.elements) ? json.elements : [];
  return elements.filter((e: unknown) => (e as { type?: unknown } | null)?.type !== "count").length;
}

function totalResults(json: unknown): number {
  return typeof json === "object" && json !== null && "total_results" in json && typeof json.total_results === "number"
    ? json.total_results
    : 0;
}

/** iNaturalist fish observations as sightings. */
export function sightingFeatures(json: unknown): { features: Feature<Point>[]; skipped: number } {
  const { data, skipped } = normalizeObservations(json);
  const features = data.features.map((f) => ({
    ...f,
    properties: { ...f.properties, kind: "sighting", source: "iNaturalist" },
  }));
  return { features, skipped };
}

/**
 * Water temperature bands for trout (the thresholds the description already gives): under 10 °C cold and slow to feed,
 * 10 to 18 °C good, 18 to 20 °C warm, over about 20 °C too warm (stressed). Low to high, the ramp's order.
 */
export const TROUT_BANDS = [
  { value: "cold", label: "Cold: under 50 °F (10 °C)", help: "Trout feed slowly in water this cold." },
  { value: "good", label: "Good: 50 to 64 °F (10 to 18 °C)", help: "The range in which trout feed best." },
  { value: "warm", label: "Warm: 64 to 68 °F (18 to 20 °C)", help: "Trout slow down; fish early in the day." },
  { value: "too_warm", label: "Too warm: over 68 °F (20 °C)", help: "Trout are stressed; catch and release can kill them." },
] as const;

export type TroutBand = (typeof TROUT_BANDS)[number]["value"];

/** The trout band for a water temperature in °C. */
export function troutBand(c: number): TroutBand {
  if (c < 10) return "cold";
  if (c <= 18) return "good";
  if (c <= 20) return "warm";
  return "too_warm";
}

/** A water temperature in °F first, °C second: "47 °F (8.5 °C)". */
export function tempText(c: number): string {
  return `${Math.round((c * 9) / 5 + 32)} °F (${c.toFixed(1)} °C)`;
}

/** The card's verdict for trout: "47 °F (8.5 °C): cold; trout feed best at 50 to 64 °F (10 to 18 °C)". */
export function troutVerdict(c: number): string {
  const t = tempText(c);
  switch (troutBand(c)) {
    case "cold":
      return `${t}: cold; trout feed best at 50 to 64 °F (10 to 18 °C)`;
    case "good":
      return `${t}: good; trout feed best at 50 to 64 °F (10 to 18 °C)`;
    case "warm":
      return `${t}: warm; trout slow down above 64 °F (18 °C) and are stressed above about 68 °F (20 °C)`;
    case "too_warm":
      return `${t}: too warm; trout are stressed above about 68 °F (20 °C)`;
  }
}

/** USGS station-name abbreviations, spelled out. */
const ABBREVIATIONS: Record<string, string> = {
  r: "River",
  rv: "River",
  riv: "River",
  c: "Creek",
  ck: "Creek",
  cr: "Creek",
  fk: "Fork",
  lk: "Lake",
  res: "Reservoir",
  br: "Branch",
  sl: "Slough",
  trib: "Tributary",
  n: "North",
  s: "South",
  e: "East",
  w: "West",
  m: "Middle",
  mf: "Middle Fork",
  nf: "North Fork",
  sf: "South Fork",
  ef: "East Fork",
  wf: "West Fork",
};

/** Where a USGS station name stops naming the water: "BLACKWOOD C NR TAHOE CITY CA" → "BLACKWOOD C". */
const PLACE_WORD = /\s(?:NR|NEAR|AT|A|ABV|ABOVE|AB|BLW|BELOW|BL|BLO|IN|ON|OUTLET|INLET|@)\s/i;

/** The stream a USGS gauge is on, from its station name: "W FK CARSON R NR WOODFORDS CA" → "West Fork Carson River". */
export function gaugeStream(siteName: string): string {
  const head = siteName.split(PLACE_WORD)[0].replace(/,.*$/, "").trim();
  return head
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ABBREVIATIONS[w.toLowerCase().replace(/\.$/, "")] ?? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

const LAKE_WORDS = new Set(["lake", "lakes", "reservoir", "pond", "ponds", "bay"]);
const STREAM_WORDS = new Set(["river", "creek", "fork", "brook", "run", "slough", "canal", "stream", "branch"]);
/** Words that say what kind of water or where on it, not which water. */
const GENERIC = new Set([...LAKE_WORDS, ...STREAM_WORDS, "north", "south", "east", "west", "middle", "upper", "lower", "the", "of", "tributary"]);

const wordsOf = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter(Boolean);

function waterKind(words: string[]): "lake" | "stream" | undefined {
  if (words.some((w) => LAKE_WORDS.has(w))) return "lake";
  if (words.some((w) => STREAM_WORDS.has(w))) return "stream";
  return undefined;
}

/**
 * Whether the gauge reads the spot's own water, by name: `different` when the spot's name names a water body (a river,
 * creek, lake ...) that is not the gauge's, or a lake where the gauge is on a stream; `same` when they share the water's
 * name; `unknown` when the spot's name names no water (a ramp, a campground, an access site named for a bridge).
 */
export function gaugeMatch(spotName: string, stream: string): "same" | "different" | "unknown" {
  const spot = wordsOf(spotName);
  const spotKind = waterKind(spot);
  if (spotKind === undefined) return "unknown";
  const gauge = wordsOf(stream);
  const gaugeKind = waterKind(gauge);
  if (gaugeKind !== undefined && gaugeKind !== spotKind) return "different";
  const core = gauge.filter((w) => !GENERIC.has(w) && w.length >= 3);
  if (core.length === 0) return "unknown";
  return core.some((w) => spot.includes(w)) ? "same" : "different";
}

/** A distance in miles first, km second: "8.7 mi (14.0 km)". */
function distanceText(km: number): string {
  return `${(km / 1.609344).toFixed(1)} mi (${km.toFixed(1)} km)`;
}

/** The water a spot's name names, as written: "Moose Creek Flat Campground" → "Moose Creek", "Lake Tahoe - West Shore" → "Lake Tahoe". */
export function spotWater(name: string): string | undefined {
  const lakeFirst = /\b(Lake|Reservoir)\s+([A-Z][\w'.]*)/.exec(name);
  if (lakeFirst) return `${lakeFirst[1]} ${lakeFirst[2]}`;
  const after = /\b([A-Z][\w'.]*)\s+(River|Creek|Fork|Brook|Slough|Canal|Lake|Lakes|Reservoir|Pond|Ponds|Bay)\b/.exec(name);
  return after ? `${after[1]} ${after[2]}` : undefined;
}

/** The card's line on where the temperature comes from, with a warning when the gauge is on other water. */
export function gaugeNote(match: "same" | "different" | "unknown", stream: string, km: number, spotName = ""): string {
  const away = distanceText(km);
  if (match === "same") return `The ${stream} gauge, ${away} away`;
  if (match === "different") {
    const water = spotWater(spotName);
    return water
      ? `A gauge on ${stream}, ${away} away, not on ${water}; that water can run warmer or colder`
      : `A gauge on other water (${stream}), ${away} away; this spot's water can run warmer or colder`;
  }
  return `A gauge on ${stream}, ${away} away; it may not be this spot's water`;
}

/**
 * Adds the nearest USGS water temperature within 30 km to each non-sighting point (mutates): waterTempC, waterTempF,
 * the trout band (tempBand) and verdict (tempVerdict), the gauge's name and stream, its distance, whether it reads
 * the spot's own water (gaugeMatch) and the card's line on it (gaugeNote), and when it was read.
 */
export function attachWaterTemps(features: Feature<Point>[], sites: IvSite[]): number {
  const temps = sites.filter((s) => s.readings["00010"] !== undefined);
  let attached = 0;
  for (const f of features) {
    const p = f.properties as Props | null;
    if (!p || p.kind === "sighting") continue;
    let best: { site: IvSite; km: number } | undefined;
    for (const site of temps) {
      const km = haversineKm(f.geometry.coordinates as Position, site.coordinates);
      if (km <= WATER_TEMP_MAX_KM && (best === undefined || km < best.km)) best = { site, km };
    }
    if (best === undefined) continue;
    const reading = best.site.readings["00010"]!;
    const km = Math.round(best.km * 10) / 10;
    const stream = gaugeStream(best.site.name);
    const match = gaugeMatch(String(p.name ?? ""), stream);
    p.waterTempC = reading.value;
    p.waterTempF = Math.round(((reading.value * 9) / 5 + 32) * 10) / 10;
    p.tempBand = troutBand(reading.value);
    p.tempVerdict = troutVerdict(reading.value);
    p.waterTempSite = best.site.name;
    p.waterTempStream = stream;
    p.waterTempKm = km;
    p.gaugeMatch = match;
    p.gaugeNote = gaugeNote(match, stream, km, String(p.name ?? ""));
    p.waterTempAt = new Date(reading.time).toISOString();
    attached += 1;
  }
  return attached;
}

export function inatUrl(bbox: BBox, days: number, now: Date): string {
  const [west, south, east, north] = bbox;
  const q = new URLSearchParams({
    nelat: String(north),
    nelng: String(east),
    swlat: String(south),
    swlng: String(west),
    iconic_taxa: "Actinopterygii",
    d1: new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10),
    geo: "true",
    verifiable: "true",
    per_page: String(INAT_LIMIT),
    order_by: "observed_on",
    order: "desc",
  });
  return `${INAT}?${q.toString()}`;
}

async function inatSightings(ctx: QueryContext, days: number, now: Date) {
  try {
    const res = await ctx.fetch(inatUrl(ctx.bbox, days, now), {
      cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:inat-fish`,
      ttlSeconds: SIGHTINGS_TTL_SECONDS,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    if (!res.ok) return { ok: false as const, error: `iNaturalist returned ${res.status}` };
    return { ok: true as const, json: (await res.json()) as unknown };
  } catch {
    return { ok: false as const, error: "iNaturalist returned no usable response" };
  }
}

const HELP: Record<string, FieldHelp> = {
  tempVerdict: {
    text:
      "The latest water temperature at the nearest USGS stream gauge within 30 km (19 mi), in °F with °C after it, and what it means for trout: " +
      "they feed best around 50 to 64 °F (10 to 18 °C), slow down above 64 °F and are stressed above about 68 °F (20 °C). The gauge may be on " +
      "other water; the next row says.",
    source: "USGS Water Data (instantaneous values)",
    url: "https://waterdata.usgs.gov/",
  },
  gaugeNote: {
    text:
      "Which stream the temperature gauge is on and how far it is from this spot. When the spot's name names a different river, creek or lake, " +
      "the card says so: that water can run warmer or colder.",
  },
  waterTempC: { text: "Water temperature at the nearest USGS gauge within 30 km.", unit: "°C" },
  waterTempF: { text: "Water temperature at the nearest USGS gauge within 30 km (19 mi).", unit: "°F" },
  status: { text: "Open or closed as the Forest Service's nightly recreation feed reports it; not a live closure notice." },
  license: { text: "The licence the observer chose for the sighting; all rights reserved when none; cite or link it when showing it." },
  boatLaunch: { text: "The boat launch Montana Fish, Wildlife & Parks lists for this fishing access site." },
};

const KIND_LABELS: Record<string, string> = {
  access: "Fishing access",
  ramp: "Boat ramp",
  pier: "Fishing pier",
  sighting: "Fish seen",
};

const CARD: CardSpec = {
  facts: [
    { key: "kind", label: "Type", values: KIND_LABELS },
    { key: "species", label: "Species" },
    { key: "scientificName", label: "Scientific name" },
    { key: "observedOn", label: "Seen on", format: "date" },
    { key: "tempVerdict", label: "Water temperature" },
    { key: "gaugeNote", label: "Temperature from" },
    { key: "waterTempAt", label: "Temperature read", format: "date" },
    { key: "activities", label: "Activities", format: "list" },
    { key: "forest", label: "Forest" },
    { key: "status", label: "Status", values: { open: "Open", closed: "Closed", none: "Not reported" } },
    {
      key: "access",
      label: "Access",
      values: { yes: "Public", permissive: "Allowed by the owner", private: "Private", customers: "Customers only", permit: "Permit needed", no: "No public access" },
    },
    { key: "fee", label: "Fee", values: { yes: "Yes", no: "No" } },
    { key: "boat", label: "Boats", values: { yes: "Allowed", no: "Not allowed" } },
    { key: "boatLaunch", label: "Boat launch" },
    { key: "camping", label: "Camping", values: { Yes: "Yes", No: "No" } },
    { key: "operator", label: "Run by" },
    {
      key: "source",
      label: "Source",
      values: { OpenStreetMap: "OpenStreetMap", USFS: "US Forest Service", iNaturalist: "iNaturalist", "Montana FWP": "Montana Fish, Wildlife & Parks" },
    },
    { key: "license", label: "Licence", values: LICENSE_LABELS },
  ],
  links: [{ key: "url", label: "Source page" }],
  hidden: ["osmId", "waterTempC", "waterTempF", "waterTempSite", "waterTempStream", "waterTempKm", "tempBand", "gaugeMatch"],
};

/** Kinds first (where to fish), then the water temperature band that colors each place. */
const ATTRIBUTES: Attribute[] = [
  {
    key: "kind",
    type: "category",
    label: "Kind",
    primary: true,
    levels: [
      { value: "access", label: "Access", help: "OpenStreetMap fishing spots, Forest Service areas that list fishing, and Montana fishing access sites." },
      { value: "ramp", label: "Boat ramp" },
      { value: "pier", label: "Pier" },
      { value: "sighting", label: "Fish seen", help: "Fish photographed on iNaturalist in the days asked for." },
    ],
  },
  {
    key: "tempBand",
    type: "ordinal",
    label: "Water temperature for trout",
    levels: TROUT_BANDS.map((b) => ({ value: b.value, label: b.label, help: b.help })),
    scale: "Trout bands: feed best at 50 to 64 °F (10 to 18 °C), stressed above about 68 °F (20 °C)",
  },
  { key: "waterTempF", type: "measure", label: "Water temperature", unit: "°F", aggregate: "mean" },
  { key: "species", type: "category", label: "Species" },
];

/** The key: the trout bands that color the places, then the points with no temperature (sightings, places far from a gauge). */
const LEGEND: LegendSpec = {
  kind: "categories",
  title: "Water temperature for trout",
  field: "tempBand",
  items: [
    ...TROUT_BANDS.map((b) => ({ label: b.label, value: b.value, symbol: "point" as const, help: b.help })),
    {
      label: "No water temperature",
      color: OFF_WHITE,
      symbol: "point" as const,
      help: "Fish sightings, and places more than 19 mi (30 km) from a USGS gauge that reads water temperature (or outside the US).",
    },
  ],
  note: "From the nearest USGS gauge, which may be on other water; the card says which.",
};

/** A place with its own name (not the default "Boat ramp") sorts first, so the map's labels name real places. */
const DEFAULT_NAMES = new Set(["Boat ramp", "Fishing pier", "Fishing spot", "Fishing Access Site", "Forest Service fishing site"]);
const hasOwnName = (f: Feature) => {
  const p = f.properties ?? {};
  return p.kind !== "sighting" && typeof p.name === "string" && !DEFAULT_NAMES.has(p.name);
};

const fishing = defineLayer({
  id: "fishing",
  title: "Fishing (access, boat ramps, recent catches, water temperature)",
  description:
    "Where to fish and launch, what fish people have seen lately, and how warm the water is. User words: fishing, where to fish, fishing spot, fishing access, boat ramp, boat launch, slipway, pier, trout, bass, what's biting, water temperature. " +
    "Points by kind: 'access' (OpenStreetMap fishing spots, US Forest Service recreation areas that list fishing, with activities such as 'Lake and Pond Fishing', forest, url and status, and in Montana the state's Fish, Wildlife & Parks fishing access sites with boatLaunch, camping and url), " +
    "'ramp' (boat ramps / slipways from OpenStreetMap, with access and fee where tagged), 'pier' (fishing piers), and 'sighting' (fish observations on iNaturalist in the last `days` days, default 30, with species, scientificName, t = when seen, url). " +
    "In the United States, access, ramp and pier points also get the nearest USGS gauge's live water temperature within 30 km: waterTempC (°C) and waterTempF (°F), tempBand for trout (cold under 10 °C / 50 °F, good 10 to 18 °C, warm 18 to 20 °C, too_warm above about 20 °C / 68 °F) with tempVerdict in words, waterTempSite and waterTempStream (the gauge and its stream), waterTempKm, waterTempAt, and gaugeMatch: 'different' when the spot's name names other water than the gauge's stream (say so), 'same', or 'unknown'. Give temperatures in °F first for US places. " +
    "Example questions: 'What fish have people caught near here this month?', 'Is the river too warm for trout?'. " +
    "Caveats: fish stocking reports are NOT available here (each state wildlife agency publishes its own, with no common feed), so say so and point to the state agency; " +
    "this layer does not show regulations, seasons or licence rules; OSM coverage of fishing spots is patchy (many lakes only have ramps mapped); " +
    "sightings are where people photograph fish, not a catch survey, and threatened species with hidden locations are left out; the water temperature is from the nearest stream gauge, which may be a different water body. " +
    "Bureau of Land Management (BLM) fishing sites are omitted: BLM publishes them only through a keyed API. " +
    "At most 2,000 OpenStreetMap places and the 200 most recent sightings are returned, and the result says when a cap is hit. " +
    "Global for OSM and iNaturalist; USFS sites and water temperature are US only, Montana access sites Montana only. Over 50,000 km² it keeps only named OSM places and says what it left out.",
  coverage: "global",
  surface: "any",
  license: "OpenStreetMap ODbL; USFS and USGS public domain; Montana Fish, Wildlife & Parks; iNaturalist CC BY-NC / CC0 per observation",
  requiredEnv: [],
  optionalEnv: ["OVERPASS_URL"],
  maxAreaKm2: 50_000,
  // Every source is bounded in wide mode (named OSM, capped USFS rows, one iNaturalist page, few USGS strips).
  hardMaxAreaKm2: 1_500_000,
  wide: { mode: "named", limit: 2000 },
  input: inputSchema,
  style: { geometry: "point", color: layerColor("fishing"), cluster: true, timeField: "t", encode: { color: "tempBand" } },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  // Sightings are dated over the days asked for; places are not.
  time: { shape: "continuous", step: "day" },
  legend: LEGEND,
  labels: { field: "name", max: 5, minZoom: 9 },
  // US temperatures and distances in °F and miles first.
  display: { units: "us", timeZone: "local" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const now = new Date();
    const us = !outsideUs(ctx.bbox);
    const montana = !bboxesDisjoint(ctx.bbox, MONTANA);
    const wide = ctx.wide === true;
    const wideLimit = Math.min(OSM_LIMIT, ctx.wideStrategy?.limit ?? OSM_LIMIT);
    // Water temperature costs one USGS request per 25 square degree strip; a very wide box skips it.
    const temperatures = us && (!wide || ivStrips(ctx.bbox).length <= WIDE_TEMP_STRIPS);
    const [osm, usfs, inat, temps, fwp] = await Promise.all([
      wide
        ? overpassQuery(ctx, buildWideFishingQuery(ctx.bbox, wideLimit), { cacheSuffix: "osm-fishing:named" })
        : overpassQuery(ctx, buildFishingQuery(ctx.bbox), { cacheSuffix: "osm-fishing" }),
      us
        ? arcgisQuery(ctx, USFS_ACTIVITIES, {
            where: "parentactivityname='Fishing'",
            outFields: ["recareaid", "recareaname", "recareaurl", "forestname", "activityname", "openstatus"],
            bbox: ctx.bbox,
            ...(wide && { resultRecordCount: wideLimit, orderByFields: "recareaid" }),
            cacheSuffix: "usfs-fishing",
            ttlSeconds: PLACES_TTL_SECONDS,
          })
        : Promise.resolve(null),
      inatSightings(ctx, input.days, now),
      temperatures ? fetchIv(ctx, ["00010"], "usgs-temp", TEMP_TTL_SECONDS) : Promise.resolve(null),
      montana
        ? arcgisQuery(ctx, MT_FWP_FAS, {
            outFields: ["NAME", "BOAT_FAC", "CAMPING", "WEB_PAGE"],
            bbox: ctx.bbox,
            cacheSuffix: "mt-fwp-fas",
            ttlSeconds: PLACES_TTL_SECONDS,
          })
        : Promise.resolve(null),
    ]);

    const features: Feature<Point>[] = [];
    const notes: string[] = [];
    const failures: string[] = [];
    const fmt = (n: number) => n.toLocaleString("en-US");
    if (osm.ok) {
      features.push(...osmFeatures(osm.json));
      if (wide) {
        const [all, named] = overpassCounts(osm.json);
        if (all !== undefined && named !== undefined) {
          const listed = elementCount(osm.json);
          notes.push(
            listed < named
              ? `OpenStreetMap: the first ${fmt(listed)} of ${fmt(named)} named places (${fmt(all)} in all; unnamed ones, most boat ramps, are left out)`
              : `OpenStreetMap: ${fmt(named)} named places of ${fmt(all)} in the box; unnamed ones (most boat ramps) are left out`,
          );
        }
      } else if (elementCount(osm.json) >= OSM_LIMIT) {
        notes.push(`OpenStreetMap places were capped at ${fmt(OSM_LIMIT)}, so some are missing; zoom in for all of them`);
      }
    }
    else failures.push(`OpenStreetMap (${osm.error})`);
    if (usfs !== null) {
      if (usfs.ok) {
        features.push(...usfsFeatures(usfs.fc));
        if (wide && usfs.truncated) notes.push(`USFS fishing areas stop at the first ${fmt(wideLimit)} activity rows`);
      } else failures.push(`USFS recreation sites (${usfs.error})`);
    }
    if (fwp !== null) {
      if (fwp.ok) features.push(...montanaFeatures(fwp.fc));
      else failures.push(`Montana FWP fishing access sites (${fwp.error})`);
    }
    if (inat.ok) {
      const sightings = sightingFeatures(inat.json);
      features.push(...sightings.features);
      if (sightings.skipped > 0) notes.push(`${sightings.skipped} fish sightings with hidden locations were left out`);
      const total = totalResults(inat.json);
      if (total > INAT_LIMIT) {
        notes.push(`Showing the ${INAT_LIMIT} most recent of ${total.toLocaleString("en-US")} fish sightings; zoom in or ask for fewer days for the rest`);
      }
    } else {
      failures.push(`iNaturalist (${inat.error})`);
    }
    if (us && !temperatures) notes.push("Water temperatures are left out over this wide a box");
    if (temps !== null) {
      if (temps.ok) {
        const n = attachWaterTemps(features, parseIv(temps.bodies, now));
        if (n === 0) notes.push("No USGS water temperature gauge within 30 km of these spots");
      } else {
        failures.push(`USGS water temperature (${temps.error})`);
      }
    }
    const sources = 2 + (us ? 1 : 0) + (temperatures ? 1 : 0) + (montana ? 1 : 0);
    if (failures.length === sources) {
      return { error: `Every fishing source failed: ${failures.join("; ")}`, hint: "upstream" };
    }
    if (failures.length > 0) notes.push(`Left out because the source failed: ${failures.join("; ")}`);
    notes.push("Fish stocking reports are not included (state agencies publish them separately)");
    if (us) notes.push("BLM fishing sites are not included (no keyless BLM source)");

    // Named places first (stable), so the top labels name real places, not "Boat ramp".
    const ordered = [...features.filter(hasOwnName), ...features.filter((f) => !hasOwnName(f))];
    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features: ordered },
      citation: {
        source:
          "OpenStreetMap contributors (ODbL); USDA Forest Service recreation activities and USGS water data (public domain); Montana Fish, Wildlife & Parks fishing access sites; iNaturalist (CC BY-NC / CC0)",
        url: "https://www.openstreetmap.org/copyright",
        retrieved: now.toISOString(),
      },
      coverageNote: notes.join("; "),
    };
  },
});

registerLayer(fishing);

export default fishing;
