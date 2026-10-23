/**
 * Backcountry points of interest from OpenStreetMap via one Overpass query with one set per kind, each cut at 1,000
 * by OpenStreetMap id (peaks with an elevation get their own set, cut at 2,000, fetched before the peaks without one):
 *   hut        nwr[tourism=alpine_hut|wilderness_hut]
 *   shelter    nwr[amenity=shelter] minus bus, picnic and bike shelters
 *   spring     nwr[natural=spring]          hot_spring  nwr[natural=hot_spring]
 *   drinking_water  nwr[amenity=drinking_water]
 *   waterfall  nwr[waterway=waterfall]      cave        nwr[natural=cave_entrance]
 *   pass       named node[mountain_pass=yes] or [highway=mountain_pass]
 *   saddle     named node[natural=saddle]   peak        named node[natural=peak]
 *   viewpoint  nwr[tourism=viewpoint]
 * `out tags center` gives ways and relations a centre point. Fixture: layers/__fixtures__/outdoor-features.tahoe.json
 * (Desolation Wilderness and Lake Tahoe west shore, CA, recorded 2026-10-09, 42 elements across all kinds).
 * Wide (over 10,000 km², up to 1,500,000 km²): one search per OSM key for every requested kind, an `out count` of every
 * match and of the named ones, then the named ones of each kind (at most 1,000 per kind, lowest ids, in kind priority
 * order); the result keeps 2,000 by kind priority and the tallest fetched peaks, so huts are not crowded out by peaks.
 * Unnamed springs, taps, viewpoints and shelters are left out at that scale. The named ones are filtered from the
 * first set rather than searched for again (see namedOverpassQuery in _shared/overpass.ts for why).
 * Live smoke check: Desolation Wilderness / Lake Tahoe south-west (38.8,-120.3 to 39.1,-119.9), 2026-10-09: 136 features (4 hut, 1 shelter, 8 spring, 12 waterfall, 8 pass or saddle, 57 peak, 31 viewpoint, 15 drinking_water), no truncation.
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
import { overpassCounts, overpassQuery } from "./_shared/overpass";
import {
  bboxClause,
  checkedOn,
  countedTotal,
  elementCenter,
  metres,
  nodeElementSchema,
  osmCitation,
  overpassBodySchema,
  relationElementSchema,
  wayElementSchema,
  wholeNumber,
} from "./_shared/osm-features";
import { layerColor } from "@/lib/render/palette";

/** Kinds in priority order: when more than MAX_POINTS come back, earlier kinds are kept first. */
export const KINDS = [
  "hut",
  "shelter",
  "hot_spring",
  "spring",
  "waterfall",
  "cave",
  "pass",
  "saddle",
  "peak",
  "viewpoint",
  "drinking_water",
] as const;

export type Kind = (typeof KINDS)[number];

/** Most elements Overpass returns for each kind (by OpenStreetMap id, not by size or distance). */
export const MAX_PER_KIND = 1_000;
/** Most peaks with an elevation Overpass returns; they are fetched before the peaks without one. */
export const MAX_PEAKS_WITH_ELE = 2_000;
/** Most points returned in all. */
export const MAX_POINTS = 5_000;

/** Largest region for the full listing of every kind (springs, taps and peaks are dense); wider boxes go named-only. */
export const ALL_KINDS_MAX_AREA_KM2 = 10_000;

const inputSchema = z.object({
  /** Only these kinds; every kind but peaks when left out (peaks join when listed here or with includePeaks). */
  kinds: z.array(z.enum(KINDS)).min(1).optional(),
  /** Add named peaks (left out by default: the basemap already labels them). */
  includePeaks: z.boolean().optional(),
});

type FeaturesInput = z.infer<typeof inputSchema>;

const NOT_A_BACKCOUNTRY_SHELTER = '["shelter_type"!~"^(public_transport|picnic_shelter|bicycle_parking|bus_stop)$"]["bus"!="yes"]';

/** Overpass selectors per kind (without the bbox). Names are required on peaks, saddles and passes. */
const SELECTORS: Record<Kind, string[]> = {
  hut: ['nwr["tourism"~"^(alpine_hut|wilderness_hut)$"]'],
  shelter: [`nwr["amenity"="shelter"]${NOT_A_BACKCOUNTRY_SHELTER}`],
  hot_spring: ['nwr["natural"="hot_spring"]'],
  spring: ['nwr["natural"="spring"]'],
  waterfall: ['nwr["waterway"="waterfall"]'],
  cave: ['nwr["natural"="cave_entrance"]'],
  pass: ['node["mountain_pass"="yes"]["name"]', 'node["highway"="mountain_pass"]["name"]'],
  saddle: ['node["natural"="saddle"]["name"]'],
  peak: ['node["natural"="peak"]["name"]["ele"]'],
  viewpoint: ['nwr["tourism"="viewpoint"]'],
  drinking_water: ['nwr["amenity"="drinking_water"]'],
};

/** Peaks without an elevation: their own set, listed after the peaks that have one. */
const PEAKS_WITHOUT_ELE = 'node["natural"="peak"]["name"][!"ele"]';

/** The Overpass sets for the requested kinds, in kind priority order: set name, selectors and element limit. */
function setsFor(kinds: readonly Kind[]): { set: string; selectors: string[]; limit: number }[] {
  const sets: { set: string; selectors: string[]; limit: number }[] = [];
  for (const kind of KINDS.filter((k) => kinds.includes(k))) {
    sets.push({ set: kind, selectors: SELECTORS[kind], limit: kind === "peak" ? MAX_PEAKS_WITH_ELE : MAX_PER_KIND });
    if (kind === "peak") sets.push({ set: "peak_noele", selectors: [PEAKS_WITHOUT_ELE], limit: MAX_PER_KIND });
  }
  return sets;
}

/** Overpass QL: one set per requested kind (two for peaks), an `out count` for each, then the elements. */
export function buildFeaturesQuery(bbox: BBox, kinds: readonly Kind[] = KINDS): string {
  const area = bboxClause(bbox);
  const sets = setsFor(kinds);
  return (
    `[out:json][timeout:25];` +
    sets.map(({ set, selectors }) => `(${selectors.map((s) => `${s}${area};`).join("")})->.${set};`).join("") +
    sets.map(({ set }) => `.${set} out count;`).join("") +
    sets.map(({ set, limit }) => `.${set} out tags center ${limit};`).join("")
  );
}

/** Plain key=value tags of the kinds a wide query can fold into one search per key; values are regex alternatives. */
const WIDE_TAGS: Partial<Record<Kind, [key: string, values: string]>> = {
  hut: ["tourism", "alpine_hut|wilderness_hut"],
  viewpoint: ["tourism", "viewpoint"],
  hot_spring: ["natural", "hot_spring"],
  spring: ["natural", "spring"],
  cave: ["natural", "cave_entrance"],
  peak: ["natural", "peak"],
  saddle: ["natural", "saddle"],
  waterfall: ["waterway", "waterfall"],
  drinking_water: ["amenity", "drinking_water"],
};

/** The other kinds' wide selectors: their own, minus the name requirement (the named filter comes after the count). */
const WIDE_OTHER: Partial<Record<Kind, string[]>> = {
  shelter: SELECTORS.shelter,
  pass: ['node["mountain_pass"="yes"]', 'node["highway"="mountain_pass"]'],
};

/** Tag filters (without the element type) that pick one kind out of the named set in a wide query. */
function wideFilters(kind: Kind): string[] {
  const tag = WIDE_TAGS[kind];
  if (tag !== undefined) return [tag[1].includes("|") ? `["${tag[0]}"~"^(${tag[1]})$"]` : `["${tag[0]}"="${tag[1]}"]`];
  return (WIDE_OTHER[kind] ?? SELECTORS[kind]).map((sel) => sel.replace(/^(nwr|node|way|relation)/, ""));
}

/**
 * Overpass QL for a wide box: counts of every match and of the named ones, then each requested kind's named elements
 * (at most `perKind` each) in kind priority order. Each search scans the whole box, so kinds sharing a key are folded
 * into one search (natural~spring|peak|...): over Utah all eleven kinds took 14 s folded against 52 s with one search
 * per kind (2026-10-14). The per-kind sets are filtered from the named set in memory.
 */
export function buildWideFeaturesQuery(bbox: BBox, kinds: readonly Kind[], perKind: number = MAX_PER_KIND): string {
  const wanted = KINDS.filter((k) => kinds.includes(k));
  const byKey = new Map<string, string[]>();
  const selectors: string[] = [];
  for (const kind of wanted) {
    const tag = WIDE_TAGS[kind];
    if (tag === undefined) {
      selectors.push(...(WIDE_OTHER[kind] ?? SELECTORS[kind]));
      continue;
    }
    byKey.set(tag[0], [...(byKey.get(tag[0]) ?? []), tag[1]]);
  }
  for (const [key, values] of byKey) {
    const alt = values.join("|");
    selectors.push(alt.includes("|") ? `nwr["${key}"~"^(${alt})$"]` : `nwr["${key}"="${alt}"]`);
  }
  const area = bboxClause(bbox);
  const perKindOut = wanted
    .map((kind) => `(${wideFilters(kind).map((f) => `nwr.named${f};`).join("")})->.${kind};.${kind} out tags center ${perKind};`)
    .join("");
  return (
    `[out:json][timeout:25];(${selectors.map((sel) => `${sel}${area};`).join("")})->.all;.all out count;` +
    `nwr.all["name"]->.named;.named out count;${perKindOut}`
  );
}

/** The first allowed kind a tag set belongs to, in KINDS order; null when none (or a bus or picnic shelter). */
export function classify(tags: Record<string, string>, allowed: readonly Kind[] = KINDS): Kind | null {
  const is: Record<Kind, boolean> = {
    hut: tags.tourism === "alpine_hut" || tags.tourism === "wilderness_hut",
    shelter:
      tags.amenity === "shelter" &&
      tags.bus !== "yes" &&
      !["public_transport", "picnic_shelter", "bicycle_parking", "bus_stop"].includes(tags.shelter_type ?? ""),
    hot_spring: tags.natural === "hot_spring",
    spring: tags.natural === "spring",
    waterfall: tags.waterway === "waterfall",
    cave: tags.natural === "cave_entrance",
    pass: (tags.mountain_pass === "yes" || tags.highway === "mountain_pass") && tags.name !== undefined,
    saddle: tags.natural === "saddle" && tags.name !== undefined,
    peak: tags.natural === "peak" && tags.name !== undefined,
    viewpoint: tags.tourism === "viewpoint",
    drinking_water: tags.amenity === "drinking_water",
  };
  return KINDS.find((k) => allowed.includes(k) && is[k]) ?? null;
}

type Props = Record<string, string | number | boolean>;

function yesNo(value: string | undefined): boolean | undefined {
  if (value === "yes") return true;
  if (value === "no") return false;
  return undefined;
}

/** Higher than Everest (8,849 m) or lower than the Dead Sea shore (-430 m): not an elevation on Earth's surface. */
const ELE_MAX_M = 8_850;
const ELE_MIN_M = -440;
/**
 * Eastern North America (east of 100° W, 26° N to 60° N; south of 26° N the Sierra Madre Oriental tops 3,500 m) has no
 * ground above Mount Mitchell's 2,037 m. A unitless `ele` above 2,100 m there was typed in feet (Glassmine Falls near
 * Asheville carried "5200", read as 5,200 m), so it is read as feet.
 */
const EAST_NA: BBox = [-100, 26, -52, 60];
const EAST_NA_MAX_M = 2_100;

/**
 * An OSM `ele` in metres, made plausible: unit suffixes are read ("5200 ft", "5200'", "1585 m"); a unitless value
 * above 2,100 m in eastern North America is taken as feet; anything above 8,850 m or below -440 m is dropped.
 */
export function plausibleEle(tag: string | undefined, at: [number, number] | number[] | null): number | undefined {
  const m = metres(tag);
  if (m === undefined) return undefined;
  const unitless = tag !== undefined && /^\s*-?[\d.,]+\s*$/.test(tag);
  let ele = m;
  if (unitless && at && m > EAST_NA_MAX_M) {
    const [lon, lat] = at;
    const [w, s, e, n] = EAST_NA;
    if (lon >= w && lon <= e && lat >= s && lat <= n) ele = Math.round(m * 0.3048 * 10) / 10;
  }
  return ele > ELE_MAX_M || ele < ELE_MIN_M ? undefined : ele;
}

/** Converts an Overpass `out tags center` response into points, one per OSM element, skipping anything unusable. */
export function normalizeFeatures(json: unknown, allowed: readonly Kind[] = KINDS): FeatureCollection<Point> {
  const features: Feature<Point>[] = [];
  const parsed = overpassBodySchema.safeParse(json);
  if (!parsed.success) return { type: "FeatureCollection", features };
  const seen = new Set<string>();

  for (const raw of parsed.data.elements) {
    const node = nodeElementSchema.safeParse(raw);
    const way = node.success ? null : wayElementSchema.safeParse(raw);
    const rel = node.success || way?.success ? null : relationElementSchema.safeParse(raw);
    const el = node.success ? node.data : way?.success ? way.data : rel?.success ? rel.data : null;
    if (el === null) continue;
    const osmId = `${el.type}/${el.id}`;
    if (seen.has(osmId)) continue;
    const tags = el.tags ?? {};
    const kind = classify(tags, allowed);
    const center = elementCenter(el);
    if (kind === null || center === null) continue;
    seen.add(osmId);

    const properties: Props = { kind, osmId };
    if (tags.name) properties.name = tags.name;
    const ele = plausibleEle(tags.ele, center);
    if (ele !== undefined) properties.ele = ele;
    if (kind === "peak" && ele !== undefined) properties.v = ele;
    const capacity = wholeNumber(tags.capacity) ?? wholeNumber(tags.beds);
    if (capacity !== undefined && capacity > 0) properties.capacity = capacity;
    if (kind === "shelter" && tags.shelter_type) properties.shelterType = tags.shelter_type;
    if (kind === "spring" || kind === "drinking_water") {
      const potable = yesNo(tags.drinking_water);
      if (potable !== undefined) properties.potable = potable;
      else if (kind === "drinking_water") properties.potable = true;
    }
    if (tags.seasonal) properties.seasonal = tags.seasonal;
    if (kind === "waterfall") {
      const height = metres(tags.height);
      if (height !== undefined) properties.heightM = height;
    }
    const fee = yesNo(tags.fee);
    if (fee !== undefined) properties.fee = fee;
    if (kind === "hut" && tags.reservation) properties.reservation = tags.reservation;
    if (tags.wikidata) properties.wikidata = tags.wikidata;
    if (tags.wikipedia) properties.wikipedia = tags.wikipedia;
    const t = checkedOn(tags);
    if (t !== undefined) properties.t = t;

    features.push({ type: "Feature", geometry: { type: "Point", coordinates: center }, properties });
  }
  return { type: "FeatureCollection", features: dropMappedTwice(features) };
}

/**
 * Two elements of one kind and name closer than this are one place mapped twice in OSM (the eval's duplicates rule
 * uses the same 300 m: lib/checks/mapChecks.ts DISTINCT_OSM_KM). Two viewpoints "Urbo kalnas" 226 m apart are one
 * hill's viewpoint mapped twice; upper and lower falls 680 m apart are two places.
 */
export const SAME_PLACE_M = 300;

/**
 * One place mapped twice (two waterfall nodes "Chutes Voltaire" 36 m apart, a peak as a node and a summit cross) is drawn
 * once: of features with the same kind and name within SAME_PLACE_M, the one with a Wikidata link (else the first) stays.
 */
export function dropMappedTwice(features: Feature<Point>[]): Feature<Point>[] {
  const kept: Feature<Point>[] = [];
  const metres = (a: Feature<Point>, b: Feature<Point>) => {
    const [x1, y1] = a.geometry.coordinates;
    const [x2, y2] = b.geometry.coordinates;
    return Math.hypot((x2 - x1) * 111_320 * Math.cos((y1 * Math.PI) / 180), (y2 - y1) * 110_570);
  };
  const ordered = [...features].sort((a, b) => Number(Boolean(b.properties?.wikidata)) - Number(Boolean(a.properties?.wikidata)));
  for (const f of ordered) {
    const name = f.properties?.name;
    const twin =
      typeof name === "string" &&
      kept.some((k) => k.properties?.name === name && k.properties?.kind === f.properties?.kind && metres(k, f) <= SAME_PLACE_M);
    if (!twin) kept.push(f);
  }
  // Back in the order Overpass sent them.
  return features.filter((f) => kept.includes(f));
}

function priority(f: Feature): number {
  return KINDS.indexOf(f.properties?.kind as Kind);
}

/** Keeps the first `max` (MAX_POINTS by default) by kind priority, the highest peaks first within the peaks. */
function capPoints(features: Feature<Point>[], max: number = MAX_POINTS): Feature<Point>[] {
  const ele = (f: Feature) => (typeof f.properties?.v === "number" ? f.properties.v : -1);
  return [...features]
    .sort((a, b) => priority(a) - priority(b) || (a.properties?.kind === "peak" ? ele(b) - ele(a) : 0))
    .slice(0, max);
}

/**
 * "Returned 120 outdoor features (4 hut, 30 spring, ...); the box was not truncated" or the cut version. In a wide box
 * (`wide`) only the per-kind breakdown, since the run adds the named-of-total note itself.
 */
export function featuresNote(features: Feature[], matched: number, rawElements: number, capped: boolean, wide = false): string {
  const counts = new Map<string, number>();
  for (const f of features) {
    const kind = String(f.properties?.kind);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const breakdown = KINDS.filter((k) => counts.has(k))
    .map((k) => `${counts.get(k)} ${k}`)
    .join(", ");
  const fmt = (n: number) => n.toLocaleString("en-US");
  if (wide) return `By kind: ${breakdown || "none"}`;
  const head = `Returned ${fmt(features.length)} outdoor features${breakdown ? ` (${breakdown})` : ""}`;
  const cut = matched > rawElements || capped;
  return cut
    ? `${head}; the box was truncated (the lowest OpenStreetMap ids of each kind, at most ${fmt(MAX_PER_KIND)} per kind and ${fmt(MAX_POINTS)} in all; the box holds ${fmt(matched)} matches), zoom in or pick fewer kinds`
    : `${head}; the box was not truncated`;
}

/** The kinds a query asks for: the listed ones (plus peaks with includePeaks), else every kind but peaks unless asked. */
export function kindsFor(input: FeaturesInput): Kind[] {
  const listed = input.kinds ?? KINDS.filter((k) => k !== "peak");
  return KINDS.filter((k) => listed.includes(k) || (k === "peak" && input.includePeaks === true));
}

/** The lower 48, Alaska and Hawaii as boxes: a view centred in one reads feet first. */
const US_BOXES: BBox[] = [
  [-125, 24.4, -66.9, 49.4],
  [-170, 51, -129.9, 71.5],
  [-161, 18.8, -154.7, 22.4],
];

/** True when the box is centred in the United States, where elevations and heights read in feet first. */
export function usView(bbox: BBox): boolean {
  const [x, y] = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  return US_BOXES.some(([w, s, e, n]) => x >= w && x <= e && y >= s && y <= n);
}

const FT_PER_M = 3.28084;
const whole = (n: number) => Math.round(n).toLocaleString("en-US");

/** A height in metres in both systems, the reader's first: "10,712 ft (3,265 m)" in the US, "3,265 m (10,712 ft)" elsewhere. */
export function bothUnits(m: number, us: boolean): string {
  return us ? `${whole(m * FT_PER_M)} ft (${whole(m)} m)` : `${whole(m)} m (${whole(m * FT_PER_M)} ft)`;
}

/** Unnamed features within this distance of a named one are titled after it ("Spring near Hagerman Pass"). */
export const NEAR_KM = 5;

/**
 * Ready for the map and the card: elevation and waterfall height as text in both units (feet first in a US view),
 * a heading for unnamed features from the nearest named one within NEAR_KM ("Viewpoint near Skinner Hut"), and the
 * named features first in kind priority order (huts, shelters, springs before viewpoints), so the labels, which go to
 * the first named features, name huts and springs.
 */
export function presentFeatures(features: Feature<Point>[], us: boolean): Feature<Point>[] {
  const named = features.filter((f) => typeof f.properties?.name === "string");
  const km = (a: Feature<Point>, b: Feature<Point>) => {
    const [x1, y1] = a.geometry.coordinates;
    const [x2, y2] = b.geometry.coordinates;
    return Math.hypot((x2 - x1) * 111.32 * Math.cos((y1 * Math.PI) / 180), (y2 - y1) * 110.57);
  };
  const out = features.map((f) => {
    const p = { ...(f.properties ?? {}) } as Props;
    if (typeof p.ele === "number") p.elevation = bothUnits(p.ele, us);
    if (typeof p.heightM === "number") p.fallHeight = bothUnits(p.heightM, us);
    if (typeof p.name !== "string") {
      let best: { name: string; d: number } | null = null;
      for (const n of named) {
        const d = km(f, n);
        if (d <= NEAR_KM && (best === null || d < best.d)) best = { name: String(n.properties?.name), d };
      }
      const noun = KIND_LABELS[p.kind as Kind] ?? "Backcountry feature";
      p.heading = best ? `${noun} near ${best.name}` : noun;
    }
    return { ...f, properties: p };
  });
  const rank = (f: Feature) => (typeof f.properties?.name === "string" ? 0 : 1);
  return out
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f) - rank(b.f) || priority(a.f) - priority(b.f) || a.i - b.i)
    .map(({ f }) => f);
}

/** Each kind in words for the card. */
const KIND_LABELS: Record<Kind, string> = {
  hut: "Hut",
  shelter: "Shelter",
  hot_spring: "Hot spring",
  spring: "Spring",
  waterfall: "Waterfall",
  cave: "Cave entrance",
  pass: "Mountain pass",
  saddle: "Saddle",
  peak: "Peak",
  viewpoint: "Viewpoint",
  drinking_water: "Drinking water",
};

const ELEVATION: FieldHelp = {
  text: "Height above sea level as the mapper tagged it (OpenStreetMap ele, in metres), shown in feet and metres.",
  source: "OpenStreetMap wiki, Key:ele",
  url: "https://wiki.openstreetmap.org/wiki/Key:ele",
};

const HELP: Record<string, FieldHelp> = {
  ele: ELEVATION,
  elevation: ELEVATION,
  v: ELEVATION,
  fallHeight: { text: "How tall the waterfall is, as mapped (OpenStreetMap height, in metres), shown in feet and metres." },
  potable: {
    text: "Whether the water is mapped as safe to drink (OpenStreetMap drinking_water); a mapped spring is not tested water, so treat wild water before drinking.",
    source: "OpenStreetMap wiki, Key:drinking_water",
    url: "https://wiki.openstreetmap.org/wiki/Key:drinking_water",
  },
  capacity: { text: "How many beds or places the hut or shelter has, as mapped (OpenStreetMap capacity or beds)." },
  seasonal: { text: "Whether the feature is only there or open part of the year, as mapped (OpenStreetMap seasonal), sometimes naming the seasons." },
  reservation: { text: "Whether the hut takes or needs a booking, as mapped (OpenStreetMap reservation); prices and dates are not included." },
};

/** The kind chips, in the order the row shows them; passes and saddles share one chip. */
const KIND_LEVELS: AttributeLevel[] = [
  { value: "hut", label: "Huts and cabins", help: "Alpine and wilderness huts, bothies and cabins you can sleep in." },
  { value: "shelter", label: "Shelters", help: "Open shelters and lean-tos for weather, not bus or picnic shelters." },
  { value: "drinking_water", label: "Drinking water", help: "Taps, fountains and pumps." },
  { value: "spring", label: "Springs", help: "Natural springs; a mapped spring is not tested water." },
  { value: "hot_spring", label: "Hot springs" },
  { value: "waterfall", label: "Waterfalls" },
  { value: "cave", label: "Caves", help: "Cave entrances." },
  { value: "peak", label: "Peaks", help: "Named summits; left out unless asked for, since the basemap already names them." },
  { value: "pass", label: "Passes and saddles" },
  { value: "saddle", label: "Passes and saddles" },
  { value: "viewpoint", label: "Viewpoints", help: "Scenic overlooks." },
];

/**
 * No measure: elevation in metres sized every marker by default ("Rank by" picks the first measure), which tells someone
 * looking for a hut or a spring nothing, so features draw as kind symbols and elevation is a card fact.
 */
const ATTRIBUTES: Attribute[] = [
  { key: "kind", type: "category", label: "Kind", primary: true, levels: KIND_LEVELS },
  { key: "potable", type: "flag", label: "Mapped safe to drink", help: HELP.potable },
  nameAttribute(),
];

/** What the map draws: one point per feature, sorted into these kinds. */
const LEGEND: LegendSpec = {
  kind: "categories",
  title: "Kind",
  field: "kind",
  items: KIND_LEVELS.filter((l, i) => KIND_LEVELS.findIndex((m) => m.label === l.label) === i).map((l) => ({
    label: l.label,
    value: l.value,
    symbol: "point" as const,
    ...(l.help && { help: l.help }),
  })),
  note: "Peaks are left out unless asked for; the basemap already names them.",
};

const CARD: CardSpec = {
  facts: [
    { key: "kind", label: "Type", values: KIND_LABELS },
    // Feet and metres, feet first in a US view (presentFeatures), whenever the mapper gave an elevation (a saddle too).
    { key: "elevation", label: "Elevation", help: ELEVATION },
    { key: "fallHeight", label: "Waterfall height" },
    { key: "capacity", label: "Beds or places", format: "int" },
    {
      key: "shelterType",
      label: "Shelter",
      values: {
        basic_hut: "Basic hut",
        weather_shelter: "Weather shelter",
        lean_to: "Lean-to",
        rock_shelter: "Rock shelter",
        field_shelter: "Field shelter",
        sun_shelter: "Sun shelter",
        pavilion: "Pavilion",
        changing_rooms: "Changing rooms",
      },
    },
    { key: "potable", label: "Safe to drink" },
    { key: "fee", label: "Fee" },
    {
      key: "reservation",
      label: "Booking",
      values: { required: "Required", recommended: "Recommended", yes: "Taken", no: "Not taken", members_only: "Members only" },
    },
    {
      key: "seasonal",
      label: "Seasonal",
      format: "list",
      values: { yes: "Yes", no: "No", spring: "Spring", summer: "Summer", autumn: "Autumn", winter: "Winter", wet_season: "Wet season", dry_season: "Dry season" },
    },
    { key: "wikipedia", label: "Wikipedia article" },
    { key: "wikidata", label: "Wikidata item" },
  ],
  // The OpenStreetMap id and the raw metres are plumbing; the elevation line already shows both units.
  hidden: ["osmId", "ele", "heightM"],
};

const outdoorFeatures = defineLayer({
  id: "outdoor-features",
  title: "Huts, springs, peaks and other backcountry features",
  description:
    "Backcountry points of interest from OpenStreetMap, anywhere in the world, one point each with kind to filter on. " +
    "Peaks are left out by default because the basemap already labels them: set includePeaks true, or list 'peak' in kinds, when the question is about peaks or summits. Kinds: " +
    "'hut' (alpine and wilderness huts, bothies and cabins you can sleep in), 'shelter' (open shelters and lean-tos, not bus stops), " +
    "'spring' and 'drinking_water' (natural springs and water sources: taps, fountains and pumps; potable says whether the water is mapped as safe to drink), 'hot_spring' (natural hot springs), " +
    "'waterfall' (heightM when mapped), 'cave' (cave entrances), 'peak' (named mountain peaks and summits, with ele in metres, and v = the elevation so taller peaks draw taller), 'saddle' and 'pass' (named saddles and mountain passes) and 'viewpoint' (scenic overlooks). " +
    "Also name, ele (metres), capacity (beds or places) for huts and shelters, fee, seasonal, and the date last checked (t) when mapped. " +
    "Use it for questions like: where are the huts or shelters on this route, where can I find a water source or spring, what are the peaks and summits around here, where are hot springs or waterfalls, or find viewpoints and caves nearby. " +
    "Pass kinds (for example ['hut', 'spring']) to get only those. Elevations and waterfall heights read in feet first with metres second in a US view. " +
    "Caveats: volunteer-mapped, so it misses features and some are out of date; springs and taps can be dry or seasonal and a mapped spring is not tested water, so treat any wild water as needing treatment; " +
    "hut bookings, prices and winter status are not included; peaks and saddles need a name to be listed and elevations come from mapper data (peaks has Wikidata elevation and prominence for notable summits). " +
    "Over 10,000 km² it lists up to 2,000 named features (unnamed ones left out) and how many there are in all. Within a kind the query keeps the lowest OpenStreetMap ids, not the tallest or nearest (peaks that have an elevation are fetched first, up to 2,000, then up to 1,000 without one): each kind is cut at 1,000 and the whole result at 5,000, and if the 5,000 cap bites, huts, shelters and springs are kept first and the tallest of the fetched peaks. The coverage note gives the count and says if it was cut.",
  coverage: "global",
  surface: "land",
  license: "ODbL (OpenStreetMap contributors)",
  requiredEnv: [],
  optionalEnv: ["OVERPASS_URL"],
  maxAreaKm2: ALL_KINDS_MAX_AREA_KM2,
  // Named-only listing with counts; the Alps (about 320,000 km²) is well inside it.
  hardMaxAreaKm2: 1_500_000,
  wide: { mode: "named", limit: 2000 },
  input: inputSchema,
  // M4 hint: extrude v (peaks), cluster (Task 0's StyleHints fields).
  style: { geometry: "point", color: layerColor("outdoor-features"), extrude: "v", cluster: true },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  // Places, not readings: the check_date in `t` is when a mapper last looked, not a time to scrub.
  time: { shape: "none" },
  legend: LEGEND,
  // The first named features, which presentFeatures puts in kind priority order: huts, shelters and springs first.
  labels: { field: "name", max: 8 },

  async query(ctx, input: FeaturesInput): Promise<LayerResult | LayerError> {
    const kinds = kindsFor(input);
    const us = usView(ctx.bbox);
    const peaksNote = kinds.includes("peak") ? "" : "; peaks are left out (the basemap names them), ask for peaks to add them";
    const cacheKinds = KINDS.filter((k) => kinds.includes(k)).join(",");

    // Wide: one named-only set over every requested kind, bounded by the strategy's limit; the first count is the total.
    if (ctx.wide) {
      const limit = Math.min(MAX_POINTS, ctx.wideStrategy?.limit ?? 2000);
      const wide = await overpassQuery(ctx, buildWideFeaturesQuery(ctx.bbox, kinds, Math.min(MAX_PER_KIND, limit)), {
        cacheSuffix: `outdoor-features:named:${cacheKinds}`,
      });
      if (!wide.ok) return { error: wide.error, hint: "upstream" };
      const features = presentFeatures(capPoints(normalizeFeatures(wide.json, kinds).features, limit), us);
      const [all] = overpassCounts(wide.json);
      return {
        kind: "geojson",
        data: { type: "FeatureCollection", features },
        ...(all !== undefined && { total: all }),
        coverageNote: featuresNote(features, all ?? features.length, features.length, false, true) + peaksNote,
        citation: osmCitation(),
      };
    }

    const result = await overpassQuery(ctx, buildFeaturesQuery(ctx.bbox, kinds), {
      cacheSuffix: `outdoor-features:${cacheKinds}`,
    });
    if (!result.ok) return { error: result.error, hint: "upstream" };

    const all = normalizeFeatures(result.json, kinds);
    const rawReturned = all.features.length;
    const body = overpassBodySchema.parse(result.json).elements;
    const rawElements = body.filter((e) => (e as { type?: unknown }).type !== "count").length;
    const matched = countedTotal(result.json) ?? rawElements;
    const capped = rawReturned > MAX_POINTS;
    const features = presentFeatures(capped ? capPoints(all.features) : all.features, us);

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      coverageNote: featuresNote(features, matched, rawElements, capped) + peaksNote,
      citation: osmCitation(),
    };
  },
});

registerLayer(outdoorFeatures);

export default outdoorFeatures;
