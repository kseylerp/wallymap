import { describe, expect, it } from "vitest";
import { normalizeOverpass, normalizeRoutes } from "@/layers/osm-trails";
import fixture from "@/layers/__fixtures__/osm-trails.tahoe.json";
import routeGeometry from "@/layers/__fixtures__/osm-trails.routes-geom.guiana.json";
import type { LayerResult } from "@/layers/types";
import {
  DATE_YEARS_MAX,
  SAMPLES_KEY,
  SAMPLE_MAX_CHARS,
  SAMPLE_VALUE_MAX_CHARS,
  TOP_SIZE,
  drawnYearsOf,
  isFullLayerResult,
  sampleOf,
  summarizeLayerResult,
  type GeojsonSummary,
} from "./summarize";

const citation = { source: "Test", url: "https://example.test", retrieved: "2026-10-09T00:00:00Z" };

describe("summarizeLayerResult", () => {
  it("summarizes the Tahoe fixture to under 2 KB with the full feature count", () => {
    const data = normalizeOverpass(fixture);
    const result: LayerResult = { kind: "geojson", data, citation };
    const summary = summarizeLayerResult(result);
    expect(JSON.stringify(summary).length).toBeLessThan(2048);
    expect(summary).toMatchObject({ kind: "geojson", featureCount: data.features.length });
    if (!("kind" in summary) || summary.kind !== "geojson") throw new Error("expected geojson");
    expect(summary.geometryTypes).toEqual({ LineString: data.features.length });
    expect(summary[SAMPLES_KEY]).toHaveLength(3);
    expect(summary.totalLengthKm).toBeGreaterThan(0);
    expect(summary).not.toHaveProperty("features");
    expect(summary).not.toHaveProperty("data");
    const [w, s, e, n] = summary.bbox ?? [];
    expect(w).toBeLessThan(e as number);
    expect(s).toBeLessThan(n as number);
  });

  it("computes the bbox across mixed geometry types", () => {
    const result: LayerResult = {
      kind: "geojson",
      citation,
      coverageNote: "US only",
      data: {
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: { a: 1 }, geometry: { type: "Point", coordinates: [-120, 39] } },
          {
            type: "Feature",
            properties: null,
            geometry: { type: "Polygon", coordinates: [[[-121, 38], [-119, 38], [-119, 40], [-121, 38]]] },
          },
        ],
      },
    };
    expect(summarizeLayerResult(result)).toEqual({
      kind: "geojson",
      featureCount: 2,
      geometryTypes: { Point: 1, Polygon: 1 },
      bbox: [-121, 38, -119, 40],
      [SAMPLES_KEY]: [{ a: 1 }, null],
      citation,
      coverageNote: "US only",
    });
  });

  it("gives a null bbox for an empty collection", () => {
    const result: LayerResult = { kind: "geojson", citation, data: { type: "FeatureCollection", features: [] } };
    expect(summarizeLayerResult(result)).toMatchObject({ featureCount: 0, bbox: null, [SAMPLES_KEY]: [] });
    expect(summarizeLayerResult(result)).not.toHaveProperty("stats");
  });

  it("tells the model a tile layer is scrubbable, without the url template", () => {
    const tiles: LayerResult = {
      kind: "tiles",
      data: {
        url: "https://t.test/2026-10-06/{z}/{x}/{y}.png",
        minzoom: 0,
        maxzoom: 8,
        format: "raster",
        time: { template: "https://t.test/{date}/{z}/{x}/{y}.png", cadence: "daily", from: "2020-11-18", daysBack: 3 },
      },
      citation,
    };
    expect(summarizeLayerResult(tiles)).toMatchObject({ time: { cadence: "daily", from: "2020-11-18", daysBack: 3 } });
    expect(JSON.stringify(summarizeLayerResult(tiles))).not.toContain("{date}");
  });

  it("flattens a tiles result and passes an error through unchanged", () => {
    const tiles: LayerResult = {
      kind: "tiles",
      data: { url: "https://tiles.example.test/{z}/{x}/{y}.png", minzoom: 0, maxzoom: 12, format: "raster" },
      citation,
    };
    expect(summarizeLayerResult(tiles)).toEqual({
      kind: "tiles",
      url: "https://tiles.example.test/{z}/{x}/{y}.png",
      minzoom: 0,
      maxzoom: 12,
      format: "raster",
      citation,
    });
    const error = { error: "nope", hint: "upstream" as const };
    expect(summarizeLayerResult(error)).toBe(error);
  });

  it("includes vector format, sourceLayer and geometry in a tiles summary", () => {
    const tiles: LayerResult = {
      kind: "tiles",
      data: {
        url: "https://tiles.example.test/{z}/{x}/{y}.pbf",
        minzoom: 4,
        maxzoom: 14,
        format: "vector",
        sourceLayer: "trails",
        geometry: "line",
      },
      citation,
    };
    expect(summarizeLayerResult(tiles)).toEqual({
      kind: "tiles",
      url: "https://tiles.example.test/{z}/{x}/{y}.pbf",
      minzoom: 4,
      maxzoom: 14,
      format: "vector",
      sourceLayer: "trails",
      geometry: "line",
      citation,
    });
  });

  it("isFullLayerResult tells full results from summaries and errors", () => {
    const full: LayerResult = { kind: "geojson", citation, data: { type: "FeatureCollection", features: [] } };
    expect(isFullLayerResult(full)).toBe(true);
    expect(isFullLayerResult(summarizeLayerResult(full))).toBe(false);
    expect(isFullLayerResult({ error: "x" })).toBe(false);
    expect(isFullLayerResult(null)).toBe(false);
  });
});

describe("sampleOf", () => {
  it("clips long strings, flattens nested values and keeps numbers", () => {
    const [sample] = sampleOf([{ properties: { name: "x".repeat(500), n: 3, tags: { a: "y".repeat(500) }, ok: true } }]);
    const props = sample as Record<string, unknown>;
    expect((props.name as string).length).toBe(SAMPLE_VALUE_MAX_CHARS);
    expect((props.name as string).endsWith("…")).toBe(true);
    expect(props.n).toBe(3);
    expect(props.ok).toBe(true);
    expect(typeof props.tags).toBe("string");
    expect((props.tags as string).length).toBe(SAMPLE_VALUE_MAX_CHARS);
  });

  it("drops samples from the end until the whole sample fits", () => {
    const big = () => ({ properties: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, "z".repeat(200)])) });
    const sample = sampleOf([big(), big(), big()]);
    expect(sample).toHaveLength(1);
    const small = sampleOf([{ properties: { a: 1 } }, { properties: { b: 2 } }, { properties: null }]);
    expect(small).toEqual([{ a: 1 }, { b: 2 }, null]);
    expect(JSON.stringify(sampleOf([{ properties: { a: "z".repeat(119) } }, { properties: { b: 2 } }])).length).toBeLessThan(SAMPLE_MAX_CHARS);
  });
});

describe("tile summaries say what the picture means", () => {
  const tiles = (url: string, time?: { template: string; cadence: "yearly"; from: string; to: string }): LayerResult => ({
    kind: "tiles",
    data: { url, minzoom: 3, maxzoom: 12, format: "raster", ...(time && { time }) },
    citation,
  });
  const LOSS = "https://tiles.globalforestwatch.org/umd_tree_cover_loss/latest/dynamic/{z}/{x}/{y}.png?render_type=true_color&start_year=2015&end_year=2025&tree_cover_density_threshold=30";

  it("forest-loss carries the exact years drawn, apart from the scrubber's archive range", () => {
    const summary = summarizeLayerResult(
      tiles(LOSS, { template: LOSS.replace("end_year=2025", "end_year={year}"), cadence: "yearly", from: "2001", to: "2025" }),
      "forest-loss",
    );
    expect(summary).toMatchObject({ drawnYears: "2015-2025", time: { from: "2001", to: "2025" } });
    expect((summary as { shows: string }).shows).toContain("Tree cover lost in 2015-2025 only");
  });

  it("flood-extent says it shows all open water on one day, not change, and how to show change", () => {
    const summary = summarizeLayerResult(tiles("https://gibs.example/OPERA/{z}/{y}/{x}.png"), "flood-extent") as { shows: string };
    expect(summary.shows).toMatch(/All open water detected on that one day/);
    expect(summary.shows).toMatch(/not a change/);
    expect(summary.shows).toMatch(/surface-water with product change/);
  });

  it("leaves shows out without a layer id or for layers that read plainly", () => {
    expect(summarizeLayerResult(tiles(LOSS))).not.toHaveProperty("shows");
    expect(summarizeLayerResult(tiles("https://example.test/{z}/{x}/{y}.png"), "geology")).not.toHaveProperty("shows");
  });

  it("reads drawn years only from start_year and end_year", () => {
    expect(drawnYearsOf(LOSS)).toBe("2015-2025");
    expect(drawnYearsOf("https://x.test/t.png?start_year=2020&end_year=2020")).toBe("2020");
    expect(drawnYearsOf("https://x.test/t.png?year=2020")).toBeUndefined();
  });
});

describe("summarizeLayerResult top", () => {
  it("names the longest hiking routes with length and network, so the note can list them", () => {
    const result: LayerResult = { kind: "geojson", data: normalizeRoutes(routeGeometry), citation };
    const summary = summarizeLayerResult(result, "osm-trails") as { top: string[] };
    expect(summary.top).toHaveLength(4);
    expect(summary.top[0]).toMatch(/^Piste de Bélizon, \d+(\.\d)? km \(regional route\)$/);
    expect(summary.top[1]).toMatch(/^Molokoï, /);
  });

  it("is left out for path answers, other layers and no layer id", () => {
    const paths: LayerResult = { kind: "geojson", data: normalizeOverpass(fixture), citation };
    expect(summarizeLayerResult(paths, "osm-trails")).not.toHaveProperty("top");
    const routes: LayerResult = { kind: "geojson", data: normalizeRoutes(routeGeometry), citation };
    expect(summarizeLayerResult(routes)).not.toHaveProperty("top");
    expect(summarizeLayerResult(routes, "mtb-trails")).not.toHaveProperty("top");
  });

  it("keeps at most TOP_SIZE, largest v first", () => {
    const features = Array.from({ length: 20 }, (_, i) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [0, 0] },
      properties: { name: `Park ${i}`, areaKm2: i, v: i },
    }));
    const summary = summarizeLayerResult({ kind: "geojson", data: { type: "FeatureCollection", features }, citation }, "protected-areas-world") as {
      top: string[];
    };
    expect(summary.top).toHaveLength(TOP_SIZE);
    expect(summary.top[0]).toBe("Park 19, 19 km²");
  });
});

describe("summarizeLayerResult stats", () => {
  type Poly = { name: string; glacierId: string; v: number; t?: string };
  const square = (x: number) => ({
    type: "Polygon" as const,
    coordinates: [[[x, 43], [x + 0.01, 43], [x + 0.01, 43.01], [x, 43]]],
  });
  const glaciers = (rows: Poly[]): LayerResult => ({
    kind: "geojson",
    citation,
    data: {
      type: "FeatureCollection",
      features: rows.map((p, i) => ({ type: "Feature" as const, geometry: square(-109.6 + i * 0.02), properties: p })),
    },
  });
  // The owner's Wind River transcript: the first features were small, so the sample said 0.18 to 0.29 km² while Gannett is ~3 km².
  const small = Array.from({ length: 40 }, (_, i): Poly => ({ name: "Unnamed glacier", glacierId: `G${i}`, v: 0.18 + (i % 12) / 100, t: "2015-08-01T00:00:00.000Z" }));
  const windRiver = glaciers([
    ...small,
    { name: "Gannett Glacier", glacierId: "GAN", v: 3.4, t: "1966-08-01T00:00:00.000Z" },
    { name: "Gannett Glacier", glacierId: "GAN", v: 3.06, t: "2015-08-01T00:00:00.000Z" },
    { name: "Dinwoody Glacier", glacierId: "DIN", v: 2.5, t: "2015-08-01T00:00:00.000Z" },
  ]);

  it("covers every feature, not the first few: the largest glacier, the total and the mean", () => {
    const summary = summarizeLayerResult(windRiver, "glaciers", { unit: "km²", geometry: "polygon" }) as GeojsonSummary;
    expect(summary.stats).toMatchObject({ unit: "km²", count: 42, max: 3.06 });
    expect(summary.stats?.top[0]).toEqual({ name: "Gannett Glacier", v: 3.06, date: "2015-08-01" });
    expect(summary.stats?.top[1].name).toBe("Dinwoody Glacier");
    expect(summary.stats?.top).toHaveLength(5);
    const smallSum = small.reduce((a, r) => a + r.v, 0);
    expect(summary.stats?.sum).toBeCloseTo(smallSum + 3.06 + 2.5, 1);
    expect(summary.totalArea).toEqual({ value: summary.stats?.sum, unit: "km²" });
    expect(summary.stats?.basis).toMatch(/newest dated feature of each of 42 glaciers \(43 features/);
    expect(summary[SAMPLES_KEY].length).toBeLessThanOrEqual(3);
  });

  it("gives the date span and the distinct years the scrubber covers", () => {
    const summary = summarizeLayerResult(windRiver, "glaciers", { unit: "km²" }) as GeojsonSummary;
    expect(summary.dates).toMatchObject({ from: "1966-08-01", to: "2015-08-01", years: ["1966", "2015"], yearCount: 2, dated: 43 });
    expect(summary.dates?.scrubber).toMatch(/^Already open in the layer panel over 1966 to 2015;/);
  });

  it("leaves out the year list past DATE_YEARS_MAX and reads the layer's own time field", () => {
    const rows = Array.from({ length: DATE_YEARS_MAX + 3 }, (_, i) => ({ name: `F${i}`, glacierId: `G${i}`, v: i, when: `${2000 + i}-06-01` }));
    const result: LayerResult = {
      kind: "geojson",
      citation,
      data: { type: "FeatureCollection", features: rows.map((p) => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [0, 0] }, properties: p })) },
    };
    const summary = summarizeLayerResult(result, "fire-perimeters", { unit: "acres", timeField: "when" }) as GeojsonSummary;
    expect(summary.dates).toMatchObject({ from: "2000-06-01", to: "2014-06-01", yearCount: 15 });
    expect(summary.dates).not.toHaveProperty("years");
    expect(summary.stats).toMatchObject({ count: 15, min: 0, max: 14, mean: 7, sum: 105 });
    expect(summary.stats).not.toHaveProperty("basis");
    expect(summary).not.toHaveProperty("totalArea");
  });

  it("totals the length of line layers and gives no area for a non-area v", () => {
    const result: LayerResult = {
      kind: "geojson",
      citation,
      data: {
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: { name: "A", v: 1 }, geometry: { type: "LineString", coordinates: [[0, 0], [0, 1]] } },
          { type: "Feature", properties: { name: "B", v: 2 }, geometry: { type: "MultiLineString", coordinates: [[[0, 0], [1, 0]]] } },
        ],
      },
    };
    const summary = summarizeLayerResult(result, undefined, { unit: "km" }) as GeojsonSummary;
    expect(summary.totalLengthKm).toBeCloseTo(222.4, 0);
    expect(summary).not.toHaveProperty("totalArea");
  });
});

describe("summarizeLayerResult truncation", () => {
  it("carries truncated and rankedOut from a wide result, and leaves both out otherwise", () => {
    const data = { type: "FeatureCollection" as const, features: [] };
    const wide: LayerResult = {
      kind: "geojson",
      data,
      citation,
      coverageNote: "Showing the 2,000 largest of 4,512 (ranked by capacity in MW); zoom in under 250,000 km² for all",
      truncated: true,
      rankedOut: "2,512 more in this box rank below these by capacity in MW and are left out",
    };
    expect(summarizeLayerResult(wide)).toMatchObject({ truncated: true, rankedOut: wide.rankedOut, coverageNote: wide.coverageNote });
    const plain = summarizeLayerResult({ kind: "geojson", data, citation });
    expect(plain).not.toHaveProperty("truncated");
    expect(plain).not.toHaveProperty("rankedOut");
  });
});

describe("summarizeLayerResult: facets and help for the model (spec §12a, §12b)", () => {
  it("lists each facet label with the raw values render.filters takes and their counts, and the help for v", () => {
    const features = [0, 3, 3, 5].map((v) => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [0, 0] }, properties: { v } }));
    const out = summarizeLayerResult(
      { kind: "geojson", data: { type: "FeatureCollection", features }, citation: { source: "s", url: "u", retrieved: "r" } },
      "mtb-trails",
      {
        facets: [
          { key: "v", label: "Difficulty", kind: "category", values: [{ value: 0, label: "Easy" }, { value: 3, label: "Hard" }, { value: 4, label: "Expert" }, { value: 5, label: "Expert" }] },
        ],
      },
      { v: { text: "Singletrack Scale.", scale: "0 (easiest) to 6 (hardest)", source: "OSM wiki" } },
    );
    if ("error" in out || out.kind !== "geojson") throw new Error("expected a geojson summary");
    expect(out.facets).toEqual([
      {
        key: "v",
        label: "Difficulty",
        kind: "category",
        values: [
          { label: "Easy", include: ["0"], count: 1 },
          { label: "Hard", include: ["3"], count: 2 },
          { label: "Expert", include: ["4", "5"], count: 1 },
        ],
      },
    ]);
    expect(out.help?.v).toBe("Singletrack Scale. Scale: 0 (easiest) to 6 (hardest). Source: OSM wiki.");
  });
});
