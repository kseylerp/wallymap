/**
 * Backcountry points of interest from OpenStreetMap via one Overpass query with one set per kind, each cut at 1,000:
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
 * Live smoke check: Desolation Wilderness / Lake Tahoe south-west (38.8,-120.3 to 39.1,-119.9), 2026-10-09: 136 features (4 hut, 1 shelter, 8 spring, 12 waterfall, 8 pass or saddle, 57 peak, 31 viewpoint, 15 drinking_water), no truncation.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { overpassQuery } from "./_shared/overpass";
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

/** Most elements Overpass returns for each kind. */
export const MAX_PER_KIND = 1_000;
/** Most points returned in all. */
export const MAX_POINTS = 5_000;

const inputSchema = z.object({
  /** Only these kinds; all kinds when left out. */
  kinds: z.array(z.enum(KINDS)).min(1).optional(),
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
  peak: ['node["natural"="peak"]["name"]'],
  viewpoint: ['nwr["tourism"="viewpoint"]'],
  drinking_water: ['nwr["amenity"="drinking_water"]'],
};

/** Overpass QL: one set per requested kind, an `out count` for each, then the elements. */
export function buildFeaturesQuery(bbox: BBox, kinds: readonly Kind[] = KINDS): string {
  const area = bboxClause(bbox);
  const wanted = KINDS.filter((k) => kinds.includes(k));
  const sets = wanted.map((k) => `(${SELECTORS[k].map((s) => `${s}${area};`).join("")})->.${k};`).join("");
  const counts = wanted.map((k) => `.${k} out count;`).join("");
  const lists = wanted.map((k) => `.${k} out tags center ${MAX_PER_KIND};`).join("");
  return `[out:json][timeout:25];${sets}${counts}${lists}`;
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
    const ele = metres(tags.ele);
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
  return { type: "FeatureCollection", features };
}

function priority(f: Feature): number {
  return KINDS.indexOf(f.properties?.kind as Kind);
}

/** Keeps the first MAX_POINTS by kind priority, the highest peaks first within the peaks. */
function capPoints(features: Feature<Point>[]): Feature<Point>[] {
  const ele = (f: Feature) => (typeof f.properties?.v === "number" ? f.properties.v : -1);
  return [...features]
    .sort((a, b) => priority(a) - priority(b) || (a.properties?.kind === "peak" ? ele(b) - ele(a) : 0))
    .slice(0, MAX_POINTS);
}

/** "Returned 120 outdoor features (4 hut, 30 spring, ...); the box was not truncated" or the cut version. */
export function featuresNote(features: Feature[], matched: number, rawElements: number, capped: boolean): string {
  const counts = new Map<string, number>();
  for (const f of features) {
    const kind = String(f.properties?.kind);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const breakdown = KINDS.filter((k) => counts.has(k))
    .map((k) => `${counts.get(k)} ${k}`)
    .join(", ");
  const fmt = (n: number) => n.toLocaleString("en-US");
  const head = `Returned ${fmt(features.length)} outdoor features${breakdown ? ` (${breakdown})` : ""}`;
  const cut = matched > rawElements || capped;
  return cut
    ? `${head}; the box was truncated (at most ${fmt(MAX_PER_KIND)} per kind and ${fmt(MAX_POINTS)} in all; the box holds ${fmt(matched)} matches), zoom in or pick fewer kinds`
    : `${head}; the box was not truncated`;
}

const outdoorFeatures = defineLayer({
  id: "outdoor-features",
  title: "Huts, springs, peaks and other backcountry features",
  description:
    "Backcountry points of interest from OpenStreetMap, anywhere in the world, one point each with kind to filter on: " +
    "'hut' (alpine and wilderness huts, bothies and cabins you can sleep in), 'shelter' (open shelters and lean-tos, not bus stops), " +
    "'spring' and 'drinking_water' (natural springs and water sources: taps, fountains and pumps; potable says whether the water is mapped as safe to drink), 'hot_spring' (natural hot springs), " +
    "'waterfall' (heightM when mapped), 'cave' (cave entrances), 'peak' (named mountain peaks and summits, with ele in metres, and v = the elevation so taller peaks draw taller), 'saddle' and 'pass' (named saddles and mountain passes) and 'viewpoint' (scenic overlooks). " +
    "Also name, ele (metres), capacity (beds or places) for huts and shelters, fee, seasonal, and the date last checked (t) when mapped. " +
    "Use it for questions like: where are the huts or shelters on this route, where can I find a water source or spring, what are the peaks and summits around here, where are hot springs or waterfalls, or find viewpoints and caves nearby. " +
    "Pass kinds (for example ['hut', 'spring']) to get only those. " +
    "Caveats: volunteer-mapped, so it misses features and some are out of date; springs and taps can be dry or seasonal and a mapped spring is not tested water, so treat any wild water as needing treatment; " +
    "hut bookings, prices and winter status are not included; peaks and saddles need a name to be listed and elevations come from mapper data (peaks has Wikidata elevation and prominence for notable summits). " +
    "Zoom in to a region under 10,000 km² first. Each kind is cut at 1,000 and the whole result at 5,000 (huts, shelters, springs and hot springs are kept first, the highest peaks first among peaks), and the coverage note says if it was cut.",
  coverage: "global",
  license: "ODbL (OpenStreetMap contributors)",
  requiredEnv: [],
  optionalEnv: ["OVERPASS_URL"],
  maxAreaKm2: 10_000,
  input: inputSchema,
  // M4 hint: extrude v (peaks), cluster (Task 0's StyleHints fields).
  style: { geometry: "point", color: layerColor("outdoor-features"), extrude: "v", cluster: true },

  async query(ctx, input: FeaturesInput): Promise<LayerResult | LayerError> {
    const area = bboxAreaKm2(ctx.bbox);
    if (area > outdoorFeatures.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${outdoorFeatures.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    const kinds = input.kinds ?? KINDS;
    const result = await overpassQuery(ctx, buildFeaturesQuery(ctx.bbox, kinds), {
      cacheSuffix: `outdoor-features:${KINDS.filter((k) => kinds.includes(k)).join(",")}`,
    });
    if (!result.ok) return { error: result.error, hint: "upstream" };

    const all = normalizeFeatures(result.json, kinds);
    const rawReturned = all.features.length;
    const body = overpassBodySchema.parse(result.json).elements;
    const rawElements = body.filter((e) => (e as { type?: unknown }).type !== "count").length;
    const matched = countedTotal(result.json) ?? rawElements;
    const capped = rawReturned > MAX_POINTS;
    const features = capped ? capPoints(all.features) : all.features;

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      coverageNote: featuresNote(features, matched, rawElements, capped),
      citation: osmCitation(),
    };
  },
});

registerLayer(outdoorFeatures);

export default outdoorFeatures;
