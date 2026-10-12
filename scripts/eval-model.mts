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
 * geocode moves it by itself (lib/agent/applyToolResult.ts), and so does set_view.
 * An `@view` question whose view is too wide for a layer (a zoom_in error) must still answer at that scale: it passes
 * only when the model did not move the camera (set_view or a successful geocode), got at most one zoom_in error per layer (no shrinking and retrying), and
 * at least one query succeeded and was drawn and rendered (the error's widerScale layers). A reply that only asks the
 * user to zoom in is a refusal and fails.
 * Every question also fails when a note (or, with no note, the closing text) runs over NOTE_MAX_WORDS words or a heading appears twice across the notes
 * and the closing text (the note is the answer; the text after it is only follow-ups).
 * Some questions carry their own extra rule (QUESTION_RULES), matched on the question in lower case.
 */
import { readFileSync } from "node:fs";
import { generateText, stepCountIs } from "ai";
import "@/layers";
import { getLayer } from "@/layers/registry";
import { getModel } from "@/lib/agent/provider";
import { isFullLayerResult, summarizeLayerResult, type GeojsonSummary } from "@/lib/layers/summarize";
import { buildTools } from "@/lib/agent/tools";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";
import type { MapView } from "@/lib/agent/view";
import { parseMapView, systemForTurn } from "@/lib/agent/viewContext";


const model = process.env.MODEL_NAME ?? "(unset)";

/** Longest note that passes: the prompt asks for about 120 words. */
const NOTE_MAX_WORDS = 150;

type ToolCall = { toolName: string; output?: unknown };

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

/** Extra pass rules for particular questions, keyed by the question in lower case. */
const QUESTION_RULES: Record<string, (calls: ToolCall[], notes: string[]) => RuleResult> = {
  "good hiking in french guiana": goodHikingRule,
  "glaciers in the wind river range": windRiverGlaciersRule,
};

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

async function runQuestion(raw: string): Promise<Outcome> {
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 100) / 10;
  const { question, view } = splitView(raw);
  try {
    const result = await generateText({
      model: getModel(),
      system: systemForTurn(SYSTEM_PROMPT, view),
      tools: buildTools({ view }),
      prompt: question,
      stopWhen: stepCountIs(12),
    });

    const calls: ToolCall[] = [];
    for (const step of result.steps) {
      for (const r of step.toolResults) calls.push({ toolName: r.toolName, output: r.output });
      for (const c of step.toolCalls) {
        if (!step.toolResults.some((r) => r.toolCallId === c.toolCallId)) calls.push({ toolName: c.toolName });
      }
    }
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
    const noted = seq.includes("note") || result.text.trim().length > 40;
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
    const reply = [...calls.filter((c) => c.toolName === "note").map((c) => noteText(c.output)), result.text].join(" ");
    const askedToZoomIn = /zoom(?:ing)? in|zoom closer|closer view|smaller area/i.test(reply);
    // Also a model that read the layer's km² limit and asked without querying at all.
    const wideView = view !== null && (zoomInLayers.length > 0 || (!queried && askedToZoomIn));
    // Answering at this scale: some query came back without an error, and what it drew was rendered.
    const succeeded = queryCalls.filter((c) => c.output !== undefined && !isLayerError(c.output)).length;
    const wideViewOk = !moved && zoomInPerLayer <= 1 && succeeded >= 1 && drew && rendered;
    // Brevity: the note is the answer, and nothing is said twice.
    const notes = calls.filter((c) => c.toolName === "note").map((c) => noteText(c.output));
    // With no note, the closing text is the answer and is held to the same length.
    const noteWords = (notes.length > 0 ? notes : [result.text]).map(wordCount);
    const dupHeadings = duplicatedHeadings([...notes, result.text]);
    const brief = noteWords.every((n) => n <= NOTE_MAX_WORDS) && dupHeadings.length === 0;
    // With no note, the closing text is the answer, as for noteWords.
    const answer = notes.length > 0 ? notes : [result.text];
    const rule = QUESTION_RULES[question.trim().toLowerCase()]?.(calls, answer);
    const ok =
      brief &&
      (rule?.ok ?? true) &&
      (wideView
        ? wideViewOk
        : routed && !queried
          ? noted
          : located && movedToPlace && queried && (drew ? rendered : answeredEmpty) && noted);

    return {
      ok,
      line: {
        question,
        ...(view ? { view: view.bbox, geocoded: seq.includes("geocode"), movedCamera: moved } : {}),
        ...(wideView ? { zoomInErrors: zoomInLayers.length, zoomInPerLayer, askedToZoomIn, succeeded } : {}),
        noteWords,
        ...(dupHeadings.length > 0 ? { dupHeadings } : {}),
        ...(rule ? { rule, answer: answer.join("\n") } : {}),
        model,
        ok,
        seq,
        features,
        tiles,
        layerErrors,
        tokens: { in: result.totalUsage.inputTokens, out: result.totalUsage.outputTokens },
        seconds: seconds(),
        finish: result.finishReason,
        textWords: wordCount(result.text),
        textStart: result.text.replace(/\s+/g, " ").slice(0, 120),
      },
    };
  } catch (err) {
    return {
      ok: false,
      line: { question: raw, model, ok: false, error: err instanceof Error ? err.message.slice(0, 200) : String(err), seconds: seconds() },
    };
  }
}

const args = process.argv.slice(2);
if (args.includes("--set")) {
  const questions = readEvalSet();
  let passed = 0;
  for (const q of questions) {
    const { ok, line } = await runQuestion(q);
    if (ok) passed += 1;
    console.log(JSON.stringify(line));
  }
  console.log(`ok ${passed}/${questions.length}`);
  if (passed < questions.length) process.exitCode = 1;
} else {
  const question = args.join(" ") || "Show hiking trails around Lake Tahoe";
  const { ok, line } = await runQuestion(question);
  console.log(JSON.stringify(line));
  if (!ok && "error" in line) process.exitCode = 1;
}
