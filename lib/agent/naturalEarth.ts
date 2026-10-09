/**
 * Natural Earth physical regions (mountain ranges, deserts, plateaus, basins, peninsulas, islands, ...) used to
 * answer "show me the Andes" when Mapbox geocoding only finds a town or a point of that name, and by the
 * `physical-regions` layer.
 *
 * Source (verified 2026-10-09): ne_10m_geography_regions_polys.geojson in nvkelso/natural-earth-vector, a 5.6 MB
 * FeatureCollection of 1,047 Polygon / MultiPolygon features. Property keys are UPPER CASE in the real file:
 *   NAME (often shouting, e.g. "SIERRA NEVADA"; some are mixed case, e.g. "S. Nevada"), NAME_EN (English name,
 *   always set), NAMEALT (alternative name, set on 17 features), FEATURECLA ("Range/mtn", "Desert", "Plain",
 *   "Plateau", "Basin", "Pen/cape", "Peninsula", "Island", "Island group", "Geoarea", ...), SCALERANK (0 most
 *   important to 5), REGION, SUBREGION. Lower-case keys are read too, in case the file is ever regenerated.
 * Names are not unique: "Sierra Nevada" is both NAME "SIERRA NEVADA" (California) and NAME_EN of "S. Nevada"
 * (Spain), so findRegion prefers a match on NAME, then NAME_EN, then NAMEALT.
 */
import type { Feature, FeatureCollection } from "geojson";
import { UPSTREAM_TIMEOUT_MS } from "@/layers/_shared/constants";
import type { BBox } from "@/layers/types";
import { createLayerFetch, type CachedFetch } from "@/lib/fetch";

export const NATURAL_EARTH_REGIONS_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_geography_regions_polys.geojson";

const CACHE_KEY = "ne:regions";
const TTL_SECONDS = 86_400;

let loading: Promise<FeatureCollection> | undefined;

// Each feature's bbox is computed once per collection, so the layer's intersection test stays cheap.
const bboxCache = new WeakMap<FeatureCollection, BBox[]>();

function isFeatureCollection(value: unknown): value is FeatureCollection {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "FeatureCollection" &&
    "features" in value &&
    Array.isArray(value.features)
  );
}

/** Walks any nested GeoJSON coordinate array and widens `box` to cover every [lon, lat] position in it. */
function extend(box: BBox, coords: unknown): void {
  if (!Array.isArray(coords)) return;
  const [x, y] = coords as unknown[];
  if (typeof x === "number" && typeof y === "number") {
    if (x < box[0]) box[0] = x;
    if (y < box[1]) box[1] = y;
    if (x > box[2]) box[2] = x;
    if (y > box[3]) box[3] = y;
    return;
  }
  for (const c of coords) extend(box, c);
}

function computeBBox(feature: Feature): BBox {
  const box: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  const g = feature.geometry;
  if (g && "coordinates" in g) extend(box, g.coordinates);
  return box;
}

/** One bbox per feature, in feature order, computed once per collection. Features without geometry get an inverted (empty) box. */
export function featureBBoxes(fc: FeatureCollection): BBox[] {
  let boxes = bboxCache.get(fc);
  if (!boxes) {
    boxes = fc.features.map(computeBBox);
    bboxCache.set(fc, boxes);
  }
  return boxes;
}

/** The bbox of one feature's geometry. */
export function featureBBox(feature: Feature): BBox {
  return computeBBox(feature);
}

async function download(fetch: CachedFetch): Promise<FeatureCollection> {
  const res = await fetch(NATURAL_EARTH_REGIONS_URL, {
    cacheKey: CACHE_KEY,
    ttlSeconds: TTL_SECONDS,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Natural Earth regions download returned ${res.status}`);
  const json: unknown = await res.json();
  if (!isFeatureCollection(json)) throw new Error("Natural Earth regions download is not a FeatureCollection");
  featureBBoxes(json);
  return json;
}

/**
 * Loads the regions once per process (concurrent callers share one request). A failed load is not remembered,
 * so the next call retries. `fetch` defaults to a rate-limited, cached fetch for the "natural-earth" source.
 */
export function loadNaturalEarthRegions(fetch?: CachedFetch): Promise<FeatureCollection> {
  if (!loading) {
    const attempt = download(fetch ?? createLayerFetch("natural-earth"));
    loading = attempt;
    attempt.catch(() => {
      if (loading === attempt) loading = undefined;
    });
  }
  return loading;
}

/** Forgets the loaded regions; for tests. */
export function resetNaturalEarthCache(): void {
  loading = undefined;
}

/** Reads a property whatever the case of its key ("NAME", "name"). */
function prop(feature: Feature, key: string): string | undefined {
  const p = feature.properties;
  if (!p) return undefined;
  const value: unknown = p[key.toUpperCase()] ?? p[key.toLowerCase()];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function numericProp(feature: Feature, key: string): number | undefined {
  const p = feature.properties;
  const value: unknown = p ? (p[key.toUpperCase()] ?? p[key.toLowerCase()]) : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Lower case, accents removed, spaces collapsed, leading "the " dropped. */
function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the\s+/, "");
}

/** Name fields in match order; NAMEALT is also spelled name_alt in other Natural Earth releases. */
const NAME_KEYS = ["name", "name_en", "namealt", "name_alt"] as const;

/**
 * Finds the region a place name refers to: case-insensitive, leading "the " ignored, matched on NAME, then
 * NAME_EN, then NAMEALT. Within one of those, the more important feature (lower SCALERANK) wins.
 */
export function findRegion(name: string, fc: FeatureCollection): Feature | undefined {
  const wanted = normalizeName(name);
  if (wanted === "") return undefined;

  let best: { feature: Feature; tier: number; rank: number } | undefined;
  for (const feature of fc.features) {
    for (let key = 0; key < NAME_KEYS.length; key++) {
      const candidate = prop(feature, NAME_KEYS[key]);
      if (candidate === undefined || normalizeName(candidate) !== wanted) continue;
      const tier = Math.min(key, 2);
      const rank = numericProp(feature, "scalerank") ?? 99;
      if (!best || tier < best.tier || (tier === best.tier && rank < best.rank)) {
        best = { feature, tier, rank };
      }
      break;
    }
  }
  return best?.feature;
}

function titleCase(text: string): string {
  return text.toLowerCase().replace(/(^|[\s(/-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** A readable name: the English name when there is one, else NAME, title-cased when it is all capitals. */
export function regionDisplayName(feature: Feature): string {
  const name = prop(feature, "name_en") ?? prop(feature, "name") ?? "Unnamed region";
  return name === name.toUpperCase() ? titleCase(name) : name;
}

/** The raw Natural Earth feature class (FEATURECLA), if any. */
export function regionFeatureClass(feature: Feature): string | undefined {
  return prop(feature, "featurecla");
}

/** A sort key: lower is more prominent (Natural Earth SCALERANK, 0 to 5). */
export function regionRank(feature: Feature): number {
  return numericProp(feature, "scalerank") ?? 99;
}

export function regionProp(feature: Feature, key: string): string | undefined {
  return prop(feature, key);
}
