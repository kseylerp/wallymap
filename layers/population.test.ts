import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import layer from "./population";

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
    expect(layer.maxAreaKm2).toBe(50_000_000);
    expect(layer.input.parse({})).toEqual({});
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
});
