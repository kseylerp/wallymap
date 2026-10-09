import { GeoJsonLayer } from "@deck.gl/layers";
import { describe, expect, it } from "vitest";
import { bboxToViewport, buildDeckLayers, hexToRgba } from "@/lib/render/deck";
import { initialMapState, type LoadedLayer, type MapState } from "@/lib/render/state";

const layer: LoadedLayer = {
  id: "osm-trails",
  title: "OSM trails",
  style: { geometry: "line", color: "#c2410c" },
  result: {
    kind: "geojson",
    data: { type: "FeatureCollection", features: [] },
    citation: { source: "OSM", url: "https://osm.org", retrieved: "2026-10-09" },
  },
  receivedAt: "2026-10-09T00:00:00Z",
};

function stateWith(op: MapState["renderOps"][number]): MapState {
  return { ...initialMapState, layers: { "osm-trails": layer }, renderOps: [op] };
}

describe("buildDeckLayers", () => {
  it("yields one GeoJsonLayer with id osm-trails:lines", () => {
    const layers = buildDeckLayers(stateWith({ layerId: "osm-trails", mode: "lines", visible: true }));
    expect(layers).toHaveLength(1);
    expect(layers[0]).toBeInstanceOf(GeoJsonLayer);
    expect(layers[0].id).toBe("osm-trails:lines");
    expect(layers[0].props.pickable).toBe(true);
  });

  it("yields no layers for an invisible op", () => {
    expect(buildDeckLayers(stateWith({ layerId: "osm-trails", mode: "lines", visible: false }))).toHaveLength(0);
  });

  it("throws NotImplemented for columns", () => {
    expect(() => buildDeckLayers(stateWith({ layerId: "osm-trails", mode: "columns", visible: true }))).toThrow(
      "NotImplemented: columns",
    );
  });
});

describe("hexToRgba", () => {
  it("parses hex with default and custom alpha", () => {
    expect(hexToRgba("#c2410c")).toEqual([194, 65, 12, 255]);
    expect(hexToRgba("#fff", 90)).toEqual([255, 255, 255, 90]);
  });
});

describe("bboxToViewport", () => {
  it("fits a bbox into the viewport", () => {
    const v = bboxToViewport([-120.2, 38.85, -120.0, 39.0], 1000, 800);
    expect(v.longitude).toBeCloseTo(-120.1, 2);
    expect(v.latitude).toBeCloseTo(38.925, 2);
    expect(v.zoom).toBeGreaterThan(9);
    expect(v.zoom).toBeLessThan(12);
    expect(v.pitch).toBe(0);
    expect(v.bearing).toBe(0);
  });
});
