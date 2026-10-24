/**
 * Notes hold only what the tools returned (audit R5, 2026-10-23): the Arctic sea ice note said "6.5 million km² in
 * 2012" (the record low was about 3.4), the Boulder note gave round-trip lengths for a "Flatirons Loop" no result
 * named, the French Broad note said "well above typical" at 85% of median, and "2,650 firesheds" stood for 265.
 *
 * Every number with a unit (and every bare count of 10 or more that is not a year or a date) in a note must be traceable
 * to this turn's tool results: a value in them (in any unit of the same kind: 5 miles is 8.05 km), a difference of two
 * of them (Lake Powell dropped 152 ft), or a ratio as a percent (42% less). Feature names with a feature word ("Royal
 * Arch Trail", "Johnny Tiller Falls") must appear in the results. Flow words (above normal, record high) must agree
 * with the gauges' own flow classes. Numbers and names in the question count as given.
 *
 * Categorical claims about a named feature (2026-10-23): Moab's note called Wall Street "south-west facing and shaded"
 * when the result says it faces east. A sentence that names features and gives one of them an aspect ("faces
 * south-west"), shade ("shaded", "sunny"), or a class or status the results use (a discipline, a difficulty, open or
 * closed) must agree with at least one of the features it names.
 */

/** `why`, for a categorical claim, says what the results hold instead; `text` is then the sentence that claims it. */
export type Claim = { text: string; kind: "number" | "name" | "flow" | "measure" | "category"; why?: string };

/**
 * Measures a note may name only when a result carries them: Joshua Tree's wind layer has no gusts, yet the note gave
 * "gusts of 30 mph"; the sightings layer has no abundance, yet a note said "brook trout present".
 */
const MEASURE_WORDS: { re: RegExp; needs: RegExp }[] = [
  { re: /\bgusts?(?:ing)?\b/i, needs: /\bgust/ },
  { re: /\bwave\s+period\b/i, needs: /\bperiod\b/ },
  { re: /\bdrivers?\s+of\b|\bdriven\s+(?:primarily\s+)?by\b/i, needs: /\bdriver/ },
];

type Dimension = "length" | "area" | "flow" | "speed" | "temperature" | "percent" | "mass-rate" | "power" | "volume" | "count" | "mass" | "depth";

/** Units by the words a note writes them in: dimension and factor to a base unit (m, m², m³/s, m/s, kg/h, MW, m³, t, m). */
const UNITS: { re: RegExp; dim: Dimension; factor: number }[] = [
  { re: /^(?:km²|km2|sq\.?\s*km|square\s+kilomet(?:er|re)s?)/i, dim: "area", factor: 1e6 },
  { re: /^(?:mi²|mi2|sq\.?\s*mi(?:les?)?|square\s+miles?)/i, dim: "area", factor: 2.589988e6 },
  { re: /^(?:m²|m2|square\s+met(?:er|re)s?)/i, dim: "area", factor: 1 },
  { re: /^(?:acres?|ac)\b(?!-)/i, dim: "area", factor: 4046.856 },
  { re: /^(?:hectares?|ha)\b/i, dim: "area", factor: 1e4 },
  { re: /^(?:acre[- ]f(?:ee)?t|af)\b/i, dim: "volume", factor: 1233.48 },
  { re: /^(?:cfs|ft³\/s|ft3\/s|cubic\s+feet\s+per\s+second)/i, dim: "flow", factor: 0.0283168 },
  { re: /^(?:m³\/s|m3\/s|cms|cumecs)/i, dim: "flow", factor: 1 },
  { re: /^(?:mph|miles?\s+per\s+hour)\b/i, dim: "speed", factor: 0.44704 },
  { re: /^(?:m\/s|metres?\s+per\s+second|meters?\s+per\s+second)/i, dim: "speed", factor: 1 },
  { re: /^(?:km\/h|kph|kmh)\b/i, dim: "speed", factor: 0.277778 },
  { re: /^(?:knots?|kts?|kn)\b/i, dim: "speed", factor: 0.514444 },
  { re: /^(?:kg\/h|kg\/hr|kilograms?\s+per\s+hour)/i, dim: "mass-rate", factor: 1 },
  { re: /^(?:t\/h|tonnes?\s+per\s+hour)/i, dim: "mass-rate", factor: 1000 },
  { re: /^(?:°\s*f|º\s*f|degrees?\s+f(?:ahrenheit)?)\b/i, dim: "temperature", factor: 1 },
  { re: /^(?:°\s*c|º\s*c|degrees?\s+c(?:elsius)?)\b/i, dim: "temperature", factor: 1 },
  { re: /^(?:%|percent\b|per\s+cent\b)/i, dim: "percent", factor: 1 },
  { re: /^(?:gw)\b/i, dim: "power", factor: 1000 },
  { re: /^(?:mw)\b/i, dim: "power", factor: 1 },
  { re: /^(?:short\s+tons?|tons?|tonnes?)\b/i, dim: "mass", factor: 1 },
  { re: /^(?:kilomet(?:er|re)s?|km)\b/i, dim: "length", factor: 1000 },
  { re: /^(?:miles?|mi)\b/i, dim: "length", factor: 1609.344 },
  { re: /^(?:met(?:er|re)s?|m)\b(?![²2/])/i, dim: "length", factor: 1 },
  { re: /^(?:feet|foot|ft)\b(?![³3])/i, dim: "length", factor: 0.3048 },
  { re: /^(?:inches|inch|in)\b(?=\s|[.,;)]|$)/i, dim: "depth", factor: 0.0254 },
  { re: /^(?:cm|centimet(?:er|re)s?)\b/i, dim: "depth", factor: 0.01 },
  { re: /^(?:mm|millimet(?:er|re)s?)\b/i, dim: "depth", factor: 0.001 },
];

/** The other units each dimension's numbers may be stored in, as factors to the base unit. */
const STORED: Record<Dimension, number[]> = {
  length: [1000, 1609.344, 1, 0.3048],
  depth: [0.0254, 0.01, 0.001, 1, 0.3048],
  area: [1e6, 2.589988e6, 1, 4046.856, 1e4],
  volume: [1233.48, 1, 1233.48e6],
  flow: [0.0283168, 1],
  speed: [0.44704, 1, 0.277778, 0.514444],
  "mass-rate": [1, 1000],
  power: [1, 1000, 0.001],
  mass: [1, 907.185, 0.907185, 1000],
  percent: [1, 100, 0.01],
  temperature: [1],
  count: [1],
};

/** Words that make a number a duration, a time of day, a date part, a rank or a coordinate: not a measured claim. */
const SKIP_AFTER = /^(?:\s*(?:years?|yrs?|months?|weeks?|days?|hours?|hrs?|h\b|minutes?|mins?|seconds?|decades?|centuries|am\b|pm\b|a\.m\.|p\.m\.|utc\b|gmt\b|[ap]dt\b|[cemp]st\b|[cemp]dt\b|°\s*[nsew]\b|º\s*[nsew]\b|st\b|nd\b|rd\b|th\b|:\d)|\s*[-–]\s*\d{1,2}\s*(?:am|pm)\b)/i;
const SKIP_BEFORE = /(?:#|\bno\.\s*|\btop\s+|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+|\bclass\s+|\bhuc\s*|\bv\s*|\bt|\bs|\bd|\bm\s*|\bstep\s+|\bsection\s+|\broute\s+|\bfr\s+|\bhwy\s+|\bhighway\s+|\bi-|\bus-?|\bsr\s+|\busgs\s+|\bgauge\s+|\bstation\s+|\bid\s+|\$)$/i;

const SCALE: Record<string, number> = { thousand: 1e3, k: 1e3, million: 1e6, mn: 1e6, billion: 1e9, bn: 1e9 };
const HEDGE = /(?:about|around|roughly|approximately|approx\.?|nearly|almost|some|over|under|more\s+than|less\s+than|close\s+to|~|≈|>|<)\s*$/i;

type NoteNumber = { text: string; value: number; dim: Dimension; factor: number; hedged: boolean; decimals: number; isTemp?: "F" | "C" };

/** Numbers written in a note with what they measure; durations, dates, times, ranks and coordinates are left out. */
export function noteNumbers(text: string): NoteNumber[] {
  const out: NoteNumber[] = [];
  const re = /(?<![\w.\-‑/])(\d{1,3}(?:[,   ]\d{3})+|\d+)(?:\.(\d+))?(?![\d-]*\d{2}-\d)/g;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    let end = start + m[0].length;
    const before = text.slice(Math.max(0, start - 12), start);
    // ISO dates (2026-10-18), times (06:00) and version-like tokens.
    if (/\d[-:/]$/.test(before) || /^[-:/]\d/.test(text.slice(end, end + 2))) continue;
    if (SKIP_BEFORE.test(before)) continue;
    const decimals = m[2]?.length ?? 0;
    let value = Number(`${m[1].replace(/[,   ]/g, "")}${m[2] ? `.${m[2]}` : ""}`);
    let rest = text.slice(end);
    const scale = /^\s*(thousand|million|billion|mn|bn)\b|^(k)\b(?!\/)/i.exec(rest);
    if (scale) {
      value *= SCALE[(scale[1] ?? scale[2]).toLowerCase()];
      end += scale[0].length;
      rest = text.slice(end);
    }
    if (SKIP_AFTER.test(rest)) continue;
    const unitText = rest.replace(/^\s+/, "");
    const unit = UNITS.find((u) => u.re.test(unitText));
    const hedged = HEDGE.test(before);
    if (unit) {
      const isTemp = unit.dim === "temperature" ? (/^(?:°\s*f|º\s*f|degrees?\s+f)/i.test(unitText) ? "F" : "C") : undefined;
      out.push({ text: text.slice(start, end + (rest.length - unitText.length) + (unitText.match(unit.re)?.[0].length ?? 0)).trim(), value, dim: unit.dim, factor: unit.factor, hedged, decimals, ...(isTemp && { isTemp }) });
      continue;
    }
    // A bare number: a count worth checking when it is 10 or more and not a year.
    const year = Number.isInteger(value) && value >= 1800 && value <= 2100 && !/[,\s]/.test(m[1]);
    if (value >= 10 && !year && !scale) out.push({ text: m[0], value, dim: "count", factor: 1, hedged, decimals });
    else if (scale) out.push({ text: text.slice(start, end).trim(), value, dim: "count", factor: 1, hedged, decimals });
  }
  return out;
}

/** Every number in a value: numbers, and numbers written inside strings ("the 2,000 largest of 4,512"). */
function collectNumbers(value: unknown, into: Set<number>, texts: string[], depth = 0): void {
  if (depth > 12 || into.size > 60_000) return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) into.add(value);
    return;
  }
  if (typeof value === "string") {
    if (value.length < 2000) texts.push(value);
    for (const n of noteNumbers(value)) into.add(n.value);
    for (const m of value.matchAll(/\d+(?:\.\d+)?/g)) into.add(Number(m[0]));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value.slice(0, 5000)) collectNumbers(v, into, texts, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "coordinates" || k === "geometry") continue;
      if (k.length < 60) texts.push(k);
      collectNumbers(v, into, texts, depth + 1);
    }
  }
}

export type FactPool = {
  /** Numbers the model read as a whole: summaries (stats, totals, top lists), place lookups, routes and the question. */
  headline: number[];
  /** The headline numbers and every feature's own values. */
  all: number[];
  /** Each named feature's own values, by its name as compared. */
  byName: Map<string, number[]>;
  /** The names in byName, longest first. */
  names: string[];
  /** Numbers the question itself gives ("under 5 miles"). */
  given: number[];
  /** The summaries' totals and statistics (sum, mean, min, max, counts, total length and area). */
  aggregates: number[];
  text: string;
  flowClasses: string[];
  /** Each named feature's categorical values (aspect, shade, discipline, status ...), by its name as compared, then key. */
  facts: Map<string, Map<string, Set<string>>>;
  /** Every categorical value each key takes over the named features: what a sentence could claim. */
  vocab: Map<string, Set<string>>;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Keys whose values are names, ids, links or free text, never a class a note claims. */
const NOT_CATEGORICAL = /name|heading|title|url|^id$|Id$|source|region|forest|district|country|county|state|place|note|help|text|^t$|date/i;

/** A categorical value as compared: a short word or phrase in lower case, or a flag's "true" / "false". */
function categoryValues(v: unknown): string[] {
  if (typeof v === "boolean") return [String(v)];
  if (typeof v === "string") return /^\p{L}[\p{L} '+_-]{0,29}$/u.test(v.trim()) && v.trim().split(/\s+/).length <= 3 ? [v.trim().toLowerCase()] : [];
  if (Array.isArray(v) && v.length <= 12) return v.flatMap((x) => (typeof x === "string" ? categoryValues(x) : []));
  return [];
}

/** A named feature's categorical values, added to its facts. */
function collectFacts(props: Record<string, unknown>, key: string, facts: Map<string, Map<string, Set<string>>>): void {
  const mine = facts.get(key) ?? new Map<string, Set<string>>();
  for (const [k, v] of Object.entries(props)) {
    if (NOT_CATEGORICAL.test(k)) continue;
    const values = categoryValues(v);
    if (values.length === 0) continue;
    const set = mine.get(k) ?? new Set<string>();
    for (const x of values) set.add(x);
    mine.set(k, set);
  }
  if (mine.size > 0) facts.set(key, mine);
}

/** Named things in a result with their own values: GeoJSON features, and top lists ({ name, v }). */
function collectNamed(value: unknown, into: Map<string, Set<number>>, flow: Set<string>, depth = 0, facts?: Map<string, Map<string, Set<string>>>): void {
  if (depth > 10) return;
  if (Array.isArray(value)) {
    for (const v of value.slice(0, 5000)) collectNamed(v, into, flow, depth + 1, facts);
    return;
  }
  if (!isRecord(value)) return;
  const props = isRecord(value.properties) ? value.properties : value;
  // A class value ("normal", "much_above"), not the field's help text.
  if (typeof props.flowClass === "string" && /^[a-z_]{3,20}$/.test(props.flowClass)) flow.add(props.flowClass);
  const name = typeof props.name === "string" ? props.name : undefined;
  if (name && (props !== value || "v" in value || "value" in value)) {
    const key = comparable(name);
    const nums = into.get(key) ?? new Set<number>();
    const texts: string[] = [];
    collectNumbers(props, nums, texts);
    if (key.length >= 4) into.set(key, nums);
    if (facts && key.length >= 4) collectFacts(props, key, facts);
  }
  for (const [k, v] of Object.entries(value)) if (k !== "geometry" && typeof v === "object") collectNamed(v, into, flow, depth + 1, facts);
}

/** Keys under which a summary gives a whole-answer figure. */
const AGGREGATE_KEY = /^(?:sum|mean|min|max|count|featureCount|total\w*|\w*Total|\w*Sum|areaKm2|lengthKm)$/i;

function collectAggregates(value: unknown, into: Set<number>, depth = 0): void {
  if (depth > 8 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value.slice(0, 200)) collectAggregates(v, into, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "number" && AGGREGATE_KEY.test(k) && Number.isFinite(v)) into.add(v);
    else if (typeof v === "object") collectAggregates(v, into, depth + 1);
  }
}

/** Significant digits as written: "16.4" has 3, "0.5" has 1, "1,413" has 4. */
function significant(n: NoteNumber): number {
  const digits = n.text.replace(/[^\d.]/g, "").replace(/^0*\.?0*/, "").replace(".", "");
  return digits.replace(/0+$/, "").length || 1;
}

/** What the turn's tools returned, as the numbers, names and text a note may quote. */
export function factPool(outputs: unknown[], question: string): FactPool {
  const headline = new Set<number>();
  const all = new Set<number>();
  const texts: string[] = [question];
  const named = new Map<string, Set<number>>();
  const flow = new Set<string>();
  const facts = new Map<string, Map<string, Set<string>>>();
  for (const o of outputs) {
    // A query's answer: what the model read (the summary) and the features drawn (the body).
    const parts = isRecord(o) && "summary" in o && "body" in o ? { summary: o.summary, body: o.body } : { summary: o, body: undefined };
    collectNumbers(parts.summary, headline, texts);
    collectNumbers(parts.body, all, texts);
    collectNamed(parts.summary, named, flow);
    collectNamed(parts.body, named, flow, 0, facts);
  }
  const vocab = new Map<string, Set<string>>();
  for (const byKey of facts.values()) for (const [k, values] of byKey) for (const v of values) vocab.set(k, (vocab.get(k) ?? new Set<string>()).add(v));
  const aggregates = new Set<number>();
  for (const o of outputs) collectAggregates(isRecord(o) && "summary" in o ? o.summary : o, aggregates);
  const given = new Set<number>();
  for (const n of noteNumbers(question)) given.add(n.value);
  for (const m of question.matchAll(/\d+(?:\.\d+)?/g)) given.add(Number(m[0]));
  for (const n of given) headline.add(n);
  for (const n of headline) all.add(n);
  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
  const byName = new Map([...named].map(([k, v]) => [k, sorted(v)] as const));
  return {
    headline: sorted(headline),
    all: sorted(all),
    byName,
    names: [...byName.keys()].sort((a, b) => b.length - a.length),
    given: sorted(given),
    aggregates: sorted(aggregates),
    text: texts.join("\n").toLowerCase(),
    flowClasses: [...flow],
    facts,
    vocab,
  };
}

/** True when `x` (within `tol`) is in the sorted list. */
function has(sorted: number[], x: number, tol: number): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x - tol) lo = mid + 1;
    else if (sorted[mid] > x + tol) hi = mid - 1;
    else return true;
  }
  return false;
}

/** The values a written number may be stored as: itself in each unit of its dimension. */
function candidates(n: NoteNumber): number[] {
  if (n.dim === "temperature") return n.isTemp === "F" ? [n.value, ((n.value - 32) * 5) / 9] : [n.value, (n.value * 9) / 5 + 32];
  const base = n.value * n.factor;
  return STORED[n.dim].map((f) => base / f);
}

/** How far a stored value may be from the written one: a count exactly, a measure to its last written digit or 1% (10% hedged). */
function tolerance(n: NoteNumber, value: number): number {
  if (n.dim === "count") return n.hedged ? Math.abs(value) * 0.05 : 0.5 * 10 ** -n.decimals;
  const digit = 0.5 * 10 ** -n.decimals * (value / Math.max(1e-9, n.value));
  return Math.max(Math.abs(digit), Math.abs(value) * (n.hedged ? 0.1 : 0.01));
}

/**
 * True when a written number is traceable: a value in `nums`, or a difference or a ratio (as a percent) of two of
 * `derived` (the figures the model read whole, so a difference of two unrelated features does not count).
 */
export function grounded(n: NoteNumber, nums: number[], derived: number[] = nums): boolean {
  for (const c of candidates(n)) {
    const tol = tolerance(n, c);
    if (has(nums, c, tol) || has(nums, -c, tol)) return true;
  }
  const limited = derived.length > 3000 ? derived.filter((_, i) => i % Math.ceil(derived.length / 3000) === 0) : derived;
  nums = derived;
  if (n.dim !== "percent") {
    for (const c of candidates(n)) {
      const tol = tolerance(n, c);
      for (const a of limited) if (has(nums, a - c, tol)) return true;
    }
    return false;
  }
  const tol = n.hedged ? 3 : 1.5;
  for (const b of limited) {
    if (b === 0) continue;
    // a is x% of b, x% more or x% less than b.
    for (const a of [(b * n.value) / 100, b * (1 + n.value / 100), b * (1 - n.value / 100)]) if (has(nums, a, Math.abs(b) * (tol / 100))) return true;
  }
  return false;
}

/** Words that make a capitalised name a feature someone could walk to (a trail, a fall, a peak, a lake). */
const FEATURE_WORD = /\b(?:Trail|Trailhead|Loop|Falls|Fall|Peak|Mountain|Mount|Mt\.?|Lake|River|Creek|Canyon|Wall|Arch|Ridge|Pass|Basin|Springs?|Dome|Butte|Mesa|Cave|Glacier|Overlook|Vista|Crag|Boulders?|Campground|Beach|Reservoir|Bay|Point|Gulch|Hollow)\b/;

/** Capitalised names in a note that carry a feature word ("Royal Arch Trail", "Johnny Tiller Falls"). */
export function noteFeatureNames(text: string): string[] {
  const out: string[] = [];
  const re = /\b(?:[A-Z][\w'’.-]*|of|the|de|del|la)(?:\s+(?:[A-Z][\w'’.-]*|of|the|de|del|la))*\b/g;
  for (const m of text.matchAll(re)) {
    // A sentence's first word or a verb before the name is not part of it ("Try Royal Arch Trail").
    const span = m[0]
      .replace(/^(?:(?:Try|Hike|Visit|Take|See|Walk|Explore|Head|Start|From|Near|At|In|On|Both|And|Or|If|For|Then|Also|Consider|Check|Drive|Ride|Climb|Paddle|Fish|Camp|Use|Park|While|With|Via|The|A|An|Of|De|Del|La)\s+)+/i, "")
      .replace(/\s+(?:of|the|de|del|la)$/i, "")
      // A possessive is the name itself ("Lake Tahoe's shore").
      .replace(/['’]s$/, "")
      .trim();
    const words = span.split(/\s+/);
    if (words.length < 2 || !FEATURE_WORD.test(span)) continue;
    // A heading or a sentence start such as "The Lake" alone is not a name.
    if (words.every((w) => FEATURE_WORD.test(w) || /^(?:The|A|An|North|South|East|West|Upper|Lower)$/.test(w))) continue;
    out.push(span);
  }
  return [...new Set(out)];
}

/** Short forms station and gauge names use (SNOTEL's "Spirit Lk", "Ben Lomond Pk"), read as the words a note writes. */
const SHORT_FORMS: Record<string, string> = { lk: "lake", mtn: "mountain", mtns: "mountains", pk: "peak", ck: "creek", cr: "creek", crk: "creek", cyn: "canyon", rdg: "ridge", mdw: "meadow", mdws: "meadows", spg: "spring", spgs: "springs", res: "reservoir", rsvr: "reservoir" };

const comparable = (t: string) =>
  t
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’`]/g, "'")
    .replace(/\bmt\.?\s/g, "mount ")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\b[a-z]+\b/g, (w) => SHORT_FORMS[w] ?? w)
    .replace(/\s+/g, " ")
    .trim();

/** True when the results (or the question) name the feature, allowing "Mt." for "Mount" and a dropped "the". */
function named(name: string, pool: FactPool, poolText: string): boolean {
  const n = comparable(name);
  if (poolText.includes(n)) return true;
  // "Royal Arch Trail" is the result's "Royal Arch": the name without its trailing feature word.
  const words = n.split(" ");
  if (words.length > 2 && poolText.includes(words.slice(0, -1).join(" "))) return true;
  // The land unit around a place the question or a lookup named: "Mount Rainier National Park" for "Mount Rainier".
  const unit = n.replace(/\s+(?:national|state)\s+(?:park|forest|monument|recreation area|preserve|seashore|lakeshore)$|\s+wilderness(?:\s+area)?$/, "");
  return unit !== n && unit.split(" ").length >= 2 && poolText.includes(unit);
}

const HIGH_WORDS = /\b(?:well\s+above|above)\s+(?:normal|typical|average|usual|median)\b|\bunusually\s+high\b|\brunning\s+high\b|\bhigh\s+water\b|\brecord\s+high\b|\bflood(?:ing)?\s+levels?\b/i;
const LOW_WORDS = /\b(?:well\s+below|below)\s+(?:normal|typical|average|usual|median)\b|\brunning\s+low\b|\brecord\s+low\b/i;

/** Dimensions a feature has as its own value: what a sentence naming it says about it. */
const MEASURES = new Set<Dimension>(["length", "depth", "area", "flow", "speed", "temperature", "mass-rate", "volume", "power"]);

/** A note's sentences: its lines, and the sentences within each. */
function segments(markdown: string): string[] {
  return markdown.split("\n").flatMap((line) => line.split(/(?<=[.!?;])\s+(?=[A-Z*(])/)).filter((s) => s.trim() !== "");
}

/** Compass points by their degrees, as results write aspects (8 points) and as notes write them in words. */
const COMPASS: Record<string, number> = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315, nne: 22.5, ene: 67.5, ese: 112.5, sse: 157.5, ssw: 202.5, wsw: 247.5, wnw: 292.5, nnw: 337.5 };
const COMPASS_WORDS = "(?:north|south)(?:[\\s\u2010-\u2015-]?(?:east|west))?|east|west|NE|NW|SE|SW|NNE|ENE|ESE|SSE|SSW|WSW|WNW|NNW";
/** "faces south-west", "aspect is SW", "south-west-facing", "a west aspect": an aspect claimed, not a place's direction. */
const FACING = [
  new RegExp(`\\b(?:fac(?:e|es|ing)|aspect(?:\\s+(?:of|is))?|oriented|orientated)\\s+(?:the\\s+|due\\s+)?(${COMPASS_WORDS})\\b`, "gi"),
  new RegExp(`\\b(${COMPASS_WORDS})[\\s\u2010-\u2015-]*(?:facing|aspect)\\b`, "gi"),
];

/** A compass word or abbreviation in degrees, or undefined. */
function compassDegrees(word: string): number | undefined {
  const w = word.toLowerCase().replace(/[\s\u2010-\u2015-]+/g, "");
  const full: Record<string, string> = { north: "n", south: "s", east: "e", west: "w", northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw" };
  return COMPASS[full[w] ?? w];
}

/** The angle between two compass bearings, 0 to 180. */
const bearingGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

/** Shade said of a place: "shaded", "in the shade", "gets afternoon shade"; and its opposite, "sunny", "in full sun". */
const SHADE_NO = /\b(?:not\s+shaded|unshaded|no\s+(?:afternoon\s+)?shade|sunny|sun[\s-]?(?:baked|exposed)|in\s+(?:the\s+)?(?:full\s+)?sun)\b/i;
const SHADE_YES = /\b(?:shaded|shady|in\s+(?:the\s+)?shade|(?:gets?|has|have|offers?|keeps?)\s+(?:afternoon\s+|some\s+)?shade)\b/i;

/** A status that holds another: a fire that is out is contained. */
const IMPLIES: Record<string, string[]> = { out: ["contained"] };

/** Keys a sentence can give a class or status by name (a discipline, a difficulty, open or closed). */
const CLASS_KEY = /status|class|difficulty|danger|discipline|surface|severity|condition|rating|containment/i;

/**
 * Categorical claims in one sentence about the features it names (`about`): an aspect, shade, or a class or status
 * word from the results' own values that none of those features holds. A feature with no value for the key does not
 * count either way; a value the question gives ("sport and shaded") is still checked, since the note says it of a
 * named feature.
 */
function categoryClaims(segment: string, named: string[], pool: FactPool): Claim[] {
  const out: Claim[] = [];
  const text = segment.trim();
  // A one-word name that is a common noun ("Trail", a way OpenStreetMap names only by its kind) names no one feature.
  const about = named.filter((n) => !/^unnamed\b/.test(n) && !/^(?:trail|path|road|track|route|way|crag|wall|boulders?|area|lake|river|creek|peak|falls?|springs?|camp|campground|parking|trailhead)$/.test(n));
  const factsOf = (key: (k: string) => boolean) =>
    about.flatMap((n) => [...(pool.facts.get(n) ?? new Map<string, Set<string>>())].filter(([k]) => key(k)).map(([k, v]) => ({ name: n, key: k, values: v })));
  const nameOf = (n: string) => n.replace(/\b\w/g, (c) => c.toUpperCase());
  // Aspect: a facing direction against each named feature's compass value.
  const compassKeys = [...pool.vocab].filter(([, vs]) => [...vs].every((v) => COMPASS[v] !== undefined)).map(([k]) => k);
  const aspects = factsOf((k) => compassKeys.includes(k));
  if (aspects.length > 0) {
    for (const re of FACING) {
      for (const m of segment.matchAll(re)) {
        const said = compassDegrees(m[1]);
        if (said === undefined) continue;
        const near = aspects.some((a) => [...a.values].some((v) => bearingGap(COMPASS[v], said) <= 45));
        if (!near) {
          const held = aspects.map((a) => `${nameOf(a.name)} faces ${[...a.values].map((v) => v.toUpperCase()).join(" or ")}`).join("; ");
          out.push({ text, kind: "category", why: `"${m[0].trim()}": in the results ${held}` });
        }
      }
    }
  }
  // Shade: a flag on the feature (afternoonShade) against the sentence's shaded or sunny.
  const shade = factsOf((k) => /shade/i.test(k) && [...(pool.vocab.get(k) ?? [])].every((v) => v === "true" || v === "false"));
  if (shade.length > 0) {
    const no = SHADE_NO.exec(segment);
    const yes = SHADE_YES.exec(segment.replace(SHADE_NO, " "));
    const held = (v: string) => shade.some((f) => f.values.has(v));
    const words = (v: string) => shade.map((f) => `${nameOf(f.name)} ${f.values.has(v) ? "is" : "is not"} shaded`).join("; ");
    if (yes && !held("true")) out.push({ text, kind: "category", why: `"${yes[0]}": in the results ${words("true")}` });
    if (no && !held("false")) out.push({ text, kind: "category", why: `"${no[0]}": in the results ${words("true")}` });
  }
  // A class or status by the results' own words ("boulder", "closed", "paved"), outside the names themselves.
  const unnamed = ` ${comparable(segment)} `.replace(new RegExp(` (?:${about.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}) `, "g"), " | ");
  for (const [k, vocab] of pool.vocab) {
    if (!CLASS_KEY.test(k) || /shade/i.test(k) || compassKeys.includes(k) || vocab.size < 2 || vocab.size > 12) continue;
    const facts = factsOf((x) => x === k);
    if (facts.length === 0) continue;
    // A held value said with the word after it is that value ("below normal" of a gauge that is "below"), not the next class.
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let said = unnamed;
    for (const f of facts) for (const h of f.values) if (h.length >= 3) said = said.replace(new RegExp(` ${esc(comparable(h))} [\\p{L}-]+(?= )`, "gu"), " |");
    for (const v of vocab) {
      if (v === "true" || v === "false" || v.length < 3) continue;
      const word = comparable(v);
      if (!new RegExp(` ${esc(word)}s? `).test(said)) continue;
      if (facts.some((f) => f.values.has(v) || [...f.values].some((held) => IMPLIES[held]?.includes(v)))) continue;
      out.push({ text, kind: "category", why: `"${v}": in the results ${facts.map((f) => `${nameOf(f.name)} is ${[...f.values].join(", ")}`).join("; ")}` });
    }
  }
  return out;
}

/**
 * What a note claims that the turn's results do not hold: numbers, feature names, and flow words against flow classes.
 * A sentence about a named feature ("Johnny Tiller Falls: an easy loop of about 0.5 km") is held to that feature's own
 * values and the summaries' figures, so a number that only happens to equal some other feature's is still caught.
 */
export function ungroundedClaims(markdown: string, pool: FactPool): Claim[] {
  const claims: Claim[] = [];
  for (const segment of segments(markdown)) {
    const padded = ` ${comparable(segment)} `;
    const about = pool.names.filter((n) => n.length >= 5 && padded.includes(` ${n} `));
    // A feature's own values (and the question's), and with them the summaries' totals; differences only among the first.
    const featureOwn = [...new Set([...pool.given, ...about.flatMap((n) => pool.byName.get(n) ?? [])])].sort((a, b) => a - b);
    const own = [...new Set([...featureOwn, ...pool.aggregates])].sort((a, b) => a - b);
    const nums = about.length > 0 ? [...new Set([...pool.headline, ...own])].sort((a, b) => a - b) : pool.all;
    const derived = about.length > 0 ? nums : pool.headline;
    if (about.length > 0) for (const c of categoryClaims(segment, about, pool)) if (!claims.some((x) => x.text === c.text)) claims.push(c);
    for (const n of noteNumbers(segment)) {
      // A measure said of a named feature (its length, height, flow) is that feature's own value, not any figure read.
      // A precise figure (three significant digits, not hedged) found anywhere is not a coincidence: the model may have
      // shortened the feature's name ("Woody Mtn Barney Flat" for WOODYMTN-BARNEYFLAT-EPOCKETLO).
      const strict = about.length > 0 && MEASURES.has(n.dim);
      const ok = strict ? grounded(n, own, featureOwn) || (!n.hedged && significant(n) >= 3 && grounded(n, pool.all, featureOwn)) : grounded(n, nums, derived);
      if (!ok && !claims.some((c) => c.text === n.text)) claims.push({ text: n.text, kind: "number" });
    }
  }
  const poolText = comparable(pool.text);
  for (const name of noteFeatureNames(markdown)) if (!named(name, pool, poolText)) claims.push({ text: name, kind: "name" });
  for (const { re, needs } of MEASURE_WORDS) {
    const m = re.exec(markdown);
    if (m && !needs.test(pool.text)) claims.push({ text: m[0], kind: "measure" });
  }
  if (pool.flowClasses.length > 0) {
    const high = HIGH_WORDS.exec(markdown);
    if (high && !pool.flowClasses.some((c) => /above|high/.test(c))) claims.push({ text: high[0], kind: "flow" });
    const low = LOW_WORDS.exec(markdown);
    if (low && !pool.flowClasses.some((c) => /below|low/.test(c))) claims.push({ text: low[0], kind: "flow" });
  }
  return claims;
}

/**
 * The note without the sentences (or list items) that hold an ungrounded claim; headings left with nothing under them
 * go too. Returns the text unchanged when nothing is cut.
 */
export function withoutClaims(markdown: string, claims: Claim[]): string {
  if (claims.length === 0) return markdown;
  const hits = (s: string) => claims.some((c) => s.includes(c.text));
  const lines = markdown.split("\n").flatMap((line) => {
    if (!hits(line)) return [line];
    const bullet = /^(\s*(?:[-*•]|\d+\.)\s+)/.exec(line);
    if (bullet) return [];
    const kept = line.split(/(?<=[.!?])\s+/).filter((s) => !hits(s));
    return kept.length > 0 ? [kept.join(" ")] : [];
  });
  while (lines.length > 0 && (/^\s*(?:#{1,6}\s|\*\*[^*]+\*\*\s*$)/.test(lines[lines.length - 1]) || lines[lines.length - 1].trim() === "")) lines.pop();
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
