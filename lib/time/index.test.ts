import type { Feature, FeatureCollection } from "geojson";
import { describe, expect, it } from "vitest";
import type { LoadedLayer } from "@/lib/render/state";
import { chooseBucket, filterByWindow, inWindow, stepWindow, tileUrlForTime, timeIndex, windowLabel, type TimeWindow } from "@/lib/time";

const DAY = 86_400_000;
const feat = (t?: unknown): Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [0, 0] },
  properties: t === undefined ? {} : { t },
});
const fc = (...ts: unknown[]): FeatureCollection => ({ type: "FeatureCollection", features: ts.map(feat) });
function layer(id: string, collection: FeatureCollection): LoadedLayer {
  return {
    id,
    title: id,
    style: { geometry: "point", color: "#000000" },
    result: { kind: "geojson", data: collection, citation: { source: "s", url: "u", retrieved: "r" } },
    receivedAt: "now",
  };
}
const tiles = (id: string): LoadedLayer => ({
  id,
  title: id,
  style: { geometry: "raster", color: "#000000" },
  result: { kind: "tiles", data: { url: "https://x/2024-01-01/{z}" }, citation: { source: "s", url: "u", retrieved: "r" } },
  receivedAt: "now",
}) as unknown as LoadedLayer;

describe("chooseBucket", () => {
  it("uses day for short spans, month for up to 10 years, year beyond", () => {
    expect(chooseBucket(30 * DAY)).toBe("day");
    expect(chooseBucket(59 * DAY)).toBe("day");
    expect(chooseBucket(5 * 365 * DAY)).toBe("month");
    expect(chooseBucket(30 * 365 * DAY)).toBe("year");
  });
  it("coarsens until the bucket count fits", () => {
    expect(chooseBucket(90 * DAY)).toBe("month");
    expect(chooseBucket(90 * DAY, 200)).toBe("day");
    expect(chooseBucket(4 * 365 * DAY, 60)).toBe("month");
    expect(chooseBucket(9 * 365 * DAY, 60)).toBe("year");
    expect(chooseBucket(4 * 365 * DAY, 40)).toBe("year");
  });
});

describe("timeIndex", () => {
  it("is null with no valid t", () => {
    expect(timeIndex({})).toBeNull();
    expect(timeIndex({ a: layer("a", fc(undefined, "nope", 5)) })).toBeNull();
    expect(timeIndex({ t: tiles("t") })).toBeNull();
  });
  it("buckets by year across layers, skips invalid, and lists contributors", () => {
    const idx = timeIndex({
      a: layer("a", fc("2016-03-01T00:00:00Z", "2016-12-31T23:59:59Z", "2020-06-01T00:00:00Z", "garbage")),
      b: layer("b", fc(undefined)),
      c: layer("c", fc("2036-01-02T00:00:00Z")),
      d: tiles("d"),
    })!;
    expect(idx.bucket).toBe("year");
    expect(idx.layerIds).toEqual(["a", "c"]);
    expect(idx.min).toBe("2016-03-01T00:00:00.000Z");
    expect(idx.max).toBe("2036-01-02T00:00:00.000Z");
    expect(idx.buckets).toHaveLength(21);
    expect(idx.buckets[0]).toEqual({ start: "2016-01-01T00:00:00.000Z", end: "2016-12-31T23:59:59.999Z", count: 2 });
    expect(idx.buckets[4].count).toBe(1);
    expect(idx.buckets[20].count).toBe(1);
    expect(idx.buckets.reduce((n, b) => n + b.count, 0)).toBe(4);
  });
  it("covers min..max contiguously by month", () => {
    const idx = timeIndex({ a: layer("a", fc("2024-01-15", "2024-02-10")) }, { maxBuckets: 60 })!;
    expect(idx.bucket).toBe("day");
    const m = timeIndex({ a: layer("a", fc("2022-01-15", "2024-05-01T12:00:00Z")) })!;
    expect(m.bucket).toBe("month");
    expect(m.buckets).toHaveLength(29);
    for (let i = 1; i < m.buckets.length; i++) {
      expect(Date.parse(m.buckets[i].start) - Date.parse(m.buckets[i - 1].end)).toBe(1);
    }
    expect(m.buckets[0].start).toBe("2022-01-01T00:00:00.000Z");
    expect(m.buckets[28].end).toBe("2024-05-31T23:59:59.999Z");
  });
  it("honors maxBuckets and handles a single instant", () => {
    const one = timeIndex({ a: layer("a", fc("2024-06-01T10:00:00Z")) })!;
    expect(one.buckets).toHaveLength(1);
    expect(one.buckets[0].count).toBe(1);
    const coarse = timeIndex({ a: layer("a", fc("2024-01-01", "2024-02-20")) }, { maxBuckets: 10 })!;
    expect(coarse.bucket).toBe("month");
  });
});

describe("inWindow", () => {
  const w: TimeWindow = ["2024-01-01T00:00:00Z", "2024-12-31T23:59:59Z"];
  it("is inclusive at both ends", () => {
    expect(inWindow("2024-01-01T00:00:00Z", w)).toBe(true);
    expect(inWindow("2024-12-31T23:59:59Z", w)).toBe(true);
    expect(inWindow("2023-12-31T23:59:59Z", w)).toBe(false);
    expect(inWindow("2025-01-01T00:00:00Z", w)).toBe(false);
  });
  it("keeps features without t", () => {
    expect(inWindow(undefined, w)).toBe(true);
  });
});

describe("filterByWindow", () => {
  const w: TimeWindow = ["2024-01-01T00:00:00Z", "2024-12-31T23:59:59Z"];
  it("returns the same object when nothing is dropped", () => {
    const all = fc("2024-05-05T00:00:00Z", undefined);
    expect(filterByWindow(all, w)).toBe(all);
  });
  it("drops only out-of-window features and keeps those without t", () => {
    const out = filterByWindow(fc("2024-05-05T00:00:00Z", "2020-01-01T00:00:00Z", undefined), w);
    expect(out.features).toHaveLength(2);
    expect(out.features.map((f) => f.properties?.t)).toEqual(["2024-05-05T00:00:00Z", undefined]);
  });
});

describe("stepWindow", () => {
  const idx = timeIndex({ a: layer("a", fc("2016-06-01", "2025-06-01")) })!; // 10 yearly buckets
  const y = (n: number): string => `${n}-01-01T00:00:00.000Z`;
  const ye = (n: number): string => `${n}-12-31T23:59:59.999Z`;
  it("slides both ends by one bucket", () => {
    expect(stepWindow(idx, [y(2018), ye(2019)], 1, "slide")).toEqual([y(2019), ye(2020)]);
    expect(stepWindow(idx, [y(2018), ye(2019)], -1, "slide")).toEqual([y(2017), ye(2018)]);
  });
  it("clamps at the ends without shrinking the window", () => {
    const first: TimeWindow = [y(2016), ye(2017)];
    const lastW: TimeWindow = [y(2024), ye(2025)];
    expect(stepWindow(idx, first, -1, "slide")).toEqual(first);
    expect(stepWindow(idx, lastW, 1, "slide")).toEqual(lastW);
  });
  it("cumulative keeps start at min and moves the end", () => {
    const w: TimeWindow = [idx.min, ye(2018)];
    expect(stepWindow(idx, w, 1, "cumulative")).toEqual([idx.min, ye(2019)]);
    expect(stepWindow(idx, w, -1, "cumulative")).toEqual([idx.min, ye(2017)]);
  });
  it("cumulative clamps to the first and last bucket", () => {
    expect(stepWindow(idx, [idx.min, ye(2016)], -1, "cumulative")).toEqual([idx.min, ye(2016)]);
    expect(stepWindow(idx, [idx.min, ye(2025)], 1, "cumulative")).toEqual([idx.min, ye(2025)]);
  });
});

describe("tileUrlForTime", () => {
  const night =
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Night_Lights/default/2024-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png";
  const loss =
    "https://tiles.globalforestwatch.org/umd_tree_cover_loss/latest/dynamic/{z}/{x}/{y}.png?render_type=true_color&start_year=2015&end_year=2025&tree_cover_density_threshold=30";
  it("replaces the night-lights date with the window end date", () => {
    const out = tileUrlForTime("night-lights", night, ["2023-01-01T00:00:00Z", "2023-07-15T12:00:00Z"]);
    expect(out).toBe(night.replace("2024-01-01", "2023-07-15"));
    expect(out).toContain("{z}/{y}/{x}");
  });
  it("sets forest-loss end_year and caps start_year", () => {
    const a = tileUrlForTime("forest-loss", loss, ["2015-01-01T00:00:00Z", "2020-12-31T23:59:59Z"]);
    expect(a).toContain("start_year=2015&end_year=2020&");
    expect(a).toContain("{z}/{x}/{y}.png");
    expect(a.endsWith("tree_cover_density_threshold=30")).toBe(true);
    const b = tileUrlForTime("forest-loss", loss, ["2001-01-01T00:00:00Z", "2010-12-31T23:59:59Z"]);
    expect(b).toContain("start_year=2010&end_year=2010&");
  });
  it("leaves other layers unchanged", () => {
    expect(tileUrlForTime("snow", night, ["2023-01-01", "2023-02-01"])).toBe(night);
  });
});

describe("windowLabel", () => {
  it("formats by bucket", () => {
    expect(windowLabel(["2016-01-01T00:00:00Z", "2025-12-31T23:59:59Z"], "year")).toBe("2016 – 2025");
    expect(windowLabel(["2024-03-01T00:00:00Z", "2024-06-30T23:59:59Z"], "month")).toBe("Mar 2024 – Jun 2024");
    expect(windowLabel(["2024-06-01T00:00:00Z", "2024-06-07T23:59:59Z"], "day")).toBe("2024-06-01 – 2024-06-07");
  });
});
