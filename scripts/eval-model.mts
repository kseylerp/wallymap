/**
 * Run one question through the real agent (system prompt + generated tools)
 * against the model named by MODEL_NAME, and print what happened.
 *
 *   MODEL_NAME=qwen/qwen3.7-flash pnpm exec tsx scripts/eval-model.mts "Show hiking trails around Lake Tahoe"
 *
 * Prints a JSON line: model, ok, tool sequence, feature count, errors, tokens, seconds.
 * "ok" means: geocode and a query tool ran, a render op was issued, at least one
 * feature came back (or the model handled a layer error and still wrote a note),
 * and the run finished without throwing.
 */
import { generateText, stepCountIs } from "ai";
import "@/layers";
import { getModel } from "@/lib/agent/provider";
import { buildTools } from "@/lib/agent/tools";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";

const question = process.argv.slice(2).join(" ") || "Show hiking trails around Lake Tahoe";
const model = process.env.MODEL_NAME ?? "(unset)";
const started = Date.now();

type ToolCall = { toolName: string; output?: unknown };

function featureCount(output: unknown): number | null {
  if (!output || typeof output !== "object") return null;
  const o = output as { kind?: string; data?: { features?: unknown[] } };
  if (o.kind === "geojson" && Array.isArray(o.data?.features)) return o.data.features.length;
  return null;
}

try {
  const result = await generateText({
    model: getModel(),
    system: SYSTEM_PROMPT,
    tools: buildTools(),
    prompt: question,
    stopWhen: stepCountIs(8),
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
  const queried = seq.some((t) => t.startsWith("query_"));
  const rendered = seq.includes("render");
  const noted = seq.includes("note") || result.text.trim().length > 40;
  const ok = seq.includes("geocode") && queried && (features.some((n) => n > 0) ? rendered : layerErrors.length > 0) && noted;

  console.log(
    JSON.stringify({
      model,
      ok,
      seq,
      features,
      layerErrors,
      tokens: { in: result.totalUsage.inputTokens, out: result.totalUsage.outputTokens },
      seconds: Math.round((Date.now() - started) / 100) / 10,
      finish: result.finishReason,
      textStart: result.text.replace(/\s+/g, " ").slice(0, 120),
    }),
  );
} catch (err) {
  console.log(
    JSON.stringify({ model, ok: false, error: err instanceof Error ? err.message.slice(0, 200) : String(err), seconds: Math.round((Date.now() - started) / 100) / 10 }),
  );
  process.exitCode = 1;
}
