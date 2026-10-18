import type { Feature, Polygon } from "geojson";
import { GeoJsonLayer } from "@deck.gl/layers";
import { drawnCount } from "@/components/LayerStack";
import { describe, expect, it } from "vitest";
import { COMPARE_COLORS, DELTA_FILL_ALPHA } from "@/lib/render/compareView";
import { DARK_GREY, DELTA_COLORS, HEX_COLUMN, PINK, PURPLE } from "@/lib/render/palette";
import { buildDeckLayers, buildDeckLayerSets, deltaColor, DELTA_STROKE, hexToRgba } from "@/lib/render/deck";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type LoadedLayer, type MapAction, type MapState } from "@/lib/render/state";
import { visibleState } from "@/lib/render/view";

type Props = Record<string, unknown>;
const props = (l: { props: unknown }) => l.props as Props;
type Accessor = (f: unknown) => number[];

const square = (x: number): Polygon => ({
  type: "Polygon",
  coordinates: [[[x, 37], [x + 0.1, 37], [x + 0.1, 37.1], [x, 37.1], [x, 37]]],
});
const fire = (name: string, year: number, x: number): Feature => ({
  type: "Feature",
  geometry: square(x),
  properties: { name, year, t: `${year}-07-01T00:00:00.000Z` },
});
const fires: LoadedLayer = {
  id: "fire-perimeters",
  title: "Fire perimeters",
  style: { geometry: "polygon", color: "#000000" },
  result: {
    kind: "geojson",
    data: { type: "FeatureCollection", features: [fire("Ferguson", 2018, -119.8), fire("Washburn", 2022, -119.6)] },
    citation: { source: "s", url: "u", retrieved: "r" },
  },
  receivedAt: "now",
};
const spec = { layerId: "fire-perimeters", a: ["2016-01-01", "2020-12-31"] as [string, string], b: ["2021-01-01", "2026-10-09"] as [string, string] };

function run(state: MapState, ...actions: MapAction[]): MapState {
  return actions.reduce(reduce, state);
}
const base = run(
  { ...initialMapState, terrain: false },
  { type: "layer_loaded", layer: fires },
  { type: "render", op: { layerId: "fire-perimeters", mode: "polygons", visible: true } },
);
const view = (mode: "swipe" | "toggle" | "delta", ...more: MapAction[]) =>
  visibleState(run(base, { type: "set_compare", compare: { ...spec, mode } }, ...more));
const opts = { mapboxToken: "" };

describe("delta rendering", () => {
  const layers = buildDeckLayers(view("delta"), opts);
  // Delta layers carry their own tag, so the layer's own look and its delta never share a deck layer.
  const main = layers.find((l) => l.id === "fire-perimeters@delta:polygons")!;
  const features = (props(main).data as GeoJSON.FeatureCollection).features;

  it("draws a white casing under a pickable class-colored layer", () => {
    expect(layers.map((l) => l.id)).toEqual(["fire-perimeters@delta:polygons:casing", "fire-perimeters@delta:polygons"]);
    expect(main).toBeInstanceOf(GeoJsonLayer);
    expect(props(main).pickable).toBe(true);
    expect(features.map((f) => f.properties?.delta)).toEqual(["a-only", "b-only"]);
  });

  it("strokes A only (lost) pink and B only (gained) purple, and fills areas at 12% (spec §12 change view)", () => {
    const line = props(main).getLineColor as Accessor;
    const fill = props(main).getFillColor as Accessor;
    expect(line(features[0])).toEqual(hexToRgba(DELTA_COLORS["a-only"]));
    expect(line(features[1])).toEqual(hexToRgba(DELTA_COLORS["b-only"]));
    expect(DELTA_COLORS).toEqual({ "a-only": PINK, "b-only": PURPLE, both: DARK_GREY });
    expect(fill(features[0])).toEqual(hexToRgba(DELTA_COLORS["a-only"], Math.round(255 * DELTA_FILL_ALPHA)));
    expect((props(main).getLineWidth as (f: unknown) => number)(features[0])).toBe(DELTA_STROKE.polygon);
  });

  it("colors unchanged features dark grey", () => {
    expect(deltaColor({ type: "Feature", geometry: null as never, properties: { delta: "both" } })).toEqual(hexToRgba(COMPARE_COLORS.both));
  });

  it("extrudes H3 cells by |B − A|", () => {
    const cell = (year: number, v: number): Feature => ({
      type: "Feature",
      geometry: square(-120),
      properties: { h3: "8a2a1072b59ffff", v, t: `${year}-01-01T00:00:00.000Z` },
    });
    const grid: LoadedLayer = { ...fires, id: "remoteness", result: { ...fires.result, data: { type: "FeatureCollection", features: [cell(2018, 10), cell(2022, 30)] } } as LoadedLayer["result"] };
    const s = run(
      { ...initialMapState, terrain: false },
      { type: "layer_loaded", layer: grid },
      { type: "render", op: { layerId: "remoteness", mode: "polygons", visible: true } },
      { type: "set_compare", compare: { ...spec, layerId: "remoteness", mode: "delta" } },
    );
    const [hex] = buildDeckLayers(visibleState(s), opts);
    expect(props(hex).extruded).toBe(true);
    const [f] = (props(hex).data as GeoJSON.FeatureCollection).features;
    expect((props(hex).getElevation as (f: unknown) => number)(f)).toBe(4000);
    // Columns variant C: translucent white walls with white caps; only the tallest takes purple, with its value.
    expect((props(hex).getFillColor as Accessor)(f)).toEqual(hexToRgba(HEX_COLUMN.top, Math.round(255 * HEX_COLUMN.topWallAlpha)));
    expect((props(hex).getLineColor as Accessor)(f)).toEqual(hexToRgba(HEX_COLUMN.edge, Math.round(255 * HEX_COLUMN.edgeAlpha)));
    const layers = buildDeckLayers(visibleState(s), opts);
    expect(layers.map((l) => l.id)).toEqual(["remoteness@hexdelta:polygons", "remoteness@hexdelta:polygons:caps", "remoteness@hexdelta:polygons:label"]);
    const caps = props(layers[1]).data as GeoJSON.FeatureCollection;
    const ring = (caps.features[0].geometry as GeoJSON.Polygon).coordinates[0];
    expect(ring[0][2]).toBeGreaterThan(4000);
    expect((props(layers[1]).getLineColor as Accessor)(caps.features[0])).toEqual(hexToRgba(HEX_COLUMN.top));
    expect((props(layers[2]).data as { text: string }[])[0].text).toBe("20");
  });

  it("draws shorter delta columns as translucent white volumes with white caps outlined dark grey", () => {
    const cell = (h3: string, x: number, year: number, v: number): Feature => ({
      type: "Feature",
      geometry: square(x),
      properties: { h3, v, t: `${year}-01-01T00:00:00.000Z` },
    });
    const twoCells: LoadedLayer = {
      ...fires,
      id: "remoteness",
      result: {
        ...fires.result,
        data: {
          type: "FeatureCollection",
          features: [
            cell("8a2a1072b59ffff", -120, 2018, 10),
            cell("8a2a1072b59ffff", -120, 2022, 30),
            cell("8a2a1072b5b7fff", -118, 2018, 10),
            cell("8a2a1072b5b7fff", -118, 2022, 15),
          ],
        },
      } as LoadedLayer["result"],
    };
    const s = run(
      { ...initialMapState, terrain: false },
      { type: "layer_loaded", layer: twoCells },
      { type: "render", op: { layerId: "remoteness", mode: "polygons", visible: true } },
      { type: "set_compare", compare: { ...spec, layerId: "remoteness", mode: "delta" } },
    );
    const [walls, caps] = buildDeckLayers(visibleState(s), opts);
    expect(props(walls).extruded).toBe(true);
    const features = (props(walls).data as GeoJSON.FeatureCollection).features;
    const short = features.find((f) => Math.abs(Number(f.properties?.v)) < 20)!;
    expect((props(walls).getFillColor as Accessor)(short)).toEqual(hexToRgba(HEX_COLUMN.wall, Math.round(255 * HEX_COLUMN.wallAlpha)));
    const shortCap = (props(caps).data as GeoJSON.FeatureCollection).features.find((f) => f.properties?.top === false)!;
    expect((props(caps).getFillColor as Accessor)(shortCap)).toEqual(hexToRgba(HEX_COLUMN.cap, Math.round(255 * HEX_COLUMN.capAlpha)));
    expect((props(caps).getLineColor as Accessor)(shortCap)).toEqual(hexToRgba(HEX_COLUMN.capOutline));
  });
});

describe("swipe and toggle", () => {
  it("swipe sends side A and side B to their own sets", () => {
    const sets = buildDeckLayerSets(view("swipe"), opts);
    expect(sets.main).toEqual([]);
    expect(sets.a.map((l) => l.id)).toEqual(["fire-perimeters:polygons:casing", "fire-perimeters:polygons"]);
    expect(sets.b.map((l) => l.id)).toEqual(["fire-perimeters~b:polygons:casing", "fire-perimeters~b:polygons"]);
    const names = (fc: unknown) => (fc as GeoJSON.FeatureCollection).features.map((f) => f.properties?.name);
    expect(names(props(sets.a[1]).data)).toEqual(["Ferguson"]);
    expect(names(props(sets.b[1]).data)).toEqual(["Washburn"]);
  });

  it("draws side A in purple and side B in pink", () => {
    const sets = buildDeckLayerSets(view("swipe"), opts);
    expect(props(sets.a[1]).getLineColor).toEqual(hexToRgba(COMPARE_COLORS.a));
    expect(props(sets.b[1]).getLineColor).toEqual(hexToRgba(COMPARE_COLORS.b));
  });

  it("swipe gives each side its own terrain copy when 3D is on", () => {
    const s = run(base, { type: "set_compare", compare: { ...spec, mode: "swipe" } });
    const sets = buildDeckLayerSets(visibleState({ ...s, terrain: true }), { mapboxToken: "pk.test" });
    expect(sets.a[0].id).toBe(sets.main[0].id);
    expect(sets.b[0].id).toBe(sets.main[0].id);
    // The flat list keeps one terrain copy.
    expect(buildDeckLayers(visibleState({ ...s, terrain: true }), { mapboxToken: "pk.test" }).filter((l) => l.id === sets.main[0].id)).toHaveLength(1);
  });

  it("toggle keeps both sides built and hides the one not showing", () => {
    const visible = (layers: ReturnType<typeof buildDeckLayers>) => Object.fromEntries(layers.map((l) => [l.id, props(l).visible !== false]));
    expect(visible(buildDeckLayers(view("toggle"), opts))).toEqual({
      "fire-perimeters:polygons:casing": true,
      "fire-perimeters:polygons": true,
      "fire-perimeters~b:polygons:casing": false,
      "fire-perimeters~b:polygons": false,
    });
    expect(visible(buildDeckLayers(view("toggle", { type: "compare_flip" }), opts))["fire-perimeters~b:polygons"]).toBe(true);
    expect(visible(buildDeckLayers(view("toggle", { type: "compare_flip" }), opts))["fire-perimeters:polygons"]).toBe(false);
  });

  it("draws nothing extra without a compare", () => {
    const sets = buildDeckLayerSets(visibleState(base), opts);
    expect(sets.a).toEqual([]);
    expect(sets.b).toEqual([]);
    expect(sets.main.map((l) => l.id)).toEqual(["fire-perimeters:polygons:casing", "fire-perimeters:polygons"]);
  });
});

describe("the layer row's count during a compare", () => {
  it("counts the features on either side of a swipe or toggle, not side A as if filtered", () => {
    for (const mode of ["swipe", "toggle"] as const) {
      const v = view(mode);
      expect(drawnCount(v.layers["fire-perimeters"], v.layers["fire-perimeters~b"])).toBe(2);
    }
    const plain = visibleState(base);
    expect(drawnCount(plain.layers["fire-perimeters"], undefined)).toBe(2);
  });
});
