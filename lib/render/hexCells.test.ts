import type { Feature } from "geojson";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import { ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { latLngToCell } from "h3-js";
import { describe, expect, it } from "vitest";
import type { Attribute } from "@/layers/types";
import { buildDeckLayers, declutterLabels, hexColumns, hexTileColor, hexTileColorAt, type HexFeature } from "@/lib/render/deck";
import {
  askAboutCellText,
  basisLabel,
  basisScale,
  basisT,
  cellContext,
  cellOf,
  hexCells,
  hexLegendSentence,
  rankWords,
  roughly,
  summarizeCell,
  usableBasis,
} from "@/lib/render/hexCells";
import { DARK_GREY } from "@/lib/render/palette";
import { initialMapState, type LoadedLayer, type MapState, type RenderOp } from "@/lib/render/state";

const citation = { source: "EIA", url: "https://www.eia.gov", retrieved: "2026-10-15" };

const fuel: Attribute = {
  key: "kind",
  label: "Fuel",
  type: "category",
  levels: [
    { value: "wind", label: "Wind" },
    { value: "solar", label: "Solar" },
    { value: "gas", label: "Natural gas" },
  ],
};
const capacity: Attribute = { key: "v", label: "Capacity", type: "measure", unit: "MW", encode: "size" };

const plant = (lng: number, lat: number, kind: string, v: number, name: string, t?: string): Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lng, lat] },
  properties: { name, kind, v, ...(t && { t }) },
});

/** West Texas, roughly: a busy cell of wind farms near Sweetwater, a lone gas plant far off, a solar farm. */
const plants: Feature[] = [
  plant(-100.4, 32.47, "wind", 300, "Roscoe Wind", "2009-01-01"),
  plant(-100.401, 32.471, "wind", 780, "Horse Hollow", "2006-01-01"),
  plant(-100.402, 32.472, "wind", 220, "Sweetwater 4", "2007-01-01"),
  plant(-100.399, 32.469, "solar", 50, "Sweetwater Solar", "2021-01-01"),
  plant(-102.0, 31.9, "gas", 900, "Permian Gas"),
];

function layerOf(features: Feature[] = plants): LoadedLayer {
  return {
    id: "power-plants",
    title: "Power plants",
    style: { geometry: "point", color: DARK_GREY, unit: "MW", extrude: "v" },
    attributes: [fuel, capacity, { key: "t", label: "Online", type: "time" }],
    result: { kind: "geojson", data: { type: "FeatureCollection", features }, citation },
    receivedAt: "2026-10-15T00:00:00Z",
  };
}

function stateWith(op: Partial<RenderOp>, extra: Partial<MapState> = {}): MapState {
  const layer = layerOf();
  return {
    ...initialMapState,
    viewport: { ...initialMapState.viewport, zoom: 7 },
    layers: { [layer.id]: layer },
    renderOps: [{ layerId: layer.id, mode: "hexbin", visible: true, ...op }],
    ...extra,
  };
}

describe("hex cells carry information (spec §12d)", () => {
  const ctx = cellContext(layerOf());
  const data = { type: "FeatureCollection" as const, features: plants };
  const cells = hexCells(data, 5);
  const busy = cells.find((c) => c.members.length === 4)!;

  it("bins once per data object and resolution, keeping each cell's members", () => {
    expect(hexCells(data, 5)).toBe(cells);
    expect(cells).toHaveLength(2);
    expect(busy.h3).toBe(latLngToCell(32.47, -100.4, 5));
  });

  it("colors a cell by count, the measure's sum, a category's share or recency, and falls back to count", () => {
    expect(basisScale(cells, "count", ctx).values.get(busy)).toBe(4);
    expect(basisScale(cells, "sum", ctx).values.get(busy)).toBe(1350);
    expect(basisScale(cells, "share:wind", ctx).values.get(busy)).toBe(0.75);
    expect(basisScale(cells, "recency", ctx).values.get(busy)).toBe(Date.parse("2021-01-01"));
    expect(usableBasis("sum", { ...ctx, measure: undefined }, cells)).toBe("count");
    expect(usableBasis("share:wind", { ...ctx, category: undefined }, cells)).toBe("count");
    const scale = basisScale(cells, "sum", ctx);
    expect(basisT(900, scale)).toBeLessThan(basisT(1350, scale));
    expect(basisT(1350, scale)).toBe(1);
    expect(basisLabel(1350, "sum")).toBe("1.4k");
    expect(basisLabel(0.75, "share:wind")).toBe("75%");
    expect(basisLabel(1, "recency")).toBe("");
  });

  it("summarises a cell for its card: area, density, rank, shares, total and median, time span, top named", () => {
    const summary = summarizeCell(busy, cells, "sum", ctx);
    expect(summary.count).toBe(4);
    expect(summary.areaKm2).toBeGreaterThan(200);
    expect(summary.densityPerKm2).toBeCloseTo(4 / summary.areaKm2);
    expect(summary.rank).toBe(1);
    expect(summary.of).toBe(2);
    expect(summary.shares?.label).toBe("Fuel");
    expect(summary.shares?.parts.map((p) => [p.label, p.share])).toEqual([
      ["Wind", 0.75],
      ["Solar", 0.25],
    ]);
    expect(summary.measure).toMatchObject({ label: "Capacity", unit: "MW", sum: 1350, median: 260 });
    expect(summary.span).toEqual({ first: "2006-01-01", latest: "2021-01-01" });
    expect(summary.named.map((n) => n.name)).toEqual(["Horse Hollow", "Roscoe Wind", "Sweetwater 4", "Sweetwater Solar"]);
    expect(summary.named[0].value).toBe("780 MW");
    expect(rankWords(summary, ctx)).toBe("1st by capacity, of 2 cells");
    expect(rankWords(summarizeCell(busy, cells, "count", ctx), ctx)).toBe("The busiest of 2 cells");
    expect(askAboutCellText("Power plants", "power-plants", summary)).toMatch(/^In Power plants \(power-plants\) inside the hex cell bbox \[-?\d/);
    expect(askAboutCellText("Power plants", "power-plants", summary)).toContain("4 features; Wind 75%, Solar 25%");
  });

  it("says in words what darker means, with the cell size", () => {
    expect(hexLegendSentence(6, "sum", ctx, { kind: { include: ["wind"] } })).toBe("Each cell ≈ 36 km²; darker = more wind capacity (labels in MW)");
    expect(hexLegendSentence(5, "count", ctx)).toBe("Each cell ≈ 250 km²; darker = more power plants");
    expect(hexLegendSentence(4, "share:wind", ctx)).toBe("Each cell ≈ 1,800 km²; darker = a larger share of wind");
    expect(hexLegendSentence(7, "recency", ctx)).toBe("Each cell ≈ 5.2 km²; darker = newer power plants");
    expect(roughly(12_393.4)).toBe("12,000");
  });
});

describe("the renderer draws the basis and registers each cell for its card", () => {
  it("colors flat tiles by the sum of capacity and labels them with it; a pick finds its cell", () => {
    const layers = buildDeckLayers(stateWith({ hexBasis: "sum" }));
    const tiles = layers.find((l) => l instanceof H3HexagonLayer)!;
    const hexes = (tiles.props as { data: HexFeature[] }).data;
    const fill = (tiles.props as { getFillColor: (f: HexFeature) => number[] }).getFillColor;
    const busy = hexes.find((h) => h.properties.count === 4)!;
    const lone = hexes.find((h) => h.properties.count === 1)!;
    expect(busy.properties.value).toBe(1350);
    expect(fill(busy)).toEqual(hexTileColorAt(1));
    expect(fill(lone)).not.toEqual(fill(busy));
    const labels = layers.find((l) => l instanceof TextLayer && l.id.endsWith(":hexbin:labels"))!;
    const getText = (labels.props as unknown as { getText: (f: HexFeature) => string }).getText;
    expect(getText(busy)).toBe("1.4k");
    expect(cellOf(busy)?.cell.members).toHaveLength(4);
    expect(cellOf(busy)?.basis).toBe("sum");
  });

  it("keeps the count ramp by default", () => {
    const layers = buildDeckLayers(stateWith({}));
    const tiles = layers.find((l) => l instanceof H3HexagonLayer)!;
    const hexes = (tiles.props as { data: HexFeature[] }).data;
    const busy = hexes.find((h) => h.properties.count === 4)!;
    expect((tiles.props as { getFillColor: (f: HexFeature) => number[] }).getFillColor(busy)).toEqual(hexTileColor(4, 4));
  });

  it("stands columns on the same cells and basis, so a column's card is the cell's", () => {
    const ctx = cellContext(layerOf());
    const columned = hexColumns({ type: "FeatureCollection", features: plants }, 5, "sum", ctx);
    const tallest = columned.cells.features.find((c) => c.properties.tallest)!;
    expect(tallest.properties.count).toBe(4);
    expect(tallest.properties.v).toBe(1350);
    expect(columned.label[0].text).toBe("1.4k");
    expect(cellOf(tallest)?.cell.members).toHaveLength(4);
  });

  it("rings the feature the pointer is over in the row's top 10", () => {
    const hovered = plants[1];
    const layers = buildDeckLayers(stateWith({ mode: "points" }, { hover: { layerId: "power-plants", feature: hovered } }));
    const ring = layers.find((l) => l.id === "power-plants:hover");
    expect(ring).toBeInstanceOf(ScatterplotLayer);
    expect((ring!.props as { data: { position: number[] }[] }).data[0].position).toEqual([-100.401, 32.471]);
    expect(buildDeckLayers(stateWith({ mode: "points", visible: false }, { hover: { layerId: "power-plants", feature: hovered } })).some((l) => l.id.endsWith(":hover"))).toBe(false);
  });
});

describe("ranked labels do not pile up", () => {
  it("keeps a lower-ranked name only where it does not overlap a higher one at this zoom", () => {
    const named = [plant(-83.68, 37.8, "x", 110, "Military Wall"), plant(-83.679, 37.8001, "x", 46, "Left Flank"), plant(-83.6, 37.75, "x", 57, "Long Wall")];
    expect(declutterLabels(named, 11, 37.8).map((f) => f.properties?.name)).toEqual(["Military Wall", "Long Wall"]);
    expect(declutterLabels(named, 17, 37.8)).toHaveLength(3);
  });
});
