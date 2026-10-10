import type { Feature } from "geojson";
import { describe, expect, it } from "vitest";
import { selectionSwatch } from "@/components/LayerStack";
import { COMPARE_COLORS, compareBId } from "@/lib/render/compareView";
import { buildDeckLayerSets } from "@/lib/render/deck";
import { layerIdFromDeckId, pickToSelection } from "@/lib/render/inspect";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type LoadedLayer, type MapAction, type MapState } from "@/lib/render/state";
import { isSelectionVisible, visibleState } from "@/lib/render/view";

const fire = (name: string, year: number): Feature => ({
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-119.6, 37.7],
        [-119.4, 37.7],
        [-119.4, 37.9],
        [-119.6, 37.7],
      ],
    ],
  },
  properties: { name, year, t: `${year}-07-01T00:00:00.000Z` },
});
const ferguson = fire("Ferguson", 2018);
const washburn = fire("Washburn", 2022);
const geo = (id: string, features: Feature[]): LoadedLayer => ({
  id,
  title: id,
  style: { geometry: "polygon", color: "#FF5A36" },
  result: { kind: "geojson", data: { type: "FeatureCollection", features }, citation: { source: "s", url: "u", retrieved: "r" } },
  receivedAt: "now",
});
const fires = geo("fire-perimeters", [ferguson, washburn, fire("Rim", 2013)]);

function run(state: MapState, ...actions: MapAction[]): MapState {
  return actions.reduce(reduce, state);
}

const loaded = run(
  { ...initialMapState, terrain: false },
  { type: "layer_loaded", layer: fires },
  { type: "render", op: { layerId: "fire-perimeters", mode: "polygons", visible: true } },
);
const spec = {
  layerId: "fire-perimeters",
  a: ["2016-01-01", "2020-12-31"] as [string, string],
  b: ["2021-01-01", "2026-10-09"] as [string, string],
};
const toggle = run(loaded, { type: "set_compare", compare: { ...spec, mode: "toggle" } });

/** The deck pick a click on side B of a toggle compare returns (the B copy draws under `<layer>~b`). */
function sideBPick(state: MapState) {
  const view = visibleState(state);
  const layerB = buildDeckLayerSets(view, { mapboxToken: "" }).main.find((l) => l.id.startsWith(compareBId("fire-perimeters")) && !l.id.endsWith("casing"));
  expect(layerB).toBeDefined();
  return { object: washburn, layer: { id: layerB!.id }, coordinate: [-119.5, 37.8] };
}

describe("inspecting a compare's side B (toggle)", () => {
  it("maps the view-only `~b` deck id back to the layer and marks the selection as side B", () => {
    const flipped = run(toggle, { type: "compare_flip" });
    const selection = pickToSelection(sideBPick(flipped), flipped.layers);
    expect(selection).toMatchObject({ layerId: "fire-perimeters", side: "b", feature: washburn });
    // Side A and plain picks carry no side.
    expect(pickToSelection({ object: ferguson, layer: { id: "fire-perimeters:polygons" } }, flipped.layers)?.side).toBeUndefined();
    // Draped on terrain, the B id carries the 3D tag too.
    expect(pickToSelection({ object: washburn, layer: { id: "fire-perimeters~b@3d:polygons" } }, flipped.layers)).toMatchObject({
      layerId: "fire-perimeters",
      side: "b",
    });
  });

  it("keeps the card open for a side B feature through the flips", () => {
    const flipped = run(toggle, { type: "compare_flip" });
    const selection = pickToSelection(sideBPick(flipped), flipped.layers)!;
    const selected = run(flipped, { type: "select", selection });
    expect(isSelectionVisible(selected, selection)).toBe(true);
    expect(isSelectionVisible(run(selected, { type: "compare_flip" }), selection)).toBe(true);
  });

  it("drops a side B selection when the compare ends or switches to delta, keeps it for swipe", () => {
    const selection = { layerId: "fire-perimeters", feature: washburn, lngLat: [0, 0] as [number, number], side: "b" as const };
    const selected = run(toggle, { type: "select", selection });
    expect(run(selected, { type: "clear_compare" }).selected).toBeUndefined();
    expect(run(selected, { type: "set_compare_mode", mode: "delta" }).selected).toBeUndefined();
    expect(run(selected, { type: "set_compare_mode", mode: "swipe" }).selected).toBe(selection);
    // A side B selection with no compare to draw side B is not shown.
    expect(isSelectionVisible(loaded, selection)).toBe(false);
  });

  it("shows the side's compare color in the card swatch, the layer's own look otherwise", () => {
    const selection = { layerId: "fire-perimeters", feature: washburn, lngLat: [0, 0] as [number, number] };
    expect(selectionSwatch(toggle, { ...selection, side: "b" }, fires)).toMatchObject({ kind: "area", tint: COMPARE_COLORS.b, hatch: COMPARE_COLORS.b });
    expect(selectionSwatch(toggle, selection, fires)).toMatchObject({ kind: "area", tint: COMPARE_COLORS.a });
    expect(selectionSwatch(loaded, selection, fires)).toMatchObject({ kind: "area", tint: "#F57272", outline: "#F57272" });
  });
});

describe("a compared feature outside the scrubber's window", () => {
  it("stays inspectable while the compare draws it (compare wins over the scrubber)", () => {
    // The scrubber narrowed to 2013 only: Washburn (2022) is outside it, but side B of the compare draws it.
    const narrowed = run(toggle, { type: "set_time_window", window: ["2013-01-01T00:00:00.000Z", "2013-12-31T23:59:59.999Z"] });
    expect(narrowed.time?.window[1]).toBe("2013-12-31T23:59:59.999Z");
    const selection = { layerId: "fire-perimeters", feature: washburn, lngLat: [0, 0] as [number, number] };
    expect(isSelectionVisible(narrowed, selection)).toBe(true);
    // Without the compare, the scrubber hides it again.
    expect(isSelectionVisible(run(narrowed, { type: "clear_compare" }), selection)).toBe(false);
  });

  it("still applies the layer's filters to the compared layer", () => {
    const filtered = run(toggle, { type: "set_filters", layerId: "fire-perimeters", filters: { name: { include: ["Ferguson"] } } });
    const selection = { layerId: "fire-perimeters", feature: washburn, lngLat: [0, 0] as [number, number] };
    expect(isSelectionVisible(filtered, selection)).toBe(false);
  });
});

describe("set_compare_mode and the selection", () => {
  it("drops a delta copy selected in delta mode when switching to swipe or toggle", () => {
    const delta = run(loaded, { type: "set_compare", compare: { ...spec, mode: "delta" } });
    const copy = (visibleState(delta).layers["fire-perimeters"].result as { data: { features: Feature[] } }).data.features[0];
    const selected = run(delta, { type: "select", selection: { layerId: "fire-perimeters", feature: copy, lngLat: [0, 0] } });
    expect(run(selected, { type: "set_compare_mode", mode: "swipe" }).selected).toBeUndefined();
    expect(run(selected, { type: "set_compare_mode", mode: "toggle" }).selected).toBeUndefined();
  });

  it("keeps a side A selection between swipe and toggle (the same features draw) and on other layers", () => {
    const selection = { layerId: "fire-perimeters", feature: ferguson, lngLat: [0, 0] as [number, number] };
    const selected = run(toggle, { type: "select", selection });
    expect(run(selected, { type: "set_compare_mode", mode: "swipe" }).selected).toBe(selection);
  });
});

describe("hex delta deck ids", () => {
  it("never reuse the flat hex tile layer's id when 3D is off, and still map back to the layer", () => {
    const hexes = Array.from({ length: 3 }, (_, k): Feature => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [-119.5 + k * 0.01, 37.8] },
      properties: { h3: `8828308${k}fffffff`, t: `${2018 + k * 2}-07-01T00:00:00.000Z`, v: k },
    }));
    const hexLayer = geo("species", hexes);
    const state = run(
      { ...initialMapState, terrain: false },
      { type: "layer_loaded", layer: hexLayer },
      { type: "render", op: { layerId: "species", mode: "points", visible: true } },
      { type: "set_compare", compare: { ...spec, layerId: "species", mode: "delta" } },
    );
    const ids = buildDeckLayerSets(visibleState(state), { mapboxToken: "" }).main.map((l) => l.id);
    expect(ids).toContain("species@hexdelta:points");
    expect(ids).not.toContain("species:points");
    expect(layerIdFromDeckId("species@hexdelta:points")).toBe("species");
  });
});
