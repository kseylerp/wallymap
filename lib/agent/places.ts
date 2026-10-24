import type { BBox } from "@/layers/types";

/**
 * The places a question names, read from its words alone (no lookup): the server's fallback when the model queries
 * a layer without geocoding the place the user asked about (lib/agent/stepGuard.ts), and "near <town>" as a radius.
 */

/** Small words that may sit inside a capitalised place name ("Gulf of Mexico", "Rio de Janeiro"). */
const CONNECTORS = new Set(["of", "de", "del", "la", "le", "du", "des", "di", "da", "the", "y"]);

/** Capitalised words that are never a place on their own. */
const NOT_PLACES = new Set(["i", "osm", "openstreetmap", "inaturalist", "gbif", "fema", "usgs", "noaa", "mw", "km", "mph"]);

/** Region words people write in lower case ("dams in the colorado river basin"), longest first. */
const REGION_WORDS = [
  "national recreation area",
  "national monument",
  "national forest",
  "national park",
  "national preserve",
  "drainage basin",
  "river basin",
  "mountain range",
  "indian reservation",
  "reservation",
  "watershed",
  "wilderness",
  "mountains",
  "plateau",
  "desert",
  "valley",
  "basin",
  "range",
  "nation",
];

const REGION_PHRASE = new RegExp(
  `\\b(?:in|near|around|at|across|of|on)\\s+(?:the\\s+)?((?:[a-z][\\w'-]*\\s+){1,3}(?:${REGION_WORDS.join("|")}))\\b`,
  "gi",
);

/** Words that start a question or a request rather than name a place ("Show Miami", "Outline the Sierra Nevada"). */
const LEAD_WORDS = new Set([
  "show", "outline", "is", "are", "was", "were", "how", "what", "which", "where", "who", "why", "when", "find", "list",
  "map", "draw", "compare", "any", "give", "tell", "can", "could", "do", "does", "did", "plot", "highlight", "zoom",
  "display", "get", "mark", "please", "recent", "nearby", "best", "good", "top", "all", "the", "a", "an",
]);

/** Words that never begin a lower-case region name ("any of it designated wilderness"). */
const NOT_REGION_START = new Set([
  "it", "is", "any", "its", "this", "that", "these", "those", "a", "an", "some", "all", "my", "our", "your", "their",
  "designated", "protected", "public", "open", "nearby", "local", "same", "other", "each", "every", "which", "what", "and", "or",
]);

/** Words before a place that say the question is about the area around it. */
const PLACE_PREPOSITION = /\b(?:in|near|around|at|across|of|on|from|to|outside|by)\s+(?:the\s+)?$/i;

type Span = { text: string; index: number; afterPreposition: boolean };

/** Runs of capitalised words (with "of", "de" and the like inside), each with where it starts. */
function capitalisedSpans(question: string): Span[] {
  const spans: Span[] = [];
  const words = [...question.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu)];
  let i = 0;
  while (i < words.length) {
    const word = words[i][0];
    if (!/^\p{Lu}/u.test(word)) {
      i += 1;
      continue;
    }
    let j = i;
    // Extend over capitalised words, and over a connector when a capitalised word follows it.
    while (j + 1 < words.length) {
      const next = words[j + 1][0];
      if (/^\p{Lu}/u.test(next)) j += 1;
      else if (CONNECTORS.has(next.toLowerCase()) && j + 2 < words.length && /^\p{Lu}/u.test(words[j + 2][0])) j += 2;
      else break;
    }
    // A question or request word at the start ("Show", "Is the") is not part of the name that follows it.
    let first = i;
    const atStart = i === 0 || /[.!?]\s*$/.test(question.slice(0, words[i].index ?? 0));
    while (atStart && first < j && LEAD_WORDS.has(words[first][0].toLowerCase())) {
      first += 1;
      while (first < j && CONNECTORS.has(words[first][0].toLowerCase())) first += 1;
    }
    const start = words[first].index ?? 0;
    const last = words[j];
    const end = (last.index ?? 0) + last[0].length;
    const text = question.slice(start, end).replace(/['’]s$/, "").replace(/[.]+$/, "");
    const single = first === j;
    // The question's first word is capitalised as a sentence start ("Recent", "Show", "Glaciers"): alone, it is no place.
    const sentenceStart = atStart && first === i;
    const before = question.slice(0, start);
    if (!(single && sentenceStart) && !NOT_PLACES.has(text.toLowerCase()) && !/^\d/.test(text)) {
      spans.push({ text, index: start, afterPreposition: PLACE_PREPOSITION.test(before) });
    }
    i = j + 1;
  }
  return spans;
}

/**
 * The places a question names, best first: region phrases ("the colorado river basin"), then capitalised names
 * ("Lake Tahoe", "West Texas", "Red River Gorge"), those after in/near/around/at before the rest. Sentence-initial
 * words alone ("Recent", "Show") are not places. Empty when the question names none ("What fires are here?").
 */
export function placeCandidates(question: string): string[] {
  const text = question.replace(/@view=\S+/g, "").trim();
  const out: string[] = [];
  const add = (place: string) => {
    const clean = place.trim().replace(/\s+/g, " ");
    if (clean !== "" && !out.some((p) => p.toLowerCase() === clean.toLowerCase())) out.push(clean);
  };
  const spans = capitalisedSpans(text);
  const regions = [...text.matchAll(REGION_PHRASE)]
    .map((m) => m[1].trim())
    .filter((r) => !NOT_REGION_START.has(r.split(/\s+/)[0].toLowerCase()));
  const lower = (t: string) => t.toLowerCase();
  // A region phrase that a capitalised span spells in full ("the Navajo Nation") goes under the span's spelling; one
  // that only extends a span ("Colorado River" + "basin") replaces it.
  const covered = (r: string) => spans.some((s) => lower(s.text).includes(lower(r)));
  const extended = (s: Span) => regions.some((r) => lower(r).includes(lower(s.text)) && lower(r) !== lower(s.text));
  for (const r of regions) if (!covered(r)) add(r);
  for (const s of spans.filter((s) => s.afterPreposition && !extended(s))) add(s.text);
  for (const s of spans.filter((s) => !s.afterPreposition && !extended(s))) add(s.text);
  return out;
}

/** The place after "near" in a question ("Recent earthquakes near Mammoth Lakes" → "Mammoth Lakes"), or null. */
export function nearPlace(question: string): string | null {
  const m = /\bnear\s+(?:the\s+)?(.+)$/i.exec(question.replace(/@view=\S+/g, "").trim());
  if (!m) return null;
  const rest = m[1];
  const candidate = placeCandidates(question).find((p) => rest.toLowerCase().startsWith(p.toLowerCase()));
  return candidate ?? null;
}

/** The place after "off" in a question ("whales off Monterey" → "Monterey"): the sea next to it, or null. */
export function offPlace(question: string): string | null {
  const m = /\boff\s+(?:the\s+(?:coast\s+of\s+)?)?(.+)$/i.exec(question.replace(/@view=\S+/g, "").trim());
  if (!m) return null;
  const rest = m[1];
  return placeCandidates(question).find((p) => rest.toLowerCase().startsWith(p.toLowerCase())) ?? null;
}

/**
 * How far "off <coastal town>" reaches, in km: a town's own box is land, and the whales, swell or currents asked about
 * are at sea beyond it (whales off Monterey were in the bay, outside the city's box). A box this wide around the town
 * holds the water next to it on any side.
 */
export const OFF_RADIUS_KM = 40;

/** A radius the user gave ("within 80 km", "within 20 miles"), in km, or null. */
export function statedRadiusKm(question: string): number | null {
  const m = /\bwithin\s+(\d+(?:\.\d+)?)\s*(km|kilomet(?:er|re)s?|mi|miles?)\b/i.exec(question);
  if (!m) return null;
  const n = Number(m[1]);
  return /^mi/i.test(m[2]) ? n * 1.609 : n;
}

/**
 * What "near <town>" means per layer kind, in km, when the user gives no distance: earthquakes 50 km, trails 25 km,
 * crags 30 km. A layer missing here keeps the box the model asked for.
 */
export const NEAR_RADIUS_KM: Record<string, number> = {
  earthquakes: 50,
  "osm-trails": 25,
  "mtb-trails": 25,
  "ski-routes": 25,
  "forest-roads": 25,
  popularity: 25,
  "popularity-campsites": 25,
  campsites: 25,
  "outdoor-features": 25,
  climbing: 30,
  peaks: 30,
  // Fires, smoke and alerts "near Yosemite Valley" reach well past the valley floor's box.
  "fire-detections": 50,
  "fire-perimeters": 50,
  "weather-alerts": 50,
  smoke: 75,
};

/**
 * A town's box from Mapbox is under this on both axes (degrees): Moab, Utah comes back 1.1° by 1.3° (its whole
 * census area), Mammoth Lakes far smaller; a county or a state is wider.
 */
const TOWN_MAX_DEG = 1.5;

/**
 * True for a town or a point, where "near" means a radius around it: a Mapbox answer under TOWN_MAX_DEG. A region
 * from the app's own sources (the Navajo Nation, a national park, a range) is what "near" it means by itself.
 */
export function isPointLike([w, s, e, n]: BBox, source?: string): boolean {
  if (source === "openstreetmap" || source === "wikidata") return e - w < FEATURE_MAX_DEG && n - s < FEATURE_MAX_DEG;
  return (source === undefined || source === "mapbox") && e - w < TOWN_MAX_DEG && n - s < TOWN_MAX_DEG;
}

/**
 * A natural feature from OpenStreetMap or Wikidata under this on both axes (degrees) is a spot "near" reaches around:
 * Yosemite Valley is 0.13° by 0.03°, and fires "near" it lay outside the valley floor. A long river or a range is wider.
 */
const FEATURE_MAX_DEG = 0.3;

const KM_PER_DEGREE = 111.32;

/** The box `radiusKm` around a point, rounded to 4 decimals. */
export function boxAround([lng, lat]: [number, number], radiusKm: number): BBox {
  const dLat = radiusKm / KM_PER_DEGREE;
  const dLng = radiusKm / (KM_PER_DEGREE * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  const r = (x: number) => Math.round(x * 1e4) / 1e4;
  return [r(Math.max(-180, lng - dLng)), r(Math.max(-90, lat - dLat)), r(Math.min(180, lng + dLng)), r(Math.min(90, lat + dLat))];
}

/**
 * The box a query of `layerId` uses for "near <place>": the stated radius, else the layer kind's default, around the
 * place's center; null when the layer has no default, or the place is a region rather than a town (then its own box
 * is what "near" means).
 */
export function nearBox(question: string, layerId: string, place: { bbox: BBox; center: [number, number]; source?: string }): BBox | null {
  const radius = statedRadiusKm(question) ?? NEAR_RADIUS_KM[layerId];
  if (radius === undefined || !isPointLike(place.bbox, place.source)) return null;
  return boxAround(place.center, radius);
}
