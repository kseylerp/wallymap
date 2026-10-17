import { describe, expect, it } from "vitest";
import type { Feature } from "geojson";
import { frameAggregate, frameDate, layerAggregate, shareOfRange, valueAt, wantsYearDial, yearFraction } from "@/lib/render/series";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type LoadedLayer, type MapState } from "@/lib/render/state";
import { timeIndex, windowLabel } from "@/lib/time";

const CITE = { source: "s", url: "https://e.org", retrieved: "2026-10-17" };
const DAYS = ["2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z", "2026-10-03T00:00:00.000Z", "2026-10-04T00:00:00.000Z"];

function reach(q: (number | null)[]): Feature {
  return { type: "Feature", geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] }, properties: { q: q[2], series: { q } } };
}

const pulse: LoadedLayer = {
  id: "river-pulse",
  title: "River pulse",
  style: { geometry: "line", color: "#9FB693" },
  attributes: [{ key: "q", type: "measure", label: "Flow", unit: "m³/s", aggregate: "max" }],
  result: {
    kind: "geojson",
    data: { type: "FeatureCollection", features: [reach([10, 20, 30, 40]), reach([100, 50, null, 25])] },
    citation: CITE,
    series: { times: DAYS, step: "day", now: 2, forecastFrom: 3 },
  },
  receivedAt: "2026-10-03",
};

describe("series frames", () => {
  it("builds one bucket per frame and opens on the newest reading, one frame wide", () => {
    const index = timeIndex({ [pulse.id]: pulse });
    expect(index?.bucket).toBe("day");
    expect(index?.buckets).toHaveLength(4);
    expect(index?.series).toEqual({ step: "day", now: 2, forecastFrom: 3 });
    const state = reduce(initialMapState, { type: "layer_loaded", layer: pulse });
    expect(state.time?.window).toEqual([DAYS[2], "2026-10-03T23:59:59.999Z"]);
    expect(windowLabel(state.time!.window, "day")).toBe("2026-10-03");
  });

  it("steps hourly frames for an hourly series", () => {
    const hours = Array.from({ length: 5 }, (_, k) => new Date(Date.UTC(2026, 9, 17, k)).toISOString());
    const wind: LoadedLayer = { ...pulse, id: "wind", result: { ...pulse.result, series: { times: hours, step: "hour", now: 0 } } as LoadedLayer["result"] };
    const index = timeIndex({ wind });
    expect(index?.bucket).toBe("hour");
    expect(index?.buckets[1].start).toBe(hours[1]);
    expect(windowLabel([index!.buckets[1].start, index!.buckets[1].end], "hour")).toBe("2026-10-17 01:00");
  });

  it("totals the aggregate measure per frame and finds the period's low and high", () => {
    const state: MapState = reduce(reduce(initialMapState, { type: "layer_loaded", layer: pulse }), {
      type: "render",
      op: { layerId: "river-pulse", mode: "lines", visible: true },
    });
    const agg = frameAggregate(state);
    expect(agg?.kind).toBe("max");
    expect(agg?.values).toEqual([100, 50, 30, 40]);
    expect(agg?.low).toEqual({ value: 30, at: 2 });
    expect(agg?.high).toEqual({ value: 100, at: 0 });
    expect(agg?.label).toBe("Highest flow in view");
    expect(shareOfRange(65, agg!)).toBeCloseTo(0.5);
  });

  it("counts dated features per bucket, and runs a total in cumulative mode", () => {
    const quake = (t: string): Feature => ({ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { t } });
    const dated: LoadedLayer = {
      id: "earthquakes",
      title: "Earthquakes",
      style: { geometry: "point", color: "#3A3A3C" },
      result: { kind: "geojson", data: { type: "FeatureCollection", features: [quake("2026-01-05"), quake("2026-01-09"), quake("2026-03-02")] }, citation: CITE },
      receivedAt: "2026-10-03",
    };
    const index = timeIndex({ earthquakes: dated })!;
    const slide = layerAggregate(dated, { index, mode: "slide" });
    expect(slide?.kind).toBe("count");
    expect(slide?.label).toBe("Earthquakes");
    expect(slide?.values.reduce((a, b) => (a ?? 0) + (b ?? 0), 0)).toBe(3);
    const cumulative = layerAggregate(dated, { index, mode: "cumulative" });
    expect(cumulative?.values[cumulative.values.length - 1]).toBe(3);
  });

  it("interpolates between frames, and holds a frame when the next one is missing", () => {
    expect(valueAt([10, 20], 0.25)).toBe(12.5);
    expect(valueAt([10, null], 0.5)).toBe(10);
    expect(valueAt([null, 20], 0)).toBeNull();
  });

  it("says the frame's date plainly and places it in the year", () => {
    expect(frameDate(Date.UTC(2026, 9, 14), "day")).toBe("Wed 14 Oct 2026");
    expect(frameDate(Date.UTC(2026, 9, 14, 9), "hour")).toBe("Wed 14 Oct, 09:00 UTC");
    expect(yearFraction(Date.UTC(2026, 0, 1))).toBe(0);
    expect(wantsYearDial({ bucket: "day", buckets: [{ start: "2026-07-01", end: "2026-07-01" } as never, { start: "2026-10-01", end: "2026-10-01T23:59:59Z" } as never] })).toBe(true);
  });
});
