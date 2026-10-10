import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { earthquakesUrl, normalizeEarthquakes } from "./earthquakes";
import fixture from "./__fixtures__/earthquakes.tahoe.json";

/** The fixture is a real USGS response for this box (365 days to 2026-10-09, M2.5+, biggest 12 events). */
const BOX: [number, number, number, number] = [-121, 38, -119, 40];
const NOW = Date.parse("2026-10-09T12:00:00Z");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string) {
  return { bbox: BOX, zoom: 8, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

function geojson(r: Awaited<ReturnType<typeof layer.query>>) {
  if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
  return r;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("earthquakesUrl", () => {
  it("sends the bbox as min/max longitude and latitude, a date-only start and a limit", () => {
    const url = new URL(earthquakesUrl(BOX, 365, 2.5, NOW));
    expect(url.origin + url.pathname).toBe("https://earthquake.usgs.gov/fdsnws/event/1/query");
    expect(url.searchParams.get("format")).toBe("geojson");
    expect(url.searchParams.get("minlongitude")).toBe("-121");
    expect(url.searchParams.get("minlatitude")).toBe("38");
    expect(url.searchParams.get("maxlongitude")).toBe("-119");
    expect(url.searchParams.get("maxlatitude")).toBe("40");
    expect(url.searchParams.get("starttime")).toBe("2025-10-09");
    expect(url.searchParams.get("minmagnitude")).toBe("2.5");
    expect(url.searchParams.get("orderby")).toBe("magnitude");
    expect(url.searchParams.get("limit")).toBe("5000");
  });

  it("goes back the requested number of days", () => {
    const url = new URL(earthquakesUrl(BOX, 30, 4, NOW));
    expect(url.searchParams.get("starttime")).toBe("2026-09-09");
    expect(url.searchParams.get("minmagnitude")).toBe("4");
  });
});

describe("normalizeEarthquakes", () => {
  it("maps events to 2-D points with t, v, depthKm and place", () => {
    const fc = normalizeEarthquakes(fixture.features);
    expect(fc.features).toHaveLength(fixture.features.length);
    const biggest = fc.features[0];
    expect(biggest.geometry).toEqual({ type: "Point", coordinates: [-119.0075, 39.3345] });
    expect(biggest.properties).toMatchObject({
      v: 5.68,
      place: "20 km ESE of Silver Springs, Nevada",
      t: new Date(1776130152123).toISOString(),
      depthKm: 5,
      magType: "mwr",
      kind: "earthquake",
      felt: 6515,
      url: "https://earthquake.usgs.gov/earthquakes/eventpage/nn00914068",
    });
    for (const f of fc.features) {
      expect(f.geometry.coordinates).toHaveLength(2);
      expect(typeof f.properties?.v).toBe("number");
      expect(Number.isNaN(Date.parse(String(f.properties?.t)))).toBe(false);
    }
  });

  it("drops events with no magnitude or no position and flags a possible tsunami", () => {
    const fc = normalizeEarthquakes([
      { geometry: { type: "Point", coordinates: [-120, 39, 3] }, properties: { mag: null, time: 1 } },
      { geometry: null, properties: { mag: 3 } },
      { geometry: { type: "Point", coordinates: [-120, 39] }, properties: { mag: 6.1, tsunami: 1 } },
      "garbage",
    ]);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toEqual({ v: 6.1, tsunami: "possible" });
  });
});

describe("earthquakes layer", () => {
  it("declares global coverage, the public domain license, no env and extrude, heat hints", () => {
    expect(layer.id).toBe("earthquakes");
    expect(layer.coverage).toBe("global");
    expect(layer.license).toBe("Public domain (USGS)");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.input.parse({})).toEqual({ days: 365, minMagnitude: 2.5 });
    expect(layer.style).toMatchObject({ geometry: "point", extrude: "v", heat: true });
  });

  it("returns a cited FeatureCollection and passes the cache key through", async () => {
    const stub = vi.fn(async () => json(fixture));
    const r = geojson(await layer.query(ctx(stub, "earthquakes:key"), { days: 365, minMagnitude: 2.5 }));
    expect(r.data.features).toHaveLength(12);
    expect(r.citation.source).toContain("U.S. Geological Survey");
    expect(r.coverageNote).toBeUndefined();
    const [url, init] = stub.mock.calls[0] as unknown as [string, { cacheKey?: string }];
    expect(url.startsWith("https://earthquake.usgs.gov/fdsnws/event/1/query?")).toBe(true);
    expect(init.cacheKey).toBe("earthquakes:key");
  });

  it("says so when nothing is found", async () => {
    const stub = vi.fn(async () => json({ type: "FeatureCollection", features: [] }));
    const r = geojson(await layer.query(ctx(stub), { days: 30, minMagnitude: 4 }));
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toBe("No earthquakes of magnitude 4 or more in the last 30 days in this area");
  });

  it("notes the 5,000 event cap", async () => {
    const many = Array.from({ length: 5000 }, (_, i) => fixture.features[i % fixture.features.length]);
    const stub = vi.fn(async () => json({ type: "FeatureCollection", features: many }));
    const r = geojson(await layer.query(ctx(stub), { days: 365, minMagnitude: 2.5 }));
    expect(r.data.features).toHaveLength(5000);
    expect(r.coverageNote).toContain("5,000 largest events");
  });

  it("maps upstream failures to hinted errors", async () => {
    const input = { days: 365, minMagnitude: 2.5 };
    expect(await layer.query(ctx(vi.fn(async () => new Response("bad", { status: 400 }))), input)).toEqual({
      error: "USGS earthquake service returned 400",
      hint: "upstream",
    });
    expect(await layer.query(ctx(vi.fn(async () => new Response("<html>", { status: 200 }))), input)).toMatchObject({
      hint: "upstream",
    });
    expect(await layer.query(ctx(vi.fn(async () => json({ nope: true }))), input)).toMatchObject({ hint: "upstream" });
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    expect(
      await layer.query(
        ctx(
          vi.fn(async () => {
            throw timeout;
          }),
        ),
        input,
      ),
    ).toMatchObject({ error: expect.stringContaining("timed out"), hint: "upstream" });
    expect(
      await layer.query(
        ctx(
          vi.fn(async () => {
            throw new Error("down");
          }),
        ),
        input,
      ),
    ).toMatchObject({ error: "USGS earthquake service returned no response", hint: "upstream" });
  });

  it("rejects a view over the area cap through runLayer", async () => {
    const r = await runLayer("earthquakes", { bbox: [-170, -60, 170, 70] });
    expect(r.status).toBe(422);
  });
});
