import type { z } from "zod";
import { getLayer } from "@/layers/registry";
import type { Attribute, Layer } from "@/layers/types";
import { placeCandidates } from "./places";
import { asksChange } from "./renderInput";
import { VOCABULARY } from "./vocabulary";

/**
 * The app's own reading of a question, made before the model chooses anything (audit R1, 2026-10-23: "flowy blue
 * trails" went to river flow, "since 2000" became 5 years, "this year" 730 days). Words people use are matched against
 * the layers' own vocabulary, their attributes' chip labels and help (a piste level's help names its colors per region),
 * a short table of phrases that name an activity rather than a layer, and the time phrases people say; the result goes
 * into the system prompt as one short block (readingForPrompt) and the step guard holds the queries and renders to it
 * where the mapping is mechanical: time inputs, a few inputs per phrase, filters on chips the question names.
 * Pure apart from the layer registry.
 */

export type TimeWindow = {
  /** The words as written ("since 2000", "this weekend"). */
  phrase: string;
  /** First and last day, YYYY-MM-DD. */
  from: string;
  to: string;
  /** The window lies ahead of today: a forecast question. */
  future: boolean;
  /** "in March" with no year: that month in every year (1 to 12). */
  month?: number;
  /** The window in plain words for the prompt. */
  label: string;
};

export type LayerHint = { layerId: string; because: string; strong: boolean };
export type FilterHint = { layerId: string; key: string; include?: string[]; range?: [number, number]; because: string; color?: boolean };
export type InputHint = { layerId: string; input: Record<string, unknown>; because: string };

export type Reading = {
  layers: LayerHint[];
  /** The species the question names in its own words ("sandhill cranes", "moose"), or null. */
  taxon: string | null;
  /** Layers the question's words rule out (a bike trail's "flowy" is not river flow). */
  avoid: { layerId: string; because: string }[];
  filters: FilterHint[];
  inputs: InputHint[];
  /** A measure to rank by ("big climbs": elevation gain). */
  rankBy: { layerId: string; key: string; because: string }[];
  time: TimeWindow | null;
  /** Places the question names in a short form ("the Madison" is the Madison River). */
  places: { written: string; place: string }[];
  /** Colors of a ski run or bike trail the question names (the filter depends on the region). */
  colors: ColorWord[];
  /** The question asks what changed ("since 2012", "shrunk", "then and now"). */
  change: boolean;
  /** How the question relates two layers ("outside protected areas", "along the Wonderland Trail"): the combine tool's op. */
  combine: CombineAsk | null;
};

export type CombineAsk = {
  op: "within" | "outside" | "near" | "along" | "overlap" | "drive_time";
  because: string;
  minutes?: number;
  distance?: number;
  unit?: "km" | "mi" | "m" | "ft";
  /** The named line a question goes along ("Wonderland Trail"), for combine's b.match. */
  match?: string;
};

/** Things a question asks to be near: water, trails, roads, camps (not a town: "near Boulder" is a place). */
const NEAR_THINGS = String.raw`(?:water|waterfalls?|lakes?|springs?|streams?|rivers?|creeks?|trailheads?|trails?|roads?|campsites?|camps?|campgrounds?|parking|huts?|peaks?|viewpoints?|fires?|wilderness|beaches?)`;

/**
 * The spatial relation between two layers a question asks for, or null: inside or within an area, outside it, overlapping
 * it, near or along something, or within some minutes' drive. "within 20 km" and "near <town>" are places, not relations.
 */
export function combineOf(question: string): CombineAsk | null {
  const q = question.replace(/@view=\S+/g, " ");
  let m: RegExpExecArray | null;
  if ((m = /\bwithin\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?)(?:['’]s?)?\s+(?:drive|driving)\b|\b(\d+(?:\.\d+)?)[- ](minute|min|hour)\s+drive\b/i.exec(q))) {
    const n = Number(m[1] ?? m[3]);
    const unit = (m[2] ?? m[4]).toLowerCase();
    return { op: "drive_time", minutes: /^h/.test(unit) ? n * 60 : n, because: m[0] };
  }
  if ((m = /\boutside\b|\bnot\s+(?:in|inside|within)\b|\b(?:isn['’]?t|aren['’]?t)\s+(?:in|inside|within)\b|\bunprotected\b/i.exec(q))) return { op: "outside", because: m[0] };
  if ((m = /\boverlap\w*|\bintersect\w*|\bin\s+(?:the\s+)?drought\b|\bthat\s+(?:are|is)\s+in\s+(?:a\s+|the\s+)?(?:drought|habitat|burn\w*|fire\w*)/i.exec(q))) return { op: "overlap", because: m[0] };
  // Along a named line (a trail, a road, a river), not "flooding along the Zambezi", one layer about one place.
  if ((m = /\balong\s+(?:the\s+)?(?:(?:[A-Z][\w'-]*\s+){1,4}(?:Trail|Road|Route|Way|Path|Loop|Highway|River|Creek|Coast)\b|(?:trail|road|route|river|creek|coast|shore)\b)/.exec(q))) {
    const name = m[0].replace(/^along\s+(?:the\s+)?/i, "").trim();
    return { op: "along", because: m[0].trim(), distance: 1, unit: "km", ...(/^[A-Z]/.test(name) && { match: name }) };
  }
  const near = new RegExp(String.raw`\b(?:near|close\s+to|next\s+to|by)\s+(?:a\s+|the\s+|any\s+)?${NEAR_THINGS}\b|\bwithin\s+(\d+(?:\.\d+)?)\s*(km|mi|miles?|m|ft|feet)\s+of\s+(?:a\s+|the\s+)?${NEAR_THINGS}\b`, "i").exec(q);
  if (near) {
    const unit = near[2] ? (/^mi/i.test(near[2]) ? "mi" : /^f/i.test(near[2]) ? "ft" : near[2].toLowerCase() === "m" ? "m" : "km") : "km";
    return { op: "near", because: near[0], distance: near[1] ? Number(near[1]) : 1, unit };
  }
  if ((m = /\b(?:inside|within)\s+(?:a\s+|the\s+)?(?![\d])(?:[A-Za-z][\w'-]*\s+){0,3}(?:national\s+forest|forest|park|wilderness|protected\s+areas?|habitat|burn\s+scars?|fire\s+perimeters?|reserve|monument|allotments?)\b/i.exec(q))) return { op: "within", because: m[0] };
  return null;
}

type ColorWord = { word: string; activity: "bike" | "ski" };

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, twenty: 20, thirty: 30, few: 3, several: 5 };
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const monthIndex = (word: string) => MONTHS.findIndex((m) => m.startsWith(word.toLowerCase().slice(0, 3)));
const fmtDay = (d: Date) => d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });

function amount(word: string): number {
  return /^\d+$/.test(word) ? Number(word) : (NUMBER_WORDS[word.toLowerCase()] ?? 1);
}

function window(phrase: string, from: Date, to: Date, today: Date, label: string, month?: number): TimeWindow {
  return { phrase, from: iso(from), to: iso(to), future: from.getTime() > today.getTime(), label, ...(month !== undefined && { month }) };
}

/** The most recent complete season (or the coming one for "this"), as [first day, last day]. */
function season(name: string, which: "last" | "this", today: Date): [Date, Date] {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const starts: Record<string, number> = { winter: 11, spring: 2, summer: 5, fall: 8, autumn: 8 };
  const start = starts[name];
  // A season runs three months from its start month; winter starts in December and ends in February.
  let startYear: number;
  if (name === "winter") {
    if (which === "last") startYear = m >= 2 ? y - 1 : y - 2;
    else startYear = m <= 1 ? y - 1 : y;
  } else {
    startYear = which === "this" || m >= start + 3 ? y : y - 1;
  }
  const first = day(startYear, start, 1);
  const last = addDays(day(startYear, start + 3, 1), -1);
  return [first, last];
}

/**
 * The time window a question's words name, relative to `now` (UTC days), or null when it names none. "now", "today"
 * and "currently" return today; "lately" 30 days; "this week" 7 days back; "this weekend" the coming Saturday and
 * Sunday; "since 2000" from January 1, 2000; "in March" every March; "last winter" the last December to February.
 */
export function timeWindow(question: string, now: Date = new Date()): TimeWindow | null {
  const q = question.replace(/@view=\S+/g, " ");
  const today = day(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const y = today.getUTCFullYear();
  let m: RegExpExecArray | null;

  if ((m = new RegExp(`\\bbetween\\s+((?:19|20)\\d\\d)\\s+and\\s+((?:19|20)\\d\\d)\\b`, "i").exec(q))) {
    const [a, b] = [Number(m[1]), Number(m[2])].sort();
    return window(m[0], day(a, 0, 1), day(b, 11, 31), today, `${a} to ${b}`);
  }
  if ((m = /\b(?:since|back to|as far back as)\s+the\s+((?:19|20)\d0)s\b/i.exec(q))) {
    const from = day(Number(m[1]), 0, 1);
    return window(m[0], from, today, today, `${iso(from)} to today`);
  }
  if ((m = new RegExp(`\\b(?:since|back to|as far back as|starting in|from)\\s+(?:${MONTH_RE}\\s+)?((?:19|20)\\d\\d)\\b`, "i").exec(q))) {
    const year = Number(m[2]);
    const month = m[1] ? monthIndex(m[1]) : 0;
    const from = day(year, month, 1);
    return window(m[0], from, today, today, `${iso(from)} to today`);
  }
  if ((m = /\b(?:in|over|during|for)\s+the\s+(?:last|past)\s+(\d+|a|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty|thirty|few|several)\s+(day|week|month|year|decade)s?\b|\b(?:the\s+)?(?:last|past)\s+(\d+|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty|thirty|few|several)\s+(day|week|month|year|decade)s?\b/i.exec(q))) {
    const n = amount(m[1] ?? m[3]);
    const unit = (m[2] ?? m[4]).toLowerCase();
    const from =
      unit === "day" ? addDays(today, -n) : unit === "week" ? addDays(today, -7 * n) : unit === "month" ? day(y, today.getUTCMonth() - n, today.getUTCDate()) : day(y - n * (unit === "decade" ? 10 : 1), today.getUTCMonth(), today.getUTCDate());
    return window(m[0], from, today, today, `${iso(from)} to today`);
  }
  if ((m = /\b(?:in|over|during|for|within)\s+the\s+(?:last|past)\s+(day|week|month|year|decade)\b|\b(?:the\s+)?past\s+(day|week|month|year|decade)\b|\bthe\s+last\s+decade\b/i.exec(q))) {
    const unit = (m[1] ?? m[2] ?? "decade").toLowerCase();
    const from = unit === "day" ? addDays(today, -1) : unit === "week" ? addDays(today, -7) : unit === "month" ? addDays(today, -30) : unit === "year" ? addDays(today, -365) : day(y - 10, today.getUTCMonth(), today.getUTCDate());
    return window(m[0], from, today, today, `${iso(from)} to today`);
  }
  if ((m = /\b(last|this(?:\s+past)?|past)\s+(winter|spring|summer|fall|autumn)\b/i.exec(q))) {
    const which = /^this$/i.test(m[1]) ? "this" : "last";
    const [from, to] = season(m[2].toLowerCase(), which, today);
    return window(m[0], from, to, today, `${iso(from)} to ${iso(to)}`);
  }
  if ((m = /\bthis\s+year\b|\bso\s+far\s+this\s+year\b|\byear\s+to\s+date\b/i.exec(q))) {
    return window(m[0], day(y, 0, 1), today, today, `${y}-01-01 to today`);
  }
  if ((m = /\blast\s+year\b/i.exec(q))) return window(m[0], day(y - 1, 0, 1), day(y - 1, 11, 31), today, `${y - 1}`);
  if ((m = /\bthis\s+month\b/i.exec(q))) return window(m[0], day(y, today.getUTCMonth(), 1), today, today, `${iso(day(y, today.getUTCMonth(), 1))} to today`);
  if ((m = /\blast\s+month\b/i.exec(q))) {
    const from = day(y, today.getUTCMonth() - 1, 1);
    return window(m[0], from, addDays(day(y, today.getUTCMonth(), 1), -1), today, `${iso(from).slice(0, 7)}`);
  }
  if ((m = /\b(?:this|last)\s+week\b/i.exec(q))) return window(m[0], addDays(today, -7), today, today, `${iso(addDays(today, -7))} to today`);
  if ((m = /\b(?:lately|recently|recent|these\s+days)\b/i.exec(q))) return window(m[0], addDays(today, -30), today, today, `the last 30 days (${iso(addDays(today, -30))} to today)`);
  if ((m = /\b(this|next|the)\s+weekend\b/i.exec(q))) {
    const dow = today.getUTCDay();
    let sat = addDays(today, (6 - dow + 7) % 7);
    if (dow === 0) sat = addDays(today, -1);
    if (/^next$/i.test(m[1])) sat = addDays(sat, 7);
    const sun = addDays(sat, 1);
    const from = sat.getTime() < today.getTime() ? today : sat;
    return { ...window(m[0], from, sun, today, `${fmtDay(sat)} and ${fmtDay(sun)}`), future: sun.getTime() > today.getTime() };
  }
  if ((m = /\b(?:the\s+)?day\s+after\s+tomorrow\b/i.exec(q))) {
    const d = addDays(today, 2);
    return window(m[0], d, d, today, fmtDay(d));
  }
  if ((m = /\btomorrow(?:'s)?\b/i.exec(q))) {
    const d = addDays(today, 1);
    return window(m[0], d, d, today, fmtDay(d));
  }
  if ((m = /\bnext\s+(\d+|two|three|four|five|six|seven|few|several)\s+days\b|\bnext\s+week\b|\bthis\s+coming\s+week\b/i.exec(q))) {
    const n = m[1] ? amount(m[1]) : 7;
    return { ...window(m[0], addDays(today, 1), addDays(today, n), today, `${iso(addDays(today, 1))} to ${iso(addDays(today, n))}`), future: true };
  }
  if ((m = new RegExp(`\\b(?:on|this|next)\\s+(${WEEKDAYS.join("|")})\\b`, "i").exec(q))) {
    const target = WEEKDAYS.indexOf(m[1].toLowerCase());
    const ahead = (target - today.getUTCDay() + 7) % 7 || (/^next/i.test(m[0]) ? 7 : 0);
    const d = addDays(today, ahead);
    return window(m[0], d, d, today, fmtDay(d));
  }
  if ((m = new RegExp(`\\b(?:in|during|for)\\s+${MONTH_RE}\\s+((?:19|20)\\d\\d)\\b`, "i").exec(q))) {
    const mi = monthIndex(m[1]);
    const year = Number(m[2]);
    return window(m[0], day(year, mi, 1), addDays(day(year, mi + 1, 1), -1), today, `${MONTHS[mi]} ${year}`);
  }
  if ((m = new RegExp(`\\b(?:in|during|for)\\s+(?:early\\s+|late\\s+|mid-?)?${MONTH_RE}\\b`, "i").exec(q)) && !/\bmay\b/i.test(m[1]) || (m = /\b(?:in|during)\s+(?:early\s+|late\s+|mid-?)?(may)\b(?!\s+(?:be|have|not|i|we|you))/i.exec(q))) {
    const mi = monthIndex(m[1]);
    // The month's most recent occurrence, so a date input lands on real data; the month itself applies to every year.
    const year = mi <= today.getUTCMonth() ? y : y - 1;
    return window(m[0], day(year, mi, 1), addDays(day(year, mi + 1, 1), -1), today, `${MONTHS[mi]} of each year (most recent: ${MONTHS[mi]} ${year})`, mi + 1);
  }
  if ((m = /\bin\s+((?:19|20)\d\d)\b/i.exec(q))) {
    const year = Number(m[1]);
    return window(m[0], day(year, 0, 1), year === y ? today : day(year, 11, 31), today, `${year}`);
  }
  if ((m = /\b(?:right\s+now|now|today|currently|at\s+the\s+moment|tonight|this\s+morning|this\s+afternoon|this\s+evening)\b/i.exec(q))) {
    return window(m[0], today, today, today, `today, ${fmtDay(today)}`);
  }
  return null;
}

// ---- Layers -----------------------------------------------------------------------------------------------------

/** Lower case, accents and punctuation gone, single spaces. */
const norm = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9+]+/g, " ")
    .trim();

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A word's spellings people use for it: plurals and -ing and -ed forms ("hike": hikes, hiking; "sky": skies). */
export function forms(word: string): string[] {
  const out = new Set([word]);
  const bases = new Set([word]);
  if (word.length > 5 && word.endsWith("ing")) {
    const b = word.slice(0, -3);
    bases.add(b).add(`${b}e`);
  } else if (word.length > 4 && word.endsWith("ies")) bases.add(`${word.slice(0, -3)}y`);
  else if (word.length > 4 && word.endsWith("es")) bases.add(word.slice(0, -2)).add(word.slice(0, -1));
  else if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) bases.add(word.slice(0, -1));
  for (const b of bases) {
    out.add(b);
    if (b.endsWith("y")) out.add(`${b.slice(0, -1)}ies`);
    if (b.endsWith("e")) out.add(`${b}s`).add(`${b.slice(0, -1)}ing`).add(`${b}d`);
    else out.add(`${b}s`).add(`${b}es`).add(`${b}ing`).add(`${b}ed`);
  }
  // Derived spellings that are other words: skiing's "skies", climbing's "climbs" (a run's ascents), warming's "warm".
  return [...out].filter((f) => f === word || (f.length >= Math.min(3, word.length) && !AMBIGUOUS_FORMS.has(f)));
}

const AMBIGUOUS_FORMS = new Set(["skies", "climbs", "warm", "warms", "warmed", "flood", "floods", "fir", "firs", "pathing"]);

/** A word or phrase as a regex that also takes each word's plural and -ing form ("beetle kill" matches "beetles kill"). */
function wordPattern(phrase: string): RegExp {
  const words = norm(phrase).split(" ").filter(Boolean);
  return new RegExp(`\\b${words.map((w) => (/^[a-z]+$/.test(w) ? `(?:${forms(w).map(escape).join("|")})` : escape(w))).join(" ")}\\b`);
}

/**
 * Phrases that name an activity or a decision rather than a layer, and what they mean on the map. `strong` phrases
 * add their layers to a step that forgot them and drop the layers in `avoid`.
 */
const PHRASES: {
  re: RegExp;
  unless?: RegExp;
  layers?: string[];
  avoid?: string[];
  inputs?: Record<string, Record<string, unknown>>;
  /** Chips a phrase means on a layer ("hikes" are paths and footpaths, not tracks, which are unpaved roads). */
  filters?: Record<string, Record<string, string[]>>;
  because: string;
}[] = [
  {
    re: /\b(?:green|blue|black|red|double[- ]black)(?:\s+(?:circle|square|diamond))?\s+(?:trails?|singletrack|loops?|lines?|rides?)\b|\bflowy\b|\bflow\s+trails?\b|\bjump\s+lines?\b|\bblack\s+diamonds?\b(?=[^?]*\b(?:bike|biking|mtb|ride|riding|trails?)\b)/i,
    layers: ["mtb-trails"],
    avoid: ["river-pulse", "streamflow"],
    because: "a trail color or flow trail is a mountain bike rating",
  },
  {
    re: /\b(?:day\s+hikes?|good\s+hikes?|best\s+hikes?|easy\s+hikes?|short\s+hikes?|long\s+hikes?|hikes?\b(?!\s+(?:to|up)\b)|trail\s+runs?|trail\s+running|long\s+runs?)\b/i,
    layers: ["osm-trails"],
    filters: { "osm-trails": { kind: ["path", "footway"] } },
    because: "hikes and runs are whole named trails with length and climb",
  },
  {
    re: /\bwater\s+sources?\b|\bwhere\s+(?:to|can\s+i)\s+(?:get|find|filter)\s+water\b|\b(?:camping|camps?)\s+and\s+water\b|\bwater\s+(?:along|on)\s+the\b/i,
    layers: ["outdoor-features", "lakes"],
    inputs: { "outdoor-features": { kinds: ["spring", "drinking_water"] } },
    because: "backcountry water is springs, taps, lakes and streams",
  },
  {
    re: /\bdispersed\b|\bboondock\w*|\bvan\b[^?]*\b(?:overnight|park|sleep|camp)\w*|\bovernight\s+parking\b|\bblm\s+land\b|\bfree\s+camping\b/i,
    layers: ["public-lands", "forest-roads"],
    because: "where free or dispersed camping is legal depends on who manages the land",
  },
  {
    re: /\bfall\s+colou?rs?\b|\bfoliage\b|\bleaves\s+(?:changing|turning)\b|\bautumn\s+colou?rs?\b|\bleaf[- ]peeping\b/i,
    layers: ["imagery-by-date"],
    avoid: ["greenness"],
    because: "fall color shows on the newest clear true-color satellite picture; greenness (NDVI) does not show color",
  },
  {
    re: /\bclass\s+(?:[1-6]|i{1,3}|iv|vi?)\+?(?=[\s?.,!]|$)|\bwhitewater\s+runs?\b|\b(?:runs?|rivers?)\b[^?]*\benough\s+water\b/i,
    layers: ["paddling", "streamflow"],
    because: "a whitewater run is a paddling section read with the gauge flow",
  },
  {
    re: /\bbackpack\w*|\bbackcountry\s+camp\w*|\bcamp\w*\s+along\b|\bthru[- ]hik\w*/i,
    inputs: { campsites: { includeParking: false, backcountryOnly: true } },
    because: "a backpacker's camp is not a parking lot",
  },
  {
    // Camping is not parking: Mojave Road's "campsites" were Big Bear's ski parking lots (Moonridge Lot, 1,200 spaces).
    re: /\bcamp(?:ing|s|sites?|grounds?)?\b/i,
    unless: /\bpark(?:ing)?\b|\bvans?\b|\brvs?\b|\bcar\s+camp\w*|\bovernight\b|\btrailheads?\b/i,
    inputs: { campsites: { includeParking: false } },
    because: "a place to camp is not a parking lot",
  },
  {
    re: /\bsnow[- ]free\b|\bstill\s+snow\b|\bsnow\s+on\s+the\b|\bany\s+snow\b|\bmelted\s+out\b|\bsnow\s+line\b/i,
    layers: ["snow-cover"],
    because: "snow on the ground is the daily satellite snow map",
  },
  {
    re: /\blaunch\s+(?:a\s+|my\s+)?(?:kayak|canoe|boat|paddle\s*board|sup|raft)\b|\bput[- ]ins?\b|\bboat\s+(?:ramp|launch)\b/i,
    layers: ["recreation-sites", "paddling"],
    because: "launch points are federal water-access sites and mapped put-ins",
  },
  {
    re: /\bshade[ds]?\b|\bshady\b|\b(?:north|south|east|west)[- ]facing\b|\bfaces?\s+(?:north|south|east|west)\b|\baspect\b|\bslope\s+angle\b|\bslopes?\s+(?:over|above|under|below)\s+\d+|\b\d+\s*°|\blow[- ]angle\b|\bavalanche\s+terrain\b|\bsteepness\b/i,
    layers: ["terrain"],
    because: "slope, aspect and shade come from the terrain layer (when the app has it)",
  },
  {
    re: /\bwill\s+it\s+(?:rain|snow|storm)\b|\brain(?:fall)?\b|\btoo\s+(?:hot|cold)\b|\btemperatures?\b|\bforecast\b|\bfreez\w+\b|\bheat\b|\bwindy\b|\bgusts?\b/i,
    unless: /\bwater\s+temp\w*|\bsea\s+surface\b|\bwarming\b|\btemperature\s+anomal\w*/i,
    layers: ["weather-forecast"],
    because: "weather ahead is the 7-day forecast for the place (when the app has it)",
  },
  {
    re: /\bavalanche\w*\b/i,
    layers: ["avalanche"],
    avoid: ["weather-alerts"],
    because: "avalanche danger is the avalanche center's forecast (when the app has it), not a weather warning",
  },
  {
    re: /\bgoing\s+to\s+flood\b|\bflood\s+stage\b|\bwill\s+(?:it|the\s+\w+(?:\s+\w+)?)\s+flood\b|\bcrest\w*\b/i,
    layers: ["streamflow"],
    because: "a river's flood stage and forecast are on its gauges",
  },
  {
    re: /\b(?:aren'?t|not|isn'?t)\s+too\s+warm\b|\b(?:cool|cold)\s+enough\b/i,
    filters: { fishing: { tempBand: ["cold", "good"] } },
    because: "trout water that is not too warm is under 64 °F",
  },
  {
    re: /\b(?:moose|elk|deer|bears?|grizzl\w*|whales?|humpbacks?|dolphins?|orcas?|seals?|sea\s+lions?|otters?|eagles?|owls?|hawks?|falcons?|cranes?|herons?|pelicans?|bison|buffalo|pronghorn|bighorn|mountain\s+goats?|jaguars?|pumas?|cougars?|mountain\s+lions?|lynx|bobcats?|coyotes?|foxes|beavers?|butterfl\w+|monarchs?|wildflowers?|puffins?|condors?|tortoises?|salamanders?|frogs?|snakes?|rattlesnakes?)\b/i,
    unless: /\bhabitat\b|\brange\s+map\b|\bherds?\b|\bwild\s+horses?\b|\bburros?\b|\bwolf\s+packs?\b/i,
    layers: ["species"],
    because: "sightings of a species are iNaturalist records (GBIF over wide areas)",
  },
  {
    re: /\bsunsets?\b|\bsunrises?\b|\bgolden\s+hour\b|\bviewpoints?\b|\boverlooks?\b|\bvistas?\b/i,
    layers: ["outdoor-features", "photos"],
    inputs: { "outdoor-features": { kinds: ["viewpoint"] } },
    because: "a view is a mapped viewpoint, and photos show where people shoot",
  },
  {
    re: /\b(?:forests?|trees?|tree\s+cover)\b[^?]*\b(?:lose|lost|loss|losing|cleared|cut\s+down)\b|\b(?:lose|lost|loss)\b[^?]*\b(?:forests?|trees?)\b/i,
    layers: ["forest-loss"],
    because: "forest lost is the yearly tree cover loss map",
  },
  {
    re: /\bpublic\s+(?:access|land)\b/i,
    layers: ["public-lands"],
    because: "public access is land a public agency manages",
  },
  {
    re: /\btrout\b|\bfly[- ]fish\w*|\bwater\s+temp\w*|\btoo\s+warm\b/i,
    layers: ["fishing", "streamflow"],
    because: "trout water is a river's temperature and flow at its gauges",
  },
  {
    re: /\bdark(?:est)?\s+sk(?:y|ies)\b|\bmilky\s+way\b|\bstargaz\w*|\bastrophoto\w*/i,
    layers: ["night-lights"],
    because: "a dark sky is little light at night from the satellite",
  },
];

/** Animal words, and the words before one that make it a species ("sandhill cranes", "bald eagles"). */
const ANIMAL = /\b(?:moose|elk|deer|bears?|grizzl\w*|whales?|humpbacks?|dolphins?|orcas?|seals?|sea\s+lions?|otters?|eagles?|owls?|hawks?|falcons?|cranes?|herons?|pelicans?|bison|buffalo|pronghorn|bighorn|mountain\s+goats?|jaguars?|pumas?|cougars?|mountain\s+lions?|lynx|bobcats?|coyotes?|foxes|beavers?|butterfl\w+|monarchs?|puffins?|condors?|tortoises?|salamanders?|frogs?|snakes?|rattlesnakes?)\b/i;
const NOT_KIND = /^(?:the|a|an|see|any|some|where|are|is|of|for|best|place|to|near|in|have|been|being|seen|recent|records?|whales?|can|i|and|or|with)$/i;

/** The species a question names, with the word before it when that word says which ("sandhill cranes"); null when none. */
export function taxonOf(text: string): string | null {
  const m = ANIMAL.exec(text);
  if (!m) return null;
  const before = text.slice(0, m.index).trim().split(/\s+/).slice(-1)[0] ?? "";
  return (/^[a-z][a-z-]{2,}$/i.test(before) && !NOT_KIND.test(before) ? `${before} ${m[0]}` : m[0]).toLowerCase();
}

/** The words that make a color mean a ski run, and a bike trail. */
const SKI_CONTEXT = /\b(?:ski\w*|piste\w*|slopes?|snowboard\w*|resort|lifts?|groomers?)\b|\bruns?\b(?<!trail runs?)(?![^?]*\btrail)/i;
const BIKE_CONTEXT = /\b(?:mtb|mountain\s+bik\w*|bik\w*|singletrack|flowy|flow\s+trails?|rid(?:e|es|ing)|trails?)\b/i;
const COLOR_WORDS = /\b(double[- ]black(?:\s+diamond)?|black(?:\s+diamond)?|blue(?:\s+square)?|green(?:\s+circle)?|red|orange|white(?:\s+circle)?)\b/gi;

/** Region a color scale is read in: piste colors differ between North America and Europe. */
export type ColorRegion = "north-america" | "europe" | "other";

export function colorRegion(center: [number, number] | null | undefined): ColorRegion {
  if (!center) return "north-america";
  const [lng, lat] = center;
  if (lng > -170 && lng < -50 && lat > 14) return "north-america";
  if (lng > -25 && lng < 45 && lat > 34) return "europe";
  return "other";
}

/** One level's colors per region, read from its help ("green circle (North America), blue (Europe)"). */
function levelColors(help: string | undefined): { color: string; region: ColorRegion | "any" }[] {
  if (!help) return [];
  const out: { color: string; region: ColorRegion | "any" }[] = [];
  const re = /((?:double\s+)?(?:green|blue|red|black|orange|white)(?:\s+(?:circle|square|diamond))?(?:\s+or\s+(?:green|blue|red|black|orange))?)\s*\(([^)]*)\)/gi;
  for (const m of help.matchAll(re)) {
    const where = m[2].toLowerCase();
    const region: ColorRegion | "any" = /north america/.test(where) ? "north-america" : /europe/.test(where) ? "europe" : "any";
    for (const c of m[1].split(/\s+or\s+/)) out.push({ color: norm(c).replace(/\s+(?:circle|square|diamond)$/, "").trim(), region });
  }
  // "Moderate (blue square)": a color inside the parentheses, for every region.
  for (const m of help.matchAll(/\(((?:double\s+)?(?:green|blue|red|black|orange|white))(?:\s+(?:circle|square|diamond))?\)/gi)) {
    out.push({ color: norm(m[1]), region: "any" });
  }
  return out;
}

/** IMBA's trail signs, when the layer has no attribute that names them (mtb:scale:imba 0 to 4). */
const IMBA_COLORS: Record<string, string[]> = { white: ["0"], green: ["1"], blue: ["2"], black: ["3"], "double black": ["4"] };

/**
 * The filter a color word means on a layer: the attribute whose level help names that color in this region (piste
 * difficulty: "blue" is intermediate in North America and easy in Europe), else, for mountain bike trails, IMBA's signs.
 */
export function colorFilter(layer: Pick<Layer, "id" | "attributes">, word: string, region: ColorRegion): { key: string; include: string[] } | null {
  const color = norm(word).replace(/\s+(?:circle|square|diamond)$/, "").replace(/^double black.*/, "double black");
  for (const attr of layer.attributes ?? []) {
    if (attr.type !== "ordinal" && attr.type !== "category") continue;
    const regional = (attr.levels ?? []).filter((l) => levelColors(l.help).some((c) => c.color === color && (c.region === region || c.region === "any")));
    const values = (regional.length > 0 ? regional : (attr.levels ?? []).filter((l) => levelColors(l.help).some((c) => c.color === color && c.region === "north-america")))
      .filter((l) => !(color === "black" && levelColors(l.help).some((c) => c.color === "double black" && (c.region === region || c.region === "any")) && !levelColors(l.help).some((c) => c.color === "black" && (c.region === region || c.region === "any"))))
      .map((l) => String(l.value));
    if (values.length > 0) return { key: attr.key, include: [...new Set(values)] };
  }
  if (layer.id === "mtb-trails" && IMBA_COLORS[color]) return { key: "imba", include: IMBA_COLORS[color] };
  return null;
}

/** Synonyms of difficulty words, so "intermediate" finds a chip labelled Moderate. */
const LEVEL_SYNONYMS: Record<string, string[]> = {
  beginner: ["easy", "novice"],
  easy: ["beginner", "novice"],
  intermediate: ["moderate"],
  moderate: ["intermediate"],
  advanced: ["hard", "difficult"],
  hard: ["advanced", "difficult"],
  expert: ["elite", "extreme"],
};

/** The bare words of a chip label ("Alpine hiking (T4)" is "alpine hiking"; "D3 Extreme Drought" is "extreme drought"). */
const bareLabel = (label: string) => norm(label.replace(/^[A-Z]{1,2}\d\s+/, "").replace(/\s*\([^)]*\)\s*$/, ""));

/** Words that are the layer's own subject: "hiking" on the trails layer names the activity, not its easiest grade. */
function subjectWords(layer: Pick<Layer, "id" | "title">): Set<string> {
  const entry = VOCABULARY.find((e) => e.layerId === layer.id);
  return new Set([...(entry?.synonyms ?? []), ...norm(layer.title).split(" ")].flatMap((w) => norm(w).split(" ")).flatMap(forms));
}

/** Attributes that say how a thing stands (a fire's status), which a question asks about rather than chooses. */
const STATE_KEYS = /^(?:status|state|condition|containment|active|open|closed)$/i;

/** Chip values the question names on one layer (labels, codes such as "class IV", difficulty synonyms), by attribute. */
function chipFilters(layer: Layer, q: string): FilterHint[] {
  const out: FilterHint[] = [];
  const subject = subjectWords(layer);
  for (const attr of layer.attributes ?? []) {
    if ((attr.type !== "ordinal" && attr.type !== "category") || !attr.levels?.length || STATE_KEYS.test(attr.key)) continue;
    const byLabel = new Map<string, string[]>();
    for (const l of attr.levels) byLabel.set(l.label, [...(byLabel.get(l.label) ?? []), String(l.value)]);
    const picked: string[] = [];
    let because = "";
    for (const [label, values] of byLabel) {
      const bare = bareLabel(label);
      // A grade or kind named like the layer's subject ("Hiking (T1)", a "Crag") is the subject, not a choice among them.
      if (bare.length < 3 || ((attr.type === "ordinal" || attr.key === "kind") && bare.split(" ").every((w) => subject.has(w)))) continue;
      // A whitewater class: "class III", "class 3", "Class IV+".
      const roman = /^class ([ivx]+)$/.exec(bare);
      const words = [bare, ...(LEVEL_SYNONYMS[bare] ?? [])];
      const hit = words.find((w) => wordPattern(w).test(q)) ??
        (roman ? [`class ${roman[1]}`, `class ${["", "i", "ii", "iii", "iv", "v", "vi"].indexOf(roman[1])}`].find((w) => new RegExp(`\\b${w}\\b`).test(q)) : undefined);
      if (hit) {
        picked.push(...values);
        because = hit;
      }
    }
    // Every chip of the attribute named is no choice at all.
    if (picked.length > 0 && picked.length < attr.levels.length) out.push({ layerId: layer.id, key: attr.key, include: [...new Set(picked)], because });
  }
  return out;
}

const MI_KM = 1.609344;

/** A length the question bounds ("under 5 miles", "over 10 km", "at least 8 mi"), as a km range, or null. */
export function lengthRange(question: string): { range: [number, number]; because: string } | null {
  const m = /\b(under|less than|shorter than|below|up to|at most|max(?:imum)?|over|more than|longer than|at least|above|min(?:imum)?)\s+(\d+(?:\.\d+)?)\s*(miles?|mi|kilomet(?:er|re)s?|km)\b/i.exec(question);
  if (!m) return null;
  const n = Number(m[2]) * (/^mi/i.test(m[3]) ? MI_KM : 1);
  const upper = /^(under|less|shorter|below|up|at most|max)/i.test(m[1]);
  return { range: upper ? [0, Math.round(n * 100) / 100] : [Math.round(n * 100) / 100, 100_000], because: m[0] };
}

/** True when a layer's answer can be ranked or filtered by `key` (a declared attribute, or the card's measure). */
function hasMeasure(layer: Layer, key: string): boolean {
  return (layer.attributes ?? []).some((a) => a.key === key) || layer.card?.measure?.key === key;
}

/** "the Madison", "the Gauley", "the French Broad" in a question about a river's water: the river's full name. */
export function riverNames(question: string): { written: string; place: string }[] {
  const out: { written: string; place: string }[] = [];
  const re = /\bthe\s+((?:[A-Z][a-z]+)(?:\s+[A-Z][a-z]+)?)\b(?!\s+(?:River|Creek|Fork|Lake|Bay|Trail|Road|Range|Mountains?|National|Valley|Canyon|Basin|Desert|Coast|Gorge|Wilderness|Forest))/g;
  const river = /\b(?:running|run|runnable|flow\w*|flood\w*|fish\w*|float\w*|paddl\w*|raft\w*|kayak\w*|cfs|water\s+level|level|high|low|release)\b/i;
  for (const m of question.matchAll(re)) {
    const rest = question.slice((m.index ?? 0) + m[0].length);
    if (!river.test(rest.slice(0, 40))) continue;
    if (/\b(?:River|Creek|Fork|Lake|Bay|Trail|Road|Range|Mountains?|National|Valley|Canyon|Basin|Desert|Coast|Gorge|Wilderness|Forest|Park)$/.test(m[1])) continue;
    if (/^(?:Arctic|Antarctic|Rockies|Andes|Alps|Sierra|Tetons|Cascades|Everglades|Grand|Great)$/.test(m[1].split(" ")[0])) continue;
    out.push({ written: `the ${m[1]}`, place: `${m[1]} River` });
  }
  return out;
}

/**
 * The reading of one question: layers its words name (vocabulary synonyms and activity phrases), chips and length
 * bounds to filter on, inputs a phrase decides, the time window, and short place names spelled out.
 */
export function readQuestion(question: string, now: Date = new Date()): Reading {
  const raw = question.replace(/@view=\S+/g, " ");
  // Place names are not layer words: "Wind Rivers" is no wind, "Lake Powell" no lake, "Glacier National Park" no glacier.
  let masked = raw;
  const named = placeCandidates(raw).filter((p) => !/^(?:class\s+)?(?:[ivx]+|\d)\+?$/i.test(p));
  for (const place of named) masked = masked.replace(new RegExp(`\\b${escape(place)}\\b`, "g"), " ");
  const q = norm(masked);
  const layers: LayerHint[] = [];
  const avoid: Reading["avoid"] = [];
  const inputs: InputHint[] = [];
  const phraseFilters: FilterHint[] = [];
  const addLayer = (layerId: string, because: string, strong: boolean) => {
    if (!getLayer(layerId)) return;
    const had = layers.find((l) => l.layerId === layerId);
    if (had) had.strong ||= strong;
    else layers.push({ layerId, because, strong });
  };
  for (const p of PHRASES) {
    const m = p.re.exec(masked);
    if (!m) continue;
    const strong = !(p.unless && p.unless.test(masked));
    for (const id of p.layers ?? []) addLayer(id, `"${m[0].trim()}": ${p.because}`, strong);
    // Avoid a layer only when the layer the phrase names exists (the forecast and avalanche layers may not yet).
    if ((p.layers ?? []).every((id) => getLayer(id))) for (const id of p.avoid ?? []) avoid.push({ layerId: id, because: `"${m[0].trim()}": ${p.because}` });
    // A phrase whose "unless" words are there names its layers only loosely and sets nothing.
    if (strong) for (const [layerId, input] of Object.entries(p.inputs ?? {})) if (!inputs.some((i) => i.layerId === layerId && JSON.stringify(i.input) === JSON.stringify(input))) inputs.push({ layerId, input, because: `"${m[0].trim()}": ${p.because}` });
    for (const [layerId, chips] of Object.entries(p.filters ?? {})) {
      for (const [key, include] of Object.entries(chips)) phraseFilters.push({ layerId, key, include, because: m[0].trim() });
    }
  }
  const places = riverNames(raw);
  for (const p of places) addLayer("streamflow", `"${p.written}" is a river: its gauges`, false);
  // A named trail or route ("the Wonderland Trail") is drawn whole from the trails layer's named routes.
  for (const p of named) if (/\b(?:Trail|Route|Way|Loop|Path)$/.test(p)) addLayer("osm-trails", `"${p}" is a named trail`, true);
  for (const entry of VOCABULARY) {
    // A capitalised synonym is a name ("Lake Powell", "Bears Ears"), matched as written.
    const hit = entry.synonyms.find((s) => (/^[A-Z][a-z]/.test(s) && /\s/.test(s) ? new RegExp(`\\b${escape(s)}\\b`, "i").test(raw) : wordPattern(s).test(q)));
    if (hit) addLayer(entry.layerId, `"${hit}"`, false);
  }
  // A layer the words rule out stays out unless the question also names it in its own words.
  const kept = avoid.filter((a) => !layers.some((l) => l.layerId === a.layerId && !l.strong && !/^"(?:flow|run)/.test(l.because)));
  for (const a of kept) {
    const i = layers.findIndex((l) => l.layerId === a.layerId && !l.strong);
    if (i >= 0) layers.splice(i, 1);
  }

  // Colors of trails and runs: a ski run's color depends on the region (resolved when the place is known).
  const colors: ColorWord[] = [];
  const skiing = SKI_CONTEXT.test(raw);
  const biking = BIKE_CONTEXT.test(raw);
  if (skiing || biking) {
    for (const m of raw.matchAll(COLOR_WORDS)) {
      const after = raw.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 30);
      // Only a color that describes the trail or run ("blue trails", "black diamond runs"), not "Blue Ridge".
      if (!/^\s*(?:and\s+\w+\s+)?(?:trails?|singletrack|runs?|pistes?|slopes?|loops?|lines?|rides?|diamonds?|squares?|circles?|groomers?)\b/i.test(after) && !/diamond|square|circle/i.test(m[0])) continue;
      const word = norm(m[0]);
      if (!colors.some((c) => c.word === word)) colors.push({ word, activity: skiing && !/\b(?:bike|mtb|singletrack|flowy)\b/i.test(raw) ? "ski" : "bike" });
    }
    for (const c of colors) addLayer(c.activity === "ski" ? "ski-routes" : "mtb-trails", `"${c.word}" ${c.activity === "ski" ? "run" : "trail"}`, true);
  }
  // A trail of one activity (bike, ski) is not every hiking path.
  if (layers.some((l) => l.layerId === "mtb-trails" || l.layerId === "ski-routes")) {
    const i = layers.findIndex((l) => l.layerId === "osm-trails" && !l.strong);
    if (i >= 0) layers.splice(i, 1);
  }

  const filters: FilterHint[] = [...phraseFilters];
  for (const hint of layers) {
    const layer = getLayer(hint.layerId);
    if (layer) filters.push(...chipFilters(layer, q));
  }
  const length = lengthRange(raw);
  const rankBy: Reading["rankBy"] = [];
  for (const hint of layers) {
    const layer = getLayer(hint.layerId);
    if (!layer) continue;
    if (length && hasMeasure(layer, "lengthKm")) filters.push({ layerId: layer.id, key: "lengthKm", range: length.range, because: length.because });
    const climb = /\b(?:big|lots? of|most|serious|steep|huge)\s+(?:climb\w*|elevation|vert\w*|gain)\b|\bclimbs?\b|\belevation gain\b|\bsteep\w*/i.exec(raw);
    if (climb && hasMeasure(layer, "gainM") && !/\bflat\b/i.test(raw)) rankBy.push({ layerId: layer.id, key: "gainM", because: climb[0] });
    const flat = /\bflat(?:test)?\b|\blittle\s+climb\w*|\bgentle\b/i.exec(raw);
    if (flat && hasMeasure(layer, "gainPerKm")) filters.push({ layerId: layer.id, key: "gainPerKm", range: [0, 15], because: flat[0] });
    if (!climb && !flat && /\blong(?:est)?\b/i.test(raw) && hasMeasure(layer, "lengthKm")) rankBy.push({ layerId: layer.id, key: "lengthKm", because: "long" });
  }

  // A grade the question gives with a style ("beginner sport") is that style's grade where the layer keeps one per
  // style ("Sport grade"), not the crag's grade over every style: a trad-only easy crag with one hard sport line passed.
  for (const grade of filters.filter((f) => getLayer(f.layerId)?.attributes?.find((a) => a.key === f.key)?.label === "Grade" && f.include)) {
    const layer = getLayer(grade.layerId);
    const styled = (layer?.attributes ?? []).filter((a) => {
      const style = /^(\w+) grade$/i.exec(a.label)?.[1];
      return a.type === "ordinal" && style !== undefined && wordPattern(style).test(q);
    });
    if (styled.length === 0) continue;
    filters.splice(filters.indexOf(grade), 1, ...styled.map((a) => ({ ...grade, key: a.key })));
  }

  return { combine: combineOf(raw), taxon: taxonOf(masked), layers, avoid: kept, filters, inputs, rankBy, time: timeWindow(raw, now), places, colors, change: asksChange(raw) || /\b(?:shrunk|shrank|retreat\w*|then\s+and\s+now|changed?\s+since)\b/i.test(raw) };
}

// ---- Inputs from the time window ---------------------------------------------------------------------------------

type Shape = Record<string, z.ZodType>;

/** The schema under optional, default and nullable wrappers. */
function inner(schema: z.ZodType): z.ZodType {
  let s = schema as unknown as { _zod?: { def?: { innerType?: z.ZodType } } };
  for (let i = 0; i < 5 && s._zod?.def?.innerType; i++) s = s._zod.def.innerType as unknown as typeof s;
  return s as unknown as z.ZodType;
}

function bounds(schema: z.ZodType): { min: number; max: number } {
  const n = inner(schema) as unknown as { minValue?: number | null; maxValue?: number | null };
  return { min: typeof n.minValue === "number" && Number.isFinite(n.minValue) ? n.minValue : -Infinity, max: typeof n.maxValue === "number" && Number.isFinite(n.maxValue) ? n.maxValue : Infinity };
}

const clamp = (v: number, { min, max }: { min: number; max: number }) => Math.max(min, Math.min(max, v));

function shapeOf(layer: Pick<Layer, "input">): Shape {
  const s = layer.input as unknown as { shape?: Shape };
  return s.shape ?? {};
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/**
 * The inputs a time window sets on a layer, by the layer's own input names: days back (or ahead, for a forecast input
 * "from today"), years back, a first and last year, weeks, one year, a month of every year. Values are held to the
 * input's own bounds. Empty when the window is today (the layers' defaults are now) or the layer takes no time input.
 */
export function timeInputs(layer: Pick<Layer, "input">, w: TimeWindow, now: Date = new Date()): Record<string, unknown> {
  const shape = shapeOf(layer);
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
  const out: Record<string, unknown> = {};
  if (w.from === today && w.to === today) return out;
  const fromYear = Number(w.from.slice(0, 4));
  const toYear = Number(w.to.slice(0, 4));
  const thisYear = Number(today.slice(0, 4));
  for (const [key, schema] of Object.entries(shape)) {
    const description = (inner(schema) as unknown as { description?: string }).description ?? (schema as unknown as { description?: string }).description ?? "";
    const ahead = /\bfrom today\b|\bahead\b|\bforecast\b/i.test(description);
    const kind = (inner(schema) as unknown as { _zod?: { def?: { type?: string } } })._zod?.def?.type;
    if (key === "days" && kind === "number") {
      if (w.future && ahead) out.days = clamp(daysBetween(today, w.to) + 1, bounds(schema));
      else if (!w.future && !ahead && w.month === undefined && w.to === today) out.days = clamp(daysBetween(w.from, today) + 1, bounds(schema));
    } else if ((key === "years" || key === "yearsBack") && kind === "number" && !w.future && w.month === undefined && toYear === thisYear) {
      // "since 2000" in October 2026 is 26.8 years: 27, so the year 2000 itself is in.
      out[key] = clamp(Math.max(1, Math.ceil(daysBetween(w.from, today) / 365.25 - 0.01)), bounds(schema));
    } else if (key === "years" && kind === "object" && !w.future) {
      // A range of years as { from, to }.
      const sub = shapeOf({ input: inner(schema) } as Pick<Layer, "input">);
      if (sub.from && sub.to) out.years = { from: clamp(fromYear, bounds(sub.from)), to: clamp(toYear, bounds(sub.to)) };
    } else if ((key === "yearFrom" || key === "startYear" || key === "sinceYear" || key === "fromYear") && kind === "number" && !w.future && w.month === undefined) {
      // Never past the last year the layer has: "this month" on yearly forest loss is its latest year.
      const last = shape.endYear ?? shape.yearTo ?? shape.toYear;
      out[key] = clamp(clamp(fromYear, bounds(schema)), { min: -Infinity, max: last ? bounds(last).max : Infinity });
    } else if ((key === "yearTo" || key === "endYear" || key === "toYear") && kind === "number" && !w.future && w.month === undefined && toYear !== thisYear) {
      out[key] = clamp(toYear, bounds(schema));
    } else if (key === "weeks" && kind === "number" && !w.future && w.to === today) {
      out.weeks = clamp(Math.max(1, Math.ceil(daysBetween(w.from, today) / 7)), bounds(schema));
    } else if (key === "year" && kind === "number" && fromYear === toYear && w.month === undefined && !w.future && w.to.slice(5) === "12-31") {
      out.year = clamp(fromYear, bounds(schema));
    } else if (key === "month" && w.month !== undefined) {
      out.month = w.month;
    }
  }
  // Only values the layer accepts as a whole.
  const parsed = layer.input.safeParse(out);
  return parsed.success ? out : {};
}

// ---- The prompt block ---------------------------------------------------------------------------------------------

const fmtValues = (f: FilterHint) => (f.include ? `include ${JSON.stringify(f.include)}` : `range ${JSON.stringify(f.range)}`);

/** The filters a reading sets on one layer, with colors resolved for the place's region. */
export function readingFilters(reading: Reading, layerId: string, center?: [number, number] | null): FilterHint[] {
  const layer = getLayer(layerId);
  if (!layer) return [];
  const out = reading.filters.filter((f) => f.layerId === layerId);
  const region = colorRegion(center);
  for (const c of reading.colors) {
    if ((c.activity === "ski") !== (layerId === "ski-routes")) continue;
    const f = colorFilter(layer, c.word, region);
    if (!f) continue;
    const had = out.find((o) => o.key === f.key && o.include);
    if (had) had.include = [...new Set([...(had.include ?? []), ...f.include])];
    else out.push({ layerId, key: f.key, include: f.include, because: `"${c.word}" ${c.activity === "ski" ? "run" : "trail"}`, color: true });
  }
  return out;
}

/** The reading as a short block for the system prompt, or "" when the question's words name nothing the app maps. */
export function readingForPrompt(reading: Reading, now: Date = new Date(), tools: readonly string[] = []): string {
  const lines: string[] = [];
  if (reading.combine && tools.includes("combine")) {
    const c = reading.combine;
    const how = c.op === "drive_time" ? `, minutes ${c.minutes}` : c.distance !== undefined ? `, distance ${c.distance} ${c.unit ?? "km"}` : "";
    lines.push(`- "${c.because}" relates two layers: once both have answered, call combine with op "${c.op}"${how}${c.match ? `, b.match "${c.match}"` : ""} (a = the things asked about, b = the area, line or layer they are tested against), and answer from its counts.`);
  }
  const strong = reading.layers.filter((l) => l.strong);
  const plain = reading.layers.filter((l) => !l.strong).slice(0, 4);
  if (strong.length > 0) lines.push(`- Query ${strong.map((l) => l.layerId).join(" and ")} (${[...new Set(strong.map((l) => l.because))].join("; ")}).`);
  if (plain.length > 0) lines.push(`- Words that name layers: ${plain.map((l) => `${l.because} → ${l.layerId}`).join(", ")}.`);
  for (const a of reading.avoid) lines.push(`- Do not query ${a.layerId} (${a.because}).`);
  for (const i of reading.inputs) lines.push(`- ${i.layerId} input ${JSON.stringify(i.input)} (${i.because}).`);
  for (const f of reading.filters) lines.push(`- render.filters on ${f.layerId}: ${f.key} ${fmtValues(f)} ("${f.because}").`);
  for (const c of reading.colors) {
    lines.push(
      c.activity === "ski"
        ? `- "${c.word}" is a piste color: green or blue easy, red intermediate, black hard in Europe; green easy, blue intermediate, black hard in North America (the server sets the ski-routes filter).`
        : `- "${c.word}" is the IMBA trail sign on mountain bike trails (the server sets the mtb-trails filter).`,
    );
  }
  for (const r of reading.rankBy) lines.push(`- Rank ${r.layerId} by ${r.key} ("${r.because}").`);
  for (const p of reading.places) lines.push(`- "${p.written}" is a river: geocode "${p.place}".`);
  const w = reading.time;
  if (w) {
    const examples: string[] = [];
    for (const l of reading.layers) {
      const layer = getLayer(l.layerId);
      const inputs = layer ? timeInputs(layer, w, now) : {};
      if (Object.keys(inputs).length > 0) examples.push(`${l.layerId} ${JSON.stringify(inputs)}`);
    }
    const what = w.month !== undefined ? `${w.label}` : w.future ? `${w.label}, ahead of today (a forecast)` : w.label;
    lines.push(`- "${w.phrase}" means ${what}${examples.length > 0 ? `; inputs: ${examples.join(", ")}` : ""}.`);
    if (reading.change && !w.future && w.from < w.to) {
      // A dated picture changes between two days: the same day of the year then and now, compared.
      const dated = reading.layers.map((l) => getLayer(l.layerId)).find((l) => l && "date" in shapeOf(l));
      if (dated) {
        const then = `${w.from.slice(0, 4)}${now.toISOString().slice(4, 10)}`;
        lines.push(`- What changed: query ${dated.id} with date ${then} and again for the newest day, then call compare on it (older as A).`);
      } else {
        lines.push(`- What changed: draw the answer in the change view (render.view change) with the numbers then and now.`);
      }
    }
  } else if (reading.change) {
    lines.push(`- What changed: draw the answer in the change view (render.view change) with the numbers then and now.`);
  }
  if (lines.length === 0) return "";
  return ["Reading of this question (the app's own word list; follow it unless the user clearly means something else):", ...lines].join("\n");
}

export type { Attribute };
