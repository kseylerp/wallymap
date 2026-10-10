import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { parseCounties } from "./_shared/counties";
import layer, { femaCountyFeatures, femaKind, femaUrl, gdacsFeatures, gdacsUrl, parseFema } from "./disasters";
import gdacsFixture from "./__fixtures__/gdacs-events.sample.json";
import femaFixture from "./__fixtures__/fema-declarations.tx.json";
import countiesFixture from "./__fixtures__/counties.houston.json";

/**
 * Recorded 2026-10-10: GDACS page 1 for FL, TC, DR (all levels) and WF (orange, red) over 90 days, trimmed to three US
 * Gulf cyclones plus two other events per kind; OpenFEMA Texas declarations since 2021-10-10, trimmed to the Houston
 * counties plus three elsewhere; Esri generalized counties for the Houston box.
 */
const HOUSTON: [number, number, number, number] = [-96, 29, -94.5, 30.5];
const GULF: [number, number, number, number] = [-100, 25, -80, 35];
const NOW = new Date("2026-10-10T10:00:00Z");

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function ctx(stub: ReturnType<typeof vi.fn>, bbox = HOUSTON) {
  return { bbox, zoom: 8, env: {}, fetch: stub as unknown as CachedFetch, cacheKey: "disasters:k" };
}

/** GDACS answers with the fixture's events of the requested type; page 2 ends the list like the real 204 does. */
function routed() {
  return vi.fn(async (url: string) => {
    if (url.includes("USA_Counties")) return json(countiesFixture);
    if (url.includes("fema.gov")) return json(femaFixture);
    const u = new URL(url);
    if (u.searchParams.get("pagenumber") !== "1") throw new TypeError("Response constructor: Invalid response status code 204");
    const code = u.searchParams.get("eventlist");
    return json({ type: "FeatureCollection", features: gdacsFixture.features.filter((f) => f.properties.eventtype === code) });
  });
}

function calls(stub: ReturnType<typeof vi.fn>) {
  return stub.mock.calls as unknown as [string, { cacheKey: string; ttlSeconds: number }][];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("GDACS", () => {
  it("builds the search URL and keeps events in the bbox as dated points", () => {
    expect(gdacsUrl("WF", "orange;red", "2026-07-12", "2026-10-10", 2)).toBe(
      "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=WF&alertlevel=orange;red&fromDate=2026-07-12&toDate=2026-10-10&pagenumber=2",
    );
    const f = gdacsFeatures(gdacsFixture.features, GULF);
    expect(f).toHaveLength(3);
    expect(f[0].properties).toMatchObject({
      source: "GDACS",
      kind: "cyclone",
      name: "Tropical Cyclone ISAIAS-26",
      alertLevel: "orange",
      t: "2026-10-06T21:00:00.000Z",
      country: "United States",
      url: expect.stringContaining("report.aspx?eventid="),
      footprintUrl: expect.stringContaining("getgeometry?eventtype=TC"),
    });
    expect(gdacsFeatures(gdacsFixture.features, [-180, -90, 180, 90]).length).toBe(gdacsFixture.features.length);
  });
});

describe("FEMA", () => {
  it("maps incident types onto the GDACS kinds where they overlap", () => {
    expect(femaKind("Fire")).toBe("wildfire");
    expect(femaKind("Hurricane")).toBe("cyclone");
    expect(femaKind("Severe Storm")).toBe("severe storm");
  });

  it("filters by date and state FIPS", () => {
    const u = new URL(femaUrl(["06", "32"], "2021-10-10"));
    expect(u.searchParams.get("$filter")).toBe("declarationDate ge '2021-10-10T00:00:00.000Z' and (fipsStateCode eq '06' or fipsStateCode eq '32')");
    expect(u.searchParams.get("$top")).toBe("10000");
  });

  it("joins declarations to county polygons by FIPS, counting each disaster once", () => {
    const counties = parseCounties(countiesFixture).counties;
    const f = femaCountyFeatures(parseFema(femaFixture), counties);
    const harris = f.find((x) => x.properties?.fips === "48201");
    expect(harris?.properties).toMatchObject({
      source: "FEMA",
      name: "Harris County",
      v: 2,
      kind: "cyclone",
      t: "2024-07-09T00:00:00.000Z",
      latest: "HURRICANE BERYL (DR-4798-TX)",
    });
    expect(String(harris?.properties?.declarations)).toMatch(/^2024-07-09 Hurricane: HURRICANE BERYL/);
    expect(f.every((x) => counties.some((c) => c.fips === x.properties?.fips))).toBe(true);
    expect(f.length).toBeGreaterThan(5);
  });
});

describe("disasters layer", () => {
  it("combines FEMA counties and GDACS points, with shared cache keys", async () => {
    const stub = routed();
    const r = await layer.query(ctx(stub), layer.input.parse({}));
    if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
    expect(r.data.features.filter((f) => f.properties?.source === "FEMA").length).toBeGreaterThan(5);
    expect(r.coverageNote).toBeUndefined();
    const c = calls(stub);
    const gdacs = c.filter(([u]) => u.includes("gdacs"));
    expect(gdacs.map(([u]) => new URL(u).searchParams.get("eventlist")).sort()).toEqual(["DR", "FL", "TC", "WF"]);
    expect(gdacs.find(([u]) => u.includes("eventlist=WF"))?.[0]).toContain("alertlevel=orange;red");
    expect(gdacs[0][1]).toMatchObject({ cacheKey: expect.stringMatching(/^disasters:gdacs:[A-Z]{2}:2026-07-12:2026-10-10:1$/), ttlSeconds: 3600 });
    const fema = c.find(([u]) => u.includes("fema.gov"));
    expect(fema?.[1]).toMatchObject({ cacheKey: "disasters:fema:48:2021-10-10", ttlSeconds: 21_600 });
  });

  it("pages GDACS until a short page and treats the closing 204 as the end", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ ...gdacsFixture.features[0], properties: { ...gdacsFixture.features[0].properties, eventid: i } }));
    const stub = vi.fn(async (url: string) => {
      if (!url.includes("gdacs")) return json({ type: "FeatureCollection", features: [] });
      const page = new URL(url).searchParams.get("pagenumber");
      if (page === "1") return json({ type: "FeatureCollection", features: full });
      throw new TypeError("Response constructor: Invalid response status code 204");
    });
    const r = await layer.query(ctx(stub, [-180, -80, 180, 80]), layer.input.parse({ days: 30 }));
    expect(r).toMatchObject({ kind: "geojson" });
    expect((r as { coverageNote?: string }).coverageNote ?? "").not.toMatch(/could not be loaded/);
    expect(calls(stub).filter(([u]) => u.includes("pagenumber=2")).length).toBe(4);
  });

  it("skips FEMA for big or foreign views and says so", async () => {
    const stub = routed();
    const r = await layer.query(ctx(stub, [-125, 24, -66, 50]), layer.input.parse({}));
    expect(r).toMatchObject({ coverageNote: expect.stringContaining("Zoom in to under 3,000,000 km² to add FEMA") });
    expect(calls(stub).some(([u]) => u.includes("fema.gov"))).toBe(false);
    const abroad = await layer.query(ctx(routed(), [100, 0, 130, 30]), layer.input.parse({}));
    expect((abroad as { coverageNote?: string }).coverageNote ?? "").not.toContain("FEMA");
  });

  it("errors when everything fails and notes a partial failure", async () => {
    const down = vi.fn(async () => new Response("no", { status: 503 }));
    expect(await layer.query(ctx(down), layer.input.parse({}))).toMatchObject({ hint: "upstream" });
    const femaDown = vi.fn(async (url: string) => (url.includes("fema.gov") ? new Response("no", { status: 500 }) : routed()(url)));
    const r = await layer.query(ctx(femaDown), layer.input.parse({}));
    expect(r).toMatchObject({ kind: "geojson", coverageNote: expect.stringContaining("FEMA declarations could not be loaded") });
  });

  it("describes kinds, sources, inputs and the user's words", () => {
    for (const word of ["GDACS", "FEMA", "cyclone", "alertLevel", "days", "years", "disasters", "hurricane"]) expect(layer.description).toContain(word);
    expect(layer.input.parse({})).toEqual({ days: 90, years: 5 });
  });
});
