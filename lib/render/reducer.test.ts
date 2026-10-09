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

  it("set_basemap sets the basemap", () => {
    expect(reduce(initialMapState, { type: "set_basemap", basemap: "satellite" }).basemap).toBe("satellite");
  });
});
