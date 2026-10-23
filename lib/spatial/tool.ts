import { tool, type JSONValue } from "ai";
import type { Feature, FeatureCollection, Position } from "geojson";
import { z } from "zod";
import { getLayer, listLayers } from "@/layers/registry";
import { type BBox, type CardFact, type Attribute, type Citation, type Layer, type LegendSpec, type StyleHints } from "@/layers/types";
import { runLayer } from "@/lib/layers/run";
import { applyFilters, type LayerFilters } from "@/lib/render/filters";
import type { Turn } from "@/lib/agent/turn";
import type { MapView } from "@/lib/agent/view";
import { canonicalLayerId } from "@/lib/agent/toolNames";
import { COMBINE_OPS, combineFeatures, combineProblem, geometryKind, type CombineOp, type CombineOutcome, type GeometryKind } from "./combine";
import { bboxOfFeatures, KM2_TO_ACRES } from "./geo";
import { driveReach, MAX_DRIVE_MINUTES } from "./reach";

/**
 * The `combine` tool (audit R3): two layers answered this turn joined into a new map layer, "Campsites within 1 km of
 * the Wonderland Trail" or "Grazing allotments overlapping desert tortoise critical habitat", with A's properties kept
 * and the join's numbers added. The browser draws the result as its own layer (lib/render/combined.ts); the model gets
 * the counts, totals, the top features and one sentence to quote.
 */

/** Combined layers are drawn under ids with this prefix; they are not in the layer registry. */
export const COMBINED_PREFIX = "combine:";

const UNITS = ["km", "mi", "m", "ft"] as const;
type Unit = (typeof UNITS)[number];
const TO_M: Record<Unit, number> = { km: 1000, mi: 1609.344, m: 1, ft: 0.3048 };

const FilterSchema = z
  .record(
    z.string(),
    z.object({
      include: z.array(z.string()).optional(),
      range: z.tuple([z.number(), z.number()]).optional(),
      match: z.string().optional(),
    }),
  )
  .optional()
  .describe("Keep only these features first, written like render.filters (e.g. { kind: { include: [\"camp_site\"] } })");

const SideSchema = z.object({
  layerId: z.string().min(1).describe("A layer queried this turn, e.g. campsites"),
  match: z.string().optional().describe("Keep only features whose name contains these words, e.g. \"Wonderland Trail\""),
  filters: FilterSchema,
});

export const CombineInputSchema = z.object({
  op: z.enum(COMBINE_OPS),
  a: SideSchema.describe("The features to keep (campsites, crags, allotments, sightings)"),
  b: SideSchema.optional().describe("The layer they are tested against (a trail, a forest, habitat); not used by drive_time"),
  distance: z.number().positive().max(200).optional().describe("near and along: how far, in unit (default 1 km)"),
  unit: z.enum(UNITS).default("km"),
  minutes: z.number().positive().max(MAX_DRIVE_MINUTES).optional().describe("drive_time: minutes of driving"),
  from: z.union([z.string().min(1), z.tuple([z.number(), z.number()])]).optional().describe("drive_time: the start, a place name or [lon, lat]; default the place geocoded this turn"),
});
export type CombineInput = z.infer<typeof CombineInputSchema>;

/** The `combine` tool's full output: a geojson layer result plus what the browser needs to draw it as its own layer. */
export type CombinedResult = {
  kind: "geojson";
  data: FeatureCollection;
  citation: Citation;
  coverageNote?: string;
  title: string;
  legend: LegendSpec;
  combined: {
    id: string;
    sourceLayerId: string;
    otherLayerId?: string;
    op: CombineOp;
    statement: string;
    count: number;
    of: number;
    totals: CombineOutcome["totals"];
    style: StyleHints;
    /** Card facts and attributes for the join's own numbers, after the source layer's. */
    facts: CardFact[];
    attributes: Attribute[];
    caveat?: string;
  };
};

export type CombineError = { error: string };

const SLUG = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** "1 km", "2 miles", "500 m", "300 ft". */
export function distanceText(value: number, unit: Unit): string {
  const v = Number(value.toFixed(2));
  if (unit === "mi") return `${v} ${v === 1 ? "mile" : "miles"}`;
  return `${v} ${unit}`;
}

/** Nouns for layers whose title is a list ("Huts, springs, peaks and other backcountry features"). */
const NOUNS: Record<string, string> = {
  "osm-trails": "Trails",
  "outdoor-features": "Backcountry features",
  "ski-routes": "Ski routes",
  climbing: "Climbing areas",
  paddling: "Paddling spots",
  "old-growth": "Old-growth forest",
  "flood-extent": "Flood water",
  "gbif-occurrences": "Occurrence records",
  "protected-areas-world": "Protected areas",
  "power-plants": "Power plants",
  "imagery-by-date": "Satellite images",
};

/** A layer's title as a plain noun: "Campsites and parking lots" is "Campsites", "Snowpack (SNOTEL, live)" "Snowpack". */
export function layerNoun(layer: Pick<Layer, "id" | "title">): string {
  return NOUNS[layer.id] ?? (layer.title.split(/\s+(?:and|with|by|from|for)\s+|\s*[(:,–—]/)[0].trim() || layer.title);
}

/** Lower case for the first letter of a word in a sentence, but never an acronym's ("BLM grazing allotments"). */
function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function pluralWord(word: string): string {
  const w = word.replace(/_/g, " ").trim();
  return /(s|water|habitat)$/i.test(w) ? w : `${w}s`;
}

/**
 * A side's noun from what was asked of it: kinds waterfall are "Waterfalls", species desert tortoise is "Desert tortoise
 * critical habitat", else the layer's own noun.
 */
export function sideNoun(layer: Pick<Layer, "id" | "title">, input: Record<string, unknown> = {}): string {
  const noun = layerNoun(layer);
  const kinds = (Array.isArray(input.kinds) ? input.kinds : typeof input.kinds === "string" ? [input.kinds] : []).filter((k): k is string => typeof k === "string");
  if (kinds.length > 0 && kinds.length <= 3) {
    const words = kinds.map(pluralWord);
    const text = words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  const species = [input.species, input.taxon, input.commonName].find((v): v is string => typeof v === "string" && v.trim() !== "");
  if (species) return `${species.charAt(0).toUpperCase()}${species.slice(1)} ${lowerFirst(noun)}`;
  return noun;
}

/** B's name in a sentence: "the Wonderland Trail" for a named route, else its noun in lower case. */
function otherName(side: { match?: string } | undefined, b: Side): string {
  if (side?.match) {
    const m = side.match.trim();
    return /^the\s/i.test(m) || !/\b(trail|road|river|creek|route|way|canyon|crest|loop|path|highway|byway)$/i.test(m) ? m : `the ${m}`;
  }
  return lowerFirst(sideNoun(b.layer, b.input));
}

/** How A relates to B, after A's name: "within 1 km of the Wonderland Trail", "overlapping critical habitat". */
export function relationText(op: CombineOp, bName: string, input: Pick<CombineInput, "distance" | "unit" | "minutes">, fromName?: string): string {
  const d = distanceText(input.distance ?? 1, input.unit ?? "km");
  switch (op) {
    case "within":
      return `inside ${bName}`;
    case "outside":
      return `outside ${bName}`;
    case "near":
    case "along":
      return `within ${d} of ${bName}`;
    case "overlap":
      return `overlapping ${bName}`;
    case "drive_time":
      return `within ${input.minutes ?? 30} minutes' drive of ${fromName ?? "the start"}`;
  }
}

/** The title of the new layer, as the legend and the row say it. */
export function combinedTitle(op: CombineOp, aTitle: string, bName: string, input: Pick<CombineInput, "distance" | "unit" | "minutes">, fromName?: string): string {
  return `${aTitle} ${relationText(op, bName, input, fromName)}`;
}

const fmtKm2 = (km2: number) => (km2 >= 100 ? Math.round(km2).toLocaleString("en-US") : km2.toFixed(1));

/** One sentence with the join's numbers, for the note: "12 of 145 campsites are within 1 km of the Wonderland Trail." */
export function statementOf(relation: string, op: CombineOp, outcome: CombineOutcome, aNoun: string, aKind: GeometryKind): string {
  const noun = lowerFirst(aNoun);
  const t = outcome.totals;
  const n = (v: number) => v.toLocaleString("en-US");
  if (aKind === "polygon" && t.areaKm2 !== undefined && t.ofAreaKm2 !== undefined && op !== "near" && op !== "along") {
    const acres = n(t.areaAcres ?? Math.round(t.areaKm2 * KM2_TO_ACRES));
    const pct = Math.round((t.share ?? 0) * 100);
    if (op === "outside") {
      return `Of ${fmtKm2(t.ofAreaKm2)} km² of ${noun}, ${fmtKm2(t.areaKm2)} km² (${acres} acres, ${pct}%) lies ${relation}, in ${n(outcome.count)} of ${n(outcome.of)} areas.`;
    }
    return `${n(outcome.count)} of ${n(outcome.of)} ${noun} are ${relation}: ${fmtKm2(t.areaKm2)} km² (${acres} acres), ${pct}% of their ${fmtKm2(t.ofAreaKm2)} km².`;
  }
  const lead = `${n(outcome.count)} of ${n(outcome.of)} ${noun} are ${relation}`;
  if ((op === "near" || op === "along") && t.minDistanceKm !== undefined) return `${lead}; the closest is ${t.minDistanceKm} km away.`;
  return `${lead}.`;
}

/** Card facts and a measure for the join's own numbers. */
function joinFields(op: CombineOp, aKind: GeometryKind, bName: string): { facts: CardFact[]; attributes: Attribute[] } {
  if (op === "near" || op === "along") {
    return {
      facts: [
        { key: "distanceKm", label: `Distance to ${bName}`, format: "km" },
        { key: "nearest", label: "Nearest" },
      ],
      attributes: [{ key: "distanceKm", type: "measure", label: `Distance to ${bName}`, unit: "km" }],
    };
  }
  if (aKind === "polygon" && op === "outside") {
    return {
      facts: [
        { key: "outsideAcres", label: "Area outside", unit: "acres", format: "int" },
        { key: "outsideShare", label: "Share outside", format: "pct" },
      ],
      attributes: [{ key: "outsideAcres", type: "measure", label: "Area outside", unit: "acres" }],
    };
  }
  if (aKind === "polygon") {
    return {
      facts: [
        { key: "overlapAcres", label: "Overlap", unit: "acres", format: "int" },
        { key: "overlapShare", label: "Share overlapping", format: "pct" },
        { key: "overlapWith", label: "Overlaps" },
      ],
      attributes: [{ key: "overlapAcres", type: "measure", label: "Overlap", unit: "acres" }],
    };
  }
  if (aKind === "line") return { facts: [{ key: "shareInside", label: "Share inside", format: "pct" }], attributes: [] };
  return { facts: op === "outside" ? [] : [{ key: "inside", label: "Inside" }], attributes: [] };
}

type Side = { layer: Layer; features: Feature[]; citation: Citation; bbox: BBox; input: Record<string, unknown> };

/** The features of one side: the latest successful query of its layer this turn, asked again (from the cache), filtered. */
async function sideOf(side: z.infer<typeof SideSchema>, turn: Turn, view: MapView | null): Promise<Side | CombineError> {
  const ids = listLayers().map((l) => l.id);
  const id = canonicalLayerId(side.layerId, ids);
  const layer = getLayer(id);
  if (!layer) return { error: `Unknown layer ${side.layerId}` };
  const asked = turn.queries.findLast((q) => q.layerId === id && q.ok);
  const bbox = asked?.bbox ?? turn.place?.bbox ?? view?.bbox ?? undefined;
  if (!bbox) return { error: `Query ${id} first: combine joins layers answered this turn.` };
  const input = asked ? (Object.fromEntries(JSON.parse(asked.inputKey) as [string, unknown][]) as Record<string, unknown>) : {};
  if (!asked) turn.note(`combine: ${id} was not queried this turn; asked it over [${bbox.join(", ")}] with its default inputs`);
  const body = (await runLayer(id, { bbox, input })).body;
  if ("error" in body) return { error: `${id} did not answer: ${body.error}` };
  if (body.kind !== "geojson") return { error: `${id} answers with map tiles, not features, so it cannot be combined.` };
  const filters: LayerFilters = { ...(side.filters ?? {}) };
  if (side.match) filters.name = { ...filters.name, match: side.match };
  const kept = applyFilters(body.data, filters).features;
  return { layer, features: kept, citation: body.citation, bbox, input };
}

/** Runs the combine tool. Never throws: problems come back as { error } for the model to read. */
export async function runCombine(input: CombineInput, turn: Turn, view: MapView | null): Promise<CombinedResult | CombineError> {
  const a = await sideOf(input.a, turn, view);
  if ("error" in a) return a;
  let b: Side | undefined;
  let bFeatures: Feature[];
  let bName: string;
  let fromName: string | undefined;
  let caveat: string | undefined;
  let otherCitation: Citation | undefined;
  if (input.op === "drive_time") {
    let center: Position | undefined;
    if (Array.isArray(input.from)) center = input.from;
    else if (typeof input.from === "string") {
      const found = await turn.lookup(input.from);
      if ("error" in found) return { error: `Could not find ${input.from} to drive from.` };
      center = found.center;
      fromName = input.from;
    } else if (turn.place) {
      center = turn.place.center;
      fromName = turn.place.name.split(",")[0];
    } else if (view?.center) center = view.center;
    if (!center) return { error: "drive_time needs from: a place name or [lon, lat]." };
    fromName ??= `[${center.map((c) => c.toFixed(3)).join(", ")}]`;
    const reach = await driveReach(center, input.minutes ?? 30);
    bFeatures = [reach.area];
    bName = fromName;
    caveat = reach.caveat;
    otherCitation = reach.citation;
  } else {
    if (!input.b) return { error: `${input.op} needs b: the layer to test against.` };
    const other = await sideOf(input.b, turn, view);
    if ("error" in other) return other;
    b = other;
    bFeatures = other.features;
    bName = otherName(input.b, other);
    otherCitation = other.citation;
    if (input.b.match && bFeatures.length === 0) return { error: `No feature of ${other.layer.id} is named like "${input.b.match}" in the box it answered; query it where that feature is.` };
  }
  const aKind = geometryKind(a.features);
  const bKind = geometryKind(bFeatures);
  const problem = combineProblem(input.op, aKind, bKind);
  if (problem) return { error: problem };
  const distanceM = (input.distance ?? 1) * TO_M[input.unit ?? "km"];
  const outcome = combineFeatures({ op: input.op, a: a.features, b: bFeatures, distanceM });
  const aTitle = sideNoun(a.layer, a.input);
  const relation = relationText(input.op, bName, input, fromName);
  const title = `${aTitle} ${relation}`;
  const statement = statementOf(relation, input.op, outcome, aTitle, aKind!);
  const id = `${COMBINED_PREFIX}${SLUG(`${a.layer.id}-${input.op}-${input.op === "drive_time" ? `${input.minutes ?? 30}min-${fromName}` : bName}`)}`;
  const fields = joinFields(input.op, aKind!, bName);
  const skippedNote = outcome.skipped > 0 ? `${plural(outcome.skipped, "feature")} with broken outlines could not be clipped and are left out` : undefined;
  const geometry: StyleHints["geometry"] = aKind === "polygon" ? "polygon" : aKind === "line" ? "line" : "point";
  const style: StyleHints = { ...a.layer.style, geometry };
  return {
    kind: "geojson",
    data: { type: "FeatureCollection", features: outcome.features },
    citation: {
      source: [a.citation.source, otherCitation && otherCitation.source !== a.citation.source ? otherCitation.source : undefined].filter(Boolean).join("; "),
      url: a.citation.url,
      retrieved: a.citation.retrieved,
    },
    coverageNote: [statement, caveat, skippedNote].filter(Boolean).join(" "),
    title,
    legend: {
      kind: "symbol",
      title,
      items: [{ label: title, symbol: geometry }],
      note: [statement, caveat].filter(Boolean).join(" "),
    },
    combined: {
      id,
      sourceLayerId: a.layer.id,
      ...(b && { otherLayerId: b.layer.id }),
      op: input.op,
      statement,
      count: outcome.count,
      of: outcome.of,
      totals: outcome.totals,
      style,
      facts: fields.facts,
      attributes: fields.attributes,
      ...(caveat && { caveat }),
    },
  };
}

/** The name a feature goes by in the model's top list. */
function featureName(f: Feature): string {
  const p = f.properties ?? {};
  for (const key of ["name", "title", "heading", "kind"]) if (typeof p[key] === "string" && p[key]) return p[key] as string;
  return "unnamed";
}

const TOP_KEYS = ["distanceKm", "nearest", "overlapAcres", "overlapShare", "overlapWith", "outsideAcres", "outsideShare", "inside", "shareInside"];

/** What the model reads: the statement, counts, totals and the first ten kept features with the join's numbers. */
export function combineOutputForModel(output: unknown): JSONValue {
  if (!output || typeof output !== "object" || "error" in output) return output as JSONValue;
  const r = output as CombinedResult;
  const top = r.data.features.slice(0, 10).map((f) => ({
    name: featureName(f),
    ...Object.fromEntries(TOP_KEYS.filter((k) => f.properties?.[k] !== undefined).map((k) => [k, f.properties![k]])),
  }));
  return {
    layerId: r.combined.id,
    title: r.title,
    statement: r.combined.statement,
    count: r.combined.count,
    of: r.combined.of,
    totals: r.combined.totals,
    top,
    ...(r.combined.caveat && { caveat: r.combined.caveat }),
    drawn: `Drawn as its own layer "${r.title}", id ${r.combined.id}: no render call is needed (to restyle or filter it, render layerId "${r.combined.id}"); the source layer ${r.combined.sourceLayerId} is hidden under it. Quote the statement's numbers in the note.`,
  } as JSONValue;
}

/** Builds the combine tool for one turn. */
export function combineTool({ turn, view }: { turn: Turn; view: MapView | null }) {
  return tool({
    description:
      "Join two layers you queried this turn into a new map layer, with counts and areas to quote: " +
      "within (A's features inside B's areas: fires inside a national forest), outside (A not inside B: jaguar records outside protected areas, old growth not in wilderness, with the area outside), " +
      "near (A within distance of B: campsites within 1 km of a lake), along (A within distance of a line B: water sources or camps along the Wonderland Trail; pass b.match with the trail's name), " +
      "overlap (A's areas that overlap B's areas, with acres and share: grazing allotments overlapping tortoise habitat, herd areas in drought), " +
      "drive_time (A within minutes' drive of from, by road). Query both layers first (for along, query the trail's layer where the trail is). " +
      "The result is drawn by itself; quote its statement in the note.",
    inputSchema: CombineInputSchema,
    execute: async (input) => {
      const out = await runCombine(input, turn, view);
      if (!("error" in out)) {
        turn.drawn.add(out.combined.sourceLayerId);
        turn.drawn.add(out.combined.id);
        const box = bboxOfFeatures(out.data.features);
        const first = out.data.features[0];
        const measure = out.combined.attributes[0]?.key;
        const value = measure ? first?.properties?.[measure] : undefined;
        turn.queries.push({
          layerId: out.combined.id,
          bbox: box ?? turn.place?.bbox ?? [-180, -90, 180, 90],
          inputKey: JSON.stringify([["op", input.op]]),
          ok: true,
          drawable: out.data.features.length > 0,
          wide: false,
          ...(first && typeof value === "number" && measure !== "distanceKm" && { top: { name: featureName(first), value, by: measure! } }),
        });
        turn.note(`combine: ${out.combined.statement}`);
      }
      return out;
    },
    toModelOutput: ({ output }) => ({ type: "json", value: combineOutputForModel(output) }),
  });
}
