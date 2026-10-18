import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import { legendOf, legendProblems } from "./contract";
import layer, { LEGENDS, PRODUCTS, waterTileUrl } from "./surface-water";

const SALTON: [number, number, number, number] = [-116.2, 33.1, -115.4, 33.7];

function ctx(stub: ReturnType<typeof vi.fn>) {
  return { bbox: SALTON, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch };
}

async function tiles(input: Record<string, unknown>) {
  const stub = vi.fn();
  const r = await layer.query(ctx(stub), layer.input.parse(input));
  expect(stub).not.toHaveBeenCalled();
  if (!("kind" in r) || r.kind !== "tiles") throw new Error(`expected tiles, got ${JSON.stringify(r)}`);
  return r;
}

describe("surface-water layer", () => {
  it("declares global coverage, no env and no area cap", () => {
    expect(layer.id).toBe("surface-water");
    expect(layer.coverage).toBe("global");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
  });

  it("defaults to occurrence at zoom 0 to 13 with no time block", async () => {
    const r = await tiles({});
    expect(r.data.url).toBe("https://storage.googleapis.com/global-surface-water/tiles2021/occurrence/{z}/{x}/{y}.png");
    expect(r.data).toMatchObject({ minzoom: 0, maxzoom: 13, format: "raster" });
    expect(r.data.time).toBeUndefined();
    expect(r.coverageNote).toMatch(/occurrence/i);
  });

  it("builds a URL and a note for every product", async () => {
    for (const product of PRODUCTS) {
      const r = await tiles({ product });
      expect(r.data.url).toBe(waterTileUrl(product));
      expect(r.data.url).toContain(`/tiles2021/${product}/{z}/{x}/{y}.png`);
      expect(r.coverageNote).toBeTruthy();
    }
    expect((await tiles({ product: "change" })).coverageNote).toMatch(/lost.*red/);
  });

  it("rejects an unknown product at the input schema", () => {
    expect(layer.input.safeParse({ product: "extent" }).success).toBe(false);
  });

  it("describes products, the end year, the legend meaning and the user's words", () => {
    for (const word of ["occurrence", "change", "seasonality", "recurrence", "2021", "lake shrink", "30 m"]) {
      expect(layer.description).toContain(word);
    }
    expect(layer.description).toMatch(/compare/);
  });

  it("summarizes to the tile URL for the model", async () => {
    expect(summarizeLayerResult(await layer.query(ctx(vi.fn()), { product: "change" }))).toMatchObject({
      kind: "tiles",
      format: "raster",
      url: expect.stringContaining("/change/"),
    });
  });

  it("draws the JRC colors as served, with a key per product that names them", async () => {
    expect(layer.style.raster).toMatchObject({ saturation: 0 });
    expect(layer.style.raster).not.toHaveProperty("hueRotate");
    expect(legendOf(layer)).toBe(LEGENDS.occurrence);
    for (const p of PRODUCTS) expect(legendProblems(LEGENDS[p], p)).toEqual([]);
    expect(LEGENDS.change.items?.map((i) => [i.label, i.color])).toEqual([
      ["Water lost", "#FF0000"],
      ["No change", "#000000"],
      ["Water gained", "#00FF00"],
    ]);
    expect((await tiles({ product: "change" })).coverageNote).toMatch(/black where water stayed the same/);
    expect((await tiles({})).coverageNote).toMatch(/faint magenta/);
  });

  it("runs through runLayer and rejects a bad product", async () => {
    expect((await runLayer("surface-water", { bbox: SALTON, zoom: 9 })).status).toBe(200);
    expect((await runLayer("surface-water", { bbox: SALTON, input: { product: "wet" } })).status).toBe(400);
  });
});
