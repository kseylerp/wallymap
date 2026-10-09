import type { Feature } from "geojson";
import { describe, expect, it } from "vitest";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type LoadedLayer, type MapAction, type MapState } from "@/lib/render/state";

const fire = (name: string, year: number): Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [-119.5, 37.8] },
  properties: { name, year, t: `${year}-07-01T00:00:00.000Z` },
});
const fires: LoadedLayer = {
  id: "fire-perimeters",
  title: "Fire perimeters",
  style: { geometry: "polygon", color: "#000000" },
  result: {
    kind: "geojson",
    data: { type: "FeatureCollection", features: [fire("Ferguson", 2018), fire("Washburn", 2022)] },
    citation: { source: "s", url: "u", retrieved: "r" },
  },
  receivedAt: "now",
};

function run(state: MapState, ...actions: MapAction[]): MapState {
  return actions.reduce(reduce, state);
}

const loaded = run(
  initialMapState,
  { type: "layer_loaded", layer: fires },
  { type: "render", op: { layerId: "fire-perimeters", mode: "polygons", visible: true } },
);
const spec = { layerId: "fire-perimeters", a: ["2016-01-01", "2020-12-31"] as [string, string], b: ["2021-01-01", "2026-10-09"] as [string, string] };

describe("compare actions", () => {
  it("set_compare starts a compare on side A, keeping the agent's labels", () => {
    const s = run(loaded, { type: "set_compare", compare: { ...spec, mode: "toggle", aLabel: "before", bLabel: "after" } });
    expect(s.compare).toEqual({ ...spec, mode: "toggle", aLabel: "before", bLabel: "after", side: "a" });
  });

  it("set_compare puts each window's ends in order", () => {
    const s = run(loaded, { type: "set_compare", compare: { ...spec, a: ["2020-12-31", "2016-01-01"], mode: "delta" } });
    expect(s.compare?.a).toEqual(["2016-01-01", "2020-12-31"]);
  });

  it("set_compare pauses the scrubber and drops a selection on the compared layer", () => {
    const playing = run(loaded, { type: "set_time_playing", playing: true }, {
      type: "select",
      selection: { layerId: "fire-perimeters", feature: fire("Ferguson", 2018), lngLat: [0, 0] },
    });
    expect(playing.time?.playing).toBe(true);
    const s = run(playing, { type: "set_compare", compare: { ...spec, mode: "swipe" } });
    expect(s.time?.playing).toBe(false);
    expect(s.time?.window).toEqual(playing.time?.window);
    expect(s.selected).toBeUndefined();
  });

  it("set_compare_mode switches the mode and goes back to side A", () => {
    const flipped = run(loaded, { type: "set_compare", compare: { ...spec, mode: "toggle" } }, { type: "compare_flip" });
    expect(flipped.compare?.side).toBe("b");
    const s = run(flipped, { type: "set_compare_mode", mode: "delta" });
    expect(s.compare).toMatchObject({ mode: "delta", side: "a" });
    expect(run(s, { type: "set_compare_mode", mode: "delta" })).toBe(s);
    expect(run(loaded, { type: "set_compare_mode", mode: "delta" })).toBe(loaded);
  });

  it("compare_flip alternates A and B", () => {
    const s = run(loaded, { type: "set_compare", compare: { ...spec, mode: "toggle" } });
    expect(run(s, { type: "compare_flip" }).compare?.side).toBe("b");
    expect(run(s, { type: "compare_flip" }, { type: "compare_flip" }).compare?.side).toBe("a");
    expect(run(loaded, { type: "compare_flip" })).toBe(loaded);
  });

  it("clear_compare ends it; removing the layer or clearing the map ends it too", () => {
    const s = run(loaded, { type: "set_compare", compare: { ...spec, mode: "swipe" } });
    expect(run(s, { type: "clear_compare" }).compare).toBeUndefined();
    expect(run(loaded, { type: "clear_compare" })).toBe(loaded);
    expect(run(s, { type: "remove_layer", layerId: "fire-perimeters" }).compare).toBeUndefined();
    expect(run(s, { type: "clear_layers" }).compare).toBeUndefined();
  });

  it("keeps the compare when another layer is removed", () => {
    const s = run(loaded, { type: "set_compare", compare: { ...spec, mode: "swipe" } }, { type: "remove_layer", layerId: "osm-trails" });
    expect(s.compare?.layerId).toBe("fire-perimeters");
  });
});
