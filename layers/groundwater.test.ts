import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { LIMIT, normalizeWells, sinceYear } from "./groundwater";
import fixture from "./__fixtures__/groundwater.kearney.json";

/** A real Water Data API answer for this box (parameter 72019, measured 2024 or later), recorded 2026-10-10, cut to its first 12 wells. */
const KEARNEY: [number, number, number, number] = [-100.2, 40.6, -99.8, 40.9];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function ctx(stub: ReturnType<typeof vi.fn>, opts: { env?: Record<string, string>; bbox?: [number, number, number, number]; cacheKey?: string } = {}) {
  return { bbox: opts.bbox ?? KEARNEY, zoom: 10, env: opts.env ?? {}, fetch: stub as unknown as CachedFetch, cacheKey: opts.cacheKey };
}

function geojson(r: Awaited<ReturnType<typeof layer.query>>) {
  if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
  return r;
}

type Call = [string, RequestInit & { cacheKey?: string; ttlSeconds?: number }];

describe("normalizeWells", () => {
  it("turns each well into a point with depth in v, the time in t and the USGS id", () => {
    const wells = normalizeWells(fixture);
    expect(wells).toHaveLength(12);
    expect(wells[0].geometry.type).toBe("Point");
    expect(wells[0].properties).toMatchObject({
      name: expect.stringMatching(/^Well \d+$/),
      v: 82,
      depthFt: 82,
      kind: "static",
      condition: "Static",
      approval: "Approved",
      url: expect.stringMatching(/^https:\/\/waterdata\.usgs\.gov\/monitoring-location\/USGS-\d+\/$/),
    });
    expect(wells[0].properties?.t).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(wells[0].properties?.date).toBe(String(wells[0].properties?.t).slice(0, 10));
    expect(wells[0].properties?.siteNo).toBe(String(wells[0].properties?.site).replace("USGS-", ""));
  });

  it("keeps a flowing well's negative depth, marks disturbed readings 'other' and drops unusable rows", () => {
    const row = (props: Record<string, unknown>, geometry: unknown = { type: "Point", coordinates: [-100, 40] }) => ({
      type: "Feature",
      geometry,
      properties: { monitoring_location_id: "USGS-1", value: "10", unit_of_measure: "ft", time: "2025-05-01T18:00:00+00:00", ...props },
    });
    const wells = normalizeWells({
      features: [
        row({ monitoring_location_id: "USGS-1", value: "-7.99", qualifier: ["Static"] }),
        row({ monitoring_location_id: "USGS-1", value: "20" }),
        row({ monitoring_location_id: "USGS-2", qualifier: ["Pumping"] }),
        row({ monitoring_location_id: "USGS-3", qualifier: [] }),
        row({ monitoring_location_id: "USGS-4", value: "not a number" }),
        row({ monitoring_location_id: "USGS-5", unit_of_measure: "m" }),
        row({ monitoring_location_id: "USGS-6" }, { type: "Polygon", coordinates: [] }),
        row({ monitoring_location_id: "USGS-7", time: "garbage" }),
      ],
    });
    expect(wells.map((w) => w.properties?.site)).toEqual(["USGS-1", "USGS-2", "USGS-3", "USGS-7"]);
    expect(wells[0].properties).toMatchObject({ v: -7.99, kind: "static" });
    expect(wells[1].properties).toMatchObject({ v: 10, kind: "other", condition: "Pumping" });
    expect(wells[2].properties?.kind).toBe("unspecified");
    expect(wells[3].properties).not.toHaveProperty("t");
    expect(normalizeWells({ nope: true })).toEqual([]);
  });
});

describe("groundwater layer", () => {
  it("declares US coverage, USGS public domain, an optional key and a sinceYear input, and draws columns by depth", () => {
    expect(layer.id).toBe("groundwater");
    expect(layer.coverage).toBe("us");
    expect(layer.license).toBe("Public domain (USGS)");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.optionalEnv).toEqual(["USGS_API_KEY"]);
    expect(layer.maxAreaKm2).toBe(40_000);
    expect(layer.input.parse({})).toEqual({});
    expect(layer.input.safeParse({ sinceYear: 1800 }).success).toBe(false);
    expect(layer.style).toMatchObject({ geometry: "point", unit: "ft", extrude: "v" });
    expect(sinceYear(new Date("2026-10-10T00:00:00Z"), {})).toBe(2021);
    expect(sinceYear(new Date("2026-10-10T00:00:00Z"), { sinceYear: 2010 })).toBe(2010);
  });

  it("asks for parameter 72019 in the bbox since five years back, with a cap and a 6 hour cache", async () => {
    const stub = vi.fn(async () => json(fixture));
    const r = geojson(await layer.query(ctx(stub, { cacheKey: "groundwater:k" }), {}));
    expect(r.data.features).toHaveLength(12);
    expect(r.coverageNote).toBe("Latest manual measurement per well since 2021; depth is feet below land surface");
    const [url, init] = stub.mock.calls[0] as unknown as Call;
    const params = new URL(url).searchParams;
    expect(url).toContain("/ogcapi/v1/collections/latest-field-measurements/items?");
    expect(params.get("parameter_code")).toBe("72019");
    expect(params.get("bbox")).toBe("-100.2,40.6,-99.8,40.9");
    expect(params.get("time")).toBe("2021-01-01T00:00:00Z/..");
    expect(params.get("limit")).toBe(String(LIMIT));
    expect(init.ttlSeconds).toBe(21_600);
    expect(init.cacheKey).toBe("groundwater:k:groundwater:2021");
    expect(init).not.toHaveProperty("headers");
  });

  it("uses sinceYear in the filter and the key, and sends USGS_API_KEY when set", async () => {
    const stub = vi.fn(async () => json(fixture));
    await layer.query(ctx(stub, { env: { USGS_API_KEY: "test-key" }, cacheKey: "k" }), { sinceYear: 2010 });
    const [url, init] = stub.mock.calls[0] as unknown as Call;
    expect(new URL(url).searchParams.get("time")).toBe("2010-01-01T00:00:00Z/..");
    expect(init.cacheKey).toBe("k:groundwater:2010");
    expect(init.headers).toEqual({ "X-Api-Key": "test-key" });
  });

  it("says when the cap is hit and when no wells match", async () => {
    const many = { features: Array.from({ length: LIMIT }, (_, i) => fixture.features[i % fixture.features.length]) };
    const capped = geojson(await layer.query(ctx(vi.fn(async () => json(many))), {}));
    expect(capped.coverageNote).toContain(`Showing ${LIMIT} wells, in no particular order`);
    const none = geojson(await layer.query(ctx(vi.fn(async () => json({ type: "FeatureCollection", features: [] }))), {}));
    expect(none.data.features).toEqual([]);
    expect(none.coverageNote).toBe("No wells measured since 2021 in this area; set sinceYear lower to include older measurements");
  });

  it("returns nothing outside the US without calling out", async () => {
    const stub = vi.fn();
    const r = geojson(await layer.query(ctx(stub, { bbox: [5, 45, 5.2, 45.2] }), {}));
    expect(r.coverageNote).toBe("No data outside the United States");
    expect(stub).not.toHaveBeenCalled();
  });

  it("maps rate limiting, errors, bad bodies and timeouts to upstream errors", async () => {
    expect(await layer.query(ctx(vi.fn(async () => json({}, 429))), {})).toEqual({
      error: "USGS Water Data API is rate-limiting requests; try again in a minute",
      hint: "upstream",
    });
    expect(await layer.query(ctx(vi.fn(async () => json({}, 500))), {})).toEqual({ error: "USGS Water Data API returned 500", hint: "upstream" });
    expect(await layer.query(ctx(vi.fn(async () => new Response("<html>"))), {})).toMatchObject({ hint: "upstream" });
    expect(await layer.query(ctx(vi.fn(async () => json({ code: "x" }))), {})).toEqual({
      error: "USGS Water Data API did not return a FeatureCollection",
      hint: "upstream",
    });
    const slow = vi.fn(async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    expect(await layer.query(ctx(slow), {})).toMatchObject({ error: expect.stringContaining("timed out"), hint: "upstream" });
  });

  it("is registered, validates sinceYear and rejects an oversized area through runLayer", async () => {
    expect((await runLayer("groundwater", { bbox: KEARNEY, input: { sinceYear: "recent" } })).status).toBe(400);
    expect((await runLayer("groundwater", { bbox: [-105, 38, -95, 44] })).status).toBe(422);
  });

  it("describes depth to water, the sign convention and that it is not a trend", () => {
    expect(layer.description).toMatch(/water table/);
    expect(layer.description).toMatch(/negative/);
    expect(layer.description).toMatch(/cannot show a trend/);
  });
});
