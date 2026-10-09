import { GeoJsonLayer } from "@deck.gl/layers";
import { describe, expect, it } from "vitest";
import { SIBLING_FADE, SLATE, bboxToViewport, buildDeckLayers, hexToRgba } from "@/lib/render/deck";
import { initialMapState, type LoadedLayer, type MapState } from "@/lib/render/state";

const layer: LoadedLayer = {
  id: "osm-trails",
  title: "OSM trails",
  style: { geometry: "line", color: "#2F3A44" },
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
  it("yields a white casing under the osm-trails:lines GeoJsonLayer", () => {
    const layers = buildDeckLayers(stateWith({ layerId: "osm-trails", mode: "lines", visible: true }));
    expect(layers).toHaveLength(2);
    expect(layers[1]).toBeInstanceOf(GeoJsonLayer);
    expect(layers[1].id).toBe("osm-trails:lines");
    expect(layers[1].props.pickable).toBe(true);
  });

  it("draws the casing first, white and wider, and not pickable", () => {
    const [casing, line] = buildDeckLayers(stateWith({ layerId: "osm-trails", mode: "lines", visible: true }));
    const props = casing.props as unknown as Record<string, unknown>;
    expect(casing).toBeInstanceOf(GeoJsonLayer);
    expect(casing.id).toBe("osm-trails:lines:casing");
    expect(props.pickable).toBe(false);
    expect(props.filled).toBe(false);
    expect(props.getLineColor).toEqual([255, 255, 255, 255]);
    expect(props.getLineWidth).toBe(4.5);
    expect(props.lineWidthUnits).toBe("pixels");
    expect(props.data).toBe((line.props as unknown as Record<string, unknown>).data);
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
  /** Props of the op's main layer: the last one, above any casing. */
  const propsFor = (op: MapState["renderOps"][number]) =>
    buildDeckLayers(stateWith(op)).at(-1)!.props as unknown as Record<string, unknown>;

  it("styles points as white discs with a slate stroke", () => {
    const layers = buildDeckLayers(stateWith({ layerId: "osm-trails", mode: "points", visible: true }));
    expect(layers).toHaveLength(1);
    const props = layers[0].props as unknown as Record<string, unknown>;
    expect(props.pointType).toBe("circle");
    expect(props.getPointRadius).toBe(7);
    expect(props.pointRadiusUnits).toBe("pixels");
    expect(props.getFillColor).toEqual([255, 255, 255, 255]);
    expect(props.getLineColor).toEqual(hexToRgba(SLATE));
    expect(props.getLineWidth).toBe(2);
  });

  it("strokes points in a requested color", () => {
    const props = propsFor({ layerId: "osm-trails", mode: "points", color: "#00ff00", visible: true });
    expect(props.getLineColor).toEqual([0, 255, 0, 255]);
  });

  it("styles lines", () => {
    const props = propsFor({ layerId: "osm-trails", mode: "lines", visible: true });
    expect(props.filled).toBe(false);
    expect(props.getLineWidth).toBe(2.5);
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
            data: { url: "https://example.com/{z}/{x}/{y}.png", minzoom: 0, maxzoom: 12, format: "raster" },
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

  it("centers the bbox in the area left clear by padding", () => {
    const bbox: [number, number, number, number] = [-120.2, 38.85, -120.0, 39.0];
    const plain = bboxToViewport(bbox, 1000, 800);
    const padded = bboxToViewport(bbox, 1000, 800, { top: 40, right: 40, bottom: 40, left: 476 });
    // A wide left panel pushes the camera west so the bbox lands right of it, and zooms out to fit.
    expect(padded.longitude).toBeLessThan(plain.longitude);
    expect(padded.zoom).toBeLessThan(plain.zoom);
  });
});

describe("buildDeckLayers opacity, heat and selection", () => {
  const a: GeoJSON.Feature = { type: "Feature", geometry: { type: "Point", coordinates: [-120, 39] }, properties: { v: 5 } };
  const b: GeoJSON.Feature = {
    type: "Feature",
    geometry: { type: "LineString", coordinates: [[-121, 38], [-119, 40]] },
    properties: {},
  };
  const withData: LoadedLayer = {
    ...layer,
    result: { ...layer.result, data: { type: "FeatureCollection", features: [a, b] } } as LoadedLayer["result"],
  };
  const stateFor = (op: MapState["renderOps"][number], selected?: MapState["selected"]): MapState => ({
    ...initialMapState,
    layers: { "osm-trails": withData },
    renderOps: [op],
    selected,
  });
  const props = (l: { props: unknown }) => l.props as Record<string, unknown>;

  it("multiplies opacity into every color's alpha", () => {
    const [casing, line] = buildDeckLayers(stateFor({ layerId: "osm-trails", mode: "lines", visible: true, opacity: 0.5 }));
    expect(props(casing).getLineColor).toEqual([255, 255, 255, 128]);
    expect(props(line).getLineColor).toEqual(hexToRgba(layer.style.color, 128));
    const [poly] = buildDeckLayers(stateFor({ layerId: "osm-trails", mode: "polygons", visible: true, opacity: 0.5 }));
    expect(props(poly).getFillColor).toEqual(hexToRgba(layer.style.color, 32));
  });

  it("leaves heat to the Mapbox heatmap (no deck layers)", () => {
    expect(buildDeckLayers(stateFor({ layerId: "osm-trails", mode: "heat", visible: true }))).toHaveLength(0);
  });

  it("still throws for hexbin", () => {
    expect(() => buildDeckLayers(stateFor({ layerId: "osm-trails", mode: "hexbin", visible: true }))).toThrow(
      "NotImplemented: hexbin",
    );
  });

  it("fades siblings of the selected feature and re-triggers the color accessors", () => {
    const op = { layerId: "osm-trails", mode: "lines" as const, visible: true };
    const plain = buildDeckLayers(stateFor(op));
    const selected = buildDeckLayers(stateFor(op, { layerId: "osm-trails", feature: a, lngLat: [-120, 39] }));
    const getColor = props(selected[1]).getLineColor as (f: GeoJSON.Feature) => number[];
    expect(typeof getColor).toBe("function");
    expect(getColor(a)).toEqual(hexToRgba(layer.style.color));
    expect(getColor(b)[3]).toBe(Math.round(255 * SIBLING_FADE));
    const triggers = (l: { props: unknown }) => (props(l).updateTriggers as { getLineColor: unknown }).getLineColor;
    expect(triggers(selected[1])).not.toEqual(triggers(plain[1]));
  });

  it("leaves other layers alone when a feature of a different layer is selected", () => {
    const op = { layerId: "osm-trails", mode: "lines" as const, visible: true };
    const [, line] = buildDeckLayers(stateFor(op, { layerId: "campsites", feature: a, lngLat: [-120, 39] }));
    expect(props(line).getLineColor).toEqual(hexToRgba(layer.style.color));
  });
});
