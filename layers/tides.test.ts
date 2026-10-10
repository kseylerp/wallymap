import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, {
  MAX_STATIONS,
  observedLevel,
  parseStations,
  pickStations,
  tideFeature,
  upcomingEvents,
} from "./tides";
import stationsFixture from "./__fixtures__/coops-stations.sf.json";
import waterlevelsFixture from "./__fixtures__/coops-waterlevels.sf.json";
import hiloFixture from "./__fixtures__/coops-hilo.9414290.json";
import wlFixture from "./__fixtures__/coops-wl.9414290.json";

/** Recorded 2026-10-10 ~02:20 UTC. Station lists trimmed to the SF box plus The Battery (NY) to test the filter. */
const SF: [number, number, number, number] = [-122.7, 37.6, -122.2, 38.0];
const NOW = new Date("2026-10-10T02:15:00Z");
const NO_DATA = { error: { message: "No data was found. This product may not be offered at this station at the requested time." } };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function routedStub() {
  return vi.fn(async (url: string) => {
    if (url.includes("type=tidepredictions")) return json(stationsFixture);
    if (url.includes("type=waterlevels")) return json(waterlevelsFixture);
    if (url.includes("product=water_level")) return url.includes("station=9414290&") ? json(wlFixture) : json(NO_DATA);
    return json(hiloFixture);
  });
}

function ctx(stub: ReturnType<typeof vi.fn>, bbox = SF) {
  return { bbox, zoom: 10, env: {}, fetch: stub as unknown as CachedFetch, cacheKey: "tides:k" };
}

function calls(stub: ReturnType<typeof vi.fn>) {
  return stub.mock.calls as unknown as [string, { cacheKey?: string; ttlSeconds?: number; shouldCache?: unknown }][];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("parsing", () => {
  it("parses station lists and picks live gauges first, capped", () => {
    const stations = parseStations(stationsFixture);
    expect(stations.length).toBe(39);
    const live = new Set(parseStations(waterlevelsFixture).map((s) => s.id));
    expect(live.has("9414290")).toBe(true);
    const picked = pickStations(stations, live, SF);
    expect(picked).toHaveLength(MAX_STATIONS);
    expect(picked.slice(0, 3).every((s) => live.has(s.id))).toBe(true);
    expect(picked.map((s) => s.id)).not.toContain("8518750");
  });

  it("lists upcoming highs and lows soonest first, in feet and UTC", () => {
    const events = upcomingEvents(hiloFixture, NOW);
    expect(events[0]).toEqual({ time: Date.parse("2026-10-10T06:49:00Z"), height: 5.265, type: "high" });
    expect(events[1].type).toBe("low");
    expect(upcomingEvents(hiloFixture, new Date("2026-10-10T07:00:00Z"))[0].type).toBe("low");
    expect(upcomingEvents(NO_DATA, NOW)).toEqual([]);
  });

  it("reads the latest water level and ignores errors and stale readings", () => {
    expect(observedLevel(wlFixture, NOW)).toEqual({ time: Date.parse("2026-10-10T02:06:00Z"), height: 2.495 });
    expect(observedLevel(NO_DATA, NOW)).toBeUndefined();
    expect(observedLevel(wlFixture, new Date("2026-10-10T08:00:00Z"))).toBeUndefined();
  });

  it("builds a point with next and following tide, upcoming text and observedNow", () => {
    const station = parseStations(stationsFixture).find((s) => s.id === "9414290")!;
    const f = tideFeature(station, upcomingEvents(hiloFixture, NOW), observedLevel(wlFixture, NOW));
    expect(f?.properties).toMatchObject({
      stationId: "9414290",
      kind: "high",
      nextType: "high",
      t: "2026-10-10T06:49:00.000Z",
      v: 5.265,
      thenType: "low",
      thenT: "2026-10-10T12:19:00.000Z",
      thenV: 1.22,
      observedNow: 2.495,
      observedAt: "2026-10-10T02:06:00.000Z",
    });
    expect(String(f?.properties?.upcoming)).toMatch(/^high 5\.3 ft at 06:49 UTC/);
    expect(tideFeature(station, [], undefined)).toBeNull();
  });
});

describe("tides layer", () => {
  it("caches station lists a day under shared keys and asks each station with its own key", async () => {
    const stub = routedStub();
    const r = await layer.query(ctx(stub), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(MAX_STATIONS);
    expect(r.coverageNote).toMatch(/Showing 8 of 38/);
    const c = calls(stub);
    expect(c[0][1]).toMatchObject({ cacheKey: "tides:stations:predictions", ttlSeconds: 86_400 });
    expect(c[1][1]).toMatchObject({ cacheKey: "tides:stations:waterlevels", ttlSeconds: 86_400 });
    const hilo = c.filter((x) => x[0].includes("product=predictions"));
    expect(hilo).toHaveLength(MAX_STATIONS);
    const u = new URL(hilo[0][0]);
    expect(u.searchParams.get("interval")).toBe("hilo");
    expect(u.searchParams.get("datum")).toBe("MLLW");
    expect(u.searchParams.get("units")).toBe("english");
    expect(u.searchParams.get("time_zone")).toBe("gmt");
    expect(u.searchParams.get("begin_date")).toBe("20261010 02:14");
    expect(hilo[0][1].cacheKey).toMatch(/^tides:hilo:\d+$/);
    expect(hilo[0][1].ttlSeconds).toBe(900);
  });

  it("asks for observed water level only at live gauges", async () => {
    const stub = routedStub();
    const r = await layer.query(ctx(stub), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const wl = calls(stub).filter((x) => x[0].includes("product=water_level"));
    const live = new Set(parseStations(waterlevelsFixture).map((s) => s.id));
    const picked = pickStations(parseStations(stationsFixture), live, SF);
    expect(wl.length).toBe(picked.filter((s) => live.has(s.id)).length);
    expect(wl.length).toBeGreaterThan(0);
    for (const [url, init] of wl) {
      expect(url).toContain("date=latest");
      expect(init.ttlSeconds).toBe(360);
      expect(typeof init.shouldCache).toBe("function");
    }
    const gg = r.data.features.find((f) => f.properties?.stationId === "9414290");
    expect(gg?.properties?.observedNow).toBe(2.495);
  });

  it("returns a note and no station calls when nothing is in view", async () => {
    const stub = routedStub();
    const r = await layer.query(ctx(stub, [-123.5, 36.0, -123.3, 36.2]), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toMatch(/No NOAA tide stations/);
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("skips upstream outside the US and maps a failed station list to an upstream error", async () => {
    const none = vi.fn();
    const r = await layer.query(ctx(none, [2, 45, 3, 46]), {});
    expect(none).not.toHaveBeenCalled();
    expect(r).toMatchObject({ coverageNote: "No data outside the United States" });

    const down = vi.fn(async () => new Response("no", { status: 502 }));
    expect(await layer.query(ctx(down), {})).toMatchObject({ hint: "upstream" });
  });

  it("errors when every station's predictions fail, and notes partial failures", async () => {
    const predDown = vi.fn(async (url: string) => {
      if (url.includes("type=tidepredictions")) return json(stationsFixture);
      if (url.includes("type=waterlevels")) return json(waterlevelsFixture);
      return new Response("busy", { status: 503 });
    });
    expect(await layer.query(ctx(predDown), {})).toMatchObject({ hint: "upstream" });

    let n = 0;
    const someDown = vi.fn(async (url: string) => {
      if (url.includes("product=predictions") && n++ === 0) return new Response("busy", { status: 503 });
      return routedStub()(url);
    });
    const r = await layer.query(ctx(someDown), {});
    expect(r).toMatchObject({ kind: "geojson" });
    expect((r as { coverageNote?: string }).coverageNote).toMatch(/1 station did not answer/);
  });

  it("describes units, datum, freshness and the user's words", () => {
    for (const word of ["tide", "low tide", "high tide", "feet", "MLLW", "UTC", "observedNow"]) {
      expect(layer.description).toContain(word);
    }
    expect(layer.license).toBe("Public domain (NOAA CO-OPS)");
    expect(layer.style).toMatchObject({ geometry: "point", unit: "ft" });
    expect(layer.coverage).toBe("us");
  });

  it("rejects an oversized bbox through runLayer", async () => {
    expect((await runLayer("tides", { bbox: [-125, 32, -117, 42] })).status).toBe(422);
  });
});
