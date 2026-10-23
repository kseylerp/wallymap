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
 */

export type Claim = { text: string; kind: "number" | "name" | "flow" };

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
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Named things in a result with their own values: GeoJSON features, and top lists ({ name, v }). */
function collectNamed(value: unknown, into: Map<string, Set<number>>, flow: Set<string>, depth = 0): void {
  if (depth > 10) return;
  if (Array.isArray(value)) {
    for (const v of value.slice(0, 5000)) collectNamed(v, into, flow, depth + 1);
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
  }
  for (const [k, v] of Object.entries(value)) if (k !== "geometry" && typeof v === "object") collectNamed(v, into, flow, depth + 1);
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
  for (const o of outputs) {
    // A query's answer: what the model read (the summary) and the features drawn (the body).
    const parts = isRecord(o) && "summary" in o && "body" in o ? { summary: o.summary, body: o.body } : { summary: o, body: undefined };
    collectNumbers(parts.summary, headline, texts);
    collectNumbers(parts.body, all, texts);
    collectNamed(parts.summary, named, flow);
    collectNamed(parts.body, named, flow);
  }
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
      .trim();
    const words = span.split(/\s+/);
    if (words.length < 2 || !FEATURE_WORD.test(span)) continue;
    // A heading or a sentence start such as "The Lake" alone is not a name.
    if (words.every((w) => FEATURE_WORD.test(w) || /^(?:The|A|An|North|South|East|West|Upper|Lower)$/.test(w))) continue;
    out.push(span);
  }
  return [...new Set(out)];
}

const comparable = (t: string) =>
  t
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’`]/g, "'")
    .replace(/\bmt\.?\s/g, "mount ")
    .replace(/[^a-z0-9' ]+/g, " ")
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
