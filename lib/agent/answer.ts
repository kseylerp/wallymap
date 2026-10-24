import type { Feature, FeatureCollection } from "geojson";
import { getLayer, listLayers } from "@/layers/registry";
import type { BBox } from "@/layers/types";
import { toolResultToActions, type LayerCatalog } from "./applyToolResult";
import { catalogEntry } from "@/lib/layers/catalog";
import { rankedTop } from "@/lib/render/attributes";
import { cardContent } from "@/lib/render/card";
import { isCombinedId } from "@/lib/render/combined";
import { layerDisplay } from "@/lib/render/contract";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type LoadedLayer, type MapState, type RenderOp } from "@/lib/render/state";
import { visibleState } from "@/lib/render/view";
import { boundsOf } from "@/lib/render/views";
import { FIRST_SENTENCE_WORDS as FIRST_WORDS } from "./compose";
import { factPool, ungroundedClaims } from "./grounding";
import { inUS } from "./units";

/**
 * The answer, built from the turn's results rather than left to the model (top-10 use cases, 2026-10-23: 48 of 50
 * follow-ups were generic, 16 notes opened with "The map shows…", 12 left out a deciding number the results held).
 *
 * The turn's tool calls are replayed to the map the browser ends on (the same mapping and reducer), and the answer is
 * read off its main layer exactly as a person sees it: the features left after the filters, ranked by the row's Rank
 * by, each with its card's rows. A template per kind of answer (hikes, a forecast, campsites, snow stations...) says
 * which rows decide and how to say them; it fills:
 *  - the lead: one sentence, at most 40 words, that answers with the deciding number ("12 hikes near Bend; the top is
 *    Tumalo Falls Trail at 6.8 mi round trip with 650 ft of climb.");
 *  - the options: the top three named features, one line each, with the facts that decide between them;
 *  - three follow-up questions that name what was just found and offer the next decision.
 * The note the model wrote keeps its caveats under them (lib/agent/noteCheck.ts composeNote).
 */

export type AnswerCall = { toolName: string; input?: unknown; output?: unknown };

/** The map the browser ends on after these calls: each result through the client's mapping and the reducer, in order. */
export function mapOf(calls: readonly AnswerCall[]): MapState {
  // The catalog the browser gets (GET /api/layers), so the map read here is the person's.
  const catalog: LayerCatalog = Object.fromEntries(listLayers().map((l) => [l.id, catalogEntry(l)]));
  let state = reduce(initialMapState, { type: "turn_start" });
  for (const c of calls) {
    if (c.output === undefined) continue;
    try {
      for (const action of toolResultToActions(c.toolName, c.input, c.output, { width: 1440, height: 900 }, catalog, state.renderOps)) state = reduce(state, action);
    } catch {
      // A result the map cannot take is not part of the answer.
    }
  }
  return state;
}

/** How one kind of answer reads: the words for one and many, and the card rows that decide between options. */
type Kind = {
  one: string;
  many: string;
  /** Card row labels, in the order they are said; the first three a feature has are used. */
  rows: string[];
  /** Follow-up questions; {A} and {B} are the top two names, {place} where, {noun} the plural. */
  followUps: string[];
  /**
   * "pick" (the default): the question picks among options, so the template's lead names the top one with its facts.
   * "total": the answer is a total or a change (how much ice was lost, when a river peaks), so the model's own first
   * sentence leads when it answers with a number, and the template's lead stands in only when it does not.
   */
  answer?: "pick" | "total";
  /** False when the features are not options worth listing (single sightings, a monument's two outlines). */
  list?: boolean;
};

const HIKE: Kind = {
  one: "hike",
  many: "hikes",
  rows: ["Round trip", "Climb, round trip", "Length", "Climb", "Shape", "Difficulty"],
  followUps: [
    "How does {A} compare with {B} for length and climb?",
    "Which hikes near {place} are loops under 5 miles?",
    "Is {A} busy on weekends?",
    "What is the weather near {place} this weekend?",
  ],
};

/** Answer kinds by layer id (the main layer decides the kind). Layers not listed read from their card's measure and first facts. */
const KINDS: Record<string, Kind> = {
  "osm-trails": HIKE,
  popularity: HIKE,
  "mtb-trails": {
    one: "trail",
    many: "trails",
    rows: ["Length", "IMBA color", "Difficulty", "Climb"],
    followUps: ["How does {A} compare with {B}?", "Which trails near {place} are under 5 miles?", "What is the weather for riding near {place} this weekend?"],
  },
  climbing: {
    one: "crag",
    many: "crags",
    rows: ["Routes", "Sport", "Afternoon shade", "Faces", "Grades"],
    followUps: ["Which has more sport routes at 5.10, {A} or {B}?", "Is {A} in the shade in the afternoon?", "What is the weather near {place} this weekend?"],
  },
  paddling: {
    one: "section",
    many: "sections",
    rows: ["Class", "Length", "Flow", "Gauge"],
    followUps: ["Is {A} running this weekend?", "How does {A} compare with {B}?", "Where are the put-ins near {place}?"],
  },
  streamflow: {
    answer: "total",
    one: "gauge",
    many: "gauges",
    rows: ["Flow", "Running", "Flow vs. the date's median", "Forecast high"],
    followUps: ["Is {A} above normal for this date?", "When in the year is {A} highest?", "Will {A} rise this weekend?"],
  },
  campsites: {
    one: "campsite",
    many: "campsites",
    rows: ["Type", "Fee", "Capacity", "Run by"],
    followUps: ["Is {A} reservable?", "Which campsites near {place} have drinking water?", "What is the weather near {place} this weekend?"],
  },
  "recreation-sites": {
    one: "site",
    many: "sites",
    rows: ["Type", "Status", "Managed by", "Reservable"],
    followUps: ["Is {A} reservable?", "Which campgrounds near {place} are open all year?", "What is the weather near {place} this weekend?"],
  },
  "forest-roads": {
    one: "road",
    many: "roads",
    rows: ["Road number", "Maintenance level", "Camping rule here", "Passenger cars allowed"],
    followUps: ["Can I camp along {A}?", "Which roads near {place} are open to passenger cars all year?", "What is the weather near {place} this weekend?"],
  },
  snowpack: {
    one: "snow station",
    many: "snow stations",
    rows: ["Snow depth", "Percent of normal", "Snow water equivalent", "Reading"],
    followUps: ["How does the snow at {A} compare with normal?", "When does snow usually arrive at {A}?", "What is the avalanche danger near {place} today?"],
  },
  avalanche: {
    answer: "total",
    one: "avalanche zone",
    many: "avalanche zones",
    rows: ["Danger", "Avalanche center", "Issued"],
    followUps: ["Which slopes near {place} are under 30 degrees?", "How much snow is on the ground near {place}?", "What is the weather near {place} this weekend?"],
  },
  "weather-forecast": {
    one: "forecast point",
    many: "forecast points",
    rows: ["Temperature", "Chance of rain or snow", "Wind"],
    followUps: ["Any weather alerts near {place} this weekend?", "What are good hikes near {place} for Saturday?", "Is there snow on the ground near {place}?"],
  },
  glaciers: {
    answer: "total",
    one: "glacier",
    many: "glaciers",
    rows: ["Area", "Ice lost since the first survey", "Area in the first survey", "Survey"],
    followUps: ["How has {A} changed since the first survey?", "Which glaciers in {place} lost the most ice?", "How does {A} compare with {B}?"],
  },
  monuments: {
    answer: "total",
    list: false,
    one: "boundary",
    many: "boundaries",
    rows: ["Area", "Boundary", "Designation"],
    followUps: ["Are there mining claims inside {A}?", "What did {A} lose since 2021?", "Who manages the land around {A}?"],
  },
  "fire-perimeters": {
    answer: "total",
    one: "fire",
    many: "fires",
    rows: ["Acres burned", "Year", "Status"],
    followUps: ["How severe was the burn in {A}?", "How has the land regrown since {A}?", "Which fires near {place} were largest?"],
  },
  mines: {
    answer: "total",
    one: "mine site",
    many: "mine sites",
    rows: ["Status when last recorded", "Commodities", "Development status"],
    followUps: ["Is {A} still producing?", "Which protected areas are near {A}?", "Are there mining claims near {place}?"],
  },
  "mining-claims": {
    answer: "total",
    one: "claim",
    many: "claims",
    rows: ["Case", "Status", "Commodity"],
    followUps: ["Who holds {A}?", "Which protected areas are near {place}?", "Are there active mines near {place}?"],
  },
  "methane-plumes": {
    answer: "total",
    one: "methane plume",
    many: "methane plumes",
    rows: ["Emission rate", "Sector", "Seen on"],
    followUps: ["Which plumes near {place} are largest?", "Where are the pipelines near {place}?", "How has methane near {place} changed since last year?"],
  },
  species: {
    answer: "total",
    list: false,
    one: "sighting",
    many: "sightings",
    rows: ["Seen on", "Scientific name", "Quality"],
    followUps: ["Which months had the most sightings near {place}?", "Where is protected habitat near {place}?", "What else has been seen near {place}?"],
  },
  "gbif-occurrences": {
    answer: "total",
    list: false,
    one: "record",
    many: "records",
    rows: ["Seen on", "Scientific name"],
    followUps: ["Which months had the most records near {place}?", "Where is protected habitat near {place}?", "What else has been seen near {place}?"],
  },
  "critical-habitat": {
    answer: "total",
    one: "habitat unit",
    many: "habitat units",
    rows: ["Listed as", "Area", "Designation"],
    followUps: ["Where has {A} been seen recently?", "What threatens {A}?", "Which protected areas overlap {A}?"],
  },
  peaks: {
    one: "peak",
    many: "peaks",
    rows: ["Elevation", "Prominence"],
    followUps: ["How tall is {A} compared with {B}?", "Is there a hike to the top of {A}?", "What rock is {A} made of?"],
  },
  lakes: {
    one: "lake",
    many: "lakes",
    rows: ["Maximum depth", "Area", "Surface elevation"],
    followUps: ["How does {A} compare with {B}?", "Where can I launch a kayak on {A}?", "What is the water temperature at {A}?"],
  },
  "geologic-unit": {
    answer: "total",
    one: "rock unit",
    many: "rock units",
    rows: ["Rock", "Age", "Description"],
    followUps: ["How old is {A}?", "Are there faults near {place}?", "What is the soil like near {place}?"],
  },
  wilderness: {
    answer: "total",
    one: "wilderness",
    many: "wilderness areas",
    rows: ["Area", "Managed by", "Designated"],
    followUps: ["Who manages {A}?", "What threatens {A}?", "Are there mining claims near {A}?"],
  },
};

/** Follow-ups for answers read off a picture (tiles: no named features), by layer: the place is what they name. */
const TILE_FOLLOW_UPS: Record<string, string[]> = {
  "forest-loss": ["What drove the forest loss in {place}?", "Where near {place} was the most forest lost since 2020?", "Which protected areas in {place} lost forest?"],
  "forest-types": ["How tall are the trees near {place}?", "How much forest near {place} was lost since 2015?", "What ecosystems cover {place}?"],
  "land-cover": ["What ecosystems cover {place}?", "How much forest near {place} was lost since 2015?", "What wildlife has been seen near {place}?"],
  "old-growth": ["How tall are the trees near {place}?", "Who manages the old forest near {place}?", "How much forest near {place} was lost since 2015?"],
  geology: ["Are there faults near {place}?", "What is the soil like near {place}?", "How old are the rocks near {place}?"],
  phenology: ["When do the leaves turn near {place} in the fall?", "How does green-up near {place} compare with last year?", "What grows around {place}?"],
  greenness: ["When does spring green up near {place}?", "What grows around {place}?", "How has the vegetation near {place} changed since 2015?"],
  "public-lands": ["Is the land near {place} protected?", "Where can I camp near {place}?", "Are there mining claims near {place}?"],
  "fire-hazard": ["Have fires burned near {place} since 2015?", "Any weather alerts or smoke near {place} right now?", "What protects the land near {place}?"],
  "snow-cover": ["How deep is the snow at the stations near {place}?", "What is the avalanche danger near {place} today?", "What is the weather near {place} this weekend?"],
  terrain: ["Which slopes near {place} are under 30 degrees?", "What is the avalanche danger near {place} today?", "What is the weather near {place} this weekend?"],
};

const GENERIC_FOLLOW_UPS = [
  "How does {A} compare with {B}?",
  "What else should I know about {A}?",
  "What is the weather near {place} this weekend?",
  "What changed near {place} since 2015?",
  "Who manages the land near {place}?",
  "What wildlife has been seen near {place}?",
];

/** Values a card shows for what it does not know: never a deciding fact. */
const UNKNOWN = /^(?:not (?:recorded|rated|mapped|known)|unknown|none|n\/a|—|-|fee not mapped)$/i;

/** "5.62 mi (9.05 km)" is "5.62 mi": the person's units only, so the line stays short. */
const firstUnit = (value: string) => value.replace(/^([−-]?[\d.,]+\s*[^\s(]+)\s*\([^)]*\)$/, "$1").trim();

/** One deciding fact in words. */
/** Longest value an option line quotes whole (words); a rule or description past it keeps its first clause. */
const VALUE_WORDS = 18;

/** A long value's first clause: Coconino's camping rule ran 60 words in each of three option lines. */
export function briefValue(v: string): string {
  if (v.split(/\s+/).length <= VALUE_WORDS) return v;
  // The clause after the rule's owner ("Coconino National Forest, forest-wide, outside the Sedona orders: dispersed
  // camping is allowed …") is the rule itself.
  const after = /^[^:]{0,90}:\s+(.*)$/.exec(v)?.[1] ?? v;
  const clause = after.split(/;\s+|\.\s+|\s+\(/)[0].trim();
  const words = clause.split(/\s+/);
  return words.length <= VALUE_WORDS + 6 ? clause.replace(/[.,;:]$/, "") : `${words.slice(0, VALUE_WORDS).join(" ").replace(/[.,;:]$/, "")}…`;
}

function phrase(label: string, raw: string): string {
  const v = briefValue(firstUnit(raw));
  switch (label) {
    case "Round trip":
      return `${v} round trip`;
    case "Climb, round trip":
    case "Climb":
      return `${v} of climb`;
    case "Length":
    case "Area":
    case "Routes":
    case "Elevation":
    case "Maximum depth":
      return label === "Routes" ? `${v} routes` : label === "Maximum depth" ? `${v} deep` : v;
    case "Shape":
    case "Type":
    case "Status":
    case "Difficulty":
    case "Rock":
    case "Designation":
    case "Boundary":
      return v.charAt(0).toLowerCase() + v.slice(1);
    case "Snow depth":
      return `${v} of snow`;
    case "Percent of normal":
      return `${v} of normal`;
    case "Ice lost since the first survey":
      return `${v} of its ice lost since the first survey`;
    case "Acres burned":
      return `${v} burned`;
    case "Danger":
      return `danger ${v.toLowerCase()}`;
    case "Reading":
      return `read ${v}`;
    case "Seen on":
      return `seen ${v}`;
    default:
      return `${label.toLowerCase()} ${v}`;
  }
}

export type AnswerOption = { name: string; facts: string[] };

export type AnswerTemplate = {
  layerId: string;
  /** Where the answer is about, as said ("near Bend", "in this view"). */
  where: string;
  /** The place's short name, for follow-ups (null for a "here" question with no geocode). */
  place: string | null;
  /** Features the main layer shows after its filters, and whether that count is a number the results hold. */
  count: number;
  countGrounded: boolean;
  noun: { one: string; many: string };
  options: AnswerOption[];
  /** The first sentence: the answer with its deciding number, at most 40 words; null when the results give none. */
  lead: string | null;
  /** Markdown lines under the lead: one per option, or one per forecast day after the lead's. */
  lines: string[];
  /** Every option's line, the lead's own too: under a first sentence the model wrote. */
  allLines: string[];
  /** The model's first sentence leads when it answers (a total or a change); the template's lead only stands in. */
  modelFirst: boolean;
  followUps: string[];
};

const dataOf = (l: LoadedLayer | undefined): FeatureCollection | null => (l?.result.kind === "geojson" ? l.result.data : null);
const words = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** Layers drawn for context, never the answer's main layer while another answered. */
const CONTEXT = new Set(["public-lands", "terrain", "photos", "wikipedia-nearby", "protected-areas-world", "weather-alerts", "smoke", "fire-hazard", "river-pulse", "outdoor-features"]);

/**
 * The layer the answer is read from: a join when there is one with features (hikes near a waterfall), else the
 * preferred layers in order (the question's own reading), else the layer drawn ranked, else the first drawn with
 * features, context layers last.
 */
export function mainOp(state: MapState, prefer: readonly string[] = []): RenderOp | undefined {
  const vis = visibleState(state);
  const ops = state.renderOps.filter((o) => o.visible !== false && state.layers[o.layerId]);
  const showing = (o: RenderOp) => {
    const l = vis.layers[o.layerId] ?? state.layers[o.layerId];
    return l.result.kind === "tiles" || (dataOf(l)?.features.length ?? 0) > 0;
  };
  const named = (o: RenderOp) => (dataOf(state.layers[o.layerId])?.features ?? []).some((f) => typeof f.properties?.name === "string");
  const last = (pred: (o: RenderOp) => boolean) => [...ops].reverse().find(pred);
  const join = last((o) => isCombinedId(o.layerId) && showing(o) && named(o));
  if (join) return join;
  // The question's layers with features first (a crag list over the shade tiles beside it), then its tile layers.
  const features = (o: RenderOp) => dataOf(state.layers[o.layerId]) !== null;
  for (const pass of [features, (o: RenderOp) => !features(o)]) {
    for (const id of prefer) {
      const op = last((o) => o.layerId === id && showing(o) && pass(o));
      if (op) return op;
    }
  }
  return (
    last((o) => o.view === "ranked" && showing(o) && !CONTEXT.has(o.layerId)) ??
    ops.find((o) => showing(o) && !CONTEXT.has(o.layerId) && dataOf(state.layers[o.layerId]) !== null) ??
    ops.find((o) => showing(o) && !CONTEXT.has(o.layerId)) ??
    ops.find(showing)
  );
}

/** The source layer a joined layer's features come from (combine:<a>-near-<b>: a's card and kind). */
function sourceOf(layer: LoadedLayer, op: RenderOp): string {
  if (!isCombinedId(op.layerId)) return op.layerId;
  const ids = listLayers().map((l) => l.id).sort((a, b) => b.length - a.length);
  const rest = op.layerId.slice("combine:".length);
  return ids.find((id) => rest.startsWith(`${id}-`)) ?? layer.id;
}

/** The top `n` drawn features of a layer as its row ranks them (or in source order when it has no measure). */
export function topOfOp(state: MapState, op: RenderOp, n: number): { key?: string; top: Feature[]; shown: Feature[] } {
  const vis = visibleState(state);
  const all = state.layers[op.layerId];
  const shownLayer = vis.layers[op.layerId] ?? all;
  const data = all.allData ?? dataOf(all);
  const shown = dataOf(shownLayer);
  if (!data || !shown) return { top: [], shown: [] };
  const ranked = rankedTop(all, op, data, shown, n);
  return { key: ranked.key, top: ranked.top.length > 0 ? ranked.top : shown.features.slice(0, n), shown: shown.features };
}

/** The name a person reads for a feature, or null for one with none worth saying. */
function nameOf(f: Feature): string | null {
  const p = f.properties ?? {};
  for (const k of ["name", "heading", "species", "commonName", "title"]) {
    const v = p[k];
    if (typeof v === "string" && v.trim().length >= 3 && !/^unnamed\b/i.test(v.trim())) return v.trim();
  }
  return null;
}

/** "Sat, Oct 24: high 44 °F, low 30 °F; 3% chance of rain or snow, 0.00 in; wind to 7 mph, gusts 15 mph; mostly cloudy". */
const DAY_NAMES: Record<string, string> = { Sun: "Sunday", Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday" };

/** A forecast day line read plainly: the day's name in full, the totals of nothing left out. */
export function forecastDay(line: string): { day: string; date: string; text: string } | null {
  const m = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat),\s*([A-Z][a-z]{2}\s+\d{1,2}):\s*(.+)$/.exec(line.trim());
  if (!m) return null;
  const parts = m[3]
    .split(/;\s*/)
    .map((p) => p.replace(/,\s*0\.00 in\b/, "").replace(/^rest of day\s+/, "").trim())
    // "mostly cloudy, Chance of light rain showers" reads as one sentence.
    .map((p) => p.replace(/(,\s*)([A-Z])(?=[a-z])/g, (_, sep: string, c: string) => `${sep}${c.toLowerCase()}`))
    .filter(Boolean);
  return { day: DAY_NAMES[m[1]], date: m[2], text: parts.join(", ") };
}

/** The forecast days a question asks about (its time window), else the next two. */
function forecastDays(f: Feature, window?: { from: string; to: string } | null): { day: string; date: string; text: string }[] {
  const days = Array.isArray(f.properties?.days) ? (f.properties?.days as unknown[]).filter((d): d is string => typeof d === "string") : [];
  const read = days.map(forecastDay).filter((d): d is NonNullable<ReturnType<typeof forecastDay>> => d !== null);
  if (read.length === 0) return [];
  if (window) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const iso = (d: { date: string }) => {
      const [mon, day] = d.date.split(/\s+/);
      const m = months.indexOf(mon) + 1;
      return `${String(m).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`;
    };
    const from = window.from.slice(5);
    const to = window.to.slice(5);
    const inside = read.filter((d) => (from <= to ? iso(d) >= from && iso(d) <= to : iso(d) >= from || iso(d) <= to));
    if (inside.length > 0) return inside.slice(0, 3);
  }
  return read.slice(0, 2);
}

/** A number of 10 or more is said only when a result holds it (the grounding check reads it as a count claim). */
function countHeld(count: number, outputs: unknown[], question: string): boolean {
  if (count < 10) return true;
  return ungroundedClaims(`${count} features`, factPool(outputs, question)).length === 0;
}

/** Fills a follow-up template; null when a slot it names has nothing to fill it. */
function fill(template: string, slots: Record<string, string | null>): string | null {
  let missing = false;
  // No place looked up (a "here" question): "near {place}" is here.
  const text = slots.place ? template : template.replace(/\b(?:near|in|around|at)\s+\{place\}/g, "here");
  const out = text.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = slots[k];
    if (!v) missing = true;
    return v ?? "";
  });
  return missing ? null : out;
}

export type AnswerInput = {
  calls: readonly AnswerCall[];
  question: string;
  /** Every result the model read this turn (query summaries and bodies), for counts the grounding check accepts. */
  outputs: unknown[];
  /** The places found this turn, in order; the answer is about the one holding its top feature (else the last). */
  places: readonly { name: string; bbox: BBox; center?: [number, number] }[];
  /** The view a "here" question was asked on. */
  view: { bbox: BBox | null } | null;
  /** Layers the question's words name, in order: the main layer is the first of them drawn. */
  prefer?: readonly string[];
  /** The question's time window (a forecast's days). */
  window?: { from: string; to: string } | null;
  /** A species the question names, for its follow-ups. */
  taxon?: string | null;
  /** The question asks what changed: its answer is a change, not a pick. */
  change?: boolean;
};

const middleOf = (f: Feature): [number, number] | null => {
  const b = boundsOf([f]);
  return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : null;
};
const inBox = ([x, y]: [number, number], [w, s, e, n]: BBox, pad = 0.25) => {
  const dx = (e - w) * pad;
  const dy = (n - s) * pad;
  return x >= w - dx && x <= e + dx && y >= s - dy && y <= n + dy;
};

/** The place the answer is about: the found place holding the top feature, else the last one found (a retry's). */
function placeFor(places: AnswerInput["places"], top: Feature | undefined): AnswerInput["places"][number] | null {
  if (places.length === 0) return null;
  const at = top ? middleOf(top) : null;
  return (at && [...places].reverse().find((p) => inBox(at, p.bbox))) || places[places.length - 1];
}

/** The answer template filled from this turn's results, or null when nothing is drawn to answer from. */
export function answerTemplate(input: AnswerInput, state: MapState = mapOf(input.calls)): AnswerTemplate | null {
  const op = mainOp(state, input.prefer ?? []);
  if (!op) return null;
  const layer = state.layers[op.layerId];
  const sourceId = sourceOf(layer, op);
  const kind = KINDS[sourceId];
  const { top, shown } = layer.result.kind === "geojson" ? topOfOp(state, op, 12) : { top: [] as Feature[], shown: [] as Feature[] };
  const place = placeFor(input.places, top[0]);
  const placeName = place ? place.name.split(",")[0].trim() : null;
  const where = placeName ? `near ${placeName}` : "in this view";
  const box = place?.bbox ?? input.view?.bbox ?? null;
  const us = inUS(box);
  const display = { ...layerDisplay(layer), units: us ? ("us" as const) : ("metric" as const) };
  const title = getLayer(sourceId)?.title ?? layer.title;
  const noun = kind ? { one: kind.one, many: kind.many } : { one: title.toLowerCase(), many: title.toLowerCase() };

  const count = shown.length;
  const countGrounded = countHeld(count, input.outputs, input.question);
  const seen = new Set<string>();
  const options: AnswerOption[] = [];
  for (const f of top) {
    const name = nameOf(f);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const content = cardContent(f, { unit: layer.style.unit, card: layer.card, fieldHelp: layer.fieldHelp, display });
    const rows = [...(content.measure ? [content.measure] : []), ...content.facts].filter((r) => r.value && !UNKNOWN.test(r.value.trim()));
    const wanted = kind?.rows ?? [];
    const picked = wanted.length > 0 ? wanted.flatMap((label) => rows.filter((r) => r.label === label).slice(0, 1)) : rows.filter((r) => /\d/.test(r.value));
    // One climb is enough: the round trip's when there is one.
    const facts: string[] = [];
    for (const r of picked) {
      if (r.label === "Climb" && picked.some((p) => p.label === "Climb, round trip")) continue;
      if (r.label === "Length" && picked.some((p) => p.label === "Round trip") && kind === HIKE) continue;
      if (facts.length >= 3) break;
      facts.push(phrase(r.label, r.value));
    }
    options.push({ name, facts });
    if (options.length >= 3) break;
  }

  // The lead and the option lines: only for the kinds of answer with a template; any other layer keeps the model's note.
  let lead: string | null = null;
  let lines: string[] = [];
  let allLines: string[] = [];
  if (sourceId === "weather-forecast") {
    const here = shown.find((f) => f.properties?.kind === "here") ?? top[0];
    const days = here ? forecastDays(here, input.window) : [];
    if (days.length > 0) {
      const at = placeName ? ` at ${placeName}` : "";
      lead = `${days[0].day}${at}: ${days[0].text}.`;
      if (words(lead) > FIRST_WORDS) lead = `${days[0].day}${at}: ${days[0].text.split(/,\s*/).slice(0, 4).join(", ")}.`;
      allLines = days.map((d) => `- **${d.day}**: ${d.text}.`);
      lines = allLines.slice(1);
    }
  } else if (kind && options.length > 0) {
    const first = options[0];
    const facts = first.facts.filter((f) => /\d/.test(f));
    const said = facts.length > 0 ? facts.slice(0, 2).join(" and ") : first.facts.slice(0, 2).join(", ");
    const counted = countGrounded && count > 0;
    const opening = counted ? `${count.toLocaleString("en-US")} ${count === 1 ? noun.one : noun.many} ${where}` : `The top ${noun.one} ${where}`;
    const tail = said ? `, ${said}` : "";
    lead = counted ? `${opening}; the top is ${first.name}${tail}.` : `${opening} is ${first.name}${tail}.`;
    if (words(lead) > FIRST_WORDS) lead = counted ? `${opening}; the top is ${first.name}.` : null;
    if (lead && !/\d/.test(lead)) lead = null;
    lines = kind.list === false ? [] : options.map((o) => `- **${o.name}**${o.facts.length > 0 ? `: ${o.facts.join(", ")}` : ""}.`);
    allLines = lines;
  }

  // Follow-ups: the next decision, naming what was just found. Those naming a feature or the place come first.
  const slots: Record<string, string | null> = { A: options[0]?.name ?? null, B: options[1]?.name ?? null, place: placeName, noun: noun.many, taxon: input.taxon ?? null };
  const filled = [...(kind?.followUps ?? TILE_FOLLOW_UPS[sourceId] ?? []), ...GENERIC_FOLLOW_UPS].map((t) => fill(t, slots)).filter((q): q is string => q !== null);
  const unique = [...new Set(filled)];
  const anchored = unique.filter((q) => (slots.A && q.includes(slots.A)) || (slots.B && q.includes(slots.B)) || (placeName && q.includes(placeName)));
  const followUps = [...anchored, ...unique.filter((q) => !anchored.includes(q))].slice(0, 3);
  const modelFirst = kind?.answer === "total" || input.change === true;
  return { layerId: op.layerId, where, place: placeName, count, countGrounded, noun, options, lead, lines, allLines, modelFirst, followUps };
}

/** True when a follow-up names one of the anchors (a feature or the place), as the answer's rule asks. */
export function namesAnchor(question: string, anchors: readonly string[]): boolean {
  const q = question.toLowerCase();
  return anchors.some((a) => a.length >= 3 && q.includes(a.toLowerCase()));
}

/**
 * The follow-ups the answer ends with: exactly three, at least two naming something from this answer. The model's own
 * that name something are kept first; the template's fill the rest.
 */
export function chooseFollowUps(model: readonly string[], built: readonly string[], anchors: readonly string[]): string[] {
  const specific = model.filter((q) => namesAnchor(q, anchors));
  const out: string[] = [];
  for (const q of [...specific, ...built]) {
    if (out.length >= 3) break;
    if (!out.some((o) => o.toLowerCase() === q.toLowerCase())) out.push(q);
  }
  for (const q of model) {
    if (out.length >= 3) break;
    if (!out.includes(q)) out.push(q);
  }
  return out.slice(0, 3);
}

export type { MapState };

/** Names in this turn's results a follow-up may name (features of every query and join), and the places found. */
export function anchorsOf(calls: readonly AnswerCall[], places: readonly { name: string }[]): string[] {
  const out = new Set<string>();
  for (const c of calls) {
    if (!(c.toolName.startsWith("query_") || c.toolName === "combine")) continue;
    const data = (c.output as { data?: { features?: Feature[] } } | undefined)?.data;
    for (const f of data?.features ?? []) {
      for (const k of ["name", "heading", "species", "commonName"]) {
        const v = f.properties?.[k];
        if (typeof v === "string" && v.trim().length >= 4) out.add(v.trim());
      }
    }
  }
  for (const p of places) {
    const short = p.name.split(",")[0].trim();
    if (short.length >= 3) out.add(short);
  }
  return [...out];
}
