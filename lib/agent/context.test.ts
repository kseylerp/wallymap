import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import "@/layers";
import { contextForPrompt, contextFrom, followsUp } from "./context";
import { createTurn } from "./turn";

const history = (followUp: string): UIMessage[] => [
  { id: "u1", role: "user", parts: [{ type: "text", text: "Loop hikes under 6 miles with a waterfall near Asheville" }] },
  {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "tool-geocode", toolCallId: "g", state: "output-available", input: { place: "Asheville" }, output: { name: "Asheville, North Carolina", bbox: [-82.8, 35.5, -82.3, 35.8], center: [-82.55, 35.6] } },
      { type: "tool-query_osm-trails", toolCallId: "q", state: "output-available", input: { bbox: [-82.8, 35.5, -82.3, 35.8], zoom: 10 }, output: { kind: "geojson" } },
      {
        type: "tool-render",
        toolCallId: "r",
        state: "output-available",
        input: { layerId: "osm-trails" },
        output: { layerId: "osm-trails", view: "ranked", filters: { lengthKm: { range: [0, 9.66] }, shape: { include: ["loop"] } } },
      },
    ],
  } as UIMessage,
  { id: "u2", role: "user", parts: [{ type: "text", text: followUp }] },
];

describe("a follow-up keeps the last answer's place, layers and filters (docs/top-10-use-cases.md)", () => {
  it("reads what the last answer drew from the history", () => {
    const c = contextFrom(history("Show only the ones under 3 miles"))!;
    expect(c.place?.name).toBe("Asheville, North Carolina");
    expect(c.layers).toEqual([{ layerId: "osm-trails", input: {}, view: "ranked", filters: { lengthKm: { range: [0, 9.66] }, shape: { include: ["loop"] } } }]);
  });

  it("asks the same layers again, keeping the filters the question does not change", () => {
    const question = "Which of these are quiet on weekends?";
    const context = contextFrom(history(question));
    expect(followsUp(question, context)).toBe(true);
    const turn = createTurn({ question, context });
    expect(turn.reading.layers).toContainEqual(expect.objectContaining({ layerId: "osm-trails", strong: true }));
    expect(turn.reading.filters).toContainEqual(expect.objectContaining({ layerId: "osm-trails", key: "shape", include: ["loop"] }));
    expect(contextForPrompt(context!, question)).toMatch(/do not geocode again/);
  });

  it("is a new question when it names a place of its own", () => {
    const question = "Good day hikes near Bend";
    expect(followsUp(question, contextFrom(history(question)))).toBe(false);
  });
});
