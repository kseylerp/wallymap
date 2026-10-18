import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { quantity } from "@/lib/render/units";
import { legendOf, labelsOf, timeShapeOf } from "./contract";
import layer, { GLOBAL_CSV_URL, MIN_GLOBAL_STATIONS, MIN_STATIONS, parseTrends, parseTrendsCsv, trendFeatures, TRENDS_URL, US_CSV_URL } from "./sea-level-trends";
import fixture from "./__fixtures__/sealvltrends.sample.json";
import inches from "./__fixtures__/sea-level-trends.inches.json";

/** Recorded 2026-10-18 from NOAA's two tables: SF Bay, the Gulf, The Battery, Hawaii, Alaska; Reykjavik and Ny-Alesund. */
const US_CSV = readFileSync(new URL("./__fixtures__/sea-level-trends.us.csv", import.meta.url), "utf8");
const GLOBAL_CSV = readFileSync(new URL("./__fixtures__/sea-level-trends.global.csv", import.meta.url), "utf8");

const SF: [number, number, number, number] = [-123, 37, -122, 38.5];
const GULF: [number, number, number, number] = [-98, 25, -88, 31];

function ctx(stub: ReturnType<typeof vi.fn>, bbox = SF) {
  return { bbox, zoom: 8, env: {}, fetch: stub as unknown as CachedFetch, cacheKey: "sea-level-trends:k" };
}

/** A table padded with stations far south of every test box, so it is as long as NOAA's whole table must be. */
function padded(csv: string, n: number): string {
  const rows = Array.from({ length: n }, (_, i) => `F-${i},"Filler ${i}",1950,2025,76,100,1.0,0.1,0.33,0.03,-85.0,${(i % 300) - 150}`);
  return `${csv.trimEnd()}\n${rows.join("\n")}\n`;
}
const fullUs = padded(US_CSV, MIN_STATIONS);
const fullGlobal = padded(GLOBAL_CSV, MIN_GLOBAL_STATIONS);
const fullInches = {
  ...inches,
  SeaLvlTrends: [
    ...inches.SeaLvlTrends,
    ...Array.from({ length: MIN_STATIONS }, (_, i) => ({ ...inches.SeaLvlTrends[0], stationId: `filler-${i}`, stationName: `Filler ${i}`, latitude: -85, longitude: i - 50 })),
  ],
};

/** A fetch that answers each URL from `routes` (a body, or a status number for a failure). */
function route(routes: Record<string, string | number>) {
  return vi.fn(async (url: string) => {
    const hit = routes[url];
    if (hit === undefined || typeof hit === "number") return new Response("no", { status: typeof hit === "number" ? hit : 404 });
    return new Response(hit, { status: 200 });
  });
}
const tables = () => route({ [US_CSV_URL]: fullUs, [GLOBAL_CSV_URL]: fullGlobal });

describe("sea-level-trends", () => {
  it("reads NOAA's tables in mm/yr with the 95% range and the record years, US and global", () => {
    const us = parseTrendsCsv(US_CSV, "US");
    expect(us).toHaveLength(11);
    expect(us.find((t) => t.stationId === "8779770")).toEqual({
      stationId: "8779770",
      stationName: "Port Isabel, TX",
      affil: "US",
      latitude: 26.0612,
      longitude: -97.2155,
      trend: 4.35,
      ci95: 0.3,
      startYear: 1944,
      endYear: 2025,
    });
    const global = parseTrendsCsv(GLOBAL_CSV, "Global");
    expect(global.map((t) => t.stationName)).toEqual(["Reykjavik, Iceland", "Ny-Alesund, Norway"]);
    expect(global[1].trend).toBe(-5.14);
  });

  it("rejects a table whose trend column is not in mm/yr rather than relabel it", () => {
    const feet = US_CSV.replace("MSL Trends (mm/yr)", "MSL Trends (in/decade)");
    expect(parseTrendsCsv(feet, "US")).toEqual([]);
    expect(parseTrendsCsv("garbage", "US")).toEqual([]);
  });

  it("converts the JSON list's inches per decade to mm/yr (Galveston 2.61 in/decade is 6.63 mm/yr, not 2.61)", () => {
    const rows = parseTrends(inches);
    const galveston = rows.find((t) => t.stationId === "8771450");
    expect(galveston).toMatchObject({ trend: 6.63, startYear: 1904, endYear: 2025 });
    // NOAA's JSON error is a standard error: 0.04 in/decade x 2.54 x 1.96 = 0.2 mm/yr, the table's 95% range (0.21).
    expect(galveston?.ci95).toBe(0.2);
    expect(rows.find((t) => t.stationId === "8771013")?.trend).toBe(12.19);
    expect(rows.find((t) => t.stationId === "9450460")?.trend).toBe(-0.36);
  });

  it("drops JSON rows in a unit it does not know, and keeps mm/yr rows as they are", () => {
    const odd = { SeaLvlTrends: [{ ...inches.SeaLvlTrends[0], trendUnits: "furlongs/fortnight" }, { ...inches.SeaLvlTrends[1], trendUnits: undefined }] };
    expect(parseTrends(odd)).toEqual([]);
    expect(parseTrends(fixture).find((t) => t.stationId === "9414290")?.trend).toBe(1.99);
    expect(parseTrends({ nope: 1 })).toEqual([]);
  });

  it("keeps stations in the bbox, fastest rise first, with mm/yr, its range, years, feet per century and a page link", () => {
    const f = trendFeatures(parseTrendsCsv(US_CSV, "US"), GULF);
    expect(f.map((x) => x.properties?.name)).toEqual(["Eagle Point, TX", "Grand Isle, LA", "Galveston Pier 21, TX", "Port Isabel, TX"]);
    expect(f[0].properties).toMatchObject({ v: 12.19, trendError: 1.33, ftPerCentury: 4, inPerDecade: 4.7992, startYear: 1993, endYear: 2025, kind: "rising" });
    const sf = trendFeatures(parseTrendsCsv(US_CSV, "US"), SF).find((x) => x.properties?.stationId === "9414290");
    expect(sf?.properties).toMatchObject({ v: 1.99, ftPerCentury: 0.65, network: "US", url: "https://tidesandcurrents.noaa.gov/sltrends/sltrends_station.shtml?id=9414290" });
    const reykjavik = trendFeatures(parseTrendsCsv(GLOBAL_CSV, "Global"), [-23, 63, -21, 65])[0];
    expect(reykjavik.properties?.url).toContain("sltrends_global_station.shtml?stnid=010-001");
    expect(reykjavik.properties?.network).toBe("global");
  });

  it("states the per-decade figure from the same number as mm/yr, so 5.76 mm/yr reads 5.76 cm per decade", () => {
    const [eagle] = trendFeatures(parseTrendsCsv(US_CSV, "US"), GULF);
    const at = (trend: number) => trendFeatures([{ ...parseTrendsCsv(US_CSV, "US")[0], trend, latitude: 29, longitude: -95 }], GULF)[0].properties!;
    const perDecade = (trend: number) => quantity(at(trend).inPerDecade as number, "in", { units: "metric" });
    expect(perDecade(5.76)).toMatch(/^5\.76 cm /);
    expect(perDecade(6.62)).toMatch(/^6\.62 cm /);
    expect(perDecade(1.99)).toMatch(/^1\.99 cm /);
    expect(perDecade(12.19)).toMatch(/^12\.2 cm /);
    expect(eagle.properties?.inPerDecade).toBeCloseTo(12.19 / 2.54, 4);
  });

  it("asks for both tables under new cache keys (the old week-long list is never read) and answers the Gulf in mm/yr", async () => {
    const stub = tables();
    const r = await layer.query(ctx(stub, GULF), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features[0].properties).toMatchObject({ name: "Eagle Point, TX", v: 12.19 });
    const calls = stub.mock.calls as unknown as [string, { cacheKey: string; ttlSeconds: number }][];
    expect(calls.map(([url]) => url).sort()).toEqual([GLOBAL_CSV_URL, US_CSV_URL].sort());
    for (const [, init] of calls) {
      expect(init.cacheKey).toMatch(/^sea-level-trends:v2:/);
      expect(init.cacheKey).not.toBe("sea-level-trends:all");
      expect(init.ttlSeconds).toBe(604_800);
    }
    expect(r.sourceStatus).toBeUndefined();
  });

  it("falls back to the JSON list, converted from inches per decade, when the US table fails", async () => {
    const stub = route({ [US_CSV_URL]: 503, [GLOBAL_CSV_URL]: fullGlobal, [TRENDS_URL]: JSON.stringify(fullInches) });
    const r = await layer.query(ctx(stub, GULF), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const eagle = r.data.features.find((f) => f.properties?.stationId === "8771013");
    expect(eagle?.properties?.v).toBe(12.19);
    expect(r.sourceStatus).toEqual({ ok: true });
  });

  it("says when only the US stations could be loaded", async () => {
    const r = await layer.query(ctx(route({ [US_CSV_URL]: fullUs, [GLOBAL_CSV_URL]: 500 }), [-23, 63, -21, 65]), {});
    expect(r).toMatchObject({ kind: "geojson", coverageNote: expect.stringMatching(/international stations could not be loaded/) });
  });

  it("notes an inland view and maps a total failure upstream", async () => {
    const r = await layer.query(ctx(tables(), [-105, 39, -104, 40]), {});
    expect(r).toMatchObject({ kind: "geojson", coverageNote: expect.stringMatching(/No NOAA sea level trend stations/) });
    const down = vi.fn(async () => new Response("no", { status: 503 }));
    expect(await layer.query(ctx(down), {})).toMatchObject({ hint: "upstream" });
  });

  it("treats a JSON list far shorter than NOAA's (one station, 2026-10-17) as no answer", async () => {
    const stub = route({ [US_CSV_URL]: 503, [GLOBAL_CSV_URL]: 503, [TRENDS_URL]: JSON.stringify({ count: 1, SeaLvlTrends: inches.SeaLvlTrends.slice(0, 1) }) });
    expect(await layer.query(ctx(stub), {})).toMatchObject({ error: expect.stringMatching(/did not answer/), hint: "upstream" });
  });

  it("colors stations by trend, names the three fastest, has no time axis and a key in mm/yr", () => {
    expect(layer.style).toMatchObject({ geometry: "point", unit: "mm/yr", encode: { color: "v" } });
    expect(labelsOf(layer)).toEqual({ field: "name", max: 3, rankBy: "v" });
    expect(timeShapeOf(layer).shape).toBe("none");
    expect(legendOf(layer)).toMatchObject({ kind: "ramp", field: "v", unit: "mm/yr" });
    for (const word of ["mm/yr", "relative sea level", "trendError", "sea level", "not a forecast"]) expect(layer.description).toContain(word);
  });

  it("answers a box over 30,000,000 km² with every station in it, fastest rise first, and the count", async () => {
    expect(layer.maxAreaKm2).toBe(30_000_000);
    expect(layer.wide).toEqual({ orderBy: "trend in mm/yr", rank: "fastest-rising", limit: 1000 });
    vi.stubGlobal("fetch", tables());
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
    const r = await layer.query({ ...ctx(tables(), [-180, -80, 180, 80]), wide: true, wideStrategy: { ...layer.wide, limit: 2 } as typeof layer.wide }, {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(2);
    expect(r.data.features[0].properties?.name).toBe("Eagle Point, TX");
    // The fillers sit at 85°S, outside the box: 11 US and 2 global stations.
    expect(r.total).toBe(13);
    expect(r.coverageNote).not.toMatch(/zoom in/);
  });

  it("rejects an oversized bbox through runLayer", async () => {
    expect((await runLayer("sea-level-trends", { bbox: [-180, -80, 180, 80] })).status).toBe(422);
  });
});
