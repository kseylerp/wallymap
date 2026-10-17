import { IconLayer, TextLayer } from "@deck.gl/layers";
import { describe, expect, it } from "vitest";
import { FillStyleExtension, _TerrainExtension as TerrainExtension } from "@deck.gl/extensions";
import { WebMercatorViewport } from "@deck.gl/core";
import { H3HexagonLayer, TerrainLayer } from "@deck.gl/geo-layers";
import {
  SIBLING_FADE,
  SeamlessTerrainLayer,
  UNLIT,
  UnpremultiplyExtension,
  bboxToViewport,
  buildDeckLayers,
  hexLabelSize,
  hexResolution,
  hexTileColor,
  hexToRgba,
  hexbin,
  ignoreTileError,
  metersPerPixel,
  scoreRampColor,
} from "@/lib/render/deck";
import { DARK_GREY, OFF_WHITE, PINK, PURPLE, SAGE, WHITE as WHITE_HEX } from "@/lib/render/palette";
import { pinIconFor } from "@/lib/render/wally/pins";
import { pickToSelection } from "@/lib/render/inspect";
import { initialMapState, RENDER_MODES, type LoadedLayer, type MapState } from "@/lib/render/state";
import { DECK_TERRAIN_TAG } from "@/lib/render/wally/deckTerrain";

const rgba = (hex: string, alpha = 255) => hexToRgba(hex, alpha);
const GREY = rgba(DARK_GREY);
const WHITE = [255, 255, 255, 255];
type Props = Record<string, unknown>;
const props = (l: { props: unknown }) => l.props as Props;
type Accessor = (f: unknown) => number[];
type WidthAccessor = (f: unknown) => number;

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

/** `n` point features, spread out a little. */
function points(n: number): GeoJSON.Feature[] {
  return Array.from({ length: n }, (_, i) => ({
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [-120 + i * 0.001, 39] },
    properties: { kind: i % 2 ? "parking" : "camp_site" },
  }));
}

/** `n` points packed around Tahoe, so they share a handful of cells. */
const dense = (n: number): GeoJSON.Feature[] =>
  Array.from({ length: n }, (_, i) => ({
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [-120.05 + (i % 50) * 0.002, 39.05 + Math.floor(i / 50) * 0.002] },
    properties: {},
  }));

const a: GeoJSON.Feature = { type: "Feature", geometry: { type: "LineString", coordinates: [[-121, 38], [-119, 40]] }, properties: { v: 0 } };
const b: GeoJSON.Feature = { type: "Feature", geometry: { type: "LineString", coordinates: [[-120, 38], [-118, 40]] }, properties: { v: 100 } };

/** A state with `features` loaded as `layerId` (style `geometry`) and one op on it. */
function stateOf(
  layerId: string,
  features: GeoJSON.Feature[],
  op: Partial<MapState["renderOps"][number]> = {},
  { geometry = "point", zoom = 12, unit }: { geometry?: "point" | "line" | "polygon"; zoom?: number; unit?: "score" } = {},
): MapState {
  const mode = op.mode ?? (geometry === "point" ? "points" : geometry === "line" ? "lines" : "polygons");
  return {
    ...initialMapState,
    viewport: { ...initialMapState.viewport, zoom },
    layers: {
      [layerId]: {
        ...layer,
        id: layerId,
        style: { geometry, color: "#F2A33A", ...(unit && { unit }) },
        result: { ...layer.result, data: { type: "FeatureCollection", features } } as LoadedLayer["result"],
      },
    },
    renderOps: [{ layerId, mode, visible: true, ...op }],
  };
}
const select = (state: MapState, feature: GeoJSON.Feature): MapState => ({
  ...state,
  selected: { layerId: state.renderOps[0].layerId, feature, lngLat: [-120, 39] },
});
const trails = (op: Partial<MapState["renderOps"][number]> = {}) => stateOf("osm-trails", [a, b], op, { geometry: "line" });

describe("buildDeckLayers", () => {
  it("yields no layers for an invisible op, an unloaded layer, or a tiles result", () => {
    expect(buildDeckLayers(trails({ visible: false }))).toHaveLength(0);
    expect(buildDeckLayers({ ...initialMapState, renderOps: [{ layerId: "missing", mode: "lines", visible: true }] })).toHaveLength(0);
    const tiles = trails();
    tiles.layers["osm-trails"] = {
      ...layer,
      result: {
        kind: "tiles",
        data: { url: "https://example.com/{z}/{x}/{y}.png", minzoom: 0, maxzoom: 12, format: "raster" },
        citation: layer.result.citation,
      },
    };
    expect(buildDeckLayers(tiles)).toHaveLength(0);
  });

  it("draws every mode without throwing, and leaves heat to Mapbox", () => {
    for (const mode of RENDER_MODES) expect(() => buildDeckLayers(trails({ mode }))).not.toThrow();
    expect(buildDeckLayers(trails({ mode: "heat" }))).toHaveLength(0);
  });
});

// Data lines are native Mapbox line layers now (lib/render/nativeLines.ts, tested in nativeLines.test.ts): deck drew
// them into per-tile terrain textures, soft and jagged on 3D terrain. The deck line, dash and gradient tests that
// stood here moved there as tests of the Mapbox layer specs; only a swiped compare's sides still draw deck lines.
describe("lines leave deck for Mapbox", () => {
  it("builds no deck layers for a lines op, a line layer's columns, flat or on 3D terrain", () => {
    expect(buildDeckLayers(trails())).toHaveLength(0);
    expect(buildDeckLayers(trails({ mode: "columns" }))).toHaveLength(0);
    expect(buildDeckLayers({ ...trails(), terrain: true, flattened: false }, { mapboxToken: "pk.test" }).map((l) => l.id)).toEqual(["wally-terrain"]);
  });

  it("still draws a line layer's symbols, clusters and hex tiles in deck", () => {
    expect(buildDeckLayers(trails({ mode: "points" }))[0]).toBeInstanceOf(IconLayer);
  });
});

describe("deck stroke widths are pixels at every zoom (owner: trails drew as 8 to 14px worms on 3D terrain)", () => {
  it("knows how wide a pixel is on the ground: 78 km at zoom 0 on the equator, half per zoom, narrower toward the poles", () => {
    expect(metersPerPixel(0, 0)).toBeCloseTo(78271.517, 2);
    expect(metersPerPixel(11, 0)).toBeCloseTo(metersPerPixel(10, 0) / 2, 9);
    expect(metersPerPixel(10, 60)).toBeCloseTo(metersPerPixel(10, 0) / 2, 6);
  });

  it("draws area outlines draped on 3D terrain in meters that one pixel spans, and pixels flat", () => {
    const area = stateOf("wilderness", [a], {}, { geometry: "polygon" });
    const [casing, outline] = buildDeckLayers({ ...area, terrain: true, flattened: false, viewport: { ...area.viewport, zoom: 10, latitude: 38 } }, { mapboxToken: "pk.test" }).filter((l) => l.id !== "wally-terrain");
    for (const layer of [casing, outline]) {
      expect(props(layer)).toMatchObject({ lineWidthUnits: "meters" });
      expect(props(layer).lineWidthScale).toBeCloseTo(metersPerPixel(10, 38), 9);
    }
    expect(buildDeckLayers(area).map((l) => props(l).lineWidthUnits)).toEqual(["pixels", "pixels"]);
  });
});

describe("areas: tint, 45° hatch and an outline over a white casing", () => {
  const polys = (layerId: string, op: Partial<MapState["renderOps"][number]> = {}) =>
    stateOf(layerId, [a, b], op, { geometry: "polygon" });
  const fire = (acres: number): GeoJSON.Feature => ({ ...a, properties: { acres, v: acres } });

  it("draws fire perimeters pink: 15% tint, pink hatch, a 1.5px pink outline over a 3.5px white casing", () => {
    const [casing, poly] = buildDeckLayers(polys("fire-perimeters"));
    expect(casing.id).toBe("fire-perimeters:polygons:casing");
    expect(props(casing)).toMatchObject({ pickable: false, filled: false, getLineColor: WHITE, getLineWidth: 3.5 });
    const p = props(poly);
    expect(poly.id).toBe("fire-perimeters:polygons");
    expect(p.pickable).toBe(true);
    expect(p.filled).toBe(true);
    expect((p.getFillPatternBackgroundColor as Accessor)(a)).toEqual(rgba(PINK, Math.round(255 * 0.15)));
    expect(p.getLineColor).toEqual(rgba(PINK));
    expect(p.getLineWidth).toBe(1.5);
    expect(p.fillPatternMask).toBe(true);
    expect(p.fillPatternSizeUnits).toBe("pixels");
    expect(p.getFillPatternScale).toBe(0.5);
    expect((p.extensions as unknown[])[0]).toBeInstanceOf(FillStyleExtension);
    // No 2D canvas in tests: the hatch is off and the fill is the tint.
    expect(p.fillPatternEnabled).toBe(false);
    expect((p.getFillColor as Accessor)(a)).toEqual(rgba(PINK, Math.round(255 * 0.15)));
  });

  it("hatches larger fires denser, in five steps", () => {
    const pattern = props(buildDeckLayers(polys("fire-perimeters"))[1]).getFillPattern as (f: unknown) => string;
    expect([50, 500, 5_000, 50_000, 500_000].map((acres) => pattern(fire(acres)))).toEqual([0, 1, 2, 3, 4].map((s) => `hatch-F57272-${s}`));
    const mapping = props(buildDeckLayers(polys("fire-perimeters"))[1]).fillPatternMapping as Record<string, unknown>;
    expect(mapping["hatch-F57272-4"]).toBeDefined();
  });

  it("tints and hatches protected land sage under a dark grey outline; other areas dark grey", () => {
    for (const id of ["wilderness", "public-lands", "physical-regions"]) {
      const p = props(buildDeckLayers(polys(id))[1]);
      expect((p.getFillPatternBackgroundColor as Accessor)(a)).toEqual(rgba(SAGE, Math.round(255 * 0.12)));
      expect((p.getFillPattern as (f: unknown) => string)(a)).toBe("hatch-9FB693-1");
      expect(p.getLineColor).toEqual(GREY);
    }
    const other = props(buildDeckLayers(polys("something-new"))[1]);
    expect((other.getFillPattern as (f: unknown) => string)(a)).toBe("hatch-3A3A3C-1");
  });

  it("draws a compare side in its color: tint, hatch and outline", () => {
    const p = props(buildDeckLayers(polys("fire-perimeters", { color: PURPLE }))[1]);
    expect((p.getFillPattern as (f: unknown) => string)(fire(500))).toBe("hatch-6E5BFF-1");
    expect(p.getLineColor).toEqual(rgba(PURPLE));
  });

  it("applies op opacity to tint and outline", () => {
    const [casing, poly] = buildDeckLayers(polys("fire-perimeters", { opacity: 0.5 }));
    expect((props(poly).getFillPatternBackgroundColor as Accessor)(a)).toEqual(rgba(PINK, 19));
    expect(props(poly).getLineColor).toEqual(rgba(PINK, 128));
    expect(props(casing).getLineColor).toEqual([255, 255, 255, 128]);
  });

  it("turns the selected area purple with a 2.5px outline, and fades the rest", () => {
    const [casing, poly] = buildDeckLayers(select(polys("fire-perimeters"), a));
    const p = props(poly);
    expect((p.getLineColor as Accessor)(a)).toEqual(rgba(PURPLE));
    expect((p.getFillPattern as (f: unknown) => string)(a)).toMatch(/^hatch-6E5BFF-/);
    expect((p.getLineWidth as WidthAccessor)(a)).toBe(2.5);
    expect((p.getLineWidth as WidthAccessor)(b)).toBe(1.5);
    expect((props(casing).getLineWidth as WidthAccessor)(a)).toBe(4.5);
    expect((p.getFillPatternBackgroundColor as Accessor)(b)[3]).toBe(Math.round(38 * SIBLING_FADE));
  });
});

describe("score areas", () => {
  it("ramp by v with 0.55 to 0.80 opacity", () => {
    expect(scoreRampColor(0)).toEqual(rgba(OFF_WHITE, 140));
    expect(scoreRampColor(100)).toEqual(rgba(DARK_GREY, 204));
    expect(scoreRampColor(100, "remoteness")).toEqual(rgba(DARK_GREY, 204));
    expect(scoreRampColor(250)).toEqual(scoreRampColor(100));
    expect(scoreRampColor(-5)).toEqual(scoreRampColor(0));
    expect(scoreRampColor(undefined)).toEqual(scoreRampColor(0));
  });

  it("shades remoteness cells by its ramp (off-white → sage → dark grey) with white 1px edges; selected purple", () => {
    const state = stateOf("remoteness", [a, b], {}, { geometry: "polygon", unit: "score" });
    const layers = buildDeckLayers(state);
    expect(layers).toHaveLength(1);
    const p = props(layers[0]);
    expect((p.getFillColor as Accessor)(a)).toEqual(rgba(OFF_WHITE, 140));
    expect((p.getFillColor as Accessor)(b)).toEqual(rgba(DARK_GREY, 204));
    expect(p.getLineColor).toEqual(rgba(WHITE_HEX, 204));
    expect(p.getLineWidth).toBe(1);
    const [sel] = buildDeckLayers(select(state, b));
    expect((props(sel).getLineColor as Accessor)(b)).toEqual(rgba(PURPLE));
    expect((props(sel).getLineWidth as WidthAccessor)(b)).toBe(2.5);
  });
});

describe("point symbols", () => {
  it("draws up to 2,000 points as 24px symbols centered on the point", () => {
    const layers = buildDeckLayers(stateOf("campsites", points(2000)));
    expect(layers).toHaveLength(1);
    const [symbols] = layers;
    expect(symbols).toBeInstanceOf(IconLayer);
    expect(symbols.id).toBe("campsites:points");
    const p = props(symbols);
    expect(p.pickable).toBe(true);
    expect(p.getSize).toBe(24);
    expect(p.sizeUnits).toBe("pixels");
    // Without this, GlobeView culls every icon quad.
    expect(p.parameters).toMatchObject({ cullMode: "none" });
    const getIcon = p.getIcon as (f: GeoJSON.Feature) => { url: string; width: number; height: number; anchorY: number };
    const [camp, parking] = points(2);
    // Rasterized at 2x, anchored at the center.
    expect(getIcon(camp)).toMatchObject({ url: pinIconFor("campsites", camp).url, width: 48, height: 48, anchorY: 24 });
    expect(getIcon(parking).url).toBe(pinIconFor("campsites", parking).url);
    expect(getIcon(parking).url).not.toBe(getIcon(camp).url);
    // The same definition every call, so the atlas is not rebuilt per frame.
    expect(getIcon(camp)).toBe(getIcon(points(1)[0]));
    expect((p.getPosition as Accessor)(camp)).toEqual([-120, 39]);
  });

  it("draws the same symbols zoomed out", () => {
    expect(buildDeckLayers(stateOf("campsites", points(3), {}, { zoom: 4 }))[0]).toBeInstanceOf(IconLayer);
  });

  it("places non-point features at their center", () => {
    const line: GeoJSON.Feature = { type: "Feature", geometry: { type: "LineString", coordinates: [[0, 0], [2, 2]] }, properties: {} };
    const p = props(buildDeckLayers(stateOf("campsites", [...points(3), line]))[0]);
    expect((p.getPosition as Accessor)(line)).toEqual([1, 1]);
  });

  it("fills the selected symbol purple at full alpha and fades its siblings to 35%", () => {
    const features = points(3);
    const plain = props(buildDeckLayers(stateOf("species", features))[0]);
    const p = props(buildDeckLayers(select(stateOf("species", features), features[1]))[0]);
    expect((p.getColor as Accessor)(features[1])).toEqual(WHITE);
    expect((p.getColor as Accessor)(features[0])).toEqual([255, 255, 255, Math.round(255 * SIBLING_FADE)]);
    const getIcon = p.getIcon as (f: GeoJSON.Feature) => { url: string };
    expect(getIcon(features[1]).url).toBe(pinIconFor("species", features[1], true).url);
    expect(decodeURIComponent(getIcon(features[1]).url)).toContain(`fill="${PURPLE}"`);
    expect(getIcon(features[0]).url).toBe(pinIconFor("species", features[0]).url);
    const triggers = (q: Props) => q.updateTriggers as Record<string, unknown>;
    expect(triggers(p).getIcon).not.toEqual(triggers(plain).getIcon);
    expect(triggers(p).getColor).not.toEqual(triggers(plain).getColor);
  });

  it("draws fire detections as pink symbols", () => {
    const p = props(buildDeckLayers(stateOf("fire-detections", points(2)))[0]);
    const getIcon = p.getIcon as (f: GeoJSON.Feature) => { url: string };
    expect(decodeURIComponent(getIcon(points(1)[0]).url)).toContain(`fill="${PINK}"`);
  });

  it("applies op opacity, and re-triggers getColor when it changes", () => {
    const features = points(2);
    const at = (opacity: number) => props(buildDeckLayers(select(stateOf("species", features, { opacity }), features[0]))[0]);
    expect(props(buildDeckLayers(stateOf("species", features, { opacity: 0.5 }))[0]).getColor).toEqual([255, 255, 255, 128]);
    expect((at(0.5).updateTriggers as Props).getColor).not.toEqual((at(1).updateTriggers as Props).getColor);
  });
});

describe("H3 tiles for dense points", () => {
  it("switches from symbols to tiles past 2,000 features", () => {
    expect(buildDeckLayers(stateOf("species", dense(2000)))[0]).toBeInstanceOf(IconLayer);
    const layers = buildDeckLayers(stateOf("species", dense(2001)));
    expect(layers[0]).toBeInstanceOf(H3HexagonLayer);
    expect(layers[0].id).toBe("species:hexbin");
    expect(layers[1]).toBeInstanceOf(TextLayer);
    expect(layers[1].id).toBe("species:hexbin:labels");
  });

  it("maps zoom to resolution: z≤6 → 3, 7–8 → 4, 9–10 → 5, 11–12 → 6, ≥13 → 7", () => {
    expect([0, 5, 5.9, 6, 7.5, 8, 9.9, 10, 11.9, 12, 18].map(hexResolution)).toEqual([3, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7]);
  });

  it("draws flat tiles on the gray ramp with white edges at 0.8", () => {
    const p = props(buildDeckLayers(stateOf("species", dense(2001), {}, { zoom: 10 }))[0]);
    expect(p.pickable).toBe(true);
    expect(p.extruded).toBe(false);
    expect(p.coverage).toBe(0.94);
    const hexes = p.data as { properties: { count: number; h3: string } }[];
    expect(hexes.reduce((n, h) => n + h.properties.count, 0)).toBe(2001);
    expect((p.getHexagon as (f: unknown) => string)(hexes[0])).toBe(hexes[0].properties.h3);
    expect((p.getLineColor as Accessor)(hexes[0])).toEqual([255, 255, 255, 204]);
  });

  it("runs from off-white at 55% (fewest) to dark grey at 80% (busiest), log scaled, through the fill accessor", () => {
    expect(hexTileColor(1, 100)).toEqual(rgba(OFF_WHITE, Math.round(255 * 0.55)));
    expect(hexTileColor(100, 100)).toEqual(rgba(DARK_GREY, Math.round(255 * 0.8)));
    const mid = hexTileColor(10, 100);
    expect(mid[0]).toBeLessThan(250);
    expect(mid[0]).toBeGreaterThan(58);
    const tiles: GeoJSON.Feature[] = [
      ...Array.from({ length: 1990 }, () => dense(1)[0]),
      ...dense(11).map((f, i) => ({ ...f, geometry: { type: "Point" as const, coordinates: [-121 + i * 0.5, 40] } })),
    ];
    const p = props(buildDeckLayers(stateOf("species", tiles, {}, { zoom: 10 }))[0]);
    const hexes = p.data as { properties: { count: number } }[];
    const fill = p.getFillColor as Accessor;
    const busiest = hexes.find((h) => h.properties.count === 1990)!;
    const single = hexes.find((h) => h.properties.count === 1)!;
    expect(fill(busiest)).toEqual(rgba(DARK_GREY, 204));
    expect(fill(single)).toEqual(rgba(OFF_WHITE, 140));
  });

  it("skips features with invalid coordinates instead of throwing", () => {
    const bad: GeoJSON.Feature[] = [
      { type: "Feature", geometry: { type: "Point", coordinates: [NaN, 39] }, properties: {} },
      { type: "Feature", geometry: { type: "Point", coordinates: [-120, 95] }, properties: {} },
      { type: "Feature", geometry: { type: "Point", coordinates: [200, 39] }, properties: {} },
    ];
    for (const one of bad) {
      const layers = buildDeckLayers(stateOf("species", [...dense(2000), one], {}, { zoom: 10 }));
      const hexes = props(layers[0]).data as { properties: { count: number } }[];
      expect(hexes.reduce((n, h) => n + h.properties.count, 0)).toBe(2000);
    }
  });

  it("labels grouped tiles with an 11px count on a white halo, dark grey on light tiles and off-white on dark ones, reusing the label list", () => {
    const [hex, labels] = buildDeckLayers(stateOf("species", dense(2001), {}, { zoom: 10 }));
    const all = props(hex).data as { properties: { count: number } }[];
    const p = props(labels);
    const labelled = p.data as { properties: { count: number } }[];
    expect(labelled.length).toBe(all.filter((h) => h.properties.count >= 2).length);
    const max = Math.max(...all.map((h) => h.properties.count));
    const light = labelled.find((h) => Math.log(h.properties.count) / Math.log(max) <= 0.6)!;
    const dark = labelled.find((h) => h.properties.count === max)!;
    expect((p.getColor as Accessor)(light)).toEqual(GREY);
    expect((p.getColor as Accessor)(dark)).toEqual(hexToRgba(OFF_WHITE));
    expect(p.outlineColor).toEqual([255, 255, 255, 230]);
    expect(p.fontSettings).toMatchObject({ sdf: true });
    expect((p.getSize as (f: unknown) => number)(light)).toBe(11);
    expect(p.pickable).toBe(false);
    // Drawn over terrain, never cut by a hill in front of it.
    expect(p.parameters).toMatchObject({ depthCompare: "always" });
    expect(props(buildDeckLayers(stateOf("species", dense(2001), {}, { zoom: 10 }))[1]).data).not.toBe(labelled);
    const state = stateOf("species", dense(2001), {}, { zoom: 10 });
    expect(props(buildDeckLayers(state)[1]).data).toBe(props(buildDeckLayers(state)[1]).data);
  });

  it("keeps a label inside its cell: 11px, then 9px, else none", () => {
    expect(hexLabelSize("12", 60)).toBe(11);
    expect(hexLabelSize("1.5k", 30)).toBe(9);
    expect(hexLabelSize("1.5k", 20)).toBe(0);
    // Zoomed far out, the res-3 cells at z0 are a few pixels wide: no label fits.
    const far = buildDeckLayers(stateOf("species", dense(2001), {}, { zoom: 0 }));
    expect((props(far[1]).data as unknown[]).length).toBe(0);
  });

  it("caches the binning per result and resolution", () => {
    const data: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: dense(10) };
    expect(hexbin(data, 5)).toBe(hexbin(data, 5));
    expect(hexbin(data, 6)).not.toBe(hexbin(data, 5));
    const state = stateOf("species", dense(2001), {}, { zoom: 10 });
    expect(props(buildDeckLayers(state)[0]).data).toBe(props(buildDeckLayers(state)[0]).data);
  });

  it("picks as a Point feature with the tile's count and cell, which the inspect card can select", () => {
    const state = stateOf("species", dense(2001), {}, { zoom: 10 });
    const [hex] = buildDeckLayers(state);
    const tile = (props(hex).data as GeoJSON.Feature[])[0];
    const sel = pickToSelection({ object: tile, layer: { id: hex.id }, coordinate: [-120, 39] }, state.layers);
    expect(sel?.layerId).toBe("species");
    expect(sel?.feature.geometry.type).toBe("Point");
    expect(sel?.feature.properties).toMatchObject({ count: expect.any(Number), h3: expect.any(String) });
  });

  it("outlines the selected tile in 2.5px purple and fades the others and their labels", () => {
    const base = stateOf("species", dense(2001), {}, { zoom: 10 });
    const tiles = props(buildDeckLayers(base)[0]).data as GeoJSON.Feature[];
    const [hex, labels] = buildDeckLayers(select(base, tiles[0]));
    const p = props(hex);
    expect((p.getLineColor as Accessor)(tiles[0])).toEqual(rgba(PURPLE));
    expect((p.getLineWidth as WidthAccessor)(tiles[0])).toBe(2.5);
    expect((p.getLineWidth as WidthAccessor)(tiles[1])).toBe(1);
    const fill = p.getFillColor as Accessor;
    expect(fill(tiles[1])[3]).toBeLessThan((props(buildDeckLayers(base)[0]).getFillColor as Accessor)(tiles[1])[3]);
    const other = (props(labels).data as GeoJSON.Feature[]).find((t) => t !== tiles[0])!;
    expect((props(labels).getColor as Accessor)(other)[3]).toBe(Math.round(255 * SIBLING_FADE));
  });

  it("ignores a tile selected at another resolution instead of fading every tile", () => {
    const at10 = stateOf("species", dense(2001), {}, { zoom: 10 });
    const stale = (props(buildDeckLayers(at10)[0]).data as GeoJSON.Feature[])[0];
    const at12 = select({ ...at10, viewport: { ...at10.viewport, zoom: 12 } }, stale);
    const p = props(buildDeckLayers(at12)[0]);
    const tiles = p.data as GeoJSON.Feature[];
    expect(tiles).not.toContain(stale);
    const plain = props(buildDeckLayers({ ...at10, viewport: { ...at10.viewport, zoom: 12 } })[0]);
    expect((p.getFillColor as Accessor)(tiles[0])).toEqual((plain.getFillColor as Accessor)(tiles[0]));
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
    expect(padded.longitude).toBeLessThan(plain.longitude);
    expect(padded.zoom).toBeLessThan(plain.zoom);
  });
});

describe("draping on 3D terrain", () => {
  const TOKEN = "pk.test";
  const terrainOf = (l: { props: unknown }) => ((props(l).extensions as unknown[]) ?? []).some((e) => e instanceof TerrainExtension);
  const on = (state: MapState) => ({ ...state, terrain: true, flattened: false });

  it("puts an invisible terrain source from Mapbox's DEM first, scaled by the 1.2 exaggeration", () => {
    const [source] = buildDeckLayers(on(trails()), { mapboxToken: TOKEN });
    expect(source).toBeInstanceOf(TerrainLayer);
    const p = props(source);
    expect(p.operation).toBe("terrain+draw");
    expect(p.pickable).toBe(false);
    // Sea tiles the DEM lacks 404; they are skipped without a console error each.
    expect(p.onTileError).toBe(ignoreTileError);
    expect(p.color).toEqual([0, 0, 0, 0]);
    // Unlit, and un-premultiplied at the end, or translucent draped tints darken (fire read maroon).
    expect(p.material).toEqual(UNLIT);
    expect((p.extensions as unknown[])[0]).toBeInstanceOf(UnpremultiplyExtension);
    expect(p.elevationData).toBe("https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1/{z}/{x}/{y}@2x.pngraw?access_token=pk.test");
    const decoder = p.elevationDecoder as Record<string, number>;
    expect(decoder.rScaler).toBeCloseTo(6553.6 * 1.2);
    expect(decoder.offset).toBeCloseTo(-12000);
  });

  it("cuts each terrain tile's mesh at the tile's own edges, so neighbours meet without an overlap band", () => {
    const [source] = buildDeckLayers(on(trails()), { mapboxToken: TOKEN });
    expect(source).toBeInstanceOf(SeamlessTerrainLayer);
    // Load two neighbouring zoom-5 tiles (split at 31.95°N, the seam that crossed West Texas) and keep the bounds deck
    // would mesh them over.
    const meshed: number[][] = [];
    const layer = new SeamlessTerrainLayer({
      id: "t",
      elevationData: "https://dem/{z}/{x}/{y}.png",
      fetch: (_url: unknown, { loadOptions }: { loadOptions?: { terrain: { bounds: number[] } } }) => {
        meshed.push(loadOptions?.terrain.bounds ?? []);
        return Promise.resolve(null);
      },
    });
    const viewport = new WebMercatorViewport({ width: 800, height: 600, longitude: -101.25, latitude: 32, zoom: 5 });
    Object.assign(layer, { context: { viewport }, state: { isTiled: true } });
    const tile = (y: number) => {
      const lat = (row: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / 32))) * 180) / Math.PI;
      return { index: { x: 7, y, z: 5 }, id: `7-${y}-5`, bbox: { west: -101.25, east: -90, north: lat(y), south: lat(y + 1) }, zoom: 5 };
    };
    void layer.getTiledTerrainData(tile(12) as never);
    void layer.getTiledTerrainData(tile(13) as never);
    const exact = (y: number) => {
      const { west, south, east, north } = tile(y).bbox;
      return [...viewport.projectFlat([west, south]), ...viewport.projectFlat([east, north])];
    };
    expect(meshed[0]).toEqual(exact(12));
    expect(meshed[1]).toEqual(exact(13));
    // The northern tile's bottom edge is the southern tile's top edge: shared, not overlapped (deck's own pads by a DEM pixel).
    expect(meshed[0][1]).toBe(meshed[1][3]);
  });

  // Lines no longer drape in deck: Mapbox drapes its own line layers (nativeLines.ts).
  it("drapes polygons (keeping the hatch)", () => {
    const poly = on(stateOf("fire-perimeters", [a], {}, { geometry: "polygon" }));
    for (const l of buildDeckLayers(poly, { mapboxToken: TOKEN }).slice(1)) expect(props(l).terrainDrawMode).toBe("drape");
    expect((props(buildDeckLayers(poly, { mapboxToken: TOKEN })[2]).extensions as unknown[])[0]).toBeInstanceOf(FillStyleExtension);
  });

  it("stands symbols on the surface (offset)", () => {
    const [, symbols] = buildDeckLayers(on(stateOf("campsites", points(3))), { mapboxToken: TOKEN });
    expect(symbols).toBeInstanceOf(IconLayer);
    expect(terrainOf(symbols)).toBe(true);
    expect(props(symbols).terrainDrawMode).toBe("offset");
  });

  it("drapes hex tiles flat on the surface and stands their labels on it", () => {
    const [, hex, labels] = buildDeckLayers(on(stateOf("species", dense(2001), {}, { zoom: 10 })), { mapboxToken: TOKEN });
    expect(props(hex).terrainDrawMode).toBe("drape");
    expect(props(hex).extruded).toBe(false);
    expect(props(labels).terrainDrawMode).toBe("offset");
  });

  it("stays flat with no terrain source when the map is flattened, terrain is off, or there is no token", () => {
    const lines = on(stateOf("fire-perimeters", [a], {}, { geometry: "polygon" }));
    for (const [state, token] of [
      [{ ...lines, flattened: true }, TOKEN],
      [{ ...lines, terrain: false }, TOKEN],
      [lines, ""],
    ] as const) {
      const layers = buildDeckLayers(state, { mapboxToken: token });
      expect(layers.some((l) => l instanceof TerrainLayer)).toBe(false);
      expect(layers.some(terrainOf)).toBe(false);
    }
  });
});

describe("switching 3D on and off", () => {
  const TOKEN = "pk.test";
  const terrainOf = (l: { props: unknown }) => ((props(l).extensions as unknown[]) ?? []).some((e) => e instanceof TerrainExtension);
  const flat = (state: MapState) => ({ ...state, terrain: false });
  const on = (state: MapState) => ({ ...state, terrain: true, flattened: false });
  const dataIds = (state: MapState) =>
    buildDeckLayers(state, { mapboxToken: TOKEN })
      .filter((l) => !(l instanceof TerrainLayer))
      .map((l) => l.id);
  const cases: [string, MapState][] = [
    ["polygons", stateOf("fire-perimeters", [a], {}, { geometry: "polygon" })],
    ["symbols", stateOf("campsites", points(3))],
    ["hex tiles", stateOf("species", dense(2001), {}, { zoom: 10 })],
  ];

  // Deck sets a layer extension up once, when the layer is created, so a live layer cannot gain or lose the terrain
  // extension: it was never drawn after 3D came on, and vanished (and broke picking) after it went off.
  it.each(cases)("gives %s new deck ids when 3D turns on or off, so deck builds fresh layers", (_name, state) => {
    const flatIds = dataIds(flat(state));
    const drapedIds = dataIds(on(state));
    expect(flatIds.length).toBeGreaterThan(0);
    expect(drapedIds).toHaveLength(flatIds.length);
    for (const id of drapedIds) expect(flatIds).not.toContain(id);
    for (const id of drapedIds) expect(id.startsWith(`${state.renderOps[0].layerId}${DECK_TERRAIN_TAG}:`)).toBe(true);
    // Same ids on every build, so ordinary updates still match the live layers.
    expect(dataIds(on(state))).toEqual(drapedIds);
    expect(dataIds(flat(state))).toEqual(flatIds);
  });

  it("keeps the untagged ids and no terrain extension with 3D off", () => {
    const layers = buildDeckLayers(flat(stateOf("fire-perimeters", [a], {}, { geometry: "polygon" })), { mapboxToken: TOKEN });
    expect(layers.map((l) => l.id)).toEqual(["fire-perimeters:polygons:casing", "fire-perimeters:polygons"]);
    expect(layers.some(terrainOf)).toBe(false);
  });

  it("still maps a draped layer's pick back to its app layer", () => {
    const [, , poly] = buildDeckLayers(on(stateOf("fire-perimeters", [a], {}, { geometry: "polygon" })), { mapboxToken: TOKEN });
    const selection = pickToSelection({ object: a, layer: { id: poly.id }, coordinate: [-120, 39] }, { "fire-perimeters": {} });
    expect(selection?.layerId).toBe("fire-perimeters");
  });
});

describe("update triggers follow layer panel edits while the card is open", () => {
  // Lines moved to Mapbox (their paint follows opacity and color in nativeLines.test.ts); polygons keep the triggers.
  it("change with opacity and color for polygons", () => {
    const areas = (op: Partial<MapState["renderOps"][number]> = {}) => stateOf("fire-perimeters", [a, b], op, { geometry: "polygon" });
    const triggers = (state: MapState, accessor: string) =>
      (props(buildDeckLayers(select(state, a)).at(-1)!).updateTriggers as Record<string, unknown>)[accessor];
    for (const accessor of ["getLineColor", "getLineWidth"]) {
      expect(triggers(areas({ opacity: 0.5 }), accessor)).not.toEqual(triggers(areas({ opacity: 1 }), accessor));
      expect(triggers(areas({ color: PINK }), accessor)).not.toEqual(triggers(areas(), accessor));
    }
  });
});
