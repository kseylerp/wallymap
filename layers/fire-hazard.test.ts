import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import { contractProblems, legendOf, timeShapeOf } from "./contract";
import layer, { WHP_TILE_URL } from "./fire-hazard";

const MONTANA: [number, number, number, number] = [-115, 45, -110, 49];

function ctx(stub: ReturnType<typeof vi.fn>, bbox = MONTANA) {
  return { bbox, zoom: 7, env: {}, fetch: stub as unknown as CachedFetch };
}

describe("fire-hazard layer", () => {
  it("builds the verified ImageServer exportImage template with no-data transparency", () => {
    expect(WHP_TILE_URL).toBe(
      "https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/USFS_EDW_RMRS_WildfireHazardPotentialClassified/ImageServer/exportImage" +
        "?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&f=image" +
        "&interpolation=RSP_NearestNeighbor&noData=0&noDataInterpretation=esriNoDataMatchAny" +
        "&renderingRule=" +
        encodeURIComponent(
          JSON.stringify({
            rasterFunction: "Colormap",
            rasterFunctionArguments: { Colormap: [[2, 159, 182, 147], [3, 223, 145, 77], [4, 226, 92, 167], [5, 110, 91, 255]] },
          }),
        ),
    );
  });

  it("keys the four drawn classes in their colors, leaves the rest clear, and is one 2023 rating (audit 2026-10-17: no key)", () => {
    expect(contractProblems(layer)).toEqual([]);
    const legend = legendOf(layer);
    expect(legend.items?.map((i) => [i.label, i.color])).toEqual([
      ["Low", "#9FB693"],
      ["Moderate", "#DF914D"],
      ["High", "#E25CA7"],
      ["Very high", "#6E5BFF"],
    ]);
    expect(legend.note).toMatch(/left clear/);
    expect(layer.style.raster).toMatchObject({ opacity: 0.7 });
    expect(timeShapeOf(layer)).toMatchObject({ shape: "single", dates: ["2023"] });
  });

  it("declares US coverage, the public domain license and no env or input", () => {
    expect(layer.id).toBe("fire-hazard");
    expect(layer.coverage).toBe("us");
    expect(layer.license).toBe("Public domain (USDA Forest Service)");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
    expect(layer.input.parse({})).toEqual({});
  });

  it("returns a raster tiles result inside the US without calling upstream", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub), {});
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.data).toMatchObject({ format: "raster", minzoom: 3, maxzoom: 12, tileSize: 256, url: WHP_TILE_URL });
    expect(r.citation.source).toContain("Wildfire Hazard Potential");
  });

  it("returns an empty result with a coverage note outside the US", async () => {
    const r = await layer.query(ctx(vi.fn(), [2, 45, 3, 46]), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toEqual([]);
    expect(r.coverageNote).toMatch(/outside the United States/i);
  });

  it("summarizes to the tile URL for the model", async () => {
    const summary = summarizeLayerResult(await layer.query(ctx(vi.fn()), {}));
    expect(summary).toMatchObject({ kind: "tiles", format: "raster", url: WHP_TILE_URL });
  });

  it("runs through runLayer", async () => {
    expect((await runLayer("fire-hazard", { bbox: MONTANA, zoom: 7 })).status).toBe(200);
  });

  it("describes fire risk in the words people use and says it is not a forecast or past fires", () => {
    expect(layer.description).toMatch(/fire risk/i);
    expect(layer.description).toMatch(/not a forecast/i);
    expect(layer.description).toMatch(/fire-perimeters/);
  });
});
