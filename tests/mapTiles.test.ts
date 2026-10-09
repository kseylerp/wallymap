import type { Map as MapboxMap } from "mapbox-gl";
import { describe, expect, it } from "vitest";
import { insertBeforeId, ownershipFillColor, syncTileLayers, vectorTileLayerSpecs } from "@/components/mapTiles";
import type { LayerResult } from "@/layers/types";
import { initialMapState, type MapState } from "@/lib/render/state";

const STYLE = { geometry: "polygon" as const, color: "#B9A6FF" };

describe("vectorTileLayerSpecs", () => {
  it("builds a fill and a white outline for polygons, keyed tiles-<id>", () => {
    const specs = vectorTileLayerSpecs("public-lands", STYLE, "padus", "polygon", true);
    expect(specs).toHaveLength(2);
    const [fill, line] = specs;
    expect(fill).toMatchObject({
      id: "tiles-public-lands",
      type: "fill",
      source: "tiles-public-lands",
      "source-layer": "padus",
      layout: { visibility: "visible" },
      paint: { "fill-opacity": 0.28 },
    });
    expect(line).toMatchObject({
      id: "tiles-public-lands-line",
      type: "line",
      source: "tiles-public-lands",
      "source-layer": "padus",
      layout: { visibility: "visible" },
      paint: { "line-color": "#FFFFFF", "line-width": 1.5, "line-opacity": 0.9 },
    });
  });

  it("colors polygon fills by manager, falling back to the layer style color", () => {
    const [fill] = vectorTileLayerSpecs("public-lands", STYLE, "padus", "polygon", true);
    expect(fill.type).toBe("fill");
    expect((fill as { paint: Record<string, unknown> }).paint["fill-color"]).toEqual(ownershipFillColor("#B9A6FF"));
  });

  it("hides every spec when not visible", () => {
    for (const spec of vectorTileLayerSpecs("x", STYLE, "s", "polygon", false)) {
      expect(spec.layout).toMatchObject({ visibility: "none" });
    }
  });

  it("draws lines as a single line layer in the style color", () => {
    const specs = vectorTileLayerSpecs("roads", { geometry: "line", color: "#123456" }, "roads", "line", true);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ id: "tiles-roads", type: "line", "source-layer": "roads", paint: { "line-color": "#123456" } });
  });

  it("draws points as a single circle layer in the style color", () => {
    const specs = vectorTileLayerSpecs("pts", { geometry: "point", color: "#654321" }, "pts", "point", true);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ id: "tiles-pts", type: "circle", paint: { "circle-color": "#654321" } });
  });
});

describe("ownershipFillColor", () => {
  const expr = ownershipFillColor("#ABCDEF") as unknown[];
  // ["case", ["has","agency"], agencyMatch, ["has","designation"], designationCase, fallback]
  const agencyMatch = expr[2] as unknown[];

  /** The output that follows the match label list containing `value`. */
  function colorAfterLabel(match: unknown[], value: string): unknown {
    const index = match.findIndex((part) => Array.isArray(part) && part.includes(value));
    return index === -1 ? undefined : match[index + 1];
  }

  it("matches the decoded PAD-US agency values, each list followed by its color", () => {
    expect(expr[0]).toBe("case");
    expect(expr[1]).toEqual(["has", "agency"]);
    expect(agencyMatch[0]).toBe("match");
    for (const agency of ["USFS", "BLM", "NPS", "FWS", "USBR", "USACE", "DOE", "TVA", "ARS", "DOD", "NRCS"]) {
      expect(colorAfterLabel(agencyMatch, agency)).toBe("#B9A6FF");
    }
    for (const agency of ["State", "State Parks"]) expect(colorAfterLabel(agencyMatch, agency)).toBe("#9FC4FF");
    expect(colorAfterLabel(agencyMatch, "NGO")).toBe("#EDEDEA");
    // Local, Tribal and anything unlisted take the match default.
    expect(agencyMatch[agencyMatch.length - 1]).toBe("#D9D4FF");
  });

  it("falls back to the designation when there is no agency, then to the style color", () => {
    expect(expr[3]).toEqual(["has", "designation"]);
    const designationCase = JSON.stringify(expr[4]);
    expect(designationCase).toContain('["get","designation"]');
    expect(designationCase).toContain('"Private"');
    expect(expr[expr.length - 1]).toBe("#ABCDEF");
  });
});

type FakeLayer = { id: string; type: string; source?: string; layout?: Record<string, unknown> };

/** A stand-in for the Mapbox map that records every mutating call. */
function fakeMap(initialLayers: FakeLayer[] = [{ id: "land", type: "background" }, { id: "road-label", type: "symbol" }]) {
  const layers: FakeLayer[] = initialLayers.map((l) => ({ ...l }));
  const sources: Record<string, { type: string; tiles?: string[]; tileSize?: number }> = {};
  const calls: string[] = [];
  const map = {
    getStyle: () => ({ layers: layers.map((l) => ({ ...l })), sources: { ...sources } }),
    getLayer: (id: string) => layers.find((l) => l.id === id),
    getSource: (id: string) => sources[id],
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
  it("adds the vector source and both layers once, under the first label, however often it runs", () => {
    const { map, calls, layers } = fakeMap();
    syncTileLayers(map, stateWith());
    syncTileLayers(map, stateWith());
    expect(calls.filter((c) => c.startsWith("addSource"))).toEqual(["addSource tiles-public-lands"]);
    expect(calls.filter((c) => c.startsWith("addLayer"))).toEqual([
      "addLayer tiles-public-lands",
      "addLayer tiles-public-lands-line",
    ]);
    expect(layers.map((l) => l.id)).toEqual(["land", "tiles-public-lands", "tiles-public-lands-line", "road-label"]);
  });

  it("removes the layers before their source when the layer leaves the state", () => {
    const { map, calls, layers, sources } = fakeMap();
    syncTileLayers(map, stateWith());
    calls.length = 0;
    syncTileLayers(map, initialMapState);
    expect(calls).toEqual([
      "removeLayer tiles-public-lands",
      "removeLayer tiles-public-lands-line",
      "removeSource tiles-public-lands",
    ]);
    expect(layers.map((l) => l.id)).toEqual(["land", "road-label"]);
    expect(sources).toEqual({});
  });

  it("toggles layout visibility on both layers", () => {
    const { map, layers } = fakeMap();
    syncTileLayers(map, stateWith({ visible: true }));
    syncTileLayers(map, stateWith({ visible: false }));
    const ours = () => layers.filter((l) => l.id.startsWith("tiles-")).map((l) => l.layout?.visibility);
    expect(ours()).toEqual(["none", "none"]);
    syncTileLayers(map, stateWith({ visible: true }));
    expect(ours()).toEqual(["visible", "visible"]);
  });

  it("drops and re-adds the source when the tile URL changes", () => {
    const { map, calls, sources } = fakeMap();
    syncTileLayers(map, stateWith());
    calls.length = 0;
    const next = "https://storage.googleapis.com/wally-tiles/padus/v2/{z}/{x}/{y}.pbf";
    syncTileLayers(map, stateWith({ url: next }));
    expect(calls.filter((c) => !c.startsWith("setLayout"))).toEqual([
      "removeLayer tiles-public-lands",
      "removeLayer tiles-public-lands-line",
      "removeSource tiles-public-lands",
      "addSource tiles-public-lands",
      "addLayer tiles-public-lands",
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
