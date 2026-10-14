import { describe, expect, it } from "vitest";
import { setViewFollowsInStep, toolResultToActions, type LayerCatalog } from "@/lib/agent/applyToolResult";
import type { UIMessage } from "ai";
import { bboxToViewport } from "@/lib/render/deck";
import type { LayerResult } from "@/layers/types";
import type { RenderOp } from "@/lib/render/state";

const canvas = { width: 1000, height: 800 };

const catalog: LayerCatalog = {
  "osm-trails": { title: "OpenStreetMap trails", style: { geometry: "line", color: "#D97757" } },
  huts: { title: "Mountain huts", style: { geometry: "point", color: "#16a34a" } },
  parks: { title: "Parks", style: { geometry: "polygon", color: "#65a30d" } },
};

const result: LayerResult = {
  kind: "geojson",
  data: { type: "FeatureCollection", features: [] },
  citation: { source: "OSM", url: "https://osm.org", retrieved: "2026-10-09" },
};

describe("toolResultToActions", () => {
  it("set_view with a bbox fits the bbox to the canvas", () => {
    const bbox = [-120.3, 38.9, -119.9, 39.3] as const;
    const actions = toolResultToActions("set_view", { bbox }, { bbox }, canvas, catalog, []);
    const { longitude, latitude, zoom } = bboxToViewport([...bbox], canvas.width, canvas.height);
    // No pitch: the reducer picks the arrival pitch and backs the zoom off for it (`fit`).
    // The agent framed it: this turn's results no longer move the camera.
    expect(actions).toEqual([{ type: "set_view", viewport: { longitude, latitude, zoom, bearing: 0 }, fit: true }, { type: "place_framed" }]);
  });

  it("set_view with a bbox passes an explicit pitch and bearing through", () => {
    const bbox = [6.8, 45.85, 6.95, 45.97];
    const [action] = toolResultToActions("set_view", {}, { bbox, pitch: 72, bearing: 30 }, canvas, catalog, []);
    expect(action).toMatchObject({ type: "set_view", fit: true, viewport: { pitch: 72, bearing: 30 } });
  });

  it("set_view with terrain sets terrain before moving the camera", () => {
    const output = { center: [6.87, 45.92], zoom: 12, terrain: false };
    expect(toolResultToActions("set_view", output, output, canvas, catalog, [])).toEqual([
      { type: "set_terrain", terrain: false },
      { type: "set_view", viewport: { longitude: 6.87, latitude: 45.92, zoom: 12 } },
      { type: "place_framed" },
    ]);
    expect(toolResultToActions("set_view", {}, { terrain: true }, canvas, catalog, [])).toEqual([
      { type: "set_terrain", terrain: true },
    ]);
  });

  it("set_view with center and zoom produces a partial viewport of only the given fields", () => {
    const output = { center: [6.87, 45.92], zoom: 11, pitch: 45 };
    const actions = toolResultToActions("set_view", output, output, canvas, catalog, []);
    expect(actions).toEqual([
      { type: "set_view", viewport: { longitude: 6.87, latitude: 45.92, zoom: 11, pitch: 45 } },
      { type: "place_framed" },
    ]);
  });

  it("set_basemap accepts the outdoors-satellite hybrid", () => {
    const actions = toolResultToActions(
      "set_basemap",
      { style: "outdoors-satellite" },
      { style: "outdoors-satellite" },
      canvas,
      catalog,
      [],
    );
    expect(actions).toEqual([{ type: "set_basemap", basemap: "outdoors-satellite" }]);
  });

  it("set_basemap switches the basemap", () => {
    const actions = toolResultToActions("set_basemap", { style: "satellite" }, { style: "satellite" }, canvas, catalog, []);
    expect(actions).toEqual([{ type: "set_basemap", basemap: "satellite" }]);
  });

  it("render produces a visible render op", () => {
    const output = { layerId: "osm-trails", mode: "lines", color: "#ff0000" };
    const actions = toolResultToActions("render", output, output, canvas, catalog, []);
    expect(actions).toEqual([
      { type: "render", op: { layerId: "osm-trails", mode: "lines", color: "#ff0000", visible: true } },
    ]);
  });

  it("render carries well-formed filters (ranges ordered, junk dropped); {} clears", () => {
    const output = {
      layerId: "osm-trails",
      mode: "lines",
      filters: { sac_scale: { include: ["alpine_hiking", 3] }, acres: { range: [500, 100] }, bad: "x", empty: { include: [] } },
    };
    expect(toolResultToActions("render", output, output, canvas, catalog, [])).toEqual([
      {
        type: "render",
        op: {
          layerId: "osm-trails",
          mode: "lines",
          visible: true,
          filters: { sac_scale: { include: ["alpine_hiking"] }, acres: { range: [100, 500] } },
        },
      },
    ]);
    const clear = { layerId: "osm-trails", mode: "lines", filters: {} };
    expect(toolResultToActions("render", clear, clear, canvas, catalog, [])[0]).toEqual({
      type: "render",
      op: { layerId: "osm-trails", mode: "lines", visible: true, filters: {} },
    });
  });

  it("set_time maps to the mode, then the window (year bounds cover whole years), then play", () => {
    const output = { start: "2016", end: "2017", play: true, mode: "cumulative" };
    expect(toolResultToActions("set_time", output, output, canvas, catalog, [])).toEqual([
      { type: "set_time_mode", mode: "cumulative" },
      { type: "set_time_window", window: ["2016-01-01T00:00:00.000Z", "2017-12-31T23:59:59.999Z"] },
      { type: "set_time_playing", playing: true },
    ]);
  });

  it("set_time reads months and dates, orders reversed ends, and drops unreadable or bad modes", () => {
    const months = { start: "2024-03", end: "2024-02-10" };
    expect(toolResultToActions("set_time", months, months, canvas, catalog, [])).toEqual([
      { type: "set_time_window", window: ["2024-02-10T23:59:59.999Z", "2024-03-01T00:00:00.000Z"] },
    ]);
    const month = { start: "2024-02", end: "2024-02", mode: "rolling" };
    expect(toolResultToActions("set_time", month, month, canvas, catalog, [])).toEqual([
      { type: "set_time_window", window: ["2024-02-01T00:00:00.000Z", "2024-02-29T23:59:59.999Z"] },
    ]);
    const bad = { start: "last summer", end: "2024" };
    expect(toolResultToActions("set_time", bad, bad, canvas, catalog, [])).toEqual([]);
  });

  it("compare maps to a set_compare action carrying the windows, mode and labels", () => {
    const output = { layerId: "forest-loss", a: ["2015-01-01", "2015-12-31"], b: ["2025-01-01", "2025-12-31"], mode: "delta", aLabel: "2015", bLabel: "2025" };
    expect(toolResultToActions("compare", output, output, canvas, catalog, [])).toEqual([{ type: "set_compare", compare: output }]);
    const bare = { layerId: "night-lights", a: ["2020-01-01", "2020-01-01"], b: ["2026-10-06", "2026-10-06"], mode: "toggle" };
    expect(toolResultToActions("compare", bare, bare, canvas, catalog, [])).toEqual([{ type: "set_compare", compare: bare }]);
  });

  it("compare with malformed output maps to nothing", () => {
    const good = { layerId: "forest-loss", a: ["2015-01-01", "2015-12-31"], b: ["2025-01-01", "2025-12-31"], mode: "delta" };
    for (const bad of [{ ...good, mode: "fade" }, { ...good, a: ["2015-01-01"] }, { ...good, b: ["nope", "2025"] }, { ...good, layerId: 3 }]) {
      expect(toolResultToActions("compare", bad, bad, canvas, catalog, [])).toEqual([]);
    }
  });

  it("query_<id> with a LayerResult loads the layer and adds a default render op", () => {
    const actions = toolResultToActions("query_osm-trails", { bbox: [0, 0, 1, 1] }, result, canvas, catalog, []);
    expect(actions).toEqual([
      {
        type: "layer_loaded",
        layer: {
          id: "osm-trails",
          title: "OpenStreetMap trails",
          style: { geometry: "line", color: "#D97757" },
          result,
          receivedAt: expect.any(String),
        },
      },
      { type: "render", op: { layerId: "osm-trails", mode: "lines", visible: true }, defaultMode: true },
    ]);
  });

  it("query_<id> picks the default render mode from the style geometry", () => {
    const point = toolResultToActions("query_huts", {}, result, canvas, catalog, []);
    const polygon = toolResultToActions("query_parks", {}, result, canvas, catalog, []);
    expect(point[1]).toEqual({ type: "render", op: { layerId: "huts", mode: "points", visible: true }, defaultMode: true });
    expect(polygon[1]).toEqual({ type: "render", op: { layerId: "parks", mode: "polygons", visible: true }, defaultMode: true });
  });

  it("query_<id> skips the default render op when one already exists for that layer", () => {
    const existing: RenderOp[] = [{ layerId: "osm-trails", mode: "points", visible: true }];
    const actions = toolResultToActions("query_osm-trails", {}, result, canvas, catalog, existing);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("layer_loaded");
  });

  it("query_<id> falls back to the id as title and a blue line style when the catalog lacks the layer", () => {
    const actions = toolResultToActions("query_mystery", {}, result, canvas, catalog, []);
    expect(actions).toEqual([
      {
        type: "layer_loaded",
        layer: {
          id: "mystery",
          title: "mystery",
          style: { geometry: "line", color: "#2F3A44" },
          result,
          receivedAt: expect.any(String),
        },
      },
      { type: "render", op: { layerId: "mystery", mode: "lines", visible: true }, defaultMode: true },
    ]);
  });

  it("query_<id> with a LayerError reports a layer error", () => {
    const output = { error: "Area too large; zoom in", hint: "zoom_in" };
    const actions = toolResultToActions("query_osm-trails", {}, output, canvas, catalog, []);
    expect(actions).toEqual([
      { type: "layer_error", layerId: "osm-trails", message: "Area too large; zoom in" },
    ]);
  });

  it("a successful geocode names the place: the camera fits what the queries return there, not the geocoded box (spec §12)", () => {
    const bbox = [-110.1, 42.83, -109.2, 43.53];
    const output = { bbox, center: [-109.65, 43.18], name: "Wind River Range, Wyoming", source: "mapbox" };
    expect(toolResultToActions("geocode", { place: "Wind River Range" }, output, canvas, catalog, [])).toEqual([{ type: "place_named", bbox }]);
  });

  it("a geocode followed by set_view in the same step, or a failed geocode, does not move the camera", () => {
    const output = { bbox: [0, 0, 1, 1], center: [0.5, 0.5], name: "X", source: "mapbox" };
    expect(toolResultToActions("geocode", {}, output, canvas, catalog, [], { setViewFollows: true })).toEqual([]);
    expect(toolResultToActions("geocode", {}, { error: "No match for Nowhere" }, canvas, catalog, [])).toEqual([]);
    expect(toolResultToActions("geocode", {}, { center: [0, 0] }, canvas, catalog, [])).toEqual([]);
  });

  it("note settles a named place nothing was fitted to; list_layers changes nothing on the map", () => {
    expect(toolResultToActions("note", { markdown: "hi" }, { markdown: "hi" }, canvas, catalog, [])).toEqual([{ type: "place_settle" }]);
    expect(toolResultToActions("list_layers", {}, [], canvas, catalog, [])).toEqual([]);
  });

  it("unknown tools and malformed outputs change nothing", () => {
    expect(toolResultToActions("mystery_tool", {}, {}, canvas, catalog, [])).toEqual([]);
    expect(toolResultToActions("set_basemap", {}, { style: "neon" }, canvas, catalog, [])).toEqual([]);
    expect(toolResultToActions("render", {}, { layerId: "x", mode: "blobs" }, canvas, catalog, [])).toEqual([]);
    expect(toolResultToActions("set_view", {}, {}, canvas, catalog, [])).toEqual([]);
    expect(toolResultToActions("query_osm-trails", {}, null, canvas, catalog, [])).toEqual([]);
  });
});

describe("toolResultToActions for route", () => {
  const line = { type: "LineString", coordinates: [[-120.14, 39.17], [-120.16, 39.05], [-120.1, 38.95]] };
  const output = {
    id: "walking-tahoe-city-to-emerald-bay",
    name: "Tahoe City to Emerald Bay",
    profile: "walking",
    line,
    distanceKm: 27.34,
    durationMin: 328,
    waypoints: [
      { lngLat: [-120.14, 39.17], type: "start", name: "North Lake Boulevard" },
      { lngLat: [-120.1, 38.95], type: "end" },
    ],
    bbox: [-120.16, 38.95, -120.1, 39.17],
  };
  const padded = { width: 1000, height: 800, padding: { top: 60, right: 40, bottom: 200, left: 420 } };

  it("loads the route, then fits the camera to its bbox inside the panels' padding", () => {
    const actions = toolResultToActions("route", {}, output, padded, catalog, []);
    expect(actions[0]).toEqual({
      type: "route_loaded",
      route: {
        id: "walking-tahoe-city-to-emerald-bay",
        name: "Tahoe City to Emerald Bay",
        line,
        source: "tool",
        distanceKm: 27.34,
        durationMin: 328,
        waypoints: [
          { lngLat: [-120.14, 39.17], type: "start" },
          { lngLat: [-120.1, 38.95], type: "end" },
        ],
      },
    });
    const { longitude, latitude, zoom } = bboxToViewport([-120.16, 38.95, -120.1, 39.17], 1000, 800, padded.padding);
    expect(actions[1]).toEqual({ type: "set_view", viewport: { longitude, latitude, zoom, bearing: 0 }, fit: true });
    expect(actions).toHaveLength(2);
  });

  it("falls back to the line's extent and its ends when bbox and waypoints are missing", () => {
    const { bbox, waypoints, ...bare } = output;
    void bbox;
    void waypoints;
    const [loaded, view] = toolResultToActions("route", {}, bare, canvas, catalog, []);
    expect(loaded).toMatchObject({
      route: { waypoints: [{ lngLat: [-120.14, 39.17], type: "start" }, { lngLat: [-120.1, 38.95], type: "end" }] },
    });
    const fitted = bboxToViewport([-120.16, 38.95, -120.1, 39.17], canvas.width, canvas.height);
    expect(view).toMatchObject({ type: "set_view", fit: true, viewport: { longitude: fitted.longitude, zoom: fitted.zoom } });
  });

  it("reports a route error under the route layer id", () => {
    expect(toolResultToActions("route", {}, { error: "No route found" }, canvas, catalog, [])).toEqual([
      { type: "layer_error", layerId: "route", message: "No route found" },
    ]);
  });

  it("ignores a malformed route", () => {
    expect(toolResultToActions("route", {}, { id: "x", line: { type: "LineString", coordinates: [[0, 0]] } }, canvas, catalog)).toEqual([]);
    expect(toolResultToActions("route", {}, { line }, canvas, catalog)).toEqual([]);
  });
});

describe("setViewFollowsInStep", () => {
  const tool = (name: string, id: string) =>
    ({ type: `tool-${name}`, toolCallId: id, state: "output-available", input: {}, output: {} }) as UIMessage["parts"][number];
  const step = { type: "step-start" } as UIMessage["parts"][number];

  it("is true only for a set_view after the geocode and before the next step", () => {
    const sameStep = [step, tool("geocode", "a"), tool("set_view", "b"), step, tool("query_glaciers", "c")];
    expect(setViewFollowsInStep(sameStep, 1)).toBe(true);
    const nextStep = [step, tool("geocode", "a"), step, tool("set_view", "b")];
    expect(setViewFollowsInStep(nextStep, 1)).toBe(false);
    const before = [step, tool("set_view", "b"), tool("geocode", "a")];
    expect(setViewFollowsInStep(before, 2)).toBe(false);
  });
});

describe("tool names and views at the tool-call level", () => {
  const climbingCatalog: LayerCatalog = { climbing: { title: "Climbing", style: { geometry: "point", color: "#3A3A3C" } } };
  const body: LayerResult = { ...result, data: { type: "FeatureCollection", features: [] } };

  it("writes a repaired query_climbing<|channel|>commentary call to the canonical layer id (no phantom layer row)", () => {
    const actions = toolResultToActions("query_climbing<|channel|>commentary", {}, body, canvas, climbingCatalog, []);
    const loaded = actions.find((a) => a.type === "layer_loaded");
    expect(loaded?.type === "layer_loaded" && loaded.layer.id).toBe("climbing");
    expect(loaded?.type === "layer_loaded" && loaded.layer.title).toBe("Climbing");
    expect(JSON.stringify(actions)).not.toContain("<|");
    // Even before the catalog lists the layer, the junk never becomes part of an id.
    const bare = toolResultToActions("query_climbing<|channel|>commentary", {}, body, canvas, {}, []);
    expect(JSON.stringify(bare)).not.toContain("<|");
  });

  it("passes render.view to the op, and ignores a view it does not know", () => {
    const [ranked] = toolResultToActions("render", {}, { layerId: "huts", view: "ranked" }, canvas, catalog, []);
    expect(ranked).toMatchObject({ type: "render", op: { layerId: "huts", view: "ranked" } });
    const [odd] = toolResultToActions("render", {}, { layerId: "huts", view: "gallery" }, canvas, catalog, []);
    expect(odd.type === "render" && odd.op.view).toBeUndefined();
  });
});
