import type { Feature } from "geojson";
import { describe, expect, it } from "vitest";
import type { TileTime } from "@/layers/types";
import {
  compareBaseId,
  compareBId,
  compareSides,
  compareSideShown,
  compareTileUrl,
  defaultCompare,
  effectiveMode,
  isComparable,
  isHexCollection,
} from "@/lib/render/compareView";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type LoadedLayer, type MapAction, type MapState } from "@/lib/render/state";
import { featureCounts, visibleState } from "@/lib/render/view";

const fire = (name: string, year: number, extra: Record<string, unknown> = {}): Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [-119.5, 37.8] },
  properties: { name, year, t: `${year}-07-01T00:00:00.000Z`, ...extra },
});
const geo = (id: string, features: Feature[]): LoadedLayer => ({
  id,
  title: id,
  style: { geometry: "polygon", color: "#000000" },
  result: { kind: "geojson", data: { type: "FeatureCollection", features }, citation: { source: "s", url: "u", retrieved: "r" } },
  receivedAt: "now",
});
const tiles = (id: string, url: string, time?: TileTime): LoadedLayer =>
  ({
    id,
    title: id,
    style: { geometry: "polygon", color: "#000000" },
    result: { kind: "tiles", data: { url, minzoom: 0, maxzoom: 12, format: "raster", ...(time && { time }) }, citation: { source: "s", url: "u", retrieved: "r" } },
    receivedAt: "now",
  }) as LoadedLayer;

const fires = geo("fire-perimeters", [fire("Rim", 2013), fire("Ferguson", 2018), fire("Washburn", 2022), fire("Oak", 2017)]);
const trails = geo("osm-trails", [{ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { name: "JMT" } }]);
const lossTime: TileTime = { template: "https://tiles.test/{z}/{x}/{y}.png?start_year=2001&end_year={year}", cadence: "yearly", from: "2001", to: "2025" };
const lightsTime: TileTime = { template: "https://gibs.test/VIIRS/default/{date}/{z}/{y}/{x}.png", cadence: "daily", from: "2012-01-01", daysBack: 3 };
const loss = tiles("forest-loss", "https://tiles.test/{z}/{x}/{y}.png?start_year=2001&end_year=2024", lossTime);
const lights = tiles("night-lights", "https://gibs.test/VIIRS/default/2026-10-01/{z}/{y}/{x}.png", lightsTime);

const spec = { layerId: "fire-perimeters", a: ["2016-01-01", "2020-12-31"] as [string, string], b: ["2021-01-01", "2026-10-09"] as [string, string] };

function run(state: MapState, ...actions: MapAction[]): MapState {
  return actions.reduce(reduce, state);
}

const loaded = run(
  initialMapState,
  { type: "layer_loaded", layer: fires },
  { type: "render", op: { layerId: "fire-perimeters", mode: "polygons", visible: true } },
  { type: "layer_loaded", layer: trails },
  { type: "render", op: { layerId: "osm-trails", mode: "lines", visible: true } },
);

const names = (l: LoadedLayer | undefined) =>
  l?.result.kind === "geojson" ? l.result.data.features.map((f) => f.properties?.name as string) : null;

describe("compareSides", () => {
  it("splits a layer into its two windows and their delta", () => {
    const sides = compareSides(fires, undefined, { ...spec, mode: "delta" });
    expect(names(sides.a)).toEqual(["Ferguson", "Oak"]);
    expect(names(sides.b)).toEqual(["Washburn"]);
    expect(sides.b.id).toBe("fire-perimeters~b");
    expect(sides.delta?.result.kind === "geojson" && sides.delta.result.data.features.map((f) => f.properties?.delta)).toEqual([
      "a-only",
      "a-only",
      "b-only",
    ]);
  });

  it("keeps undated features on both sides, so the delta calls them unchanged", () => {
    const undated: Feature = { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { name: "Undated" } };
    const layer = geo("fire-perimeters", [fire("Ferguson", 2018), undated, fire("Washburn", 2022)]);
    const sides = compareSides(layer, undefined, { ...spec, mode: "delta" });
    expect(names(sides.a)).toEqual(["Ferguson", "Undated"]);
    expect(names(sides.b)).toEqual(["Undated", "Washburn"]);
    const delta = sides.delta?.result.kind === "geojson" ? sides.delta.result.data.features : [];
    expect(delta.map((f) => [f.properties?.name, f.properties?.delta])).toEqual([
      ["Ferguson", "a-only"],
      ["Undated", "both"],
      ["Washburn", "b-only"],
    ]);
  });

  it("builds the delta only in delta mode, keeping the sides it already made", () => {
    const layer = geo("fire-perimeters", [fire("Ferguson", 2018), fire("Washburn", 2022)]);
    const swipe = compareSides(layer, undefined, { ...spec, mode: "swipe" });
    expect(swipe.delta).toBeUndefined();
    const delta = compareSides(layer, undefined, { ...spec, mode: "delta" });
    expect(delta.delta).toBeDefined();
    expect(delta.a).toBe(swipe.a);
    expect(delta.b).toBe(swipe.b);
  });

  it("returns the same objects for the same compare (deck keeps its buffers)", () => {
    const one = compareSides(fires, undefined, { ...spec, mode: "swipe" });
    const two = compareSides(fires, undefined, { ...spec, mode: "delta" });
    expect(two.a).toBe(one.a);
    expect(two.b).toBe(one.b);
  });

  it("applies the layer's filters before splitting", () => {
    const sides = compareSides(fires, { name: { include: ["Oak"] } }, { ...spec, mode: "swipe" });
    expect(names(sides.a)).toEqual(["Oak"]);
    expect(names(sides.b)).toEqual([]);
  });

  it("uses the per-cell difference for H3 cells", () => {
    const cell = (h3: string, year: number, v: number): Feature => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 0] },
      properties: { h3, v, t: `${year}-01-01T00:00:00.000Z` },
    });
    const grid = geo("remoteness", [cell("8a2a1072b59ffff", 2018, 10), cell("8a2a1072b59ffff", 2022, 25)]);
    expect(isHexCollection(grid.result.kind === "geojson" ? grid.result.data : { type: "FeatureCollection", features: [] })).toBe(true);
    const sides = compareSides(grid, undefined, { ...spec, layerId: "remoteness", mode: "delta" });
    const [f] = sides.delta?.result.kind === "geojson" ? sides.delta.result.data.features : [];
    expect(f.properties).toMatchObject({ v: 15, vA: 10, vB: 25, delta: "b-only" });
  });

  it("points a tile layer's two sides at their windows", () => {
    const sides = compareSides(loss, undefined, { layerId: "forest-loss", a: ["2015-01-01", "2015-12-31"], b: ["2025-01-01", "2025-12-31"], mode: "delta" });
    expect(sides.delta).toBeUndefined();
    expect(sides.a.result.kind === "tiles" && sides.a.result.data.url).toContain("start_year=2015&end_year=2015");
    expect(sides.b.id).toBe("forest-loss~b");
    expect(sides.b.result.kind === "tiles" && sides.b.result.data.url).toContain("start_year=2025&end_year=2025");
  });
});

describe("compareTileUrl", () => {
  it("shows night lights on the window's end date", () => {
    expect(compareTileUrl(lights.result.kind === "tiles" ? lights.result.data.url : "", lightsTime, ["2020-01-01", "2020-01-01"])).toContain(
      "/2020-01-01/",
    );
  });
  it("leaves other layers alone", () => {
    expect(compareTileUrl("https://x.test/{z}.png", undefined, ["2020-01-01", "2020-01-01"])).toBe("https://x.test/{z}.png");
  });
});

describe("visibleState while comparing", () => {
  it("draws side A under the layer's id and side B under its B id in swipe and toggle", () => {
    for (const mode of ["swipe", "toggle"] as const) {
      const view = visibleState(run(loaded, { type: "set_compare", compare: { ...spec, mode } }));
      expect(names(view.layers["fire-perimeters"])).toEqual(["Ferguson", "Oak"]);
      expect(names(view.layers[compareBId("fire-perimeters")])).toEqual(["Washburn"]);
      // Side B is view-only: no render op, so the layer panel and the export never list it.
      expect(view.renderOps.map((op) => op.layerId)).toEqual(["fire-perimeters", "osm-trails"]);
      expect(view.layers["osm-trails"]).toBe(loaded.layers["osm-trails"]);
    }
  });

  it("passes the delta collection through in delta mode", () => {
    const view = visibleState(run(loaded, { type: "set_compare", compare: { ...spec, mode: "delta" } }));
    const drawn = view.layers["fire-perimeters"];
    expect(drawn.result.kind === "geojson" && drawn.result.data.features.map((f) => f.properties?.delta)).toEqual(["a-only", "a-only", "b-only"]);
    expect(view.layers[compareBId("fire-perimeters")]).toBeUndefined();
    expect(featureCounts(run(loaded, { type: "set_compare", compare: { ...spec, mode: "delta" } }), "fire-perimeters")).toEqual({ shown: 3, total: 4 });
  });

  it("takes precedence over the scrubber's window for the compared layer only", () => {
    const narrowed = run(loaded, { type: "set_time_window", window: ["2013-01-01T00:00:00.000Z", "2013-12-31T23:59:59.999Z"] });
    expect(names(visibleState(narrowed).layers["fire-perimeters"])).toEqual(["Rim"]);
    const view = visibleState(run(narrowed, { type: "set_compare", compare: { ...spec, mode: "swipe" } }));
    expect(names(view.layers["fire-perimeters"])).toEqual(["Ferguson", "Oak"]);
  });

  it("compares a tile layer by toggle whatever the mode asked for", () => {
    const state = run(initialMapState, { type: "layer_loaded", layer: loss }, { type: "set_compare", compare: { layerId: "forest-loss", a: ["2015-01-01", "2015-12-31"], b: ["2025-01-01", "2025-12-31"], mode: "delta" } });
    expect(effectiveMode(state)).toBe("toggle");
    const view = visibleState(state);
    expect(view.layers["forest-loss"].result.kind === "tiles" && view.layers["forest-loss"].result.data.url).toContain("end_year=2015");
    expect(view.layers["forest-loss~b"].result.kind === "tiles" && view.layers["forest-loss~b"].result.data.url).toContain("end_year=2025");
  });

  it("ignores a compare on a layer that is not loaded", () => {
    const state = run(loaded, { type: "set_compare", compare: { ...spec, layerId: "species", mode: "swipe" } });
    expect(visibleState(state).layers).toEqual(loaded.layers);
  });
});

describe("compareSideShown", () => {
  const toggling = run(loaded, { type: "set_compare", compare: { ...spec, mode: "toggle" } });
  it("shows A first, then B after a flip; other layers always", () => {
    expect(compareSideShown(toggling, "fire-perimeters")).toBe(true);
    expect(compareSideShown(toggling, "fire-perimeters~b")).toBe(false);
    const flipped = run(toggling, { type: "compare_flip" });
    expect(compareSideShown(flipped, "fire-perimeters")).toBe(false);
    expect(compareSideShown(flipped, "fire-perimeters~b")).toBe(true);
    expect(compareSideShown(flipped, "osm-trails")).toBe(true);
  });
  it("shows both sides in swipe", () => {
    const swiping = run(toggling, { type: "set_compare_mode", mode: "swipe" });
    expect(compareSideShown(swiping, "fire-perimeters~b")).toBe(true);
  });
});

describe("helpers", () => {
  it("maps side B's id back to its layer", () => {
    expect(compareBaseId(compareBId("forest-loss"))).toBe("forest-loss");
    expect(compareBaseId("forest-loss")).toBe("forest-loss");
  });
  it("knows which layers can be compared", () => {
    expect(isComparable(fires)).toBe(true);
    expect(isComparable(trails)).toBe(false);
    expect(isComparable(loss)).toBe(true);
    expect(isComparable(tiles("population", "u"))).toBe(false);
  });
  it("opens a layer on its preset, else on the two halves of its dates", () => {
    const today = new Date("2026-10-09T12:00:00Z");
    expect(defaultCompare(fires, today)).toEqual({ layerId: "fire-perimeters", a: ["2016-01-01", "2020-12-31"], b: ["2021-01-01", "2026-10-09"], mode: "delta" });
    const other = geo("species", [fire("x", 2010), fire("y", 2020)]);
    expect(defaultCompare(other, today)).toEqual({ layerId: "species", a: ["2010-07-01", "2015-07-01"], b: ["2015-07-02", "2020-07-01"], mode: "delta" });
  });
});
