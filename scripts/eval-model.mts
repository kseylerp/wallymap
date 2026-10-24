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
 *   --tag coverage   runs only the coverage questions (COVERAGE_QUESTIONS), each also held to its expected layers and view;
 *                    one whose layer is under a documented outage (Layer.outage) and did not answer is skipped, not passed
 *   --tag usecase    runs only the use-case questions (USECASE_QUESTIONS, docs/use-cases.md), each held to its expected
 *                    layers, view and filter; what the app still lacks for the full answer is listed as `needs`
 *   --tag top10      runs only the top 10 use cases' 50 golden questions (scripts/top10.expectations.ts, docs/top-10-use-cases.md;
 *                    not in docs/questions.md), each also held to the strict rule in scripts/top10Check.ts: every
 *                    assertion its expectation names (layers, filters, view, basemap, labels, legend, card order, the
 *                    note's deciding facts, grounding, answer first, 3 specific follow-ups, camera, phone first screen)
 *   --screens        after the set, the screen checks (scripts/evalScreens.ts) on SCREEN_QUESTIONS: each one's final
 *                    map opened by permalink in a browser at desktop and phone size; see that file for the server.
 *                    Refuses to start with under 5 GB free disk, stops cleanly under 2 GB, and prints the disk the run
 *                    used at its peak (scripts/diskGuard.ts).
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { generateText } from "ai";
import { getLayer, listLayers } from "@/layers";
import { agentTurn } from "@/lib/agent/agent";
import { isFullLayerResult, summarizeLayerResult, type GeojsonSummary } from "@/lib/layers/summarize";
import type { MapView } from "@/lib/agent/view";
import { parseMapView } from "@/lib/agent/viewContext";
import { toolResultToActions, type LayerCatalog } from "@/lib/agent/applyToolResult";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type MapState, type RenderMode, type ViewKind } from "@/lib/render/state";
import { visibleState } from "@/lib/render/view";
import { lineEntries } from "@/lib/render/nativeLines";
import { boundsOf } from "@/lib/render/views";
import { runMapChecks, type CheckResult, type LayerInfo, type PlaceRef } from "@/lib/checks/mapChecks";
import type { BBox } from "@/layers/types";
import { isActiveEntry } from "@/lib/render/filters";
import { nearBox, nearPlace } from "@/lib/agent/places";
import { freeBytes, sizeText, START_MIN_FREE, watchDisk, type DiskGuard } from "@/scripts/diskGuard";
import { TOP10, top10For } from "@/scripts/top10.expectations";
import { top10Rule } from "@/scripts/top10Check";


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
export function readEvalSet(): string[] {
  const text = readFileSync(new URL("../docs/questions.md", import.meta.url), "utf8");
  const m = text.match(/<!-- eval:start -->([\s\S]*?)<!-- eval:end -->/);
  if (!m) throw new Error("docs/questions.md is missing the eval:start / eval:end markers");
  return m[1]
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
}

type Outcome = { ok: boolean; line: Record<string, unknown>; skipped?: string };

const isLayerError = (output: unknown) => !!output && typeof output === "object" && "error" in output;

/** Feature names in a query output (full geojson results only). */
function featureNames(output: unknown): string[] {
  const features = (output as { kind?: string; data?: { features?: { properties?: Record<string, unknown> | null }[] } } | undefined)?.data?.features;
  if (!Array.isArray(features)) return [];
  return features.flatMap((f) => (typeof f.properties?.name === "string" ? [f.properties.name] : []));
}

/** Lower case, straight apostrophes and hyphens, single spaces: how a name and the note are compared ("NA‑0420" with a non-breaking hyphen is NA-0420). */
function comparable(text: string): string {
  return text.toLowerCase().replace(/[\u2018\u2019`]/g, "'").replace(/[\u2010-\u2015\u2212]/g, "-").replace(/[\s\u00a0\u202f]+/g, " ");
}

type RuleResult = { ok: boolean; [detail: string]: unknown };

/** A name as a note may write it: comparable, "Mt."/"Mount", "St."/"Saint" and "&"/"and" alike. */
function spoken(text: string): string {
  return comparable(text)
    .replace(/\bmt\.?(?=\s)/g, "mount")
    .replace(/\bst\.?(?=\s)/g, "saint")
    .replace(/\s&\s/g, " and ");
}

/**
 * True when the note names `name`: as written, without a trailing tag ("Taylor Reid No. 1 (A)"), or with the usual
 * abbreviations either way ("Mt. Hood" for "Mount Hood"). Pass rules that check a note's wording accept any clear way of
 * saying the same thing, never one exact phrase.
 */
export function noteNames(note: string, name: string): boolean {
  const n = spoken(note);
  const full = spoken(name);
  const bare = full.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return n.includes(full) || (bare.length >= 3 && n.includes(bare));
}

/** Words that make an area in km² a sum over many features: "total", "together", "combined", "in all", "between them". */
const AGGREGATE = String.raw`(?:total(?:ling|ing)?|together|combined|altogether|in all|all told|overall|collectively|between them|sum|cumulative)`;
const KM2 = String.raw`\d[\d,.]*\s*(?:km(?:²|2)|square kilomet(?:er|re)s|sq\.? ?km)`;

/** True when the note gives a summed area in km², in any clear wording ("together covering 21 km²", "a combined 21 km²"). */
export function statesTotalArea(note: string): boolean {
  return new RegExp(String.raw`\b${AGGREGATE}[^.\n]*?${KM2}|${KM2}[^.\n]*?\b${AGGREGATE}\b`, "i").test(note);
}

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
  const note = notes.join("\n");
  const names = [...new Set(answered.flatMap((c) => featureNames(c.output)).map(comparable))].filter((n) => n.length >= 4);
  const named = names.filter((n) => noteNames(note, n));
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
 * the returned stats (stats.top, over every outline), gives a summed area in km² in any clear wording ("total", "together
 * covering", "combined"), and never says "sample".
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
  const namesLargest = largest !== undefined && noteNames(note, largest);
  const statesTotal = statesTotalArea(note);
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
 * The place a question is about, for the place check: every place it geocoded (their boxes joined, and for "near
 * <town>" the radius each queried layer searches around it), else the map view a "here" question carries; null when it
 * named none (a route question's stops are places too).
 */
function questionPlace(calls: ToolCall[], view: MapView | null, question?: string): PlaceRef | null {
  const found = calls.filter(geocodeMoved).flatMap((c) => {
    const bbox = bboxOf(c.output);
    return bbox ? [{ bbox, name: placeName(c.output) ?? "the place" }] : [];
  });
  if (found.length > 0) {
    // "near <town>" means the layer's radius around the town (lib/agent/places.ts nearBox), as the server queries it.
    const near = question !== undefined && nearPlace(question) !== null;
    const radii = near
      ? calls.filter(geocodeMoved).flatMap((g) => {
          const geo = g.output as { bbox: BBox; center: [number, number]; source?: string };
          return calls.filter((c) => c.toolName.startsWith("query_")).flatMap((c) => {
            const box = nearBox(question!, c.toolName.slice(6), geo);
            return box ? [box] : [];
          });
        })
      : [];
    const boxes = [...found.map((f) => f.bbox), ...radii];
    const bbox: BBox = [
      Math.min(...boxes.map((b) => b[0])),
      Math.min(...boxes.map((b) => b[1])),
      Math.max(...boxes.map((b) => b[2])),
      Math.max(...boxes.map((b) => b[3])),
    ];
    return { bbox, name: [...new Set(found.map((f) => f.name))].join(" and ") };
  }
  return view?.bbox ? { bbox: view.bbox as BBox, name: "the map view" } : null;
}

/** The map the browser would end on: every tool result through the client's mapping and the reducer, in order. */
export function mapAfter(calls: ToolCall[]): MapState {
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
 * `boundary` (its 2021 and current outlines matched by name), with what was lost drawn (the 2021 edge, "a-only") and
 * what remains ("both"), and the camera fitted to the union of both.
 */
function bearsEarsChangeRule(calls: ToolCall[]): RuleResult {
  const state = mapAfter(calls);
  const compare = state.compare;
  const drawn = visibleState(state).layers.monuments;
  const features = drawn?.result.kind === "geojson" ? drawn.result.data.features : [];
  const classes = [...new Set(features.map((f) => f.properties?.delta))];
  const union = boundsOf(features);
  const ok = compare?.layerId === "monuments" && compare.by?.key === "boundary" && classes.includes("a-only") && classes.includes("both") && contains(state.camera?.bbox, union);
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
  const namesLargest = largest !== undefined && noteNames(notes.join("\n"), largest.name);
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
  const namesLargest = largest !== undefined && noteNames(notes.join("\n"), largest.name);
  const ok = most >= 100 && plants.length === 1 && !shrank && !zoomIn && namesLargest;
  return { ok, features: most, queries: plants.length, region, shrank, zoomIn, largest, namesLargest, boxes };
}

/** "dams in the Colorado River basin": a basin-wide box must answer (wide, largest by storage), not error and shrink. */
function coloradoDamsRule(calls: ToolCall[], notes: string[]): RuleResult {
  const dams = calls.filter((c) => c.toolName === "query_dams");
  const most = Math.max(0, ...dams.filter((c) => !isLayerError(c.output)).map((c) => featureCount(c.output) ?? 0));
  const zoomIn = dams.filter((c) => isZoomInError(c.output)).length;
  const largest = largestByV(calls, "query_dams");
  const namesLargest = largest !== undefined && noteNames(notes.join("\n"), largest.name);
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

/**
 * A data story's caption (spec §13, lib/agent/prompt.ts "A timeline note follows the data's shape"): the note gives a low
 * and a peak (or strongest) with numbers, says what size, width or brightness and color mean, and (`ratio`) puts the two
 * in proportion; the basemap stepped back to Data only.
 */
function captionShapeRule(layerId: string, opts: { ratio?: boolean; low?: boolean } = {}) {
  return (calls: ToolCall[], notes: string[]): RuleResult => {
    const text = notes.join(" ").toLowerCase();
    const numbers = (text.match(/\d[\d,.]*/g) ?? []).length;
    const low = opts.low === false || /\b(low|lowest|minimum|bottom|weakest|slack|calm)/.test(text);
    const peak = /\b(peak|high|highest|maximum|max|strongest|fastest|top)/.test(text);
    const meaning = /\b(colou?r|width|wide|wider|thick|bright|brightness)/.test(text);
    const ratio = !opts.ratio || /(\d+(\.\d+)?\s*(times|×|x)\b|(twice|two|three|four|five|six|ten)[\s\-\u2010-\u2015]*(times|fold)|doubl|tripl|quadrupl|half|halv|percent|%)/.test(text);
    const dataOnly = calls.some((c) => c.toolName === "set_basemap" && (c.input as { style?: unknown } | undefined)?.style === "data-only");
    const drawn = calls.some((c) => c.toolName === "render" && (c.input as { layerId?: unknown } | undefined)?.layerId === layerId);
    return { ok: numbers >= 2 && low && peak && meaning && ratio && drawn, numbers, low, peak, meaning, ratio, dataOnly, drawn };
  };
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
  "how has the mississippi's flow changed over the last three months?": captionShapeRule("river-pulse", { ratio: true }),
  "show the currents in cook inlet this week": captionShapeRule("ocean-currents"),
  // "Where is it strongest" asks for the peak and where; a low is not the question.
  "where is the wind strongest over the sierra tomorrow?": captionShapeRule("wind-flow", { low: false }),
};

/**
 * What a coverage question must end with (docs/questions.md, "Coverage questions"): `layers` each queried, answered
 * without an error and, when the answer held features or tiles, drawn ("a|b" for either layer); `view` the standard
 * view the drawn layer ends in (route: a route on the map; change: also a compare on the layer); `mode` its Show as.
 * An empty `layers` is a route question, answered by the route tool alone.
 */
export type CoverageExpect = { layers: string[]; view?: ViewKind; mode?: RenderMode };

/**
 * The coverage questions, keyed by the question in lower case (without its @view): together with the older questions
 * (LAYERS_IN_OLDER_QUESTIONS) every registered layer is asked about, and every standard view is expected at least twice.
 */
export const COVERAGE_QUESTIONS: Record<string, CoverageExpect> = {
  // Change: then vs now.
  "has grand staircase-escalante gotten smaller since 2021?": { layers: ["monuments"], view: "change" },
  "how much less sea ice is in the arctic this september than in 2012?": { layers: ["sea-ice"], view: "change" },
  "show lahaina before and after the 2023 fire": { layers: ["imagery-by-date"], view: "change" },
  // Satellite water area or the reservoir's own storage record: either answers whether it shrank.
  "did lake mead shrink since the 1980s?": { layers: ["surface-water|reservoir-levels"] },
  // Timeline: dated features over time.
  "wolf packs in washington since 2014": { layers: ["wolf-packs"], view: "timeline" },
  "where did beetles kill trees in colorado over the last ten years?": { layers: ["tree-mortality"], view: "timeline" },
  "earthquakes in japan this month": { layers: ["earthquakes"], view: "timeline" },
  // Ranked: biggest, highest, busiest, most.
  "busiest ports on the gulf coast": { layers: ["ports"], view: "ranked" },
  "highest peaks in the southern alps of new zealand": { layers: ["peaks"], view: "ranked" },
  "biggest glaciers in patagonia": { layers: ["glaciers"], view: "ranked" },
  "which counties in florida had the most disaster declarations?": { layers: ["disasters"], view: "ranked" },
  // Density: where are the most.
  "where are most of the old mines in nevada?": { layers: ["mines"], view: "density" },
  "where are the most groundwater wells around phoenix?": { layers: ["groundwater"], view: "density" },
  "heatmap of brown bear sightings in alaska": { layers: ["gbif-occurrences|species"], view: "density", mode: "heat" },
  "show power plants in arizona as 3d columns by megawatts": { layers: ["power-plants"], mode: "columns" },
  // Detail: one thing.
  "what rock is table mountain made of?": { layers: ["geologic-unit"], view: "detail" },
  "tell me about mount kilimanjaro": { layers: ["peaks|wikipedia-nearby"], view: "detail" },
  "how deep is crater lake?": { layers: ["lakes"], view: "detail" },
  // Scenario: an amount of sea level rise.
  "show charleston with 6 feet of sea level rise": { layers: ["sea-level-rise"], view: "scenario" },
  "what would 2 feet of sea level rise do to honolulu?": { layers: ["sea-level-rise"], view: "scenario" },
  // Route: plan a route.
  "plan a bike ride from banff to lake louise": { layers: [], view: "route" },
  "walking route from zermatt to the hörnli hut": { layers: [], view: "route" },
  "plan a hike from happy isles to the top of half dome": { layers: [], view: "route" },
  // Layers no older question asks about, one question each.
  "where is the ogallala aquifer?": { layers: ["aquifers"] },
  // "Which large fires burned …" asks for named fires, which fire-perimeters answers; burn severity is how badly.
  "how badly did the 2020 fires burn in oregon?": { layers: ["burn-severity"] },
  "is the tongass a carbon sink?": { layers: ["carbon-flux"] },
  "can i see condors near big sur?": { layers: ["condor-range"] },
  "critical habitat for the desert tortoise near st. george": { layers: ["critical-habitat"] },
  "any floods or cyclones in mozambique right now?": { layers: ["disasters"] },
  "where has forest just been cleared in british columbia?": { layers: ["disturbance"] },
  "how dry is colorado this week?": { layers: ["drought"] },
  "wildfire risk around bend": { layers: ["fire-hazard"] },
  "fire danger in southern california this week": { layers: ["fire-weather"] },
  "where can i fish for trout near bozeman?": { layers: ["fishing"] },
  "is there flooding along the zambezi right now?": { layers: ["flood-extent"] },
  "is downtown asheville in a flood zone?": { layers: ["flood-zones"] },
  "new deforestation alerts in the congo this month": { layers: ["forest-alerts"] },
  "show the geology of the grand canyon": { layers: ["geology"] },
  "where are the wild horses in nevada?": { layers: ["grazing-allotments"] },
  "show plant hardiness zones in vermont": { layers: ["hardiness-zones"] },
  "what's the land cover around torres del paine?": { layers: ["land-cover"] },
  "active mining claims near moab": { layers: ["mining-claims"] },
  "oil and gas leases near chaco canyon": { layers: ["mineral-leases"] },
  "where is the old-growth forest in oregon?": { layers: ["old-growth"] },
  // Forest types (ForTy via Earth Engine): the class here, and natural forest converted since a year (its change view).
  "is this primary forest or plantation?": { layers: ["forest-types"] },
  "where has natural forest been converted to plantations in borneo since 2017?": { layers: ["forest-types"] },
  "rapids on the middle fork salmon": { layers: ["paddling"] },
  "kayaking rivers near queenstown": { layers: ["paddling"] },
  "where is the permafrost in alaska?": { layers: ["permafrost"] },
  "did spring come early in virginia this year?": { layers: ["phenology"] },
  "where do people take photos around mount fuji?": { layers: ["photos"] },
  "pipelines and power lines near midland, texas": { layers: ["pipelines-lines"] },
  "trailheads and picnic areas in the coconino national forest": { layers: ["recreation-sites"] },
  "what watershed is denver in?": { layers: ["river-basins"] },
  "is there wildfire smoke over seattle today?": { layers: ["smoke"] },
  "when is low tide at acadia?": { layers: ["tides"] },
  "tell me about the history of bodie": { layers: ["wikipedia-nearby"] },
  // Is it safe or open now, near me, compare two places.
  "is it safe to hike at paradise on mount rainier today?": { layers: ["weather-alerts"] },
  "are the forest roads open for camping near flagstaff?": { layers: ["forest-roads"] },
  "huts near here": { layers: ["outdoor-features"] },
  "where can i fish here": { layers: ["fishing"] },
  "which is more remote, the gila or the bob marshall?": { layers: ["remoteness"] },
  "compare snow depth at mount baker and mount hood": { layers: ["snowpack"] },
  // Data stories (spec §13, §13a): a whole river network day by day, currents and wind as moving particles, hourly.
  "how has the mississippi's flow changed over the last three months?": { layers: ["river-pulse"], view: "timeline" },
  "show the currents in cook inlet this week": { layers: ["ocean-currents"], view: "timeline" },
  "where is the avalanche terrain near teton pass?": { layers: ["terrain"] },
  "where is the wind strongest over the sierra tomorrow?": { layers: ["wind-flow"] },
  // The forecasts added for the use cases (audit R8, R10): a 7-day hourly weather forecast and the avalanche centers' danger.
  "will it rain in yosemite valley this weekend?": { layers: ["weather-forecast"] },
  "what's the avalanche danger in little cottonwood canyon today?": { layers: ["avalanche"] },
};

/**
 * A use-case question's expectation (docs/use-cases.md; audit in .superpowers/m3/usecases/AUDIT.md): the coverage
 * expectation (layers answered and drawn, view, Show as) plus the use case it belongs to, the `render.filters` key the
 * decision needs on a layer (`layer` may be "a|b"), and `needs`: what the app lacks today for the full answer, in
 * words (a missing source or a cross-layer step). The rule checks layers, view and filter; `needs` and the use case's
 * acceptance list are checked by hand until the app can answer them.
 */
export type UsecaseExpect = CoverageExpect & { useCase: string; filter?: { layer: string; key: string }; join?: string; needs?: string[] };

/** The use-case questions, keyed by the question in lower case (`--tag usecase` runs only these). */
export const USECASE_QUESTIONS: Record<string, UsecaseExpect> = {
  // UC01 Day hiker picks a trail.
  "good day hikes near boulder under 5 miles": { useCase: "UC01", layers: ["popularity|osm-trails"], view: "ranked", filter: { layer: "popularity|osm-trails", key: "lengthKm" } },
  "easy hikes with a waterfall near asheville": { useCase: "UC01", layers: ["popularity|osm-trails", "outdoor-features"], join: "near" },
  // UC02 Hiker checks snow on trails.
  "which trails at mount rainier are snow free right now?": { useCase: "UC02", layers: ["snow-cover", "osm-trails|popularity"], needs: ["snow sampled along each trail"] },
  "is there still snow on the trails around lake tahoe?": { useCase: "UC02", layers: ["snowpack", "snow-cover"] },
  // UC03 Backpacker plans water and camps.
  "backpacking in the wind rivers: where are the water sources and campsites?": { useCase: "UC03", layers: ["outdoor-features|lakes", "campsites"] },
  "where can i camp along the wonderland trail?": { useCase: "UC03", layers: ["osm-trails", "campsites"], join: "along" },
  // UC04 Trail runner picks a long run with the right climbing.
  "long trail runs with big climbs near chamonix": { useCase: "UC04", layers: ["popularity|osm-trails"], view: "ranked" },
  "flat trail runs over 10 miles near portland": { useCase: "UC04", layers: ["popularity|osm-trails"], filter: { layer: "popularity|osm-trails", key: "lengthKm" } },
  // UC05 Mountain biker picks an intermediate ride.
  "intermediate mountain bike trails near bentonville": { useCase: "UC05", layers: ["mtb-trails"], filter: { layer: "mtb-trails", key: "v|level" } },
  "flowy blue trails in sedona": { useCase: "UC05", layers: ["mtb-trails"], filter: { layer: "mtb-trails", key: "v|level" } },
  // UC06 Sport climber picks a crag by style and sun.
  "which crags near moab are sport and shaded in the afternoon?": { useCase: "UC06", layers: ["climbing"], view: "ranked", filter: { layer: "climbing", key: "disciplines" } },
  "beginner sport climbing at red rock near las vegas": { useCase: "UC06", layers: ["climbing"], filter: { layer: "climbing", key: "disciplines|sportBands" } },
  // UC07 Boulderer checks the weekend conditions.
  "bouldering near bishop this weekend, will it be too hot?": { useCase: "UC07", layers: ["climbing", "weather-forecast"], filter: { layer: "climbing", key: "disciplines|boulderBands" } },
  "is it too windy to climb at joshua tree tomorrow?": { useCase: "UC07", layers: ["weather-forecast|wind-flow"] },
  // UC08 Whitewater kayaker picks a run with water.
  "where can i paddle class iii near asheville this weekend?": { useCase: "UC08", layers: ["paddling", "streamflow"], filter: { layer: "paddling", key: "v" }, needs: ["whitewater class", "runnable range per section"] },
  "is the gauley running right now?": { useCase: "UC08", layers: ["streamflow"], needs: ["runnable range"] },
  "class iv runs in colorado with enough water right now": { useCase: "UC08", layers: ["paddling", "streamflow"], filter: { layer: "paddling", key: "v" }, needs: ["whitewater class", "runnable range per section"] },
  // UC09 Sea or flatwater kayaker times the tide and wind.
  "best time to kayak tomales bay tomorrow, tide and wind": { useCase: "UC09", layers: ["tides", "weather-forecast|wind-flow"], view: "timeline" },
  "where can i launch a kayak on lake tahoe?": { useCase: "UC09", layers: ["recreation-sites|fishing|paddling"] },
  // UC10 Backcountry skier checks avalanche danger and snow.
  "avalanche danger near stevens pass today": { useCase: "UC10", layers: ["avalanche"] },
  "where's the deepest fresh snow in utah right now?": { useCase: "UC10", layers: ["snowpack"], view: "ranked" },
  "low-angle ski tours near teton pass": { useCase: "UC10", layers: ["ski-routes"] },
  // UC11 Angler picks a river by flow and water temperature.
  "is the madison fishing well right now?": { useCase: "UC11", layers: ["streamflow|fishing"] },
  "where can i fly fish with public access near asheville?": { useCase: "UC11", layers: ["fishing", "public-lands"], needs: ["access points on public land (join)"] },
  "trout streams near denver that aren't too warm": { useCase: "UC11", layers: ["fishing|streamflow"], filter: { layer: "fishing|streamflow", key: "tempBand|tempF" } },
  // UC12 Surfer picks a session.
  "will santa cruz have good surf this weekend?": { useCase: "UC12", layers: ["surf"], needs: ["tide"] },
  "where is the swell biggest on the oregon coast right now?": { useCase: "UC12", layers: ["surf"], view: "ranked" },
  // UC13 Car camper finds free dispersed camping.
  "free dispersed camping near sedona": { useCase: "UC13", layers: ["forest-roads", "public-lands"], needs: ["dispersed camping closures"] },
  "where can i park my van overnight on blm land near moab?": { useCase: "UC13", layers: ["public-lands", "campsites"], needs: ["designated-site rules"] },
  // UC14 Overlander plans a route with water and camps.
  "camping and water along the mojave road": { useCase: "UC14", layers: ["campsites", "outdoor-features"], join: "along", needs: ["the named route's line"] },
  "forest roads a subaru can drive near leadville": { useCase: "UC14", layers: ["forest-roads"], filter: { layer: "forest-roads", key: "level" } },
  // UC15 Wildlife watcher finds an animal.
  "where can i see moose near jackson hole?": { useCase: "UC15", layers: ["species|gbif-occurrences"], view: "density" },
  "where are whales being seen off monterey this week?": { useCase: "UC15", layers: ["species|gbif-occurrences"] },
  // UC16 Birder plans a migration trip.
  "best place to see sandhill cranes in nebraska in march": { useCase: "UC16", layers: ["gbif-occurrences"], view: "density" },
  "where have bald eagles been seen near seattle lately?": { useCase: "UC16", layers: ["species|gbif-occurrences"] },
  // UC17 Photographer picks a sunset or night spot.
  "where should i shoot sunset near sedona?": { useCase: "UC17", layers: ["photos|outdoor-features"], needs: ["sunset time and azimuth", "view direction"] },
  "darkest skies for milky way photos near moab": { useCase: "UC17", layers: ["night-lights"], needs: ["brightness values at places"] },
  "is there fall color near asheville right now?": { useCase: "UC17", layers: ["imagery-by-date|greenness"], needs: ["a fall color source"] },
  // UC18 Resident watches smoke and fire.
  "is it smoky in bend tomorrow?": { useCase: "UC18", layers: ["smoke"] },
  "are the fires near missoula contained?": { useCase: "UC18", layers: ["fire-perimeters"] },
  // UC19 Flood and weather watcher.
  "is the french broad going to flood in asheville?": { useCase: "UC19", layers: ["streamflow"] },
  "any flash flood warnings in utah canyons today?": { useCase: "UC19", layers: ["weather-alerts"] },
  "will it rain in zion this weekend?": { useCase: "UC19", layers: ["weather-forecast"] },
  // UC20 Ranger reviews fire history and burn severity.
  "how much of the deschutes national forest burned in the last 10 years and how badly?": { useCase: "UC20", layers: ["fire-perimeters", "burn-severity"], needs: ["clip to the forest boundary", "severity acres by class"] },
  "where did beetles kill trees in the medicine bow since 2020?": { useCase: "UC20", layers: ["tree-mortality"], view: "timeline" },
  // UC21 Range manager checks grazing against habitat and drought.
  "grazing allotments overlapping desert tortoise critical habitat near st. george": { useCase: "UC21", layers: ["grazing-allotments", "critical-habitat"], join: "overlap" },
  "wild horse areas in nevada that are in drought right now": { useCase: "UC21", layers: ["grazing-allotments", "drought"], join: "overlap" },
  // UC22 Conservation researcher measures deforestation and its drivers.
  "how much forest did pará lose since 2017 and to what?": { useCase: "UC22", layers: ["forest-loss"], needs: ["hectares lost (zonal totals)", "drivers of loss"] },
  "which protected areas in borneo lost the most forest?": { useCase: "UC22", layers: ["forest-loss", "protected-areas-world"], needs: ["loss per protected area (zonal totals)"] },
  // UC23 Conservation researcher finds species outside protection.
  "jaguar records in costa rica outside protected areas": { useCase: "UC23", layers: ["gbif-occurrences|species", "protected-areas-world"], join: "outside" },
  "old-growth forest in oregon that isn't in wilderness": { useCase: "UC23", layers: ["old-growth", "wilderness"], join: "outside" },
  // UC24 Journalist checks a water, disaster or emissions story.
  "how much has lake powell dropped since 2000?": { useCase: "UC24", layers: ["reservoir-levels"] },
  "which california counties got the most disaster declarations since 2020?": { useCase: "UC24", layers: ["disasters"], view: "ranked" },
  "biggest methane leaks in the permian this year": { useCase: "UC24", layers: ["methane-plumes"], view: "ranked" },
  // UC25 Educator shows a change to a class.
  "show my class how the glaciers in glacier national park have shrunk": { useCase: "UC25", layers: ["glaciers"], view: "change" },
  "what rock is under denver?": { useCase: "UC25", layers: ["geologic-unit"], view: "detail" },
  "how has arctic sea ice changed since 2012?": { useCase: "UC25", layers: ["sea-ice"], view: "change" },
};

/** The use-case expectation for a question as written in the set (its @view dropped), if it is one. */
export function usecaseFor(raw: string): UsecaseExpect | undefined {
  return USECASE_QUESTIONS[raw.replace(/\s*@view=.*$/, "").trim().toLowerCase()];
}

/**
 * A use-case question's rule: the coverage rule on its layers and view, and, when it names one, a `render.filters`
 * entry on that layer for that key (either of `a|b` for both), so "only intermediate trails" ends with the chips set.
 */
export function usecaseRule(expect: UsecaseExpect, calls: ToolCall[]): RuleResult {
  const coverage = coverageRule(expect, calls);
  // A question that relates two layers ("outside protected areas", "in drought") must end with combine's join.
  const joined = expect.join === undefined || calls.some((c) => c.toolName === "combine" && (c.input as { op?: string } | undefined)?.op === expect.join && !hasError(c.output));
  const joinPart = expect.join !== undefined ? { join: expect.join, joined } : {};
  if (!expect.filter) return { ...coverage, ok: coverage.ok && joined, useCase: expect.useCase, ...joinPart, ...(expect.needs && { needs: expect.needs }) };
  const layers = expect.filter.layer.split("|");
  const keys = expect.filter.key.split("|");
  const ops = mapAfter(calls).renderOps.filter((o) => layers.includes(o.layerId));
  const filtered = ops.some((o) => keys.some((k) => isActiveEntry(o.filters?.[k])));
  return { ...coverage, ok: coverage.ok && filtered && joined, useCase: expect.useCase, filter: expect.filter, filtered, ...joinPart, ...(expect.needs && { needs: expect.needs }) };
}

function hasError(output: unknown): boolean {
  return !!output && typeof output === "object" && "error" in output;
}

/** Layers the older eval questions (before the coverage questions) already ask about, per their Last run tool lists. */
export const LAYERS_IN_OLDER_QUESTIONS = [
  "osm-trails", "fire-perimeters", "fire-detections", "forest-loss", "snowpack", "snow-cover", "streamflow", "campsites",
  "forest-roads", "species", "outdoor-features", "popularity", "popularity-campsites", "public-lands", "wilderness",
  "night-lights", "population", "remoteness", "physical-regions", "surf", "peaks", "protected-areas-world", "mtb-trails",
  "ski-routes", "climbing", "lakes", "weather-alerts", "earthquakes", "geologic-unit", "glaciers", "greenness",
  "gbif-occurrences", "reservoir-levels", "dams", "monuments", "uranium", "sea-level-trends", "sea-level-rise",
  "methane-plumes", "temperature-anomaly", "sequoia-groves", "sequoia-mortality", "power-plants",
];

/** The coverage expectation for a question as written in the set (its @view dropped), if it is one. */
export function coverageFor(raw: string): CoverageExpect | undefined {
  return COVERAGE_QUESTIONS[raw.replace(/\s*@view=.*$/, "").trim().toLowerCase()];
}

/** A coverage question's rule: each expected layer answered and drawn, and the view and Show as it expects. */
export function coverageRule(expect: CoverageExpect, calls: ToolCall[]): RuleResult {
  const state = mapAfter(calls);
  const layers = expect.layers.map((alts) => {
    const ids = alts.split("|");
    const queries = calls.filter((c) => ids.some((id) => c.toolName === `query_${id}`));
    const answered = queries.filter((c) => c.output !== undefined && !isLayerError(c.output));
    const returned = answered.some((c) => (featureCount(c.output) ?? 0) > 0 || isTiles(c.output));
    const drawn = state.renderOps.some((o) => ids.includes(o.layerId));
    return { layer: alts, queried: queries.length, answered: answered.length, drawn, ok: answered.length > 0 && (!returned || drawn) };
  });
  const ids = expect.layers.flatMap((alts) => alts.split("|"));
  const ops = state.renderOps.filter((o) => ids.includes(o.layerId));
  const views = ops.map((o) => o.view);
  const routes = Object.keys(state.routes).length;
  const viewOk =
    expect.view === undefined ||
    (expect.view === "route"
      ? routes > 0 || state.renderOps.some((o) => o.view === "route")
      : views.includes(expect.view) || (expect.view === "change" && state.compare !== undefined && ids.includes(state.compare.layerId)));
  const modes = ops.map((o) => o.mode);
  const modeOk = expect.mode === undefined || modes.includes(expect.mode);
  const ok = layers.every((l) => l.ok) && viewOk && modeOk;
  return { ok, layers, ...(expect.view ? { view: expect.view, views, viewOk } : {}), ...(expect.mode ? { mode: expect.mode, modes, modeOk } : {}), ...(expect.view === "route" ? { routes } : {}) };
}

/**
 * A coverage question that needs a layer under a documented outage (Layer.outage) and got no answer from it is skipped,
 * not passed and not failed: the reason, or undefined when the question counts. A layer that answered despite its
 * outage counts as usual (and the outage should be removed).
 */
/** The source failure an answer reports as offline (docs/layer-contract.md sourceStatus), or undefined. */
function offlineStatus(output: unknown): { message: string; since?: string } | undefined {
  const status = output && typeof output === "object" ? (output as { sourceStatus?: { ok?: boolean; reason?: string; message?: string; since?: string } }).sourceStatus : undefined;
  return status && status.ok === false && status.reason === "offline" ? { message: status.message ?? "offline", ...(status.since && { since: status.since }) } : undefined;
}

export function outageSkip(expect: CoverageExpect, calls: ToolCall[]): string | undefined {
  for (const alts of expect.layers) {
    const ids = alts.split("|");
    // Every alternative was asked and its answer says the source is offline (mining claims near Moab): skipped, not failed.
    const asked = calls.filter((c) => ids.some((id) => c.toolName === `query_${id}`));
    const offline = asked.map((c) => offlineStatus(c.output));
    if (asked.length > 0 && offline.every(Boolean) && !asked.some((c) => c.output !== undefined && !isLayerError(c.output) && !offlineStatus(c.output))) {
      return `source offline: ${offline.map((o) => o!.message + (o!.since ? ` since ${o!.since}` : "")).join(", ")}`;
    }
    const down = ids.map((id) => getLayer(id)).filter((l) => l?.outage !== undefined);
    if (down.length !== ids.length) continue;
    const answered = calls.some((c) => ids.some((id) => c.toolName === `query_${id}`) && c.output !== undefined && !isLayerError(c.output));
    if (!answered) return `documented outage: ${down.map((l) => `${l?.id} since ${l?.outage?.since}`).join(", ")}`;
  }
  return undefined;
}

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
  /** What the server's step guard did for the model (lib/agent/stepGuard.ts). */
  guard?: string[];
};

/** Runs one question through the real agent and collects every tool call (with its output, when it returned). */
async function runModel(raw: string): Promise<Run> {
  const started = Date.now();
  const { question, view } = splitView(raw);
  // The same turn setup as app/api/chat/route.ts: tools, system prompt with the view, and the step-guarded model.
  const { turn, ...agent } = agentTurn({ question, view });
  const result = await generateText({ ...agent, prompt: question });
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
    ...(turn.log.length > 0 && { guard: turn.log }),
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
  const expect = coverageFor(question);
  const coverage = expect ? coverageRule(expect, calls) : undefined;
  const usecase = usecaseFor(question);
  const usecaseResult = usecase ? usecaseRule(usecase, calls) : undefined;
  const rulesOk =
    brief &&
    (rule?.ok ?? true) &&
    (coverage?.ok ?? true) &&
    (usecaseResult?.ok ?? true) &&
    (wideView
      ? wideViewOk
      : routed && !queried
        ? noted
        : located && movedToPlace && queried && (drew ? rendered : answeredEmpty) && noted);
  // The map checks read the map the browser would end on.
  const state = mapAfter(calls);
  const checks = runMapChecks(state, { lookup: lookupLayer, place: questionPlace(calls, view, question) });
  const checksOk = checks.every((c) => c.ok);
  const ok = rulesOk && checksOk;
  const skipped = expect ? outageSkip(expect, calls) : usecase ? outageSkip(usecase, calls) : undefined;
  // The top 10 use cases' strict rule (scripts/top10Check.ts): every assertion of the question's expectation.
  const top10Expect = top10For(run.raw);
  const top10 = top10Expect ? top10Rule(top10Expect, { calls, text, state, question, hereView: (view?.bbox as BBox | undefined) ?? null }) : undefined;
  const okStrict = top10 ? ok && top10.ok : ok;

  return {
    ok: okStrict,
    state,
    checks,
    ...(skipped && { skipped }),
    line: {
      ...(top10Expect && { id: top10Expect.id }),
      question,
      ...(skipped && { skipped }),
      ...(view ? { view: view.bbox, geocoded: seq.includes("geocode"), movedCamera: moved } : {}),
      ...(wideView ? { zoomInErrors: zoomInLayers.length, zoomInPerLayer, askedToZoomIn, succeeded } : {}),
      noteWords,
      ...(dupHeadings.length > 0 ? { dupHeadings } : {}),
      ...(rule ? { rule, answer: answer.join("\n") } : {}),
      ...(coverage ? { coverage } : {}),
      ...(usecaseResult ? { usecase: usecaseResult } : {}),
      ...(top10 ? { top10: { ok: top10.ok, baseOk: ok, failed: top10.failed, passed: top10.assertions.filter((a) => a.ok).map((a) => a.id) } } : {}),
      model,
      ok: okStrict,
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
      ...(run.guard ? { guard: run.guard } : {}),
      textWords: wordCount(text),
      textStart: text.replace(/\s+/g, " ").slice(0, 120),
    },
  };
}

/**
 * The questions the screen checks open (scripts/evalScreens.ts), about a dozen covering lines (trails, mountain bike
 * facets, ski routes), points (crags, surf, dams, wildlife), hexes (wind capacity), areas (fire perimeters, glaciers in
 * the Wind Rivers and on Patagonia's ice, a monument), choropleths (county temperature, hardiness zones, drought), ranked
 * cards (uranium) and two layers at once (campsites and roads); each at desktop and phone size.
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
  // Ice under the outlines on satellite: the hardest ground for an area to show on.
  "Biggest glaciers in Patagonia",
  "How has Bears Ears changed since 2021?",
  "Which uranium mines near the Navajo Nation score highest?",
  // Choropleths (owner, 2026-10-18: too faint on satellite): the fill must read on Topo, Topo + Satellite and Satellite.
  "How much warmer than normal was Fresno County last month?",
  "Show plant hardiness zones in Vermont",
  "How dry is Colorado this week?",
  // Data stories (spec §13, §13a): a whole river network day by day, currents and wind as moving particles.
  "How has the Mississippi's flow changed over the last three months?",
  "Show the currents in Cook Inlet this week",
  "Where is the wind strongest over the Sierra tomorrow?",
  // Use-case screens (2026-10-23): roads by maintenance level, each level on Topo, Topo + Satellite and Satellite; and
  // boulders with a forecast point on the same map.
  "Forest roads a Subaru can drive near Leadville",
  "Bouldering near Bishop this weekend, will it be too hot?",
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

/** Run only as a script (node or tsx with this file), so tests can import the question data without calling the model. */
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const save = argValue(args, "--save");
  const replay = argValue(args, "--replay");
  const only = argValue(args, "--only")?.toLowerCase().split("|");
  const tag = argValue(args, "--tag");
  if (tag !== undefined && tag !== "coverage" && tag !== "usecase" && tag !== "top10") throw new Error(`Unknown --tag ${tag} ("coverage", "usecase" or "top10")`);
  const screens = args.includes("--screens");
  // Screens fill the disk (a dev server, Chromium, screenshots): not started short of space, stopped cleanly when low.
  let disk: DiskGuard | undefined;
  if (screens) {
    const free = freeBytes();
    if (free < START_MIN_FREE) {
      console.error(`Not running screens: ${sizeText(free)} free disk, under the ${sizeText(START_MIN_FREE)} they need.`);
      process.exit(1);
    }
    disk = watchDisk((left) => console.error(`eval: free disk is down to ${sizeText(left)}; stopping the run cleanly`));
  }
  if (args.includes("--set")) {
    // The top 10's golden questions live in their expectations file, not in docs/questions.md.
    const questions = (tag === "top10" ? TOP10.map((e) => e.question) : readEvalSet())
      .filter((q) => !only || only.some((o) => q.toLowerCase().includes(o)))
      .filter((q) => tag !== "coverage" || coverageFor(q) !== undefined)
      .filter((q) => tag !== "usecase" || usecaseFor(q) !== undefined);
    let passed = 0;
    let skipped = 0;
    const forScreens: { raw: string; slug: string; state: MapState; failures: string[] }[] = [];
    for (const q of questions) {
      if (disk?.low()) break;
      const outcome = await question(q, { save, replay });
      if (outcome.ok) passed += 1;
      else if (outcome.skipped) skipped += 1;
      console.log(JSON.stringify(outcome.line));
      if (screens && "state" in outcome && SCREEN_QUESTIONS.includes(q)) {
        forScreens.push({ raw: q, slug: slugOf(q), state: outcome.state, failures: outcome.checks.flatMap((c) => c.failures) });
      }
    }
    // A question skipped for a documented outage counts neither way.
    console.log(`ok ${passed}/${questions.length - skipped}${skipped > 0 ? ` (${skipped} skipped: documented outage)` : ""}`);
    if (screens) {
      const { runScreens } = await import("@/scripts/evalScreens");
      const screenResult = disk?.low() ? undefined : await runScreens(forScreens, { disk });
      if (screenResult) console.log(`screens ok ${screenResult.passed}/${screenResult.total} (contact sheet ${screenResult.sheet})`);
      if (!screenResult || screenResult.passed < screenResult.total) process.exitCode = 1;
      disk?.stop();
      console.log(`${disk?.low() ? "stopped: free disk under 2 GB; " : ""}${disk?.report()}`);
    }
    if (passed < questions.length - skipped) process.exitCode = 1;
  } else {
    const raw = args.filter((a, i) => !a.startsWith("--") && !["--save", "--replay", "--only", "--tag"].includes(args[i - 1])).join(" ") || "Show hiking trails around Lake Tahoe";
    const outcome = await question(raw, { save, replay });
    console.log(JSON.stringify(outcome.line));
    if (!outcome.ok && "error" in outcome.line) process.exitCode = 1;
  }
}
