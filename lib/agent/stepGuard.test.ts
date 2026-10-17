import { generateText, stepCountIs, streamText, wrapLanguageModel } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@/layers";
import type { BBox } from "@/layers/types";
import { stepGuard } from "./stepGuard";
import { buildTools } from "./tools";
import { createTurn, type Geocoder } from "./turn";
import type { MapView } from "./view";

// Layer queries answer from here (no network): one named point inside the asked box.
const runLayer = vi.hoisted(() => vi.fn());
vi.mock("@/lib/layers/run", () => ({ runLayer }));

const TAHOE: BBox = [-120.2, 38.9, -119.9, 39.3];
const SIERRA: BBox = [-121.5, 35.4, -117.9, 40.4];

beforeEach(() => {
  runLayer.mockReset();
  runLayer.mockImplementation(async (_id: string, { bbox }: { bbox: BBox }) => ({
    status: 200,
    body: {
      kind: "geojson",
      data: {
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry: { type: "Point", coordinates: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2] }, properties: { name: "Top Site", v: 9 } }],
      },
      citation: { source: "test", url: "https://example.com", retrieved: "2026-10-16" },
    },
  }));
});

const geocoder: Geocoder = vi.fn(async (place: string) => {
  if (/tahoe/i.test(place)) return { bbox: TAHOE, center: [-120.04, 39.1] as [number, number], name: "Lake Tahoe", source: "mapbox" as const };
  if (/sierra nevada/i.test(place)) return { bbox: SIERRA, center: [-119.7, 37.9] as [number, number], name: "Sierra Nevada", source: "natural-earth" as const };
  return { error: `No match for ${place}` };
});

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

type Reply = { calls?: { name: string; input: Record<string, unknown> }[]; text?: string };

/** A model that answers each step from `replies`, in order, and records the prompts it was sent. */
function scripted(replies: Reply[]) {
  let step = 0;
  const prompts: unknown[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(options.prompt);
      const reply = replies[Math.min(step, replies.length - 1)];
      step += 1;
      const calls = (reply.calls ?? []).map((c, i) => ({ type: "tool-call" as const, toolCallId: `m${step}-${i}`, toolName: c.name, input: JSON.stringify(c.input) }));
      return {
        content: [...(reply.text ? [{ type: "text" as const, text: reply.text }] : []), ...calls],
        finishReason: { unified: calls.length > 0 ? ("tool-calls" as const) : ("stop" as const), raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
  return { model, prompts };
}

async function run(question: string, replies: Reply[], view: MapView | null = null) {
  const turn = createTurn({ question, view, geocoder });
  const tools = buildTools({ view, turn });
  const { model, prompts } = scripted(replies);
  const result = await generateText({
    model: wrapLanguageModel({ model, middleware: stepGuard(turn, Object.keys(tools)) }),
    tools,
    prompt: question,
    stopWhen: stepCountIs(8),
  });
  const calls = result.steps.flatMap((s) => s.toolCalls.map((c) => ({ name: c.toolName, input: c.input as Record<string, unknown> })));
  return { turn, result, calls, prompts };
}

describe("step guard: queried but never drawn", () => {
  it("renders a layer queried and never drawn before a text-only ending, and the model answers after", async () => {
    const { calls, result, turn } = await run("What fires are here?", [
      { calls: [{ name: "query_fire-perimeters", input: { bbox: TAHOE } }] },
      { text: "Two fires burned here." },
      { text: "Two fires are drawn." },
    ], { bbox: TAHOE, zoom: 9, center: [-120.05, 39.1] });
    expect(calls.map((c) => c.name)).toEqual(["query_fire-perimeters", "render"]);
    expect(calls[1].input).toEqual({ layerId: "fire-perimeters" });
    expect(result.text).toBe("Two fires are drawn.");
    expect(turn.log.join("\n")).toMatch(/rendered fire-perimeters before the answer/);
  });

  it("renders it before the note when the note comes first", async () => {
    const { calls } = await run("What fires are here?", [
      { calls: [{ name: "query_fire-perimeters", input: { bbox: TAHOE } }, { name: "query_fire-detections", input: { bbox: TAHOE } }] },
      { calls: [{ name: "render", input: { layerId: "fire-detections" } }, { name: "note", input: { markdown: "Fires here." } }] },
      { text: "- Want older fires?" },
    ], { bbox: TAHOE, zoom: 9, center: [-120.05, 39.1] });
    expect(calls.map((c) => c.name)).toEqual(["query_fire-perimeters", "query_fire-detections", "render", "render", "note"]);
    expect(calls.filter((c) => c.name === "render").map((c) => c.input.layerId).sort()).toEqual(["fire-detections", "fire-perimeters"]);
  });

  it("does nothing when every queried layer was drawn", async () => {
    const { calls, turn } = await run("What fires are here?", [
      { calls: [{ name: "query_fire-perimeters", input: { bbox: TAHOE } }] },
      { calls: [{ name: "render", input: { layerId: "fire-perimeters" } }] },
      { calls: [{ name: "note", input: { markdown: "Fires here." } }] },
      { text: "- More?" },
    ], { bbox: TAHOE, zoom: 9, center: [-120.05, 39.1] });
    expect(calls.map((c) => c.name)).toEqual(["query_fire-perimeters", "render", "note"]);
    expect(turn.log).toEqual([]);
  });
});

describe("step guard: canonical tool names in the stream", () => {
  it("renames a garbled tool name before the stream leaves the server", async () => {
    const question = "Which uranium mines near the Navajo Nation score highest?";
    const turn = createTurn({ question, view: { bbox: [-112, 35, -107, 38], zoom: 6, center: [-109.5, 36.5] }, geocoder });
    const tools = buildTools({ view: turn.view, turn });
    let step = 0;
    type Part = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer P> ? P : never;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        step += 1;
        const parts: Part[] =
          step === 1
            ? [
                { type: "stream-start" as const, warnings: [] },
                { type: "tool-input-start" as const, id: "c1", toolName: "query_uranium<|channel|>commentary" },
                { type: "tool-input-delta" as const, id: "c1", delta: JSON.stringify({ bbox: [-112, 35, -107, 38] }) },
                { type: "tool-input-end" as const, id: "c1" },
                { type: "tool-call" as const, toolCallId: "c1", toolName: "query_uranium<|channel|>commentary", input: JSON.stringify({ bbox: [-112, 35, -107, 38] }) },
                { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
              ]
            : [
                { type: "stream-start" as const, warnings: [] },
                { type: "text-start" as const, id: "t" },
                { type: "text-delta" as const, id: "t", delta: "Done." },
                { type: "text-end" as const, id: "t" },
                { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
              ];
        return { stream: convertArrayToReadableStream(parts) };
      },
    });
    const result = streamText({
      model: wrapLanguageModel({ model, middleware: stepGuard(turn, Object.keys(tools)) }),
      tools,
      prompt: question,
      stopWhen: stepCountIs(4),
    });
    const chunks: { type: string; toolName?: string }[] = [];
    for await (const chunk of result.toUIMessageStream()) chunks.push(chunk as { type: string; toolName?: string });
    const names = chunks.flatMap((c) => (typeof c.toolName === "string" ? [c.toolName] : []));
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => !n.includes("<|"))).toBe(true);
    expect(names).toContain("query_uranium");
  });
});
