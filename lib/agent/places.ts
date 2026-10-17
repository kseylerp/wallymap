/**
 * The places a question names, read from its words alone (no lookup): the server's fallback when the model queries
 * a layer without geocoding the place the user asked about (lib/agent/stepGuard.ts).
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

