import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { parseTrends, trendFeatures, TRENDS_URL } from "./sea-level-trends";
import fixture from "./__fixtures__/sealvltrends.sample.json";

/** Recorded 2026-10-10: the SF Bay stations plus Nawiliwili, The Battery and Reykjavik, seasonal cycles stripped. */
const SF: [number, number, number, number] = [-123, 37, -122, 38.5];

function ctx(stub: ReturnType<typeof vi.fn>, bbox = SF) {
  return { bbox, zoom: 8, env: {}, fetch: stub as unknown as CachedFetch, cacheKey: "sea-level-trends:k" };
}

const ok = () => vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));

describe("sea-level-trends", () => {
  it("parses US and global stations", () => {
    const trends = parseTrends(fixture);
    expect(trends).toHaveLength(9);
    expect(trends.find((t) => t.stationId === "010-001")?.affil).toBe("Global");
    expect(parseTrends({ nope: 1 })).toEqual([]);
  });

  it("keeps stations in the bbox, fastest rise first, with mm/yr, error, years and a page link", () => {
    const f = trendFeatures(parseTrends(fixture), SF);
    expect(f).toHaveLength(6);
    expect(f[0].properties).toMatchObject({ name: "Richmond", v: 3.35, trendError: 0.72, startYear: 1979, endYear: 2025, kind: "rising" });
    const sf = f.find((x) => x.properties?.stationId === "9414290");
    expect(sf?.properties).toMatchObject({
      v: 1.99,
      startYear: 1897,
      annotation: "Possible datum shift",
      network: "US",
      ftPerCentury: 0.65,
      url: "https://tidesandcurrents.noaa.gov/sltrends/sltrends_station.shtml?id=9414290",
    });
    const reykjavik = trendFeatures(parseTrends(fixture), [-23, 63, -21, 65])[0];
    expect(reykjavik.properties?.url).toContain("sltrends_global_station.shtml?stnid=010-001");
    expect(reykjavik.properties?.network).toBe("global");
  });

  it("asks once for every station in metric units, cached a week under one shared key", async () => {
    const stub = ok();
    const r = await layer.query(ctx(stub), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(6);
    const [url, init] = stub.mock.calls[0] as unknown as [string, { cacheKey: string; ttlSeconds: number }];
    expect(url).toBe(TRENDS_URL);
    expect(url).toContain("units=metric");
    expect(init).toMatchObject({ cacheKey: "sea-level-trends:all", ttlSeconds: 604_800 });
  });

  it("notes an inland view and maps upstream failure", async () => {
    const r = await layer.query(ctx(ok(), [-105, 39, -104, 40]), {});
    expect(r).toMatchObject({ kind: "geojson", coverageNote: expect.stringMatching(/No NOAA sea level trend stations/) });
    const down = vi.fn(async () => new Response("no", { status: 503 }));
    expect(await layer.query(ctx(down), {})).toMatchObject({ hint: "upstream" });
  });

  it("describes the unit and its meaning for the model", () => {
    for (const word of ["mm/yr", "relative sea level", "trendError", "sea level", "not a forecast"]) expect(layer.description).toContain(word);
    expect(layer.style).toMatchObject({ geometry: "point", unit: "mm/yr" });
  });

  it("answers a box over 30,000,000 km² with every station in it, fastest rise first, and the count", async () => {
    expect(layer.maxAreaKm2).toBe(30_000_000);
    expect(layer.wide).toEqual({ orderBy: "trend in mm/yr", rank: "fastest-rising", limit: 1000 });
    const stub = ok();
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("sea-level-trends", { bbox: [-170, 0, -50, 70], zoom: 2 });
      expect(res.status).toBe(200);
      if (!("data" in res.body) || res.body.kind !== "geojson") throw new Error("expected geojson");
      const rates = res.body.data.features.map((f) => Number(f.properties?.v));
      expect(rates).toEqual([...rates].sort((a, b) => b - a));
      expect(res.body).toMatchObject({ total: rates.length, coverageNote: expect.stringMatching(/^Showing all \d+ in this wide view \(ranked by trend in mm\/yr\); Measured/) });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("cuts a wide answer at the strategy's limit, keeping the fastest-rising, with no note of its own about the cut", async () => {
    const r = await layer.query({ ...ctx(ok(), [-180, -80, 180, 80]), wide: true, wideStrategy: { ...layer.wide, limit: 2 } as typeof layer.wide }, {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(2);
    expect(r.total).toBe(9);
    expect(r.coverageNote).not.toMatch(/zoom in/);
  });

  it("rejects an oversized bbox through runLayer", async () => {
    expect((await runLayer("sea-level-trends", { bbox: [-180, -80, 180, 80] })).status).toBe(422);
  });
});
