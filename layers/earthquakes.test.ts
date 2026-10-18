import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { cardContent } from "@/lib/render/card";
import { summarizeFeature } from "@/lib/render/inspect";
import layer, { depthText, earthquakesCountUrl, earthquakesUrl, magnitudeText, normalizeEarthquakes, quakeHeading } from "./earthquakes";
import { contractProblems, labelsOf, legendOf, timeShapeOf } from "./contract";
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

  it("builds a count URL for the same search without order or limit", () => {
    const url = new URL(earthquakesCountUrl(BOX, 365, 2.5, NOW));
    expect(url.origin + url.pathname).toBe("https://earthquake.usgs.gov/fdsnws/event/1/count");
    expect(url.searchParams.get("minlongitude")).toBe("-121");
    expect(url.searchParams.get("starttime")).toBe("2025-10-09");
    expect(url.searchParams.has("limit")).toBe(false);
    expect(new URL(earthquakesUrl(BOX, 365, 2.5, NOW, 2000)).searchParams.get("limit")).toBe("2000");
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
    expect(fc.features[0].properties).toEqual({ heading: "Earthquake", v: 6.1, magnitude: "M 6.1", tsunami: "possible" });
  });

  it("titles the card by kind and place and writes magnitude as M 5.7 and depth in km and mi", () => {
    const fc = normalizeEarthquakes(fixture.features);
    const biggest = fc.features[0];
    expect(biggest.properties).toMatchObject({
      heading: "Earthquake 20 km ESE of Silver Springs, Nevada",
      magnitude: "M 5.7",
      depth: "5 km (3.1 mi)",
    });
    expect(summarizeFeature(biggest).name).toBe("Earthquake 20 km ESE of Silver Springs, Nevada");
    const card = cardContent(biggest, { unit: layer.style.unit, card: layer.card, fieldHelp: layer.fieldHelp });
    expect(card.measure).toMatchObject({ label: "Magnitude", value: "M 5.7" });
    expect(card.measure?.help).toBeDefined();
    expect(card.facts.find((f) => f.key === "depth")?.value).toBe("5 km (3.1 mi)");
    expect([...card.facts, ...card.details].map((r) => r.key)).not.toContain("depthKm");
    expect(quakeHeading("quarry blast", "Central California")).toBe("Quarry blast near Central California");
    expect(magnitudeText(3.58)).toBe("M 3.6");
    expect(depthText(410.3)).toBe("410 km (255 mi)");
  });
});

describe("earthquakes contract", () => {
  it("is continuous by day, keys size by magnitude with depth as color, and labels the five strongest", () => {
    const data = normalizeEarthquakes(fixture.features);
    expect(timeShapeOf(layer, data)).toMatchObject({ shape: "continuous", step: "day" });
    const legend = legendOf(layer, data);
    expect(legend).toMatchObject({ kind: "size", field: "v", unit: "M" });
    expect(legend.stops?.map((s) => s.label)).toEqual(["M 2.5", "M 4", "M 5", "M 6", "M 7 and up"]);
    expect(legend.note).toMatch(/depth/i);
    expect(legend.note).toMatch(/km \(mi\)/);
    expect(labelsOf(layer)).toEqual({ field: "magnitude", max: 5, rankBy: "v" });
    expect(layer.style.encode).toEqual({ size: "v", color: "depthKm" });
    expect(contractProblems(layer)).toEqual([]);
  });
});

describe("earthquakes layer", () => {
  it("declares global coverage, the public domain license, no env and extrude, heat hints", () => {
    expect(layer.id).toBe("earthquakes");
    expect(layer.coverage).toBe("global");
    expect(layer.license).toBe("Public domain (USGS)");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.input.parse({})).toEqual({ days: 365, minMagnitude: 2.5 });
    expect(layer.maxAreaKm2).toBe(5_000_000);
    expect(layer.hardMaxAreaKm2).toBeUndefined();
    expect(layer.wide).toEqual({ orderBy: "magnitude", rank: "strongest", limit: 2000 });
    expect(layer.style).toMatchObject({ geometry: "point", unit: "M", extrude: "v", heat: true });
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

  it("rejects a view over the hard cap (4 x 5,000,000 km²) through runLayer", async () => {
    const r = await runLayer("earthquakes", { bbox: [-170, -60, 170, 70] });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ hint: "zoom_in", error: expect.stringMatching(/zoom in to under 20000000 km²$/) });
  });

  it("answers an Alaska-wide box wide: the 2,000 strongest, a count, and a note naming the total", async () => {
    const stub = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/count?") ? json({ count: 5983, maxAllowed: 20000 }) : json(fixture),
    );
    vi.stubGlobal("fetch", stub);
    try {
      const r = await runLayer("earthquakes", { bbox: [-170, 45, -130, 72], zoom: 3 });
      expect(r.status).toBe(200);
      const urls = stub.mock.calls.map((c) => new URL(String(c[0])));
      const query = urls.find((u) => u.pathname.endsWith("/query"));
      expect(query?.searchParams.get("orderby")).toBe("magnitude");
      expect(query?.searchParams.get("limit")).toBe("2000");
      expect(urls.some((u) => u.pathname.endsWith("/count"))).toBe(true);
      expect(r.body).toMatchObject({
        total: 5983,
        truncated: true,
        coverageNote: "Showing the 12 strongest of 5,983 (ranked by magnitude); zoom in under 5,000,000 km² for all",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
