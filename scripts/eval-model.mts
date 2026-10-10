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
 * anything that came back was rendered (render or compare), the model
 * wrote a note (also when a layer errored or returned nothing), and the run finished without
 * throwing. A route-only question passes when the route tool ran and a note followed.
 *
 * A question may end with `@view=[w,s,e,n]`, the map view the browser would send with it
 * (lib/agent/view.ts). The view goes into the system prompt the way app/api/chat/route.ts
 * puts it there, and the place then counts as located without a geocode.
 * A question without `@view` that geocodes a named place must also call set_view, or it fails.
 */
import { readFileSync } from "node:fs";
import { generateText, stepCountIs } from "ai";
import "@/layers";
import { getModel } from "@/lib/agent/provider";
import { buildTools } from "@/lib/agent/tools";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";
import type { MapView } from "@/lib/agent/view";
import { parseMapView, systemForTurn } from "@/lib/agent/viewContext";


const model = process.env.MODEL_NAME ?? "(unset)";

type ToolCall = { toolName: string; output?: unknown };

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
      tools: buildTools(),
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
    const layerErrors = calls
      .filter((c) => c.toolName.startsWith("query_") && c.output && typeof c.output === "object" && "error" in (c.output as object))
      .map((c) => String((c.output as { error: string }).error).slice(0, 80));
    const tiles = calls.filter((c) => c.toolName.startsWith("query_") && isTiles(c.output)).length;
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
    // A query that drew something must have been rendered; an empty result or a layer
    // error only needs the note that explains it.
    // A question that names a place (no @view, so the model had to geocode it) must also move the
    // camera there with set_view; otherwise the data loads off-screen. @view questions are exempt.
    const movedToPlace = view !== null || !seq.includes("geocode") || seq.includes("set_view");
    const ok = routed && !queried ? noted : located && movedToPlace && queried && (drew ? rendered : true) && noted;

    return {
      ok,
      line: {
        question,
        ...(view ? { view: view.bbox, geocoded: seq.includes("geocode"), movedCamera: seq.includes("set_view") } : {}),
        model,
        ok,
        seq,
        features,
        tiles,
        layerErrors,
        tokens: { in: result.totalUsage.inputTokens, out: result.totalUsage.outputTokens },
        seconds: seconds(),
        finish: result.finishReason,
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
