import type { BBox } from "@/layers/types";
import { nominatimSearch, type OsmPlace } from "./nominatim";
import { wikidataFeature, type RegionMatch } from "./regionNames";

/**
 * Natural features and named routes by name (audit R2): rivers, lakes, bays, peaks, passes, valleys, trails and old
 * roads. OpenStreetMap's search answers first, ranked so a feature beats a town or street of the same name, a feature
 * near the map view (or the question's other places) beats a far one, and a famous one beats an obscure one without a
 * view; Wikidata answers what OpenStreetMap only knows as streets (the Wonderland Trail, a valley like Jackson Hole).
 */

/** Words that make a name a natural feature or a route, which the place geocoder (streets and towns) answers badly. */
const FEATURE_NAME =
  /\b(?:river|creek|fork|stream|brook|bay|lake|reservoir|pond|sound|inlet|cove|harbou?r|gulf|strait|lagoon|trail|road|route|way|loop|canyon|gorge|valley|hole|falls|waterfall|glacier|icefield|peak|mount|mt|mountain|butte|mesa|pass|ridge|dome|island|isle|beach|cape|spring|springs|coast|conservation area|recreation area)\b/i;

export function isFeatureName(place: string): boolean {
  return FEATURE_NAME.test(place.split(",")[0]);
}

/** Routes and old roads are mapped as many ways: the tracks and paths of one name are one route. */
const ROUTE_NAME = /\b(?:trail|road|route|way|loop)$/i;

const normalize = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:the|of)\b/g, " ")
    .replace(/\bmt\b/g, "mount")
    .replace(/\s+/g, " ")
    .trim();

/** The asked name is the place's name, or its name followed by words of where it is ("Lake Powell Utah"). */
function sameName(asked: string, p: Pick<OsmPlace, "name" | "label">): boolean {
  const n = normalize(p.name);
  if (n === asked) return true;
  if (!asked.startsWith(`${n} `) || n.length < 4) return false;
  const label = normalize(p.label);
  return asked.slice(n.length + 1).split(" ").every((w) => label.includes(w));
}

/** True when a town of exactly the asked name outranks every feature of it: "Half Moon Bay" is the town. */
export function townWins(place: string, found: OsmPlace[]): boolean {
  const name = normalize(place.split(",")[0]);
  const exact = found.filter((p) => sameName(name, p));
  const town = exact.filter(isSettlement).sort((a, b) => b.importance - a.importance)[0];
  if (!town) return false;
  const route = ROUTE_NAME.test(place.split(",")[0].trim());
  return exact.filter((p) => isFeature(p, route)).every((p) => p.importance <= town.importance);
}

/** OpenStreetMap classes that are features (water, peaks, parks, routes), not settlements, streets or businesses. */
function isFeature(p: OsmPlace, route: boolean): boolean {
  if (["natural", "waterway", "water", "mountain_pass", "route", "glacier"].includes(p.category)) return true;
  if (p.category === "boundary") return ["national_park", "protected_area"].includes(p.type);
  if (p.category === "leisure") return ["nature_reserve", "park"].includes(p.type);
  if (p.category === "landuse") return p.type === "forest";
  if (p.category === "place") return ["island", "islet", "archipelago"].includes(p.type);
  if (p.category === "highway") return route && ["track", "path", "footway", "bridleway", "cycleway", "unclassified"].includes(p.type);
  return false;
}

const isSettlement = (p: OsmPlace) =>
  (p.category === "boundary" && p.type === "administrative") || (p.category === "place" && ["city", "town", "village", "hamlet", "municipality"].includes(p.type));

function km(a: readonly number[], b: readonly number[]): number {
  const rad = Math.PI / 180;
  const h = Math.sin(((b[1] - a[1]) * rad) / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(((b[0] - a[0]) * rad) / 2) ** 2;
  return 12_742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A box of `halfKm` around a point, square on the ground. */
export function boxAround([lng, lat]: [number, number], halfKm: number): BBox {
  const dLat = halfKm / 110.57;
  const dLng = halfKm / (111.32 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

/** How far around a feature known only as a point the question's area reaches: a peak's slopes, a valley, a bay. */
function halfSpanKm(p: Pick<OsmPlace, "type" | "category">): number {
  if (["peak", "volcano"].includes(p.type)) return 12;
  if (["valley", "saddle", "mountain_pass", "yes"].includes(p.type) || p.category === "mountain_pass") return 10;
  if (["bay", "strait", "water", "lake", "reservoir"].includes(p.type)) return 8;
  return 5;
}

/** A feature's box: its own extent, or a span around it when it is mapped as a point. */
function featureBox(p: OsmPlace): BBox {
  const tiny = p.bbox[2] - p.bbox[0] < 0.02 && p.bbox[3] - p.bbox[1] < 0.02;
  return tiny ? boxAround(p.center, halfSpanKm(p)) : p.bbox;
}

const union = (boxes: BBox[]): BBox => [
  Math.min(...boxes.map((b) => b[0])),
  Math.min(...boxes.map((b) => b[1])),
  Math.max(...boxes.map((b) => b[2])),
  Math.max(...boxes.map((b) => b[3])),
];

/** The farthest any feature of a route may lie from its nearest neighbour and still be the same route. */
const ROUTE_GAP_KM = 250;

/**
 * The best OpenStreetMap feature for `place` among Nominatim's answers, or null: exactly the asked name (before any
 * comma), a feature class (or, for a route's name, tracks and paths), not outranked by a town of that name (Half Moon
 * Bay is the town), near `proximity` when there is one, else important enough to be the one people mean (a pond in
 * Illinois called Jackson Hole is not). A route's ways near each other are joined into one box.
 */
export function pickFeature(place: string, found: OsmPlace[], proximity?: [number, number]): { name: string; bbox: BBox; center: [number, number] } | null {
  const name = normalize(place.split(",")[0]);
  const route = ROUTE_NAME.test(place.split(",")[0].trim());
  const exact = found.filter((p) => sameName(name, p));
  const features = exact.filter((p) => isFeature(p, route));
  if (features.length === 0) return null;
  const town = exact.filter(isSettlement).sort((a, b) => b.importance - a.importance)[0];
  const near = (p: OsmPlace) => (proximity ? km(proximity, p.center) <= 300 : false);
  const ranked = features
    .map((p) => ({ p, near: near(p) ? 1 : 0, way: p.category === "highway" ? 1 : 0 }))
    .sort((a, b) => b.near - a.near || a.way - b.way || b.p.importance - a.p.importance);
  const best = ranked[0].p;
  if (!near(best)) {
    if (town && town.importance >= best.importance) return null;
    if (best.importance < 0.2 && best.category !== "highway") return null;
  }
  if (best.category === "highway") {
    // A route of tracks: the ways of that name that chain to the best one, joined.
    const group = [best];
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of features) {
        if (p.category !== "highway" || group.includes(p)) continue;
        if (group.some((g) => km(g.center, p.center) <= ROUTE_GAP_KM)) {
          group.push(p);
          grew = true;
        }
      }
    }
    // A single short street-like way is no route.
    if (group.length < 2 && proximity === undefined) return null;
    const bbox = union(group.map((g) => g.bbox));
    return { name: best.label, bbox, center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2] };
  }
  return { name: best.label, bbox: featureBox(best), center: best.center };
}

/** How far around a feature Wikidata knows only as a point a question reaches, by what its description says it is. */
function wikidataSpan(place: string): number {
  if (ROUTE_NAME.test(place.split(",")[0].trim())) return 20;
  if (/\b(?:valley|hole|canyon|gorge|coast)\b/i.test(place)) return 20;
  if (/\b(?:mount|mt|peak|mountain|volcano|butte)\b/i.test(place)) return 12;
  return 8;
}

/**
 * A natural feature or named route by name: OpenStreetMap first (see pickFeature), then Wikidata. Null when neither
 * knows one; never throws.
 */
export async function featureLookup(place: string, proximity?: [number, number]): Promise<RegionMatch | null> {
  const route = ROUTE_NAME.test(place.split(",")[0].trim());
  const found = await nominatimSearch(place, route ? 20 : 10);
  const best = pickFeature(place, found, proximity);
  if (best) return { ...best, source: "openstreetmap" };
  if (townWins(place, found)) return null;
  return wikidataFeature(place, wikidataSpan(place), proximity);
}

/**
 * A famous place of exactly the asked name that Nominatim ranks far above the geocoder's answer, or null: for a name
 * asked with no view and no other place to go by, "Chamonix" is Chamonix-Mont-Blanc, not a suburb of Cape Town.
 */
export async function famousPlace(place: string, answer: [number, number]): Promise<RegionMatch | null> {
  const name = normalize(place.split(",")[0]);
  const found = await nominatimSearch(place, 5);
  const top = found[0];
  if (!top || top.importance < 0.45) return null;
  const n = normalize(top.name);
  if (n !== name && !n.startsWith(`${name} `)) return null;
  if (km(top.center, answer) < 100) return null;
  // The geocoder's own answer, when Nominatim knows it at all, must rank well below.
  const theirs = found.find((p) => km(p.center, answer) < 50);
  if (theirs && theirs.importance > top.importance * 0.7) return null;
  return { name: top.label, bbox: top.bbox, center: top.center, source: "openstreetmap" };
}
