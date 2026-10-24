/**
 * The top 10 use cases' strict pass rule (docs/top-10-use-cases.md "Acceptance tests"): one question's run (its tool
 * calls, notes and closing text, and the map the browser would end on) held to its expectation
 * (scripts/top10.expectations.ts). Every field of the expectation is one assertion, and five apply to every question:
 * the note is grounded in the results, it answers in its first sentence with a deciding number, the reply ends with 3
 * follow-ups specific to the result, the camera frames the top features, and the phone's first screen shows the answer
 * (first sentence short enough for the folded chat sheet, top features labelled and in frame).
 *
 * Pure: the caller (scripts/eval-model.mts) replays the run to the final map state and passes it in.
 */
import type { Feature, FeatureCollection } from "geojson";
import { getLayer } from "@/layers";
import { labelsOf } from "@/layers/contract";
import type { BBox } from "@/layers/types";
import { attributeFor, rankedTop } from "@/lib/render/attributes";
import { cardContent } from "@/lib/render/card";
import { isCombinedId } from "@/lib/render/combined";
import { layerDisplay } from "@/lib/render/contract";
import { isActiveEntry, type LayerFilters } from "@/lib/render/filters";
import { rowLegend } from "@/lib/render/legendView";
import type { LoadedLayer, MapState, RenderOp } from "@/lib/render/state";
import { visibleState } from "@/lib/render/view";
import { boundsOf } from "@/lib/render/views";
import { factPool, ungroundedClaims } from "@/lib/agent/grounding";
import { extractFollowUps } from "@/lib/agent/followups";
import { isFullLayerResult, summarizeLayerResult } from "@/lib/layers/summarize";
import type { FilterExpect, InputExpect, Top10Expect } from "@/scripts/top10.expectations";

export type ToolCall = { toolName: string; input?: unknown; output?: unknown };

/** One assertion's outcome; `id` names the kind (the baseline groups failures by it). */
export type Assertion = { id: string; ok: boolean; detail: string };

export type Top10Result = { ok: boolean; assertions: Assertion[]; failed: Assertion[] };

/** Longest first sentence the folded phone chat sheet (34% of an 844 px screen) shows without scrolling. */
export const PHONE_FIRST_SENTENCE_WORDS = 40;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isError = (output: unknown) => isObject(output) && "error" in output;
const ok = (c: ToolCall) => c.output !== undefined && !isError(c.output);
const alts = (s: string) => s.split("|").map((x) => x.trim()).filter(Boolean);
const lower = (s: string) => s.toLowerCase();

function features(output: unknown): Feature[] {
  const f = isObject(output) && isObject(output.data) ? (output.data as { features?: unknown }).features : undefined;
  return Array.isArray(f) ? (f as Feature[]) : [];
}
const isTiles = (output: unknown) => isObject(output) && output.kind === "tiles";

/** True when a layer id stands for one of the alternatives ("combine" is any joined layer). */
function matches(id: string, alternatives: string[]): boolean {
  return alternatives.some((a) => a === id || (a === "combine" && isCombinedId(id)));
}

/** The main layer's last render op and its loaded entry (all data, and what the map shows after filters). */
function mainLayer(state: MapState, main: string): { op: RenderOp; all: LoadedLayer; shown: LoadedLayer } | undefined {
  const ids = alts(main);
  const vis = visibleState(state);
  // In the order the expectation lists them: the first alternative drawn with something on the map is the main one,
  // else the first drawn at all (an empty answer still has a row, a legend and a camera).
  const drawn = ids.flatMap((want) => {
    const op = [...state.renderOps].reverse().find((o) => o.visible !== false && matches(o.layerId, [want]) && state.layers[o.layerId]);
    return op ? [{ op, all: state.layers[op.layerId], shown: vis.layers[op.layerId] ?? state.layers[op.layerId] }] : [];
  });
  const showing = (l: LoadedLayer) => l.result.kind === "tiles" || (dataOf(l)?.features.length ?? 0) > 0;
  return drawn.find((d) => showing(d.shown)) ?? drawn[0];
}

function dataOf(layer: LoadedLayer | undefined): FeatureCollection | null {
  return layer?.result.kind === "geojson" ? layer.result.data : null;
}

/** The top `n` drawn features of the main layer by its Rank by (or source order when it has no measure). */
function topOf(m: NonNullable<ReturnType<typeof mainLayer>>, n: number): { key?: string; top: Feature[] } {
  const all = m.all.allData ?? dataOf(m.all);
  const shown = dataOf(m.shown);
  if (!all || !shown) return { top: [] };
  const ranked = rankedTop(m.all, m.op, all, shown, n);
  return { key: ranked.key, top: ranked.top.length > 0 ? ranked.top : shown.features.slice(0, n) };
}

/** The note as the person reads it: the note tool's markdown, or the closing text when there is none. */
export function answerText(calls: ToolCall[], text: string): string {
  const notes = calls.filter((c) => c.toolName === "note").map((c) => (isObject(c.output) && typeof c.output.markdown === "string" ? c.output.markdown : ""));
  const joined = notes.filter(Boolean).join("\n");
  return joined || extractFollowUps(text).body;
}

/** The first sentence of prose in a note: headings and emphasis dropped, list markers too. */
export function firstSentence(markdown: string): string {
  const prose = markdown
    .split("\n")
    // Headings and bold-only lines are titles, not the answer.
    .filter((l) => !/^\s*#{1,6}\s/.test(l) && !/^\s*(?:\*\*|__)[^*_]+(?:\*\*|__):?\s*$/.test(l))
    .map((l) => l.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/, "").replace(/\*\*|__|`/g, "").trim())
    .filter((l) => l.length > 0)
    .join(" ");
  const m = /^(.+?[.!?])(?=\s|$)/.exec(prose.replace(/\b(?:e\.g|i\.e|approx|vs|Mt|St|No|ca)\.\s/gi, (s) => s.replace(". ", "․ ")));
  return (m ? m[1] : prose).replace(/․/g, ".").trim();
}

const words = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

const comparable = (t: string) =>
  t
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[‐-―−]/g, "-")
    .replace(/[\s  ]+/g, " ")
    .replace(/\bmt\.?(?=\s)/g, "mount")
    .replace(/\bst\.?(?=\s)/g, "saint");

/** Named features in every successful query and combine output. */
function resultNames(calls: ToolCall[]): string[] {
  const names = new Set<string>();
  for (const c of calls) {
    if (!ok(c) || !(c.toolName.startsWith("query_") || c.toolName === "combine")) continue;
    for (const f of features(c.output)) {
      const p = f.properties ?? {};
      for (const k of ["name", "heading", "species", "commonName"]) if (typeof p[k] === "string" && (p[k] as string).trim().length >= 4) names.add((p[k] as string).trim());
    }
  }
  return [...names];
}

/** True when the text names `name`, as written or without a trailing "(A)" tag. */
function names(text: string, name: string): boolean {
  const t = comparable(text);
  const full = comparable(name);
  const bare = full.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return t.includes(full) || (bare.length >= 4 && t.includes(bare));
}

/** Place names the turn geocoded (the first part of each: "Asheville" of "Asheville, North Carolina"). */
function placeNames(calls: ToolCall[]): string[] {
  return calls
    .filter((c) => c.toolName === "geocode" && ok(c) && isObject(c.output) && typeof c.output.name === "string")
    .map((c) => String((c.output as { name: string }).name).split(",")[0].trim())
    .filter((n) => n.length >= 3);
}

function contains(outer: BBox | undefined, inner: BBox | null): boolean {
  if (!outer || !inner) return false;
  const dx = (outer[2] - outer[0]) * 0.02;
  const dy = (outer[3] - outer[1]) * 0.02;
  return outer[0] <= inner[0] + dx && outer[1] <= inner[1] + dy && outer[2] >= inner[2] - dx && outer[3] >= inner[3] - dy;
}

// ── One assertion per expectation field ─────────────────────────────────────────────────────────────────────────────

function layersAssert(e: Top10Expect, calls: ToolCall[], state: MapState): Assertion {
  const missing: string[] = [];
  for (const group of e.layers) {
    if (group.startsWith("combine:")) {
      const op = group.slice(8);
      const joined = calls.some((c) => c.toolName === "combine" && ok(c) && isObject(c.input) && c.input.op === op);
      if (!joined) missing.push(`no ${op} join`);
      continue;
    }
    const ids = alts(group);
    const answered = calls.filter((c) => ids.some((id) => c.toolName === `query_${id}`) && ok(c));
    const returned = answered.some((c) => features(c.output).length > 0 || isTiles(c.output));
    const drawn = state.renderOps.some((o) => ids.includes(o.layerId));
    if (answered.length === 0) missing.push(`${group} not answered`);
    else if (returned && !drawn) missing.push(`${group} answered but not drawn`);
  }
  return { id: "layers", ok: missing.length === 0, detail: missing.length ? missing.join("; ") : "all answered and drawn" };
}

function anyOfAssert(e: Top10Expect, calls: ToolCall[], state: MapState): Assertion | null {
  if (!e.anyOf) return null;
  const got = e.anyOf.layers.filter((id) => calls.some((c) => c.toolName === `query_${id}` && ok(c)) && state.renderOps.some((o) => o.layerId === id));
  return { id: "layers", ok: got.length >= e.anyOf.min, detail: `${got.length} of ${e.anyOf.min} needed from ${e.anyOf.layers.join(", ")} (${got.join(", ") || "none"})` };
}

function forbidAssert(e: Top10Expect, state: MapState): Assertion | null {
  if (!e.forbid) return null;
  const bad = state.renderOps.filter((o) => e.forbid!.includes(o.layerId)).map((o) => o.layerId);
  return { id: "forbid", ok: bad.length === 0, detail: bad.length ? `drew ${bad.join(", ")}` : "none drawn" };
}

/** The chip labels a filter entry picks, through the layer's levels ("2" is "Blue"); a range picks the levels inside it. */
function pickedLabels(layerIds: string[], key: string, entry: LayerFilters[string]): string[] {
  const out = new Set<string>();
  if (entry.range) {
    const [lo, hi] = entry.range;
    for (const id of layerIds) {
      const layer = getLayer(id);
      const attr = layer ? attributeFor(layer, key) : undefined;
      for (const l of attr?.levels ?? []) if (typeof l.value === "number" && l.value >= lo && l.value <= hi) out.add(lower(l.label));
    }
  }
  for (const v of entry.include ?? []) {
    let label: string | undefined;
    for (const id of layerIds) {
      const layer = getLayer(id);
      const attr = layer ? attributeFor(layer, key) : undefined;
      label = attr?.levels?.find((l) => String(l.value) === String(v))?.label;
      if (label) break;
    }
    out.add(lower(label ?? String(v)));
  }
  return [...out];
}

/** Every filter set this turn on the layers: render ops' filters, and the filters a combine call put on a side. */
function filterSets(layerIds: string[], calls: ToolCall[], state: MapState): { layer: string; filters: LayerFilters }[] {
  const out: { layer: string; filters: LayerFilters }[] = [];
  for (const o of state.renderOps) if (matches(o.layerId, layerIds) && o.filters) out.push({ layer: o.layerId, filters: o.filters });
  for (const c of calls) {
    if (c.toolName !== "combine" || !ok(c) || !isObject(c.input)) continue;
    for (const side of [c.input.a, c.input.b]) {
      if (isObject(side) && typeof side.layerId === "string" && matches(side.layerId, layerIds) && isObject(side.filters)) out.push({ layer: side.layerId, filters: side.filters as LayerFilters });
    }
  }
  return out;
}

export function filterHolds(f: FilterExpect, calls: ToolCall[], state: MapState): { ok: boolean; detail: string } {
  const layerIds = alts(f.layer);
  const keys = alts(f.key);
  const sets = filterSets(layerIds, calls, state);
  const seen: string[] = [];
  for (const { layer, filters } of sets) {
    for (const key of keys) {
      const entry = filters[key];
      if (!isActiveEntry(entry)) continue;
      const sourceIds = isCombinedId(layer) ? layerIds.filter((id) => id !== "combine") : [layer];
      const picked = pickedLabels(sourceIds, key, entry);
      seen.push(`${key}=${entry.include ? picked.join("/") : ""}${entry.range ? `[${entry.range.join(",")}]` : ""}`);
      // Each wanted label may name alternatives ("Blue|Intermediate"): one of them picked.
      const labelsOk = (f.labels ?? []).every((want) => want.split("|").some((w) => picked.includes(lower(w))));
      const hi = entry.range?.[1];
      const lo = entry.range?.[0];
      const maxOk = f.max === undefined || (hi !== undefined && Number.isFinite(hi) && hi <= f.max * 1.05);
      const minOk = f.min === undefined || (lo !== undefined && lo >= f.min * 0.95);
      const onOk = f.on === undefined || picked.includes("true") || picked.length > 0;
      if (labelsOk && maxOk && minOk && onOk) return { ok: true, detail: `${layer} ${seen[seen.length - 1]}` };
    }
  }
  return { ok: false, detail: `${f.layer} ${f.key}${f.labels?.length ? ` = ${f.labels.join(", ")}` : ""}${f.min !== undefined ? ` ≥ ${f.min}` : ""}${f.max !== undefined ? ` ≤ ${f.max}` : ""} not set${seen.length ? ` (set: ${seen.join("; ")})` : " (no filter set)"}` };
}

function filtersAssert(e: Top10Expect, calls: ToolCall[], state: MapState): Assertion | null {
  if (!e.filters?.length) return null;
  const results = e.filters.map((f) => filterHolds(f, calls, state));
  return { id: "filters", ok: results.every((r) => r.ok), detail: results.map((r) => r.detail).join("; ") };
}

export function inputHolds(i: InputExpect, calls: ToolCall[]): boolean {
  const ids = alts(i.layer);
  return calls.some((c) => {
    if (!ids.some((id) => c.toolName === `query_${id}`) || !ok(c) || !isObject(c.input)) return false;
    const v = c.input[i.key];
    if (v === undefined) return false;
    if (i.equals !== undefined && v !== i.equals) return false;
    if (i.match !== undefined && !new RegExp(i.match, "i").test(Array.isArray(v) ? v.join(",") : String(v))) return false;
    if (i.min !== undefined && !(typeof v === "number" && v >= i.min)) return false;
    if (i.max !== undefined && !(typeof v === "number" && v <= i.max)) return false;
    return true;
  });
}

function inputsAssert(e: Top10Expect, calls: ToolCall[]): Assertion | null {
  if (!e.inputs?.length) return null;
  const bad = e.inputs.filter((i) => !inputHolds(i, calls));
  return { id: "inputs", ok: bad.length === 0, detail: bad.length ? bad.map((i) => `${i.layer}.${i.key} ${i.equals ?? i.match ?? `${i.min ?? ""}..${i.max ?? ""}`}`).join("; ") + " not asked" : "asked" };
}

// ── The assertions every question gets ─────────────────────────────────────────────────────────────────────────────

/**
 * The outputs as the server's grounding check reads them (lib/agent/tools.ts modelView, lib/agent/grounding.ts
 * factPool): a query's summary (counts, stats, totals the model read) beside its full body; other tools as they are.
 */
function outputsOf(calls: ToolCall[]): unknown[] {
  return calls
    .filter((c) => ok(c) && (c.toolName.startsWith("query_") || ["combine", "geocode", "route"].includes(c.toolName)))
    .map((c) => {
      const layerId = c.toolName.startsWith("query_") ? c.toolName.slice(6) : undefined;
      const layer = layerId ? getLayer(layerId) : undefined;
      if (!layer || !isFullLayerResult(c.output)) return c.output;
      return { summary: summarizeLayerResult(c.output, layer.id, { ...layer.style, attributes: layer.attributes }, layer.fieldHelp), body: c.output };
    });
}

/**
 * Runs every assertion for one question. `question` is the text asked (without its @view); `view` is true for a
 * "here" question (the camera must not move to anything else).
 */
export function top10Rule(e: Top10Expect, run: { calls: ToolCall[]; text: string; state: MapState; question: string; hereView?: BBox | null }): Top10Result {
  const { calls, text, state, question } = run;
  const note = answerText(calls, text);
  const asserts: (Assertion | null)[] = [layersAssert(e, calls, state), anyOfAssert(e, calls, state), forbidAssert(e, state), filtersAssert(e, calls, state), inputsAssert(e, calls)];
  const m = mainLayer(state, e.main);
  if (!m) asserts.push({ id: "main", ok: false, detail: `main layer ${e.main} not drawn` });

  if (e.view) asserts.push({ id: "view", ok: !!m?.op.view && e.view.includes(m.op.view), detail: `view ${m?.op.view ?? "none"} (wanted ${e.view.join(" or ")})` });
  if (e.basemap) asserts.push({ id: "basemap", ok: e.basemap.includes(state.basemap), detail: `basemap ${state.basemap} (wanted ${e.basemap.join(" or ")})` });
  const ranked = m ? topOf(m, 3) : { top: [] as Feature[] };
  if (e.rankBy) asserts.push({ id: "rankBy", ok: !!ranked.key && e.rankBy.includes(ranked.key), detail: `ranked by ${ranked.key ?? "nothing"} (wanted ${e.rankBy.join(" or ")})` });
  if (e.compare) asserts.push({ id: "compare", ok: !!state.compare && !!m && state.compare.layerId === m.op.layerId, detail: state.compare ? `compare on ${state.compare.layerId}` : "no compare open" });
  if (e.timePanel) asserts.push({ id: "time", ok: !!state.time?.open || !!state.compare, detail: state.time ? `time panel ${state.time.open ? "open" : "closed"}` : "no time panel" });
  if (e.places) {
    const sentences = note.split(/(?<=[.!?])\s+|\n+/);
    const missing = e.places.filter((p) => !sentences.some((s) => lower(s).includes(lower(p)) && /\d/.test(s)));
    asserts.push({ id: "places", ok: missing.length === 0, detail: missing.length ? `no number given for ${missing.join(", ")}` : "both places with numbers" });
  }

  // Labels: the main layer's on-map names for its top features.
  const shownFeatures = dataOf(m?.shown)?.features ?? [];
  const spec = m ? labelsOf({ labels: m.all.labels ?? getLayer(m.op.layerId)?.labels, card: m.all.card ?? getLayer(m.op.layerId)?.card }) : undefined;
  const labelled = spec ? Math.min(spec.max, shownFeatures.filter((f) => typeof f.properties?.[spec.field] === "string" || typeof f.properties?.[spec.field] === "number").length) : 0;
  if (e.labels !== undefined) {
    const need = Math.min(e.labels, Math.max(1, shownFeatures.length));
    const total = dataOf(m?.all)?.features.length ?? 0;
    asserts.push({ id: "labels", ok: labelled >= need, detail: spec ? `${labelled} labelled by ${spec.field} (need ${need}; ${shownFeatures.length} of ${total} features shown)` : "the layer has no on-map labels" });
  }

  // Legend: the main layer's row legend, as the console draws it.
  if (e.legend && m) {
    const blocks = rowLegend(m.all, m.op, dataOf(m.shown));
    const texts = blocks.flatMap((b) => [b.title ?? "", b.note ?? "", ...b.entries.map((x) => x.label)]).map(lower);
    const missing = e.legend.filter((want) => !want.split("|").some((w) => texts.some((t) => t.includes(lower(w)))));
    asserts.push({ id: "legend", ok: missing.length === 0, detail: missing.length ? `legend lacks ${missing.join(", ")} (has ${blocks.map((b) => b.title).filter(Boolean).join(", ") || "no titles"})` : "legend names the encoding" });
  } else if (e.legend) asserts.push({ id: "legend", ok: false, detail: "no main layer to key" });

  // Card: the top feature's rows in order.
  if (e.card) {
    const top = ranked.top[0];
    if (!m || !top) asserts.push({ id: "card", ok: false, detail: "no top feature to open" });
    else {
      const content = cardContent(top, { unit: m.all.style.unit, card: m.all.card, fieldHelp: m.all.fieldHelp, display: layerDisplay(m.all) });
      const rows = [content.measure?.label, ...content.facts.map((f) => f.label)].filter((x): x is string => !!x).map(lower);
      let i = 0;
      const missing: string[] = [];
      for (const want of e.card) {
        const at = rows.findIndex((r, k) => k >= i && r === lower(want));
        if (at === -1) missing.push(want);
        else i = at + 1;
      }
      asserts.push({ id: "card", ok: missing.length === 0, detail: missing.length ? `card lacks or misorders ${missing.join(", ")} (rows: ${rows.slice(0, 8).join(", ")})` : "card rows in order" });
    }
  }

  // Note: deciding facts, named features, grounding, answer first.
  const lacking = e.facts.filter((f) => !f.re.test(note)).map((f) => f.what);
  asserts.push({ id: "facts", ok: lacking.length === 0, detail: lacking.length ? `note lacks: ${lacking.join("; ")}` : "deciding facts stated" });
  const resultList = resultNames(calls);
  const named = resultList.filter((n) => names(note, n));
  if (e.names !== undefined && e.names > 0) asserts.push({ id: "names", ok: named.length >= e.names, detail: `${named.length} features named (need ${e.names})${named.length ? `: ${named.slice(0, 4).join(", ")}` : ""}` });
  // A "name" read across a sentence end ("Asheville. Spring") is the name finder's slip, not a claim.
  const claims = note ? ungroundedClaims(note, factPool(outputsOf(calls), question)).filter((c) => !(c.kind === "name" && /[.!?]\s/.test(c.text))) : [];
  asserts.push({ id: "grounded", ok: claims.length === 0, detail: claims.length ? `not in the results: ${claims.slice(0, 5).map((c) => c.text).join("; ")}` : "every number and name traced" });
  const first = firstSentence(note);
  asserts.push({ id: "answerFirst", ok: /\d/.test(first), detail: first ? `first sentence: "${first.slice(0, 120)}"` : "no note" });

  // Follow-ups: exactly 3, at least 2 naming a feature or the place from this answer.
  const { followUps } = extractFollowUps(text);
  const anchors = [...resultList, ...placeNames(calls)];
  const specific = followUps.filter((q) => anchors.some((a) => names(q, a)));
  asserts.push({ id: "followUps", ok: followUps.length === 3 && specific.length >= 2, detail: `${followUps.length} follow-ups, ${specific.length} specific` });

  // Camera: the middle of each top feature in frame (a long trail may run off screen; its name and middle may not), and a
  // "here" question may keep the view the person is looking at.
  const middles = ranked.top.map((f) => boundsOf([f])).filter((b): b is BBox => b !== null).map((b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2] as BBox);
  const topBox = middles.length > 0 ? ([Math.min(...middles.map((b) => b[0])), Math.min(...middles.map((b) => b[1])), Math.max(...middles.map((b) => b[2])), Math.max(...middles.map((b) => b[3]))] as BBox) : null;
  const cameraBox = (state.camera?.bbox ?? run.hereView ?? undefined) as BBox | undefined;
  const framed = topBox === null ? !!cameraBox : contains(cameraBox, topBox);
  asserts.push({ id: "camera", ok: framed, detail: topBox === null ? (cameraBox ? "camera set (no features to frame)" : "camera never moved") : framed ? "top features in frame" : `top features outside the camera ${JSON.stringify(cameraBox)}` });

  // Phone first screen: the first sentence fits the folded sheet, the top features are named on the map and in frame.
  const short = first.length > 0 && words(first) <= PHONE_FIRST_SENTENCE_WORDS && /\d/.test(first);
  const labelsOk = shownFeatures.length === 0 || labelled >= Math.min(3, shownFeatures.length);
  asserts.push({ id: "phone", ok: short && labelsOk && framed, detail: `first sentence ${words(first)} words${/\d/.test(first) ? "" : " with no number"}, ${labelled} labels, ${framed ? "in frame" : "out of frame"}` });

  const assertions = asserts.filter((a): a is Assertion => a !== null);
  const failed = assertions.filter((a) => !a.ok);
  return { ok: failed.length === 0, assertions, failed };
}
