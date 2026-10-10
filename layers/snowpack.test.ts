import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { joinSnotel, snowType, type SnotelData, type SnotelStation } from "./snowpack";
import stationsFixture from "./__fixtures__/snotel-stations.json";
import hourlyFixture from "./__fixtures__/snotel-hourly.tahoe.json";

const stations = stationsFixture as unknown as SnotelStation[];
/** Hourly SNWD, WTEQ and TOBS for the 17 Tahoe stations, recorded 2026-10-10 ~02:15 UTC (no snow yet). */
const hourly = hourlyFixture as unknown as SnotelData[];

const TAHOE: [number, number, number, number] = [-120.6, 38.6, -119.8, 39.3];
const NOW = new Date("2026-10-10T02:15:00Z");

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function routedStub() {
  return vi.fn(async (url: string) => json(url.includes("/stations?") ? stations : hourly));
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

/** One station on Pacific standard time with hourly series given as [local "YYYY-MM-DD HH:mm", value]. */
const BLUE = "356:CA:SNTL";
function row(series: Record<string, [string, number | null][]>): SnotelData[] {
  return [
    {
      stationTriplet: BLUE,
      data: Object.entries(series).map(([elementCode, values]) => ({
        stationElement: { elementCode },
        values: values.map(([date, value]) => ({ date, value })),
      })),
    },
  ];
}
function blue(data: SnotelData[]) {
  return joinSnotel(stations, data, TAHOE, NOW).features.find((f) => f.properties?.name === "Blue Lakes")?.properties;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("snowType", () => {
  it("classes density: powder < 150, settled 150-300, wet/dense > 300", () => {
    expect(snowType(90)).toBe("powder");
    expect(snowType(150)).toBe("settled");
    expect(snowType(300)).toBe("settled");
    expect(snowType(301)).toBe("wet/dense");
  });
});

describe("joinSnotel", () => {
  it("joins the recorded hourly data: depth as v, UTC time from the station clock, no snow yet", () => {
    const fc = joinSnotel(stations, hourly, TAHOE, NOW);
    expect(fc.features).toHaveLength(17);
    const p = fc.features.find((f) => f.properties?.name === "Blue Lakes")?.properties ?? {};
    expect(p).toMatchObject({ stationId: BLUE, elevationFt: 8060, v: 0, type: "no snow" });
    // PST station clock: 18:00 local on Oct 9 is 02:00 UTC on Oct 10.
    expect(p.t).toBe("2026-10-10T02:00:00.000Z");
    expect(typeof p.tempC).toBe("number");
    expect(typeof p.swe).toBe("number");
  });

  it("computes density, type, 24-hour new snow and temperature in °C", () => {
    const p = blue(
      row({
        SNWD: [["2026-10-08 18:00", 30], ["2026-10-09 17:00", 39], ["2026-10-09 18:00", 40]],
        WTEQ: [["2026-10-09 18:00", 9.6]],
        TOBS: [["2026-10-09 18:00", 26.6]],
      }),
    );
    expect(p).toMatchObject({ v: 40, swe: 9.6, density: 240, type: "settled", new24h: 10, tempC: -3 });
    expect(p?.t).toBe("2026-10-10T02:00:00.000Z");
  });

  it("calls light new snow powder and never reports negative new snow", () => {
    const p = blue(
      row({
        SNWD: [["2026-10-08 18:00", 14], ["2026-10-09 18:00", 12]],
        WTEQ: [["2026-10-09 18:00", 1.2]],
      }),
    );
    expect(p).toMatchObject({ density: 100, type: "powder", new24h: 0 });
  });

  it("leaves density and type out under 2 inches or when the sensors disagree", () => {
    expect(blue(row({ SNWD: [["2026-10-09 18:00", 1]], WTEQ: [["2026-10-09 18:00", 0.3]] }))).not.toHaveProperty("type");
    const odd = blue(row({ SNWD: [["2026-10-09 18:00", 3]], WTEQ: [["2026-10-09 18:00", 2.5]] }));
    expect(odd).not.toHaveProperty("density");
    expect(odd).toMatchObject({ v: 3, swe: 2.5 });
  });

  it("keeps a station with no recent reading on the map without v or t", () => {
    expect(blue([])).toEqual({ name: "Blue Lakes", stationId: BLUE, elevationFt: 8060 });
    const stale = blue(row({ SNWD: [["2026-10-01 18:00", 5]] }));
    expect(stale).not.toHaveProperty("v");
  });

  it("keeps only stations inside the bbox", () => {
    const names = joinSnotel(stations, hourly, TAHOE, NOW).features.map((f) => f.properties?.name);
    expect(names).not.toContain("Sonora Pass");
  });
});

describe("snowpack layer", () => {
  it("shares the station list across views and caches each view's hourly call for 15 minutes", async () => {
    const stub = routedStub();
    const r = await layer.query(ctx(stub, "snowpack:k"), {});
    expect(r).toMatchObject({ kind: "geojson" });
    const calls = stub.mock.calls as unknown as [string, { ttlSeconds?: number }][];
    expect(cacheKeys(stub)).toEqual(["snowpack:stations:WTEQ", "snowpack:k:snotel-hourly"]);
    expect(calls[1][1].ttlSeconds).toBe(900);
  });

  it("asks for SNWD, WTEQ and TOBS hourly over a window around now", async () => {
    const stub = routedStub();
    await layer.query(ctx(stub), {});
    const stationsUrl = String(stub.mock.calls[0][0]);
    expect(param(stationsUrl, "stationTriplets")).toBe("*:*:SNTL");
    expect(param(stationsUrl, "activeOnly")).toBe("true");
    const url = String(stub.mock.calls[1][0]);
    expect((param(url, "stationTriplets") ?? "").split(",")).toHaveLength(17);
    expect(param(url, "elements")).toBe("SNWD,WTEQ,TOBS");
    expect(param(url, "duration")).toBe("HOURLY");
    expect(param(url, "beginDate")).toBe("2026-10-08 14:15");
    expect(param(url, "endDate")).toBe("2026-10-10 14:15");
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
    const r = await layer.query(ctx(stub, "snowpack:k"), {});
    const dataCalls = stub.mock.calls.filter((c) => String(c[0]).includes("/data?"));
    expect(dataCalls.map((c) => (param(c[0], "stationTriplets") ?? "").split(",").length)).toEqual([100, 100, 5]);
    const keys = cacheKeys(stub);
    expect(new Set(keys).size).toBe(keys.length);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(205);
  });

  it("covers Alaska too, and nothing in the eastern US or abroad", async () => {
    const stub = routedStub();
    const ak = await layer.query(ctx(stub, undefined, [-146.5, 62.8, -145, 63.6]), {});
    expect(stub).toHaveBeenCalled();
    expect(ak).toMatchObject({ kind: "geojson" });

    const none = vi.fn();
    const east = await layer.query(ctx(none, undefined, [-80, 38, -79, 39]), {});
    expect(east).toMatchObject({ coverageNote: expect.stringMatching(/western United States and Alaska/) });
    const abroad = await layer.query(ctx(none, undefined, [2, 45, 3, 46]), {});
    expect(abroad).toMatchObject({ coverageNote: "No data outside the United States" });
    expect(none).not.toHaveBeenCalled();
  });

  it("returns a note when no stations fall in the bbox, and upstream errors on failure", async () => {
    const empty = vi.fn(async () => json([]));
    expect(await layer.query(ctx(empty), {})).toMatchObject({ coverageNote: expect.stringMatching(/No SNOTEL/) });

    const down = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(await layer.query(ctx(down), {})).toMatchObject({ hint: "upstream" });
    const dataDown = vi.fn(async (url: string) =>
      url.includes("/stations?") ? json(stations) : new Response("nope", { status: 503 }),
    );
    expect(await layer.query(ctx(dataDown), {})).toMatchObject({ hint: "upstream" });
    const notList = vi.fn(async () => json({ message: "bad request" }));
    expect(await layer.query(ctx(notList), {})).toMatchObject({ hint: "upstream" });
  });

  it("describes depth, SWE, density classes, freshness and the user's words", () => {
    for (const word of ["snowpack", "snow depth", "powder", "SWE", "density", "kg/m³", "hourly", "inches", "new24h"]) {
      expect(layer.description).toContain(word);
    }
    expect(layer.style).toMatchObject({ geometry: "point", color: "#3A3A3C", unit: "in" });
    expect(layer.coverage).toBe("us");
    expect(layer.license).toBe("Public domain (USDA NRCS)");
    expect(layer.maxAreaKm2).toBe(400_000);
  });

  it("rejects an oversized bbox through runLayer", async () => {
    const big = await runLayer("snowpack", { bbox: [-125, 31, -110, 49], zoom: 4 });
    expect(big.status).toBe(422);
  });
});
