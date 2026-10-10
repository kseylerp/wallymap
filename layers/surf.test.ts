import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, {
  buoyFeatures,
  compass,
  forecastFeatures,
  forecastGrid,
  parseLatestObs,
  parseStationNames,
} from "./surf";
import marineFixture from "./__fixtures__/marine.sf.json";

/** Recorded 2026-10-10 ~02:11 UTC: latest_obs trimmed to 11 stations, activestations to 5, marine for SF's 4 x 4 grid. */
const OBS = readFileSync(join(__dirname, "__fixtures__/ndbc-latest-obs.txt"), "utf8");
const XML = readFileSync(join(__dirname, "__fixtures__/ndbc-stations.xml"), "utf8");
const SF: [number, number, number, number] = [-123.2, 37.3, -122.3, 38.0];
const NOW = new Date("2026-10-10T02:15:00Z");

function text(body: string): Response {
  return new Response(body, { status: 200 });
}

function routedStub() {
  return vi.fn(async (url: string) => {
    if (url.includes("latest_obs")) return text(OBS);
    if (url.includes("activestations")) return text(XML);
    return text(JSON.stringify(marineFixture));
  });
}

function ctx(stub: ReturnType<typeof vi.fn>, bbox = SF, cacheKey?: string) {
  return { bbox, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

function calls(stub: ReturnType<typeof vi.fn>) {
  return stub.mock.calls as unknown as [string, { cacheKey?: string; ttlSeconds?: number }][];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("parsing", () => {
  it("reads latest_obs columns by header name, with MM as missing", () => {
    const obs = parseLatestObs(OBS);
    const halfMoon = obs.find((o) => o.id === "46012");
    expect(halfMoon).toMatchObject({ lat: 37.356, lon: -122.881, wvht: 2.2, dpd: 11, wtmp: 16.3, wspd: 4 });
    expect(halfMoon?.apd).toBeUndefined();
    expect(new Date(halfMoon?.time ?? 0).toISOString()).toBe("2026-10-10T01:00:00.000Z");
    expect(obs.find((o) => o.id === "46026")?.wvht).toBeUndefined();
  });

  it("reads station names from activestations.xml", () => {
    const names = parseStationNames(XML);
    expect(names.get("46237")).toBe("San Francisco Bar, CA (142)");
    expect(names.get("46012")).toMatch(/HALF MOON BAY/);
  });

  it("turns degrees into a 16-point compass direction", () => {
    expect(compass(0)).toBe("N");
    expect(compass(261)).toBe("W");
    expect(compass(292)).toBe("WNW");
    expect(compass(359)).toBe("N");
  });
});

describe("buoyFeatures", () => {
  it("keeps buoys in the bbox with a wave height, with period, direction and water temperature", () => {
    const fc = buoyFeatures(parseLatestObs(OBS), parseStationNames(XML), SF, NOW);
    expect(fc.features.map((f) => f.properties?.stationId).sort()).toEqual(["46012", "46237"]);
    const bar = fc.features.find((f) => f.properties?.stationId === "46237");
    expect(bar?.properties).toMatchObject({
      name: "San Francisco Bar, CA (142)",
      kind: "buoy",
      t: "2026-10-10T01:30:00.000Z",
      v: 1.8,
      waveFt: 5.9,
      periodS: 11,
      avgPeriodS: 9.2,
      directionDeg: 261,
      directionFrom: "W",
      waterTempC: 15.6,
    });
    expect(bar?.geometry.coordinates).toEqual([-122.634, 37.788]);
  });

  it("drops observations older than 12 hours", () => {
    const later = new Date("2026-10-10T14:00:00Z");
    expect(buoyFeatures(parseLatestObs(OBS), new Map(), SF, later).features).toHaveLength(0);
  });

  it("names a buoy by id when the station list lacks it", () => {
    const fc = buoyFeatures(parseLatestObs(OBS), new Map(), SF, NOW);
    expect(fc.features[0].properties?.name).toMatch(/^NDBC \d+/);
  });
});

describe("forecast", () => {
  it("samples a 4 x 4 grid of cell centres", () => {
    const grid = forecastGrid([0, 0, 4, 4]);
    expect(grid).toHaveLength(16);
    expect(grid[0]).toEqual([0.5, 0.5]);
    expect(grid[15]).toEqual([3.5, 3.5]);
  });

  it("gives the current hour's waves and the biggest in the next 48 hours per sea cell", () => {
    const fc = forecastFeatures(marineFixture, NOW);
    expect(fc.features.length).toBeGreaterThan(0);
    for (const f of fc.features) {
      const p = f.properties ?? {};
      expect(p.kind).toBe("forecast");
      expect(p.t).toBe("2026-10-10T02:00:00.000Z");
      expect(typeof p.v).toBe("number");
      expect(Number(p.maxNext48hM)).toBeGreaterThanOrEqual(Number(p.v));
      expect(typeof p.periodS).toBe("number");
    }
  });

  it("drops land cells, whose hours are all null", () => {
    const land = { latitude: 39, longitude: -120, hourly: { time: ["2026-10-10T02:00"], wave_height: [null] } };
    expect(forecastFeatures([land], NOW).features).toHaveLength(0);
  });
});

describe("surf layer", () => {
  it("fetches the global observation file and station list under shared cache keys with short TTLs", async () => {
    const stub = routedStub();
    const r = await layer.query(ctx(stub, SF, "surf:k"), { forecast: false });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(2);
    const [obs, stations] = calls(stub);
    expect(obs[0]).toBe("https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt");
    expect(obs[1]).toMatchObject({ cacheKey: "surf:ndbc-latest", ttlSeconds: 600 });
    expect(stations[0]).toBe("https://www.ndbc.noaa.gov/activestations.xml");
    expect(stations[1].cacheKey).toBe("surf:ndbc-stations");
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("adds Open-Meteo Marine forecast points when forecast is true", async () => {
    const stub = routedStub();
    const r = await layer.query(ctx(stub, SF, "surf:k"), { forecast: true });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const marine = calls(stub).find((c) => c[0].includes("marine-api.open-meteo.com"));
    expect(marine).toBeDefined();
    const url = new URL(marine![0]);
    expect(url.searchParams.get("latitude")?.split(",")).toHaveLength(16);
    expect(url.searchParams.get("hourly")).toBe("wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period");
    expect(marine![1].cacheKey).toBe("surf:k:marine");
    const kinds = new Set(r.data.features.map((f) => f.properties?.kind));
    expect(kinds).toEqual(new Set(["buoy", "forecast"]));
    expect(r.citation.source).toMatch(/non-commercial/);
  });

  it("suggests the forecast when no buoy is in view, without fetching names", async () => {
    const stub = routedStub();
    const r = await layer.query(ctx(stub, [-120.6, 38.6, -119.8, 39.3]), { forecast: false });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toMatch(/forecast true/);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("keeps buoys when the forecast fails, and errors when the observations fail", async () => {
    const marineDown = vi.fn(async (url: string) => {
      if (url.includes("latest_obs")) return text(OBS);
      if (url.includes("activestations")) return text(XML);
      return new Response("busy", { status: 429 });
    });
    const r = await layer.query(ctx(marineDown), { forecast: true });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(2);
    expect(r.coverageNote).toMatch(/forecast failed/);

    const down = vi.fn(async () => new Response("no", { status: 503 }));
    expect(await layer.query(ctx(down), { forecast: false })).toMatchObject({ hint: "upstream" });
  });

  it("describes units, freshness, licence and the user's words", () => {
    for (const word of ["surf", "swell", "waves", "metres", "period", "non-commercial", "forecast"]) {
      expect(layer.description.toLowerCase()).toContain(word);
    }
    expect(layer.license).toMatch(/NOAA/);
    expect(layer.license).toMatch(/non-commercial/);
    expect(layer.style).toMatchObject({ geometry: "point", unit: "m" });
    expect(layer.coverage).toBe("global");
  });

  it("rejects bad input and an oversized bbox through runLayer", async () => {
    expect((await runLayer("surf", { bbox: SF, input: { forecast: "yes" } })).status).toBe(400);
    expect((await runLayer("surf", { bbox: [-130, 20, -110, 45] })).status).toBe(422);
  });
});
