import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import layer, { lossTileUrl } from "./forest-loss";

const AMAZON: [number, number, number, number] = [-60, -10, -50, 0];

function ctx(stub: ReturnType<typeof vi.fn>) {
  return { bbox: AMAZON, zoom: 5, env: {}, fetch: stub as unknown as CachedFetch };
}

describe("forest-loss layer", () => {
  it("builds the verified true-color dynamic tile URL from the inputs", () => {
    expect(lossTileUrl(2018, 2024, "50")).toBe(
      "https://tiles.globalforestwatch.org/umd_tree_cover_loss/latest/dynamic/{z}/{x}/{y}.png" +
        "?render_type=true_color&start_year=2018&end_year=2024&tree_cover_density_threshold=50",
    );
  });

  it("declares global coverage, the CC BY license and no required env", () => {
    expect(layer.coverage).toBe("global");
    expect(layer.license).toBe("CC BY 4.0 (Hansen/UMD/Google/USGS/NASA via GFW)");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
  });

  it("applies the documented input defaults", () => {
    expect(layer.input.parse({})).toEqual({ startYear: 2015, endYear: 2025, canopyThreshold: "30" });
    expect(layer.input.safeParse({ startYear: 2000 }).success).toBe(false);
    expect(layer.input.safeParse({ endYear: 2026 }).success).toBe(false);
    expect(layer.input.safeParse({ canopyThreshold: "99" }).success).toBe(false);
  });

  it("returns a raster tiles result without calling upstream", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub), { startYear: 2015, endYear: 2025, canopyThreshold: "30" });
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.data.format).toBe("raster");
    expect(r.data).toMatchObject({ minzoom: 3, maxzoom: 12 });
    expect(r.data.url).toContain("start_year=2015&end_year=2025&tree_cover_density_threshold=30");
    expect(r.citation.source).toContain("Global Forest Watch");
  });

  it("rejects a start year after the end year", async () => {
    const r = await layer.query(ctx(vi.fn()), { startYear: 2022, endYear: 2018, canopyThreshold: "30" });
    expect(r).toMatchObject({ error: expect.stringContaining("startYear") });
  });

  it("summarizes to the tile URL and format for the model", async () => {
    const r = await layer.query(ctx(vi.fn()), { startYear: 2015, endYear: 2025, canopyThreshold: "30" });
    const summary = summarizeLayerResult(r);
    expect(summary).toMatchObject({
      kind: "tiles",
      format: "raster",
      url: expect.stringContaining("umd_tree_cover_loss/latest/dynamic/{z}/{x}/{y}.png"),
    });
  });

  it("describes yearly loss and warns it is not logging", () => {
    expect(layer.description).toMatch(/year/i);
    expect(layer.description).toMatch(/not .*logging|logging/i);
  });

  it("runs through runLayer and rejects an out-of-range year", async () => {
    const ok = await runLayer("forest-loss", { bbox: AMAZON, zoom: 5 });
    expect(ok.status).toBe(200);
    const bad = await runLayer("forest-loss", { bbox: AMAZON, input: { startYear: 1999 } });
    expect(bad.status).toBe(400);
  });
});
