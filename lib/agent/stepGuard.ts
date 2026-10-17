import type { LanguageModelMiddleware } from "ai";
import { getLayer } from "@/layers/registry";
import type { BBox } from "@/layers/types";
import { bboxAreaKm2 } from "@/layers/types";
import type { GeocodeResult } from "./geocode";
import { placeCandidates } from "./places";
import { normalizeRenderInput } from "./renderInput";
import { repairToolName } from "./toolNames";
import { inputKeyOf, undrawn, type Turn } from "./turn";

/**
 * The step guard: a language-model middleware that reads each step the model proposes before the SDK runs its tools,
 * and holds the turn to rules the prompt alone did not keep (the 16 failures of the 2026-10-16 eval):
 *  - tool names are canonical (`query_climbing<|channel|>commentary` → `query_climbing`) in the stream itself;
 *  - a query about a place the user named, with no geocode yet, gets the place looked up first: a geocode call is
 *    added to the step and the queries run on its box (a question that names no place and has no map view is about
 *    the queried layer's own region, Layer.place: sequoia groves are in the Sierra Nevada);
 *  - a second query of a layer on a smaller box inside one its wide strategy already answered is dropped, and the
 *    model is told to use the first result;
 *  - a step that would end the turn (a note, or text with no tool calls) while successful queries were never drawn
 *    gets a render call for each first, in the layer's default view.
 * A tool call the model wrote out as chat-template text becomes that call. Every change is logged on the turn (and
 * the server console).
 */

type Middleware = LanguageModelMiddleware;
type WrapGenerate = NonNullable<Middleware["wrapGenerate"]>;
type WrapStream = NonNullable<Middleware["wrapStream"]>;
type CallOptions = Parameters<WrapGenerate>[0]["params"];
type GenerateResult = Awaited<ReturnType<WrapGenerate>>;
type Content = GenerateResult["content"][number];
type StreamResult = Awaited<ReturnType<WrapStream>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;
type Model = Parameters<WrapGenerate>[0]["model"];

/** One tool call the model proposed, with its input parsed. */
export type DraftCall = { toolCallId: string; toolName: string; input: Record<string, unknown> };

/** What the guard decided for one step. */
export type Decision = {
  /** The calls to run, in order (the model's, renamed or rewritten, plus any the guard added). */
  calls: DraftCall[];
  /** True to drop the step's text (the turn goes on with renders, and the model writes its answer after them). */
  dropText: boolean;
  /** Calls dropped, with the reason the model is told when nothing else is left to run. */
  rejected: { call: DraftCall; reason: string }[];
  /** True when anything differs from what the model proposed. */
  changed: boolean;
};

let idCounter = 0;
function guardId(): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `call_guard_${Date.now().toString(36)}_${idCounter}`;
}

const QUERY = "query_";
const isQuery = (name: string) => name.startsWith(QUERY);
const layerOf = (name: string) => name.slice(QUERY.length);

function isBBox(value: unknown): value is BBox {
  return Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

/** True when `inner` lies inside `outer` (a small rounding margin allowed). */
function inside(inner: BBox, outer: BBox): boolean {
  const dx = (outer[2] - outer[0]) * 0.02;
  const dy = (outer[3] - outer[1]) * 0.02;
  return inner[0] >= outer[0] - dx && inner[1] >= outer[1] - dy && inner[2] <= outer[2] + dx && inner[3] <= outer[3] + dy;
}

function pointIn([lng, lat]: [number, number], [w, s, e, n]: BBox): boolean {
  return lng >= w && lng <= e && lat >= s && lat <= n;
}

/** A query's inputs with the layer's defaults filled in, as its tool will run them (so a left-out default compares equal). */
function withDefaults(layerId: string, input: Record<string, unknown>): Record<string, unknown> {
  const rest = Object.fromEntries(Object.entries(input).filter(([k]) => k !== "bbox" && k !== "zoom"));
  const parsed = getLayer(layerId)?.input.safeParse(rest);
  return parsed?.success ? (parsed.data as Record<string, unknown>) : rest;
}

/** Popularity layers and the layer whose features each one scores (and already contains). */
const POPULARITY_OF: Record<string, string> = { popularity: "osm-trails", "popularity-campsites": "campsites" };
/** A question about how popular or busy places are; "best" and "most visited" count. */
const ASKS_POPULAR = /\b(?:popular\w*|busiest|busy|crowd\w*|congest\w*|foot traffic|quiet\w*|best|most visited|least visited)\b/i;

/** Query calls that would locate the place themselves: physical-regions outlines a named region. */
const LOCATING_QUERIES = new Set(["query_physical-regions"]);

/**
 * The place the step's queries are about when the model did not geocode it: the place the step's own geocode call
 * names (its result was not back yet when the queries were written), else the place the question names (outside the
 * map view, when there is one), else the queried layer's own region when the question names none and there is no
 * view. Null when there is nothing to look up or the lookup finds nothing.
 */
async function placeForStep(calls: DraftCall[], turn: Turn): Promise<{ text: string; found: GeocodeResult; fromStep: boolean } | null> {
  const asked = calls.find((c) => c.toolName === "geocode" && typeof c.input.place === "string");
  if (asked) {
    const found = await turn.lookup(asked.input.place as string);
    return "error" in found ? null : { text: asked.input.place as string, found, fromStep: true };
  }
  const named = placeCandidates(turn.question);
  const homes = turn.view
    ? []
    : calls.flatMap((c) => (isQuery(c.toolName) ? [getLayer(layerOf(c.toolName))?.place] : [])).filter((p): p is string => typeof p === "string");
  for (const text of named.length > 0 ? named.slice(0, 2) : homes.slice(0, 1)) {
    const found = await turn.lookup(text);
    if ("error" in found) continue;
    // With a map view, only a place off the screen is looked up for the model: the view is otherwise what "here" means.
    if (turn.view?.bbox && pointIn(found.center, turn.view.bbox)) return null;
    return { text, found, fromStep: false };
  }
  return null;
}

/**
 * Tool calls the model wrote as text in its chat template instead of calling them, which the provider then passed on
 * as the answer ("<|start|>assistant<|channel|>commentary to=functions.geocode <|constrain|>={"place":"Navajo
 * Nation"}<|call|>"), parsed back into calls; empty when the text holds none.
 */
export function leakedCalls(text: string): { toolName: string; input: Record<string, unknown> }[] {
  if (!text.includes("to=functions.")) return [];
  const out: { toolName: string; input: Record<string, unknown> }[] = [];
  for (const segment of text.split("<|call|>")) {
    const m = /to=functions\.([\w-]+)[\s\S]*?(\{[\s\S]*\})\s*$/.exec(segment.replace(/<\|(?:end|return)\|>\s*$/, "").trim());
    if (!m) continue;
    try {
      const input: unknown = JSON.parse(m[2]);
      if (typeof input === "object" && input !== null && !Array.isArray(input)) out.push({ toolName: m[1], input: input as Record<string, unknown> });
    } catch {
      // Not a whole JSON object: leave the text as it is.
    }
  }
  return out;
}

/** The guard's rules on one proposed step. Pure apart from place lookups (shared with the geocode tool through `turn`). */
export async function decideStep(draft: { calls: DraftCall[]; hasText: boolean; text?: string }, turn: Turn, toolNames: readonly string[]): Promise<Decision> {
  let changed = false;
  // 0. Tool calls written out as chat-template text become the calls they are.
  const leaked = draft.calls.length === 0 && draft.text ? leakedCalls(draft.text) : [];
  let leakedText = false;
  if (leaked.length > 0) {
    draft = { ...draft, calls: leaked.map((c) => ({ toolCallId: guardId(), ...c })), hasText: false };
    leakedText = true;
    changed = true;
    turn.note(`tool call${leaked.length > 1 ? "s" : ""} written as text turned into ${leaked.map((c) => c.toolName).join(", ")}`);
  }
  // 1. Canonical tool names.
  let calls = draft.calls.map((c) => {
    const name = repairToolName(c.toolName, toolNames) ?? c.toolName;
    if (name === c.toolName) return c;
    changed = true;
    turn.note(`tool name ${JSON.stringify(c.toolName)} sent as ${name}`);
    return { ...c, toolName: name };
  });

  // 2. A smaller box inside one a wide strategy already answered for the same layer and inputs: drop it.
  const rejected: Decision["rejected"] = [];
  calls = calls.filter((c) => {
    if (!isQuery(c.toolName) || !isBBox(c.input.bbox)) return true;
    const layerId = layerOf(c.toolName);
    const box = c.input.bbox;
    const key = inputKeyOf(withDefaults(layerId, c.input));
    const earlier = turn.queries.find((q) => q.layerId === layerId && q.ok && q.wide && q.inputKey === key && inside(box, q.bbox));
    if (!earlier || bboxAreaKm2(box) >= bboxAreaKm2(earlier.bbox) * 0.9) return true;
    const reason =
      `Not queried: ${layerId} already answered the whole area [${earlier.bbox.join(", ")}] with its wide strategy (the largest or named features over all of it). ` +
      "Use that first result: render it if you have not, then write the note; do not query a smaller box inside it.";
    rejected.push({ call: c, reason });
    turn.note(`${layerId}: a second query on a smaller box inside its wide answer was dropped`);
    changed = true;
    return false;
  });

  // 2b. One line per way: popularity is a colouring of the trails (or campsites) it scores, so it is only added when
  // the question asks how popular, and once it has answered, the plain layer is not queried on top of it.
  const asksPopular = ASKS_POPULAR.test(turn.question);
  calls = calls.filter((c) => {
    if (!isQuery(c.toolName)) return true;
    const layerId = layerOf(c.toolName);
    let reason: string | null = null;
    if (POPULARITY_OF[layerId] && !asksPopular) {
      reason =
        `Not queried: the question does not ask how popular or busy, and ${layerId} would draw a second line over every ${POPULARITY_OF[layerId]} feature. ` +
        `Answer from ${POPULARITY_OF[layerId]}.`;
    }
    const scoredBy = Object.keys(POPULARITY_OF).find((p) => POPULARITY_OF[p] === layerId && turn.queries.some((q) => q.layerId === p && q.ok && q.drawable));
    if (scoredBy) reason = `Not queried: ${scoredBy} already holds every ${layerId} feature it scores; render ${scoredBy} instead of drawing ${layerId} over it.`;
    if (!reason) return true;
    rejected.push({ call: c, reason });
    turn.note(`${layerId}: dropped so trails or campsites are not drawn twice (${scoredBy ? `${scoredBy} already answered` : "popularity not asked"})`);
    changed = true;
    return false;
  });

  // 3. Queries with no place looked up: look it up, add the geocode, and run the queries on its box.
  const queries = calls.filter((c) => isQuery(c.toolName));
  const located = turn.place !== null || turn.regionQueried || calls.some((c) => LOCATING_QUERIES.has(c.toolName));
  if (queries.length > 0 && !located) {
    const place = await placeForStep(calls, turn);
    if (place) {
      if (!place.fromStep) {
        calls = [{ toolCallId: guardId(), toolName: "geocode", input: { place: place.text } }, ...calls];
        turn.note(`looked up "${place.text}" before ${queries.map((q) => q.toolName).join(", ")}: the model queried without locating it`);
      }
      const bbox = place.found.bbox;
      calls = calls.map((c) => (isQuery(c.toolName) && !LOCATING_QUERIES.has(c.toolName) ? { ...c, input: { ...c.input, bbox } } : c));
      // The place is known for this step's queries even before the geocode tool records it.
      turn.place ??= place.found;
      if (!turn.places.includes(place.found)) turn.places.push(place.found);
      changed = true;
    }
  }

  // 4. Ending the turn with queries never drawn: render them first, in the layer's default view.
  const hasNote = calls.some((c) => c.toolName === "note");
  // A step whose calls were all dropped is asked again, not ended.
  const ending = hasNote || (calls.length === 0 && rejected.length === 0);
  let dropText = false;
  if (ending) {
    const drawnHere = new Set(calls.flatMap((c) => (c.toolName === "render" || c.toolName === "compare") && typeof c.input.layerId === "string" ? [c.input.layerId] : []));
    const pending = undrawn(turn).filter((id) => !drawnHere.has(id));
    if (pending.length > 0) {
      const renders = pending.map((layerId): DraftCall => ({
        toolCallId: guardId(),
        toolName: "render",
        input: normalizeRenderInput({ layerId }, getLayer(layerId), turn.question),
      }));
      const at = calls.findIndex((c) => c.toolName === "note");
      calls = at === -1 ? renders : [...calls.slice(0, at), ...renders, ...calls.slice(at)];
      // A text-only ending is written again after the renders, from the drawn map.
      dropText = !hasNote && draft.hasText;
      turn.note(`rendered ${pending.join(", ")} before the ${hasNote ? "note" : "answer"}: queried but never drawn`);
      changed = true;
    }
  }
  return { calls, dropText: dropText || leakedText, rejected, changed };
}

function parseInput(input: unknown): Record<string, unknown> | null {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(input === "" ? "{}" : input);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type ToolCallLike = { type: "tool-call"; toolCallId: string; toolName: string; input: string; providerExecuted?: boolean };

/** The step's tool calls as drafts, or null when one cannot be read (left to the SDK as it is). */
function draftCalls(parts: readonly { type: string }[]): DraftCall[] | null {
  const calls: DraftCall[] = [];
  for (const part of parts) {
    if (part.type !== "tool-call") continue;
    const call = part as ToolCallLike;
    if (call.providerExecuted) return null;
    const input = parseInput(call.input);
    if (!input) return null;
    calls.push({ toolCallId: call.toolCallId, toolName: call.toolName, input });
  }
  return calls;
}

const toPart = (c: DraftCall): ToolCallLike => ({ type: "tool-call", toolCallId: c.toolCallId, toolName: c.toolName, input: JSON.stringify(c.input) });

/** The prompt with the dropped calls and why, so the model answers from what it has. */
function reaskParams(params: CallOptions, rejected: Decision["rejected"]): CallOptions {
  return {
    ...params,
    prompt: [
      ...params.prompt,
      { role: "assistant", content: rejected.map(({ call }) => ({ type: "tool-call" as const, toolCallId: call.toolCallId, toolName: call.toolName, input: call.input })) },
      {
        role: "tool",
        content: rejected.map(({ call, reason }) => ({ type: "tool-result" as const, toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text" as const, value: reason } })),
      },
    ],
  };
}

/** Most times one step is asked again after all its calls were dropped. */
const MAX_REASKS = 1;

const finishFor = (calls: DraftCall[], reason: { unified: string; raw: string | undefined }) =>
  calls.length > 0 ? { unified: "tool-calls" as const, raw: reason.raw } : reason;

/** The guard as middleware for one turn; `toolNames` are the turn's tools, for name repair. */
export function stepGuard(turn: Turn, toolNames: readonly string[]): Middleware {
  const rename = (name: string) => repairToolName(name, toolNames) ?? name;

  async function guardGenerate(model: Model, params: CallOptions, first: GenerateResult): Promise<GenerateResult> {
    let result = first;
    for (let attempt = 0; ; attempt++) {
      const calls = draftCalls(result.content);
      if (!calls) return result;
      const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      const decision = await decideStep({ calls, hasText: text.trim() !== "", text }, turn, toolNames);
      if (decision.rejected.length > 0 && decision.calls.length === 0 && attempt < MAX_REASKS) {
        result = await model.doGenerate(reaskParams(params, decision.rejected));
        continue;
      }
      if (!decision.changed) return result;
      const kept = result.content.filter((c) => c.type !== "tool-call" && !(decision.dropText && c.type === "text"));
      return {
        ...result,
        content: [...kept, ...decision.calls.map((c) => toPart(c) as Content)],
        finishReason: finishFor(decision.calls, result.finishReason) as GenerateResult["finishReason"],
      };
    }
  }

  async function collect(stream: ReadableStream<StreamPart>): Promise<StreamPart[]> {
    const parts: StreamPart[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return parts;
      parts.push(value);
    }
  }

  function streamOf(parts: StreamPart[]): ReadableStream<StreamPart> {
    return new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
  }

  /** Renames tool calls as they stream, for steps the guard has no other reason to hold. */
  function renaming(): TransformStream<StreamPart, StreamPart> {
    return new TransformStream({
      transform(part, controller) {
        if ((part.type === "tool-call" || part.type === "tool-input-start") && "toolName" in part) {
          const name = rename(part.toolName);
          controller.enqueue(name === part.toolName ? part : ({ ...part, toolName: name } as StreamPart));
          return;
        }
        controller.enqueue(part);
      },
    });
  }

  async function guardStream(model: Model, params: CallOptions, first: StreamResult): Promise<StreamResult> {
    let result = first;
    let parts = await collect(result.stream);
    for (let attempt = 0; ; attempt++) {
      if (parts.some((p) => p.type === "error")) return { ...result, stream: streamOf(parts).pipeThrough(renaming()) };
      const calls = draftCalls(parts);
      if (!calls) return { ...result, stream: streamOf(parts).pipeThrough(renaming()) };
      const text = parts.map((p) => (p.type === "text-delta" ? p.delta : "")).join("");
      const decision = await decideStep({ calls, hasText: text.trim() !== "", text }, turn, toolNames);
      if (decision.rejected.length > 0 && decision.calls.length === 0 && attempt < MAX_REASKS) {
        result = await model.doStream(reaskParams(params, decision.rejected));
        parts = await collect(result.stream);
        continue;
      }
      if (!decision.changed) return { ...result, stream: streamOf(parts) };
      const isText = (p: StreamPart) => p.type === "text-start" || p.type === "text-delta" || p.type === "text-end";
      const isToolInput = (p: StreamPart) => p.type === "tool-input-start" || p.type === "tool-input-delta" || p.type === "tool-input-end" || p.type === "tool-call";
      const kept = parts.filter((p) => p.type !== "finish" && !isToolInput(p) && !(decision.dropText && isText(p)));
      const finish = parts.find((p): p is Extract<StreamPart, { type: "finish" }> => p.type === "finish");
      const out: StreamPart[] = [...kept, ...decision.calls.map((c) => toPart(c) as StreamPart)];
      if (finish) out.push({ ...finish, finishReason: finishFor(decision.calls, finish.finishReason) } as StreamPart);
      return { ...result, stream: streamOf(out) };
    }
  }

  return {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate, params, model }) => guardGenerate(model, params, await doGenerate()),
    // Every step is read whole before it streams on: a step that looks harmless can still be a tool call written
    // as text, and the answer itself arrives whole in the note.
    wrapStream: async ({ doStream, params, model }) => guardStream(model, params, await doStream()),
  };
}
