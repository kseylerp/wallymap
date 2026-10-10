import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { countiesUrl, countyOffset, parseCounties, roundedBbox } from "./_shared/counties";
import layer, { anomalyUrl, joinAnomalies, latestCandidates, periodEnd } from "./temperature-anomaly";
import countiesFixture from "./__fixtures__/counties.sfbay.json";
import nceiFixture from "./__fixtures__/ncei-county-tavg.202609-1.json";

/** Recorded 2026-10-10: Esri generalized counties for the SF Bay box; NCEI September 2026 (1 month) trimmed to California plus AL-001 and CT-001. */
const SF: [number, number, number, number] = [-122.7, 37.2, -121.7, 38.2];
const NOW = new Date("2026-10-10T10:00:00Z");
const NOT_PUBLISHED = () => new Response("<!DOCTYPE html><html>not found</html>", { status: 404 });

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function ctx(stub: ReturnType<typeof vi.fn>, bbox = SF) {
  return { bbox, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch, cacheKey: "temperature-anomaly:k" };
}

function routed(published = new Set(["202609"])) {
  return vi.fn(async (url: string) => {
    if (url.includes("USA_Counties")) return json(countiesFixture);
    const period = url.match(/tavg\/(\d{6})\//)?.[1] ?? "";
    return published.has(period) ? json(nceiFixture) : NOT_PUBLISHED();
  });
}

function calls(stub: ReturnType<typeof vi.fn>) {
  return stub.mock.calls as unknown as [string, { cacheKey: string; ttlSeconds: number }][];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("county outlines", () => {
  it("builds a paged, simplified bbox query and parses FIPS", () => {
    const u = new URL(countiesUrl(SF, 1));
    expect(u.searchParams.get("resultOffset")).toBe("2000");
    expect(u.searchParams.get("orderByFields")).toBe("FIPS");
    expect(u.searchParams.get("f")).toBe("geojson");
    expect(countyOffset(SF)).toBe(0.003);
    expect(countyOffset([-125, 24, -66, 50])).toBe(0.02);
    const { counties, more } = parseCounties(countiesFixture);
    expect(counties).toHaveLength(10);
    expect(more).toBe(false);
    expect(counties.find((c) => c.fips === "06075")).toMatchObject({ stateAbbr: "CA", countyFips: "075", name: "San Francisco County" });
    expect(parseCounties({ type: "FeatureCollection", features: [], properties: { exceededTransferLimit: true } }).more).toBe(true);
    expect(roundedBbox([-122.7041, 37.2, -121.6999, 38.20001])).toEqual([-122.71, 37.2, -121.69, 38.21]);
    expect(roundedBbox([-180, -90, 180, 90])).toEqual([-180, -90, 180, 90]);
  });
});

describe("temperature-anomaly", () => {
  it("knows the newest periods and their end dates", () => {
    expect(latestCandidates(NOW.getTime())).toEqual(["202609", "202608"]);
    expect(latestCandidates(Date.parse("2026-01-05T00:00:00Z"))).toEqual(["202512", "202511"]);
    expect(periodEnd("202609")).toBe("2026-09-30T00:00:00.000Z");
    expect(periodEnd("202402")).toBe("2024-02-29T00:00:00.000Z");
    expect(anomalyUrl("202609", 3)).toBe("https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/county/mapping/110/tavg/202609/3/data.json");
  });

  it("joins anomalies to counties by state and county FIPS", () => {
    const { features, unmatched } = joinAnomalies(parseCounties(countiesFixture).counties, nceiFixture, "202609", 1);
    expect(features).toHaveLength(10);
    expect(unmatched).toHaveLength(0);
    const sf = features.find((f) => f.properties?.fips === "06075");
    expect(sf?.properties).toMatchObject({
      name: "San Francisco County",
      v: 1.9,
      kind: "warmer",
      averageF: 63.8,
      normalF: 61.9,
      warmestRank: 25,
      years: 132,
      period: "September 2026",
      t: "2026-09-30T00:00:00.000Z",
    });
    expect(sf?.geometry.type).toMatch(/Polygon/);
  });

  it("uses last month by default, cached a week per period, with outlines cached separately", async () => {
    const stub = routed();
    const r = await layer.query(ctx(stub), layer.input.parse({}));
    if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
    expect(r.data.features).toHaveLength(10);
    expect(r.coverageNote).toContain("September 2026, °F against the 1901-2000 average");
    const c = calls(stub);
    const ncei = c.find(([u]) => u.includes("ncei"));
    expect(ncei?.[1]).toMatchObject({ cacheKey: "temperature-anomaly:202609:1", ttlSeconds: 604_800 });
    const outline = c.find(([u]) => u.includes("USA_Counties"));
    expect(outline?.[1].cacheKey).toBe("counties:v1:-122.70,37.20,-121.70,38.20:0");
    expect(new URL(outline?.[0] ?? "").searchParams.get("geometry")).toBe("-122.7,37.2,-121.7,38.2");
  });

  it("falls back a month when last month is not out yet, and errors for an unpublished period", async () => {
    const stub = routed(new Set(["202608"]));
    const r = await layer.query(ctx(stub), layer.input.parse({ months: 3 }));
    expect(r).toMatchObject({ kind: "geojson" });
    const tried = calls(stub).filter(([u]) => u.includes("ncei")).map(([u]) => u.match(/tavg\/(\d+\/\d+)/)?.[1]);
    expect(tried).toEqual(["202609/3", "202608/3"]);

    const none = await layer.query(ctx(routed(new Set())), layer.input.parse({ period: "202610" }));
    expect(none).toEqual({ error: "NOAA has no county temperatures for 202610 yet" });
  });

  it("notes Connecticut and views with no contiguous-US county", async () => {
    const ct = { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [-73, 41.5] }, properties: { FIPS: "09110", STATE_ABBR: "CT", COUNTY_FIPS: "110", NAME: "Capitol Planning Region" } }] };
    const stub = vi.fn(async (url: string) => (url.includes("USA_Counties") ? json(ct) : json(nceiFixture)));
    const r = await layer.query(ctx(stub, [-73.5, 41, -72, 42]), layer.input.parse({}));
    expect(r).toMatchObject({ kind: "geojson", coverageNote: expect.stringContaining("Connecticut has no county values") });
    const abroad = await layer.query(ctx(vi.fn(), [2, 45, 3, 46]), layer.input.parse({}));
    expect(abroad).toMatchObject({ coverageNote: "No data outside the United States" });
  });

  it("maps upstream failure", async () => {
    const down = vi.fn(async () => new Response("busy", { status: 503 }));
    expect(await layer.query(ctx(down), layer.input.parse({}))).toMatchObject({ hint: "upstream" });
  });

  it("validates inputs and describes the baseline and US-only coverage", async () => {
    expect(layer.input.safeParse({ months: 6 }).success).toBe(false);
    expect(layer.input.safeParse({ period: "2026-09" }).success).toBe(false);
    expect(layer.input.safeParse({ period: "202613" }).success).toBe(false);
    for (const word of ["1901-2000", "contiguous United States", "°F", "warming", "hotter than normal", "temperature anomaly"]) {
      expect(layer.description).toContain(word);
    }
    expect((await runLayer("temperature-anomaly", { bbox: [-170, 10, -50, 75] })).status).toBe(422);
  });
});
