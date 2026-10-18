import { IconLayer } from "@deck.gl/layers";
import type { Feature } from "geojson";
import { describe, expect, it } from "vitest";
import type { Attribute } from "@/layers/types";
import { buildDeckLayers } from "@/lib/render/deck";
import { categoryKey, CATEGORY_COLORS, OTHER_COLOR } from "@/lib/render/categories";
import { DARK_GREY, PINK, PURPLE } from "@/lib/render/palette";
import { initialMapState, type LoadedLayer, type MapState, type RenderMode } from "@/lib/render/state";

const KINDS: Attribute = {
  key: "kind",
  type: "category",
  label: "Kind",
  primary: true,
  levels: [
    { value: "alpine_hut", label: "Huts" },
    { value: "spring", label: "Springs" },
    { value: "viewpoint", label: "Viewpoints" },
  ],
};
const HEIGHT: Attribute = { key: "elevationM", type: "measure", label: "Elevation", unit: "m" };

function pt(i: number, props: Record<string, unknown>): Feature {
  return { type: "Feature", geometry: { type: "Point", coordinates: [10 + i * 0.05, 46] }, properties: props };
}

function stateOf(layer: Partial<LoadedLayer> & Pick<LoadedLayer, "id" | "style">, features: Feature[], mode: RenderMode): MapState {
  const loaded: LoadedLayer = {
    title: layer.id,
    receivedAt: "",
    result: { kind: "geojson", data: { type: "FeatureCollection", features }, citation: { source: "s", url: "https://x", retrieved: "r" } },
    ...layer,
  };
  return {
    ...initialMapState,
    terrain: false,
    viewport: { longitude: 10, latitude: 46, zoom: 10, pitch: 0, bearing: 0 },
    layers: { [layer.id]: loaded },
    renderOps: [{ layerId: layer.id, mode, visible: true }],
  };
}

type Props = Record<string, unknown>;

describe("encode by default (owner: 'needs to be discernible')", () => {
  const features = [
    pt(0, { kind: "alpine_hut", name: "Hut A", elevationM: 2400 }),
    pt(1, { kind: "spring", name: "Spring B", elevationM: 1200 }),
    pt(2, { kind: "viewpoint", name: "View C", elevationM: 1800 }),
  ];

  it("colors each kind from the palette, purple, pink, dark grey, and folds a fifth kind into Other", () => {
    const key = categoryKey({ id: "outdoor-features", attributes: [KINDS], style: {} })!;
    expect(key.groups.map((g) => g.color)).toEqual([PURPLE, PINK, DARK_GREY]);
    const many: Attribute = { ...KINDS, levels: ["a", "b", "c", "d", "e"].map((v) => ({ value: v, label: v })) };
    expect(categoryKey({ id: "x", attributes: [many], style: {} })!.groups.map((g) => g.color)).toEqual([...CATEGORY_COLORS, OTHER_COLOR]);
    expect(categoryKey({ id: "remoteness", attributes: [KINDS], style: { unit: "score" } })).toBeUndefined();
  });

  it("gives each kind its own glyph and fill on the map, sized by the primary measure", () => {
    const layers = buildDeckLayers(stateOf({ id: "outdoor-features", style: { geometry: "point", color: DARK_GREY }, attributes: [KINDS, HEIGHT] }, features, "points"));
    const icons = layers.find((l) => l instanceof IconLayer)!;
    const p = icons.props as Props;
    const getIcon = p.getIcon as (f: Feature) => { id: string };
    const ids = features.map((f) => getIcon(f).id);
    expect(ids[0]).toMatch(/^hut-c6E5BFF/);
    expect(ids[1]).toMatch(/^drop-cF57272/);
    expect(ids[2]).toMatch(/^eye-c3A3A3C/);
    const size = p.getSize as (f: Feature) => number;
    expect(typeof size).toBe("function");
    expect(size(features[0])).toBeGreaterThan(size(features[1]));
  });

  it("labels the top features by the card's measure (labelsOf)", () => {
    const layers = buildDeckLayers(
      stateOf({ id: "peaks", style: { geometry: "point", color: DARK_GREY }, attributes: [HEIGHT], card: { measure: { key: "elevationM", label: "Elevation" } } }, features, "points"),
    );
    const placed = layers.find((l) => l.id.endsWith(":points:placed"));
    expect(placed).toBeTruthy();
    const names = ((placed!.props as Props).data as Feature[]).map((f) => f.properties?.name);
    expect(names[0]).toBe("Hut A");
  });

  it("draws a line layer's own points as symbols in lines mode (rapids and put-ins)", () => {
    const run: Feature = { type: "Feature", geometry: { type: "LineString", coordinates: [[10, 46], [10.1, 46.1]] }, properties: { name: "Run" } };
    const layers = buildDeckLayers(stateOf({ id: "paddling", style: { geometry: "line", color: DARK_GREY } }, [run, pt(0, { kind: "rapid" })], "lines"));
    const icons = layers.find((l) => l instanceof IconLayer);
    expect(((icons?.props as Props).data as Feature[]).length).toBe(1);
  });

  it("fills areas by category at a readable tint, with a white casing wider than a basemap line", () => {
    const square = (x: number, kind: string): Feature => ({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]] },
      properties: { kind },
    });
    const kinds: Attribute = { key: "kind", type: "category", label: "Kind", levels: [{ value: "a", label: "A" }, { value: "b", label: "B" }] };
    const layers = buildDeckLayers(stateOf({ id: "grazing-allotments", style: { geometry: "polygon", color: DARK_GREY }, attributes: [kinds] }, [square(0, "a"), square(2, "b")], "polygons"));
    const casing = layers.find((l) => l.id.endsWith(":polygons:casing"))!;
    expect((casing.props as Props).getLineWidth).toBeGreaterThanOrEqual(3.5);
    const poly = layers.find((l) => l.id.endsWith(":polygons"))!;
    const line = (poly.props as Props).getLineColor as (f: Feature) => number[];
    expect(line(square(0, "a")).slice(0, 3)).toEqual([0x6e, 0x5b, 0xff]);
    expect(line(square(2, "b")).slice(0, 3)).toEqual([0xf5, 0x72, 0x72]);
  });
});
