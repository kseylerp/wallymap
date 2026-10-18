import type { Map as MapboxMap } from "mapbox-gl";
import { describe, expect, it } from "vitest";
import {
  ensureHatchImages,
  heatColor,
  heatEntries,
  heatLayerSpec,
  heatPointsCollection,
  insertBeforeId,
  LAND_OUTLINE,
  landFillOpacity,
  landHatchOpacity,
  syncHeatLayers,
  syncTileLayers,
  vectorHatchPattern,
  vectorTileLayerSpecs,
} from "@/components/mapTiles";
import { DARK_GREY, OFF_WHITE, PINK, PURPLE, SAGE, WHITE } from "@/lib/render/palette";
import { hexToRgb, lightness } from "@/lib/render/ramp";
import type { LayerResult, StyleHints } from "@/layers/types";
import { buildDeckLayerSets } from "@/lib/render/deck";
import { pickUnderHeat } from "@/lib/render/inspect";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type MapAction, type MapState } from "@/lib/render/state";
import { visibleState } from "@/lib/render/view";

const STYLE = { geometry: "polygon" as const, color: "#B9A6FF" };

describe("vectorTileLayerSpecs", () => {
  it("colors vector tile areas by the legend's field and item colors (public lands by manager)", () => {
    const specs = vectorTileLayerSpecs("public-lands", STYLE, "padus", "polygon", true, {}, { field: "Mang_Type", colors: [["FED", "#6E5BFF"], ["STAT", "#F57272"]] });
    const fill = specs[0].paint as Record<string, unknown>;
    expect(fill["fill-color"]).toEqual(["match", ["to-string", ["get", "Mang_Type"]], "FED", "#6E5BFF", "STAT", "#F57272", SAGE]);
    expect(JSON.stringify(specs[1].paint)).toContain("hatch-6E5BFF-1");
  });

  it("draws public land as the sage area recipe: tint, 45° hatch, a dark grey outline over a white casing", () => {
    const specs = vectorTileLayerSpecs("public-lands", STYLE, "padus", "polygon", true);
    expect(specs.map((s) => s.id)).toEqual(["tiles-public-lands", "tiles-public-lands-hatch", "tiles-public-lands-casing", "tiles-public-lands-line"]);
    const [fill, hatch, casing, line] = specs;
    expect(fill).toMatchObject({
      type: "fill",
      source: "tiles-public-lands",
      "source-layer": "padus",
      layout: { visibility: "visible" },
      paint: { "fill-color": SAGE, "fill-opacity": landFillOpacity(1, 0.18) },
    });
    expect(hatch).toMatchObject({
      type: "fill",
      source: "tiles-public-lands",
      paint: { "fill-pattern": "hatch-9FB693-1", "fill-opacity": landHatchOpacity(1, 0.9) },
    });
    expect(vectorHatchPattern("public-lands")).toBe("hatch-9FB693-1");
    expect(casing).toMatchObject({ type: "line", paint: { "line-color": WHITE, "line-width": 3.25, "line-opacity": 0.8 } });
    expect(line).toMatchObject({ type: "line", layout: { visibility: "visible" }, paint: { "line-color": DARK_GREY, "line-width": 1.25, "line-opacity": 0.8 } });
    expect(LAND_OUTLINE).toEqual({ opacity: 0.8 });
  });

  it("draws no manager or agency colors: every area is the same sage, whatever its agency", () => {
    const json = JSON.stringify(vectorTileLayerSpecs("public-lands", STYLE, "padus", "polygon", true));
    expect(json).not.toContain("agency");
    expect(json).not.toMatch(/"match"|"case"/);
  });

  it("takes a palette color picked in the panel, ignores any other, and scales by the panel opacity", () => {
    const [fill, hatch, casing, line] = vectorTileLayerSpecs("public-lands", STYLE, "padus", "polygon", true, { color: "#FF5A36", opacity: 0.5 });
    expect((fill as { paint: Record<string, unknown> }).paint["fill-color"]).toBe(SAGE);
    expect((casing as { paint: Record<string, unknown> }).paint["line-opacity"]).toBe(0.4);
    expect((line as { paint: Record<string, unknown> }).paint["line-opacity"]).toBe(0.4);
    expect((hatch as { paint: Record<string, unknown> }).paint["fill-opacity"]).toEqual(landHatchOpacity(0.5, 0.9));
    const [purple] = vectorTileLayerSpecs("public-lands", STYLE, "padus", "polygon", true, { color: PURPLE });
    expect((purple as { paint: Record<string, unknown> }).paint["fill-color"]).toBe(PURPLE);
  });

  it("hides every spec when not visible", () => {
    for (const spec of vectorTileLayerSpecs("x", STYLE, "s", "polygon", false)) {
      expect(spec.layout).toMatchObject({ visibility: "none" });
    }
  });

  // Owner, 2026-10-14: no dark grey line cores anywhere; vector tile lines are sage like every data line.
  it("draws lines sage over a white casing", () => {
    const specs = vectorTileLayerSpecs("roads", { geometry: "line", color: "#123456" }, "roads", "line", true);
    expect(specs.map((s) => s.id)).toEqual(["tiles-roads-casing", "tiles-roads"]);
    expect(specs[0]).toMatchObject({ type: "line", paint: { "line-color": WHITE, "line-width": 4.5 } });
    expect(specs[1]).toMatchObject({ type: "line", "source-layer": "roads", paint: { "line-color": SAGE, "line-width": 2.5 } });
    // A requested dark grey reads as sage too; other palette colors stand.
    expect(vectorTileLayerSpecs("roads", { geometry: "line", color: "#123456" }, "roads", "line", true, { color: DARK_GREY })[1].paint).toMatchObject({ "line-color": SAGE });
    expect(vectorTileLayerSpecs("roads", { geometry: "line", color: "#123456" }, "roads", "line", true, { color: PINK })[1].paint).toMatchObject({ "line-color": PINK });
  });

  it("draws points as off-white circles stroked dark grey", () => {
    const specs = vectorTileLayerSpecs("pts", { geometry: "point", color: "#654321" }, "pts", "point", true);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ id: "tiles-pts", type: "circle", paint: { "circle-color": OFF_WHITE, "circle-stroke-color": DARK_GREY } });
  });
});

describe("landFillOpacity", () => {
  it("interpolates the tint on zoom, fading to 30% of it by trailhead zooms", () => {
    expect(landFillOpacity(1, 0.1)).toEqual(["interpolate", ["linear"], ["zoom"], 9, 0.1, 12, 0.08, 13.5, 0.05, 15, 0.03]);
  });

  it("scales every stop by the layer panel opacity", () => {
    expect(landFillOpacity(0.5, 0.1)).toEqual(["interpolate", ["linear"], ["zoom"], 9, 0.05, 12, 0.04, 13.5, 0.025, 15, 0.015]);
  });
});

describe("ensureHatchImages", () => {
  it("adds each hatch pattern once, at 2x, and skips ids that are not hatches", () => {
    const added: string[] = [];
    const images = new Set<string>();
    const map = {
      hasImage: (id: string) => images.has(id),
      addImage: (id: string, image: { width: number; height: number }, options: { pixelRatio: number }) => {
        added.push(`${id} ${image.width}x${image.height} @${options.pixelRatio}`);
        images.add(id);
      },
    } as unknown as MapboxMap;
    ensureHatchImages(map, ["hatch-9FB693-1", "hatch-9FB693-1", "not-a-hatch"]);
    ensureHatchImages(map, ["hatch-9FB693-1"]);
    expect(added).toEqual(["hatch-9FB693-1 72x72 @2"]);
  });
});

type FakeLayer = {
  id: string;
  type: string;
  source?: string;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
};

/** A stand-in for the Mapbox map that records every mutating call. */
function fakeMap(initialLayers: FakeLayer[] = [{ id: "land", type: "background" }, { id: "road-label", type: "symbol" }]) {
  const layers: FakeLayer[] = initialLayers.map((l) => ({ ...l }));
  const sources: Record<string, { type: string; tiles?: string[]; tileSize?: number; data?: unknown }> = {};
  const calls: string[] = [];
  const images = new Set<string>();
  const map = {
    hasImage: (id: string) => images.has(id),
    addImage: (id: string) => {
      calls.push(`addImage ${id}`);
      images.add(id);
    },
    getStyle: () => ({ layers: layers.map((l) => ({ ...l })), sources: { ...sources } }),
    getLayer: (id: string) => layers.find((l) => l.id === id),
    getSource: (id: string) =>
      sources[id] && {
        ...sources[id],
        setData: (data: unknown) => {
          calls.push(`setData ${id}`);
          sources[id] = { ...sources[id], data } as (typeof sources)[string];
        },
      },
    addSource: (id: string, spec: { type: string; tiles?: string[] }) => {
      calls.push(`addSource ${id}`);
      sources[id] = spec;
    },
    removeSource: (id: string) => {
      calls.push(`removeSource ${id}`);
      delete sources[id];
    },
    addLayer: (spec: FakeLayer, beforeId?: string) => {
      calls.push(`addLayer ${spec.id}`);
      const index = beforeId ? layers.findIndex((l) => l.id === beforeId) : -1;
      if (index === -1) layers.push(spec);
      else layers.splice(index, 0, spec);
    },
    removeLayer: (id: string) => {
      calls.push(`removeLayer ${id}`);
      layers.splice(layers.findIndex((l) => l.id === id), 1);
    },
    setLayoutProperty: (id: string, property: string, value: unknown) => {
      calls.push(`setLayout ${id} ${property}=${String(value)}`);
      const layer = layers.find((l) => l.id === id);
      if (layer) layer.layout = { ...layer.layout, [property]: value };
    },
    setPaintProperty: (id: string, property: string, value: unknown) => {
      const layer = layers.find((l) => l.id === id);
      if (layer) layer.paint = { ...layer.paint, [property]: value };
    },
    moveLayer: (id: string, beforeId?: string) => {
      calls.push(`moveLayer ${id}`);
      const [layer] = layers.splice(layers.findIndex((l) => l.id === id), 1);
      const index = beforeId ? layers.findIndex((l) => l.id === beforeId) : -1;
      if (index === -1) layers.push(layer);
      else layers.splice(index, 0, layer);
    },
  };
  return { map: map as unknown as MapboxMap, calls, layers, sources };
}

const PADUS_URL = "https://storage.googleapis.com/wally-tiles/padus/v1/{z}/{x}/{y}.pbf";

function stateWith(options: { url?: string; visible?: boolean; raster?: { tileSize?: number } } = {}): MapState {
  const data: Extract<LayerResult, { kind: "tiles" }>["data"] = options.raster
    ? { url: "https://example.test/{z}/{x}/{y}.png", minzoom: 3, maxzoom: 12, format: "raster", ...options.raster }
    : { url: options.url ?? PADUS_URL, minzoom: 3, maxzoom: 12, format: "vector", sourceLayer: "padus", geometry: "polygon" };
  const result: LayerResult = {
    kind: "tiles",
    data,
    citation: { source: "PAD-US", url: "https://example.test", retrieved: "2026-10-09T00:00:00Z" },
  };
  return {
    ...initialMapState,
    layers: {
      "public-lands": { id: "public-lands", title: "Public land", style: STYLE, result, receivedAt: "2026-10-09T00:00:00Z" },
    },
    renderOps:
      options.visible === undefined ? [] : [{ layerId: "public-lands", mode: "polygons", visible: options.visible }],
  };
}

describe("syncTileLayers", () => {
  it("adds the vector source, its hatch image and its four layers once, under the first label, however often it runs", () => {
    const { map, calls, layers } = fakeMap();
    syncTileLayers(map, stateWith());
    syncTileLayers(map, stateWith());
    expect(calls.filter((c) => c.startsWith("addSource"))).toEqual(["addSource tiles-public-lands"]);
    expect(calls.filter((c) => c.startsWith("addImage"))).toEqual(["addImage hatch-9FB693-1"]);
    expect(calls.filter((c) => c.startsWith("addLayer"))).toEqual([
      "addLayer tiles-public-lands",
      "addLayer tiles-public-lands-hatch",
      "addLayer tiles-public-lands-casing",
      "addLayer tiles-public-lands-line",
    ]);
    expect(layers.map((l) => l.id)).toEqual([
      "land",
      "tiles-public-lands",
      "tiles-public-lands-hatch",
      "tiles-public-lands-casing",
      "tiles-public-lands-line",
      "road-label",
    ]);
  });

  it("removes the layers before their source when the layer leaves the state", () => {
    const { map, calls, layers, sources } = fakeMap();
    syncTileLayers(map, stateWith());
    calls.length = 0;
    syncTileLayers(map, initialMapState);
    expect(calls).toEqual([
      "removeLayer tiles-public-lands",
      "removeLayer tiles-public-lands-hatch",
      "removeLayer tiles-public-lands-casing",
      "removeLayer tiles-public-lands-line",
      "removeSource tiles-public-lands",
    ]);
    expect(layers.map((l) => l.id)).toEqual(["land", "road-label"]);
    expect(sources).toEqual({});
  });

  it("toggles layout visibility on all four layers", () => {
    const { map, layers } = fakeMap();
    syncTileLayers(map, stateWith({ visible: true }));
    syncTileLayers(map, stateWith({ visible: false }));
    const ours = () => layers.filter((l) => l.id.startsWith("tiles-")).map((l) => l.layout?.visibility);
    expect(ours()).toEqual(["none", "none", "none", "none"]);
    syncTileLayers(map, stateWith({ visible: true }));
    expect(ours()).toEqual(["visible", "visible", "visible", "visible"]);
  });

  it("drops and re-adds the source when the tile URL changes", () => {
    const { map, calls, sources } = fakeMap();
    syncTileLayers(map, stateWith());
    calls.length = 0;
    const next = "https://storage.googleapis.com/wally-tiles/padus/v2/{z}/{x}/{y}.pbf";
    syncTileLayers(map, stateWith({ url: next }));
    expect(calls.filter((c) => !c.startsWith("setLayout") && !c.startsWith("moveLayer"))).toEqual([
      "removeLayer tiles-public-lands",
      "removeLayer tiles-public-lands-hatch",
      "removeLayer tiles-public-lands-casing",
      "removeLayer tiles-public-lands-line",
      "removeSource tiles-public-lands",
      "addSource tiles-public-lands",
      "addLayer tiles-public-lands",
      "addLayer tiles-public-lands-hatch",
      "addLayer tiles-public-lands-casing",
      "addLayer tiles-public-lands-line",
    ]);
    expect(sources["tiles-public-lands"].tiles).toEqual([next]);
  });

  it("gives raster sources the result's tileSize, defaulting to 256", () => {
    const big = fakeMap();
    syncTileLayers(big.map, stateWith({ raster: { tileSize: 512 } }));
    expect(big.sources["tiles-public-lands"]).toMatchObject({ type: "raster", tileSize: 512 });
    const plain = fakeMap();
    syncTileLayers(plain.map, stateWith({ raster: {} }));
    expect(plain.sources["tiles-public-lands"]).toMatchObject({ type: "raster", tileSize: 256 });
  });
});

describe("syncTileLayers with layer panel settings", () => {
  const rasterResult = (url: string): LayerResult => ({
    kind: "tiles",
    data: { url, minzoom: 0, maxzoom: 12, format: "raster" },
    citation: { source: "x", url: "https://example.test", retrieved: "2026-10-09" },
  });
  const twoRasters = (order: string[], opacity?: number): MapState => ({
    ...initialMapState,
    layers: Object.fromEntries(
      ["a", "b"].map((id) => [
        id,
        { id, title: id, style: STYLE, result: rasterResult(`https://example.test/${id}/{z}/{x}/{y}.png`), receivedAt: "" },
      ]),
    ),
    renderOps: order.map((layerId) => ({ layerId, mode: "polygons", visible: true, ...(opacity !== undefined && { opacity }) })),
  });

  it("scales raster and vector opacity by the render op", () => {
    const raster = fakeMap();
    syncTileLayers(raster.map, twoRasters(["a", "b"], 0.5));
    expect(raster.layers.find((l) => l.id === "tiles-a")?.paint).toMatchObject({ "raster-opacity": 0.36 });
    const vector = fakeMap();
    syncTileLayers(vector.map, stateWith({ visible: true }));
    const faded = stateWith({ visible: true });
    faded.renderOps = [{ ...faded.renderOps[0], opacity: 0.5 }];
    syncTileLayers(vector.map, faded);
    expect(vector.layers.find((l) => l.id === "tiles-public-lands")?.paint).toMatchObject({ "fill-opacity": landFillOpacity(0.5, 0.18) });
  });

  it("calms third-party rasters by default and applies a layer's raster hint to the Mapbox paint", () => {
    const withStyle = (style: StyleHints): MapState => {
      const state = twoRasters(["a", "b"]);
      state.layers.a = { ...state.layers.a, style };
      return state;
    };
    const plain = fakeMap();
    syncTileLayers(plain.map, twoRasters(["a", "b"]));
    expect(plain.layers.find((l) => l.id === "tiles-a")?.paint).toMatchObject({
      "raster-opacity": 0.72,
      "raster-saturation": -0.55,
      "raster-hue-rotate": 0,
      "raster-brightness-max": 1,
    });
    const hinted = fakeMap();
    const raster = { saturation: -0.5, hueRotate: 40, contrast: 0.1, brightnessMin: 0.05, brightnessMax: 0.92, opacity: 0.6 };
    syncTileLayers(hinted.map, withStyle({ ...STYLE, raster }));
    expect(hinted.layers.find((l) => l.id === "tiles-a")?.paint).toMatchObject({
      "raster-saturation": -0.5,
      "raster-hue-rotate": 40,
      "raster-contrast": 0.1,
      "raster-brightness-min": 0.05,
      "raster-brightness-max": 0.92,
      "raster-opacity": 0.6,
    });
    // Panel opacity and a compare side hidden by opacity still scale the hint's opacity.
    const faded = withStyle({ ...STYLE, raster });
    faded.renderOps = [{ layerId: "a", mode: "polygons", visible: true, opacity: 0.5 }];
    syncTileLayers(hinted.map, faded);
    expect(hinted.layers.find((l) => l.id === "tiles-a")?.paint?.["raster-opacity"]).toBeCloseTo(0.3);
  });

  it("leaves raster: null layers (imagery) as served, with only the existing 0.8 opacity", () => {
    const { map, layers } = fakeMap();
    const state = twoRasters(["a", "b"]);
    state.layers.a = { ...state.layers.a, style: { ...STYLE, raster: null } };
    syncTileLayers(map, state);
    expect(layers.find((l) => l.id === "tiles-a")?.paint).toMatchObject({
      "raster-opacity": 0.8,
      "raster-saturation": 0,
      "raster-hue-rotate": 0,
      "raster-contrast": 0,
      "raster-brightness-min": 0,
      "raster-brightness-max": 1,
    });
  });

  it("stacks tile layers in render-op order and restacks after a reorder", () => {
    const { map, layers, calls } = fakeMap();
    syncTileLayers(map, twoRasters(["a", "b"]));
    expect(layers.map((l) => l.id)).toEqual(["land", "road-label", "tiles-a", "tiles-b"]);
    syncTileLayers(map, twoRasters(["a", "b"]));
    expect(calls.some((c) => c.startsWith("moveLayer"))).toBe(false);
    syncTileLayers(map, twoRasters(["b", "a"]));
    expect(layers.map((l) => l.id)).toEqual(["land", "road-label", "tiles-b", "tiles-a"]);
  });
});

describe("heat mode (Mapbox heatmap)", () => {
  const fc: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", geometry: { type: "Point", coordinates: [-120, 39] }, properties: { v: 10 } },
      { type: "Feature", geometry: { type: "LineString", coordinates: [[-121, 38], [-119, 40]] }, properties: { v: 5 } },
    ],
  };
  const heatState = (mode: "heat" | "lines", opacity?: number): MapState => ({
    ...initialMapState,
    layers: {
      fires: {
        id: "fires",
        title: "Fires",
        style: { geometry: "point", color: "#D97757" },
        result: { kind: "geojson", data: fc, citation: { source: "x", url: "https://x.test", retrieved: "" } },
        receivedAt: "",
      },
    },
    renderOps: [{ layerId: "fires", mode, visible: true, ...(opacity !== undefined && { opacity }) }],
  });

  it("weights one point per feature by v against the largest v", () => {
    expect(heatPointsCollection(fc).features).toEqual([
      { type: "Feature", geometry: { type: "Point", coordinates: [-120, 39] }, properties: { w: 1 } },
      { type: "Feature", geometry: { type: "Point", coordinates: [-120, 39] }, properties: { w: 0.5 } },
    ]);
  });

  it("builds a heatmap layer with opacity and the density ramp (off-white → sage → purple → dark grey)", () => {
    const spec = heatLayerSpec("fires", 0.5);
    expect(spec).toMatchObject({ id: "heat-fires", type: "heatmap", source: "heat-fires" });
    expect(spec.paint?.["heatmap-opacity"]).toBeCloseTo(0.45);
    const color = spec.paint?.["heatmap-color"] as unknown[];
    expect(color).toEqual(heatColor());
    expect(color.slice(0, 5)).toEqual(["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(250, 249, 245, 0)"]);
    expect(color.at(-1)).toBe(`rgba(${hexToRgb(DARK_GREY).join(", ")}, 0.85)`);
    // Lightness falls and opacity rises with density.
    const stops = color.slice(5).filter((_, i) => i % 2 === 1) as string[];
    const parsed = stops.map((c) => c.match(/[\d.]+/g)!.map(Number));
    for (let i = 1; i < parsed.length; i++) {
      expect(lightness(parsed[i].slice(0, 3) as [number, number, number])).toBeLessThan(lightness(parsed[i - 1].slice(0, 3) as [number, number, number]));
      expect(parsed[i][3]).toBeGreaterThan(parsed[i - 1][3]);
    }
  });

  it("adds the heat source and layer under the labels, uploads data once, and removes them when the mode changes", () => {
    const { map, layers, calls, sources } = fakeMap();
    syncHeatLayers(map, heatState("heat"));
    syncHeatLayers(map, heatState("heat", 0.5));
    expect(layers.map((l) => l.id)).toEqual(["land", "heat-fires", "road-label"]);
    expect(calls.filter((c) => c.startsWith("setData"))).toEqual([]);
    expect(layers[1].paint?.["heatmap-opacity"]).toBeCloseTo(0.45);
    syncHeatLayers(map, heatState("lines"));
    expect(layers.map((l) => l.id)).toEqual(["land", "road-label"]);
    expect(sources).toEqual({});
  });
});

describe("heat mode under a compare", () => {
  const sighting = (year: number, x: number): GeoJSON.Feature => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [x, 51] },
    properties: { species: "elk", t: `${year}-06-01T00:00:00.000Z` },
  });
  const wildlife: MapState["layers"][string] = {
    id: "species",
    title: "Wildlife",
    style: { geometry: "point", color: "#000000" },
    result: {
      kind: "geojson",
      data: { type: "FeatureCollection", features: [sighting(2019, -115.6), sighting(2020, -115.5), sighting(2024, -115.4)] },
      citation: { source: "s", url: "u", retrieved: "r" },
    },
    receivedAt: "now",
  };
  const base = [
    { type: "layer_loaded", layer: wildlife },
    { type: "render", op: { layerId: "species", mode: "heat", visible: true } },
  ] as MapAction[];
  const compared = (mode: "swipe" | "toggle" | "delta", ...more: MapAction[]): MapState =>
    visibleState(
      [
        ...base,
        { type: "set_compare", compare: { layerId: "species", a: ["2019-01-01", "2020-12-31"], b: ["2021-01-01", "2024-12-31"], mode } } as MapAction,
        ...more,
      ].reduce(reduce, { ...initialMapState, terrain: false }),
    );
  const coords = (e: { data: GeoJSON.FeatureCollection }) => e.data.features.map((f) => (f.geometry as GeoJSON.Point).coordinates[0]);

  it("toggle gives each side its own heatmap and shows only the side on screen", () => {
    const a = heatEntries(compared("toggle"));
    expect(a.map((e) => [e.id, e.shown])).toEqual([["heat-species", true], ["heat-species~b", false]]);
    expect(coords(a[0])).toEqual([-115.6, -115.5]);
    expect(coords(a[1])).toEqual([-115.4]);
    const b = heatEntries(compared("toggle", { type: "compare_flip" }));
    expect(b.map((e) => [e.id, e.shown])).toEqual([["heat-species", false], ["heat-species~b", true]]);

    const { map, layers, calls } = fakeMap();
    syncHeatLayers(map, compared("toggle"));
    syncHeatLayers(map, compared("toggle", { type: "compare_flip" }));
    expect(layers.map((l) => [l.id, l.layout?.visibility])).toEqual([
      ["land", undefined],
      ["heat-species", "none"],
      ["heat-species~b", "visible"],
      ["road-label", undefined],
    ]);
    // Flipping sides only switches visibility; nothing is uploaded again.
    expect(calls.filter((c) => c.startsWith("setData") || c.startsWith("addSource"))).toEqual(["addSource heat-species", "addSource heat-species~b"]);
  });

  it("swipe draws no heatmap; its two sides draw as points in the clipped side overlays", () => {
    const view = compared("swipe");
    expect(heatEntries(view)).toEqual([]);
    const { a, b } = buildDeckLayerSets(view, { mapboxToken: "" });
    expect(a.map((l) => l.id)).toEqual(["species:points"]);
    expect(b.map((l) => l.id)).toEqual(["species~b:points"]);
  });

  it("a click under a toggle's heat picks the side on screen; a swipe leaves picking to deck", () => {
    const project = ([x]: [number, number]) => ({ x: (x + 116) * 1000, y: 0 });
    const at = { x: 600, y: 0 }; // -115.4, side B's sighting
    expect(pickUnderHeat(compared("toggle"), project, at, 10)).toBeNull();
    expect(pickUnderHeat(compared("toggle", { type: "compare_flip" }), project, at, 10)).toMatchObject({ layerId: "species", side: "b" });
    expect(pickUnderHeat(compared("swipe"), project, { x: 400, y: 0 }, 10)).toBeNull();
  });

  it("delta draws its discs only, without a heat haze under them", () => {
    expect(heatEntries(compared("delta"))).toEqual([]);
    const { map, layers } = fakeMap();
    syncHeatLayers(map, visibleState(base.reduce(reduce, initialMapState)));
    expect(layers.map((l) => l.id)).toContain("heat-species");
    syncHeatLayers(map, compared("delta"));
    expect(layers.map((l) => l.id)).toEqual(["land", "road-label"]);
  });
});

describe("insertBeforeId", () => {
  it("returns the first symbol layer so data sits under labels", () => {
    expect(
      insertBeforeId([
        { id: "land", type: "background" },
        { id: "water", type: "fill" },
        { id: "road-label", type: "symbol" },
        { id: "place-label", type: "symbol" },
      ]),
    ).toBe("road-label");
  });

  it("returns undefined when the style has no labels", () => {
    expect(insertBeforeId([{ id: "land", type: "background" }])).toBeUndefined();
    expect(insertBeforeId([])).toBeUndefined();
  });
});
