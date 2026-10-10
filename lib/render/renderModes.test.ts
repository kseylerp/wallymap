import type { Feature } from "geojson";
import { GeoJsonLayer, IconLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import { _TerrainExtension as TerrainExtension } from "@deck.gl/extensions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderModeOf, toolResultToActions, type LayerCatalog } from "@/lib/agent/applyToolResult";
import { TOOL_RENDER_MODES } from "@/lib/agent/tools";
import {
  buildDeckLayers,
  clusterColor,
  clusterPoints,
  clusterRadius,
  columnWallColor,
  hexColumns,
  hexToRgba,
  isClusterFeature,
  rampRgba,
  type ColumnFeature,
} from "@/lib/render/deck";
import { layerIdFromDeckId, pickToSelection, pickUnderHeat, summarizeFeature } from "@/lib/render/inspect";
import { CLUSTER_BLOB, COLUMN_WALL_ALPHAS, DARK_GREY, HEX_COLUMN, OFF_WHITE, PINK, PURPLE, WHITE } from "@/lib/render/palette";
import { CLUSTER_DEFAULT, defaultRenderMode, extentZoom, modeForGeometry, reduce } from "@/lib/render/reducer";
import { isSelectionVisible } from "@/lib/render/view";
import { heatPointsCollection, HEAT_MIN_WEIGHT } from "@/components/mapTiles";
import { decodeState, encodeState, MAX_FILTER_CHARS, restoreFromPermalink } from "@/lib/render/permalink";
import { initialMapState, RENDER_MODES, type LoadedLayer, type MapState, type RenderMode, type RenderOp } from "@/lib/render/state";
import { DECK_TERRAIN_TAG } from "@/lib/render/wally/deckTerrain";

type Props = Record<string, unknown>;
const props = (l: { props: unknown }) => l.props as Props;
const TOKEN = "pk.test";

afterEach(() => vi.restoreAllMocks());

const citation = { source: "iNaturalist", url: "https://www.inaturalist.org", retrieved: "2026-10-09" };

/** `n` sightings around Banff on a 30-wide grid ~2 km apart (a regional extent), named in a cycle of three species. */
function sightings(n: number): Feature[] {
  const names = ["Elk", "Bighorn sheep", "Grizzly bear"];
  return Array.from({ length: n }, (_, i) => ({
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [-115.6 + (i % 30) * 0.03, 51.15 + Math.floor(i / 30) * 0.02] },
    properties: { name: names[i % 3], v: (i % 5) + 1 },
  }));
}

function loaded(id: string, features: Feature[], style: Partial<LoadedLayer["style"]> = {}): LoadedLayer {
  return {
    id,
    title: id,
    style: { geometry: "point", color: DARK_GREY, ...style },
    result: { kind: "geojson", data: { type: "FeatureCollection", features }, citation },
    receivedAt: "2026-10-09T00:00:00Z",
  };
}

function stateWith(layer: LoadedLayer, op: Partial<RenderOp>, extra: Partial<MapState> = {}): MapState {
  return {
    ...initialMapState,
    viewport: { ...initialMapState.viewport, zoom: 9 },
    layers: { [layer.id]: layer },
    renderOps: [{ layerId: layer.id, mode: "points", visible: true, ...op }],
    ...extra,
  };
}

const species = loaded("species", sightings(600), { cluster: true, heat: true, extrude: "count" });

describe("the hexbin bug: every render mode builds without throwing", () => {
  it("draws hexbin as flat H3 tiles instead of throwing NotImplemented", () => {
    const layers = buildDeckLayers(stateWith(species, { mode: "hexbin" }));
    expect(layers[0]).toBeInstanceOf(H3HexagonLayer);
    expect(layers.map((l) => l.id)).toEqual(["species:hexbin", "species:hexbin:labels"]);
  });

  it.each(RENDER_MODES.map((m) => [m]))("builds %s for point, line and area layers", (mode) => {
    const line = loaded("osm-trails", [{ type: "Feature", geometry: { type: "LineString", coordinates: [[-115, 51], [-115.1, 51.1]] }, properties: {} }], { geometry: "line" });
    for (const layer of [species, line]) {
      expect(() => buildDeckLayers(stateWith(layer, { mode }))).not.toThrow();
      expect(() => buildDeckLayers(stateWith(layer, { mode }, { flattened: true }), { mapboxToken: TOKEN })).not.toThrow();
    }
  });

  it("falls back to symbols with one console warning for a mode it does not know", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = stateWith(species, { mode: "sparkles" as RenderMode });
    const layers = buildDeckLayers(state);
    buildDeckLayers(state);
    expect(layers).toHaveLength(1);
    expect(layers[0]).toBeInstanceOf(IconLayer);
    expect(layers[0].id).toBe("species:points");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("sparkles");
  });

  it("keeps every other layer when one op cannot build", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = { ...loaded("broken", []), result: { kind: "geojson", data: { type: "FeatureCollection" }, citation } } as unknown as LoadedLayer;
    const state: MapState = {
      ...stateWith(species, { mode: "clusters" }),
      layers: { species, broken },
      renderOps: [
        { layerId: "broken", mode: "clusters", visible: true },
        { layerId: "species", mode: "clusters", visible: true },
      ],
    };
    const ids = buildDeckLayers(state).map((l) => l.id);
    expect(ids).toContain("species:clusters");
  });
});

describe("clusters", () => {
  it("aggregates every feature into blobs and singletons, cached per result and zoom", () => {
    const data = species.result.kind === "geojson" ? species.result.data : null;
    if (!data) throw new Error("geojson");
    const at9 = clusterPoints(data, 9.4);
    const total = at9.blobs.reduce((n, b) => n + b.properties.point_count, 0) + at9.singles.features.length;
    expect(total).toBe(600);
    expect(at9.blobs.length).toBeGreaterThan(0);
    expect(at9.max).toBe(Math.max(...at9.blobs.map((b) => b.properties.point_count)));
    expect(clusterPoints(data, 9.9)).toBe(at9);
    // Past the index's max zoom every feature stands alone, as the original object.
    const at17 = clusterPoints(data, 17);
    expect(at17.blobs).toHaveLength(0);
    expect(at17.singles.features[0]).toBe(data.features.find((f) => f === at17.singles.features[0]));
    expect(at17.singles.features.every((f) => data.features.includes(f))).toBe(true);
  });

  it("skips features without a usable position", () => {
    const data = { type: "FeatureCollection" as const, features: [...sightings(3), { type: "Feature" as const, geometry: null, properties: {} } as unknown as Feature] };
    const { blobs, singles } = clusterPoints(data, 20);
    expect(blobs.length + singles.features.length).toBe(3);
  });

  it("draws blobs on the gray ramp with a dark grey outline and counts, and singletons as the layer's symbol", () => {
    const layers = buildDeckLayers(stateWith(species, { mode: "clusters" }));
    expect(layers.map((l) => l.id)).toEqual(["species:clusters", "species:clusters:labels", "species:points"]);
    const [blobs, labels, singles] = layers;
    expect(blobs).toBeInstanceOf(ScatterplotLayer);
    expect(labels).toBeInstanceOf(TextLayer);
    expect(singles).toBeInstanceOf(IconLayer);
    expect(props(blobs).pickable).toBe(true);
    // Billboards on 3D terrain: no depth test, so a slope never cuts a blob (or a symbol) in half.
    expect(props(blobs).parameters).toMatchObject({ depthCompare: "always" });
    expect(props(singles).parameters).toMatchObject({ depthCompare: "always" });
    expect(props(blobs).getLineColor).toEqual(hexToRgba(CLUSTER_BLOB.outline));
    expect(props(labels).getColor).toEqual(hexToRgba(DARK_GREY));
    expect(props(labels).outlineColor).toEqual(hexToRgba(WHITE, 240));
    // Same ids on a rebuild.
    expect(buildDeckLayers(stateWith(species, { mode: "clusters" })).map((l) => l.id)).toEqual(layers.map((l) => l.id));
    // On deck's terrain copy the ids carry the 3D tag and the blobs stand on the surface.
    const on3d = buildDeckLayers(stateWith(species, { mode: "clusters" }), { mapboxToken: TOKEN });
    expect(on3d[1].id).toBe(`species${DECK_TERRAIN_TAG}:clusters`);
    expect((props(on3d[1]).extensions as unknown[]).some((e) => e instanceof TerrainExtension)).toBe(true);
  });

  it("sizes blobs by count and shades them off-white to dark grey", () => {
    expect(clusterRadius(2)).toBe(CLUSTER_BLOB.minPx);
    expect(clusterRadius(10_000)).toBe(CLUSTER_BLOB.maxPx);
    expect(clusterRadius(20)).toBeGreaterThan(clusterRadius(5));
    expect(clusterColor(2, 100).slice(0, 3)).toEqual(hexToRgba(OFF_WHITE).slice(0, 3));
    expect(clusterColor(100, 100).slice(0, 3)).toEqual(rampRgba("gray", CLUSTER_BLOB.rampMax).slice(0, 3));
    expect(clusterColor(100, 100)[0]).toBeLessThan(clusterColor(10, 100)[0]);
  });

  it("marks blobs as clusters (a click zooms in) and blob picks name the layer", () => {
    const data = species.result.kind === "geojson" ? species.result.data : null;
    const blob = clusterPoints(data!, 9).blobs[0];
    expect(isClusterFeature(blob)).toBe(true);
    expect(isClusterFeature(data!.features[0])).toBe(false);
    expect(layerIdFromDeckId("species:clusters")).toBe("species");
    expect(layerIdFromDeckId("species@3d:clusters:labels")).toBeNull();
    const pick = pickToSelection({ object: blob, layer: { id: "species:clusters" }, coordinate: [-115.5, 51.2] }, { species: {} });
    expect(pick && isClusterFeature(pick.feature)).toBe(true);
  });
});

describe("heat", () => {
  it("leaves the heatmap to Mapbox and draws only the clicked feature as its symbol", () => {
    expect(buildDeckLayers(stateWith(species, { mode: "heat" }))).toHaveLength(0);
    const data = species.result.kind === "geojson" ? species.result.data : null;
    const feature = data!.features[42];
    const layers = buildDeckLayers(stateWith(species, { mode: "heat" }, { selected: { layerId: "species", feature, lngLat: [-115, 51] } }));
    expect(layers.map((l) => l.id)).toEqual(["species:heat"]);
    expect(props(layers[0]).data).toEqual([feature]);
    expect(layerIdFromDeckId("species:heat")).toBe("species");
  });

  it("picks the nearest real feature under the heat, within the radius", () => {
    const data = species.result.kind === "geojson" ? species.result.data : null;
    const target = data!.features[7];
    const [lng, lat] = (target.geometry as GeoJSON.Point).coordinates;
    // A flat projection: 10,000 px per degree, so neighbors are 30 px apart.
    const project = ([x, y]: [number, number]) => ({ x: (x - lng) * 10_000 + 500, y: (lat - y) * 10_000 + 400 });
    const state = stateWith(species, { mode: "heat" });
    const hit = pickUnderHeat(state, project, { x: 503, y: 401 }, 10);
    expect(hit?.feature).toBe(target);
    expect(hit?.layerId).toBe("species");
    expect(pickUnderHeat(state, project, { x: 515, y: 415 }, 10)).toBeNull();
    expect(pickUnderHeat(stateWith(species, { mode: "points" }), project, { x: 500, y: 400 }, 10)).toBeNull();
  });
});

describe("columns", () => {
  const data = species.result.kind === "geojson" ? species.result.data : null;

  it("stacks points into H3 cells by count (or the sum of v), with the most common names", () => {
    // Ten extra sightings at the trailhead make one cell the clear tallest.
    const hotspot = sightings(10).map((f) => ({ ...f, geometry: { type: "Point" as const, coordinates: [-115.6, 51.15] } }));
    const busy = { type: "FeatureCollection" as const, features: [...data!.features, ...hotspot] };
    const byCount = hexColumns(busy, 7, "count");
    expect(byCount.cells.features.reduce((n, c) => n + c.properties.count, 0)).toBe(610);
    expect(byCount.max).toBe(Math.max(...byCount.cells.features.map((c) => c.properties.count)));
    expect(byCount.cells.features.filter((c) => c.properties.tallest)).toHaveLength(1);
    expect(byCount.caps.features).toHaveLength(byCount.cells.features.length);
    expect(byCount.label).toHaveLength(1);
    const busiest = byCount.cells.features.find((c) => c.properties.tallest)!;
    expect(busiest.properties.top).toMatch(/Elk|Bighorn sheep|Grizzly bear/);
    expect(hexColumns(busy, 7, "count")).toBe(byCount);
    const byV = hexColumns(data!, 7, "v");
    const sumV = data!.features.reduce((n, f) => n + Number(f.properties?.v), 0);
    expect(byV.cells.features.reduce((n, c) => n + (c.properties.v ?? 0), 0)).toBeCloseTo(sumV);
  });

  it("draws translucent white walls by height third, white caps outlined dark grey, only the tallest purple, in 3D", () => {
    const layers = buildDeckLayers(stateWith(species, { mode: "columns" }));
    expect(layers.map((l) => l.id)).toEqual(["species:columns", "species:columns:caps", "species:columns:label"]);
    const [walls, caps] = layers;
    expect(walls).toBeInstanceOf(GeoJsonLayer);
    expect(props(walls).extruded).toBe(true);
    expect(props(walls).material).toBe(false);
    expect(props(walls).wireframe).toBe(true);
    const cells = (props(walls).data as GeoJSON.FeatureCollection).features as ColumnFeature[];
    const fill = props(walls).getFillColor as (f: unknown) => number[];
    const tallest = cells.find((c) => c.properties.tallest)!;
    expect(fill(tallest)).toEqual(hexToRgba(HEX_COLUMN.top, Math.round(255 * HEX_COLUMN.topWallAlpha)));
    const elevation = props(walls).getElevation as (f: unknown) => number;
    expect(Math.max(...cells.map(elevation))).toBe(elevation(tallest));
    const capFill = props(caps).getFillColor as (f: unknown) => number[];
    const capLine = props(caps).getLineColor as (f: unknown) => number[];
    const plainCap = (props(caps).data as GeoJSON.FeatureCollection).features.find((f) => !f.properties?.tallest)!;
    expect(capFill(plainCap)).toEqual(hexToRgba(WHITE, Math.round(255 * HEX_COLUMN.capAlpha)));
    expect(capLine(plainCap)).toEqual(hexToRgba(DARK_GREY));
    expect(columnWallColor(10, 10, false)).toEqual(hexToRgba(WHITE, Math.round(255 * COLUMN_WALL_ALPHAS[0])));
    expect(columnWallColor(5, 10, false)).toEqual(hexToRgba(WHITE, Math.round(255 * COLUMN_WALL_ALPHAS[1])));
    expect(columnWallColor(1, 10, false)).toEqual(hexToRgba(WHITE, Math.round(255 * COLUMN_WALL_ALPHAS[2])));
    expect(columnWallColor(10, 10, true).slice(0, 3)).toEqual(hexToRgba(PURPLE).slice(0, 3));
  });

  it("stands on deck's terrain copy under the 3D tag, and draws flat hex tiles in 2D", () => {
    const on3d = buildDeckLayers(stateWith(species, { mode: "columns" }), { mapboxToken: TOKEN });
    expect(on3d.map((l) => l.id)).toContain(`species${DECK_TERRAIN_TAG}:columns`);
    const walls = on3d.find((l) => l.id === `species${DECK_TERRAIN_TAG}:columns`)!;
    expect(props(walls).terrainDrawMode).toBe("offset");
    const flat = buildDeckLayers(stateWith(species, { mode: "columns" }, { flattened: true }));
    expect(flat[0]).toBeInstanceOf(H3HexagonLayer);
    expect(flat[0].id).toBe("species:hexbin");
  });

  it("gives a picked column's card its count and most common names", () => {
    const cell = hexColumns(data!, 7, "count").cells.features[0];
    const summary = summarizeFeature(cell);
    expect(summary.name).toMatch(/features? in this cell$/);
    expect(summary.rows.map((r) => r.label)).toEqual(expect.arrayContaining(["Features", "Most common"]));
    expect(summary.rows.some((r) => r.label === "Tallest")).toBe(false);
  });

  it("extrudes areas by v in 3D (fire perimeters by acres), and draws them as areas in 2D", () => {
    const ring = (x: number) => [[[x, 51], [x + 0.1, 51], [x + 0.1, 51.1], [x, 51.1], [x, 51]]];
    const fires = loaded(
      "fire-perimeters",
      [100, 5000, 20000].map((acres, i) => ({ type: "Feature" as const, geometry: { type: "Polygon" as const, coordinates: ring(-116 + i * 0.2) }, properties: { v: acres, acres } })),
      { geometry: "polygon", extrude: "v" },
    );
    const layers = buildDeckLayers(stateWith(fires, { mode: "columns" }));
    expect(layers.map((l) => l.id)).toEqual(["fire-perimeters:columns", "fire-perimeters:columns:caps", "fire-perimeters:columns:label"]);
    // No wireframe on areas: a detailed perimeter would draw a dark line at every vertex.
    expect(props(layers[0]).wireframe).toBe(false);
    const elevation = props(layers[0]).getElevation as (f: unknown) => number;
    const features = fires.result.kind === "geojson" ? fires.result.data.features : [];
    expect(elevation(features[2])).toBeGreaterThan(elevation(features[1]));
    expect(elevation(features[1])).toBeCloseTo(elevation(features[2]) / 4);
    const fill = props(layers[0]).getFillColor as (f: unknown) => number[];
    expect(fill(features[2]).slice(0, 3)).toEqual(hexToRgba(PURPLE).slice(0, 3));
    const flat = buildDeckLayers(stateWith(fires, { mode: "columns" }, { flattened: true }));
    expect(flat.map((l) => l.id)).toEqual(["fire-perimeters:polygons:casing", "fire-perimeters:polygons"]);
  });
});

describe("no dark line casings (owner: the black border distorts line colours)", () => {
  const line = (id: string, unit?: "score") =>
    loaded(
      id,
      [0, 50, 100].map((v, i) => ({ type: "Feature" as const, geometry: { type: "LineString" as const, coordinates: [[-115 + i, 51], [-115.1 + i, 51.1]] }, properties: { v, informal: i === 1 } })),
      { geometry: "line", ...(unit && { unit }) },
    );
  const isWhite = (c: number[]) => c[0] === 255 && c[1] === 255 && c[2] === 255;

  it.each([["osm-trails"], ["forest-roads"], ["streams"], ["popularity"]])("every casing under %s is white, selected or not", (id) => {
    const layer = line(id, id === "popularity" ? "score" : undefined);
    const features = layer.result.kind === "geojson" ? layer.result.data.features : [];
    const states = [
      stateWith(layer, { mode: "lines" }),
      stateWith(layer, { mode: "lines" }, { selected: { layerId: id, feature: features[1], lngLat: [-115, 51] } }),
      stateWith(layer, { mode: "lines", color: PURPLE }),
    ];
    for (const state of states) {
      for (const deckLayer of buildDeckLayers(state, { mapboxToken: TOKEN })) {
        if (!deckLayer.id.endsWith(":casing")) continue;
        const color = props(deckLayer).getLineColor as number[] | ((f: Feature) => number[]);
        const colors = typeof color === "function" ? features.map(color) : [color];
        for (const c of colors) expect(isWhite(c) || c[3] === 0).toBe(true);
      }
    }
  });
});

describe("reducer defaults from the layer's hints", () => {
  it("starts a dense cluster-hinted point layer as clusters at a regional zoom, else symbols", () => {
    // Judged by the data's extent, not the camera: still on the globe (z1.5) or already close, a regional layer clusters.
    expect(extentZoom(species.result.kind === "geojson" ? species.result.data : { type: "FeatureCollection", features: [] })).toBeLessThan(CLUSTER_DEFAULT.maxZoom);
    expect(defaultRenderMode(species, 1.5)).toBe("clusters");
    expect(defaultRenderMode(species, 16)).toBe("clusters");
    // The same count packed into one village block fits past z12: symbols.
    const packed = sightings(600).map((f, i) => ({ ...f, geometry: { type: "Point" as const, coordinates: [-115.57 + (i % 30) * 0.0001, 51.178 + Math.floor(i / 30) * 0.0001] } }));
    expect(defaultRenderMode(loaded("species", packed, { cluster: true }), 1.5)).toBe("points");
    expect(defaultRenderMode(loaded("species", sightings(CLUSTER_DEFAULT.minFeatures), { cluster: true }), 9)).toBe("points");
    expect(defaultRenderMode({ ...species, style: { ...species.style, cluster: false } }, 9)).toBe("points");
    expect(defaultRenderMode(loaded("lines", [], { geometry: "line" }), 9)).toBe("lines");
    expect(defaultRenderMode(loaded("areas", [], { geometry: "polygon", extrude: "v" }), 9)).toBe("polygons");
  });

  it("applies the default to a new op, and keeps the current mode on a re-render without one", () => {
    const base: MapState = { ...initialMapState, viewport: { ...initialMapState.viewport, zoom: 9 }, layers: { species } };
    const first = reduce(base, { type: "render", op: { layerId: "species", mode: "points", visible: true }, defaultMode: true });
    expect(first.renderOps[0].mode).toBe("clusters");
    const heat = reduce(first, { type: "set_style", layerId: "species", mode: "heat" });
    const again = reduce(heat, { type: "render", op: { layerId: "species", mode: "points", visible: true }, defaultMode: true });
    expect(again.renderOps[0].mode).toBe("heat");
    // An explicit mode wins.
    expect(reduce(first, { type: "render", op: { layerId: "species", mode: "points", visible: true } }).renderOps[0].mode).toBe("points");
  });

  it("keeps point-only modes off line and area layers", () => {
    const lines = loaded("osm-trails", [], { geometry: "line" });
    const areas = loaded("glaciers", [], { geometry: "polygon", extrude: "v" });
    expect(modeForGeometry("clusters", lines)).toBe("lines");
    expect(modeForGeometry("columns", lines)).toBe("lines");
    expect(modeForGeometry("hexbin", areas)).toBe("polygons");
    expect(modeForGeometry("columns", areas)).toBe("columns");
    expect(modeForGeometry("heat", areas)).toBe("heat");
    expect(modeForGeometry("clusters", species)).toBe("clusters");
    const state = { ...initialMapState, layers: { glaciers: areas }, renderOps: [{ layerId: "glaciers", mode: "polygons" as const, visible: true }] };
    expect(reduce(state, { type: "set_style", layerId: "glaciers", mode: "clusters" }).renderOps[0].mode).toBe("polygons");
  });
});

describe("render tool mapping", () => {
  const catalog: LayerCatalog = {
    species: { title: "Species", style: { geometry: "point", color: DARK_GREY, cluster: true } },
    glaciers: { title: "Glaciers", style: { geometry: "polygon", color: DARK_GREY, extrude: "v" } },
  };
  const render = (output: Record<string, unknown>) => toolResultToActions("render", output, output, { width: 1000, height: 800 }, catalog);

  it("maps symbols to the points mode and passes clusters, heat and columns through", () => {
    expect(render({ layerId: "species", mode: "symbols" })).toEqual([{ type: "render", op: { layerId: "species", mode: "points", visible: true } }]);
    for (const mode of ["clusters", "heat", "columns", "hexbin"] as const) {
      expect(render({ layerId: "species", mode })).toEqual([{ type: "render", op: { layerId: "species", mode, visible: true } }]);
    }
    expect(render({ layerId: "glaciers", mode: "columns" })[0]).toMatchObject({ op: { mode: "columns" } });
  });

  it("lets the reducer choose when mode is omitted, and drops an unreadable mode", () => {
    expect(render({ layerId: "species" })).toEqual([{ type: "render", op: { layerId: "species", mode: "points", visible: true }, defaultMode: true }]);
    expect(render({ layerId: "glaciers" })).toEqual([{ type: "render", op: { layerId: "glaciers", mode: "polygons", visible: true }, defaultMode: true }]);
    expect(render({ layerId: "species", mode: "sparkles" })).toEqual([]);
  });

  it("accepts every mode the tool schema offers", () => {
    for (const mode of TOOL_RENDER_MODES) expect(renderModeOf(mode)).not.toBeNull();
    expect(TOOL_RENDER_MODES).toEqual(expect.arrayContaining(["symbols", "clusters", "heat", "columns"]));
  });
});

describe("permalink", () => {
  it("round-trips every point mode", () => {
    for (const mode of ["clusters", "heat", "columns", "points"] as const) {
      const hash = encodeState({ ...stateWith(species, { mode }), basemap: "outdoors" });
      expect(decodeState(hash)?.layers).toEqual([{ id: "species", mode, visible: true }]);
    }
  });
});

describe("review fixes", () => {
  it("keeps a clicked column, hex tile or blob inspectable while filters and a time window are on", () => {
    const data = species.result.kind === "geojson" ? species.result.data : null;
    const column = hexColumns(data!, 7, "count").cells.features[0];
    const tile = buildDeckLayers(stateWith(species, { mode: "hexbin" }))[0].props.data as Feature[];
    const blob = clusterPoints(data!, 9).blobs[0];
    const filtered = stateWith(species, { mode: "columns", filters: { v: { range: [3, 5] }, name: { include: ["Elk"] } } });
    for (const feature of [column, tile[0], blob]) {
      expect(isSelectionVisible(filtered, { layerId: "species", feature, lngLat: [-115.5, 51.2] })).toBe(true);
    }
    // A real feature the filters exclude still closes its card.
    const outside = data!.features.find((f) => f.properties?.v === 1)!;
    expect(isSelectionVisible(filtered, { layerId: "species", feature: outside, lngLat: [-115.5, 51.2] })).toBe(false);
  });

  it("carries filters in the share link, reads old links, and caps a link with too many", async () => {
    const op: RenderOp = {
      layerId: "species",
      mode: "clusters",
      visible: true,
      filters: { v: { range: [2.5, 40] }, name: { include: ["Elk", "Bighorn sheep", "a:b,c=d+e"] } },
    };
    const hash = encodeState({ ...stateWith(species, op), basemap: "outdoors" });
    expect(hash).toMatch(/&f=species:v:2\.5~40,species:name=Elk\+Bighorn%20sheep\+a%3Ab%2Cc%3Dd%2Be/);
    expect(decodeState(hash)?.layers).toEqual([{ id: "species", mode: "clusters", visible: true, filters: op.filters }]);
    // A link from before filters still reads, with no filters.
    expect(decodeState("#v=-115.6,51.2,10,45,0&l=species:points:1")?.layers).toEqual([{ id: "species", mode: "points", visible: true }]);
    // The restored op carries the filters.
    const actions: unknown[] = [];
    const outcome = await restoreFromPermalink(hash, (a) => actions.push(a), async () => species.result, {
      catalog: { species: { title: "Species", style: species.style } },
      canvas: { width: 1000, height: 800 },
    });
    expect(actions).toContainEqual({ type: "render", op: { layerId: "species", mode: "clusters", visible: true, filters: op.filters } });
    expect(outcome?.filtersDropped).toBeUndefined();
    // Hundreds of category values do not fit: the link keeps what fits and says how many entries it left out.
    const many: RenderOp[] = Array.from({ length: 60 }, (_, i) => ({
      layerId: `layer-${i}`,
      mode: "points",
      visible: true,
      filters: { kind: { include: Array.from({ length: 8 }, (_, k) => `category number ${k}`) } },
    }));
    const big: MapState = { ...initialMapState, layers: Object.fromEntries(many.map((o) => [o.layerId, { ...species, id: o.layerId }])), renderOps: many };
    const capped = encodeState(big);
    const f = /&f=([^&]*)/.exec(capped)?.[1] ?? "";
    expect(f.length).toBeLessThanOrEqual(MAX_FILTER_CHARS);
    const fx = Number(/&fx=(\d+)/.exec(capped)?.[1]);
    expect(fx).toBeGreaterThan(0);
    expect(decodeState(capped)?.filtersDropped).toBe(fx);
  });

  it("weighs heat by the 95th percentile, so one outlier does not blank the layer, and zero v at the minimum", () => {
    const fc = (vs: unknown[]): GeoJSON.FeatureCollection => ({
      type: "FeatureCollection",
      features: vs.map((v) => ({ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { v } })),
    });
    const acres = [...Array.from({ length: 40 }, (_, i) => 100 + i * 10), 380_000];
    const w = heatPointsCollection(fc(acres)).features.map((f) => f.properties?.w as number);
    expect(w.at(-1)).toBe(1);
    expect(w[39]).toBe(1);
    expect(w[0]).toBeGreaterThan(0.2);
    expect(heatPointsCollection(fc([0, 10])).features[0].properties?.w).toBe(HEAT_MIN_WEIGHT);
    expect(heatPointsCollection(fc(["x", "y"])).features.map((f) => f.properties?.w)).toEqual([1, 1]);
  });

  it("tints cluster blobs in a requested compare color so the two sides differ", () => {
    const [blobs] = buildDeckLayers(stateWith(species, { mode: "clusters", color: PINK }));
    expect(props(blobs).getLineColor).toEqual(hexToRgba(PINK));
    const fill = props(blobs).getFillColor as (f: unknown) => number[];
    const one = (props(blobs).data as unknown[])[0];
    expect(fill(one).slice(0, 3)).toEqual(hexToRgba(PINK).slice(0, 3));
  });

  it("makes every column tied for the top purple", () => {
    const tied: Feature[] = [
      ...sightings(3).map((f) => ({ ...f, geometry: { type: "Point" as const, coordinates: [-115.6, 51.15] } })),
      ...sightings(3).map((f) => ({ ...f, geometry: { type: "Point" as const, coordinates: [-114.6, 51.65] } })),
      { ...sightings(1)[0], geometry: { type: "Point", coordinates: [-116.2, 50.9] } },
    ];
    const { cells, label } = hexColumns({ type: "FeatureCollection", features: tied }, 7, "count");
    expect(cells.features.filter((c) => c.properties.tallest).map((c) => c.properties.count)).toEqual([3, 3]);
    expect(label).toHaveLength(2);
    const ring = (x: number) => [[[x, 51], [x + 0.1, 51], [x + 0.1, 51.1], [x, 51.1], [x, 51]]];
    const areas = loaded(
      "glaciers",
      [500, 500, 20].map((v, i) => ({ type: "Feature" as const, geometry: { type: "Polygon" as const, coordinates: ring(i) }, properties: { v } })),
      { geometry: "polygon", extrude: "v" },
    );
    const [walls] = buildDeckLayers(stateWith(areas, { mode: "columns" }));
    const fill = props(walls).getFillColor as (f: unknown) => number[];
    const features = areas.result.kind === "geojson" ? areas.result.data.features : [];
    expect(features.map((f) => fill(f).slice(0, 3))).toEqual([hexToRgba(PURPLE).slice(0, 3), hexToRgba(PURPLE).slice(0, 3), [255, 255, 255]]);
  });
});
