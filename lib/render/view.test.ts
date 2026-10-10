import type { Feature, FeatureCollection } from "geojson";
import { describe, expect, it } from "vitest";
import type { TileTime } from "@/layers/types";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type LoadedLayer, type MapAction, type MapState } from "@/lib/render/state";
import { featureCounts, isSelectionVisible, variantsKept, visibleState } from "@/lib/render/view";

const feat = (props: Record<string, unknown>): Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [0, 0] },
  properties: props,
});
const geo = (id: string, features: Feature[]): LoadedLayer => ({
  id,
  title: id,
  style: { geometry: "point", color: "#000000" },
  result: { kind: "geojson", data: { type: "FeatureCollection", features }, citation: { source: "s", url: "u", retrieved: "r" } },
  receivedAt: "now",
});
const raster = (id: string, url: string, time?: TileTime): LoadedLayer =>
  ({
    id,
    title: id,
    style: { geometry: "polygon", color: "#000000" },
    result: { kind: "tiles", data: { url, minzoom: 0, maxzoom: 12, format: "raster", ...(time && { time }) }, citation: { source: "s", url: "u", retrieved: "r" } },
    receivedAt: "now",
  }) as LoadedLayer;

const fires = geo(
  "fire-perimeters",
  Array.from({ length: 12 }, (_, k) => feat({ name: `F${k}`, t: `${2014 + k}-07-01T00:00:00.000Z`, acres: 100 * k })),
);
const undated = geo("osm-trails", [feat({ name: "A" }), feat({ name: "B" })]);
const loss = raster("forest-loss", "https://tiles.test/{z}/{x}/{y}.png?start_year=2001&end_year=2024", {
  template: "https://tiles.test/{z}/{x}/{y}.png?start_year=2001&end_year={year}",
  cadence: "yearly",
  from: "2001",
  to: "2025",
});

function run(state: MapState, ...actions: MapAction[]): MapState {
  return actions.reduce(reduce, state);
}

const base = run(
  initialMapState,
  { type: "layer_loaded", layer: fires },
  { type: "layer_loaded", layer: undated },
  { type: "layer_loaded", layer: loss },
);
const dataOf = (s: MapState, id: string) => {
  const r = s.layers[id].result;
  return r.kind === "geojson" ? r.data : null;
};
const urlOf = (s: MapState, id: string) => {
  const r = s.layers[id].result;
  return r.kind === "tiles" ? r.data.url : null;
};

describe("visibleState", () => {
  it("returns the state itself when nothing narrows it", () => {
    const plain = run(initialMapState, { type: "layer_loaded", layer: undated });
    expect(visibleState(plain)).toBe(plain);
    // The scrubber's opening window covers everything, so it changes nothing either (tiles keep their URL).
    expect(visibleState(base)).toBe(base);
  });

  it("drops dated features outside the window and keeps undated features and layers", () => {
    const s = run(base, { type: "set_time_window", window: ["2019-01-01T00:00:00.000Z", "2020-12-31T23:59:59.999Z"] });
    const view = visibleState(s);
    expect((dataOf(view, "fire-perimeters") as FeatureCollection).features.map((f) => f.properties?.name)).toEqual(["F5", "F6"]);
    expect(view.layers["osm-trails"]).toBe(s.layers["osm-trails"]);
    expect(featureCounts(s, "fire-perimeters")).toEqual({ shown: 2, total: 12 });
    expect(featureCounts(s, "forest-loss")).toBeNull();
  });

  it("points a time-aware tile layer at the window's end once the window is narrowed", () => {
    const s = run(base, { type: "set_time_window", window: ["2014-01-01T00:00:00.000Z", "2018-12-31T23:59:59.999Z"] });
    expect(urlOf(visibleState(s), "forest-loss")).toBe("https://tiles.test/{z}/{x}/{y}.png?start_year=2001&end_year=2018");
  });

  it("memoizes: the same state gives the same view, the same window the same data object", () => {
    const window: [string, string] = ["2016-01-01T00:00:00.000Z", "2016-12-31T23:59:59.999Z"];
    const a = run(base, { type: "set_time_window", window });
    expect(visibleState(a)).toBe(visibleState(a));
    // A different state object (the viewport moved) with the same window reuses the derived data.
    const b = run(a, { type: "set_view", viewport: { zoom: 5 } });
    expect(dataOf(visibleState(b), "fire-perimeters")).toBe(dataOf(visibleState(a), "fire-perimeters"));
  });

  it("hides the inspect card for a feature the window leaves out", () => {
    const s = run(base, { type: "set_time_window", window: ["2019-01-01T00:00:00.000Z", "2019-12-31T23:59:59.999Z"] });
    const [inside, outside] = [fires.result, fires.result].map((r, k) =>
      r.kind === "geojson" ? r.data.features[k === 0 ? 5 : 0] : undefined,
    ) as Feature[];
    expect(isSelectionVisible(s, { layerId: "fire-perimeters", feature: inside, lngLat: [0, 0] })).toBe(true);
    expect(isSelectionVisible(s, { layerId: "fire-perimeters", feature: outside, lngLat: [0, 0] })).toBe(false);
  });
});

describe("variantsKept", () => {
  it("keeps 64 versions of a small layer and fewer of a dense one, never under 8", () => {
    expect(variantsKept(0)).toBe(64);
    expect(variantsKept(500)).toBe(64);
    expect(variantsKept(2000)).toBe(16);
    expect(variantsKept(100_000)).toBe(8);
  });
});
