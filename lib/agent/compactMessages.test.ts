import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { compactMessages } from "./compactMessages";

const citation = { source: "OSM", url: "https://www.openstreetmap.org/copyright", retrieved: "2026-10-09T00:00:00Z" };
const fullResult = {
  kind: "geojson",
  data: {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { name: "Rim" }, geometry: { type: "Point", coordinates: [-120, 39] } }],
  },
  citation,
};

function message(parts: unknown[]): UIMessage {
  return { id: "a1", role: "assistant", parts } as UIMessage;
}

describe("compactMessages", () => {
  it("replaces a finished query output with its summary and leaves the original intact", () => {
    const original = message([
      { type: "text", text: "Here are trails." },
      { type: "tool-query_osm-trails", toolCallId: "c1", state: "output-available", input: {}, output: fullResult },
    ]);
    const [compacted] = compactMessages([original]);
    const part = compacted.parts[1] as { output: Record<string, unknown> };
    expect(part.output).toMatchObject({ kind: "geojson", featureCount: 1 });
    expect(part.output).not.toHaveProperty("data");
    expect(compacted.parts[0]).toBe(original.parts[0]);
    expect((original.parts[1] as { output: unknown }).output).toBe(fullResult);
  });

  it("leaves other tools, errors and unfinished parts untouched", () => {
    const original = message([
      { type: "tool-set_view", toolCallId: "c1", state: "output-available", input: {}, output: { bbox: [0, 0, 1, 1] } },
      { type: "tool-query_osm-trails", toolCallId: "c2", state: "output-available", input: {}, output: { error: "x" } },
      { type: "tool-query_osm-trails", toolCallId: "c3", state: "input-available", input: {} },
    ]);
    expect(compactMessages([original])[0]).toBe(original);
  });
});
