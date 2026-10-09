import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { LIST_LAYERS_STUB, compactMessages } from "./compactMessages";

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

  it("replaces a finished route output with the route minus its line, keeping errors as they are", () => {
    const route = {
      id: "walking-tahoe-city-to-emerald-bay",
      name: "Tahoe City to Emerald Bay",
      line: { type: "LineString", coordinates: [[-120.14, 39.17], [-120.12, 39.05], [-120.1, 38.95]] },
      distanceKm: 27.34,
      resolved: { from: "Tahoe City, California", to: "Emerald Bay, California" },
    };
    const original = message([
      { type: "tool-route", toolCallId: "r1", state: "output-available", input: {}, output: route },
      { type: "tool-route", toolCallId: "r2", state: "output-available", input: {}, output: { error: "No route found" } },
    ]);
    const [compacted] = compactMessages([original]);
    expect((compacted.parts[0] as { output: unknown }).output).toEqual({
      id: "walking-tahoe-city-to-emerald-bay",
      name: "Tahoe City to Emerald Bay",
      distanceKm: 27.34,
      resolved: { from: "Tahoe City, California", to: "Emerald Bay, California" },
      pointCount: 3,
    });
    expect(compacted.parts[1]).toBe(original.parts[1]);
    expect((original.parts[0] as { output: unknown }).output).toBe(route);
    // Compacting twice changes nothing more.
    expect(compactMessages([compacted])[0]).toBe(compacted);
  });

  it("collapses an earlier list_layers output to a one-line stub", () => {
    const rows = [{ id: "osm-trails", title: "OpenStreetMap trails", coverage: "worldwide", available: true, synonyms: "trail" }];
    const original = message([{ type: "tool-list_layers", toolCallId: "c1", state: "output-available", input: {}, output: rows }]);
    const [compacted] = compactMessages([original]);
    expect((compacted.parts[0] as { output: unknown }).output).toBe(LIST_LAYERS_STUB);
    expect(LIST_LAYERS_STUB).not.toContain("\n");
    // Already compacted: returned as is.
    expect(compactMessages([compacted])[0]).toBe(compacted);
  });
});
