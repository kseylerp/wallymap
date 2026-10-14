import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { MAX_USBR_SITES, SITES, buildSeries, cdecDate, parseCdec, parseUsbrRows } from "./reservoir-levels";

/**
 * Fixtures were recorded from the live services on 2026-10-10: the last 12,000 bytes of the Powell and Mead elevation and
 * storage files (a Range request, so each starts mid-row), and CDEC daily and monthly storage for Hetch Hetchy and Shasta.
 */
const fx = (name: string) => readFileSync(new URL(`./__fixtures__/reservoir-levels.${name}`, import.meta.url), "utf8");
const powellElevation = fx("usbr-919-49.txt");
const powellStorage = fx("usbr-919-17.txt");
const meadElevation = fx("usbr-921-49.txt");
const meadStorage = fx("usbr-921-17.txt");
const cdecDaily = fx("cdec-daily.json");
const cdecMonthly = fx("cdec-monthly.json");

const WEST: [number, number, number, number] = [-124, 32, -104, 43];
const POWELL_VIEW: [number, number, number, number] = [-112, 36, -111, 37.5];

type Call = [string, RequestInit & { cacheKey?: string; ttlSeconds?: number }];

/** Answers by URL, the way the three upstream hosts would. */
function upstream(overrides: Partial<Record<string, () => Response>> = {}) {
  return vi.fn(async (url: string) => {
    for (const [fragment, make] of Object.entries(overrides)) if (make && url.includes(fragment)) return make();
    const body = (text: string) => new Response(text, { status: 206 });
    if (url.includes("/919/json/49")) return body(powellElevation);
    if (url.includes("/919/json/17")) return body(powellStorage);
    if (url.includes("/921/json/49")) return body(meadElevation);
    if (url.includes("/921/json/17")) return body(meadStorage);
    if (url.includes("dur_code=D")) return new Response(cdecDaily);
    if (url.includes("dur_code=M")) return new Response(cdecMonthly);
    return new Response("not found", { status: 404 });
  });
}

function ctx(stub: ReturnType<typeof vi.fn>, bbox = POWELL_VIEW, cacheKey?: string) {
  return { bbox, zoom: 8, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

function geojson(r: Awaited<ReturnType<typeof layer.query>>) {
  if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
  return r;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("parsing", () => {
  it("reads daily rows out of a file tail that starts mid-row", () => {
    const rows = parseUsbrRows(powellElevation);
    expect(rows.length).toBeGreaterThan(400);
    expect(rows.at(-1)).toEqual({ date: "2026-10-08", value: 3519.03 });
    expect(parseUsbrRows('x":1],["2026-01-01",null],["2026-01-02",12.5],["2026-01-03",-3]')).toEqual([
      { date: "2026-01-02", value: 12.5 },
      { date: "2026-01-03", value: -3 },
    ]);
  });

  it("pads CDEC dates and drops -9999 and null readings", () => {
    expect(cdecDate("2026-10-1 00:00")).toBe("2026-10-01");
    expect(cdecDate("junk")).toBeNull();
    const parsed = parseCdec(JSON.parse(cdecDaily));
    expect(parsed?.get("HTH")?.at(-1)).toEqual({ date: "2026-10-08", value: 280357 });
    expect(parsed?.get("HTH")?.some((r) => r.value < 0)).toBe(false);
    expect(parseCdec({ not: "an array" })).toBeNull();
  });

  it("averages by month for short spans and by year for long ones", () => {
    const rows = [
      { date: "2025-01-10", value: 10 },
      { date: "2025-01-20", value: 20 },
      { date: "2025-02-05", value: 30 },
      { date: "2024-06-01", value: 100 },
    ];
    expect(buildSeries(rows, "2025-01-01", 2, 1)).toEqual([
      { t: "2025-01", v: 15 },
      { t: "2025-02", v: 30 },
    ]);
    expect(buildSeries(rows, "2020-01-01", 20, 1)).toEqual([
      { t: "2024", v: 100 },
      { t: "2025", v: 20 },
    ]);
  });
});

describe("reservoir-levels layer", () => {
  it("declares western coverage, a public-domain license, no env and a years and name input", () => {
    expect(layer.id).toBe("reservoir-levels");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.license).toContain("Public domain");
    expect(layer.maxAreaKm2).toBe(3_000_000);
    expect(layer.wide).toEqual({ orderBy: "storage in acre-feet", limit: 1000 });
    expect(layer.input.parse({})).toEqual({ years: 5 });
    expect(layer.input.safeParse({ years: 61 }).success).toBe(false);
    expect(layer.style).toMatchObject({ geometry: "point", unit: "acre-feet", extrude: "v" });
    expect(layer.description).toMatch(/provisional/i);
  });

  it("gives Lake Powell its elevation, storage, percent full, date and a monthly series", async () => {
    const stub = upstream();
    const r = geojson(await layer.query(ctx(stub, POWELL_VIEW, "reservoir-levels:k"), { years: 1 }));
    const powell = r.data.features.find((f) => f.properties?.name === "Lake Powell");
    expect(powell?.geometry).toEqual({ type: "Point", coordinates: [-111.48396, 36.93649] });
    expect(powell?.properties).toMatchObject({
      v: 5207553,
      storageAf: 5207553,
      elevationFt: 3519.03,
      capacityAf: 23_314_000,
      pctFull: 22,
      lastDate: "2026-10-08",
      t: "2026-10-08T00:00:00.000Z",
      river: "Colorado River",
      seriesUnit: "ft",
    });
    const series = powell?.properties?.series as { t: string; v: number }[];
    expect(series.length).toBeGreaterThanOrEqual(10);
    expect(series.length).toBeLessThanOrEqual(13);
    expect(series.at(-1)).toEqual({ t: "2026-10", v: expect.any(Number) });
    expect(series[0].t >= "2025-10").toBe(true);
    expect(r.coverageNote).toMatch(/Provisional/);
    expect(r.citation.source).toMatch(/Reclamation/);
  });

  it("asks the Reclamation file for its tail only, caches 6 hours, and keys each file separately", async () => {
    const stub = upstream();
    await layer.query(ctx(stub, POWELL_VIEW, "reservoir-levels:k"), { years: 5, name: "powell" });
    const calls = stub.mock.calls as unknown as Call[];
    expect(calls).toHaveLength(2);
    const urls = calls.map((c) => c[0]).sort();
    expect(urls).toEqual([
      "https://www.usbr.gov/uc/water/hydrodata/reservoir_data/919/json/17.json",
      "https://www.usbr.gov/uc/water/hydrodata/reservoir_data/919/json/49.json",
    ]);
    for (const [, init] of calls) {
      expect(String((init.headers as Record<string, string>).range)).toMatch(/^bytes=-\d+$/);
      expect(init.ttlSeconds).toBe(21_600);
    }
    expect(new Set(calls.map((c) => c[1].cacheKey)).size).toBe(2);
  });

  it("reads California reservoirs from CDEC in one daily and one monthly call", async () => {
    const stub = upstream();
    const view: [number, number, number, number] = [-120.2, 37.5, -119.5, 38.2];
    const r = geojson(await layer.query(ctx(stub, view), { years: 2, name: "hetch" }));
    const calls = stub.mock.calls as unknown as Call[];
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toContain("Stations=HTH&SensorNums=15&dur_code=D&Start=2026-09-28&End=2026-10-10");
    expect(calls[1][0]).toContain("dur_code=M&Start=2024-10-01&End=2026-10-10");
    const hetch = r.data.features[0];
    expect(hetch.properties).toMatchObject({
      name: "Hetch Hetchy Reservoir",
      v: 280357,
      capacityAf: 360_000,
      pctFull: 78,
      lastDate: "2026-10-08",
      seriesUnit: "acre-feet",
      source: "California DWR (CDEC)",
    });
    expect(hetch.properties).not.toHaveProperty("elevationFt");
    const series = hetch.properties?.series as { t: string; v: number }[];
    expect(series.every((p) => /^\d{4}-\d{2}$/.test(p.t))).toBe(true);
    expect(series.some((p) => p.v < 0)).toBe(false);
  });

  it("returns Powell and Mead together over the Colorado, largest storage first, and caps Reclamation sites", async () => {
    const stub = upstream();
    const colorado: [number, number, number, number] = [-115.5, 35, -110.5, 37.5];
    const r = geojson(await layer.query(ctx(stub, colorado), { years: 1 }));
    expect(r.data.features.map((f) => f.properties?.name)).toEqual(["Lake Mead", "Lake Powell"]);
    expect(r.data.features[0].properties).toMatchObject({ elevationFt: 1037.61, pctFull: 26 });

    const wide = upstream();
    const west = geojson(await layer.query(ctx(wide, WEST), { years: 1 }));
    const usbrCalls = (wide.mock.calls as unknown as Call[]).filter((c) => c[0].includes("usbr.gov"));
    expect(usbrCalls.length).toBe(MAX_USBR_SITES * 2);
    expect(west.coverageNote).toMatch(/largest of \d+ Reclamation reservoirs/);
  });

  it("in a wide view keeps the Reclamation cap, gives every covered reservoir in the box as the total, and drops the zoom hint", async () => {
    const stub = upstream();
    const r = geojson(await layer.query({ ...ctx(stub, WEST), wide: true, wideStrategy: layer.wide }, { years: 1 }));
    const usbrCalls = (stub.mock.calls as unknown as Call[]).filter((c) => c[0].includes("usbr.gov"));
    expect(usbrCalls.length).toBe(MAX_USBR_SITES * 2);
    expect(r.total).toBe(SITES.length);
    expect(r.coverageNote).toContain("At most 6 Reclamation reservoirs (the largest) per request; set name for the others");
    expect(r.coverageNote).not.toMatch(/zoom in/);
    const powell = geojson(await layer.query({ ...ctx(upstream(), POWELL_VIEW), wide: true, wideStrategy: layer.wide }, { years: 1 }));
    expect(powell.total).toBeUndefined();
  });

  it("notes a reservoir whose files fail and keeps the rest", async () => {
    const stub = upstream({ "/921/": () => new Response("down", { status: 500 }) });
    const r = geojson(await layer.query(ctx(stub, [-115.5, 35, -110.5, 37.5]), { years: 1 }));
    expect(r.data.features.map((f) => f.properties?.name)).toEqual(["Lake Powell"]);
    expect(r.coverageNote).toContain("No reading from Lake Mead");
  });

  it("returns an upstream error when nothing answers, and notes empty or out-of-range views", async () => {
    const down = vi.fn(async () => new Response("down", { status: 503 }));
    expect(await layer.query(ctx(down, POWELL_VIEW), { years: 1 })).toEqual({
      error: "Reservoir data services returned no readings; try again shortly",
      hint: "upstream",
    });
    const quiet = upstream();
    const nothing = geojson(await layer.query(ctx(quiet, [-108, 34, -107.5, 34.5]), { years: 1 }));
    expect(nothing.data.features).toEqual([]);
    expect(nothing.coverageNote).toMatch(/No major reservoir/);
    const named = geojson(await layer.query(ctx(quiet, WEST), { years: 1, name: "zzz" }));
    expect(named.coverageNote).toContain("No reservoir named like 'zzz'");
    expect(quiet).not.toHaveBeenCalled();
    const europe = geojson(await layer.query(ctx(quiet, [5, 45, 6, 46]), { years: 1 }));
    expect(europe.coverageNote).toMatch(/western United States only/);
  });

  it("uses the official capacities, and gives no percent for Reclamation sites without an official figure", () => {
    const cap = (id: string) => SITES.find((s) => s.id === id)?.capacityAf;
    expect([cap("usbr-919"), cap("usbr-921"), cap("usbr-922"), cap("usbr-923")]).toEqual([23_314_000, 26_120_000, 1_873_648, 570_253]);
    expect([cap("cdec-ORO"), cap("cdec-HTH"), cap("cdec-SHA"), cap("cdec-EXC")]).toEqual([3_424_753, 360_000, 4_552_000, 1_024_600]);
    const gorge = SITES.find((s) => s.id === "usbr-917");
    expect(gorge?.capacityAf).toBeUndefined();
    expect(gorge?.sizeAf).toBeGreaterThan(3_000_000);
    expect(layer.description).toMatch(/live storage/);
    expect(layer.description).not.toMatch(/dead pool/);
  });

  it("knows each site once, inside the west, with a source code", () => {
    expect(new Set(SITES.map((s) => s.id)).size).toBe(SITES.length);
    for (const s of SITES) {
      expect(s.coordinates[0]).toBeGreaterThan(-124);
      expect(s.coordinates[0]).toBeLessThan(-104);
      expect(s.coordinates[1]).toBeGreaterThan(32);
      expect(s.coordinates[1]).toBeLessThan(44);
      expect(s.id).toBe(`${s.source}-${s.code}`);
    }
  });

  it("is registered and rejects an oversized area and a bad years value through runLayer", async () => {
    expect((await runLayer("reservoir-levels", { bbox: [-170, 10, -60, 70] })).status).toBe(422);
    expect((await runLayer("reservoir-levels", { bbox: POWELL_VIEW, input: { years: 0 } })).status).toBe(400);
  });
});
