import { generateText, stepCountIs, streamText, wrapLanguageModel } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@/layers";
import type { BBox } from "@/layers/types";
import { prepareStepFor } from "./agent";
import { leakedCalls, repeatReason, stepGuard } from "./stepGuard";
import { buildTools } from "./tools";
import { createTurn, MAX_STEPS, type Geocoder } from "./turn";
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

describe("step guard: a named place the model never looked up", () => {
  it("looks the place up first and runs the query on its box", async () => {
    const { calls } = await run("How deep is Lake Tahoe?", [
      { calls: [{ name: "query_lakes", input: { bbox: [-121, 38, -119, 40], name: "Lake Tahoe" } }] },
      { calls: [{ name: "render", input: { layerId: "lakes" } }, { name: "note", input: { markdown: "Lake Tahoe is 501 m deep." } }] },
      { text: "- More?" },
    ]);
    expect(calls.map((c) => c.name)).toEqual(["geocode", "query_lakes", "render", "note"]);
    expect(calls[0].input).toEqual({ place: "Lake Tahoe" });
    expect(calls[1].input.bbox).toEqual(TAHOE);
    expect(runLayer.mock.calls[0][1].bbox).toEqual(TAHOE);
  });

  it("uses the box of a geocode the model sent in the same step as its queries", async () => {
    const { calls } = await run("How deep is Lake Tahoe?", [
      { calls: [{ name: "geocode", input: { place: "Lake Tahoe, CA" } }, { name: "query_lakes", input: { bbox: [0, 0, 1, 1], name: "Lake Tahoe" } }] },
      { calls: [{ name: "note", input: { markdown: "Deep." } }] },
      { text: "- More?" },
    ]);
    expect(calls.filter((c) => c.name === "geocode")).toHaveLength(1);
    expect(calls.find((c) => c.name === "query_lakes")?.input.bbox).toEqual(TAHOE);
  });

  it("leaves a place inside the map view alone: the view is what the user means", async () => {
    const { calls } = await run("Any trails around Lake Tahoe?", [
      { calls: [{ name: "query_osm-trails", input: { bbox: TAHOE } }] },
      { calls: [{ name: "render", input: { layerId: "osm-trails" } }, { name: "note", input: { markdown: "Trails." } }] },
      { text: "- More?" },
    ], { bbox: [-120.5, 38.5, -119.5, 39.5], zoom: 8, center: [-120, 39] });
    expect(calls.map((c) => c.name)).toEqual(["query_osm-trails", "render", "note"]);
  });

  it("a question naming no place, with no view, is about the queried layer's own region (sequoia groves: the Sierra Nevada)", async () => {
    const { calls } = await run("Which sequoia groves burned in the 2020 and 2021 fires?", [
      { calls: [{ name: "query_sequoia-groves", input: { bbox: [-119, 36, -118, 37] } }] },
      { calls: [{ name: "render", input: { layerId: "sequoia-groves" } }, { name: "note", input: { markdown: "Groves." } }] },
      { text: "- More?" },
    ]);
    expect(calls.slice(0, 2).map((c) => c.name)).toEqual(["geocode", "query_sequoia-groves"]);
    expect(calls[0].input).toEqual({ place: "Sierra Nevada" });
    expect(calls[1].input.bbox).toEqual(SIERRA);
  });
});

describe("step guard: a smaller box after a wide answer", () => {
  const TEXAS: BBox = [-104, 29, -96, 35];
  it("drops the second query and asks the model again with the reason", async () => {
    const { calls, prompts, turn } = await run("wind farms in West Texas", [
      { calls: [{ name: "query_power-plants", input: { bbox: TEXAS } }] },
      { calls: [{ name: "render", input: { layerId: "power-plants" } }] },
      { calls: [{ name: "query_power-plants", input: { bbox: [-102, 31, -100, 33] } }] },
      { calls: [{ name: "note", input: { markdown: "Wind farms." } }] },
      { text: "- More?" },
    ], { bbox: TEXAS, zoom: 5, center: [-100, 32] });
    expect(calls.filter((c) => c.name === "query_power-plants")).toHaveLength(1);
    expect(calls.map((c) => c.name)).toEqual(["query_power-plants", "render", "note"]);
    expect(JSON.stringify(prompts[3])).toMatch(/already answered the whole area/);
    expect(turn.log.join("\n")).toMatch(/smaller box inside its wide answer was dropped/);
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

describe("near <town>: the layer kind's radius", () => {
  it("queries earthquakes within 50 km of the town the model geocoded, whatever box it passed", async () => {
    const mammoth: Geocoder = async () => ({ bbox: [-119.03, 37.6, -118.93, 37.67], center: [-118.97, 37.65], name: "Mammoth Lakes", source: "mapbox" });
    const question = "Recent earthquakes near Mammoth Lakes";
    const turn = createTurn({ question, view: null, geocoder: mammoth });
    const tools = buildTools({ view: null, turn });
    const options = { toolCallId: "t", messages: [], context: {} };
    await tools.geocode.execute!({ place: "Mammoth Lakes" } as never, options as never);
    await tools["query_earthquakes"].execute!({ bbox: [-121, 36, -117, 39], zoom: 8 } as never, options as never);
    const box = runLayer.mock.calls[0][1].bbox as BBox;
    expect(((box[3] - box[1]) * 111.32) / 2).toBeCloseTo(50, 0);
    expect(turn.log.join("\n")).toMatch(/near Mammoth Lakes/);
  });
});

describe("step guard: a tool call written as text", () => {
  it("parses a chat-template call the provider passed on as text", () => {
    expect(leakedCalls('<|start|>assistant<|channel|>commentary to=functions.geocode <|constrain|>={"place":"Navajo Nation"}<|call|>')).toEqual([
      { toolName: "geocode", input: { place: "Navajo Nation" } },
    ]);
    expect(leakedCalls('to=functions.query_uranium <|constrain|>json<|message|>{"bbox":[-112,35,-107,38]}<|call|>')).toEqual([
      { toolName: "query_uranium", input: { bbox: [-112, 35, -107, 38] } },
    ]);
    expect(leakedCalls("Lake Tahoe is 501 m deep.")).toEqual([]);
  });

  it("runs it as the call, and the turn goes on", async () => {
    const { calls, result } = await run("How deep is Lake Tahoe?", [
      { text: '<|start|>assistant<|channel|>commentary to=functions.geocode <|constrain|>={"place":"Lake Tahoe"}<|call|>' },
      { calls: [{ name: "query_lakes", input: { bbox: TAHOE, name: "Lake Tahoe" } }] },
      { calls: [{ name: "render", input: { layerId: "lakes" } }, { name: "note", input: { markdown: "Deep." } }] },
      { text: "- More?" },
    ]);
    expect(calls.map((c) => c.name)).toEqual(["geocode", "query_lakes", "render", "note"]);
    expect(result.text).toBe("- More?");
  });
});

describe("near <town>: only the place the query is about", () => {
  it("ignores an earlier lookup that found a same-named place elsewhere", async () => {
    const lookups: Record<string, { bbox: BBox; center: [number, number] }> = {
      "red river gorge": { bbox: [-120.0, 47.1, -119.9, 47.2], center: [-119.95, 47.15] },
      "red river gorge kentucky": { bbox: [-83.7, 37.75, -83.6, 37.85], center: [-83.65, 37.8] },
    };
    const g: Geocoder = async (place) => ({ ...lookups[place.toLowerCase().replace(/,/g, "")], name: place, source: "mapbox" });
    const turn = createTurn({ question: "Climbing crags near Red River Gorge", view: null, geocoder: g });
    const tools = buildTools({ view: null, turn });
    const options = { toolCallId: "t", messages: [], context: {} };
    await tools.geocode.execute!({ place: "Red River Gorge" } as never, options as never);
    await tools.geocode.execute!({ place: "Red River Gorge, Kentucky" } as never, options as never);
    await tools["query_climbing"].execute!({ bbox: [-83.8, 37.7, -83.5, 37.9], zoom: 10 } as never, options as never);
    const box = runLayer.mock.calls[0][1].bbox as BBox;
    expect((box[0] + box[2]) / 2).toBeCloseTo(-83.65, 1);
  });
});

describe("step guard: one line per way (popularity colours the trails)", () => {
  it("drops popularity when the question does not ask how popular", async () => {
    const { calls, turn } = await run("Show hiking trails around Lake Tahoe", [
      { calls: [{ name: "geocode", input: { place: "Lake Tahoe" } }] },
      { calls: [{ name: "query_osm-trails", input: { bbox: TAHOE } }, { name: "query_popularity", input: { bbox: TAHOE } }] },
      { calls: [{ name: "render", input: { layerId: "osm-trails" } }, { name: "note", input: { markdown: "Trails." } }] },
      { text: "- More?" },
    ]);
    expect(calls.map((c) => c.name)).toEqual(["geocode", "query_osm-trails", "render", "note"]);
    expect(turn.log.join("\n")).toMatch(/popularity: dropped/);
  });

  it("keeps popularity when asked, and does not draw osm-trails over it afterwards", async () => {
    const { calls } = await run("Which trails around Lake Tahoe are the most popular?", [
      { calls: [{ name: "geocode", input: { place: "Lake Tahoe" } }] },
      { calls: [{ name: "query_popularity", input: { bbox: TAHOE } }] },
      { calls: [{ name: "query_osm-trails", input: { bbox: TAHOE } }] },
      { calls: [{ name: "render", input: { layerId: "popularity" } }, { name: "note", input: { markdown: "Rubicon Trail is top." } }] },
      { text: "- More?" },
    ]);
    expect(calls.map((c) => c.name)).toEqual(["geocode", "query_popularity", "render", "note"]);
  });
});

describe("step guard: no asking again (shrinking, repeats, failures, the step budget)", () => {
  const NEVADA: BBox = [-120, 35, -114, 42];
  const RENO: BBox = [-120, 39.3, -119.3, 40.6];
  const tooWide = async () => ({ status: 422, body: { error: "Area is 402280 km²; zoom in to under 60000 km²", hint: "zoom_in" } });

  it("never queries a part of a box the layer said was over its limit (the Nevada mines turn)", async () => {
    runLayer.mockImplementation(tooWide);
    const { calls, prompts, turn } = await run("Where are most of the old mines in Nevada?", [
      { calls: [{ name: "query_mines", input: { bbox: NEVADA } }] },
      { calls: [{ name: "query_mines", input: { bbox: RENO } }] },
      { calls: [{ name: "note", input: { markdown: "Mines records need a smaller area than Nevada." } }] },
      { text: "- Zoom to a district?" },
    ], { bbox: NEVADA, zoom: 6, center: [-117, 38.5] });
    expect(calls.filter((c) => c.name === "query_mines")).toHaveLength(1);
    // Mines' wider-scale layer (geology) answers the whole state instead of the part.
    expect(calls.find((c) => c.name === "query_geology")?.input.bbox).toEqual(NEVADA);
    expect(turn.log.join("\n")).toMatch(/mines: a part of a box over its limit was asked; query_geology answers the whole box instead/);
    void prompts;
  });

  it("answers the whole place at this scale instead: species over Colorado becomes GBIF density, not a smaller box", async () => {
    const COLORADO: BBox = [-109.06, 36.99, -102.04, 41.0];
    runLayer.mockImplementation(async (id: string, { bbox }: { bbox: BBox }) =>
      id === "species"
        ? { status: 422, body: { error: "Area is 269282 km²; zoom in to under 200000 km²", hint: "zoom_in" } }
        : { status: 200, body: { kind: "geojson", data: { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2] }, properties: { name: "Puma concolor" } }] }, citation: { source: "t", url: "https://e.x", retrieved: "2026" } } },
    );
    const { calls, turn } = await run("Where are the most iNaturalist or GBIF records of mountain lions in Colorado?", [
      { calls: [{ name: "query_species", input: { bbox: COLORADO, taxon: "mountain lion" } }] },
      { calls: [{ name: "query_species", input: { bbox: [-106, 38, -104, 40], taxon: "mountain lion" } }] },
      { calls: [{ name: "note", input: { markdown: "Mountain lion records." } }] },
      { text: "- More?" },
    ], { bbox: COLORADO, zoom: 6, center: [-105.5, 39] });
    const gbif = calls.find((c) => c.name === "query_gbif-occurrences");
    expect(gbif?.input).toMatchObject({ density: true, bbox: COLORADO });
    expect(calls.filter((c) => c.name === "query_species")).toHaveLength(1);
    expect(turn.log.join("\n")).toMatch(/query_gbif-occurrences answers the whole box instead/);
  });

  it("writes the note itself when the model only asks again for dropped queries", async () => {
    runLayer.mockImplementation(tooWide);
    const { calls, prompts } = await run("Where are the most groundwater wells in Nevada?", [
      { calls: [{ name: "query_groundwater", input: { bbox: NEVADA } }] },
      { calls: [{ name: "query_groundwater", input: { bbox: RENO } }] },
      { calls: [{ name: "query_groundwater", input: { bbox: [-118, 39, -117, 40] } }] },
      { text: "- Zoom in?" },
    ], { bbox: NEVADA, zoom: 6, center: [-117, 38.5] });
    expect(calls.filter((c) => c.name === "query_groundwater")).toHaveLength(1);
    expect(JSON.stringify(prompts)).toMatch(/over its area limit, and a smaller box inside it/);
    const note = calls.find((c) => c.name === "note");
    expect(String(note?.input.markdown)).toMatch(/Groundwater levels\*\* covers at most [\d,]+ km² at a time, and this area is/);
  });

  it("drops the same query on a box it already answered, in a later step or the same one", async () => {
    const { calls } = await run("Which large fires burned in Oregon in 2020?", [
      { calls: [{ name: "query_fire-perimeters", input: { bbox: TAHOE, minAcres: 1000 } }, { name: "query_fire-perimeters", input: { bbox: [-120.1, 39, -120, 39.1], minAcres: 1000 } }] },
      { calls: [{ name: "query_fire-perimeters", input: { bbox: TAHOE, minAcres: 1000 } }, { name: "render", input: { layerId: "fire-perimeters" } }] },
      { calls: [{ name: "note", input: { markdown: "Fires." } }] },
      { text: "- More?" },
    ], { bbox: TAHOE, zoom: 9, center: [-120.04, 39.1] });
    expect(calls.filter((c) => c.name === "query_fire-perimeters")).toHaveLength(1);
  });

  it("stops a layer that failed twice, and one asked three times", async () => {
    runLayer.mockImplementation(async () => ({ status: 503, body: { error: "ArcGIS service returned 404", hint: "upstream" } }));
    const boxes: BBox[] = [[-110, 38, -109.9, 38.1], [-110.5, 38, -110.4, 38.1], [-111, 38, -110.9, 38.1]];
    const failing = await run("Active mining claims near Moab", [
      ...boxes.map((bbox) => ({ calls: [{ name: "query_mining-claims", input: { bbox } }] })),
      { calls: [{ name: "note", input: { markdown: "Claims are unavailable." } }] },
      { text: "- Try later?" },
    ], { bbox: [-111, 38, -109, 39], zoom: 8, center: [-110, 38.5] });
    expect(failing.calls.filter((c) => c.name === "query_mining-claims")).toHaveLength(2);
  });

  it("offers only drawing and the note in the last two steps, and only the note on the last", async () => {
    const turn = createTurn({ question: "Where are most of the old mines in Nevada?" });
    const prepare = prepareStepFor(turn, ["query_mines", "render", "compare", "note", "geocode"]);
    expect(prepare({ stepNumber: 3 })).toEqual({});
    expect(prepare({ stepNumber: MAX_STEPS - 2 })).toEqual({ activeTools: ["render", "compare", "note"] });
    expect(prepare({ stepNumber: MAX_STEPS - 1 })).toEqual({ activeTools: ["note"], toolChoice: "required" });
    turn.noted = true;
    expect(prepare({ stepNumber: MAX_STEPS - 1 })).toEqual({});
  });

  it("drops a query proposed in the last two steps before a note", () => {
    const turn = createTurn({ question: "Where are most of the old mines in Nevada?" });
    turn.step = MAX_STEPS - 2;
    const reason = repeatReason({ toolCallId: "x", toolName: "query_mines", input: { bbox: RENO } }, turn, [], true);
    expect(reason?.why).toBe("two steps left and no note yet");
  });
});
