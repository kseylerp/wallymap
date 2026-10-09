import { describe, expect, it } from "vitest";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type LoadedLayer, type MapState } from "@/lib/render/state";

const layer: LoadedLayer = {
  id: "osm-trails",
  title: "OSM trails",
  style: { geometry: "line", color: "#D97757" },
  result: {
    kind: "geojson",
    data: { type: "FeatureCollection", features: [] },
    citation: { source: "OSM", url: "https://osm.org", retrieved: "2026-10-09" },
  },
  receivedAt: "2026-10-09T00:00:00Z",
};

describe("reduce", () => {
  it("set_view merges a partial viewport", () => {
    const next = reduce(initialMapState, { type: "set_view", viewport: { zoom: 9, longitude: -120 } });
    expect(next.viewport).toEqual({ longitude: -120, latitude: 20, zoom: 9, pitch: 0, bearing: 0 });
    expect(initialMapState.viewport.zoom).toBe(1.5);
  });

  it("render on an existing layerId replaces the op instead of appending", () => {
    const first = reduce(initialMapState, {
      type: "render",
      op: { layerId: "osm-trails", mode: "lines", visible: true },
    });
    const second = reduce(first, {
      type: "render",
      op: { layerId: "osm-trails", mode: "lines", color: "#112233", visible: true },
    });
    expect(second.renderOps).toHaveLength(1);
    expect(second.renderOps[0].color).toBe("#112233");
    expect(first.renderOps[0].color).toBeUndefined();
  });

  it("toggle_layer flips visible", () => {
    const rendered = reduce(initialMapState, {
      type: "render",
      op: { layerId: "osm-trails", mode: "lines", visible: true },
    });
    const hidden = reduce(rendered, { type: "toggle_layer", layerId: "osm-trails" });
    expect(hidden.renderOps[0].visible).toBe(false);
    const shown = reduce(hidden, { type: "toggle_layer", layerId: "osm-trails" });
    expect(shown.renderOps[0].visible).toBe(true);
    expect(reduce(initialMapState, { type: "toggle_layer", layerId: "nope" })).toEqual(initialMapState);
  });

  it("layer_error appends and keeps a previously loaded layer; layer_loaded clears the error", () => {
    const loaded: MapState = reduce(initialMapState, { type: "layer_loaded", layer });
    const errored = reduce(loaded, { type: "layer_error", layerId: "osm-trails", message: "boom" });
    expect(errored.layers["osm-trails"]).toEqual(layer);
    expect(errored.errors).toEqual([{ layerId: "osm-trails", message: "boom" }]);
    const recovered = reduce(errored, { type: "layer_loaded", layer });
    expect(recovered.errors).toEqual([]);
  });

  it("defaults to the outdoors-satellite hybrid basemap", () => {
    expect(initialMapState.basemap).toBe("outdoors-satellite");
  });

  it("set_basemap sets the basemap", () => {
    expect(reduce(initialMapState, { type: "set_basemap", basemap: "satellite" }).basemap).toBe("satellite");
  });
});

describe("reduce: selection and layer panel actions", () => {
  const feature: GeoJSON.Feature = {
    type: "Feature",
    geometry: { type: "LineString", coordinates: [[-120, 39], [-120.1, 39.1]] },
    properties: { name: "Rubicon Trail" },
  };
  const other: LoadedLayer = { ...layer, id: "campsites", title: "Campsites" };
  const base: MapState = {
    ...initialMapState,
    layers: { "osm-trails": layer, campsites: other },
    renderOps: [
      { layerId: "osm-trails", mode: "lines", visible: true },
      { layerId: "campsites", mode: "points", visible: true },
    ],
  };
  const selection = { layerId: "osm-trails", feature, lngLat: [-120.05, 39.05] as [number, number] };

  it("select stores the selection and deselect clears it", () => {
    const selected = reduce(base, { type: "select", selection });
    expect(selected.selected).toEqual(selection);
    expect(reduce(selected, { type: "deselect" }).selected).toBeUndefined();
    expect(reduce(base, { type: "deselect" })).toBe(base);
  });

  it("set_opacity clamps to 0..1 and ignores unknown layers", () => {
    expect(reduce(base, { type: "set_opacity", layerId: "osm-trails", opacity: 0.4 }).renderOps[0].opacity).toBe(0.4);
    expect(reduce(base, { type: "set_opacity", layerId: "osm-trails", opacity: 3 }).renderOps[0].opacity).toBe(1);
    expect(reduce(base, { type: "set_opacity", layerId: "osm-trails", opacity: -1 }).renderOps[0].opacity).toBe(0);
    expect(reduce(base, { type: "set_opacity", layerId: "nope", opacity: 0.5 })).toBe(base);
  });

  it("set_style changes color and mode independently", () => {
    const colored = reduce(base, { type: "set_style", layerId: "osm-trails", color: "#5E7D5A" });
    expect(colored.renderOps[0]).toEqual({ layerId: "osm-trails", mode: "lines", visible: true, color: "#5E7D5A" });
    const heat = reduce(colored, { type: "set_style", layerId: "osm-trails", mode: "heat" });
    expect(heat.renderOps[0]).toMatchObject({ mode: "heat", color: "#5E7D5A" });
  });

  it("a render op from the agent keeps the opacity the user set", () => {
    const faded = reduce(base, { type: "set_opacity", layerId: "osm-trails", opacity: 0.3 });
    const restyled = reduce(faded, { type: "render", op: { layerId: "osm-trails", mode: "points", visible: true } });
    expect(restyled.renderOps[0]).toMatchObject({ mode: "points", opacity: 0.3 });
  });

  it("reorder moves an op to the target index, clamped to the list", () => {
    const moved = reduce(base, { type: "reorder", layerId: "osm-trails", toIndex: 1 });
    expect(moved.renderOps.map((op) => op.layerId)).toEqual(["campsites", "osm-trails"]);
    const clamped = reduce(base, { type: "reorder", layerId: "campsites", toIndex: -5 });
    expect(clamped.renderOps.map((op) => op.layerId)).toEqual(["campsites", "osm-trails"]);
    expect(reduce(base, { type: "reorder", layerId: "osm-trails", toIndex: 0 })).toBe(base);
    expect(reduce(base, { type: "reorder", layerId: "nope", toIndex: 0 })).toBe(base);
  });

  it("remove_layer drops the layer, its op and its selection", () => {
    const selected = reduce(base, { type: "select", selection });
    const removed = reduce(selected, { type: "remove_layer", layerId: "osm-trails" });
    expect(removed.layers["osm-trails"]).toBeUndefined();
    expect(removed.renderOps.map((op) => op.layerId)).toEqual(["campsites"]);
    expect(removed.selected).toBeUndefined();
  });

  it("hiding or reloading the selected layer clears the selection; other layers keep it", () => {
    const selected = reduce(base, { type: "select", selection });
    expect(reduce(selected, { type: "toggle_layer", layerId: "osm-trails" }).selected).toBeUndefined();
    expect(reduce(selected, { type: "toggle_layer", layerId: "campsites" }).selected).toEqual(selection);
    expect(reduce(selected, { type: "layer_loaded", layer }).selected).toBeUndefined();
  });

  it("switching the selected layer to heat drops the selection; other modes and layers keep it", () => {
    const selected = reduce(base, { type: "select", selection });
    expect(reduce(selected, { type: "set_style", layerId: "osm-trails", mode: "heat" }).selected).toBeUndefined();
    expect(
      reduce(selected, { type: "render", op: { layerId: "osm-trails", mode: "heat", visible: true } }).selected,
    ).toBeUndefined();
    expect(reduce(selected, { type: "set_style", layerId: "osm-trails", mode: "points" }).selected).toEqual(selection);
    expect(reduce(selected, { type: "set_style", layerId: "osm-trails", color: "#123456" }).selected).toEqual(selection);
    expect(reduce(selected, { type: "set_style", layerId: "campsites", mode: "heat" }).selected).toEqual(selection);
  });

  it("clear_layers empties layers, ops, errors and the selection", () => {
    const next = reduce(reduce(base, { type: "select", selection }), { type: "clear_layers" });
    expect(next.layers).toEqual({});
    expect(next.renderOps).toEqual([]);
    expect(next.selected).toBeUndefined();
  });
});
