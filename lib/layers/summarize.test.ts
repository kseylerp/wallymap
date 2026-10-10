import { describe, expect, it } from "vitest";
import { normalizeOverpass } from "@/layers/osm-trails";
import fixture from "@/layers/__fixtures__/osm-trails.tahoe.json";
import type { LayerResult } from "@/layers/types";
import { SAMPLE_MAX_CHARS, SAMPLE_VALUE_MAX_CHARS, isFullLayerResult, sampleOf, summarizeLayerResult } from "./summarize";

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
