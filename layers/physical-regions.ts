/**
 * Named physical regions (mountain ranges, deserts, plains, plateaus, basins, peninsulas, islands) from
 * Natural Earth's 10m geography regions polygons. The file is loaded once per process by
 * lib/agent/naturalEarth.ts (cache key "ne:regions", 24 hours), so a query never waits on more than the first
 * download. Source file, property names and quirks are documented there. Properties returned per polygon:
 *   name (English name), kind (see KINDS), featureClass (Natural Earth's own class, e.g. "Range/mtn"),
 *   region and subregion (continent and sub-continent, when set), and altName (an alternative name, when set).
 * There is no time dimension, so features carry no `t`; `areaKm2` is the outline's area, computed here.
 * Drawing (2026-10-18): `kind` is the color category (REGION_LEGEND: ranges purple, deserts pink, plains sage and so on) with
 * a light tint, and the regions' names are labelled on the map, so the Rockies read apart from the Great Plains without a click.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import {
  featureBBoxes,
  loadNaturalEarthRegions,
  regionDisplayName,
  regionFeatureClass,
  regionProp,
  regionRank,
} from "@/lib/agent/naturalEarth";
import { bboxAreaKm2, defineLayer, type Attribute, type BBox, type CardSpec, type FieldHelp, type LayerError, type LayerResult, type LegendSpec } from "./types";
import { registerLayer } from "./registry";
import { bboxesDisjoint } from "./_shared/coverage";
import { pointInPolygon } from "./_shared/geo";
import { DARK_GREY, layerColor, PINK, PURPLE, SAGE, SURFACE } from "@/lib/render/palette";
import { interpolateStops, rgbToHex } from "@/lib/render/ramp";

const KINDS = ["range", "desert", "plain", "plateau", "basin", "peninsula", "island", "other"] as const;
export type RegionKind = (typeof KINDS)[number];

/** Larger results are slow to send and unreadable on a map; the most prominent regions are kept. */
const MAX_FEATURES = 150;
const TRUNCATED_NOTE = `Showing the ${MAX_FEATURES} most prominent regions; zoom in or pick kinds for the rest`;

/**
 * Feature classes never returned: the seven continents (each covers a whole map and would top every list),
 * and the single "Dragons-be-here" placeholder.
 */
const EXCLUDED_CLASSES = new Set(["continent", "dragons-be-here"]);

/** Maps a Natural Earth feature class (FEATURECLA) to a kind. "Pen/cape" is how the file spells most peninsulas. */
export function regionKind(featureClass: string | undefined): RegionKind {
  switch (featureClass?.toLowerCase()) {
    case "range/mtn":
      return "range";
    case "desert":
      return "desert";
    case "plain":
      return "plain";
    case "plateau":
      return "plateau";
    case "basin":
      return "basin";
    case "peninsula":
    case "pen/cape":
      return "peninsula";
    case "island":
    case "island group":
      return "island";
    default:
      return "other";
  }
}

const mix = (a: string, b: string) => rgbToHex(interpolateStops([a, b], 0.5));

/** Each kind in words and its fill. */
export const KIND_LEVELS: { value: RegionKind; label: string; color: string }[] = [
  { value: "range", label: "Mountain range", color: PURPLE },
  { value: "desert", label: "Desert", color: PINK },
  { value: "plain", label: "Plain", color: SAGE },
  { value: "plateau", label: "Plateau", color: mix(SAGE, DARK_GREY) },
  { value: "basin", label: "Basin", color: mix(PURPLE, SAGE) },
  { value: "peninsula", label: "Peninsula", color: mix(PINK, PURPLE) },
  { value: "island", label: "Island or island group", color: DARK_GREY },
  { value: "other", label: "Other landform (valley, lowland, delta, coast...)", color: SURFACE },
];

export const REGION_LEGEND: LegendSpec = {
  kind: "categories",
  title: "Landform",
  field: "kind",
  items: KIND_LEVELS.map(({ value, label, color }) => ({ label, value, color, symbol: "polygon" as const })),
  note: "Approximate outlines at about 1:10 million; neighbouring regions overlap.",
};

const ATTRIBUTES: Attribute[] = [
  { key: "kind", type: "category", label: "Landform", levels: KIND_LEVELS.map(({ value, label }) => ({ value, label })), encode: "color", primary: true },
  { key: "areaKm2", type: "measure", label: "Area", unit: "km²" },
  { key: "name", type: "name", label: "Name" },
];

function ringKm2(ring: Position[]): number {
  if (ring.length < 4) return 0;
  const meanLat = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
  const kx = 111.32 * Math.cos((meanLat * Math.PI) / 180);
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) sum += ring[i][0] * kx * ring[i + 1][1] * 110.57 - ring[i + 1][0] * kx * ring[i][1] * 110.57;
  return Math.abs(sum / 2);
}

/** A polygon's area in km² on a local flat projection (outer rings minus holes), rounded to three significant figures. */
export function regionAreaKm2(geometry: Geometry): number {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  const km2 = polygons.reduce((t, rings) => t + ringKm2(rings[0] ?? []) - rings.slice(1).reduce((h, r) => h + ringKm2(r), 0), 0);
  if (km2 <= 0) return 0;
  const digits = Math.max(0, Math.floor(Math.log10(km2)) - 2);
  return Math.round(km2 / 10 ** digits) * 10 ** digits;
}

const inputSchema = z.object({
  kinds: z.array(z.enum(KINDS)).optional(),
});

function bboxesIntersect(a: BBox, b: BBox): boolean {
  return !bboxesDisjoint(a, b);
}

/** True when the segment from `a` to `b` crosses the box (Liang-Barsky clipping). */
function segmentTouchesBox(a: Position, b: Position, [w, s, e, n]: BBox): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [
    [-dx, a[0] - w],
    [dx, e - a[0]],
    [-dy, a[1] - s],
    [dy, n - a[1]],
  ]) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * True when the region's outline itself reaches the box, not just its bounding box. Natural Earth's Polynesia is one
 * triangle from Hawaii to New Zealand to Easter Island whose box spans -180 to -106° and up to 26° N, so a box test put it
 * first in every view of the southern United States. A part counts when an outline edge crosses the box or the box sits
 * inside it (holes excluded).
 */
export function regionTouchesBox(geometry: Geometry, bbox: BBox): boolean {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  const center: Position = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  return polygons.some((rings) => {
    const outer = rings[0] ?? [];
    if (outer.length < 2) return false;
    for (let i = 0; i + 1 < outer.length; i++) if (segmentTouchesBox(outer[i], outer[i + 1], bbox)) return true;
    return pointInPolygon(center, { type: "Polygon", coordinates: rings });
  });
}

function toPolygonFeature(feature: Feature, kind: RegionKind): Feature<Geometry> | undefined {
  if (!feature.geometry) return undefined;
  const properties: Record<string, string> = {
    name: regionDisplayName(feature),
    kind,
  };
  const featureClass = regionFeatureClass(feature);
  if (featureClass !== undefined) properties.featureClass = featureClass;
  const region = regionProp(feature, "region");
  if (region !== undefined) properties.region = region;
  const subregion = regionProp(feature, "subregion");
  if (subregion !== undefined) properties.subregion = subregion;
  const altName = regionProp(feature, "namealt") ?? regionProp(feature, "name_alt");
  if (altName !== undefined) properties.altName = altName;
  const area = regionAreaKm2(feature.geometry);
  return { type: "Feature", geometry: feature.geometry, properties: area > 0 ? { ...properties, areaKm2: area } : properties };
}

/** Every Natural Earth feature class the file holds (read 2026-10-16), in words; continents are never returned. */
const FEATURE_CLASS_LABELS: Record<string, string> = {
  "Range/mtn": "Mountain range",
  Desert: "Desert",
  Plain: "Plain",
  Plateau: "Plateau",
  Basin: "Basin",
  Peninsula: "Peninsula",
  "Pen/cape": "Peninsula or cape",
  Island: "Island",
  "Island group": "Island group",
  Valley: "Valley",
  Lowland: "Lowland",
  Gorge: "Gorge",
  Delta: "Delta",
  Wetlands: "Wetlands",
  Coast: "Coast",
  Foothills: "Foothills",
  Tundra: "Tundra",
  Isthmus: "Isthmus",
  Depression: "Depression",
  Lake: "Lake",
  Geoarea: "Named region",
};

const HELP: Record<string, FieldHelp> = {
  featureClass: {
    text: "The kind of landform as Natural Earth classes it (its feature class), such as mountain range, desert, plateau or island group.",
    source: "Natural Earth, 10m geography regions",
    url: "https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-physical-labels/",
  },
};

const CARD: CardSpec = {
  measure: { key: "areaKm2", label: "Area", unit: "km²", help: { text: "The area of the outline, computed by this app; the outline is approximate, so treat it as a rough size." } },
  facts: [
    { key: "featureClass", label: "Landform", values: FEATURE_CLASS_LABELS },
    { key: "altName", label: "Also called" },
    { key: "region", label: "Continent or ocean" },
    { key: "subregion", label: "Part of" },
  ],
  /** Kind is the landform grouped for filtering (range, desert ... other). */
  hidden: ["kind"],
};

const physicalRegions = defineLayer({
  id: "physical-regions",
  title: "Named physical regions",
  description:
    "Outlines of named natural regions of the world from Natural Earth: mountain ranges (the Andes, the Alps, the Sierra Nevada), deserts, plains, plateaus, basins, peninsulas and islands. " +
    "Each polygon has name, kind (range, desert, plain, plateau, basin, peninsula, island or other), featureClass (Natural Earth's own label), areaKm2 (the outline's rough area), and region and subregion (the continent) when known. " +
    "The map tints each region by kind with a legend (ranges purple, deserts pink, plains sage) and prints the names of the most prominent. " +
    "Use it to answer 'where is the X range' or to outline a whole landscape when the user names one. Pass kinds, for example ['range'] or ['desert', 'plateau'], to show only those types; leave it out to see every kind. " +
    "Anywhere in the world. Caveats: the outlines are approximate and generalised, drawn at about 1:10 million scale, so they show roughly where a region is and have no exact edge; neighbouring regions overlap. " +
    "A range polygon covers the foothills and valleys around the peaks, not just the high ground. Only well-known regions are included, and small ranges or local landforms will be missing; whole continents are left out. " +
    "Each call returns at most 150 regions, the most prominent first, and says so when it cuts the list. " +
    "Zoom in to a region under 30,000,000 km² (about a continent) first. Features have no dates.",
  coverage: "global",
  surface: "any",
  license: "Public domain (Natural Earth)",
  requiredEnv: [],
  maxAreaKm2: 30_000_000,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("physical-regions"), fillOpacity: 0.1 },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  legend: REGION_LEGEND,
  // The answer is a name: label the most prominent regions (source order is most prominent first).
  labels: { field: "name", max: 12 },
  time: { shape: "none" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    let fc: FeatureCollection;
    try {
      fc = await loadNaturalEarthRegions(ctx.fetch);
    } catch (err) {
      return {
        error: `Natural Earth regions are unavailable: ${err instanceof Error ? err.message : String(err)}`,
        hint: "upstream",
      };
    }

    const wanted = input.kinds && input.kinds.length > 0 ? new Set<RegionKind>(input.kinds) : undefined;
    const boxes = featureBBoxes(fc);
    const matches: { feature: Feature<Geometry>; rank: number; area: number }[] = [];
    fc.features.forEach((feature, i) => {
      if (!bboxesIntersect(boxes[i], ctx.bbox) || !feature.geometry || !regionTouchesBox(feature.geometry, ctx.bbox)) return;
      const featureClass = regionFeatureClass(feature);
      if (featureClass !== undefined && EXCLUDED_CLASSES.has(featureClass.toLowerCase())) return;
      const kind = regionKind(featureClass);
      if (wanted && !wanted.has(kind)) return;
      const out = toPolygonFeature(feature, kind);
      if (out) matches.push({ feature: out, rank: regionRank(feature), area: bboxAreaKm2(boxes[i]) });
    });

    // Most prominent first, then the larger region.
    matches.sort((a, b) => a.rank - b.rank || b.area - a.area);
    const truncated = matches.length > MAX_FEATURES;

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features: matches.slice(0, MAX_FEATURES).map((m) => m.feature) },
      citation: {
        source: "Natural Earth 10m physical labels: geography regions (public domain)",
        url: "https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-physical-labels/",
        retrieved: new Date().toISOString(),
      },
      ...(truncated ? { coverageNote: TRUNCATED_NOTE } : {}),
    };
  },
});

registerLayer(physicalRegions);

export default physicalRegions;
