import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeEeFetch, testEnv } from "@/lib/ee/__fixtures__/fakeEe";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import { contractProblems, legendOf } from "./contract";
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
    expect(layer.license).toBe("CC BY 4.0 (Hansen/UMD/Google/USGS/NASA via GFW; drivers of loss WRI and Google DeepMind; outlines geoBoundaries)");
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
    expect(r.data).toMatchObject({ minzoom: 3, maxzoom: 12, tileSize: 512 });
    expect(r.data.url).toContain("start_year=2015&end_year=2025&tree_cover_density_threshold=30");
    expect(r.citation.source).toContain("Global Forest Watch");
    expect(r.data.time).toEqual({
      template: expect.stringContaining("start_year=2015&end_year={year}&"),
      cadence: "yearly",
      from: "2015",
      to: "2025",
    });
    expect(r.coverageNote).toBe("Tree cover lost 2015–2025, where canopy was at least 30% in 2000");
  });

  it("keys the loss pink the tiles draw, unfiltered (audit 2026-10-17: no key)", () => {
    expect(contractProblems(layer)).toEqual([]);
    expect(legendOf(layer).items).toEqual([expect.objectContaining({ label: "Tree cover lost in the years shown", color: "#E44692" })]);
    expect(layer.style.raster).toMatchObject({ saturation: 0 });
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

/** Earth Engine as recorded for the Pará box on 2026-10-23: the region rows, then the sums over Pará's outline. */
function paraCompute(expression: unknown): unknown {
  const text = JSON.stringify(expression);
  if (text.includes("Collection.reduceColumns")) {
    return text.includes("ADM1")
      ? { list: [["BRA-ADM1-1", "Para", "BRA", 1217747, 1217747], ["BRA-ADM1-2", "Amazonas", "BRA", 1565029, 124855]] }
      : { list: [["BRA-ADM0", "Brazil", "BRA", 8471604, 1757397]] };
  }
  if (text.includes("Filter.equals")) {
    return { forest: 1_098_000, total: 82_800, y2017: 13_900, y2018: 8_000, y2024: 15_900, d1: 54_200, d5: 22_200, d3: 2_800, d2: 1_400, d4: 1_300 };
  }
  return { forest: 1_400_000, total: 105_900, y2017: 17_800, d1: 69_800, d5: 27_800 };
}

describe("forest-loss totals through Earth Engine", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sums the loss over the state the box stands for and states km², hectares, the busiest years and the drivers", async () => {
    vi.stubGlobal("fetch", fakeEeFetch({ compute: paraCompute }).fetch);
    const r = await layer.query({ bbox: [-58.9, -9.9, -46.0, 2.6], zoom: 5, env: testEnv(), fetch: vi.fn() as unknown as CachedFetch }, { startYear: 2017, endYear: 2025, canopyThreshold: "30" });
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.coverageNote).toBe(
      "Tree cover lost 2017–2025 in Para (the state or province's outline): about 82,800 km² (8.3 million ha), 7.5% of the 1,098,000 km² with at least 30% canopy in 2000; " +
        "most in 2024 15,900 km², 2017 13,900 km², 2018 8,000 km²; what drove it (WRI and Google DeepMind drivers of forest loss, the dominant driver of each 1 km cell): " +
        "permanent agriculture 66% (54,200 km²), wildfire 27% (22,200 km²), shifting cultivation 3% (2,800 km²), hard commodities 2% (1,400 km²), logging 2% (1,300 km²); estimated from Hansen v1.13 on a 280 m grid",
    );
    expect(r.legend).toMatchObject({ title: "Tree cover loss 2017–2025", items: [expect.objectContaining({ label: "Lost 2017–2025: 82,800 km² in Para" })] });
    expect(r.citation.source).toContain("WRI and Google DeepMind");
    // The tiles and the scrubber are the same as without Earth Engine.
    expect(r.data.url).toContain("start_year=2017&end_year=2025");
  });

  it("keeps the picture and says the totals are missing when Earth Engine fails", async () => {
    vi.stubGlobal("fetch", fakeEeFetch({ compute: () => new Response("busy", { status: 503 }) }).fetch);
    const r = await layer.query({ bbox: AMAZON, zoom: 5, env: testEnv(), fetch: vi.fn() as unknown as CachedFetch }, { startYear: 2017, endYear: 2025, canopyThreshold: "30" });
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.coverageNote).toMatch(/^Tree cover lost 2017–2025, where canopy was at least 30% in 2000; the areas lost and their drivers could not be computed \(.+\), so give no numbers$/);
    expect(r.legend).toBeUndefined();
  });
});
