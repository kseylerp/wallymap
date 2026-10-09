/**
 * Named physical regions (mountain ranges, deserts, plains, plateaus, basins, peninsulas, islands) from
 * Natural Earth's 10m geography regions polygons. The file is loaded once per process by
 * lib/agent/naturalEarth.ts (cache key "ne:regions", 24 hours), so a query never waits on more than the first
 * download. Source file, property names and quirks are documented there. Properties returned per polygon:
 *   name (English name), kind (see KINDS), featureClass (Natural Earth's own class, e.g. "Range/mtn"),
 *   region and subregion (continent and sub-continent, when set), and altName (an alternative name, when set).
 * There is no time dimension, so features carry no `t` or `v`.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import {
  featureBBoxes,
  loadNaturalEarthRegions,
  regionDisplayName,
  regionFeatureClass,
  regionProp,
  regionRank,
} from "@/lib/agent/naturalEarth";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { bboxesDisjoint } from "./_shared/coverage";

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

const inputSchema = z.object({
  kinds: z.array(z.enum(KINDS)).optional(),
});

function bboxesIntersect(a: BBox, b: BBox): boolean {
  return !bboxesDisjoint(a, b);
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
  return { type: "Feature", geometry: feature.geometry, properties };
}

const physicalRegions = defineLayer({
  id: "physical-regions",
  title: "Named physical regions",
  description:
    "Outlines of named natural regions of the world from Natural Earth: mountain ranges (the Andes, the Alps, the Sierra Nevada), deserts, plains, plateaus, basins, peninsulas and islands. " +
    "Each polygon has name, kind (range, desert, plain, plateau, basin, peninsula, island or other), featureClass (Natural Earth's own label), and region and subregion (the continent) when known. " +
    "Use it to answer 'where is the X range' or to outline a whole landscape when the user names one. Pass kinds, for example ['range'] or ['desert', 'plateau'], to show only those types; leave it out to see every kind. " +
    "Anywhere in the world. Caveats: the outlines are approximate and generalised, drawn at about 1:10 million scale, so they show roughly where a region is and have no exact edge; neighbouring regions overlap. " +
    "A range polygon covers the foothills and valleys around the peaks, not just the high ground. Only well-known regions are included, and small ranges or local landforms will be missing; whole continents are left out. " +
    "Each call returns at most 150 regions, the most prominent first, and says so when it cuts the list. " +
    "Zoom in to a region under 30,000,000 km² (about a continent) first. Features have no dates.",
  coverage: "global",
  license: "Public domain (Natural Earth)",
  requiredEnv: [],
  maxAreaKm2: 30_000_000,
  input: inputSchema,
  style: { geometry: "polygon", color: "#FFFFFF", fillOpacity: 0 },

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
      if (!bboxesIntersect(boxes[i], ctx.bbox)) return;
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
