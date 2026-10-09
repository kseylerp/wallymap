import { describe, expect, it } from "vitest";
import { normalizeOverpass } from "@/layers/osm-trails";
import fixture from "@/layers/__fixtures__/osm-trails.tahoe.json";
import type { LayerResult } from "@/layers/types";
import { isFullLayerResult, summarizeLayerResult } from "./summarize";

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
