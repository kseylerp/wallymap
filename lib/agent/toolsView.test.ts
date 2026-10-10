import { describe, expect, it, vi } from "vitest";
import type { Tool } from "ai";
import "@/layers";
import type { BBox } from "@/layers/types";
import { buildTools, isWithinView } from "@/lib/agent/tools";

vi.mock("@/lib/agent/geocode", () => ({
  geocode: vi.fn(async () => ({ bbox: [24, 56.8, 24.3, 57], center: [24.1, 56.9], name: "Riga" })),
}));

const callOptions = { toolCallId: "test-call", messages: [], context: {} };

async function run(t: Tool, input: unknown): Promise<unknown> {
  if (!t.execute) throw new Error("tool has no execute");
  return await t.execute(input as never, callOptions);
}

// The owner's screenshot: the whole Baltic at zoom 5.9, far over the trails layer's 2,500 km² cap.
const BALTIC: BBox = [20, 54, 30, 60];
const view = { bbox: BALTIC, zoom: 5.9, center: [25, 57] as [number, number] };

describe("query tools answering from the current view", () => {
  it("add suggestedZoom to an area-cap error for the view's own box", async () => {
    const tools = buildTools({ view });
    const result = await run(tools["query_osm-trails"], { bbox: BALTIC, zoom: 6, namedOnly: false });
    expect(result).toMatchObject({ hint: "zoom_in", suggestedZoom: 10 });
  });

  it("measure the suggestion on the view even when the model passed a part of it", async () => {
    const tools = buildTools({ view });
    const result = await run(tools["query_osm-trails"], { bbox: [22.5, 55.5, 27.5, 58.5], zoom: 6, namedOnly: false });
    expect(result).toMatchObject({ hint: "zoom_in", suggestedZoom: 10 });
  });

  it("leave it out for a box elsewhere, with no view, or after a geocode this turn", async () => {
    const elsewhere = await run(buildTools({ view })["query_osm-trails"], { bbox: [-125, 30, -110, 45], zoom: 5, namedOnly: false });
    expect(elsewhere).toMatchObject({ hint: "zoom_in" });
    expect(elsewhere).not.toHaveProperty("suggestedZoom");

    const noView = await run(buildTools()["query_osm-trails"], { bbox: BALTIC, zoom: 6, namedOnly: false });
    expect(noView).not.toHaveProperty("suggestedZoom");

    const tools = buildTools({ view });
    await run(tools.geocode, { place: "Latvia" });
    const named = await run(tools["query_osm-trails"], { bbox: BALTIC, zoom: 6, namedOnly: false });
    expect(named).toMatchObject({ hint: "zoom_in" });
    expect(named).not.toHaveProperty("suggestedZoom");
  });
});

describe("isWithinView", () => {
  it("accepts the view, a part of it and a box rounded a little past it; rejects a box elsewhere", () => {
    expect(isWithinView(BALTIC, BALTIC)).toBe(true);
    expect(isWithinView([22, 55, 28, 59], BALTIC)).toBe(true);
    expect(isWithinView([19.9, 53.95, 30.1, 60.05], BALTIC)).toBe(true);
    expect(isWithinView([10, 54, 20, 60], BALTIC)).toBe(false);
  });
});
