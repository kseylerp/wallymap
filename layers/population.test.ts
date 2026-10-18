import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import { scenarioTileUrl } from "@/lib/render/scenario";
import { legendOf, timeShapeOf } from "./contract";
import layer, { LEGEND, POPULATION_SCENARIO } from "./population";

const EUROPE: [number, number, number, number] = [-10, 35, 30, 60];

function ctx(stub: ReturnType<typeof vi.fn>) {
  return { bbox: EUROPE, zoom: 2, env: {}, fetch: stub as unknown as CachedFetch };
}

describe("population layer", () => {
  it("declares global coverage, the GIBS license and no env", () => {
    expect(layer.id).toBe("population");
    expect(layer.coverage).toBe("global");
    expect(layer.license).toBe("NASA GIBS (public)");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
    expect(layer.input.parse({})).toEqual({ year: 2020 });
  });

  it("returns the verified GPW 2020 raster template without calling upstream", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub), {});
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.data.format).toBe("raster");
    expect(r.data.url).toBe(
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GPW_Population_Density_2020/default/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png",
    );
    expect(r.data).toMatchObject({ minzoom: 0, maxzoom: 7 });
    expect(r.citation.source).toContain("NASA");
    expect(r.coverageNote).toMatch(/2020/);
  });

  it("describes units, year and the coarse resolution", () => {
    expect(layer.description).toMatch(/people per square kilometre/i);
    expect(layer.description).toMatch(/2020/);
    expect(layer.description).toMatch(/estimate|modelled|model/i);
  });

  it("summarizes to the tile URL and format for the model", async () => {
    const summary = summarizeLayerResult(await layer.query(ctx(vi.fn()), {}));
    expect(summary).toMatchObject({ kind: "tiles", format: "raster", url: expect.stringContaining("GPW_Population_Density_2020") });
  });

  it("runs through runLayer for a continent-sized bbox", async () => {
    const res = await runLayer("population", { bbox: EUROPE, zoom: 2 });
    expect(res.status).toBe(200);
  });

  it("accepts a whole-globe bbox through runLayer", async () => {
    const res = await runLayer("population", { bbox: [-180, -85, 180, 85], zoom: 1 });
    expect(res.status).toBe(200);
  });

  it("offers the five GPW estimates as snapshots the stepper and compare move between", async () => {
    const r = await layer.query(ctx(vi.fn()), { year: 2005 });
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.data.url).toContain("/GPW_Population_Density_2005/default/default/");
    expect(r.data.scenario).toBe(POPULATION_SCENARIO);
    expect(POPULATION_SCENARIO.values).toEqual([2000, 2005, 2010, 2015, 2020]);
    expect(scenarioTileUrl(POPULATION_SCENARIO, 2010)).toContain("/GPW_Population_Density_2010/");
    expect(timeShapeOf(layer)).toEqual({ shape: "snapshots", dates: ["2000", "2005", "2010", "2015", "2020"], step: "year" });
    expect(layer.input.safeParse({ year: 2012 }).success).toBe(false);
  });

  it("keys GIBS's classes in people per km², drawn as served", () => {
    expect(layer.style.raster).toMatchObject({ saturation: 0 });
    expect(legendOf(layer)).toBe(LEGEND);
    expect(LEGEND.items?.[0]).toMatchObject({ color: "#FFF2D1" });
    expect(LEGEND.items?.at(-1)).toMatchObject({ label: "1,000 and more (cities)", color: "#BD0026" });
  });
});
