import { describe, expect, it } from "vitest";
import type { LayerResult, MonthlyStrip } from "@/layers/types";
import { columns, COMPACT_ROW_HEIGHT, legendLines, monthLine, ROW_GAP, ROW_HEIGHT, shapeStrip, stripSource, valueText } from "./monthlyStrip";
import type { LoadedLayer, MapState } from "./state";

/** Tahoe City's 1991–2020 normals (NOAA), as the climate-normals layer returns them. */
const TAHOE: MonthlyStrip = {
  place: "Tahoe City, CA",
  period: "1991–2020",
  rows: [
    { kind: "band", key: "temperature", label: "Temperature", unit: "°F", high: [39.6, 40.5, 44.6, 50.1, 59.2, 69.3, 78, 77.4, 70.4, 59.2, 47.7, 39.7], low: [20.6, 21.1, 24.1, 27.6, 33.9, 40, 46, 45.4, 40.5, 32.6, 25.9, 20.7], legend: "Band: normal daily high and low temperature, 1991–2020" },
    { kind: "bars", key: "precipitation", label: "Precipitation", unit: "in", values: [6.21, 5.72, 4.95, 2.23, 1.57, 0.61, 0.17, 0.3, 0.42, 1.89, 3.21, 6], legend: "Bars: normal monthly precipitation (rain and melted snow), 1991–2020" },
    { kind: "cells", key: "snowGround", label: "Snow on the ground", unit: "share of days", values: [0.87, 0.86, 0.83, 0.45, 0.05, 0, 0, 0, 0, 0.03, 0.23, 0.77], max: 1, legend: "Shade: share of days with at least 1 inch of snow on the ground" },
  ],
};

const JULY = new Date(2026, 6, 15);

function loaded(id: string, result: LayerResult): LoadedLayer {
  return { id, title: id, style: { geometry: "point", color: "#3A3A3C" }, result, receivedAt: "2026-10-23T00:00:00Z" };
}

describe("monthly strip shaping", () => {
  it("lays twelve equal columns across the width", () => {
    const cols = columns(240);
    expect(cols).toHaveLength(12);
    expect(cols[0]).toEqual({ month: 0, x: 0, width: 20, center: 10 });
    expect(cols[11].center).toBe(230);
  });

  it("stacks the rows with their heights, the playhead on the current month and the extremes labelled", () => {
    const s = shapeStrip(TAHOE, 240, JULY);
    expect(s.rows.map((r) => r.kind)).toEqual(["band", "bars", "cells"]);
    expect(s.rows.map((r) => r.top)).toEqual([0, ROW_HEIGHT.band + ROW_GAP, ROW_HEIGHT.band + ROW_HEIGHT.bars + 2 * ROW_GAP]);
    expect(s.height).toBe(ROW_HEIGHT.band + ROW_HEIGHT.bars + ROW_HEIGHT.cells + 2 * ROW_GAP);
    expect(s.current).toBe(6);
    expect(s.playheadX).toBe(130);
    const band = s.rows[0];
    if (band.kind !== "band") throw new Error("band");
    expect(band.path.startsWith("M10.0,")).toBe(true);
    expect(band.path.endsWith("Z")).toBe(true);
    expect(band.peak).toMatchObject({ month: 6, text: "78°" });
    expect(band.trough).toMatchObject({ month: 0, text: "21°" });
    // July's high sits at the top of the band's inner area, January's low at its bottom.
    expect(band.peak!.y).toBeLessThan(band.trough!.y);
  });

  it("draws bars in proportion to the largest month and shades cells by their share", () => {
    const s = shapeStrip(TAHOE, 240, JULY);
    const bars = s.rows[1];
    if (bars.kind !== "bars") throw new Error("bars");
    const jan = bars.bars[0];
    const jul = bars.bars[6];
    expect(jan.height).toBeCloseTo(ROW_HEIGHT.bars - 10, 5);
    expect(jul.height / jan.height).toBeCloseTo(0.17 / 6.21, 2);
    expect(jan.y + jan.height).toBe(bars.top + bars.height);
    expect(bars.peak).toMatchObject({ month: 0, text: "6.2 in" });
    const cells = s.rows[2];
    if (cells.kind !== "cells") throw new Error("cells");
    expect(cells.cells[0].alpha).toBeCloseTo(0.87, 5);
    expect(cells.cells[6].alpha).toBe(0);
  });

  it("is smaller on a phone", () => {
    const s = shapeStrip(TAHOE, 240, JULY, true);
    expect(s.height).toBe(COMPACT_ROW_HEIGHT.band + COMPACT_ROW_HEIGHT.bars + COMPACT_ROW_HEIGHT.cells + 2 * ROW_GAP);
    expect(s.height).toBeLessThan(80);
  });

  it("puts a mark inside its month (the usual green-up date) and skips months without data", () => {
    const strip: MonthlyStrip = {
      place: "Asheville",
      period: "2001–2025",
      rows: [{ kind: "bars", key: "flow", label: "River flow", unit: "cfs", values: [null, 10, 20, 40, 80, 40, 20, 10, 5, 5, 5, null], legend: "Bars" }],
      mark: { month: 2, fraction: 0.5, label: "Usual green-up, Mar 16" },
    };
    const s = shapeStrip(strip, 240, JULY);
    expect(s.mark).toEqual({ x: 50, label: "Usual green-up, Mar 16" });
    const bars = s.rows[0];
    if (bars.kind !== "bars") throw new Error("bars");
    expect(bars.bars.map((b) => b.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(legendLines(strip)).toEqual(["Bars", "Line: usual green-up, Mar 16"]);
  });

  it("says a month in words with units", () => {
    expect(monthLine(TAHOE, 6)).toBe("Jul: high 78 °F, low 46 °F · precipitation 0.2 in · snow on the ground 0%");
    expect(monthLine(TAHOE, 0)).toBe("Jan: high 40 °F, low 21 °F · precipitation 6.2 in · snow on the ground 87%");
    expect(valueText(2280, "cfs")).toBe("2,280 cfs");
    expect(valueText(20, "years")).toBe("20 yr");
    expect(legendLines(TAHOE)).toHaveLength(3);
  });

  it("draws the months of the top shown layer that has them", () => {
    const plain = loaded("streamflow", { kind: "geojson", data: { type: "FeatureCollection", features: [] }, citation: { source: "s", url: "u", retrieved: "r" } });
    const normals = loaded("climate-normals", { kind: "geojson", data: { type: "FeatureCollection", features: [] }, citation: { source: "s", url: "u", retrieved: "r" }, months: TAHOE });
    const state = {
      layers: { streamflow: plain, "climate-normals": normals },
      renderOps: [
        { layerId: "climate-normals", visible: true },
        { layerId: "streamflow", visible: true },
      ],
    } as unknown as Pick<MapState, "layers" | "renderOps">;
    expect(stripSource(state)).toMatchObject({ layerId: "climate-normals", strip: { place: "Tahoe City, CA" } });
    const hidden = { ...state, renderOps: [{ layerId: "climate-normals", visible: false }] } as unknown as Pick<MapState, "layers" | "renderOps">;
    expect(stripSource(hidden)).toBeNull();
  });
});
