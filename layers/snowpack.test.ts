import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { joinSnotel, type SnotelData, type SnotelStation } from "./snowpack";
import stationsFixture from "./__fixtures__/snotel-stations.json";
import dataFixture from "./__fixtures__/snotel-data.json";

const stations = stationsFixture as unknown as SnotelStation[];
const data = dataFixture as unknown as SnotelData[];

/** Lake Tahoe area; the fixtures were recorded for this bbox. */
const TAHOE: [number, number, number, number] = [-120.6, 38.6, -119.8, 39.3];
const INPUT = { element: "WTEQ" } as const;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** Answers the station search with the station fixture and the data call with the data fixture. */
function routedStub() {
  return vi.fn(async (url: string) => json(url.includes("/stations?") ? stations : data));
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string, bbox = TAHOE) {
  return { bbox, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

function cacheKeys(stub: ReturnType<typeof vi.fn>): (string | undefined)[] {
  return (stub.mock.calls as unknown as [string, { cacheKey?: string }][]).map((c) => c[1].cacheKey);
}

function param(url: unknown, name: string): string | null {
  return new URL(String(url)).searchParams.get(name);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("joinSnotel", () => {
  it("joins stations to their latest reading by triplet", () => {
    const fc = joinSnotel(stations, data, TAHOE);
    expect(fc.features).toHaveLength(17);
    const blueLakes = fc.features.find((f) => f.properties?.name === "Blue Lakes");
    expect(blueLakes?.geometry).toEqual({ type: "Point", coordinates: [-119.92455, 38.60801] });
    expect(blueLakes?.properties).toEqual({
      name: "Blue Lakes",
      elevationFt: 8060,
      t: "2026-10-08T00:00:00.000Z",
      v: 0,
    });
    const burnside = fc.features.find((f) => f.properties?.name === "Burnside Lake");
    expect(burnside?.properties?.v).toBe(0.1);
  });

  it("keeps only stations inside the bbox", () => {
    const names = joinSnotel(stations, data, TAHOE).features.map((f) => f.properties?.name);
    expect(stations.length).toBeGreaterThan(17);
    expect(names).not.toContain("Sonora Pass");
    expect(joinSnotel(stations, data, [-130, 30, -100, 50]).features.length).toBe(stations.length);
  });

  it("omits v and t for a station missing from the data response", () => {
    const rows = data.filter((d) => d.stationTriplet !== "356:CA:SNTL");
    const blue = joinSnotel(stations, rows, TAHOE).features.find((f) => f.properties?.name === "Blue Lakes");
    expect(blue).toBeDefined();
    expect(blue?.properties).toEqual({ name: "Blue Lakes", elevationFt: 8060 });
  });

  it("omits v and t for a station whose values are empty", () => {
    const rows: SnotelData[] = [{ stationTriplet: "356:CA:SNTL", data: [{ stationElement: {}, values: [] }] }];
    const blue = joinSnotel(stations, rows, TAHOE).features.find((f) => f.properties?.name === "Blue Lakes");
    expect(blue?.properties).toEqual({ name: "Blue Lakes", elevationFt: 8060 });
  });

  it("uses the newest date when several days come back and skips null values", () => {
    const rows: SnotelData[] = [
      {
        stationTriplet: "356:CA:SNTL",
        data: [
          {
            stationElement: {},
            values: [
              { date: "2026-10-07", value: 1.5 },
              { date: "2026-10-09", value: null },
              { date: "2026-10-08", value: 2.5 },
            ],
          },
        ],
      },
    ];
    const blue = joinSnotel(stations, rows, TAHOE).features.find((f) => f.properties?.name === "Blue Lakes");
    expect(blue?.properties).toMatchObject({ v: 2.5, t: "2026-10-08T00:00:00.000Z" });
  });
});

describe("snowpack layer", () => {
  it("makes two upstream calls with distinct cache suffixes", async () => {
    const stub = routedStub();
    const r = await layer.query(ctx(stub, "snowpack:k"), INPUT);
    expect(r).toMatchObject({ kind: "geojson" });
    expect(stub).toHaveBeenCalledTimes(2);
    const keys = cacheKeys(stub);
    expect(keys[0]).toBeDefined();
    expect(keys[1]).toBeDefined();
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[1]).toBe("snowpack:k:snotel-data");
  });

  it("searches every active SNOTEL station with the element and filters by bbox itself", async () => {
    const stub = routedStub();
    await layer.query(ctx(stub), INPUT);
    const url = String(stub.mock.calls[0][0]);
    expect(url).toContain("https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/stations?");
    expect(param(url, "stationTriplets")).toBe("*:*:SNTL");
    expect(param(url, "elements")).toBe("WTEQ");
    expect(param(url, "durations")).toBe("DAILY");
    expect(param(url, "activeOnly")).toBe("true");
    expect(url).not.toContain("minLatitude");
  });

  it("asks for the in-bbox triplets, the element and a three-day window ending today", async () => {
    const stub = routedStub();
    await layer.query(ctx(stub), { element: "SNWD" });
    const url = String(stub.mock.calls[1][0]);
    expect(url).toContain("/v1/data?");
    const triplets = param(url, "stationTriplets")?.split(",") ?? [];
    expect(triplets).toHaveLength(17);
    expect(triplets).toContain("356:CA:SNTL");
    expect(triplets).not.toContain("301:CA:SNTL");
    expect(param(url, "elements")).toBe("SNWD");
    expect(param(url, "duration")).toBe("DAILY");
    expect(param(url, "beginDate")).toBe("2026-10-06");
    expect(param(url, "endDate")).toBe("2026-10-09");
    expect(param(url, "returnFlags")).toBe("false");
  });

  it("batches data calls 100 stations at a time", async () => {
    const many: SnotelStation[] = Array.from({ length: 205 }, (_, i) => ({
      stationTriplet: `${i}:CA:SNTL`,
      name: `Station ${i}`,
      elevation: 5000,
      latitude: 39,
      longitude: -120,
    }));
    const stub = vi.fn(async (url: string) => json(url.includes("/stations?") ? many : []));
    const r = await layer.query(ctx(stub, "snowpack:k"), INPUT);
    expect(r).toMatchObject({ kind: "geojson" });
    const dataCalls = stub.mock.calls.filter((c) => String(c[0]).includes("/data?"));
    expect(dataCalls.map((c) => (param(c[0], "stationTriplets") ?? "").split(",").length)).toEqual([100, 100, 5]);
    const keys = cacheKeys(stub);
    expect(new Set(keys).size).toBe(keys.length);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(205);
    expect(r.data.features.every((f) => !("v" in (f.properties ?? {})))).toBe(true);
  });

  it("returns a cited FeatureCollection of points with t and v", async () => {
    const r = await layer.query(ctx(routedStub()), INPUT);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(17);
    expect(r.data.features.every((f) => f.geometry.type === "Point")).toBe(true);
    expect(r.citation.source).toContain("NRCS");
  });

  it("returns an empty collection with a note when no stations fall in the bbox", async () => {
    const stub = vi.fn(async () => json([]));
    const r = await layer.query(ctx(stub), INPUT);
    expect(stub).toHaveBeenCalledTimes(1);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toMatch(/No SNOTEL stations/);
  });

  it("returns a coverage note without calling upstream outside the United States", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub, undefined, [2, 45, 3, 46]), INPUT);
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toBe("No data outside the United States");
  });

  it("returns a coverage note without calling upstream in the eastern United States", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub, undefined, [-80, 38, -79, 39]), INPUT);
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toMatch(/western United States/);
  });

  it("maps a failed station search or data call to an upstream error", async () => {
    const down = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(await layer.query(ctx(down), INPUT)).toMatchObject({ hint: "upstream" });

    const dataDown = vi.fn(async (url: string) =>
      url.includes("/stations?") ? json(stations) : new Response("nope", { status: 503 }),
    );
    expect(await layer.query(ctx(dataDown), INPUT)).toMatchObject({ hint: "upstream" });
  });

  it("maps a non-array body to an upstream error", async () => {
    const stub = vi.fn(async () => json({ message: "bad request" }));
    expect(await layer.query(ctx(stub), INPUT)).toMatchObject({ hint: "upstream" });
  });

  it("states what the number means and how fresh it is", () => {
    expect(layer.description).toMatch(/snow water equivalent/i);
    expect(layer.description).toMatch(/daily/i);
    expect(layer.description).toMatch(/inches/i);
    expect(layer.style).toEqual({ geometry: "point", color: "#5B6B7A", unit: "in" });
    expect(layer.coverage).toEqual({ bbox: [-125, 31, -102, 49] });
    expect(layer.license).toBe("Public domain (USDA NRCS)");
    expect(layer.maxAreaKm2).toBe(400_000);
  });

  it("rejects an oversized bbox and bad input through runLayer", async () => {
    const big = await runLayer("snowpack", { bbox: [-125, 31, -110, 49], zoom: 4 });
    expect(big.status).toBe(422);
    const bad = await runLayer("snowpack", { bbox: TAHOE, input: { element: "TMAX" } });
    expect(bad.status).toBe(400);
  });
});
