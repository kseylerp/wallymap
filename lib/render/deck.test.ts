import { GeoJsonLayer } from "@deck.gl/layers";
import { describe, expect, it } from "vitest";
import { bboxToViewport, buildDeckLayers, hexToRgba } from "@/lib/render/deck";
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

describe("buildDeckLayers styling", () => {
  const color = layer.style.color;
  const propsFor = (op: MapState["renderOps"][number]) => buildDeckLayers(stateWith(op))[0].props as unknown as Record<string, unknown>;

  it("styles points", () => {
    const props = propsFor({ layerId: "osm-trails", mode: "points", visible: true });
    expect(props.pointType).toBe("circle");
    expect(props.getPointRadius).toBe(7);
    expect(props.pointRadiusUnits).toBe("pixels");
    expect(props.getFillColor).toEqual([255, 255, 255, 255]);
    expect(props.getLineColor).toEqual(hexToRgba(color));
    expect(props.getLineWidth).toBe(2);
  });

  it("styles lines", () => {
    const props = propsFor({ layerId: "osm-trails", mode: "lines", visible: true });
    expect(props.filled).toBe(false);
    expect(props.getLineWidth).toBe(3);
    expect(props.lineWidthUnits).toBe("pixels");
    expect(props.getLineColor).toEqual(hexToRgba(color));
  });

  it("styles polygons", () => {
    const props = propsFor({ layerId: "osm-trails", mode: "polygons", visible: true });
    expect(props.getFillColor).toEqual(hexToRgba(color, 64));
    expect(props.getLineColor).toEqual(hexToRgba(color, 255));
    expect(props.getLineWidth).toBe(1);
  });

  it("lets op.color override the style color", () => {
    const props = propsFor({ layerId: "osm-trails", mode: "lines", color: "#00ff00", visible: true });
    expect(props.getLineColor).toEqual([0, 255, 0, 255]);
  });

  it("falls back to the style color when op.color is not valid hex", () => {
    const props = propsFor({ layerId: "osm-trails", mode: "lines", color: "notahex", visible: true });
    expect(props.getLineColor).toEqual(hexToRgba(color));
  });

  it("skips tiles results", () => {
    const state: MapState = {
      ...initialMapState,
      layers: {
        "osm-trails": {
          ...layer,
          result: {
            kind: "tiles",
            data: { url: "https://example.com/{z}/{x}/{y}.png", minzoom: 0, maxzoom: 12 },
            citation: layer.result.citation,
          },
        },
      },
      renderOps: [{ layerId: "osm-trails", mode: "lines", visible: true }],
    };
    expect(buildDeckLayers(state)).toHaveLength(0);
  });

  it("skips ops whose layer is not loaded", () => {
    const state: MapState = {
      ...initialMapState,
      renderOps: [{ layerId: "missing", mode: "lines", visible: true }],
    };
    expect(buildDeckLayers(state)).toHaveLength(0);
  });
});

describe("hexToRgba", () => {
  it("throws on invalid colors", () => {
    expect(() => hexToRgba("red")).toThrow();
    expect(() => hexToRgba("#12")).toThrow();
    expect(() => hexToRgba("#12345678")).toThrow();
  });

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
