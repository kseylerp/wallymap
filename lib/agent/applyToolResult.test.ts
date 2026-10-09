import { describe, expect, it } from "vitest";
import { toolResultToActions, type LayerCatalog } from "@/lib/agent/applyToolResult";
import { bboxToViewport } from "@/lib/render/deck";
import type { LayerResult } from "@/layers/types";
import type { RenderOp } from "@/lib/render/state";

const canvas = { width: 1000, height: 800 };

const catalog: LayerCatalog = {
  "osm-trails": { title: "OpenStreetMap trails", style: { geometry: "line", color: "#c2410c" } },
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
    expect(actions).toEqual([
      { type: "set_view", viewport: bboxToViewport([...bbox], canvas.width, canvas.height) },
    ]);
  });

  it("set_view with center and zoom produces a partial viewport of only the given fields", () => {
    const output = { center: [6.87, 45.92], zoom: 11, pitch: 45 };
    const actions = toolResultToActions("set_view", output, output, canvas, catalog, []);
    expect(actions).toEqual([
      { type: "set_view", viewport: { longitude: 6.87, latitude: 45.92, zoom: 11, pitch: 45 } },
    ]);
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

  it("query_<id> with a LayerResult loads the layer and adds a default render op", () => {
    const actions = toolResultToActions("query_osm-trails", { bbox: [0, 0, 1, 1] }, result, canvas, catalog, []);
    expect(actions).toEqual([
      {
        type: "layer_loaded",
        layer: {
          id: "osm-trails",
          title: "OpenStreetMap trails",
          style: { geometry: "line", color: "#c2410c" },
          result,
          receivedAt: expect.any(String),
        },
      },
      { type: "render", op: { layerId: "osm-trails", mode: "lines", visible: true } },
    ]);
  });

  it("query_<id> picks the default render mode from the style geometry", () => {
    const point = toolResultToActions("query_huts", {}, result, canvas, catalog, []);
    const polygon = toolResultToActions("query_parks", {}, result, canvas, catalog, []);
    expect(point[1]).toEqual({ type: "render", op: { layerId: "huts", mode: "points", visible: true } });
    expect(polygon[1]).toEqual({ type: "render", op: { layerId: "parks", mode: "polygons", visible: true } });
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
          style: { geometry: "line", color: "#2563eb" },
          result,
          receivedAt: expect.any(String),
        },
      },
      { type: "render", op: { layerId: "mystery", mode: "lines", visible: true } },
    ]);
  });

  it("query_<id> with a LayerError reports a layer error", () => {
    const output = { error: "Area too large; zoom in", hint: "zoom_in" };
    const actions = toolResultToActions("query_osm-trails", {}, output, canvas, catalog, []);
    expect(actions).toEqual([
      { type: "layer_error", layerId: "osm-trails", message: "Area too large; zoom in" },
    ]);
  });

  it("geocode, note and list_layers change nothing on the map", () => {
    expect(toolResultToActions("geocode", { place: "Tahoe" }, { bbox: [0, 0, 1, 1] }, canvas, catalog, [])).toEqual([]);
    expect(toolResultToActions("note", { markdown: "hi" }, { markdown: "hi" }, canvas, catalog, [])).toEqual([]);
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
