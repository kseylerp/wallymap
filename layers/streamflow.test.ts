import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { joinGauges } from "./streamflow";
import latestFixture from "./__fixtures__/usgs-latest.tahoe.json";
import locationsFixture from "./__fixtures__/usgs-locations.tahoe.json";

const latest = latestFixture as unknown as { features: unknown[] };
const locations = locationsFixture as unknown as { features: unknown[] };

/** Lake Tahoe area; the fixtures were recorded for this bbox on 2026-10-09 around 18:45 UTC. */
const TAHOE: [number, number, number, number] = [-120.6, 38.6, -119.8, 39.3];
const FLOW = { parameter: "00060" } as const;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** Answers the latest-values call with the latest fixture and the locations call with the locations fixture. */
function routedStub() {
  return vi.fn(async (url: string) => json(url.includes("/latest-continuous/") ? latest : locations));
}

function ctx(stub: ReturnType<typeof vi.fn>, opts: { cacheKey?: string; bbox?: typeof TAHOE; env?: Record<string, string> } = {}) {
  return {
    bbox: opts.bbox ?? TAHOE,
    zoom: 9,
    env: opts.env ?? {},
    fetch: stub as unknown as CachedFetch,
    cacheKey: opts.cacheKey,
  };
}

function param(url: unknown, name: string): string | null {
  return new URL(String(url)).searchParams.get(name);
}

function callsOf(stub: ReturnType<typeof vi.fn>): [string, { cacheKey?: string; headers?: Record<string, string> }][] {
  return stub.mock.calls as unknown as [string, { cacheKey?: string; headers?: Record<string, string> }][];
}

const NOW = new Date("2026-10-09T19:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("joinGauges", () => {
  it("joins each recent reading to its gauge name by monitoring location id", () => {
    const fc = joinGauges(latest, locations, NOW);
    expect(fc.features).toHaveLength(18);
    const truckee = fc.features.find((f) => f.properties?.siteId === "USGS-10338000");
    expect(truckee?.properties).toEqual({
      name: "TRUCKEE R NR TRUCKEE CA",
      siteId: "USGS-10338000",
      t: "2026-10-09T18:15:00.000Z",
      v: 70.3,
    });
    expect(truckee?.geometry.type).toBe("Point");
  });

  it("leaves out gauges whose latest reading is more than 7 days old", () => {
    const ids = joinGauges(latest, locations, NOW).features.map((f) => f.properties?.siteId);
    // These sites only have readings from 2011, 1998 and so on in the fixture.
    expect(ids).not.toContain("USGS-10336740");
    expect(ids).not.toContain("USGS-10310358");
  });

  it("keeps only the newest reading when a site has several time series", () => {
    const point = { type: "Point", coordinates: [-120, 39] };
    const row = (time: string, value: string) => ({
      type: "Feature",
      geometry: point,
      properties: { monitoring_location_id: "USGS-1", time, value },
    });
    const fc = joinGauges(
      { features: [row("2026-10-09T10:00:00+00:00", "5"), row("2026-10-09T18:00:00+00:00", "7")] },
      { features: [] },
      NOW,
    );
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toMatchObject({ v: 7, t: "2026-10-09T18:00:00.000Z" });
  });

  it("parses string values and falls back to the site id when a name is missing", () => {
    const row = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-120, 39] },
      properties: { monitoring_location_id: "USGS-2", time: "2026-10-09T18:00:00+00:00", value: "12.50" },
    };
    const fc = joinGauges({ features: [row] }, { features: [] }, NOW);
    expect(fc.features[0].properties).toEqual({
      name: "USGS-2",
      siteId: "USGS-2",
      t: "2026-10-09T18:00:00.000Z",
      v: 12.5,
    });
  });

  it("skips readings with a non-numeric value or no point geometry", () => {
    const base = { monitoring_location_id: "USGS-3", time: "2026-10-09T18:00:00+00:00" };
    const features = [
      { type: "Feature", geometry: { type: "Point", coordinates: [-120, 39] }, properties: { ...base, value: "Ice" } },
      { type: "Feature", geometry: null, properties: { ...base, monitoring_location_id: "USGS-4", value: "3" } },
      { type: "Feature", geometry: { type: "Point", coordinates: [-120, 39] }, properties: { ...base, monitoring_location_id: "USGS-5", value: null } },
    ];
    expect(joinGauges({ features }, { features: [] }, NOW).features).toHaveLength(0);
  });
});

describe("streamflow layer", () => {
  it("asks latest-continuous for the bbox, parameter and stream sites, then names for the recent ids", async () => {
    const stub = routedStub();
    const r = await layer.query(ctx(stub), FLOW);
    expect(r).toMatchObject({ kind: "geojson" });
    expect(stub).toHaveBeenCalledTimes(2);

    const [latestUrl, namesUrl] = callsOf(stub).map((c) => c[0]);
    expect(latestUrl).toContain("https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items?");
    expect(param(latestUrl, "bbox")).toBe("-120.6,38.6,-119.8,39.3");
    expect(param(latestUrl, "parameter_code")).toBe("00060");
    expect(param(latestUrl, "site_type_code")).toBe("ST");
    expect(param(latestUrl, "f")).toBe("json");
    expect(param(latestUrl, "limit")).toBe("10000");

    expect(namesUrl).toContain("https://api.waterdata.usgs.gov/ogcapi/v0/collections/monitoring-locations/items?");
    const ids = param(namesUrl, "id")?.split(",") ?? [];
    expect(ids).toHaveLength(18);
    expect(ids).toContain("USGS-10338000");
    expect(ids).not.toContain("USGS-10336740");
    expect(param(namesUrl, "properties")).toBe("id,monitoring_location_name");
  });

  it("passes the gage height parameter through", async () => {
    const stub = routedStub();
    await layer.query(ctx(stub), { parameter: "00065" });
    expect(param(callsOf(stub)[0][0], "parameter_code")).toBe("00065");
  });

  it("uses distinct cache suffixes for the two upstream calls", async () => {
    const stub = routedStub();
    await layer.query(ctx(stub, { cacheKey: "streamflow:k" }), FLOW);
    const keys = callsOf(stub).map((c) => c[1].cacheKey);
    expect(keys).toEqual(["streamflow:k:usgs-latest", "streamflow:k:usgs-names"]);
  });

  it("batches name lookups 100 ids at a time with distinct cache suffixes", async () => {
    const features = Array.from({ length: 230 }, (_, i) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [-120, 39] },
      properties: { monitoring_location_id: `USGS-${i}`, time: "2026-10-09T18:00:00+00:00", value: "1" },
    }));
    const stub = vi.fn(async (url: string) =>
      json(url.includes("/latest-continuous/") ? { features } : { features: [] }),
    );
    const r = await layer.query(ctx(stub, { cacheKey: "streamflow:k" }), FLOW);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(230);
    const names = callsOf(stub).filter((c) => c[0].includes("/monitoring-locations/"));
    expect(names.map((c) => (param(c[0], "id") ?? "").split(",").length)).toEqual([100, 100, 30]);
    const keys = callsOf(stub).map((c) => c[1].cacheKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("returns a cited FeatureCollection of points with name, siteId, t and v", async () => {
    const r = await layer.query(ctx(routedStub()), FLOW);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(18);
    for (const f of r.data.features) {
      expect(f.geometry.type).toBe("Point");
      const p = f.properties ?? {};
      expect(typeof p.name).toBe("string");
      expect(String(p.siteId)).toMatch(/^USGS-\d+$/);
      expect(new Date(p.t).toISOString()).toBe(p.t);
      expect(typeof p.v).toBe("number");
    }
    expect(r.citation.source).toContain("USGS");
    expect(r.coverageNote).toBeUndefined();
  });

  it("returns an empty collection with a note when there are no gauges, without a names call", async () => {
    const stub = vi.fn(async () => json({ type: "FeatureCollection", features: [] }));
    const r = await layer.query(ctx(stub), FLOW);
    expect(stub).toHaveBeenCalledTimes(1);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toBe("No USGS gauges in this area");
  });

  it("says so when every gauge's latest reading is old", async () => {
    vi.setSystemTime(new Date("2026-12-31T00:00:00Z"));
    const stub = routedStub();
    const r = await layer.query(ctx(stub), FLOW);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toMatch(/last 7 days/);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("returns a coverage note without calling upstream outside the United States", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub, { bbox: [2, 45, 3, 46] }), FLOW);
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toBe("No data outside the United States");
  });

  it("sends USGS_API_KEY as X-Api-Key when set and no header when not", async () => {
    const withKey = routedStub();
    await layer.query(ctx(withKey, { env: { USGS_API_KEY: "test-key" } }), FLOW);
    for (const c of callsOf(withKey)) expect(c[1].headers).toEqual({ "X-Api-Key": "test-key" });

    const without = routedStub();
    await layer.query(ctx(without), FLOW);
    for (const c of callsOf(without)) expect(c[1].headers).toBeUndefined();
  });

  it("maps failures to upstream errors", async () => {
    const down = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(await layer.query(ctx(down), FLOW)).toMatchObject({ hint: "upstream" });

    const namesDown = vi.fn(async (url: string) =>
      url.includes("/latest-continuous/") ? json(latest) : new Response("nope", { status: 503 }),
    );
    expect(await layer.query(ctx(namesDown), FLOW)).toMatchObject({ hint: "upstream" });

    const badBody = vi.fn(async () => json({ code: "InvalidParameterValue" }));
    expect(await layer.query(ctx(badBody), FLOW)).toMatchObject({ hint: "upstream" });
  });

  it("notes when the service says there are more results than it returned", async () => {
    const withNext = { ...latest, links: [{ rel: "next", href: "https://example.test/next" }] };
    const stub = vi.fn(async (url: string) => json(url.includes("/latest-continuous/") ? withNext : locations));
    const r = await layer.query(ctx(stub), FLOW);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toMatch(/not all/i);
  });

  it("states what the number means and how fresh it is", () => {
    expect(layer.description).toMatch(/cubic feet per second/i);
    expect(layer.description).toMatch(/gage height|gauge height/i);
    expect(layer.description).toMatch(/latest reading|most recent reading/i);
    expect(layer.description).toMatch(/provisional/i);
    expect(layer.style).toEqual({ geometry: "point", color: "#5B6B7A", unit: "cfs" });
    expect(layer.coverage).toBe("us");
    expect(layer.license).toBe("Public domain (USGS)");
    expect(layer.maxAreaKm2).toBe(400_000);
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.optionalEnv).toEqual(["USGS_API_KEY"]);
  });

  it("rejects an oversized bbox and bad input through runLayer", async () => {
    const big = await runLayer("streamflow", { bbox: [-125, 31, -110, 49], zoom: 4 });
    expect(big.status).toBe(422);
    const bad = await runLayer("streamflow", { bbox: TAHOE, input: { parameter: "00010" } });
    expect(bad.status).toBe(400);
  });
});
