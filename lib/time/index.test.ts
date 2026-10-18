import type { Feature, FeatureCollection } from "geojson";
import { describe, expect, it } from "vitest";
import type { TileTime } from "@/layers/types";
import type { LoadedLayer } from "@/lib/render/state";
import { afterEach, vi } from "vitest";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type MapState } from "@/lib/render/state";
import { visibleState } from "@/lib/render/view";
import {
  chooseBucket,
  filterByWindow,
  inWindow,
  MAX_TILE_STEPS,
  periodStart,
  stepLabel,
  stepWindow,
  tileSteps,
  tileUrlForTime,
  timeIndex,
  timePresets,
  windowLabel,
  type TimeWindow,
} from "@/lib/time";

const DAY = 86_400_000;
const feat = (t?: unknown): Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [0, 0] },
  properties: t === undefined ? {} : { t },
});
const fc = (...ts: unknown[]): FeatureCollection => ({ type: "FeatureCollection", features: ts.map(feat) });
/** A dated point layer; continuous unless another time shape is given (docs/layer-contract.md). */
function layer(id: string, collection: FeatureCollection, time: LoadedLayer["time"] = { shape: "continuous" }): LoadedLayer {
  return {
    id,
    title: id,
    time,
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
  it("narrows a full-span slide window to the first bucket going forward and the newest going back", () => {
    const full: TimeWindow = [idx.buckets[0].start, idx.buckets[9].end];
    expect(stepWindow(idx, full, 1, "slide")).toEqual([y(2016), ye(2016)]);
    expect(stepWindow(idx, full, -1, "slide")).toEqual([y(2025), ye(2025)]);
    // Then it steps as usual.
    expect(stepWindow(idx, stepWindow(idx, full, 1, "slide"), 1, "slide")).toEqual([y(2017), ye(2017)]);
    expect(stepWindow(idx, stepWindow(idx, full, -1, "slide"), -1, "slide")).toEqual([y(2024), ye(2024)]);
    // A single bucket has nowhere to go.
    const one = timeIndex({ a: layer("a", fc("2020-06-01")) })!;
    const only: TimeWindow = [one.buckets[0].start, one.buckets[0].end];
    expect(stepWindow(one, only, 1, "slide")).toEqual(only);
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
  const night: TileTime = {
    template: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS/default/{date}/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png",
    cadence: "daily",
    from: "2020-11-18",
    daysBack: 3,
  };
  const nightUrl = night.template.replace("{date}", "2024-01-01");
  const loss: TileTime = {
    template:
      "https://tiles.globalforestwatch.org/umd_tree_cover_loss/latest/dynamic/{z}/{x}/{y}.png?render_type=true_color&start_year=2015&end_year={year}&tree_cover_density_threshold=30",
    cadence: "yearly",
    from: "2001",
    to: "2025",
  };
  const lossUrl = loss.template.replace("{year}", "2025");
  const now = Date.parse("2026-10-09T15:00:00Z");

  it("replaces {date} with the window end date", () => {
    const out = tileUrlForTime(nightUrl, night, ["2023-01-01T00:00:00Z", "2023-07-15T12:00:00Z"]);
    expect(out).toBe(night.template.replace("{date}", "2023-07-15"));
    expect(out).toContain("{z}/{y}/{x}");
  });
  it("fills {year} from the window end and start_year from the window start (never past the end)", () => {
    const a = tileUrlForTime(lossUrl, loss, ["2015-01-01T00:00:00Z", "2020-12-31T23:59:59Z"]);
    expect(a).toContain("start_year=2015&end_year=2020&");
    expect(a).toContain("{z}/{x}/{y}.png");
    expect(a.endsWith("tree_cover_density_threshold=30")).toBe(true);
    const b = tileUrlForTime(lossUrl, loss, ["2001-01-01T00:00:00Z", "2010-12-31T23:59:59Z"]);
    expect(b).toContain("start_year=2001&end_year=2010&");
    // A window before the layer's first year starts at that year.
    expect(tileUrlForTime(lossUrl, loss, ["1990-01-01T00:00:00Z", "2005-12-31T23:59:59Z"])).toContain("start_year=2001&end_year=2005&");
  });
  it("fills {start} and {end} from the window's first and last day", () => {
    const range: TileTime = { template: "https://x/{start}/{end}/{z}/{x}/{y}.png", cadence: "daily", from: "2020-01-01" };
    expect(tileUrlForTime("https://x", range, ["2024-03-01T00:00:00Z", "2024-03-07T12:00:00Z"])).toBe("https://x/2024-03-01/2024-03-07/{z}/{x}/{y}.png");
  });
  it("leaves the url unchanged without data.time or with an unparseable window end", () => {
    expect(tileUrlForTime(nightUrl, undefined, ["2023-01-01", "2023-02-01"])).toBe(nightUrl);
    expect(tileUrlForTime(nightUrl, night, ["2023-01-01", "not a date"])).toBe(nightUrl);
  });
  it("clamps a window that ends in the present to the latest published period", () => {
    const window: TimeWindow = ["2016-01-01T00:00:00Z", "2026-10-09T12:00:00Z"];
    expect(tileUrlForTime(nightUrl, night, window, now)).toBe(night.template.replace("{date}", "2026-10-06"));
    expect(tileUrlForTime(lossUrl, loss, window, now)).toContain("start_year=2016&end_year=2025&");
    expect(tileUrlForTime(lossUrl, loss, ["2026-01-01T00:00:00Z", "2026-10-09T00:00:00Z"], now)).toContain("end_year=2025&");
  });
  it("clamps to from, to and daysBack", () => {
    expect(tileUrlForTime(nightUrl, night, ["2010-01-01", "2010-06-01T00:00:00Z"], now)).toContain("/2020-11-18/");
    const capped: TileTime = { ...night, to: "2024-03-10", daysBack: undefined };
    expect(tileUrlForTime(nightUrl, capped, ["2020-01-01", "2026-01-01T00:00:00Z"], now)).toContain("/2024-03-10/");
    expect(tileUrlForTime(lossUrl, loss, ["1990-01-01", "1995-01-01T00:00:00Z"], now)).toContain("end_year=2001&");
    // Without daysBack or to, the newest period is today.
    const open: TileTime = { template: "u/{date}", cadence: "daily", from: "2020-01-01" };
    expect(tileUrlForTime("u/x", open, ["2020-01-01", "2030-01-01T00:00:00Z"], now)).toBe("u/2026-10-09");
  });
  it("lets a negative daysBack run ahead of today (forecast days)", () => {
    const fc: TileTime = { template: "u/{date}", cadence: "daily", from: "2020-01-01", daysBack: -9 };
    expect(tileUrlForTime("u/x", fc, ["2020-01-01", "2026-10-12T00:00:00Z"], now)).toBe("u/2026-10-12");
    expect(tileUrlForTime("u/x", fc, ["2020-01-01", "2030-01-01T00:00:00Z"], now)).toBe("u/2026-10-18");
  });
  it("snaps {date} to each cadence", () => {
    const t = (cadence: TileTime["cadence"], from = "2020-01-01"): TileTime => ({ template: "u/{date}", cadence, from });
    const w: TimeWindow = ["2020-01-01", "2024-05-17T13:00:00Z"];
    expect(tileUrlForTime("u", t("daily"), w, now)).toBe("u/2024-05-17");
    // 8-day and 16-day composites restart every 1 January (MODIS): 2024-05-17 is day-of-year 138, in the 8-day period
    // starting on day 137 (16 May) and the 16-day period starting on day 129 (8 May).
    expect(tileUrlForTime("u", t("8day"), w, now)).toBe("u/2024-05-16");
    expect(tileUrlForTime("u", t("16day"), w, now)).toBe("u/2024-05-08");
    expect(tileUrlForTime("u", t("16day"), ["2020-01-01", "2025-01-03T00:00:00Z"], now)).toBe("u/2025-01-01");
    expect(tileUrlForTime("u", t("monthly"), w, now)).toBe("u/2024-05-01");
    expect(tileUrlForTime("u", t("yearly"), w, now)).toBe("u/2024-01-01");
  });
  it("never snaps before from", () => {
    const monthly: TileTime = { template: "u/{date}", cadence: "monthly", from: "2020-03-15" };
    expect(tileUrlForTime("u", monthly, ["2020-01-01", "2020-03-20T00:00:00Z"], now)).toBe("u/2020-03-15");
    const yearly: TileTime = { template: "u/{date}", cadence: "yearly", from: "2012-04-01" };
    expect(tileUrlForTime("u", yearly, ["2012-01-01", "2012-12-31T00:00:00Z"], now)).toBe("u/2012-04-01");
  });
  it("fills every {year} in the template", () => {
    const t: TileTime = { template: "u/{year}/{year}", cadence: "yearly", from: "2001" };
    expect(tileUrlForTime("u", t, ["2001-01-01", "2010-06-01T00:00:00Z"], now)).toBe("u/2010/2010");
  });
});

describe("windowLabel", () => {
  it("formats by bucket", () => {
    expect(windowLabel(["2016-01-01T00:00:00Z", "2025-12-31T23:59:59Z"], "year")).toBe("2016 – 2025");
    expect(windowLabel(["2024-03-01T00:00:00Z", "2024-06-30T23:59:59Z"], "month")).toBe("Mar 2024 – Jun 2024");
    expect(windowLabel(["2024-06-01T00:00:00Z", "2024-06-07T23:59:59Z"], "day")).toBe("2024-06-01 – 2024-06-07");
  });
});

// ---- Dated tile layers on the scrubber ----

const NOW = Date.parse("2026-10-09T15:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
function timedTiles(id: string, time: TileTime, filled: string): LoadedLayer {
  return {
    id,
    title: id,
    style: { geometry: "polygon", color: "#000000" },
    result: {
      kind: "tiles",
      data: { url: time.template.replace("{date}", filled).replace("{year}", filled), minzoom: 0, maxzoom: 9, format: "raster", time },
      citation: { source: "s", url: "u", retrieved: "r" },
    },
    receivedAt: "now",
  };
}
const daily: TileTime = { template: "https://g/snow/{date}/{z}/{x}/{y}.png", cadence: "daily", from: "2000-02-24", daysBack: 1 };
const sixteen: TileTime = { template: "https://g/ndvi/{date}/{z}/{x}/{y}.png", cadence: "16day", from: "2000-03-05", daysBack: 25 };
const yearly: TileTime = { template: "https://gfw/loss/2001/{year}/{z}/{x}/{y}.png", cadence: "yearly", from: "2001", to: "2025" };

describe("periodStart", () => {
  it("restarts 8-day and 16-day periods every 1 January, so the year's last period is short", () => {
    expect(iso(periodStart(Date.parse("2025-12-31"), "16day"))).toBe("2025-12-19");
    expect(iso(periodStart(Date.parse("2026-01-05"), "16day"))).toBe("2026-01-01");
    expect(iso(periodStart(Date.parse("2026-01-20"), "8day"))).toBe("2026-01-17");
  });
});

describe("tileSteps", () => {
  it("offers a daily layer the last 30 days, ending daysBack before today", () => {
    const steps = tileSteps(daily, "https://g/snow/2026-10-08/{z}/{x}/{y}.png", NOW);
    expect(steps).toHaveLength(30);
    expect(iso(steps[29])).toBe("2026-10-08");
    expect(iso(steps[0])).toBe("2026-09-09");
    expect(tileSteps(daily, "x", NOW, 7)).toHaveLength(7);
    expect(tileSteps(daily, "x", NOW, 10_000)).toHaveLength(MAX_TILE_STEPS);
  });
  it("runs into forecast days when daysBack is negative", () => {
    const steps = tileSteps({ ...daily, daysBack: -9 }, "x", NOW);
    expect(iso(steps[steps.length - 1])).toBe("2026-10-18");
  });
  it("ends at an older loaded date instead of today, so the layer stays on the date asked for", () => {
    const steps = tileSteps(daily, "https://g/snow/2024-02-10/{z}/{x}/{y}.png", NOW);
    expect(iso(steps[steps.length - 1])).toBe("2024-02-10");
    expect(steps).toHaveLength(30);
  });
  it("steps 16-day composites on the January grid and keeps the newest 120", () => {
    const steps = tileSteps(sixteen, "https://g/ndvi/2026-09-14/{z}/{x}/{y}.png", NOW);
    expect(steps).toHaveLength(MAX_TILE_STEPS);
    // Today less 25 days is 2026-09-14, which is the start of a composite (day 257).
    expect(iso(steps[steps.length - 1])).toBe("2026-09-14");
    expect(iso(steps[steps.length - 2])).toBe("2026-08-29");
    expect(steps.map(iso)).toContain("2026-01-01");
  });
  it("steps years from `from` to `to`, reading the loaded year out of a {year} template", () => {
    const steps = tileSteps(yearly, "https://gfw/loss/2001/2025/{z}/{x}/{y}.png", NOW);
    expect(steps.map((s) => new Date(s).getUTCFullYear())).toEqual(Array.from({ length: 25 }, (_, k) => 2001 + k));
  });
  it("is empty when the archive starts after its newest day", () => {
    expect(tileSteps({ ...daily, from: "2030-01-01" }, "x", NOW)).toEqual([]);
  });
});

describe("timeIndex with dated tile layers", () => {
  it("opens on a tile layer alone: one bucket per image, no counts, the cadence named", () => {
    const idx = timeIndex({ n: timedTiles("greenness", sixteen, "2026-09-14") }, { now: NOW })!;
    expect(idx.cadence).toBe("16day");
    expect(idx.bucket).toBe("day");
    expect(idx.layerIds).toEqual(["greenness"]);
    expect(idx.buckets).toHaveLength(MAX_TILE_STEPS);
    expect(idx.buckets.every((b) => b.count === 0)).toBe(true);
    const last = idx.buckets[idx.buckets.length - 1];
    expect(last.start).toBe("2026-09-14T00:00:00.000Z");
    expect(last.end).toBe("2026-09-29T23:59:59.999Z");
    expect(stepLabel(idx)).toBe("one image per 16 days");
    expect(stepLabel(timeIndex({ f: timedTiles("forest-loss", yearly, "2025") }, { now: NOW })!)).toBe("one image per year");
  });
  it("lets the finest cadence set the steps when tile layers differ", () => {
    const idx = timeIndex({ a: timedTiles("forest-loss", yearly, "2025"), b: timedTiles("snow-cover", daily, "2026-10-08") }, { now: NOW })!;
    expect(idx.cadence).toBe("daily");
    expect(idx.buckets).toHaveLength(30);
    expect(idx.layerIds.sort()).toEqual(["forest-loss", "snow-cover"]);
  });
  it("merges with dated features: features pick the bucket, tile periods widen the span", () => {
    const quakes = layer("earthquakes", fc("2026-06-01T00:00:00Z", "2026-07-15T00:00:00Z"));
    const idx = timeIndex({ q: quakes, s: timedTiles("snow-cover", daily, "2026-10-08") }, { now: NOW })!;
    expect(idx.cadence).toBeUndefined();
    expect(idx.bucket).toBe("month");
    expect(idx.min).toBe("2026-06-01T00:00:00.000Z");
    expect(idx.max).toBe("2026-10-08T00:00:00.000Z");
    expect(idx.buckets.map((b) => b.count)).toEqual([1, 1, 0, 0, 0]);
    expect(stepLabel(idx)).toBe("features per month");
    expect(idx.layerIds.sort()).toEqual(["earthquakes", "snow-cover"]);
  });
});

describe("a dated tile layer in the map state", () => {
  afterEach(() => vi.useRealTimers());

  it("opens the scrubber, and play rewrites the tile URL one image per step", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const snow = timedTiles("snow-cover", daily, "2026-10-08");
    let s: MapState = reduce(initialMapState, { type: "layer_loaded", layer: snow });
    expect(s.time?.index.cadence).toBe("daily");
    expect(s.time?.index.buckets).toHaveLength(30);
    // The whole span shows the image the layer loaded.
    const url = (st: MapState) => {
      const r = visibleState(st).layers["snow-cover"].result;
      return r.kind === "tiles" ? r.data.url : "";
    };
    expect(url(s)).toBe("https://g/snow/2026-10-08/{z}/{x}/{y}.png");
    s = reduce(s, { type: "set_time_playing", playing: true });
    expect(url(s)).toBe("https://g/snow/2026-09-09/{z}/{x}/{y}.png");
    s = reduce(s, { type: "time_tick" });
    expect(url(s)).toBe("https://g/snow/2026-09-10/{z}/{x}/{y}.png");
    s = reduce(s, { type: "time_tick" });
    expect(url(s)).toBe("https://g/snow/2026-09-11/{z}/{x}/{y}.png");
  });
});

describe("timePresets (spec §12c: presets beside the scrubber)", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const dated = (dates: string[]): Record<string, LoadedLayer> => ({
    x: {
      id: "x",
      title: "x",
      time: { shape: "continuous" },
      style: { geometry: "point", color: "#000" },
      result: {
        kind: "geojson",
        data: { type: "FeatureCollection", features: dates.map((t) => ({ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { t } })) },
        citation: { source: "s", url: "https://example.com", retrieved: "r" },
      },
      receivedAt: "",
    },
  });

  it("offers the last day, week and month for a short span, each ending at the data's end", () => {
    const index = timeIndex(dated(["2026-09-01T00:00:00Z", "2026-09-20T00:00:00Z", "2026-10-10T00:00:00Z", "2026-10-15T06:00:00Z"]), { now })!;
    const presets = timePresets(index, now);
    expect(presets.map((p) => p.label)).toEqual(["Last 24 hours", "Last 7 days", "Last 30 days"]);
    expect(presets[1].window[0]).toBe("2026-10-08T12:00:00.000Z");
    expect(presets[1].window[1]).toBe(index.buckets.at(-1)!.end);
  });

  it("offers this year and since a named year for a long span, and nothing that would not narrow it", () => {
    const index = timeIndex(dated(["1995-06-01", "2005-01-01", "2012-01-01", "2020-06-01", "2026-03-01"]), { now })!;
    expect(timePresets(index, now).map((p) => p.label)).toEqual(["This year", "Since 2020", "Since 2010", "Since 2000"]);
    expect(timePresets(timeIndex(dated(["2026-10-15T01:00:00Z", "2026-10-15T02:00:00Z"]), { now })!, now)).toEqual([]);
  });

  it("drops presets that hold everything, nothing, or the same features as a finer one (glacier surveys)", () => {
    // Two surveys 50 years apart: "Since 2010", "Since 2000" and "Since 1990" all held the 2015 outlines.
    const index = timeIndex(dated(["1966-09-09", "1966-09-09", "1974-09-09", "2015-09-09", "2015-09-09", "2019-09-09"]), { now })!;
    const labels = timePresets(index, now).map((p) => p.label);
    expect(labels).toEqual(["Since 2010"]);
  });

  it("offers none for snapshots, a series, or tile layers that draw only the window's end", () => {
    const snaps = timeIndex({ x: { ...dated(["1966-09-09", "1966-09-09", "2015-09-09", "2015-09-09"]).x, time: { shape: "snapshots" } } }, { now })!;
    expect(snaps.snapshots?.stops.map((s) => s.label)).toEqual(["1966", "2015"]);
    expect(timePresets(snaps, now)).toEqual([]);
  });
});

describe("dates known only to the year", () => {
  it("step by year even over a few years (every date January 1 at midnight)", () => {
    const years = fc("2014-01-01T00:00:00.000Z", "2016-01-01T00:00:00.000Z", "2019-01-01T00:00:00.000Z");
    const index = timeIndex({ w: layer("w", years) });
    expect(index?.bucket).toBe("year");
    expect(windowLabel([index!.min, index!.max], index!.bucket)).toBe("2014 – 2019");
    // One real date among them keeps the finer steps.
    expect(timeIndex({ w: layer("w", fc("2014-01-01T00:00:00.000Z", "2016-06-14T00:00:00.000Z")) })?.bucket).toBe("month");
  });
});

describe("presets that match the data (owner: no presets that select nothing new)", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  const tileLayer = (time: TileTime, url: string): LoadedLayer =>
    ({
      id: "t",
      title: "t",
      style: { geometry: "polygon", color: "#000" },
      result: { kind: "tiles", data: { url, minzoom: 0, maxzoom: 9, format: "raster", time }, citation: { source: "s", url: "u", retrieved: "r" } },
      receivedAt: "",
    }) as LoadedLayer;

  it("a tile layer that lists its dates steps between exactly those, as a stepper", () => {
    const time: TileTime = { template: "https://x/{date}/{z}/{x}/{y}.png", cadence: "daily", from: "2020-01-01", dates: ["2026-09-02", "2026-09-19", "2026-10-04"] };
    const index = timeIndex({ t: tileLayer(time, "https://x/2026-10-04/{z}/{x}/{y}.png") }, { now })!;
    expect(index.buckets.map((b) => b.start.slice(0, 10))).toEqual(["2026-09-02", "2026-09-19", "2026-10-04"]);
    expect(index.snapshots?.stops.map((s) => s.label)).toEqual(["2026-09-02", "2026-09-19", "2026-10-04"]);
  });

  it("a 16-day tile layer offers the same date in earlier years", () => {
    const time: TileTime = { template: "https://x/{date}/{z}/{x}/{y}.png", cadence: "16day", from: "2015-01-01" };
    const index = timeIndex({ t: tileLayer(time, "https://x/2026-10-08/{z}/{x}/{y}.png") }, { now })!;
    const labels = timePresets(index, now).map((p) => p.label);
    expect(labels).toEqual(["Same date last year", "Same date 2024"]);
  });
});

