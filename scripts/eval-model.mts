/**
 * Run questions through the real agent (system prompt + generated tools) against the
 * model named by MODEL_NAME, and print what happened.
 *
 *   MODEL_NAME=qwen/qwen3.7-flash pnpm exec tsx scripts/eval-model.mts "Show hiking trails around Lake Tahoe"
 *   node --env-file=.env.local --import tsx scripts/eval-model.mts --set
 *
 * With a question, prints one JSON line: model, ok, tool sequence, feature count, errors,
 * tokens, seconds. With --set, runs every question listed between the `<!-- eval:start -->`
 * and `<!-- eval:end -->` markers in docs/questions.md (lines starting with "- "), one after
 * another, prints one JSON line each, then a final line `ok N/M`.
 * "ok" means: the place was located (geocode or a physical-regions query), a query tool ran,
 * anything that came back was rendered (render or compare), the model wrote a note, and the
 * run finished without throwing. When nothing was drawn, the note only passes if at least one
 * layer answered successfully with zero features (an honest "nothing here"); a question whose
 * every layer query errored fails however much text was written. A route-only question passes
 * when the route tool ran and a note followed.
 *
 * A question may end with `@view=[w,s,e,n]`, the map view the browser would send with it
 * (lib/agent/view.ts). The view goes into the system prompt and into buildTools the way
 * app/api/chat/route.ts passes it, and the place then counts as located without a geocode.
 * A question without `@view` that geocodes a named place must also move the camera there, or it fails: a successful
 * geocode names the place, and the map then fits the features returned for it (lib/render/reducer.ts, spec §12), as
 * set_view moves it.
 * An `@view` question whose view is too wide for a layer (a zoom_in error) must still answer at that scale: it passes
 * only when the model did not move the camera (set_view or a successful geocode), got at most one zoom_in error per layer (no shrinking and retrying), and
 * at least one query succeeded and was drawn and rendered (the error's widerScale layers). A reply that only asks the
 * user to zoom in is a refusal and fails.
 * Every question also fails when a note (or, with no note, the closing text) runs over NOTE_MAX_WORDS words or a heading appears twice across the notes
 * and the closing text (the note is the answer; the text after it is only follow-ups).
 * Some questions carry their own extra rule (QUESTION_RULES), matched on the question in lower case.
 *
 * Map checks (lib/checks/mapChecks.ts): every question's tool results are replayed through the browser's mapping and
 * reducer to the final map, and six checks run on it: features on land or at sea as the layer says (surface), no point
 * layer on a regular grid (lattice), no place drawn or ranked twice (duplicates), card rows in words (card), only
 * registered layers (layerIds), and for a question about a place, the features in or near it (place). The JSON line
 * carries `checks` (each with its failures as sentences); a question passes only if the rules above and every check pass.
 *
 *   --save <dir>     also writes each question's run (tool calls and closing text) to <dir> as gzipped JSON
 *   --replay <dir>   reads the runs from <dir> instead of calling the model (checks and rules only, no credits)
 *   --only <text>    runs only the set's questions containing <text> (case ignored; a|b for either)
 *   --screens        after the set, the screen checks (scripts/evalScreens.ts) on SCREEN_QUESTIONS: each one's final
 *                    map opened by permalink in a browser at desktop and phone size; see that file for the server.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { generateText, stepCountIs } from "ai";
import { getLayer, listLayers } from "@/layers";
import { getModel } from "@/lib/agent/provider";
import { isFullLayerResult, summarizeLayerResult, type GeojsonSummary } from "@/lib/layers/summarize";
import { buildTools, repairToolCall } from "@/lib/agent/tools";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";
import type { MapView } from "@/lib/agent/view";
import { parseMapView, systemForTurn } from "@/lib/agent/viewContext";
import { toolResultToActions, type LayerCatalog } from "@/lib/agent/applyToolResult";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type MapState } from "@/lib/render/state";
import { visibleState } from "@/lib/render/view";
import { lineEntries } from "@/lib/render/nativeLines";
import { boundsOf } from "@/lib/render/views";
import { runMapChecks, type CheckResult, type LayerInfo, type PlaceRef } from "@/lib/checks/mapChecks";
import type { BBox } from "@/layers/types";


const model = process.env.MODEL_NAME ?? "(unset)";

/** Longest note that passes: the prompt asks for about 120 words. */
const NOTE_MAX_WORDS = 150;

type ToolCall = { toolName: string; input?: unknown; output?: unknown };

function isZoomInError(output: unknown): boolean {
  return !!output && typeof output === "object" && (output as { hint?: unknown }).hint === "zoom_in";
}

/** The note tool's markdown, when the call carried it. */
function noteText(output: unknown): string {
  const markdown = output && typeof output === "object" ? (output as { markdown?: unknown }).markdown : undefined;
  return typeof markdown === "string" ? markdown : "";
}

function featureCount(output: unknown): number | null {
  if (!output || typeof output !== "object") return null;
  const o = output as { kind?: string; data?: { features?: unknown[] } };
  if (o.kind === "geojson" && Array.isArray(o.data?.features)) return o.data.features.length;
  return null;
}

/** Tile layers (forest loss, night lights, public lands, ...) return a tiles descriptor instead of features. */
function isTiles(output: unknown): boolean {
  return !!output && typeof output === "object" && (output as { kind?: string }).kind === "tiles";
}

/** Questions between the eval markers in docs/questions.md, one per "- " line. */
function readEvalSet(): string[] {
  const text = readFileSync(new URL("../docs/questions.md", import.meta.url), "utf8");
  const m = text.match(/<!-- eval:start -->([\s\S]*?)<!-- eval:end -->/);
  if (!m) throw new Error("docs/questions.md is missing the eval:start / eval:end markers");
  return m[1]
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
}

type Outcome = { ok: boolean; line: Record<string, unknown> };

const isLayerError = (output: unknown) => !!output && typeof output === "object" && "error" in output;

/** Feature names in a query output (full geojson results only). */
function featureNames(output: unknown): string[] {
  const features = (output as { kind?: string; data?: { features?: { properties?: Record<string, unknown> | null }[] } } | undefined)?.data?.features;
  if (!Array.isArray(features)) return [];
  return features.flatMap((f) => (typeof f.properties?.name === "string" ? [f.properties.name] : []));
}

/** Lower case, straight apostrophes, single spaces: how a name and the note are compared. */
function comparable(text: string): string {
  return text.toLowerCase().replace(/[\u2018\u2019`]/g, "'").replace(/\s+/g, " ");
}

type RuleResult = { ok: boolean; [detail: string]: unknown };

/**
 * "good hiking in French Guiana" (the owner's transcript, where a too-wide trails query fell back to protected-area
 * tiles, a region outline and population density): passes only when at least one query that holds hiking candidates
 * succeeded (osm-trails with named routes, peaks, outdoor-features or protected-areas-world), population and
 * night-lights were not queried, and the note (the closing text when there is none), within NOTE_MAX_WORDS, names at
 * least 3 places from the returned features.
 */
function goodHikingRule(calls: ToolCall[], notes: string[]): RuleResult {
  const CANDIDATES = ["query_osm-trails", "query_peaks", "query_outdoor-features", "query_protected-areas-world"];
  const answered = calls.filter((c) => {
    if (!CANDIDATES.includes(c.toolName) || c.output === undefined || isLayerError(c.output)) return false;
    if (c.toolName !== "query_osm-trails") return true;
    const features = (c.output as { data?: { features?: { properties?: { kind?: unknown } | null }[] } }).data?.features ?? [];
    return features.some((f) => f.properties?.kind === "route");
  });
  const contextQueried = calls.some((c) => c.toolName === "query_population" || c.toolName === "query_night-lights");
  const note = comparable(notes.join("\n"));
  const names = [...new Set(answered.flatMap((c) => featureNames(c.output)).map(comparable))].filter((n) => n.length >= 4);
  const named = names.filter((n) => note.includes(n));
  const words = wordCount(notes.join("\n"));
  const ok = answered.length > 0 && !contextQueried && words <= NOTE_MAX_WORDS && named.length >= 3;
  return { ok, candidateQueries: answered.map((c) => c.toolName), contextQueried, placesNamed: named.length, named: named.slice(0, 8) };
}

/** True for a geocode that found a place (the browser moves the camera to its bbox). */
function geocodeMoved(c: ToolCall): boolean {
  return c.toolName === "geocode" && !!c.output && typeof c.output === "object" && !isLayerError(c.output) && "bbox" in c.output;
}

/** The camera moved to the place: a successful geocode, or set_view. */
function cameraMoved(calls: ToolCall[]): boolean {
  return calls.some((c) => c.toolName === "set_view" || geocodeMoved(c));
}

/**
 * "Glaciers in the Wind River Range" (the owner's transcript: four geocodes, a 53,570 km² box over the glacier cap, a
 * shrunk retry, no camera move, and a note that read 0.18-0.29 km² off three sample features while Gannett Glacier is
 * ~3 km²): passes only with at most 2 geocode calls, a camera move, and a note that names the largest named glacier in
 * the returned stats (stats.top, over every outline), gives a total area in km², and never says "sample".
 */
function windRiverGlaciersRule(calls: ToolCall[], notes: string[]): RuleResult {
  const geocodes = calls.filter((c) => c.toolName === "geocode").length;
  const style = getLayer("glaciers")?.style;
  const summaries = calls
    .filter((c) => c.toolName === "query_glaciers" && isFullLayerResult(c.output))
    .map((c) => summarizeLayerResult(c.output as Parameters<typeof summarizeLayerResult>[0], "glaciers", style) as GeojsonSummary);
  const top = summaries.flatMap((s) => s.stats?.top ?? []).sort((a, b) => b.v - a.v);
  const largest = top.find((t) => !/^unnamed/i.test(t.name))?.name;
  const note = notes.join("\n");
  const namesLargest = largest !== undefined && comparable(note).includes(comparable(largest));
  const statesTotal = /total[^.\n]*?\d[\d,.]*\s*km(?:²|2)|\d[\d,.]*\s*km(?:²|2)[^.\n]*?\btotal\b/i.test(note);
  const saysSample = /\bsampl/i.test(note);
  const moved = cameraMoved(calls);
  const ok = geocodes <= 2 && moved && namesLargest && statesTotal && !saysSample;
  return { ok, geocodes, cameraMoved: moved, largest, namesLargest, statesTotal, saysSample };
}

/** The bbox a query call was made with, when its input carried one. */
function bboxOf(input: unknown): [number, number, number, number] | undefined {
  const bbox = input && typeof input === "object" ? (input as { bbox?: unknown }).bbox : undefined;
  return Array.isArray(bbox) && bbox.length === 4 && bbox.every((n) => typeof n === "number") ? (bbox as [number, number, number, number]) : undefined;
}

/** Rough area of a bbox in km², as lib/layers/run.ts measures it. */
function areaKm2([w, s, e, n]: [number, number, number, number]): number {
  return (e - w) * 111.32 * Math.cos((((s + n) / 2) * Math.PI) / 180) * (n - s) * 110.57;
}

/** The largest feature by v in the full outputs of one layer's successful queries. */
function largestByV(calls: ToolCall[], toolName: string): { name: string; v: number } | undefined {
  let best: { name: string; v: number } | undefined;
  for (const c of calls) {
    if (c.toolName !== toolName || isLayerError(c.output)) continue;
    const features = (c.output as { data?: { features?: { properties?: Record<string, unknown> | null }[] } } | undefined)?.data?.features ?? [];
    for (const f of features) {
      const v = f.properties?.v;
      const name = f.properties?.name;
      if (typeof v === "number" && typeof name === "string" && (best === undefined || v > best.v)) best = { name, v };
    }
  }
  return best;
}

/** The registry entry the map checks read, by layer id. */
const lookupLayer = (id: string): LayerInfo | undefined => getLayer(id);

/** A geocode's place name, when its output carries one. */
function placeName(output: unknown): string | undefined {
  const name = output && typeof output === "object" ? (output as { name?: unknown }).name : undefined;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

/**
 * The place a question is about, for the place check: every place it geocoded (their boxes joined), else the map view
 * a "here" question carries; null when it named none (a route question's stops are places too).
 */
function questionPlace(calls: ToolCall[], view: MapView | null): PlaceRef | null {
  const found = calls.filter(geocodeMoved).flatMap((c) => {
    const bbox = bboxOf(c.output);
    return bbox ? [{ bbox, name: placeName(c.output) ?? "the place" }] : [];
  });
  if (found.length > 0) {
    const bbox: BBox = [
      Math.min(...found.map((f) => f.bbox[0])),
      Math.min(...found.map((f) => f.bbox[1])),
      Math.max(...found.map((f) => f.bbox[2])),
      Math.max(...found.map((f) => f.bbox[3])),
    ];
    return { bbox, name: [...new Set(found.map((f) => f.name))].join(" and ") };
  }
  return view?.bbox ? { bbox: view.bbox as BBox, name: "the map view" } : null;
}

/** The map the browser would end on: every tool result through the client's mapping and the reducer, in order. */
function mapAfter(calls: ToolCall[]): MapState {
  const catalog: LayerCatalog = Object.fromEntries(
    listLayers().map((l) => [
      l.id,
      { title: l.title, style: l.style, license: l.license, ...(l.fieldHelp && { fieldHelp: l.fieldHelp }), ...(l.card && { card: l.card }), ...(l.attributes && { attributes: l.attributes }) },
    ]),
  );
  let state = reduce(initialMapState, { type: "turn_start" });
  for (const c of calls) {
    if (c.output === undefined) continue;
    for (const action of toolResultToActions(c.toolName, c.input, c.output, { width: 1440, height: 900 }, catalog, state.renderOps)) state = reduce(state, action);
  }
  return state;
}

function contains(outer: number[] | undefined, inner: number[] | null): boolean {
  if (!outer || !inner) return false;
  const eps = 1e-6;
  return outer[0] <= inner[0] + eps && outer[1] <= inner[1] + eps && outer[2] >= inner[2] - eps && outer[3] >= inner[3] - eps;
}

/**
 * "How has Bears Ears changed since 2021?" (the owner's Bears Ears case: the camera stayed Utah-wide, two thin
 * outlines, no change encoding): passes only when the map ends in the change view: a compare by version on monuments'
 * kind with both the 2021 and the current boundary drawn (lost and gained), and the camera fitted to the union of both.
 */
function bearsEarsChangeRule(calls: ToolCall[]): RuleResult {
  const state = mapAfter(calls);
  const compare = state.compare;
  const drawn = visibleState(state).layers.monuments;
  const features = drawn?.result.kind === "geojson" ? drawn.result.data.features : [];
  const classes = [...new Set(features.map((f) => f.properties?.delta))];
  const union = boundsOf(features);
  const ok = compare?.layerId === "monuments" && compare.by?.key === "kind" && classes.includes("a-only") && classes.includes("b-only") && contains(state.camera?.bbox, union);
  return { ok, view: state.renderOps.find((o) => o.layerId === "monuments")?.view, by: compare?.by, classes, camera: state.camera?.bbox, union };
}

/**
 * "Show only hard mountain bike trails near Moab" (the owner's Moab case: a "Value ≥ 4" slider and no difficulty
 * filter): passes only when mtb-trails is filtered on its difficulty facet through render.filters so that hard trails
 * (Singletrack 3) are drawn and nothing easier is, and the lines take the facet ramp.
 */
function moabHardRule(calls: ToolCall[]): RuleResult {
  const state = mapAfter(calls);
  const op = state.renderOps.find((o) => o.layerId === "mtb-trails");
  // The facet chips write an include list; a range from 3 up is the same filter written by hand.
  const filter = op?.filters?.v;
  const drawn = visibleState(state).layers["mtb-trails"];
  const values = drawn?.result.kind === "geojson" ? drawn.result.data.features.map((f) => Number(f.properties?.v)) : [];
  const look = lineEntries(visibleState(state)).find((e) => e.layerId === "mtb-trails")?.look.kind;
  const ok = filter !== undefined && values.includes(3) && values.every((v) => v >= 3) && look === "facet";
  return { ok, filter, drawn: values.length, look };
}

/**
 * "Which uranium mines near the Navajo Nation score highest?" (the owner: "if you list a score on the detail card it
 * needs an i-icon"): passes only when uranium ends in the ranked view and the model's summary carried the hazard
 * score's help text, and the note names the highest-scoring site.
 */
function uraniumRankedRule(calls: ToolCall[], notes: string[]): RuleResult {
  const state = mapAfter(calls);
  const view = state.renderOps.find((o) => o.layerId === "uranium")?.view;
  const layer = getLayer("uranium");
  const query = calls.find((c) => c.toolName === "query_uranium" && c.output !== undefined && !isLayerError(c.output));
  const summary = query && isFullLayerResult(query.output) ? summarizeLayerResult(query.output, "uranium", { ...layer?.style, attributes: layer?.attributes }, layer?.fieldHelp) : undefined;
  const help = summary && "kind" in summary && summary.kind === "geojson" ? summary.help : undefined;
  const largest = largestByV(calls, "query_uranium");
  const namesLargest = largest !== undefined && comparable(notes.join("\n")).includes(comparable(largest.name));
  const ok = view === "ranked" && help !== undefined && Object.values(help).some((t) => /Navajo/.test(t)) && namesLargest;
  return { ok, view, help: help ? Object.keys(help) : [], largest, namesLargest };
}

/**
 * "wind farms in West Texas" over a 392,000 km² view (the owner's case: power-plants errored over its 250,000 km² cap,
 * the model shrank the box to a 3°x3° slice and drew 9 sites): passes only when a power-plants query answered with at
 * least 100 features, power-plants was queried once, its box was at least 90% of the region's area (the region the user
 * named, when the model geocoded it, else the view: no shrinking), none came back as a zoom_in error, and the note names
 * the largest site by MW among the returned features.
 */
function westTexasWindRule(calls: ToolCall[], notes: string[], view: MapView | null): RuleResult {
  const plants = calls.filter((c) => c.toolName === "query_power-plants");
  const answered = plants.filter((c) => c.output !== undefined && !isLayerError(c.output));
  const most = Math.max(0, ...answered.map((c) => featureCount(c.output) ?? 0));
  // Geocoding the region the user named ("West Texas") is allowed: its box, not the view's, is the one not to shrink.
  const named = calls.filter(geocodeMoved).map((c) => bboxOf(c.output)).find((b) => b !== undefined);
  const region = named ?? view?.bbox;
  const viewArea = region ? areaKm2(region) : undefined;
  const boxes = plants.map((c) => bboxOf(c.input)).filter((b): b is [number, number, number, number] => b !== undefined);
  const shrank = viewArea !== undefined && boxes.some((b) => areaKm2(b) < viewArea * 0.9);
  const zoomIn = plants.some((c) => isZoomInError(c.output));
  const largest = largestByV(calls, "query_power-plants");
  const namesLargest = largest !== undefined && comparable(notes.join("\n")).includes(comparable(largest.name));
  const ok = most >= 100 && plants.length === 1 && !shrank && !zoomIn && namesLargest;
  return { ok, features: most, queries: plants.length, region, shrank, zoomIn, largest, namesLargest, boxes };
}

/** "dams in the Colorado River basin": a basin-wide box must answer (wide, largest by storage), not error and shrink. */
function coloradoDamsRule(calls: ToolCall[], notes: string[]): RuleResult {
  const dams = calls.filter((c) => c.toolName === "query_dams");
  const most = Math.max(0, ...dams.filter((c) => !isLayerError(c.output)).map((c) => featureCount(c.output) ?? 0));
  const zoomIn = dams.filter((c) => isZoomInError(c.output)).length;
  const largest = largestByV(calls, "query_dams");
  const namesLargest = largest !== undefined && comparable(notes.join("\n")).includes(comparable(largest.name));
  const ok = most > 0 && zoomIn === 0 && dams.length <= 2;
  return { ok, features: most, damQueries: dams.length, zoomIn, largest, namesLargest, boxes: dams.map((c) => bboxOf(c.input)) };
}

/**
 * "Where are most of the wind farms by capacity in West Texas?" (spec §12d: "where is most of the capacity" colors hex
 * cells by the sum of the measure): passes only when power-plants ends in the density view drawn as hex cells with the
 * sum basis, its drawn features are wind (a kind filter, or the wind-turbines source), and the note names the place.
 */
function windCapacityHexRule(calls: ToolCall[], notes: string[]): RuleResult {
  const state = mapAfter(calls);
  const op = state.renderOps.find((o) => o.layerId === "power-plants");
  const drawn = visibleState(state).layers["power-plants"];
  const kinds = drawn?.result.kind === "geojson" ? [...new Set(drawn.result.data.features.map((f) => f.properties?.kind))] : [];
  const wind = kinds.length > 0 && kinds.every((k) => k === "wind");
  const hexes = op?.mode === "hexbin" || op?.mode === "columns";
  const namesTexas = /texas/i.test(notes.join("\n"));
  const ok = op?.view === "density" && op.hexBasis === "sum" && hexes && wind && namesTexas;
  return { ok, view: op?.view, mode: op?.mode, hexBasis: op?.hexBasis, kinds, filters: op?.filters };
}

/**
 * "Show only sport crags at Red River Gorge" (spec §12c: chat and the row's chips share one state): passes only when
 * climbing is filtered through render.filters on its discipline attribute to sport alone, so the Sport chip is the
 * one pressed and every drawn crag lists sport, and climbing was not re-queried to filter (an empty first answer, from a
 * wrong box, may be asked again).
 */
function sportCragsRule(calls: ToolCall[]): RuleResult {
  const state = mapAfter(calls);
  const op = state.renderOps.find((o) => o.layerId === "climbing");
  const include = op?.filters?.disciplines?.include;
  const drawn = visibleState(state).layers.climbing;
  const features = drawn?.result.kind === "geojson" ? drawn.result.data.features : [];
  const allSport = features.length > 0 && features.every((f) => Array.isArray(f.properties?.disciplines) && f.properties.disciplines.includes("sport"));
  // A query that came back empty (a wrong box) and was asked again is not a re-query to filter; two that drew crags are.
  const queries = calls.filter((c) => c.toolName === "query_climbing" && !isLayerError(c.output) && (featureCount(c.output) ?? 0) > 0).length;
  const ok = include !== undefined && include.length === 1 && include[0] === "sport" && allSport && queries <= 1;
  return { ok, filters: op?.filters, drawn: features.length, allSport, queries };
}

/** Extra pass rules for particular questions, keyed by the question in lower case. */
const QUESTION_RULES: Record<string, (calls: ToolCall[], notes: string[], view: MapView | null) => RuleResult> = {
  "good hiking in french guiana": goodHikingRule,
  "glaciers in the wind river range": windRiverGlaciersRule,
  "wind farms in west texas": westTexasWindRule,
  "dams in the colorado river basin": coloradoDamsRule,
  "how has bears ears changed since 2021?": bearsEarsChangeRule,
  "show only hard mountain bike trails near moab": moabHardRule,
  "which uranium mines near the navajo nation score highest?": uraniumRankedRule,
  "where are most of the wind farms by capacity in west texas?": (calls, notes) => windCapacityHexRule(calls, notes),
  "show only sport crags at red river gorge": (calls) => sportCragsRule(calls),
};

/** Every coverage note the queries returned, so a wide result's "Showing the N largest of M" line is in the output. */
function coverageNotes(calls: ToolCall[]): string[] {
  return calls.flatMap((c) => {
    const note = c.output && typeof c.output === "object" ? (c.output as { coverageNote?: unknown }).coverageNote : undefined;
    return c.toolName.startsWith("query_") && typeof note === "string" ? [`${c.toolName.slice(6)}: ${note}`] : [];
  });
}

function wordCount(markdown: string): number {
  return markdown.replace(/[#*_`>|-]+/g, " ").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Headings in markdown: "# Title", a bold-only line, or a "Label:" line, lowercased. */
function headingsOf(markdown: string): string[] {
  const out: string[] = [];
  for (const line of markdown.split("\n")) {
    const m = /^\s*(?:#{1,6}\s+(.+?)\s*|(?:\*\*|__)(.+?)(?:\*\*|__)\s*|([A-Z][\w' -]{1,40}):\s*)$/.exec(line);
    const title = m && (m[1] ?? m[2] ?? m[3]);
    if (title) out.push(title.replace(/[*_:]/g, "").trim().toLowerCase());
  }
  return out;
}

/** Headings that appear more than once across all the notes and the closing text. */
function duplicatedHeadings(texts: string[]): string[] {
  const all = texts.flatMap(headingsOf);
  return [...new Set(all.filter((h, i) => all.indexOf(h) !== i))];
}

/** Splits a trailing `@view=[w,s,e,n]` off a question into the view a ~1000px-wide map would send for that box. */
function splitView(raw: string): { question: string; view: MapView | null } {
  const m = raw.match(/^(.*?)\s*@view=(\[[^\]]*\])\s*$/);
  if (!m) return { question: raw, view: null };
  const bbox: unknown = JSON.parse(m[2]);
  if (!Array.isArray(bbox) || bbox.length !== 4) throw new Error(`Bad @view on: ${raw}`);
  const [w, s, e, n] = bbox as number[];
  const zoom = Math.round(Math.log2((360 / (e - w)) * (1000 / 512)) * 10) / 10;
  const view = parseMapView({ bbox, zoom, center: [(w + e) / 2, (s + n) / 2] });
  if (!view) throw new Error(`Bad @view on: ${raw}`);
  return { question: m[1], view };
}

/** One question's run: what the model did, as the checks and rules read it (saved with --save, read with --replay). */
type Run = {
  raw: string;
  calls: ToolCall[];
  text: string;
  usage: { in?: number; out?: number };
  seconds: number;
  finish: string;
};

/** Runs one question through the real agent and collects every tool call (with its output, when it returned). */
async function runModel(raw: string): Promise<Run> {
  const started = Date.now();
  const { question, view } = splitView(raw);
  const result = await generateText({
    model: getModel(),
    system: systemForTurn(SYSTEM_PROMPT, view),
    tools: buildTools({ view }),
    prompt: question,
    stopWhen: stepCountIs(12),
    repairToolCall,
  });
  const calls: ToolCall[] = [];
  for (const step of result.steps) {
    for (const r of step.toolResults) calls.push({ toolName: r.toolName, input: r.input, output: r.output });
    for (const c of step.toolCalls) {
      if (!step.toolResults.some((r) => r.toolCallId === c.toolCallId)) calls.push({ toolName: c.toolName, input: c.input });
    }
  }
  return {
    raw,
    calls,
    text: result.text,
    usage: { in: result.totalUsage.inputTokens, out: result.totalUsage.outputTokens },
    seconds: Math.round((Date.now() - started) / 100) / 10,
    finish: result.finishReason,
  };
}

/** The file a question's run is saved under: the question as a slug. */
export function slugOf(raw: string): string {
  return raw
    .replace(/@view=.*/, "here")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/** What the screen checks need from a question: the final map and the camera fit it asked for. */
type Evaluated = Outcome & { state: MapState; checks: CheckResult[] };

/** The pass rule and the map checks on one run. */
function evaluate(run: Run): Evaluated {
  const { calls, text } = run;
  const { question, view } = splitView(run.raw);
  const seq = calls.map((c) => c.toolName);
  const features = calls.map((c) => featureCount(c.output)).filter((n): n is number => n !== null);
  const queryCalls = calls.filter((c) => c.toolName.startsWith("query_"));
  const layerErrors = queryCalls
    .filter((c) => isLayerError(c.output))
    .map((c) => String((c.output as { error: string }).error).slice(0, 80));
  // A query that answered (not an error, not a call that never returned) with zero features.
  const answeredEmpty = queryCalls.some((c) => c.output !== undefined && !isLayerError(c.output) && featureCount(c.output) === 0);
  const tiles = queryCalls.filter((c) => isTiles(c.output)).length;
  const queried = seq.some((t) => t.startsWith("query_"));
  const rendered = seq.includes("render") || seq.includes("compare");
  const noted = seq.includes("note") || text.trim().length > 40;
  const routed = seq.includes("route");
  const drew = features.some((n) => n > 0) || tiles > 0;
  // Locating the place: geocode, or a physical-regions query (the model may outline a
  // named region such as the Amazon directly). Drawing: render, or compare (which draws both sides).
  // With a map view (and a bbox) the place is already on screen, so no geocode is needed.
  const located = !!view?.bbox || seq.includes("geocode") || seq.includes("query_physical-regions");
  // A route question is answered by the route tool alone (it geocodes its own stops).
  // A query that drew something must have been rendered. When nothing was drawn, the note passes
  // only if some layer answered with zero features; layer errors and a note alone are a failure.
  // A question that names a place (no @view, so the model had to geocode it) must also move the
  // camera there; otherwise the data loads off-screen. A successful geocode moves it by itself, as does
  // set_view. @view questions are exempt.
  const moved = cameraMoved(calls);
  const movedToPlace = view !== null || !seq.includes("geocode") || moved;
  // A view too wide for a layer: ask the user to zoom in once, rather than shrink the box, retry and move the camera.
  const zoomInLayers = queryCalls.filter((c) => isZoomInError(c.output)).map((c) => c.toolName);
  const zoomInPerLayer = Math.max(0, ...zoomInLayers.map((t) => zoomInLayers.filter((u) => u === t).length));
  const reply = [...calls.filter((c) => c.toolName === "note").map((c) => noteText(c.output)), text].join(" ");
  const askedToZoomIn = /zoom(?:ing)? in|zoom closer|closer view|smaller area/i.test(reply);
  // Also a model that read the layer's km² limit and asked without querying at all.
  const wideView = view !== null && (zoomInLayers.length > 0 || (!queried && askedToZoomIn));
  // Answering at this scale: some query came back without an error, and what it drew was rendered.
  const succeeded = queryCalls.filter((c) => c.output !== undefined && !isLayerError(c.output)).length;
  const wideViewOk = !moved && zoomInPerLayer <= 1 && succeeded >= 1 && drew && rendered;
  // Brevity: the note is the answer, and nothing is said twice.
  const notes = calls.filter((c) => c.toolName === "note").map((c) => noteText(c.output));
  // With no note, the closing text is the answer and is held to the same length.
  const noteWords = (notes.length > 0 ? notes : [text]).map(wordCount);
  const dupHeadings = duplicatedHeadings([...notes, text]);
  const brief = noteWords.every((n) => n <= NOTE_MAX_WORDS) && dupHeadings.length === 0;
  // With no note, the closing text is the answer, as for noteWords.
  const answer = notes.length > 0 ? notes : [text];
  const rule = QUESTION_RULES[question.trim().toLowerCase()]?.(calls, answer, view);
  const rulesOk =
    brief &&
    (rule?.ok ?? true) &&
    (wideView
      ? wideViewOk
      : routed && !queried
        ? noted
        : located && movedToPlace && queried && (drew ? rendered : answeredEmpty) && noted);
  // The map checks read the map the browser would end on.
  const state = mapAfter(calls);
  const checks = runMapChecks(state, { lookup: lookupLayer, place: questionPlace(calls, view) });
  const checksOk = checks.every((c) => c.ok);
  const ok = rulesOk && checksOk;

  return {
    ok,
    state,
    checks,
    line: {
      question,
      ...(view ? { view: view.bbox, geocoded: seq.includes("geocode"), movedCamera: moved } : {}),
      ...(wideView ? { zoomInErrors: zoomInLayers.length, zoomInPerLayer, askedToZoomIn, succeeded } : {}),
      noteWords,
      ...(dupHeadings.length > 0 ? { dupHeadings } : {}),
      ...(rule ? { rule, answer: answer.join("\n") } : {}),
      model,
      ok,
      rulesOk,
      checks: checks.map((c) => (c.ok ? { check: c.check, ok: true } : c)),
      seq,
      features,
      tiles,
      layerErrors,
      coverageNotes: coverageNotes(calls),
      tokens: run.usage,
      seconds: run.seconds,
      finish: run.finish,
      textWords: wordCount(text),
      textStart: text.replace(/\s+/g, " ").slice(0, 120),
    },
  };
}

/**
 * The questions the screen checks open (scripts/evalScreens.ts), about a dozen covering lines (trails, mountain bike
 * facets, ski routes), points (crags, surf, dams, wildlife), hexes (wind capacity), areas (fire perimeters, glaciers, a
 * monument), ranked cards (uranium) and two layers at once (campsites and roads); each at desktop and phone size.
 */
export const SCREEN_QUESTIONS = [
  "Show hiking trails around Lake Tahoe",
  "Mountain bike trails near Moab",
  "Ski touring routes around Chamonix",
  "Find campsites and forest roads open to vehicles near Moab",
  "Climbing crags near Red River Gorge",
  "Surf at Half Moon Bay today",
  "What wildlife has been spotted around Banff this year?",
  "Show dams on the Colorado River by the decade they were built",
  "Where are most of the wind farms by capacity in West Texas?",
  "Which wildfires burned near Yosemite in the last 10 years?",
  "Glaciers in the Wind River Range",
  "How has Bears Ears changed since 2021?",
  "Which uranium mines near the Navajo Nation score highest?",
];

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function saveRun(dir: string, run: Run): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${slugOf(run.raw)}.json.gz`, gzipSync(JSON.stringify(run)));
}

function loadRun(dir: string, raw: string): Run | undefined {
  const file = `${slugOf(raw)}.json.gz`;
  if (!readdirSync(dir).includes(file)) return undefined;
  return JSON.parse(gunzipSync(readFileSync(`${dir}/${file}`)).toString("utf8")) as Run;
}

/** Runs (or replays) one question and evaluates it; a thrown run is a failure line. */
async function question(raw: string, opts: { save?: string; replay?: string }): Promise<Evaluated | Outcome> {
  const started = Date.now();
  try {
    const saved = opts.replay ? loadRun(opts.replay, raw) : undefined;
    if (opts.replay && !saved) throw new Error(`no saved run for this question in ${opts.replay}`);
    const run = saved ?? (await runModel(raw));
    if (opts.save && !saved) saveRun(opts.save, run);
    return evaluate(run);
  } catch (err) {
    return {
      ok: false,
      line: { question: raw, model, ok: false, error: err instanceof Error ? err.message.slice(0, 200) : String(err), seconds: Math.round((Date.now() - started) / 100) / 10 },
    };
  }
}

const args = process.argv.slice(2);
const save = argValue(args, "--save");
const replay = argValue(args, "--replay");
const only = argValue(args, "--only")?.toLowerCase().split("|");
const screens = args.includes("--screens");
if (args.includes("--set")) {
  const questions = readEvalSet().filter((q) => !only || only.some((o) => q.toLowerCase().includes(o)));
  let passed = 0;
  const forScreens: { raw: string; slug: string; state: MapState; failures: string[] }[] = [];
  for (const q of questions) {
    const outcome = await question(q, { save, replay });
    if (outcome.ok) passed += 1;
    console.log(JSON.stringify(outcome.line));
    if (screens && "state" in outcome && SCREEN_QUESTIONS.includes(q)) {
      forScreens.push({ raw: q, slug: slugOf(q), state: outcome.state, failures: outcome.checks.flatMap((c) => c.failures) });
    }
  }
  console.log(`ok ${passed}/${questions.length}`);
  if (screens) {
    const { runScreens } = await import("@/scripts/evalScreens");
    const screenResult = await runScreens(forScreens);
    console.log(`screens ok ${screenResult.passed}/${screenResult.total} (contact sheet ${screenResult.sheet})`);
    if (screenResult.passed < screenResult.total) process.exitCode = 1;
  }
  if (passed < questions.length) process.exitCode = 1;
} else {
  const raw = args.filter((a, i) => !a.startsWith("--") && !["--save", "--replay", "--only"].includes(args[i - 1])).join(" ") || "Show hiking trails around Lake Tahoe";
  const outcome = await question(raw, { save, replay });
  console.log(JSON.stringify(outcome.line));
  if (!outcome.ok && "error" in outcome.line) process.exitCode = 1;
}
