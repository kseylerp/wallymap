import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import { tileUrlForTime } from "@/lib/time";
import layer from "./sea-ice";

const ARCTIC: [number, number, number, number] = [-60, 70, 20, 82];

function ctx(stub: ReturnType<typeof vi.fn>) {
  return { bbox: ARCTIC, zoom: 3, env: {}, fetch: stub as unknown as CachedFetch };
}

async function tiles(input: Record<string, unknown>) {
  const stub = vi.fn();
  const r = await layer.query(ctx(stub), layer.input.parse(input));
  expect(stub).not.toHaveBeenCalled();
  if (!("kind" in r) || r.kind !== "tiles") throw new Error(`expected tiles, got ${JSON.stringify(r)}`);
  return r;
}

describe("sea-ice layer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T01:30:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("declares global coverage, no env and no area cap", () => {
    expect(layer.id).toBe("sea-ice");
    expect(layer.coverage).toBe("global");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
  });

  it("defaults to the MUR concentration map 2 days back, not the ended AMSR2 product", async () => {
    const r = await tiles({});
    expect(r.data.url).toBe(
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Ice_Concentration/default/2026-10-07/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png",
    );
    expect(r.data.url).not.toContain("AMSRU2");
    expect(r.data).toMatchObject({ minzoom: 0, maxzoom: 7, format: "raster" });
    expect(r.data.time).toEqual({
      template: expect.stringContaining("/default/{date}/GoogleMapsCompatible_Level7/"),
      cadence: "daily",
      from: "2002-06-01",
      daysBack: 2,
    });
  });

  it("product extent uses the MODIS Terra sea ice map from 2000", async () => {
    const r = await tiles({ product: "extent" });
    expect(r.data.url).toContain("/MODIS_Terra_Sea_Ice/default/2026-10-08/");
    expect(r.data.time).toMatchObject({ from: "2000-02-24", daysBack: 1 });
    expect((await tiles({ product: "extent", date: "2012-09-16" })).data.url).toContain("/default/2012-09-16/");
  });

  it("clamps a date past the newest day and rejects one before the archive", async () => {
    const r = await tiles({ date: "2026-10-09" });
    expect(r.data.url).toContain("/default/2026-10-07/");
    expect(r.coverageNote).toContain("showing 2026-10-07");
    expect(await layer.query(ctx(vi.fn()), { product: "concentration", date: "2002-05-31" })).toMatchObject({ error: expect.stringContaining("2002-06-01") });
    expect(await layer.query(ctx(vi.fn()), { product: "extent", date: "2000-02-23" })).toMatchObject({ error: expect.stringContaining("2000-02-24") });
  });

  it("the scrubber follows the window end", async () => {
    const r = await tiles({});
    expect(tileUrlForTime(r.data.url, r.data.time, ["2010-01-01", "2012-09-16T00:00:00Z"], Date.now())).toContain("/default/2012-09-16/");
  });

  it("rejects an unknown product or a malformed date", () => {
    expect(layer.input.safeParse({ product: "thickness" }).success).toBe(false);
    expect(layer.input.safeParse({ date: "Sept 2012" }).success).toBe(false);
  });

  it("tells the model the products, cadence, how far back and the user's words", () => {
    for (const word of ["daily", "2002", "extent", "concentration", "sea ice", "Northwest Passage", "compare"]) {
      expect(layer.description).toContain(word);
    }
  });

  it("summarizes to the tile URL and time range for the model", async () => {
    expect(summarizeLayerResult(await layer.query(ctx(vi.fn()), { product: "concentration" }))).toMatchObject({
      kind: "tiles",
      time: { cadence: "daily", from: "2002-06-01" },
    });
  });

  it("runs through runLayer", async () => {
    expect((await runLayer("sea-ice", { bbox: ARCTIC, zoom: 3 })).status).toBe(200);
    expect((await runLayer("sea-ice", { bbox: ARCTIC, input: { product: "x" } })).status).toBe(400);
  });
});
