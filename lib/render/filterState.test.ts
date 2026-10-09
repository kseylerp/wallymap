import type { Feature } from "geojson";
import { describe, expect, it } from "vitest";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type LoadedLayer, type MapAction, type MapState } from "@/lib/render/state";
import { isSelectionVisible, visibleState } from "@/lib/render/view";

const feat = (props: Record<string, unknown>): Feature => ({
  type: "Feature",
  geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
  properties: props,
});
const SCALES = ["hiking", "mountain_hiking", "alpine_hiking"];
const trails: LoadedLayer = {
  id: "osm-trails",
  title: "Trails",
  style: { geometry: "line", color: "#000000" },
  result: {
    kind: "geojson",
    citation: { source: "s", url: "u", retrieved: "r" },
    data: {
      type: "FeatureCollection",
      features: Array.from({ length: 9 }, (_, k) =>
        feat({ name: `T${k}`, sac_scale: SCALES[k % 3], t: `${2016 + k}-01-01T00:00:00.000Z` }),
      ),
    },
  },
  receivedAt: "now",
};

function run(state: MapState, ...actions: MapAction[]): MapState {
  return actions.reduce(reduce, state);
}
const base = run(
  initialMapState,
  { type: "layer_loaded", layer: trails },
  { type: "render", op: { layerId: "osm-trails", mode: "lines", visible: true } },
);
const names = (s: MapState) => {
  const r = visibleState(s).layers["osm-trails"].result;
  return r.kind === "geojson" ? r.data.features.map((f) => f.properties?.name) : [];
};
const alpine = { sac_scale: { include: ["alpine_hiking"] } };

describe("set_filters and the visible view", () => {
  it("narrows a layer to the features passing its filters", () => {
    const s = run(base, { type: "set_filters", layerId: "osm-trails", filters: alpine });
    expect(s.renderOps[0].filters).toEqual(alpine);
    expect(names(s)).toEqual(["T2", "T5", "T8"]);
  });

  it("clears with {} or only empty entries, and ignores unknown layers", () => {
    const s = run(base, { type: "set_filters", layerId: "osm-trails", filters: alpine });
    expect(run(s, { type: "set_filters", layerId: "osm-trails", filters: {} }).renderOps[0].filters).toBeUndefined();
    expect(run(s, { type: "set_filters", layerId: "osm-trails", filters: { sac_scale: { include: [] } } }).renderOps[0].filters).toBeUndefined();
    expect(run(s, { type: "set_filters", layerId: "nope", filters: alpine })).toBe(s);
  });

  it("a render without filters keeps the panel's; a render with filters replaces them", () => {
    const s = run(base, { type: "set_filters", layerId: "osm-trails", filters: alpine });
    const restyled = run(s, { type: "render", op: { layerId: "osm-trails", mode: "heat", visible: true } });
    expect(restyled.renderOps[0].filters).toEqual(alpine);
    const replaced = run(s, { type: "render", op: { layerId: "osm-trails", mode: "lines", visible: true, filters: {} } });
    expect(replaced.renderOps[0].filters).toBeUndefined();
  });

  it("combines with the time window", () => {
    const s = run(
      base,
      { type: "set_filters", layerId: "osm-trails", filters: alpine },
      { type: "set_time_window", window: ["2019-01-01T00:00:00.000Z", "2024-12-31T23:59:59.999Z"] },
    );
    expect(names(s)).toEqual(["T5", "T8"]);
  });

  it("memoizes per layer, filters and window", () => {
    const a = run(base, { type: "set_filters", layerId: "osm-trails", filters: alpine });
    const b = run(a, { type: "set_view", viewport: { zoom: 3 } });
    const dataOf = (s: MapState) => visibleState(s).layers["osm-trails"].result;
    expect(dataOf(b)).toBe(dataOf(a));
    const c = run(a, { type: "set_filters", layerId: "osm-trails", filters: { sac_scale: { include: ["hiking"] } } });
    expect(dataOf(c)).not.toBe(dataOf(a));
  });

  it("closes the inspect card for a feature the filters hide", () => {
    const s = run(base, { type: "set_filters", layerId: "osm-trails", filters: alpine });
    const features = trails.result.kind === "geojson" ? trails.result.data.features : [];
    expect(isSelectionVisible(s, { layerId: "osm-trails", feature: features[2], lngLat: [0, 0] })).toBe(true);
    expect(isSelectionVisible(s, { layerId: "osm-trails", feature: features[0], lngLat: [0, 0] })).toBe(false);
  });
});

describe("a re-query and the filters", () => {
  const filtered = run(base, { type: "set_filters", layerId: "osm-trails", filters: { sac_scale: { include: ["alpine_hiking"] } } });
  const requery = { ...trails, receivedAt: "later" };

  it("clears the previous filters when the same layer loads again (they may match none of the new features)", () => {
    expect(filtered.renderOps[0].filters).toBeDefined();
    const s = run(filtered, { type: "layer_loaded", layer: requery }, { type: "render", op: { layerId: "osm-trails", mode: "lines", visible: true } });
    expect(s.renderOps[0].filters).toBeUndefined();
    expect(names(s)).toHaveLength(9);
  });

  it("keeps the filters the re-query's render op sends", () => {
    const s = run(
      filtered,
      { type: "layer_loaded", layer: requery },
      { type: "render", op: { layerId: "osm-trails", mode: "lines", visible: true, filters: { sac_scale: { include: ["hiking"] } } } },
    );
    expect(s.renderOps[0].filters).toEqual({ sac_scale: { include: ["hiking"] } });
  });

  it("leaves other layers' filters alone", () => {
    const other = { ...trails, id: "forest-roads" };
    const s = run(filtered, { type: "layer_loaded", layer: other });
    expect(s.renderOps[0].filters).toEqual({ sac_scale: { include: ["alpine_hiking"] } });
  });
});
