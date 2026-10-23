import type { Feature, FeatureCollection } from "geojson";
import type { LineLayerSpecification, Map as MapboxMap } from "mapbox-gl";
import { describe, expect, it } from "vitest";
import { drawnLineEntries, lineBeforeId, syncLineLayers } from "@/components/mapTiles";
import { buildDeckLayerSets } from "@/lib/render/deck";
import {
  dashInWidths,
  lineEntries,
  lineLayerSpecs,
  linePickToSelection,
  lineSourceData,
  parseLineLayerId,
  rampLineColor,
  type LineEntry,
} from "@/lib/render/nativeLines";
import { UNRATED_LINE } from "@/lib/render/nativeLines";
import { DARK_GREY, INK, PINK, PURPLE, SAGE, SIBLING_FADE, WHITE } from "@/lib/render/palette";
import { hexToRgb, rampColor, rgbToHex } from "@/lib/render/ramp";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type LoadedLayer, type MapState, type RenderOp } from "@/lib/render/state";
import { visibleState } from "@/lib/render/view";
import { gradientColors, gradientExpression } from "@/lib/render/wally/routeLine";

const citation = { source: "OSM", url: "https://osm.org", retrieved: "2026-10-14" };
const line = (x: number, properties: Record<string, unknown> = {}): Feature => ({
  type: "Feature",
  geometry: { type: "LineString", coordinates: [[x, 38], [x + 0.1, 38.1]] },
  properties,
});
const a = line(-120, { v: 0, name: "A" });
const b = line(-119, { v: 100, name: "B" });

function layerOf(id: string, features: Feature[], style: Partial<LoadedLayer["style"]> = {}, attributes?: LoadedLayer["attributes"]): LoadedLayer {
  return {
    id,
    title: id,
    ...(attributes && { attributes }),
    style: { geometry: "line", color: "#3A3A3C", ...style },
    result: { kind: "geojson", data: { type: "FeatureCollection", features }, citation },
    receivedAt: "2026-10-14T00:00:00Z",
  };
}

function stateOf(
  id: string,
  features: Feature[],
  op: Partial<RenderOp> = {},
  style: Partial<LoadedLayer["style"]> = {},
  attributes?: LoadedLayer["attributes"],
): MapState {
  return {
    ...initialMapState,
    layers: { [id]: layerOf(id, features, style, attributes) },
    renderOps: [{ layerId: id, mode: "lines", visible: true, ...op }],
  };
}
const select = (state: MapState, feature: Feature, side?: "b"): MapState => ({
  ...state,
  selected: { layerId: state.renderOps[0].layerId, feature, lngLat: [-120, 38], ...(side && { side }) },
});

const specs = (state: MapState) => lineEntries(visibleState(state)).flatMap(lineLayerSpecs);
const byPart = (all: LineLayerSpecification[], part: string) => all.find((s) => s.id.endsWith(`:${part}`))!;
const paint = (s: LineLayerSpecification) => s.paint as Record<string, unknown>;

/** Every color literal in an expression or value. */
function colorsIn(value: unknown): string[] {
  if (typeof value === "string") return value.startsWith("#") ? [value.toUpperCase()] : [];
  if (Array.isArray(value)) return value.flatMap(colorsIn);
  return [];
}

describe("native line layers: one source and four layers per drawn layer", () => {
  it("names the source and its casing, core, dash, route and selected layers after the layer, bottom first", () => {
    const all = specs(stateOf("osm-trails", [a, b]));
    expect(all.map((s) => s.id)).toEqual(["lines-osm-trails:casing", "lines-osm-trails:core", "lines-osm-trails:dash", "lines-osm-trails:route", "lines-osm-trails:selected"]);
    for (const s of all) {
      expect(s).toMatchObject({ type: "line", source: "lines-osm-trails" });
      expect(s.layout).toMatchObject({ "line-cap": s.id.endsWith(":dash") ? "butt" : "round", "line-join": "round", visibility: "visible" });
    }
    expect(parseLineLayerId("lines-osm-trails:core")).toEqual({ id: "osm-trails", part: "core" });
    expect(parseLineLayerId("lines-fire-perimeters~b:selected")).toEqual({ id: "fire-perimeters~b", part: "selected" });
    expect(parseLineLayerId("tiles-roads")).toBeNull();
    expect(parseLineLayerId("lines-x:glow")).toBeNull();
  });

  it("draws a white casing 2px wider than the core at 0.9, routes on a 5px casing", () => {
    const casing = byPart(specs(stateOf("osm-trails", [a])), "casing");
    expect(paint(casing)["line-color"]).toBe(WHITE);
    expect(paint(casing)["line-opacity"]).toBe(0.9);
    expect(paint(casing)["line-width"]).toEqual(["match", ["get", "cls"], "route", 5, 4.5]);
    expect(byPart(specs(stateOf("osm-trails", [a], { color: PURPLE })), "casing").paint).toMatchObject({ "line-width": 4.5 });
  });

  it("states every width in pixels, the same at every zoom (no zoom expression anywhere)", () => {
    for (const state of [stateOf("mtb-trails", [a, b]), select(stateOf("mtb-trails", [a, b]), a), stateOf("popularity", [a], {}, { unit: "score" })]) {
      const all = specs(state);
      const core = paint(byPart(all, "core"))["line-width"];
      // Pixels in every case: one number, or one per class (thin forest roads).
      expect(core === 2.5 || JSON.stringify(core) === JSON.stringify(["match", ["get", "cls"], "road", 1.75, 2.5])).toBe(true);
      expect(paint(byPart(all, "route"))["line-width"]).toBe(3);
      expect(paint(byPart(all, "selected"))["line-width"]).toBe(3.5);
      expect(JSON.stringify(all)).not.toContain('"zoom"');
    }
  });

  it("draws maintained trails T1: 8px dark grey dashes over the sage core, alternating evenly", () => {
    const all = specs(stateOf("osm-trails", [a]));
    const dash = byPart(all, "dash");
    expect(dash.filter).toEqual(["==", ["get", "cls"], "trail"]);
    expect(dash.paint).toMatchObject({ "line-color": DARK_GREY, "line-width": 2.5, "line-dasharray": [3.2, 3.2] });
    expect(paint(byPart(all, "core"))["line-color"]).toEqual(expect.arrayContaining(["trail", SAGE]));
    // Selected, the trail draws purple in the highlight layer: its dashes fade out with the core.
    expect(paint(byPart(specs(select(stateOf("osm-trails", [a, b]), a)), "dash"))["line-opacity"]).toEqual(["case", ["==", ["get", "i"], 0], 0, SIBLING_FADE]);
    // A compare color, a score ramp or a delta has no dashes.
    expect(byPart(specs(stateOf("osm-trails", [a], { color: PINK })), "dash").filter).toEqual(["==", ["get", "cls"], "none"]);
  });

  it("keeps every other line core sage: forest roads thin dark grey short dashes, use trails sage dots, nothing else dark", () => {
    const core = byPart(specs(stateOf("osm-trails", [a])), "core");
    expect(new Set(colorsIn(paint(core)["line-color"]))).toEqual(new Set([SAGE, DARK_GREY]));
    expect(core.filter).toEqual(["!=", ["get", "cls"], "route"]);
    // Roads: 4px dashes and gaps on a 1.75px core, in line widths net of the round caps.
    expect(paint(core)["line-dasharray"]).toEqual(["match", ["get", "cls"], "road", ["literal", [(4 - 1.75) / 1.75, (4 + 1.75) / 1.75]], "useTrail", ["literal", [0, 3.4]], ["literal", [1, 0]]]);
    expect(paint(core)["line-width"]).toEqual(["match", ["get", "cls"], "road", 1.75, 2.5]);
    const data = lineSourceData({ data: { type: "FeatureCollection", features: [a, line(0, { informal: true })] }, layerId: "osm-trails", look: { kind: "classes" } });
    expect(data.features.map((f) => f.properties?.cls)).toEqual(["trail", "useTrail"]);
    expect(lineSourceData({ data: { type: "FeatureCollection", features: [a] }, layerId: "forest-roads", look: { kind: "classes" } }).features[0].properties?.cls).toBe("road");
    // A dark grey (or ink) asked for in the layer panel draws sage; other palette colors stand.
    for (const color of [DARK_GREY, INK]) expect(paint(byPart(specs(stateOf("streams", [a], { color })), "core"))["line-color"]).toBe(SAGE);
    expect(paint(byPart(specs(stateOf("streams", [a], { color: PINK })), "core"))["line-color"]).toBe(PINK);
    for (const state of [stateOf("streams", [a]), stateOf("popularity", [a], {}, { unit: "score" })]) {
      // The dash layer draws only T1 trails (its filter matches nothing else).
      const colors = specs(state).filter((s) => !s.id.endsWith(":casing") && !s.id.endsWith(":dash")).flatMap((s) => colorsIn(s.paint));
      expect(colors).not.toContain(DARK_GREY);
      expect(colors).not.toContain(INK);
    }
  });

  it("turns pixel dashes into Mapbox's line-width units net of the round caps, dots for use trails, [0, 0] solid", () => {
    // 7.5px of dash plus 2.5px of caps reads as the recipe's 10px dash; the 7.5px gap stays 7.5px between caps.
    expect(dashInWidths([10, 7.5])).toEqual([3, 4]);
    expect(dashInWidths([2.5, 6])).toEqual([0, 3.4]);
    expect(dashInWidths([0, 0])).toEqual([1, 0]);
  });

  it("ramps score lines pink → purple by v (low scores read on Topo), in the legend's OKLCH colors, never dark grey", () => {
    const core = byPart(specs(stateOf("popularity", [a, b], {}, { unit: "score" })), "core");
    const ramp = paint(core)["line-color"] as unknown[];
    expect(ramp).toEqual(rampLineColor("popularity"));
    expect(ramp.slice(0, 3)).toEqual(["interpolate", ["linear"], ["to-number", ["get", "v"], 0]]);
    expect(ramp[3]).toBe(0);
    expect(ramp[4]).toBe(PINK);
    expect(ramp[11]).toBe(50);
    // The middle stop is the same color the legend samples.
    expect(ramp[12]).toBe(rgbToHex(rampColor("scoreLineVisible", 0.5)));
    void SAGE;
    void hexToRgb;
    expect(ramp.at(-2)).toBe(100);
    expect(ramp.at(-1)).toBe(PURPLE);
    // Every layer's score lines share the ramp (remoteness and density lines used to end in dark grey).
    expect(rampLineColor("remoteness")).toEqual(ramp);
    expect(core.filter).toBeUndefined();
  });

  it("runs named routes in Wally's purple → pink line-gradient, 3px, solid, in their own layer", () => {
    const route = line(-118, { kind: "route", name: "Haute Route" });
    const all = specs(stateOf("ski-routes", [route, a]));
    const r = byPart(all, "route");
    expect(r.filter).toEqual(["==", ["get", "cls"], "route"]);
    expect(paint(r)["line-gradient"]).toEqual(gradientExpression());
    const stops = paint(r)["line-gradient"] as unknown[];
    expect(stops[3]).toBe(0);
    expect(stops[4]).toBe(PURPLE);
    expect(stops.at(-2)).toBe(1);
    expect(stops.at(-1)).toBe(PINK);
    expect(colorsIn(stops)).toEqual(gradientColors());
    expect(paint(r)["line-dasharray"]).toBeUndefined();
  });

  it("chains a route relation's ways so the gradient runs along it, and keeps plain lines as they are", () => {
    const relation: Feature = {
      type: "Feature",
      geometry: { type: "MultiLineString", coordinates: [[[0, 1], [0, 2]], [[0, 0], [0, 1]]] },
      properties: { kind: "nordic", route: true },
    };
    const data = lineSourceData({ data: { type: "FeatureCollection", features: [relation, a] }, layerId: "ski-routes", look: { kind: "classes" } });
    expect(data.features[0].geometry).toEqual({ type: "LineString", coordinates: [[0, 0], [0, 1], [0, 2]] });
    expect(data.features[1].geometry).toBe(a.geometry);
  });

  it("lets a compare color, a score ramp or a delta replace the route look, so the route layer draws nothing", () => {
    const route = line(-118, { kind: "route", v: 50 });
    for (const state of [stateOf("ski-routes", [route], { color: PURPLE }), stateOf("popularity", [route], {}, { unit: "score" })]) {
      const all = specs(state);
      expect(byPart(all, "route").filter).toEqual(["==", ["get", "cls"], "none"]);
      expect(byPart(all, "core").filter).toBeUndefined();
    }
  });

  it("multiplies the op opacity into casing, core, route and highlight", () => {
    const all = specs(stateOf("osm-trails", [a], { opacity: 0.5 }));
    expect(paint(byPart(all, "casing"))["line-opacity"]).toBeCloseTo(0.45);
    expect(paint(byPart(all, "core"))["line-opacity"]).toBe(0.5);
    expect(paint(byPart(all, "route"))["line-opacity"]).toBe(0.5);
    expect(paint(byPart(all, "selected"))["line-opacity"]).toBe(0.5);
  });

  it("draws the selected line purple 3.5px in its own layer on a 5.5px casing, and fades its siblings", () => {
    const all = specs(select(stateOf("osm-trails", [a, b]), b));
    const sel = byPart(all, "selected");
    expect(sel.filter).toEqual(["==", ["get", "i"], 1]);
    expect(sel.paint).toMatchObject({ "line-color": PURPLE, "line-width": 3.5, "line-opacity": 1 });
    expect(paint(byPart(all, "core"))["line-opacity"]).toEqual(["case", ["==", ["get", "i"], 1], 0, SIBLING_FADE]);
    expect(paint(byPart(all, "casing"))["line-width"]).toEqual(["case", ["==", ["get", "i"], 1], 5.5, ["match", ["get", "cls"], "route", 5, 4.5]]);
    expect(paint(byPart(all, "casing"))["line-opacity"]).toEqual(["case", ["==", ["get", "i"], 1], 1, 0.9 * SIBLING_FADE]);
    // Nothing selected: the highlight matches no feature.
    expect(byPart(specs(stateOf("osm-trails", [a, b])), "selected").filter).toEqual(["==", ["get", "i"], -1]);
    // A selection on another layer leaves this one alone.
    const other = { ...stateOf("osm-trails", [a, b]), selected: { layerId: "campsites", feature: a, lngLat: [-120, 38] as [number, number] } };
    expect(paint(byPart(specs(other), "core"))["line-opacity"]).toBe(1);
  });

  it("draws a polygon layer shown as lines as its outlines, and drops points", () => {
    const ring: Feature = { type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: {} };
    const pt: Feature = { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: {} };
    const data = lineSourceData({ data: { type: "FeatureCollection", features: [pt, ring, a] }, layerId: "wilderness", look: { kind: "classes" } });
    expect(data.features.map((f) => f.properties?.i)).toEqual([1, 2]);
  });

  it("draws lines for a lines op and a line layer's columns, not for its symbols or hex tiles", () => {
    expect(lineEntries(stateOf("osm-trails", [a], { mode: "columns" }))).toHaveLength(1);
    for (const mode of ["points", "clusters", "hexbin", "heat"] as const) expect(lineEntries(stateOf("osm-trails", [a], { mode }))).toHaveLength(0);
    expect(lineEntries(stateOf("osm-trails", [a], { visible: false }))).toHaveLength(0);
  });
});

describe("filters, time window and compare reach the line source", () => {
  it("uploads only the features the filters keep, memoized per data object", () => {
    const state = stateOf("osm-trails", [a, b], { filters: { name: { include: ["B"] } } });
    const [entry] = lineEntries(visibleState(state));
    expect(entry.data.features).toEqual([b]);
    const data = lineSourceData(entry);
    expect(data.features.map((f) => f.properties)).toEqual([{ i: 0, cls: "trail", v: 100 }]);
    expect(lineSourceData(entry)).toBe(data);
    // A pan or a selection keeps the same collection, so nothing is re-uploaded.
    const [moved] = lineEntries(visibleState(select({ ...state, viewport: { ...state.viewport, zoom: 9 } }, b)));
    expect(lineSourceData(moved)).toBe(data);
  });

  const dated = (year: number, x: number): Feature => line(x, { t: `${year}-07-01T00:00:00.000Z`, name: String(year) });
  const trails = (mode: "swipe" | "toggle" | "delta", side?: "a" | "b") => {
    let s = reduce({ ...initialMapState, terrain: false }, { type: "layer_loaded", layer: layerOf("mtb-trails", [dated(2018, -120), dated(2022, -119)]) });
    s = reduce(s, { type: "render", op: { layerId: "mtb-trails", mode: "lines", visible: true } });
    s = reduce(s, { type: "set_compare", compare: { layerId: "mtb-trails", a: ["2016-01-01", "2020-12-31"], b: ["2021-01-01", "2026-10-09"], mode } });
    if (side === "b") s = { ...s, compare: { ...s.compare!, side: "b" } };
    return s;
  };

  it("draws a toggle compare's two sides natively in purple and pink, the side not showing hidden", () => {
    const entries = lineEntries(visibleState(trails("toggle")));
    expect(entries.map((e) => [e.id, e.look, e.shown])).toEqual([
      ["mtb-trails", { kind: "solid", color: PURPLE }, true],
      ["mtb-trails~b", { kind: "solid", color: PINK }, false],
    ]);
    expect(entries[1].side).toBe("b");
    expect(lineLayerSpecs(entries[1])[0].layout).toMatchObject({ visibility: "none" });
    expect(lineEntries(visibleState(trails("toggle", "b"))).map((e) => e.shown)).toEqual([false, true]);
    // Not in deck.
    expect(buildDeckLayerSets(visibleState(trails("toggle")), { mapboxToken: "" }).main).toHaveLength(0);
  });

  it("leaves a swiped compare's lines to deck's clipped side overlays", () => {
    const view = visibleState(trails("swipe"));
    expect(lineEntries(view)).toHaveLength(0);
    const sets = buildDeckLayerSets(view, { mapboxToken: "" });
    expect(sets.a.map((l) => l.id)).toEqual(["mtb-trails:lines:casing", "mtb-trails:lines"]);
    expect(sets.b.map((l) => l.id)).toEqual(["mtb-trails~b:lines:casing", "mtb-trails~b:lines"]);
    expect((sets.b[1].props as unknown as { getLineColor: number[] }).getLineColor.slice(0, 3)).toEqual([245, 114, 114]);
  });

  it("strokes a delta's lines natively by class (A only pink, B only purple, unchanged sage), and keeps them out of deck", () => {
    const view = visibleState(trails("delta"));
    const [entry] = lineEntries(view);
    expect(entry.look).toEqual({ kind: "delta" });
    const data = lineSourceData(entry);
    expect(data.features.map((f) => f.properties?.delta)).toEqual(["a-only", "b-only"]);
    const core = byPart(lineLayerSpecs(entry), "core");
    // The change view: lost (A only) pink, gained (B only) purple, unchanged sage (spec §12).
    expect(paint(core)["line-color"]).toEqual(["match", ["get", "delta"], "a-only", PINK, "b-only", PURPLE, SAGE]);
    expect(buildDeckLayerSets(view, { mapboxToken: "" }).main).toHaveLength(0);
  });
});

describe("picking a native line", () => {
  const entry: LineEntry = {
    id: "mtb-trails~b",
    layerId: "mtb-trails",
    side: "b",
    data: { type: "FeatureCollection", features: [a, b] },
    look: { kind: "solid", color: PINK },
    opacity: 1,
    shown: true,
    selected: -1,
  };
  const entries = new Map([[entry.id, entry]]);
  const known = { "mtb-trails": {} };

  it("maps a hit on the core, route or highlight back to the layer, the compare side and the original feature", () => {
    for (const part of ["core", "dash", "route", "selected"]) {
      const sel = linePickToSelection({ layer: { id: `lines-mtb-trails~b:${part}` }, properties: { i: 1, cls: "solid" } }, entries, known, [-119, 38], { x: 5, y: 6 });
      expect(sel).toEqual({ layerId: "mtb-trails", feature: b, lngLat: [-119, 38], screen: { x: 5, y: 6 }, side: "b" });
      // The very object in the data, so the highlight and the card match by reference.
      expect(sel?.feature).toBe(b);
    }
  });

  it("ignores the casing, other layers, unloaded layers, hidden sides and stale indexes", () => {
    const at = (id: string, i: unknown = 0, list = entries, k: Record<string, unknown> = known) =>
      linePickToSelection({ layer: { id }, properties: { i } }, list, k, [0, 0]);
    expect(at("lines-mtb-trails~b:casing")).toBeNull();
    expect(at("tiles-roads")).toBeNull();
    expect(at("lines-other:core")).toBeNull();
    expect(at("lines-mtb-trails~b:core", 0, entries, {})).toBeNull();
    expect(at("lines-mtb-trails~b:core", 0, new Map([[entry.id, { ...entry, shown: false }]]))).toBeNull();
    expect(at("lines-mtb-trails~b:core", 7)).toBeNull();
    expect(at("lines-mtb-trails~b:core", "x")).toBeNull();
    expect(linePickToSelection(null, entries, known, [0, 0])).toBeNull();
  });
});

type FakeLayer = { id: string; type: string; source?: string; filter?: unknown; layout?: Record<string, unknown>; paint?: Record<string, unknown> };

/** A stand-in for the Mapbox map that records every mutating call. */
function fakeMap(initial: FakeLayer[] = [{ id: "land", type: "background" }, { id: "road", type: "line" }, { id: "road-label", type: "symbol" }]) {
  const layers = initial.map((l) => ({ ...l }));
  const sources: Record<string, { type: string; data?: unknown; lineMetrics?: boolean }> = {};
  const calls: string[] = [];
  const map = {
    getStyle: () => ({ layers: layers.map((l) => ({ ...l })), sources: { ...sources } }),
    getLayer: (id: string) => layers.find((l) => l.id === id),
    getSource: (id: string) =>
      sources[id] && {
        setData: (data: unknown) => {
          calls.push(`setData ${id}`);
          sources[id] = { ...sources[id], data };
        },
      },
    addSource: (id: string, spec: { type: string; data?: unknown; lineMetrics?: boolean }) => {
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
      if (index === -1) layers.push({ ...spec });
      else layers.splice(index, 0, { ...spec });
    },
    removeLayer: (id: string) => {
      calls.push(`removeLayer ${id}`);
      layers.splice(layers.findIndex((l) => l.id === id), 1);
    },
    setPaintProperty: (id: string, property: string, value: unknown) => {
      calls.push(`setPaint ${id} ${property}`);
      const layer = layers.find((l) => l.id === id)!;
      layer.paint = { ...layer.paint, [property]: value };
    },
    setFilter: (id: string, filter: unknown) => {
      calls.push(`setFilter ${id}`);
      layers.find((l) => l.id === id)!.filter = filter;
    },
    setLayoutProperty: (id: string, property: string, value: unknown) => {
      calls.push(`setLayout ${id} ${property}=${String(value)}`);
      const layer = layers.find((l) => l.id === id)!;
      layer.layout = { ...layer.layout, [property]: value };
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

describe("syncLineLayers", () => {
  it("adds a lineMetrics GeoJSON source and the four layers under the labels, above the roads", () => {
    const { map, layers, sources } = fakeMap();
    syncLineLayers(map, visibleState(stateOf("osm-trails", [a, b])));
    expect(sources["lines-osm-trails"]).toMatchObject({ type: "geojson", lineMetrics: true });
    expect(layers.map((l) => l.id)).toEqual(["land", "road", "lines-osm-trails:casing", "lines-osm-trails:core", "lines-osm-trails:dash", "lines-osm-trails:route", "lines-osm-trails:selected", "road-label"]);
    expect(drawnLineEntries(map).get("osm-trails")?.layerId).toBe("osm-trails");
  });

  it("sends filtered data with setData only when the collection changes", () => {
    const { map, calls, sources } = fakeMap();
    const base = stateOf("osm-trails", [a, b]);
    syncLineLayers(map, visibleState(base));
    calls.length = 0;
    // A pan and a selection: no upload; the selection only sets the paint and filters that changed.
    syncLineLayers(map, visibleState({ ...base, viewport: { ...base.viewport, zoom: 8 } }));
    expect(calls).toEqual([]);
    syncLineLayers(map, visibleState(select(base, a)));
    expect(calls.some((c) => c.startsWith("setData"))).toBe(false);
    expect(calls).toContain("setFilter lines-osm-trails:selected");
    expect(calls).toContain("setPaint lines-osm-trails:core line-opacity");
    calls.length = 0;
    // A filter narrows the data: one upload of the kept features.
    syncLineLayers(map, visibleState({ ...base, renderOps: [{ ...base.renderOps[0], filters: { name: { include: ["A"] } } }] }));
    expect(calls.filter((c) => c.startsWith("setData"))).toEqual(["setData lines-osm-trails"]);
    expect((sources["lines-osm-trails"].data as FeatureCollection).features.map((f) => f.properties?.i)).toEqual([0]);
  });

  it("removes a layer's lines when its op goes, and keeps render-op order", () => {
    const { map, layers, sources } = fakeMap();
    const two: MapState = {
      ...initialMapState,
      layers: { "osm-trails": layerOf("osm-trails", [a]), "forest-roads": layerOf("forest-roads", [b]) },
      renderOps: [
        { layerId: "osm-trails", mode: "lines", visible: true },
        { layerId: "forest-roads", mode: "lines", visible: true },
      ],
    };
    syncLineLayers(map, two);
    const ours = () => layers.map((l) => l.id).filter((id) => id.startsWith("lines-") && id.endsWith(":core"));
    expect(ours()).toEqual(["lines-osm-trails:core", "lines-forest-roads:core"]);
    syncLineLayers(map, { ...two, renderOps: [...two.renderOps].reverse() });
    expect(ours()).toEqual(["lines-forest-roads:core", "lines-osm-trails:core"]);
    syncLineLayers(map, { ...two, renderOps: [two.renderOps[1]] });
    expect(ours()).toEqual(["lines-forest-roads:core"]);
    expect(Object.keys(sources)).toEqual(["lines-forest-roads"]);
  });

  it("goes under the route tool's lines when a route is on the map", () => {
    expect(lineBeforeId([{ id: "road", type: "line" }, { id: "route-r1-casing", type: "line" }, { id: "road-label", type: "symbol" }])).toBe("route-r1-casing");
    expect(lineBeforeId([{ id: "road", type: "line" }, { id: "road-label", type: "symbol" }])).toBe("road-label");
  });

  it("does nothing before the style has loaded", () => {
    const map = { getStyle: () => { throw new Error("Style is not done loading"); } } as unknown as MapboxMap;
    expect(() => syncLineLayers(map, stateOf("osm-trails", [a]))).not.toThrow();
  });
});

describe("the encoded ordinal drives the line color (spec §12c: difficulty on the sage → pink → purple ramp)", () => {
  const difficulty: LoadedLayer["attributes"] = [
      {
        key: "v",
        label: "Difficulty",
        type: "ordinal",
        scale: "mtb:scale",
        encode: "color",
        levels: [
          { value: 0, label: "Easy" },
          { value: 2, label: "Moderate" },
          { value: 3, label: "Hard" },
          { value: 5, label: "Expert" },
        ],
      },
  ];
  const trails = [line(-120, { v: 0 }), line(-119, { v: 3 }), line(-118, { v: 5 })];

  it("matches each class to its ramp color on the ordinal value, and an unrated value draws a thin grey dash", () => {
    const [entry] = lineEntries(visibleState(stateOf("mtb-trails", trails, {}, {}, difficulty)));
    expect(entry.look.kind).toBe("facet");
    expect(lineSourceData(entry).features.map((f) => f.properties?.fv)).toEqual(["0", "3", "5"]);
    const color = paint(byPart(lineLayerSpecs(entry), "core"))["line-color"] as unknown[];
    expect(color.slice(0, 2)).toEqual(["match", ["get", "fv"]]);
    expect(color[3]).toBe(SAGE);
    expect(color.at(-2)).toBe(PURPLE);
    // Not rated never reads as the easiest level: dark grey, thin, dashed (lines fixer, 2026-10-18).
    expect(color.at(-1)).toBe(DARK_GREY);
    const core = paint(byPart(lineLayerSpecs(entry), "core"));
    expect(JSON.stringify(core["line-width"])).toContain(String(UNRATED_LINE.width));
    expect(JSON.stringify(core["line-dasharray"])).toContain('"case"');
  });

  it("dashes lines by a dash attribute's values (pipelines by kind)", () => {
    const kinds: LoadedLayer["attributes"] = [
      { key: "kind", type: "category", label: "Kind", encode: "dash", levels: [{ value: "gas", label: "Gas" }, { value: "oil", label: "Oil" }, { value: "water", label: "Water" }] },
    ];
    const pipes = [line(-120, { kind: "gas" }), line(-119, { kind: "oil" }), line(-118, { kind: "water" })];
    const [entry] = lineEntries(visibleState(stateOf("pipelines-lines", pipes, {}, {}, kinds)));
    expect(lineSourceData(entry).features.map((f) => f.properties?.dk)).toEqual([0, 1, 2]);
    const dash = paint(byPart(lineLayerSpecs(entry), "core"))["line-dasharray"] as unknown[];
    expect(dash.slice(0, 2)).toEqual(["match", ["get", "dk"]]);
  });

  it("keeps the T1 dashes on the trails a facet draws sage (easy and no grade), so they show on green Topo", () => {
    const sac: LoadedLayer["attributes"] = [
      {
        key: "sac_scale",
        type: "ordinal",
        label: "Difficulty",
        encode: "color",
        levels: [
          { value: "hiking", label: "Hiking (T1)" },
          { value: "mountain_hiking", label: "Mountain hiking (T2)" },
          { value: "alpine_hiking", label: "Alpine hiking (T4)" },
        ],
      },
    ];
    const paths = [line(-120, { sac_scale: "hiking" }), line(-119, {}), line(-118, { sac_scale: "alpine_hiking" })];
    const [entry] = lineEntries(visibleState(stateOf("osm-trails", paths, {}, {}, sac)));
    expect(entry.look.kind).toBe("facet");
    expect(lineSourceData(entry).features.map((f) => f.properties?.cls)).toEqual(["trail", "trail", "trail"]);
    const filter = byPart(lineLayerSpecs(entry), "dash").filter as unknown[];
    expect(filter[0]).toBe("all");
    // Dashes on every rated trail except the levels the ramp colors (T2 and up); a trail with no grade is the unrated dash.
    expect(JSON.stringify(filter)).toContain('["literal",["mountain_hiking","alpine_hiking"]]');
    expect(JSON.stringify(filter)).toContain('["literal",["hiking","mountain_hiking","alpine_hiking"]]');
    expect(paint(byPart(lineLayerSpecs(entry), "dash"))["line-color"]).toBe(DARK_GREY);
  });

  it("dashes a facet's sage level on any line class, so passenger-car roads show on green Topo", () => {
    const level = [{ key: "level", type: "ordinal" as const, label: "Maintenance level", encode: "color" as const, levels: [{ value: "car", label: "Passenger car" }, { value: "high", label: "High clearance" }] }];
    const roads = [line(-106.3, { level: "car" }), line(-106.2, { level: "high" })];
    const [entry] = lineEntries(visibleState(stateOf("forest-roads", roads, {}, {}, level)));
    expect(entry.look.kind).toBe("facet");
    const filter = JSON.stringify(byPart(lineLayerSpecs(entry), "dash").filter);
    expect(filter).not.toContain('["==",["get","cls"]');
    expect(filter).toContain('["!=",["get","cls"],"route"]');
  });

  it("fades a filtered layer's other lines only to 75% while one is selected, so the answer stays on Topo", () => {
    const sac = [{ key: "sac_scale", type: "ordinal" as const, label: "Difficulty", encode: "color" as const, levels: [{ value: "hiking", label: "Hiking (T1)" }, { value: "mountain_hiking", label: "Mountain hiking (T2)" }] }];
    const paths = [line(-120, { sac_scale: "hiking" }), line(-119, { sac_scale: "mountain_hiking" })];
    const [entry] = lineEntries(visibleState(stateOf("osm-trails", paths, {}, {}, sac)));
    expect(entry.look.kind).toBe("facet");
    expect(JSON.stringify(paint(byPart(lineLayerSpecs({ ...entry, selected: 0 }), "core"))["line-opacity"])).toContain(String(SIBLING_FADE));
    expect(JSON.stringify(paint(byPart(lineLayerSpecs({ ...entry, selected: 0, filtered: true }), "core"))["line-opacity"])).toContain("0.75");
    const [narrowed] = lineEntries(visibleState(stateOf("osm-trails", paths, { filters: { sac_scale: { include: ["hiking"] } } }, {}, sac)));
    expect(narrowed.filtered).toBe(true);
  });

  it("draws named routes on the route gradient under a facet too (wide-scale hiking routes drew plain sage)", () => {
    const sac: LoadedLayer["attributes"] = [{ key: "sac_scale", type: "ordinal", label: "Difficulty", encode: "color", levels: [{ value: "mountain_hiking", label: "T2" }] }];
    const [entry] = lineEntries(visibleState(stateOf("osm-trails", [line(-120, { kind: "route", name: "Tahoe Rim Trail" }), line(-119, {})], {}, {}, sac)));
    expect(entry.look.kind).toBe("facet");
    expect(lineSourceData(entry).features.map((f) => f.properties?.cls)).toEqual(["route", "trail"]);
    const all = lineLayerSpecs(entry);
    expect(byPart(all, "route").filter).toEqual(["==", ["get", "cls"], "route"]);
    expect(byPart(all, "core").filter).toEqual(["!=", ["get", "cls"], "route"]);
  });

  it("follows the chip filter (only hard trails) and a color asked for still wins", () => {
    const hard = lineEntries(visibleState(stateOf("mtb-trails", trails, { filters: { v: { include: ["3"] } } }, {}, difficulty)));
    expect(hard[0].data.features).toHaveLength(1);
    const asked = lineEntries(visibleState(stateOf("mtb-trails", trails, { color: PINK }, {}, difficulty)));
    expect(asked[0].look).toEqual({ kind: "solid", color: PINK });
  });
});

describe("an encoded network on satellite imagery (river pulse)", () => {
  const encodedEntry = (imagery: boolean, selected = -1): LineEntry => ({
    id: "river-pulse",
    layerId: "river-pulse",
    data: { type: "FeatureCollection", features: [a, b] },
    look: { kind: "encoded", size: { key: "q", extent: [0, 100] }, color: { key: "pct", extent: [0, 200] } },
    opacity: 1,
    shown: true,
    selected,
    ...(imagery && { imagery }),
  });
  /** The width at the thin end (share 0) of an encoded width expression. */
  const thinEnd = (w: unknown) => (w as unknown[])[4];

  it("draws the thinnest reach wider and with the trails' casing on imagery, and as before on Topo", () => {
    const topo = lineLayerSpecs(encodedEntry(false));
    const sat = lineLayerSpecs(encodedEntry(true));
    expect(thinEnd(paint(byPart(topo, "core"))["line-width"])).toBe(1.25);
    expect(thinEnd(paint(byPart(topo, "casing"))["line-width"])).toBe(2.25);
    expect(thinEnd(paint(byPart(sat, "core"))["line-width"])).toBe(1.75);
    expect(thinEnd(paint(byPart(sat, "casing"))["line-width"])).toBe(3.75);
    expect(paint(byPart(sat, "casing"))["line-color"]).toBe(WHITE);
  });

  it("keeps the network readable while one reach is selected", () => {
    const opacity = paint(byPart(lineLayerSpecs(encodedEntry(true, 0)), "core"))["line-opacity"] as unknown[];
    expect(opacity[3]).toBe(0.75);
    expect(opacity[3]).toBeGreaterThan(SIBLING_FADE);
  });

  it("knows imagery from the basemap", () => {
    const loaded = layerOf("river-pulse", [a, b], { encode: { size: "v" } } as never);
    const state = { ...initialMapState, basemap: "outdoors-satellite", layers: { "river-pulse": loaded }, renderOps: [{ layerId: "river-pulse", mode: "lines", visible: true } as RenderOp] } as MapState;
    expect(lineEntries(state)[0]?.imagery).toBe(true);
    expect(lineEntries({ ...state, basemap: "outdoors" })[0]?.imagery).toBeUndefined();
  });
});
