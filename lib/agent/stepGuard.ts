import type { LanguageModelMiddleware } from "ai";
import { getLayer } from "@/layers/registry";
import type { BBox } from "@/layers/types";
import { bboxAreaKm2, hardMaxAreaKm2 } from "@/layers/types";
import type { GeocodeResult } from "./geocode";
import { placeCandidates } from "./places";
import { NOTE_MAX_WORDS, noteWords, trimNote } from "./noteCheck";
import { followUpList } from "./compose";
import { extractFollowUps } from "./followups";
import { followUpsForTurn } from "./turnAnswer";
import { ANSWERS_FOR, applyReading, readingInputs } from "./readingGuard";
import { asksChange, normalizeRenderInput } from "./renderInput";
import { canonicalLayerId, repairToolName } from "./toolNames";
import { widerScaleFor, widerScaleHints } from "./tools";
import { inputKeyOf, MAX_STEPS, undrawn, type Turn } from "./turn";

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
  /** The step's text in place of the model's: the follow-up questions after the note. */
  text?: string;
  /** Text after the step's calls: the follow-ups when the note is on the last step and no step is left for them. */
  trailingText?: string;
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

/** The date a query asked for (`date`, or `year` as its January 1), as YYYY-MM-DD, from its input key; null without one. */
export function dateOfInput(inputKey: string): string | null {
  try {
    const entries = JSON.parse(inputKey) as [string, unknown][];
    const get = (k: string) => entries.find(([key]) => key === k)?.[1];
    const date = get("date");
    if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}/.test(date)) return date.slice(0, 10);
    const year = get("year");
    if (typeof year === "number" && Number.isInteger(year)) return `${year}-01-01`;
    return null;
  } catch {
    return null;
  }
}

/** Most place lookups (geocode calls) in one turn. */
export const MAX_GEOCODES = 4;

/** Most queries of one layer in one turn: a third look is enough to answer or to say the layer cannot. */
export const MAX_QUERIES_PER_LAYER = 3;

/**
 * Why a query would only spend a step asking again, or null when it asks something new: a part of a box the layer
 * already said was over its limit, a box inside one it already answered with the same inputs (in an earlier step or
 * this one), a layer that failed twice or was asked MAX_QUERIES_PER_LAYER times, or any query in the last two steps
 * before a note.
 */
export function repeatReason(c: DraftCall, turn: Turn, askedHere: DraftCall[], finalSteps: boolean): { why: string; text: string; instead?: DraftCall } | null {
  const layerId = layerOf(c.toolName);
  if (finalSteps) {
    return {
      why: "two steps left and no note yet",
      text: "Not queried: two steps are left in this turn. Render what has answered (if it is not drawn yet) and write the note now from those results.",
    };
  }
  const box = isBBox(c.input.bbox) ? c.input.bbox : null;
  const mine = turn.queries.filter((q) => q.layerId === layerId);
  const tooWide = box ? mine.find((q) => q.zoomIn && (inside(box, q.bbox) || overlapShare(box, q.bbox) > 0.5)) : undefined;
  if (tooWide) {
    const wider = widerScaleFor(layerId, tooWide.bbox);
    // The first wider-scale layer not asked yet answers the whole place instead (species over Colorado: GBIF density).
    const hint = widerScaleHints(layerId, tooWide.bbox).find(
      (h) => !turn.queries.some((q) => q.layerId === h.layerId) && !askedHere.some((d) => d.toolName === `${QUERY}${h.layerId}`),
    );
    const instead: DraftCall | undefined = hint && { toolCallId: guardId(), toolName: `${QUERY}${hint.layerId}`, input: { ...(hint.input ?? {}), bbox: tooWide.bbox } };
    return {
      ...(instead && { instead }),
      why: "a part of a box that was over its limit",
      text:
        `Not queried: ${layerId} already said [${tooWide.bbox.join(", ")}] is over its area limit, and a smaller box inside it would answer only part of the place asked about. ` +
        (wider.length > 0 ? `Answer at this scale with ${wider.join(" or ")}, or say` : "Say") +
        ` in the note that ${layerId} needs a smaller area. Do not query ${layerId} again.`,
    };
  }
  const key = inputKeyOf(withDefaults(layerId, c.input));
  const same = box
    ? [...mine.filter((q) => q.ok).map((q) => ({ bbox: q.bbox, key: q.inputKey })), ...askedHere.filter((d) => d.toolName === c.toolName && isBBox(d.input.bbox)).map((d) => ({ bbox: d.input.bbox as BBox, key: inputKeyOf(withDefaults(layerId, d.input)) }))].find(
        (q) => q.key === key && inside(box, q.bbox),
      )
    : undefined;
  if (same) {
    return {
      why: "the same inputs on a box it already answered",
      text: `Not queried: ${layerId} already answered [${same.bbox.join(", ")}] with these inputs, which holds this box. Use that result: render it if you have not, then write the note.`,
    };
  }
  const failed = mine.filter((q) => !q.ok && !q.zoomIn).length;
  if (failed >= 2) {
    return { why: "failed twice", text: `Not queried: ${layerId} failed twice this turn. Say in the note that it is unavailable right now, and answer from the rest.` };
  }
  if (mine.length + askedHere.filter((d) => d.toolName === c.toolName).length >= MAX_QUERIES_PER_LAYER) {
    return {
      why: `asked ${MAX_QUERIES_PER_LAYER} times`,
      text: `Not queried: ${layerId} was asked ${MAX_QUERIES_PER_LAYER} times this turn. Answer from what came back: render it and write the note.`,
    };
  }
  return null;
}

/** The share of `a`'s area that lies inside `b`. */
function overlapShare(a: BBox, b: BBox): number {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const area = (a[2] - a[0]) * (a[3] - a[1]);
  return area > 0 ? (w * h) / area : 0;
}

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
  if (!text.includes("to=functions.")) {
    // The note's input written as the answer ('{ "markdown": "Map shows…" }', fly fishing near Asheville, 2026-10-23).
    const note = leadingObject(text);
    return note && typeof note.markdown === "string" && note.markdown.trim() !== "" ? [{ toolName: "note", input: { markdown: note.markdown } }] : [];
  }
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

/** The JSON object a text opens with, when it opens with one; null otherwise. */
function leadingObject(text: string): Record<string, unknown> | null {
  const t = text.trimStart();
  if (!t.startsWith("{")) return null;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        const value: unknown = JSON.parse(t.slice(0, i + 1));
        return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    }
  }
  return null;
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
  // 0b. After the note, the reply is only the follow-ups: exactly three, at least two naming what this answer found
  // (the model's own that do, then the answer template's). Anything else the model wrote repeats the note.
  if (turn.noted && draft.calls.length === 0) {
    const followUps = followUpsForTurn(turn, [...turn.modelFollowUps, ...extractFollowUps(draft.text ?? "").followUps]);
    const text = followUpList(followUps);
    if (text !== (draft.text ?? "").trim()) turn.note("the reply after the note is its three follow-ups, naming what the answer found");
    return { calls: [], dropText: false, rejected: [], changed: text !== (draft.text ?? ""), text };
  }
  // 1. Canonical tool names, and canonical layer ids in render and compare ("query_peaks" is peaks).
  const layerIds = toolNames.filter(isQuery).map(layerOf);
  let calls = draft.calls.map((c) => {
    const name = repairToolName(c.toolName, toolNames) ?? c.toolName;
    let call = c;
    if (name !== c.toolName) {
      changed = true;
      turn.note(`tool name ${JSON.stringify(c.toolName)} sent as ${name}`);
      call = { ...call, toolName: name };
    }
    if ((name === "render" || name === "compare") && typeof call.input.layerId === "string") {
      const layerId = canonicalLayerId(call.input.layerId, layerIds);
      if (layerId !== call.input.layerId) {
        changed = true;
        turn.note(`${name} layerId ${JSON.stringify(call.input.layerId)} sent as ${layerId}`);
        call = { ...call, input: { ...call.input, layerId } };
      }
    }
    return call;
  });

  // 1b. The question's reading (lib/agent/readingGuard.ts): river names, time and phrase inputs, layers the words rule
  // out or name, and renders of layers never queried. Queries it adds answer before the note, so a note in the same
  // step waits for them.
  const rejected: Decision["rejected"] = [];
  const read = applyReading(calls, turn, turn.step >= MAX_STEPS - 2 && !turn.noted);
  rejected.push(...read.rejected);
  let deferred = false;
  if (read.changed) {
    changed = true;
    const before = new Set(calls.map((c) => c.toolCallId));
    calls = read.calls;
    if (calls.some((c) => !before.has(c.toolCallId) && isQuery(c.toolName)) && calls.some((c) => c.toolName === "note")) {
      calls = calls.filter((c) => c.toolName !== "note");
      deferred = true;
      turn.note("note held back: the question's layers are queried first");
    }
  }

  // 1c. Ending before asking the layers the question's words name (Boulder's soils: "there is no soil layer", and the
  // turn stopped): they are asked first, on the place's box, and the answer waits for them. Once per layer.
  const endingEarly = !turn.noted && turn.step < MAX_STEPS - 2 && (calls.some((c) => c.toolName === "note") || (calls.length === 0 && rejected.length === 0 && draft.hasText));
  if (endingEarly) {
    const box = turn.place?.bbox ?? turn.view?.bbox ?? null;
    const missing = turn.reading.layers.filter(
      (l) =>
        l.strong &&
        getLayer(l.layerId) &&
        !turn.readingAdded.has(l.layerId) &&
        !turn.queries.some((q) => [l.layerId, ...(ANSWERS_FOR[l.layerId] ?? [])].includes(q.layerId)) &&
        !calls.some((c) => c.toolName === `${QUERY}${l.layerId}`) &&
        (box === null || bboxAreaKm2(box) <= hardMaxAreaKm2(getLayer(l.layerId)!)),
    );
    if (missing.length > 0) {
      const at = turn.place?.center ?? turn.view?.center ?? null;
      const added = missing.map((l): DraftCall => {
        turn.readingAdded.add(l.layerId);
        return { toolCallId: guardId(), toolName: `${QUERY}${l.layerId}`, input: { ...readingInputs(turn.reading, l.layerId, turn.now, at), ...(box && { bbox: box }) } };
      });
      calls = [...calls.filter((c) => c.toolName !== "note"), ...added];
      deferred = true;
      changed = true;
      turn.note(`queried ${missing.map((l) => l.layerId).join(", ")} before the answer: the question's words name ${missing.length > 1 ? "them" : "it"} (${missing[0].because})`);
    }
  }

  // 2. A smaller box inside one a wide strategy already answered for the same layer and inputs: drop it.
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

  // 2a. No asking again: a layer is not queried on a part of a box it could not answer (zoom_in), on a box inside one
  // it already answered with the same inputs, after failing twice, or more than MAX_QUERIES_PER_LAYER times; and with
  // two steps left and no note, nothing is queried at all. The steps go to drawing and the note instead.
  const finalSteps = turn.step >= MAX_STEPS - 2 && !turn.noted;
  const askedHere: DraftCall[] = [];
  const replaced: DraftCall[] = [];
  calls = calls.filter((c) => {
    if (!isQuery(c.toolName)) return true;
    const reason = repeatReason(c, turn, askedHere, finalSteps);
    if (reason === null) {
      askedHere.push(c);
      return true;
    }
    if (reason.instead) {
      // Answer the whole place at this scale instead of a part of it.
      replaced.push(reason.instead);
      askedHere.push(reason.instead);
      turn.note(`${layerOf(c.toolName)}: a part of a box over its limit was asked; ${reason.instead.toolName} answers the whole box instead`);
      changed = true;
      return false;
    }
    rejected.push({ call: c, reason: reason.text });
    turn.note(`${layerOf(c.toolName)}: query dropped (${reason.why})`);
    changed = true;
    return false;
  });
  calls = [...calls, ...replaced];

  // 2c. Four place lookups are enough: Table Mountain was looked up seven times (streets, a country, a city) and the
  // turn ran out of steps before the rock was asked.
  let lookups = turn.geocodes;
  calls = calls.filter((c) => {
    if (c.toolName !== "geocode") return true;
    if (lookups < MAX_GEOCODES) {
      lookups += 1;
      return true;
    }
    rejected.push({
      call: c,
      reason: `Not looked up: ${MAX_GEOCODES} place lookups were made this turn. Use the best one you have (or a feature's coordinates from a query result, such as a peak's point) and go on.`,
    });
    turn.note(`geocode "${String(c.input.place)}" dropped: ${MAX_GEOCODES} lookups already`);
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

  // 2d. A compare of a layer never queried (the greenness turn compared without asking for either month): its two
  // dates are queried first, on the place's box, then the compare runs.
  const placeBox = turn.place?.bbox ?? turn.view?.bbox ?? null;
  if (placeBox) {
    const queriedHere = new Set(calls.filter((c) => isQuery(c.toolName)).map((c) => layerOf(c.toolName)));
    const added: DraftCall[] = [];
    for (const c of calls) {
      if (c.toolName !== "compare" || typeof c.input.layerId !== "string") continue;
      const layerId = c.input.layerId;
      const layer = getLayer(layerId);
      if (!layer || turn.queries.some((q) => q.layerId === layerId && q.ok) || queriedHere.has(layerId)) continue;
      const dated = "date" in ((layer.input as { shape?: Record<string, unknown> }).shape ?? {});
      const windows = [c.input.a, c.input.b].filter((w): w is [string, string] => Array.isArray(w) && typeof w[0] === "string");
      const inputs = dated && windows.length === 2 ? windows.map((w) => ({ date: w[0].slice(0, 10) })) : [{}];
      for (const input of inputs) added.push({ toolCallId: guardId(), toolName: `${QUERY}${layerId}`, input: { ...input, bbox: placeBox } });
      queriedHere.add(layerId);
    }
    if (added.length > 0) {
      // The compare waits for the next step, once the queries have answered.
      calls = [...added, ...calls.filter((c) => c.toolName !== "compare" && c.toolName !== "note")];
      turn.note(`queried ${added.map((c) => c.toolName).join(", ")} before comparing: the layer was never queried`);
      changed = true;
      return { calls, dropText: true, rejected, changed };
    }
  }

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

  // 3b. Ending with nothing drawn after a layer said the place is over its limit: its first wider-scale layer answers the
  // whole place first, and the model writes its answer from that (brown bears over Alaska: GBIF density, not "zoom in").
  const endingEmpty = (calls.some((c) => c.toolName === "note") || (calls.length === 0 && rejected.length === 0)) && !turn.queries.some((q) => q.ok && q.drawable);
  if (endingEmpty && !turn.noted) {
    for (const q of turn.queries.filter((r) => r.zoomIn)) {
      const hint = widerScaleHints(q.layerId, q.bbox).find((h) => !turn.queries.some((r) => r.layerId === h.layerId));
      if (!hint) continue;
      calls = [{ toolCallId: guardId(), toolName: `${QUERY}${hint.layerId}`, input: { ...(hint.input ?? {}), bbox: q.bbox } }];
      turn.note(`${q.layerId} was over its limit and nothing was drawn: ${QUERY}${hint.layerId} answers the whole box before the answer`);
      return { calls, dropText: true, rejected, changed: true };
    }
  }

  // 4a. A question about change ("less sea ice than in 2012", "before and after") whose layer answered for two dates
  // and was never compared: the compare goes in before the turn ends, older date as A, newer as B.
  const endingNow = calls.some((c) => c.toolName === "note") || (calls.length === 0 && rejected.length === 0);
  if (endingNow && asksChange(turn.question)) {
    const comparing = new Set(calls.flatMap((c) => (c.toolName === "compare" && typeof c.input.layerId === "string" ? [c.input.layerId] : [])));
    const compares: DraftCall[] = [];
    for (const layerId of [...new Set(turn.queries.filter((q) => q.ok && q.drawable).map((q) => q.layerId))]) {
      if (turn.compared.has(layerId) || comparing.has(layerId)) continue;
      const dates = [...new Set(turn.queries.filter((q) => q.layerId === layerId && q.ok && q.drawable).map((q) => dateOfInput(q.inputKey)).filter((d): d is string => d !== null))].sort();
      if (dates.length < 2) continue;
      const [a, b] = [dates[0], dates[dates.length - 1]];
      compares.push({ toolCallId: guardId(), toolName: "compare", input: { layerId, a: [a, a], b: [b, b], mode: "swipe", aLabel: a.slice(0, 7), bLabel: b.slice(0, 7) } });
      turn.drawn.add(layerId);
    }
    if (compares.length > 0) {
      const at = calls.findIndex((c) => c.toolName === "note");
      calls = at === -1 ? compares : [...calls.slice(0, at), ...compares, ...calls.slice(at)];
      turn.note(`compared ${compares.map((c) => c.input.layerId).join(", ")} between its two dates: the question asks what changed`);
      changed = true;
    }
  }

  // 3c. A question that relates two layers ("outside protected areas", "in drought") ends with the combine tool's join,
  // not two layers to compare by eye: a note before it is held back once, naming the layers to join.
  if (calls.some((c) => c.toolName === "combine")) turn.readingAdded.add("combine");
  const joinAsk = turn.reading.combine;
  // An answer written as plain text, with no note, is held back the same way (wild horses in drought, 2026-10-23 full run).
  const textEnding = calls.length === 0 && rejected.length === 0 && draft.hasText && !turn.noted;
  if (joinAsk && toolNames.includes("combine") && !turn.readingAdded.has("combine") && (calls.some((c) => c.toolName === "note") || textEnding)) {
    const answered = [...new Set(turn.queries.filter((q) => q.ok && q.drawable).map((q) => q.layerId))].filter((id) => getLayer(id)?.style.geometry !== undefined);
    if (joinAsk.op === "drive_time" ? answered.length >= 1 : answered.length >= 2) {
      const [a, b] = combineSides(answered, joinAsk.op);
      const note = (calls.find((c) => c.toolName === "note") as DraftCall | undefined) ?? { toolCallId: guardId(), toolName: "note", input: { markdown: draft.text ?? "" } };
      rejected.push({
        call: note,
        reason:
          `Not shown yet: the question asks "${joinAsk.because}", which the combine tool answers. Call combine with op "${joinAsk.op}", a ${a}${b ? `, b ${b}${joinAsk.match ? ` (match "${joinAsk.match}")` : ""}` : ""}` +
          `${joinAsk.minutes ? `, minutes ${joinAsk.minutes}` : ""}${joinAsk.distance ? `, distance ${joinAsk.distance} ${joinAsk.unit ?? "km"}` : ""}, then write the note from its counts.`,
      });
      calls = calls.filter((c) => c.toolName !== "note");
      turn.readingAdded.add("combine");
      turn.note(`note held back: the question asks "${joinAsk.because}" and combine was not called`);
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
    const renders = pending.map((layerId): DraftCall => ({
      toolCallId: guardId(),
      toolName: "render",
      input: normalizeRenderInput({ layerId }, getLayer(layerId), turn.question),
    }));
    // The answer's ranked layer is drawn again after the step's other renders, so the camera ends on its top features,
    // not on a context layer drawn last (Asheville's waterfall loops were framed off screen by the waterfalls' own
    // render) or on one trail the model picked out by name (Boulder's camera ended on Meyer's Homestead Trail).
    const main = mainRankedRender(turn);
    const stepRenders = [...calls.filter((c) => c.toolName === "render" || c.toolName === "compare"), ...renders];
    const last = stepRenders[stepRenders.length - 1];
    const lastId = typeof last?.input.layerId === "string" ? last.input.layerId : null;
    const sameAsMain = (id: string | null) => id !== null && main !== null && (id === main.layerId || (/^combine\b/.test(id) && main.layerId === "combine"));
    const redraw = main !== null && last !== undefined && !(sameAsMain(lastId) && !singleNamed(last.input));
    if (redraw) renders.push({ toolCallId: guardId(), toolName: "render", input: main });
    if (renders.length > 0) {
      const at = calls.findIndex((c) => c.toolName === "note");
      calls = at === -1 ? [...calls.filter((c) => c.toolName !== "note"), ...renders] : [...calls.slice(0, at), ...renders, ...calls.slice(at)];
      if (pending.length > 0) {
        // A text-only ending is written again after the renders, from the drawn map (unless it becomes the note below).
        dropText = !hasNote && draft.hasText;
        turn.note(`rendered ${pending.join(", ")} before the ${hasNote ? "note" : "answer"}: queried but never drawn`);
      }
      if (redraw) turn.note(`drew ${main!.layerId} ranked again last, so the camera ends on its top features`);
      changed = true;
    }
  }
  // 4b. A join drawn in its source's view (hikes near a waterfall ranked like the hikes), so its top features are
  // listed, sized and framed like the source's were; the join draws with no view of its own.
  if (ending) {
    const joinAt = turn.calls.findLastIndex((c) => c.toolName === "combine" && typeof (c.output as { combined?: { id?: unknown } } | undefined)?.combined?.id === "string");
    const last = joinAt >= 0 ? (turn.calls[joinAt].output as { combined: { id: string; sourceLayerId?: string } }) : undefined;
    // Drawn in a view after the last join (a second join is a new layer with no view of its own).
    const drawnAlready = [...turn.calls.slice(joinAt + 1), ...calls.map((c) => ({ toolName: c.toolName, input: c.input }))].some(
      (c) => c.toolName === "render" && typeof (c.input as { layerId?: unknown })?.layerId === "string" && /^combine\b/.test((c.input as { layerId: string }).layerId) && (c.input as { view?: unknown }).view !== undefined,
    );
    if (last && !drawnAlready && last.combined.sourceLayerId) {
      const source = last.combined.sourceLayerId;
      const sourceRender = [...turn.calls].reverse().find((c) => c.toolName === "render" && (c.input as { layerId?: unknown })?.layerId === source)?.output as { view?: string; rankBy?: string } | undefined;
      const view = sourceRender?.view ?? turn.reading.views.find((v) => v.layerId === source)?.view;
      if (view) {
        // Ranked by the source's own measure (a hike's length), not the join's distance to the nearest waterfall.
        const sourceLayer = getLayer(source);
        const rankBy = sourceRender?.rankBy ?? turn.reading.rankBy.find((r) => r.layerId === source)?.key ?? sourceLayer?.labels?.rankBy ?? sourceLayer?.card?.measure?.key;
        const render: DraftCall = { toolCallId: guardId(), toolName: "render", input: { layerId: "combine", view, ...(rankBy && { rankBy }) } };
        const at = calls.findIndex((c) => c.toolName === "note");
        calls = at === -1 ? [...calls, render] : [...calls.slice(0, at), render, ...calls.slice(at)];
        turn.note(`drew the join ${last.combined.id} in the ${view} view of ${source}`);
        changed = true;
      }
    }
  }
  // 5. An answer written as text with no note becomes the note (after any renders above), so it is grounded, composed
  // and cut like one (lib/agent/noteCheck.ts) and its follow-ups come after it; the model's own are kept for that.
  const textAnswer = extractFollowUps(draft.text ?? "");
  if (
    !hasNote &&
    rejected.length === 0 &&
    !leakedText &&
    !turn.noted &&
    textAnswer.body.trim() !== "" &&
    // Only questions is no answer ("- More?" after a note sent back to be rewritten).
    !textAnswer.body.split("\n").every((l) => l.trim() === "" || /^\s*[-*+]\s+.*\?\s*$/.test(l)) &&
    calls.every((c) => c.toolName === "render") &&
    (turn.queries.length > 0 || turn.calls.length > 0)
  ) {
    turn.modelFollowUps = textAnswer.followUps;
    calls = [...calls, { toolCallId: guardId(), toolName: "note", input: { markdown: textAnswer.body } }];
    dropText = true;
    changed = true;
    turn.note("the answer written as text became the note");
  }
  let text: string | undefined;
  // 6. A data story's answer has the data's shape (spec §13): the low and the peak with numbers and dates, and what size
  // (or width, or brightness) and color mean. What the note, or a closing text with no note, leaves out is added from
  // the story: its first sentence (the low and the peak) and the encoding sentence, before the follow-up questions.
  const story = turn.queries.findLast((q) => q.ok && q.meaning !== undefined);
  if (story?.meaning) {
    const additions = (answer: string) => [
      ...(story.caption && !hasLowAndPeak(answer) ? [firstSentence(story.caption)] : []),
      ...(!saysMeaning(answer) ? [story.meaning as string] : []),
    ];
    const at = calls.findIndex((c) => c.toolName === "note");
    if (at >= 0) {
      const markdown = typeof calls[at].input.markdown === "string" ? (calls[at].input.markdown as string) : "";
      const add = additions(markdown);
      if (add.length > 0) {
        // The note keeps to its word limit: the model's part gives way to the story's lines.
        const room = Math.max(20, NOTE_MAX_WORDS - noteWords(add.join(" ")));
        calls = calls.map((c, i) => (i === at ? { ...c, input: { ...c.input, markdown: `${trimNote(markdown, room).trimEnd()}\n\n${add.join(" ")}` } } : c));
        turn.note("added the story's shape (low and peak, what size and color mean) to the note");
        changed = true;
      }
    } else if (!hasNote && calls.length === 0 && rejected.length === 0 && !dropText && !leakedText && !turn.noted && draft.text) {
      // A closing text that is no answer of the turn's (nothing was asked of a layer): the story's lines still go in.
      const add = additions(draft.text);
      if (add.length > 0) {
        text = withMeaning(draft.text, add.join(" "));
        turn.note("added the story's shape (low and peak, what size and color mean) to the closing text");
        changed = true;
      }
    }
  }
  // 7. A note on the last step leaves no step for the follow-ups: they come after it in the same step.
  const trailingText = calls.some((c) => c.toolName === "note") && turn.step >= MAX_STEPS - 1 ? followUpList(followUpsForTurn(turn, turn.modelFollowUps)) : undefined;
  if (trailingText) changed = true;
  return { calls, dropText: dropText || leakedText || deferred, rejected, changed, ...(text !== undefined && { text }), ...(trailingText && { trailingText }) };
}

/** True for a render that picks out one or two features by name (a detail of one trail), not the ranked answer. */
function singleNamed(input: Record<string, unknown>): boolean {
  const name = (input.filters as { name?: { include?: unknown[]; match?: unknown } } | undefined)?.name;
  return (Array.isArray(name?.include) && name.include.length > 0) || (typeof name?.match === "string" && name.match.trim() !== "");
}

/**
 * The render that draws the answer ranked, as drawn: the last ranked render of a join (hikes near a waterfall), else
 * the last ranked render that does not pick out features by name. Its layer id is "combine" for a join. Null when the
 * turn drew nothing ranked.
 */
export function mainRankedRender(turn: Pick<Turn, "calls">): Record<string, unknown> | null {
  const ranked = turn.calls
    .filter((c) => c.toolName === "render" && (c.output as { view?: unknown } | undefined)?.view === "ranked" && typeof (c.output as { layerId?: unknown }).layerId === "string")
    .map((c) => c.output as Record<string, unknown> & { layerId: string });
  const isJoin = (o: { layerId: string }) => /^combine\b/.test(o.layerId);
  const pick = [...ranked].reverse().find(isJoin) ?? [...ranked].reverse().find((o) => !singleNamed(o));
  if (!pick) return null;
  return { ...pick, layerId: isJoin(pick) ? "combine" : pick.layerId };
}

/**
 * Which answered layer is a (the things kept) and which b (what they are tested against): an area layer is b for
 * within, outside and overlap (the first answered of two areas is a), a line layer for along; otherwise the order the
 * question was answered in.
 */
export function combineSides(answered: string[], op: string): [string, string | undefined] {
  if (op === "drive_time") return [answered[0], undefined];
  const geometry = (id: string) => getLayer(id)?.style.geometry;
  const want = op === "along" ? "line" : op === "near" ? undefined : "polygon";
  const b = want ? (answered.slice().reverse().find((id) => geometry(id) === want && answered.some((x) => x !== id)) ?? answered[1]) : answered[answered.length - 1];
  const a = answered.find((id) => id !== b) ?? answered[0];
  return [a, b];
}

/** True when an answer gives a low (or weakest) and a peak (or strongest). */
export function hasLowAndPeak(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(low|lowest|minimum|weakest|slack|calm|bottom)/.test(t) && /\b(peak|high|highest|maximum|strongest|fastest)/.test(t);
}

/** A caption's first sentence (up to its first full stop followed by a space and a capital). */
function firstSentence(caption: string): string {
  const m = /^.*?[.;](?=\s+[A-Z])/.exec(caption);
  return (m ? m[0] : caption).replace(/;$/, ".");
}

/** True when an answer says what the marks' size (or width, or brightness) and color mean. */
export function saysMeaning(text: string): boolean {
  const t = text.toLowerCase();
  return /\bcolou?r/.test(t) && /\b(width|wide|wider|thick|size|bright|brightness)/.test(t);
}

/**
 * The answer with the meaning sentence after its findings and before its follow-up questions (a closing bullet list),
 * within the note's word limit: the findings are cut to make room first, then the follow-ups go.
 */
export function withMeaning(text: string, meaning: string, max = NOTE_MAX_WORDS): string {
  const lines = text.trimEnd().split("\n");
  let cut = lines.length;
  while (cut > 0 && (/^\s*[-*•]\s/.test(lines[cut - 1]) || lines[cut - 1].trim() === "")) cut -= 1;
  // Only a trailing list of questions is the follow-ups; findings in bullets stay above the sentence.
  const tail = lines.slice(cut);
  const follow = (tail.some((l) => /\?\s*$/.test(l)) ? tail : []).filter((l) => l.trim() !== "");
  const body = (follow.length > 0 ? lines.slice(0, cut) : lines).join("\n");
  const followWords = noteWords(follow.join("\n"));
  const keepFollow = noteWords(meaning) + followWords + 20 <= max;
  const room = Math.max(20, max - noteWords(meaning) - (keepFollow ? followWords : 0));
  return [trimNote(body, room).trimEnd(), "", meaning, ...(keepFollow && follow.length > 0 ? ["", ...follow] : [])].join("\n");
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

const fmtKm2 = (n: number) => `${Math.round(n).toLocaleString("en-US")} km²`;

/**
 * The turn's ending when the model asked again only for queries the guard drops, even after being told why: renders
 * for anything queried and not drawn, then a plain note the server writes, saying what could not be drawn and why, so
 * the turn never ends with no answer (species over Colorado shrank twice and stopped with nothing, 2026-10-17).
 */
export function fallbackEnding(turn: Turn, rejected: Decision["rejected"]): DraftCall[] {
  const renders = undrawn(turn).map((layerId): DraftCall => ({ toolCallId: guardId(), toolName: "render", input: normalizeRenderInput({ layerId }, getLayer(layerId), turn.question) }));
  const lines: string[] = [];
  for (const layerId of [...new Set(rejected.map((r) => layerOf(r.call.toolName)).filter(Boolean))]) {
    // A layer that answered is on the map; only what could not be drawn is listed.
    if (turn.queries.some((q) => q.layerId === layerId && q.ok)) continue;
    const layer = getLayer(layerId);
    const title = layer?.title ?? layerId;
    const wide = turn.queries.find((q) => q.layerId === layerId && q.zoomIn);
    if (wide && layer) {
      lines.push(`- **${title}** covers at most ${fmtKm2(hardMaxAreaKm2(layer))} at a time, and this area is ${fmtKm2(bboxAreaKm2(wide.bbox))}, so it is not drawn. Zoom in, or ask about a smaller area.`);
    } else {
      lines.push(`- **${title}** did not answer this question.`);
    }
  }
  const drawn = renders.length > 0 || turn.drawn.size > 0;
  const markdown = [drawn ? "What answered is on the map." : "Nothing could be drawn for this question at this scale.", ...lines].join("\n");
  turn.note("the model only asked again for dropped queries: the server wrote the note");
  return [...renders, { toolCallId: guardId(), toolName: "note", input: { markdown } }];
}

/** The call with only render, compare and note on offer, one of them required: the last try before the server writes the note. */
function answerOnlyParams(params: CallOptions): CallOptions {
  const tools = (params.tools ?? []).filter((t) => "name" in t && ["render", "compare", "note"].includes(t.name));
  return tools.length > 0 ? { ...params, tools, toolChoice: { type: "required" } } : params;
}

/** Most times one step is asked again after all its calls were dropped. */
const MAX_REASKS = 1;

/**
 * A step with no tool call and no text before the answer was written: the model stopped with nothing (Bishop
 * bouldering, 2026-10-23: a geocode, then an empty step and an empty answer). Asked once more as it was.
 */
const isEmptyStep = (calls: DraftCall[], text: string, turn: Turn) => calls.length === 0 && text.trim() === "" && !turn.noted;

const finishFor = (calls: DraftCall[], reason: { unified: string; raw: string | undefined }) =>
  calls.length > 0 ? { unified: "tool-calls" as const, raw: reason.raw } : reason;

/** The guard as middleware for one turn; `toolNames` are the turn's tools, for name repair. */
export function stepGuard(turn: Turn, toolNames: readonly string[]): Middleware {
  const rename = (name: string) => repairToolName(name, toolNames) ?? name;

  async function guardGenerate(model: Model, params: CallOptions, first: GenerateResult): Promise<GenerateResult> {
    let result = first;
    let emptyRetried = false;
    for (let attempt = 0; ; attempt++) {
      const calls = draftCalls(result.content);
      if (!calls) return result;
      const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      if (!emptyRetried && isEmptyStep(calls, text, turn)) {
        emptyRetried = true;
        turn.note("the model's step was empty: asked again");
        result = await model.doGenerate(params);
        attempt--;
        continue;
      }
      const decision = await decideStep({ calls, hasText: text.trim() !== "", text }, turn, toolNames);
      if (decision.rejected.length > 0 && decision.calls.length === 0 && attempt < MAX_REASKS) {
        result = await model.doGenerate(reaskParams(params, decision.rejected));
        continue;
      }
      if (decision.rejected.length > 0 && decision.calls.length === 0 && !turn.noted && attempt === MAX_REASKS) {
        // Told why once and still only asking again: one more try with only drawing and the note on offer.
        result = await model.doGenerate(answerOnlyParams(reaskParams(params, decision.rejected)));
        continue;
      }
      if (decision.rejected.length > 0 && decision.calls.length === 0 && !turn.noted) decision.calls = fallbackEnding(turn, decision.rejected);
      if (!decision.changed) return result;
      const kept = result.content.filter((c) => c.type !== "tool-call" && !(decision.dropText && c.type === "text") && !(decision.text !== undefined && c.type === "text"));
      const replacedText = decision.text !== undefined ? [{ type: "text", text: decision.text } as Content] : [];
      const trailing = decision.trailingText !== undefined ? [{ type: "text", text: decision.trailingText } as Content] : [];
      return {
        ...result,
        content: [...replacedText, ...kept, ...decision.calls.map((c) => toPart(c) as Content), ...trailing],
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
    let emptyRetried = false;
    for (let attempt = 0; ; attempt++) {
      if (parts.some((p) => p.type === "error")) return { ...result, stream: streamOf(parts).pipeThrough(renaming()) };
      const calls = draftCalls(parts);
      if (!calls) return { ...result, stream: streamOf(parts).pipeThrough(renaming()) };
      const text = parts.map((p) => (p.type === "text-delta" ? p.delta : "")).join("");
      if (!emptyRetried && isEmptyStep(calls, text, turn)) {
        emptyRetried = true;
        turn.note("the model's step was empty: asked again");
        result = await model.doStream(params);
        parts = await collect(result.stream);
        attempt--;
        continue;
      }
      const decision = await decideStep({ calls, hasText: text.trim() !== "", text }, turn, toolNames);
      if (decision.rejected.length > 0 && decision.calls.length === 0 && attempt < MAX_REASKS) {
        result = await model.doStream(reaskParams(params, decision.rejected));
        parts = await collect(result.stream);
        continue;
      }
      if (decision.rejected.length > 0 && decision.calls.length === 0 && !turn.noted && attempt === MAX_REASKS) {
        result = await model.doStream(answerOnlyParams(reaskParams(params, decision.rejected)));
        parts = await collect(result.stream);
        continue;
      }
      if (decision.rejected.length > 0 && decision.calls.length === 0 && !turn.noted) decision.calls = fallbackEnding(turn, decision.rejected);
      if (!decision.changed) return { ...result, stream: streamOf(parts) };
      const isText = (p: StreamPart) => p.type === "text-start" || p.type === "text-delta" || p.type === "text-end";
      const isToolInput = (p: StreamPart) => p.type === "tool-input-start" || p.type === "tool-input-delta" || p.type === "tool-input-end" || p.type === "tool-call";
      const kept = parts.filter((p) => p.type !== "finish" && !isToolInput(p) && !((decision.dropText || decision.text !== undefined) && isText(p)));
      const finish = parts.find((p): p is Extract<StreamPart, { type: "finish" }> => p.type === "finish");
      const id = "guard-text";
      const replacedText: StreamPart[] =
        decision.text !== undefined
          ? ([{ type: "text-start", id }, { type: "text-delta", id, delta: decision.text }, { type: "text-end", id }] as StreamPart[])
          : [];
      const trailing: StreamPart[] =
        decision.trailingText !== undefined
          ? ([{ type: "text-start", id: "guard-follow-ups" }, { type: "text-delta", id: "guard-follow-ups", delta: decision.trailingText }, { type: "text-end", id: "guard-follow-ups" }] as StreamPart[])
          : [];
      const out: StreamPart[] = [...replacedText, ...kept, ...decision.calls.map((c) => toPart(c) as StreamPart), ...trailing];
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
