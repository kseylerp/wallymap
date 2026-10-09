import { IconLayer, TextLayer } from "@deck.gl/layers";
import { describe, expect, it } from "vitest";
import { PathStyleExtension, _TerrainExtension as TerrainExtension } from "@deck.gl/extensions";
import { H3HexagonLayer, TerrainLayer } from "@deck.gl/geo-layers";
import {
  SIBLING_FADE,
  bboxToViewport,
  buildDeckLayers,
  hexResolution,
  hexTileColor,
  hexToRgba,
  hexbin,
  scoreRampColor,
} from "@/lib/render/deck";
import { lineDashFor } from "@/lib/render/palette";
import { pickToSelection } from "@/lib/render/inspect";
import { initialMapState, type LoadedLayer, type MapState } from "@/lib/render/state";
import { DECK_TERRAIN_TAG } from "@/lib/render/wally/deckTerrain";

const INK = [31, 31, 31, 255];
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

  it("throws NotImplemented for columns and hexbin, and leaves heat to Mapbox", () => {
    expect(() => buildDeckLayers(trails({ mode: "columns" }))).toThrow("NotImplemented: columns");
    expect(() => buildDeckLayers(trails({ mode: "hexbin" }))).toThrow("NotImplemented: hexbin");
    expect(buildDeckLayers(trails({ mode: "heat" }))).toHaveLength(0);
  });
});

describe("lines: white over a thin ink casing, dashed per layer", () => {
  it("draws a 2.5px white line over a 4.5px ink casing (1px a side), only the line pickable", () => {
    const [casing, line] = buildDeckLayers(trails());
    expect(casing.id).toBe("osm-trails:lines:casing");
    expect(line.id).toBe("osm-trails:lines");
    expect(props(casing)).toMatchObject({ pickable: false, filled: false, getLineColor: INK, getLineWidth: 4.5, lineWidthUnits: "pixels" });
    expect(props(line)).toMatchObject({ pickable: true, filled: false, getLineColor: WHITE, getLineWidth: 2.5, lineWidthUnits: "pixels" });
    expect(props(casing).data).toBe(props(line).data);
  });

  it("ignores the registry color: no colored lines, on any basemap", () => {
    for (const basemap of ["outdoors", "outdoors-satellite", "satellite"] as const) {
      expect(props(buildDeckLayers({ ...trails(), basemap })[1]).getLineColor).toEqual(WHITE);
    }
  });

  it("still honors a color the user or agent asked for, and falls back to white on bad hex", () => {
    expect(props(buildDeckLayers(trails({ color: "#00ff00" }))[1]).getLineColor).toEqual([0, 255, 0, 255]);
    expect(props(buildDeckLayers(trails({ color: "notahex" }))[1]).getLineColor).toEqual(WHITE);
  });

  it("marks layers by the white line's dash: trails solid, forest roads dashed 4/3, others a stable pattern", () => {
    expect(lineDashFor("osm-trails")).toEqual([0, 0]);
    expect(lineDashFor("forest-roads")).toEqual([4, 3]);
    expect(lineDashFor("something-new")).toEqual(lineDashFor("something-new"));
    expect([[4, 3], [2, 2], [8, 3]]).toContainEqual(lineDashFor("something-new"));
    const [casing, line] = buildDeckLayers(stateOf("forest-roads", [a], {}, { geometry: "line" }));
    expect(props(line).getDashArray).toEqual([4, 3]);
    expect((props(line).extensions as unknown[])[0]).toBeInstanceOf(PathStyleExtension);
    expect(props(casing).getDashArray).toBeUndefined();
  });

  it("keeps the same extensions across a basemap switch (deck throws if they change on a live layer)", () => {
    const ext = (basemap: MapState["basemap"]) => props(buildDeckLayers({ ...trails(), basemap })[1]).extensions as unknown[];
    expect(ext("outdoors")).toEqual(ext("outdoors-satellite"));
    expect(ext("outdoors")[0]).toBe(ext("satellite")[0]);
  });

  it("multiplies opacity into every color's alpha", () => {
    const [casing, line] = buildDeckLayers(trails({ opacity: 0.5 }));
    expect(props(casing).getLineColor).toEqual([31, 31, 31, 128]);
    expect(props(line).getLineColor).toEqual([255, 255, 255, 128]);
  });

  it("draws the selected line 3.5px white over 1.5px of ink a side, fades its siblings, and re-triggers", () => {
    const plain = buildDeckLayers(trails());
    const [casing, line] = buildDeckLayers(select(trails(), a));
    const color = props(line).getLineColor as Accessor;
    expect(color(a)).toEqual(WHITE);
    expect(color(b)[3]).toBe(Math.round(255 * SIBLING_FADE));
    expect((props(line).getLineWidth as WidthAccessor)(a)).toBe(3.5);
    expect((props(line).getLineWidth as WidthAccessor)(b)).toBe(2.5);
    expect((props(casing).getLineWidth as WidthAccessor)(a)).toBe(6.5);
    expect((props(casing).getLineWidth as WidthAccessor)(b)).toBe(4.5);
    expect((props(casing).getLineColor as Accessor)(b)[3]).toBe(Math.round(255 * SIBLING_FADE));
    const triggers = (l: { props: unknown }) => props(l).updateTriggers as Record<string, unknown>;
    for (const accessor of ["getLineColor", "getLineWidth"]) {
      expect(triggers(line)[accessor]).not.toEqual(triggers(plain[1])[accessor]);
      expect(triggers(casing)[accessor]).not.toEqual(triggers(plain[0])[accessor]);
    }
  });

  it("leaves other layers alone when a feature of a different layer is selected", () => {
    const state = { ...trails(), selected: { layerId: "campsites", feature: a, lngLat: [-120, 39] as [number, number] } };
    expect(props(buildDeckLayers(state)[1]).getLineColor).toEqual(WHITE);
  });
});

describe("polygons: white outline over ink, light ink wash", () => {
  const polys = (layerId: string, op: Partial<MapState["renderOps"][number]> = {}) =>
    stateOf(layerId, [a, b], op, { geometry: "polygon" });

  it("outlines in 1px white over 0.5px of ink a side, above a 10% ink fill by default (fire perimeters too)", () => {
    for (const id of ["fire-perimeters", "something-new"]) {
      const [casing, poly] = buildDeckLayers(polys(id));
      expect(casing.id).toBe(`${id}:polygons:casing`);
      expect(props(casing)).toMatchObject({ pickable: false, filled: false, getLineColor: INK, getLineWidth: 2 });
      const p = props(poly);
      expect(poly.id).toBe(`${id}:polygons`);
      expect(p.pickable).toBe(true);
      expect(p.getFillColor).toEqual([31, 31, 31, Math.round(255 * 0.1)]);
      expect(p.getLineColor).toEqual(WHITE);
      expect(p.getLineWidth).toBe(1);
      expect(p.lineWidthUnits).toBe("pixels");
    }
  });

  it("outlines boundaries (wilderness, public lands, regions) with no fill", () => {
    for (const id of ["wilderness", "public-lands", "physical-regions"]) {
      expect(props(buildDeckLayers(polys(id))[1]).filled).toBe(false);
    }
  });

  it("applies op opacity to fill and outline", () => {
    const [casing, poly] = buildDeckLayers(polys("fire-perimeters", { opacity: 0.5 }));
    expect(props(poly).getFillColor).toEqual([31, 31, 31, 13]);
    expect(props(poly).getLineColor).toEqual([255, 255, 255, 128]);
    expect(props(casing).getLineColor).toEqual([31, 31, 31, 128]);
  });

  it("outlines the selected polygon 2.5px white over 1px of ink a side", () => {
    const [casing, poly] = buildDeckLayers(select(polys("fire-perimeters"), a));
    const p = props(poly);
    expect((p.getLineWidth as WidthAccessor)(a)).toBe(2.5);
    expect((p.getLineWidth as WidthAccessor)(b)).toBe(1);
    expect((props(casing).getLineWidth as WidthAccessor)(a)).toBe(4.5);
    expect((p.getFillColor as Accessor)(b)[3]).toBe(Math.round(26 * SIBLING_FADE));
  });
});

describe("score ramp", () => {
  it("runs from white at 25% alpha (v 0) to ink at 70% (v 100)", () => {
    expect(scoreRampColor(0)).toEqual([255, 255, 255, 64]);
    expect(scoreRampColor(100)).toEqual([31, 31, 31, 179]);
    expect(scoreRampColor(50)).toEqual([143, 143, 143, 121]);
  });

  it("clamps out-of-range scores and treats a missing v as 0", () => {
    expect(scoreRampColor(250)).toEqual(scoreRampColor(100));
    expect(scoreRampColor(-5)).toEqual(scoreRampColor(0));
    expect(scoreRampColor(undefined)).toEqual(scoreRampColor(0));
  });

  it("shades score polygons (remoteness) by v in gray under a faint ink outline; selected, white over ink", () => {
    const state = stateOf("remoteness", [a, b], {}, { geometry: "polygon", unit: "score" });
    const [casing, poly] = buildDeckLayers(state);
    const p = props(poly);
    expect((p.getFillColor as Accessor)(a)).toEqual([255, 255, 255, 64]);
    expect((p.getFillColor as Accessor)(b)).toEqual([31, 31, 31, 179]);
    expect(p.getLineColor).toEqual([31, 31, 31, 51]);
    expect(p.getLineWidth).toBe(0.5);
    expect(props(casing).getLineWidth).toBe(0);
    const [selCasing, selPoly] = buildDeckLayers(select(state, b));
    expect((props(selPoly).getLineColor as Accessor)(b)).toEqual(WHITE);
    expect((props(selPoly).getLineWidth as WidthAccessor)(b)).toBe(2.5);
    expect((props(selCasing).getLineWidth as WidthAccessor)(b)).toBe(4.5);
    expect((props(selCasing).getLineWidth as WidthAccessor)(a)).toBe(0);
  });
});

describe("point symbols", () => {
  it("draws up to 2,000 points as 24px monochrome symbols centered on the point", () => {
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
    expect(getIcon(camp)).toMatchObject({ url: "/pins/camp.svg", width: 48, height: 48, anchorY: 24 });
    expect(getIcon(parking).url).toBe("/pins/parking.svg");
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

  it("fills the selected symbol solid ink at full alpha and fades its siblings to 35%", () => {
    const features = points(3);
    const plain = props(buildDeckLayers(stateOf("species", features))[0]);
    const p = props(buildDeckLayers(select(stateOf("species", features), features[1]))[0]);
    expect((p.getColor as Accessor)(features[1])).toEqual(WHITE);
    expect((p.getColor as Accessor)(features[0])).toEqual([255, 255, 255, Math.round(255 * SIBLING_FADE)]);
    const getIcon = p.getIcon as (f: GeoJSON.Feature) => { url: string };
    expect(getIcon(features[1]).url).toBe("/pins/species-selected.svg");
    expect(getIcon(features[0]).url).toBe("/pins/species.svg");
    const triggers = (q: Props) => q.updateTriggers as Record<string, unknown>;
    expect(triggers(p).getIcon).not.toEqual(triggers(plain).getIcon);
    expect(triggers(p).getColor).not.toEqual(triggers(plain).getColor);
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
    expect(layers[0].id).toBe("species:points");
    expect(layers[1]).toBeInstanceOf(TextLayer);
    expect(layers[1].id).toBe("species:points:labels");
  });

  it("maps zoom to resolution: z≤6 → 3, 7–8 → 4, 9–10 → 5, 11–12 → 6, ≥13 → 7", () => {
    expect([0, 6, 6.9, 7, 8.5, 9, 10.9, 11, 12.9, 13, 18].map(hexResolution)).toEqual([3, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7]);
  });

  it("draws flat light-gray tiles with a light edge, no color", () => {
    const p = props(buildDeckLayers(stateOf("species", dense(2001), {}, { zoom: 10 }))[0]);
    expect(p.pickable).toBe(true);
    expect(p.extruded).toBe(false);
    const hexes = p.data as { properties: { count: number; h3: string } }[];
    expect(hexes.reduce((n, h) => n + h.properties.count, 0)).toBe(2001);
    expect((p.getHexagon as (f: unknown) => string)(hexes[0])).toBe(hexes[0].properties.h3);
    expect((p.getLineColor as Accessor)(hexes[0])).toEqual([255, 255, 255, 204]);
    for (const h of hexes) {
      const [r, g, bl] = (p.getFillColor as Accessor)(h);
      // Neutral gray between #9A9A96 and white.
      expect(r).toBe(g);
      expect(r).toBeGreaterThanOrEqual(154);
      expect(bl).toBeGreaterThanOrEqual(150);
    }
  });

  it("runs from white at 55% (fewest) to #9A9A96 at 80% (busiest), through the fill accessor", () => {
    expect(hexTileColor(1, 100)).toEqual([255, 255, 255, Math.round(255 * 0.55)]);
    expect(hexTileColor(100, 100)).toEqual([154, 154, 150, Math.round(255 * 0.8)]);
    const tiles: GeoJSON.Feature[] = [
      ...Array.from({ length: 1990 }, () => dense(1)[0]),
      ...dense(11).map((f, i) => ({ ...f, geometry: { type: "Point" as const, coordinates: [-121 + i * 0.5, 40] } })),
    ];
    const p = props(buildDeckLayers(stateOf("species", tiles, {}, { zoom: 10 }))[0]);
    const hexes = p.data as { properties: { count: number } }[];
    const fill = p.getFillColor as Accessor;
    const busiest = hexes.find((h) => h.properties.count === 1990)!;
    const single = hexes.find((h) => h.properties.count === 1)!;
    expect(fill(busiest)).toEqual([154, 154, 150, 204]);
    expect(fill(single)).toEqual([255, 255, 255, 140]);
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

  it("labels grouped tiles with an 11px ink count on a white halo, reusing the label list", () => {
    const [hex, labels] = buildDeckLayers(stateOf("species", dense(2001), {}, { zoom: 10 }));
    const all = props(hex).data as { properties: { count: number } }[];
    const p = props(labels);
    const labelled = p.data as { properties: { count: number } }[];
    expect(labelled.length).toBe(all.filter((h) => h.properties.count >= 2).length);
    expect((p.getColor as Accessor)(labelled[0])).toEqual(INK);
    expect(p.outlineColor).toEqual([255, 255, 255, 230]);
    expect(p.fontSettings).toMatchObject({ sdf: true });
    expect(p.getSize).toBe(11);
    expect(p.pickable).toBe(false);
    expect(props(buildDeckLayers(stateOf("species", dense(2001), {}, { zoom: 10 }))[1]).data).not.toBe(labelled);
    const state = stateOf("species", dense(2001), {}, { zoom: 10 });
    expect(props(buildDeckLayers(state)[1]).data).toBe(props(buildDeckLayers(state)[1]).data);
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

  it("outlines the selected tile in 2.5px ink and fades the others and their labels", () => {
    const base = stateOf("species", dense(2001), {}, { zoom: 10 });
    const tiles = props(buildDeckLayers(base)[0]).data as GeoJSON.Feature[];
    const [hex, labels] = buildDeckLayers(select(base, tiles[0]));
    const p = props(hex);
    expect((p.getLineColor as Accessor)(tiles[0])).toEqual(INK);
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
    expect(p.color).toEqual([0, 0, 0, 0]);
    expect(p.elevationData).toBe("https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1/{z}/{x}/{y}@2x.pngraw?access_token=pk.test");
    const decoder = p.elevationDecoder as Record<string, number>;
    expect(decoder.rScaler).toBeCloseTo(6553.6 * 1.2);
    expect(decoder.offset).toBeCloseTo(-12000);
  });

  it("drapes lines (casing and core, keeping the dash extension) and polygons", () => {
    const [, casing, core] = buildDeckLayers(on(trails()), { mapboxToken: TOKEN });
    for (const l of [casing, core]) {
      expect(terrainOf(l)).toBe(true);
      expect(props(l).terrainDrawMode).toBe("drape");
    }
    expect((props(core).extensions as unknown[])[0]).toBeInstanceOf(PathStyleExtension);
    const poly = on(stateOf("fire-perimeters", [a], {}, { geometry: "polygon" }));
    for (const l of buildDeckLayers(poly, { mapboxToken: TOKEN }).slice(1)) expect(props(l).terrainDrawMode).toBe("drape");
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
    const lines = on(trails());
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
    ["lines", trails()],
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
    const layers = buildDeckLayers(flat(trails()), { mapboxToken: TOKEN });
    expect(layers.map((l) => l.id)).toEqual(["osm-trails:lines:casing", "osm-trails:lines"]);
    expect(layers.some(terrainOf)).toBe(false);
    // The dash extension stays: it does not depend on terrain.
    expect((props(layers[1]).extensions as unknown[])[0]).toBeInstanceOf(PathStyleExtension);
  });

  it("still maps a draped layer's pick back to its app layer", () => {
    const [, , core] = buildDeckLayers(on(trails()), { mapboxToken: TOKEN });
    const selection = pickToSelection({ object: a, layer: { id: core.id }, coordinate: [-120, 39] }, { "osm-trails": {} });
    expect(selection?.layerId).toBe("osm-trails");
  });
});

describe("update triggers follow layer panel edits while the card is open", () => {
  it("change with opacity and color for lines and polygons", () => {
    const triggers = (state: MapState, accessor: string) =>
      (props(buildDeckLayers(select(state, a)).at(-1)!).updateTriggers as Record<string, unknown>)[accessor];
    for (const accessor of ["getFillColor", "getLineColor", "getLineWidth"]) {
      expect(triggers(trails({ opacity: 0.5 }), accessor)).not.toEqual(triggers(trails({ opacity: 1 }), accessor));
      expect(triggers(trails({ color: "#FF5A36" }), accessor)).not.toEqual(triggers(trails(), accessor));
    }
  });
});
