import { describe, expect, it } from "vitest";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type LoadedLayer, type MapState, type RouteState } from "@/lib/render/state";

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

  it("a choropleth answer opens on Topographical, never satellite; the agent cannot put it back on imagery, a person can", () => {
    const counties: LoadedLayer = {
      id: "temperature-anomaly",
      title: "Temperature anomaly",
      style: { geometry: "polygon", color: "#3A3A3C", encode: { color: "v" } },
      attributes: [{ key: "v", type: "measure", label: "Anomaly" }],
      result: {
        kind: "geojson",
        data: { type: "FeatureCollection", features: [{ type: "Feature", properties: { v: 3 }, geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }] },
        citation: { source: "NOAA", url: "https://ncei.noaa.gov", retrieved: "2026-10-18" },
      },
      receivedAt: "2026-10-18T00:00:00Z",
    };
    const loaded = reduce({ ...initialMapState, basemap: "satellite" }, { type: "layer_loaded", layer: counties });
    const drawn = reduce(loaded, { type: "render", op: { layerId: "temperature-anomaly", mode: "polygons", visible: true } });
    expect(drawn.basemap).toBe("outdoors");
    expect(reduce(drawn, { type: "set_basemap", basemap: "outdoors-satellite", agent: true }).basemap).toBe("outdoors");
    expect(reduce(drawn, { type: "set_basemap", basemap: "satellite" }).basemap).toBe("satellite");
    // A share link keeps the basemap it carries; a line layer is no choropleth.
    expect(reduce(loaded, { type: "render", op: { layerId: "temperature-anomaly", mode: "polygons", visible: true }, exact: true }).basemap).toBe("satellite");
    const trails = reduce(reduce(initialMapState, { type: "layer_loaded", layer }), { type: "render", op: { layerId: "osm-trails", mode: "lines", visible: true } });
    expect(trails.basemap).toBe("outdoors-satellite");
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

describe("reduce: 3D camera rules", () => {
  const feature = {
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [6.87, 45.92] },
    properties: { name: "Lac Blanc" },
  };
  const selection = { layerId: "osm-trails", feature, lngLat: [6.87, 45.92] as [number, number] };
  const atTrailZoom: MapState = { ...initialMapState, viewport: { ...initialMapState.viewport, zoom: 12, pitch: 45 } };

  it("starts with terrain on and the map not flattened", () => {
    expect(initialMapState.terrain).toBe(true);
    expect(initialMapState.flattened).toBe(false);
  });

  it("set_view without a pitch tilts to 45 at zoom 10 and above", () => {
    const next = reduce(initialMapState, { type: "set_view", viewport: { longitude: 6.87, latitude: 45.92, zoom: 11 } });
    expect(next.viewport.pitch).toBe(45);
    expect(next.viewport.zoom).toBe(11);
  });

  it("set_view below zoom 10 stays flat", () => {
    const next = reduce(atTrailZoom, { type: "set_view", viewport: { zoom: 6 } });
    expect(next.viewport.pitch).toBe(0);
  });

  it("set_view keeps an explicit pitch, so the map's own camera reports pass unchanged", () => {
    const camera = { longitude: 6.87, latitude: 45.92, zoom: 12, pitch: 20, bearing: 10 };
    expect(reduce(initialMapState, { type: "set_view", viewport: camera }).viewport).toEqual(camera);
    expect(reduce(initialMapState, { type: "set_view", viewport: { zoom: 12, pitch: 60 } }).viewport.pitch).toBe(60);
  });

  it("the world reset returns to pitch 0", () => {
    const next = reduce(atTrailZoom, { type: "set_view", viewport: initialMapState.viewport });
    expect(next.viewport).toEqual(initialMapState.viewport);
  });

  it("a fit at trail zoom tilts to 45 and backs the zoom off 0.4", () => {
    const next = reduce(initialMapState, {
      type: "set_view",
      viewport: { longitude: 6.87, latitude: 45.92, zoom: 12 },
      fit: true,
    });
    expect(next.viewport.pitch).toBe(45);
    expect(next.viewport.zoom).toBeCloseTo(11.6);
  });

  it("a fit at Detail pitch backs the zoom off 0.8, and a flat fit keeps its zoom", () => {
    const detail = reduce(initialMapState, { type: "set_view", viewport: { zoom: 12, pitch: 72 }, fit: true });
    expect(detail.viewport.zoom).toBeCloseTo(11.2);
    const flat = reduce(initialMapState, { type: "set_view", viewport: { zoom: 8 }, fit: true });
    expect(flat.viewport).toMatchObject({ zoom: 8, pitch: 0 });
  });

  it("does not tilt arrivals on a flattened map", () => {
    const flattened = { ...initialMapState, flattened: true };
    const next = reduce(flattened, { type: "set_view", viewport: { zoom: 12 }, fit: true });
    expect(next.viewport).toMatchObject({ zoom: 12, pitch: 0 });
  });

  it("select leaves the viewport untouched, and so does deselect", () => {
    const selected = reduce(atTrailZoom, { type: "select", selection });
    expect(selected.selected).toEqual(selection);
    expect(selected.viewport).toBe(atTrailZoom.viewport);
    const deselected = reduce(selected, { type: "deselect" });
    expect(deselected.selected).toBeUndefined();
    expect(deselected.viewport).toBe(atTrailZoom.viewport);
    const flat = { ...atTrailZoom, flattened: true, viewport: { ...atTrailZoom.viewport, pitch: 0 } };
    expect(reduce(flat, { type: "select", selection }).viewport).toBe(flat.viewport);
    expect(reduce(initialMapState, { type: "select", selection }).viewport).toBe(initialMapState.viewport);
  });

  it("a selection dropped by hide, clear, reload or heat leaves the viewport untouched", () => {
    const loaded = reduce(
      reduce(atTrailZoom, { type: "layer_loaded", layer }),
      { type: "render", op: { layerId: "osm-trails", mode: "lines", visible: true } },
    );
    const selected = reduce(loaded, { type: "select", selection });
    const dropped = [
      reduce(selected, { type: "toggle_layer", layerId: "osm-trails" }),
      reduce(selected, { type: "clear_layers" }),
      reduce(selected, { type: "layer_loaded", layer }),
      reduce(selected, { type: "render", op: { layerId: "osm-trails", mode: "heat", visible: true } }),
      reduce(selected, { type: "set_style", layerId: "osm-trails", mode: "heat" }),
      reduce(selected, { type: "remove_layer", layerId: "osm-trails" }),
    ];
    for (const next of dropped) {
      expect(next.selected).toBeUndefined();
      expect(next.viewport).toBe(atTrailZoom.viewport);
    }
  });

  it("set_flattened(true) drops to pitch 0; set_flattened(false) restores 45 and terrain", () => {
    const flat = reduce(atTrailZoom, { type: "set_flattened", flattened: true });
    expect(flat.flattened).toBe(true);
    expect(flat.viewport.pitch).toBe(0);
    const off = reduce({ ...flat, terrain: false }, { type: "set_flattened", flattened: false });
    expect(off.flattened).toBe(false);
    expect(off.terrain).toBe(true);
    expect(off.viewport.pitch).toBe(45);
  });

  it("set_flattened(false) at the world view keeps the globe flat", () => {
    const flat = reduce(initialMapState, { type: "set_flattened", flattened: true });
    expect(reduce(flat, { type: "set_flattened", flattened: false }).viewport.pitch).toBe(0);
  });

  it("set_terrain switches terrain and returns the same state when unchanged", () => {
    const off = reduce(initialMapState, { type: "set_terrain", terrain: false });
    expect(off.terrain).toBe(false);
    expect(reduce(initialMapState, { type: "set_terrain", terrain: true })).toBe(initialMapState);
  });
});

describe("routes", () => {
  const route = (id: string): RouteState => ({
    id,
    name: "Tahoe City to Emerald Bay",
    line: { type: "LineString", coordinates: [[-120.14, 39.17], [-120.1, 38.95]] },
    source: "tool",
    distanceKm: 26.1,
    durationMin: 330,
    waypoints: [
      { lngLat: [-120.14, 39.17], type: "start" },
      { lngLat: [-120.1, 38.95], type: "end" },
    ],
  });

  it("route_loaded adds a route and replaces one with the same id", () => {
    const one = reduce(initialMapState, { type: "route_loaded", route: route("a") });
    expect(Object.keys(one.routes)).toEqual(["a"]);
    expect(initialMapState.routes).toEqual({});
    const replaced = reduce(one, { type: "route_loaded", route: { ...route("a"), distanceKm: 3 } });
    expect(replaced.routes.a.distanceKm).toBe(3);
    const two = reduce(replaced, { type: "route_loaded", route: route("b") });
    expect(Object.keys(two.routes).sort()).toEqual(["a", "b"]);
  });

  it("route_loaded clears an earlier route error", () => {
    const failed = reduce(initialMapState, { type: "layer_error", layerId: "route", message: "No route found" });
    expect(reduce(failed, { type: "route_loaded", route: route("a") }).errors).toEqual([]);
  });

  it("route_removed drops one route and is a no-op for an unknown id", () => {
    const two = reduce(reduce(initialMapState, { type: "route_loaded", route: route("a") }), {
      type: "route_loaded",
      route: route("b"),
    });
    expect(Object.keys(reduce(two, { type: "route_removed", routeId: "a" }).routes)).toEqual(["b"]);
    expect(reduce(two, { type: "route_removed", routeId: "zzz" })).toBe(two);
  });

  it("routes_cleared and clear_layers remove every route", () => {
    const loaded = reduce(initialMapState, { type: "route_loaded", route: route("a") });
    expect(reduce(loaded, { type: "routes_cleared" }).routes).toEqual({});
    expect(reduce(loaded, { type: "clear_layers" }).routes).toEqual({});
    expect(reduce(initialMapState, { type: "routes_cleared" })).toBe(initialMapState);
  });
});

describe("Rank by, the hex basis, hover and fly_to (spec §12c, §12d)", () => {
  const layer = {
    id: "dams",
    title: "Dams",
    style: { geometry: "point" as const, color: "#3A3A3C" },
    result: {
      kind: "geojson" as const,
      data: { type: "FeatureCollection" as const, features: [{ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [-111, 36] }, properties: { name: "Glen Canyon", v: 27 } }] },
      citation: { source: "NID", url: "https://nid.sec.usace.army.mil", retrieved: "2026-10-15" },
    },
    receivedAt: "",
  };
  const drawn = reduce(reduce(initialMapState, { type: "layer_loaded", layer }), { type: "render", op: { layerId: "dams", mode: "points", visible: true } });
  const feature = layer.result.data.features[0];

  it("sets and clears Rank by and the hex basis on the op", () => {
    const ranked = reduce(drawn, { type: "set_rank_by", layerId: "dams", key: "v" });
    expect(ranked.renderOps[0].rankBy).toBe("v");
    expect(reduce(ranked, { type: "set_rank_by", layerId: "dams" }).renderOps[0]).not.toHaveProperty("rankBy");
    // None, picked in the row, is kept as "" so the default (the primary measure) does not come back.
    expect(reduce(ranked, { type: "set_rank_by", layerId: "dams", key: "" }).renderOps[0].rankBy).toBe("");
    expect(reduce(drawn, { type: "set_hex_basis", layerId: "dams", basis: "sum" }).renderOps[0].hexBasis).toBe("sum");
  });

  it("rings a hovered feature until the pointer leaves or the layer goes, and flies to a picked one with its card", () => {
    const hovered = reduce(drawn, { type: "set_hover", hover: { layerId: "dams", feature } });
    expect(hovered.hover?.feature).toBe(feature);
    expect(reduce(hovered, { type: "set_hover" }).hover).toBeUndefined();
    expect(reduce(hovered, { type: "remove_layer", layerId: "dams" }).hover).toBeUndefined();
    const flown = reduce(drawn, { type: "fly_to", bbox: [-111, 36, -111, 36], select: { layerId: "dams", feature, lngLat: [-111, 36] } });
    expect(flown.camera!.bbox[2] - flown.camera!.bbox[0]).toBeGreaterThan(0);
    expect(flown.camera?.seq).toBe((drawn.camera?.seq ?? 0) + 1);
    expect(flown.selected?.feature).toBe(feature);
  });
});
