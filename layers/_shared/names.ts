/**
 * Names as people say them, shared by every layer (lib/layers/run.ts reads each feature's name through displayName).
 *
 * - A trailing article goes back to the front: catalogues file "Oasis, The", and OpenBeta and some OpenStreetMap editors
 *   copy that order (naturalName).
 * - A name in capitals is written in ordinary capitals ("BERNARDO" → "Bernardo", "PIO XI" → "Pio XI", "JORGE MONTT" →
 *   "Jorge Montt"): roman numerals and acronyms stay in capitals, small joining words ("de", "of") go lower case, and no
 *   accent is added that the source does not have.
 * - A source's abbreviations are spelled out ("Gl. Upsala" → "Upsala Glacier" in glaciers, "Mt." → "Mount", "Res." →
 *   "Reservoir"), and run-together initials get their points ("Lake Jb Thomas Dam" → "Lake J.B. Thomas Dam").
 *
 * When the name changed, the feature keeps the source's own spelling as `nameInSource` (the card's "Name in source").
 */
const TRAILING_ARTICLE = /^(.+?),\s*(the|a|an)\s*$/i;

export function naturalName(name: string): string {
  const m = TRAILING_ARTICLE.exec(name.trim());
  if (!m || m[1].trim() === "") return name;
  const article = m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase();
  return `${article} ${m[1].trim()}`;
}

/** I to XXXIX: the numerals that number things in names ("Pio XI", "Granby Dike IV"). */
const ROMAN = /^(?=[IVX])X{0,3}(?:IX|IV|V?I{0,3})$/;

/** Acronyms that hold a vowel (one without vowels, "BLM", "NWR", stays in capitals anyway). */
const ACRONYMS = new Set(["USA", "US", "USFS", "USGS", "USACE", "USBR", "NOAA", "NASA", "TVA", "NPS", "NRA", "SRA", "WMA", "UK", "EU", "LLC", "INC", "AEP", "PG&E", "KOA", "YMCA", "OHV", "ATV", "UTV"]);

/** Joining words written in lower case inside a name ("Bahía de los Ángeles", "Lake of the Woods"). */
const SMALL_WORDS = new Set(["de", "del", "della", "di", "da", "do", "dos", "das", "du", "des", "la", "las", "le", "les", "los", "el", "y", "e", "of", "the", "and", "on", "at", "in", "en", "van", "von", "der", "den", "zu", "am", "im"]);

/** Short words without vowels that are abbreviations, not someone's initials ("Mt", "St", "Rd"). */
const NOT_INITIALS = new Set(["mt", "st", "pk", "cr", "fk", "rd", "dr", "jr", "sr", "ft", "mr", "ms", "nr", "hwy", "pkwy", "blvd", "ln", "ct", "pl", "sq", "mtn", "mtns", "nw", "ne", "sw", "se", "nd", "rd", "th"]);

const hasVowel = (word: string) => /[aeiouyàáâãäåèéêëìíîïòóôõöùúûüýæœ]/i.test(word);

/** Two-letter English words: any other two letters ending a name in capitals are the source's abbreviation. */
const TWO_LETTER_WORDS = new Set(["am", "an", "as", "at", "be", "by", "do", "go", "he", "hi", "if", "in", "is", "it", "me", "my", "no", "of", "oh", "ok", "on", "or", "ox", "so", "to", "up", "us", "we"]);

/** One word of a name in capitals, in ordinary capitals. `first` and `last` place the word in the name. */
function caseWord(word: string, first: boolean, last = false): string {
  if (!/\p{L}/u.test(word)) return word;
  const letters = word.replace(/[^\p{L}&]/gu, "");
  // "MT." and "ST." are Mount and Saint, not acronyms: "Mt." and "St.".
  if (NOT_INITIALS.has(letters.toLowerCase())) return word.charAt(0) + word.slice(1).toLowerCase();
  if (ROMAN.test(letters) || ACRONYMS.has(letters) || (letters.length >= 2 && !hasVowel(letters))) return word;
  // "TABOR BOAT RAMP PA": the source's own short form (parking area), kept as given; "Pa" read as a name cut short.
  if (last && !first && letters.length === 2 && !TWO_LETTER_WORDS.has(letters.toLowerCase()) && !SMALL_WORDS.has(letters.toLowerCase())) return word;
  const lower = word.toLowerCase();
  if (!first && SMALL_WORDS.has(lower)) return lower;
  // Each part after a hyphen or a point starts a word ("SAN-JUAN" → "San-Juan", "ST.PAUL" → "St.Paul").
  let out = lower.replace(/(^|[-./])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
  // "O'HIGGINS" → "O'Higgins", "D'ARC" → "D'Arc", but "SMITH'S" → "Smith's".
  out = out.replace(/^(\p{L})'(\p{L})/u, (_m, a: string, b: string) => `${a}'${b.toUpperCase()}`);
  // "MCDONALD" → "McDonald".
  out = out.replace(/^Mc(\p{L})/u, (_m, ch: string) => `Mc${ch.toUpperCase()}`);
  return out;
}

/** True when a name is written in capitals: four or more letters and none in lower case. */
export function isAllCaps(name: string): boolean {
  const letters = name.replace(/[^\p{L}]/gu, "");
  return letters.length >= 4 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

/** True when every word of a capitals name is a roman numeral or an acronym ("BLM", "USFS"): it stays as it is. */
export function isAcronymName(name: string): boolean {
  const words = name.split(/\s+/).map((w) => w.replace(/[^\p{L}&]/gu, "")).filter(Boolean);
  return words.length > 0 && words.every((w) => ROMAN.test(w) || ACRONYMS.has(w) || (w.length >= 2 && !hasVowel(w)));
}

/** A name in capitals in ordinary capitals; any other name as it is. */
export function titleCase(name: string): string {
  if (!isAllCaps(name) || isAcronymName(name)) return name;
  const parts = name.split(/(\s+)/);
  return parts.map((part, i) => (/^\s+$/.test(part) ? part : caseWord(part, i === 0, i === parts.length - 1))).join("");
}

type Abbreviation = { pattern: RegExp; replace: string | ((...m: string[]) => string); layers?: string[] };

/**
 * Abbreviations sources use, spelled out. Without `layers` they apply everywhere; an abbreviation that is also an
 * initial elsewhere ("L." in "John L. Smith Dam") is only read at the start of a name, in the layers it comes from.
 */
const ABBREVIATIONS: Abbreviation[] = [
  // GLIMS writes the Spanish "Glaciar" as "Gl." before the name: "Gl. Upsala" is Upsala Glacier.
  { pattern: /^Gl\.?\s+(.+)$/i, replace: (_m, rest) => `${rest} Glacier`, layers: ["glaciers"] },
  { pattern: /^(.+?)\s+Gl\.?$/i, replace: (_m, rest) => `${rest} Glacier`, layers: ["glaciers"] },
  { pattern: /^L\.\s+(?=\p{L}{2})/u, replace: "Lake ", layers: ["lakes", "dams", "reservoir-levels", "glaciers", "fishing", "paddling"] },
  { pattern: /\bMt\.?(?=\s+\p{L})/gu, replace: "Mount" },
  { pattern: /\bPk\.?(?=\s|$)/g, replace: "Peak" },
  { pattern: /\bRes\.(?=\s|$)/g, replace: "Reservoir" },
  { pattern: /\bRes(?=\s*$)/g, replace: "Reservoir", layers: ["dams", "lakes", "reservoir-levels", "streamflow"] },
  { pattern: /\bCr\.(?=\s|$)/g, replace: "Creek" },
  { pattern: /\bCr(?=\s*$)/g, replace: "Creek", layers: ["dams", "streamflow", "paddling", "fishing", "lakes"] },
  { pattern: /\bFk\.?(?=\s|$)/g, replace: "Fork" },
];

/** Run-together initials made by a careless title-casing: "Jb" → "J.B.", "Jbs" left alone. */
function pointInitials(name: string): string {
  return name.replace(/\b([A-Z])([a-z])\b(?!\.)/g, (m, a: string, b: string) => (NOT_INITIALS.has(m.toLowerCase()) || hasVowel(m) ? m : `${a}.${b.toUpperCase()}.`));
}

/** A feature name as people read it (see the module comment); `layerId` picks the source's abbreviations. */
export function displayName(raw: string, layerId?: string): string {
  let name = naturalName(raw.trim())
    // A spacing acute used as an apostrophe ("O´HIGGINS").
    .replace(/(\p{L})[´ʹʼ`](\p{L})/gu, "$1'$2")
    .replace(/\s+/g, " ");
  name = titleCase(name);
  for (const a of ABBREVIATIONS) {
    if (a.layers && (layerId === undefined || !a.layers.includes(layerId))) continue;
    name = name.replace(a.pattern, a.replace as (substring: string, ...args: string[]) => string);
  }
  if (layerId === "dams" || layerId === "lakes" || layerId === "reservoir-levels" || layerId === "mines" || layerId === "uranium" || layerId === "power-plants") {
    name = pointInitials(name);
  }
  return name;
}

/** A name that says there is none ("No Name", "NONAME", "Unnamed Road"), as forest and OpenStreetMap editors fill the field. */
const PLACEHOLDER_NAME = /^(?:no[\s_-]*name|un-?named|none|null|n\/a)(?:\s+(?:road|rd|trail|track|street|st))?$/i;

/** OpenStreetMap highway values that are roads (an unnamed one is "Unnamed road"); paths and tracks for feet and bikes are trails. */
const ROAD_HIGHWAYS = new Set(["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "service", "track", "road", "living_street"]);
const TRAIL_HIGHWAYS = new Set(["path", "footway", "bridleway", "cycleway", "steps"]);

/** True for a placeholder name that names nothing ("No Name"). */
export function isPlaceholderName(name: string): boolean {
  return PLACEHOLDER_NAME.test(name.trim());
}

/** What a placeholder name reads as: "Unnamed road" on a road (forest roads, an OpenStreetMap road), "Unnamed trail" on a path. */
export function unnamedFor(properties: Record<string, unknown>, layerId?: string): string {
  const highway = typeof properties.highway === "string" ? properties.highway : undefined;
  if (layerId === "forest-roads" || (highway !== undefined && ROAD_HIGHWAYS.has(highway))) return "Unnamed road";
  if (highway !== undefined && TRAIL_HIGHWAYS.has(highway)) return "Unnamed trail";
  return "Unnamed";
}

/**
 * A feature's `name` read through displayName, with the source's spelling kept as `nameInSource` when it changed; other
 * properties untouched. A placeholder ("No Name") reads "Unnamed road" (card, lists, labels and notes alike), with no
 * "Name in source" row: the source named nothing.
 */
export function withDisplayName<P extends Record<string, unknown> | null>(properties: P, layerId?: string): P {
  if (!properties || typeof properties.name !== "string") return properties;
  if (isPlaceholderName(properties.name)) return { ...properties, name: unnamedFor(properties, layerId) } as P;
  const name = displayName(properties.name, layerId);
  if (name === properties.name) return properties;
  if (name === properties.name.trim()) return { ...properties, name } as P;
  return { ...properties, name, nameInSource: properties.nameInSource ?? properties.name } as P;
}

/** A feature's `name` with its article put back in front (naturalName) and nothing else changed. */
export function withNaturalName<P extends Record<string, unknown> | null>(properties: P): P {
  if (!properties || typeof properties.name !== "string") return properties;
  const name = naturalName(properties.name);
  return name === properties.name ? properties : ({ ...properties, name } as P);
}
