import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import layer, { NLCD_CLASSES, NLCD_YEARS, WORLDCOVER_URL, nlcdEpoch, nlcdTileUrl } from "./land-cover";
import { contractProblems, legendOf, timeShapeOf } from "./contract";

const PNW: [number, number, number, number] = [-123, 44, -121, 46];

function ctx(stub: ReturnType<typeof vi.fn>) {
  return { bbox: PNW, zoom: 8, env: {}, fetch: stub as unknown as CachedFetch };
}

async function tiles(input: Record<string, unknown>) {
  const stub = vi.fn();
  const r = await layer.query(ctx(stub), layer.input.parse(input));
  expect(stub).not.toHaveBeenCalled();
  if (!("kind" in r) || r.kind !== "tiles") throw new Error(`expected tiles, got ${JSON.stringify(r)}`);
  return r;
}

describe("land-cover layer", () => {
  it("declares global coverage, no env and no area cap", () => {
    expect(layer.id).toBe("land-cover");
    expect(layer.coverage).toBe("global");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
  });

  it("defaults to the static WorldCover 2021 tiles, with no time block", async () => {
    const r = await tiles({});
    expect(r.data.url).toBe(WORLDCOVER_URL);
    expect(r.data.url).toContain("layer=esa-worldcover-map-10m-2021-v2_map");
    expect(r.data.url).toContain("tilematrixset=EPSG:3857&tilematrix={z}&tilerow={y}&tilecol={x}");
    expect(r.data).toMatchObject({ minzoom: 0, maxzoom: 14, format: "raster" });
    expect(r.data.time).toBeUndefined();
    expect(r.coverageNote).toMatch(/WorldCover 2021/);
    expect(r.citation.source).toMatch(/CC BY 4.0/);
    expect(r.citation.source).toMatch(/Copernicus Sentinel data/);
  });

  it("nlcd: true draws the 2021 NLCD map through WMS with the bbox placeholder", async () => {
    const r = await tiles({ nlcd: true });
    expect(r.data.url).toBe(nlcdTileUrl(2021));
    expect(r.data.url).toContain("https://www.mrlc.gov/geoserver/mrlc_display/wms?service=WMS&version=1.1.1&request=GetMap&layers=NLCD_2021_Land_Cover_L48");
    expect(r.data.url).toContain("srs=EPSG:3857");
    expect(r.data.url).toContain("bbox={bbox-epsg-3857}");
    expect(r.data.time).toBeUndefined();
    expect(r.coverageNote).toMatch(/NLCD 2021/);
    expect(r.coverageNote).toMatch(/lower 48/);
  });

  it("snaps a year between epochs to the one at or before it and says so", async () => {
    const r = await tiles({ nlcd: true, year: 2015 });
    expect(r.data.url).toContain("layers=NLCD_2013_Land_Cover_L48");
    expect(r.coverageNote).toContain("NLCD 2013");
    expect(r.coverageNote).toContain("2015");
    const exact = await tiles({ nlcd: true, year: 2016 });
    expect(exact.data.url).toContain("NLCD_2016_Land_Cover_L48");
    expect(exact.coverageNote).not.toContain("nearest");
  });

  it("uses the last epoch for a year after it and errors before 2001", async () => {
    expect((await tiles({ nlcd: true, year: 2030 })).data.url).toContain("NLCD_2021_Land_Cover_L48");
    expect(await layer.query(ctx(vi.fn()), { nlcd: true, year: 1990 })).toMatchObject({ error: expect.stringContaining("2001") });
  });

  it("explains that year needs nlcd", async () => {
    expect(await layer.query(ctx(vi.fn()), { nlcd: false, year: 2019 })).toMatchObject({ error: expect.stringContaining("nlcd") });
  });

  it("epoch helper", () => {
    expect(nlcdEpoch(2000)).toBeNull();
    expect(nlcdEpoch(2001)).toBe(2001);
    expect(nlcdEpoch(2005)).toBe(2004);
    expect(NLCD_YEARS).toHaveLength(9);
  });

  it("tells the model both products, the years, the caveats and the user's words", () => {
    expect(layer.description).toMatch(/WorldCover/);
    expect(layer.description).toMatch(/NLCD|National Land Cover/);
    expect(layer.description).toMatch(/2001, 2004, 2006/);
    expect(layer.description).toContain("forest vs grassland");
    expect(layer.description).toContain("land cover");
  });

  it("summarizes to the tile URL for the model", async () => {
    expect(summarizeLayerResult(await layer.query(ctx(vi.fn()), { nlcd: false }))).toMatchObject({ kind: "tiles", format: "raster", maxzoom: 14 });
  });

  it("runs through runLayer", async () => {
    expect((await runLayer("land-cover", { bbox: PNW, zoom: 8 })).status).toBe(200);
    expect((await runLayer("land-cover", { bbox: PNW, input: { nlcd: "yes" } })).status).toBe(400);
  });

  it("keys the map with WorldCover's class colors and lets NLCD step and swipe between its nine years", async () => {
    const legend = legendOf(layer);
    expect(legend).toMatchObject({ kind: "categories" });
    expect(legend.items?.[0]).toEqual({ label: "Tree cover", value: 10, color: "#006400", symbol: "raster" });
    expect(legend.items?.map((i) => i.label)).toContain("Cropland");
    expect(NLCD_CLASSES.find((c) => c.value === 42)?.color).toBe("#1C5F2C");
    const r = await layer.query({ bbox: [-123, 45.3, -122.3, 45.8], zoom: 9, env: {}, fetch: (() => Promise.reject(new Error("no call"))) as never }, { nlcd: true, year: 2016 });
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.data.scenario).toMatchObject({ param: "year", values: [2001, 2004, 2006, 2008, 2011, 2013, 2016, 2019, 2021] });
    // The scenario template fills to the very URL each year's call returns.
    expect(r.data.scenario?.template.replace("{value}", "2016")).toBe(r.data.url);
    expect(r.data.scenario?.template.replace("{value}", "2001")).toBe(nlcdTileUrl(2001));
    expect(timeShapeOf(layer)).toEqual({ shape: "single", dates: ["2021"] });
    expect(contractProblems(layer)).toEqual([]);
  });
});
