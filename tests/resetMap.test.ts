import type { Feature } from "geojson";
import { describe, expect, it } from "vitest";
import { isMapReset, reduce } from "@/lib/render/reducer";
import { initialMapState, type LoadedLayer, type MapAction, type MapState } from "@/lib/render/state";
import { previewExitCamera } from "@/lib/render/wally/playback";

const fire = (name: string, year: number): Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [-119.5, 37.8] },
  properties: { name, year, t: `${year}-07-01T00:00:00.000Z` },
});
const fires: LoadedLayer = {
  id: "fire-perimeters",
  title: "Fire perimeters",
  style: { geometry: "polygon", color: "var(--ink)" },
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

const route = {
  id: "r1",
  line: { type: "LineString" as const, coordinates: [[-119.5, 37.8], [-119.4, 37.9]] },
  source: "tool" as const,
  distanceKm: 12,
  waypoints: [],
};

/** A busy map: a dated layer with a filter, a window, a compare, a route being previewed, a selection, an error. */
const busy = run(
  initialMapState,
  { type: "set_basemap", basemap: "satellite" },
  { type: "set_flattened", flattened: true },
  { type: "set_view", viewport: { longitude: -119.5, latitude: 37.8, zoom: 9, bearing: 20 } },
  { type: "layer_loaded", layer: fires },
  { type: "render", op: { layerId: "fire-perimeters", mode: "polygons", visible: true, filters: { year: { range: [2018, 2020] } } } },
  { type: "set_time_window", window: ["2018-01-01T00:00:00.000Z", "2019-12-31T00:00:00.000Z"] },
  { type: "set_compare", compare: { layerId: "fire-perimeters", a: ["2016-01-01", "2020-12-31"], b: ["2021-01-01", "2026-10-09"], mode: "toggle" } },
  { type: "route_loaded", route },
  { type: "preview_start", routeId: "r1" },
  { type: "select", selection: { layerId: "fire-perimeters", feature: fire("Ferguson", 2018), lngLat: [0, 0] } },
  { type: "layer_error", layerId: "other", message: "failed" },
  { type: "set_time_window", window: ["2018-01-01T00:00:00.000Z", "2019-12-31T00:00:00.000Z"] },
);

describe("reset_map", () => {
  it("starts from a state that really has everything set", () => {
    expect(Object.keys(busy.layers)).toHaveLength(1);
    expect(busy.renderOps[0].filters).toBeDefined();
    expect(busy.time).toBeDefined();
    expect(busy.compare).toBeDefined();
    expect(busy.playback).toBeDefined();
    expect(busy.selected).toBeDefined();
    expect(busy.errors).toHaveLength(1);
    expect(Object.keys(busy.routes)).toHaveLength(1);
    expect(isMapReset(busy)).toBe(false);
  });

  it("clears layers, ops, filters, time, compare, preview, selection, routes and the camera", () => {
    const s = run(busy, { type: "reset_map" });
    expect(s.layers).toEqual({});
    expect(s.routes).toEqual({});
    expect(s.renderOps).toEqual([]);
    expect(s.errors).toEqual([]);
    expect(s.selected).toBeUndefined();
    expect(s.playback).toBeUndefined();
    expect(s.time).toBeUndefined();
    expect(s.pendingTime).toBeUndefined();
    expect(s.compare).toBeUndefined();
    expect(s.viewport).toEqual(initialMapState.viewport);
    expect(isMapReset(s)).toBe(true);
  });

  it("clears a time window still waiting for a dated layer", () => {
    const waiting = run(initialMapState, { type: "set_time_window", window: ["2018-01-01", "2019-01-01"] });
    expect(waiting.pendingTime).toBeDefined();
    expect(isMapReset(waiting)).toBe(false);
    expect(run(waiting, { type: "reset_map" }).pendingTime).toBeUndefined();
  });

  it("keeps the basemap and the 3D choice", () => {
    const s = run(busy, { type: "reset_map" });
    expect(s.basemap).toBe("satellite");
    expect(s.flattened).toBe(true);
    expect(s.terrain).toBe(busy.terrain);
    const threeD = run(initialMapState, { type: "set_basemap", basemap: "outdoors" }, { type: "layer_loaded", layer: fires }, { type: "reset_map" });
    expect(threeD.basemap).toBe("outdoors");
    expect(threeD.flattened).toBe(false);
    expect(threeD.terrain).toBe(true);
  });

  it("is a no-op reset on a fresh map, and a moved camera alone counts as not reset", () => {
    expect(isMapReset(initialMapState)).toBe(true);
    expect(isMapReset(run(initialMapState, { type: "set_basemap", basemap: "satellite" }))).toBe(true);
    expect(isMapReset(run(initialMapState, { type: "set_view", viewport: { zoom: 6 } }))).toBe(false);
  });

  it("ends a route preview on the globe, not back on the trail it started from", () => {
    // MapCanvas keeps the live camera and the state's viewport from when the preview began; the preview's exit runs
    // after the viewport effect in the commit that ends it, so it must not ease back to the trail after a reset.
    const trail = { longitude: -119.53, latitude: 37.73, zoom: 16.09, pitch: 60, bearing: 30 };
    const restore = { camera: trail, viewport: busy.viewport };
    const reset = run(busy, { type: "reset_map" });
    expect(previewExitCamera(restore, reset.viewport, reset.flattened)).toEqual({ camera: initialMapState.viewport, reset: true });
    // Clear all (and the preview's own ×) leave the viewport alone: then the camera rises back to where it was.
    const cleared = run(busy, { type: "clear_layers" });
    expect(cleared.playback).toBeUndefined();
    expect(previewExitCamera(restore, cleared.viewport, false)).toEqual({ camera: trail, reset: false });
    expect(previewExitCamera(restore, run(busy, { type: "preview_stop" }).viewport, true)).toEqual({ camera: { ...trail, pitch: 0 }, reset: false });
  });
});
