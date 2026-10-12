import { describe, expect, it, vi } from "vitest";
import type { Tool } from "ai";
import "@/layers";
import type { BBox } from "@/layers/types";
import { listLayers } from "@/layers/registry";
import { WIDER_SCALE, buildTools, isWithinView, widerScaleFor } from "@/lib/agent/tools";

vi.mock("@/lib/agent/geocode", () => ({
  geocode: vi.fn(async () => ({ bbox: [24, 56.8, 24.3, 57], center: [24.1, 56.9], name: "Riga" })),
}));

const callOptions = { toolCallId: "test-call", messages: [], context: {} };

async function run(t: Tool, input: unknown): Promise<unknown> {
  if (!t.execute) throw new Error("tool has no execute");
  return await t.execute(input as never, callOptions);
}

// The owner's screenshot was the whole Baltic at zoom 5.9 ([20, 54, 30, 60], about 402,000 km²). The trails layer now
// answers up to 400,000 km² with named routes, so these use the Baltic Sea and its shores, far over that cap.
const BALTIC: BBox = [10, 50, 35, 66];
const view = { bbox: BALTIC, zoom: 4.6, center: [22.5, 58] as [number, number] };

describe("query tools answering from the current view", () => {
  it("add suggestedZoom to an area-cap error for the view's own box", async () => {
    const tools = buildTools({ view });
    const result = await run(tools["query_osm-trails"], { bbox: BALTIC, zoom: 5, namedOnly: false });
    expect(result).toMatchObject({ hint: "zoom_in", suggestedZoom: 6 });
  });

  it("measure the suggestion on the view even when the model passed a part of it", async () => {
    const tools = buildTools({ view });
    const result = await run(tools["query_osm-trails"], { bbox: [15, 52, 30, 63], zoom: 5, namedOnly: false });
    expect(result).toMatchObject({ hint: "zoom_in", suggestedZoom: 6 });
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

// The owner's Tierra del Fuego view ("great hikes around here", no place named) is about 298,000 km², which the trails
// layer now answers with named routes; all of Patagonia is still too wide for it.
const PATAGONIA: BBox = [-76, -56, -62, -38];

describe("zoom_in errors for the current view name layers that answer at this scale", () => {
  it("osm-trails over all of Patagonia offers the protected-areas tiles, not US-only or capped layers", async () => {
    const tools = buildTools({ view: { bbox: PATAGONIA, zoom: 4, center: [-69, -47] } });
    const result = await run(tools["query_osm-trails"], { bbox: PATAGONIA, zoom: 4, namedOnly: false });
    expect(result).toMatchObject({ hint: "zoom_in", widerScale: ["query_protected-areas-world"] });
  });

  it("keeps layers whose cap fits a smaller view, and passes the input a layer needs", () => {
    const fuego: BBox = [-68.5, -55, -67, -54.5];
    expect(widerScaleFor("osm-trails", fuego)).toEqual([
      "query_peaks",
      'query_outdoor-features with kinds: ["hut","viewpoint","waterfall"]',
      "query_protected-areas-world",
    ]);
    // Huts, viewpoints and waterfalls fit a small country (French Guiana, about 136,000 km²); peaks do not.
    expect(widerScaleFor("osm-trails", [-54.6, 2.1, -51.6, 5.8])).toEqual([
      'query_outdoor-features with kinds: ["hut","viewpoint","waterfall"]',
      "query_protected-areas-world",
    ]);
    expect(widerScaleFor("species", PATAGONIA)).toEqual(["query_gbif-occurrences with density: true"]);
    expect(widerScaleFor("campsites", [-112, 37, -109, 40])).toContain("query_public-lands");
  });

  it("is left out when the query was not about the view", async () => {
    const named = await run(buildTools()["query_osm-trails"], { bbox: PATAGONIA, zoom: 5, namedOnly: false });
    expect(named).not.toHaveProperty("widerScale");
  });

  it("only names registered layers, and each query tool says what to use at a wider scale", () => {
    const ids = listLayers().map((l) => l.id);
    for (const [id, hints] of Object.entries(WIDER_SCALE)) {
      expect(ids).toContain(id);
      for (const hint of hints) expect(ids).toContain(hint.layerId);
    }
    expect(buildTools()["query_osm-trails"].description).toContain(
      "At a wider scale, use peaks, outdoor-features with kinds hut/viewpoint/waterfall, recreation-sites, protected-areas-world.",
    );
  });

  it("never sends hiking questions to where people live, and always asks outdoor-features for its wide kinds", () => {
    const hiking = ["osm-trails", "popularity", "photos", "wikipedia-nearby", "campsites", "outdoor-features", "recreation-sites", "peaks", "mtb-trails"];
    for (const id of hiking) {
      const ids = (WIDER_SCALE[id] ?? []).map((h) => h.layerId);
      expect(ids, id).not.toContain("population");
      expect(ids, id).not.toContain("night-lights");
    }
    for (const hints of Object.values(WIDER_SCALE)) {
      for (const hint of hints.filter((h) => h.layerId === "outdoor-features")) {
        expect(hint.input).toEqual({ kinds: ["hut", "viewpoint", "waterfall"] });
      }
    }
  });
});

describe("isWithinView", () => {
  const BALTIC: BBox = [20, 54, 30, 60];
  it("accepts the view, a part of it and a box rounded a little past it; rejects a box elsewhere", () => {
    expect(isWithinView(BALTIC, BALTIC)).toBe(true);
    expect(isWithinView([22, 55, 28, 59], BALTIC)).toBe(true);
    expect(isWithinView([19.9, 53.95, 30.1, 60.05], BALTIC)).toBe(true);
    expect(isWithinView([10, 54, 20, 60], BALTIC)).toBe(false);
  });
});
