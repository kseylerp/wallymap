import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { hardMaxAreaKm2 } from "./types";
import { legendOf, labelsOf, timeShapeOf } from "./contract";
import layer, { HISTORY_LIMIT, LIMIT, WIDE_LIMIT, addContext, levelOf, normalizeWells, parseHistory, sinceYear, waterLevelPercentile } from "./groundwater";
import fixture from "./__fixtures__/groundwater.kearney.json";
/** The same 12 wells' manual readings since 2006 (field-measurements, the Kearney box), recorded 2026-10-18. */
import history from "./__fixtures__/groundwater.kearney-history.json";

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

/** The call for the newest readings (the history call runs beside it). */
const latestCall = (stub: ReturnType<typeof vi.fn>) => stub.mock.calls.find((c) => String(c[0]).includes("/latest-field-measurements/")) as unknown as Call;

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
    expect(layer.wide).toEqual({ limit: 2000, rank: "first" });
    expect(hardMaxAreaKm2(layer)).toBe(160_000);
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
    expect(r.coverageNote).toBe("Latest manual measurement per well since 2021; depth is feet below land surface; 0 of 12 wells compared with their own readings since 2006");
    const [url, init] = latestCall(stub);
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
    const [url, init] = latestCall(stub);
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
    expect(none.coverageNote).toBe("No wells measured since 2021 in this area; ask for an earlier start year to include older measurements");
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

  it("answers a wide box (about 150,000 km²) with one 2,000-well page, deepest first, and the count of all wells", async () => {
    const stub = vi.fn(async (input: RequestInfo | URL) =>
      new URL(String(input)).searchParams.get("resulttype") === "hits" ? json({ type: "FeatureCollection", features: [], numberMatched: 2492 }) : json(fixture),
    );
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("groundwater", { bbox: [-102, 39, -98, 43], zoom: 6 });
      expect(res.status).toBe(200);
      const urls = stub.mock.calls.map((c) => new URL(String(c[0])));
      expect(urls.find((u) => !u.searchParams.has("resulttype"))?.searchParams.get("limit")).toBe(String(WIDE_LIMIT));
      const hits = urls.find((u) => u.searchParams.get("resulttype") === "hits");
      expect(hits?.searchParams.get("bbox")).toBe("-102,39,-98,43");
      expect(hits?.searchParams.get("time")).toBe("2021-01-01T00:00:00Z/..");
      if (!("data" in res.body) || res.body.kind !== "geojson") throw new Error("expected geojson");
      const depths = res.body.data.features.map((f) => Number(f.properties?.v));
      expect(depths).toEqual([...depths].sort((a, b) => b - a));
      expect(res.body).toMatchObject({
        total: 2492,
        truncated: true,
        coverageNote:
          "Showing the 12 first of 2,492; zoom in under 40,000 km² for all; Latest manual measurement per well since 2021; depth is feet below land surface; zoom in under 12,000 km² to compare each well with its own record",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("drops the in-view cap note in wide mode and leaves the total out when the count fails", async () => {
    const many = { features: Array.from({ length: LIMIT }, (_, i) => fixture.features[i % fixture.features.length]) };
    const stub = vi.fn(async (url: string) => (new URL(url).searchParams.get("resulttype") === "hits" ? json({}, 500) : json(many)));
    const r = geojson(await layer.query({ ...ctx(stub), wide: true, wideStrategy: layer.wide }, {}));
    expect(r.total).toBeUndefined();
    expect(r.coverageNote).not.toMatch(/in no particular order/);
  });

  it("describes depth to water, the sign convention and that it is not a trend", () => {
    expect(layer.description).toMatch(/water table/);
    expect(layer.description).toMatch(/negative/);
    expect(layer.description).toMatch(/cannot show a trend/);
  });

  it("is one reading per well (no scrubber), colored by depth, with the three deepest labelled by their depth", () => {
    expect(layer.time).toEqual({ shape: "single" });
    expect(timeShapeOf(layer, { type: "FeatureCollection", features: normalizeWells(fixture) }).shape).toBe("single");
    expect(layer.style.encode).toEqual({ color: "v" });
    expect(legendOf(layer)).toMatchObject({ kind: "ramp", field: "v", unit: "ft below land surface" });
    expect(labelsOf(layer)).toEqual({ field: "depthLabel", max: 3, rankBy: "v" });
    expect(normalizeWells(fixture)[0].properties?.depthLabel).toBe("82 ft");
  });

  it("says the method in words and flags a depth over 1,500 ft as a probable error", () => {
    let n = 0;
    const row = (props: Record<string, unknown>) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [-100, 41] },
      properties: { monitoring_location_id: `USGS-${n++}`, value: "68.14", unit_of_measure: "ft", time: "2025-04-01", ...props },
    });
    const wells = normalizeWells({
      features: [
        row({ observing_procedure_code: "O", observing_procedure: "GW level, estim, report, observ" }),
        row({ observing_procedure_code: "V", observing_procedure: "GW level, calib electric tape" }),
        row({ observing_procedure: "GW level, steel tape" }),
        row({ value: "2976.72", observing_procedure_code: "S" }),
      ],
    });
    expect(wells.map((w) => w.properties?.method)).toEqual(["Reported or estimated (no tape reading)", "Calibrated electric tape", "Steel tape", "Steel tape"]);
    expect(wells[3].properties?.check).toMatch(/probably a data entry error/);
    expect(wells[0].properties?.check).toBeUndefined();
  });

  it("places the newest reading in the well's own record: share of earlier readings deeper than now, and its class", () => {
    const record = parseHistory(history);
    const site = record?.get("USGS-404046099504501") ?? [];
    expect(site.length).toBe(37);
    // 82.00 ft on 2025-06-10 against readings of 77 to 85 ft since 2006.
    const c = waterLevelPercentile(82, "2025-06-10", site);
    expect(c).toMatchObject({ since: 2006 });
    expect(c?.pct).toBeGreaterThan(0);
    expect(c?.pct).toBeLessThan(100);
    expect(waterLevelPercentile(82, "2025-06-10", site.slice(0, 5))).toBeUndefined();
    expect([5, 10, 24, 25, 75, 76, 90, 91, 100].map(levelOf)).toEqual(["much-below", "below", "below", "normal", "normal", "above", "above", "much-above", "much-above"]);
  });

  it("adds the comparison to every Kearney well with enough record, and says how many", async () => {
    const stub = vi.fn(async (url: string) => json(url.includes("/field-measurements/") ? history : fixture));
    const r = geojson(await layer.query(ctx(stub, { cacheKey: "k" }), {}));
    const hist = stub.mock.calls.map((c) => new URL(String(c[0]))).find((u) => u.pathname.endsWith("/field-measurements/items"));
    expect(hist?.searchParams.get("time")).toBe("2006-01-01T00:00:00Z/..");
    expect(hist?.searchParams.get("bbox")).toBe("-100.2,40.6,-99.8,40.9");
    expect(hist?.searchParams.get("skipGeometry")).toBe("true");
    const compared = r.data.features.filter((f) => typeof f.properties?.pct === "number");
    expect(compared.length).toBe(12);
    expect(compared[0].properties).toMatchObject({ level: expect.any(String), medianFt: expect.any(Number), recordSince: 2006 });
    expect(r.coverageNote).toContain("12 of 12 wells compared with their own readings since 2006");
  });

  it("leaves the comparison out when the history page is cut at its limit or the box is too big", async () => {
    expect(addContext(normalizeWells(fixture), new Map())).toBe(0);
    const full = { features: Array.from({ length: HISTORY_LIMIT }, () => history.features[0]) };
    const stub = vi.fn(async (url: string) => json(url.includes("/field-measurements/") ? full : fixture));
    const r = geojson(await layer.query(ctx(stub), {}));
    expect(r.data.features.some((f) => f.properties?.pct !== undefined)).toBe(false);
    const big = vi.fn(async () => json(fixture));
    const wide = geojson(await layer.query(ctx(big, { bbox: [-101, 40, -99, 41.5] }), {}));
    expect(big.mock.calls.some((c) => String(c[0]).includes("/field-measurements/"))).toBe(false);
    expect(wide.coverageNote).toContain("zoom in under 12,000 km² to compare each well with its own record");
  });
});
