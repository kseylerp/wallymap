import { describe, expect, it } from "vitest";
import { normalizeOverpass, normalizeRoutes } from "@/layers/osm-trails";
import fixture from "@/layers/__fixtures__/osm-trails.tahoe.json";
import routeGeometry from "@/layers/__fixtures__/osm-trails.routes-geom.guiana.json";
import type { LayerResult } from "@/layers/types";
import {
  SAMPLE_MAX_CHARS,
  SAMPLE_VALUE_MAX_CHARS,
  TOP_SIZE,
  drawnYearsOf,
  isFullLayerResult,
  sampleOf,
  summarizeLayerResult,
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
    expect(summary.sample).toHaveLength(3);
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
      sample: [{ a: 1 }, null],
      citation,
      coverageNote: "US only",
    });
  });

  it("gives a null bbox for an empty collection", () => {
    const result: LayerResult = { kind: "geojson", citation, data: { type: "FeatureCollection", features: [] } };
    expect(summarizeLayerResult(result)).toMatchObject({ featureCount: 0, bbox: null, sample: [] });
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
