import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { datetimeWindow, plumeFeatures, plumesUrl, sourceFeatures, sourcesUrl } from "./methane-plumes";
import plumesFixture from "./__fixtures__/carbonmapper-plumes.bakersfield.json";
import sourcesFixture from "./__fixtures__/carbonmapper-sources.bakersfield.json";

/** Recorded 2026-10-10 over Bakersfield for two years; signed image URLs and scene lists trimmed. */
const BAKERSFIELD: [number, number, number, number] = [-119.5, 35, -118.5, 36];
const NOW = new Date("2026-10-10T10:00:00Z");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function ctx(stub: ReturnType<typeof vi.fn>, bbox = BAKERSFIELD) {
  return { bbox, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch, cacheKey: "methane-plumes:k" };
}

const routed = () => vi.fn(async (url: string) => (url.includes("/plumes/annotated") ? json(plumesFixture) : json(sourcesFixture)));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("methane-plumes", () => {
  it("builds bbox-repeated, CH4, dated, capped URLs", () => {
    expect(datetimeWindow(730, NOW.getTime())).toBe("2024-10-10T00:00:00Z/2026-10-10T23:59:59Z");
    const p = plumesUrl(BAKERSFIELD, 730, NOW.getTime());
    expect(p).toContain("plumes/annotated?bbox=-119.5&bbox=35&bbox=-118.5&bbox=36&plume_gas=CH4&status=published&sort=emissions_desc");
    expect(p).toContain("limit=200");
    expect(new URL(p).searchParams.get("datetime")).toBe("2024-10-10T00:00:00Z/2026-10-10T23:59:59Z");
    expect(sourcesUrl(BAKERSFIELD, 90, NOW.getTime())).toContain("sources.geojson?bbox=-119.5&bbox=35&bbox=-118.5&bbox=36&plume_gas=CH4&datetime=");
  });

  it("turns plumes into points with time, kg/h and plain-word sector, withholding hidden rates", () => {
    const f = plumeFeatures(plumesFixture.items);
    expect(f).toHaveLength(6);
    expect(f[0].properties).toMatchObject({
      kind: "plume",
      plumeId: "tan20250421t192349c00s4001-A",
      t: "2025-04-21T19:23:49.000Z",
      v: 2544.9,
      sector: "oil and gas",
      platform: expect.any(String),
    });
    expect(f[0].geometry.coordinates).toEqual([-119.45857637780027, 35.293902753771164]);
    expect(f.find((x) => x.properties?.plumeId === "tan20250203t191818c00s4001-B")?.properties?.sector).toBe("landfill");
    const hidden = f.find((x) => x.properties?.plumeId === "av320241025t194701-B");
    expect(hidden?.properties?.v).toBeUndefined();
    expect(hidden?.properties?.sector).toBe("livestock (manure)");
  });

  it("turns sources into points with mean rate, last seen, persistence and a clean name", () => {
    const f = sourceFeatures(sourcesFixture.features);
    expect(f).toHaveLength(5);
    expect(f[0].properties).toMatchObject({ kind: "source", v: 658.2, t: "2024-10-25T00:00:00.000Z", plumeCount: 1, persistence: 0.5 });
    expect(String(f[0].properties?.sourceName)).toBe("CH4_1B2_250m_-119.16434_35.39886");
    const landfill = f.find((x) => x.properties?.sector === "landfill");
    expect(landfill?.properties).toMatchObject({ plumeCount: 16, persistence: 1, firstSeen: "2024-10-15" });
  });

  it("queries plumes and sources in parallel, cached 6 hours, and notes the cap", async () => {
    const stub = routed();
    const r = await layer.query(ctx(stub), layer.input.parse({}));
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(11);
    expect(r.data.features[0].properties?.kind).toBe("source");
    expect(r.coverageNote).toMatch(/Showing the 6 largest of 204 plumes/);
    expect(r.citation.source).toContain("Data by Carbon Mapper");
    const calls = stub.mock.calls as unknown as [string, { cacheKey: string; ttlSeconds: number }][];
    expect(calls.map((c) => c[1].cacheKey).sort()).toEqual(["methane-plumes:k:plumes", "methane-plumes:k:sources"]);
    for (const [, init] of calls) expect(init.ttlSeconds).toBe(21_600);
  });

  it("keeps going with one half down and errors with both down", async () => {
    const half = vi.fn(async (url: string) => (url.includes("sources") ? json({}, 500) : json(plumesFixture)));
    const r = await layer.query(ctx(half), layer.input.parse({}));
    expect(r).toMatchObject({ kind: "geojson", coverageNote: expect.stringContaining("Sources could not be loaded") });
    const down = vi.fn(async () => json({}, 503));
    expect(await layer.query(ctx(down), layer.input.parse({}))).toMatchObject({ hint: "upstream" });
  });

  it("says when nothing was seen", async () => {
    const empty = vi.fn(async (url: string) =>
      url.includes("/plumes/") ? json({ bbox_count: 0, items: [] }) : json({ type: "FeatureCollection", features: [] }),
    );
    const r = await layer.query(ctx(empty), layer.input.parse({ days: 90 }));
    expect(r).toMatchObject({ coverageNote: expect.stringContaining("No methane plumes seen here in the last 90 days (or not yet observed)") });
    expect((r as { coverageNote: string }).coverageNote).toMatch(/^kind 'plume' is one sighting \(v = kg\/h then\)/);
  });

  it("describes the unit, kinds, licence and words for the model", () => {
    for (const word of ["kg/h", "plume", "source", "persistence", "methane", "emissions", "super-emitter"]) expect(layer.description).toContain(word);
    expect(layer.license).toContain("non-commercial");
    expect(layer.license).toContain("Data by Carbon Mapper");
  });

  it("declares a wide strategy ranked by emission rate, and rejects a box over the 2,000,000 km² hard cap through runLayer", async () => {
    expect(layer.maxAreaKm2).toBe(500_000);
    expect(layer.wide).toEqual({ orderBy: "emission rate in kg/h", limit: 1000 });
    expect((await runLayer("methane-plumes", { bbox: [-125, 25, -65, 50] })).status).toBe(422);
  });

  it("answers a wide box (about 1,000,000 km²) with the 500 largest plumes and sources and the combined total", async () => {
    const stub = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/plumes/annotated") ? json({ ...plumesFixture, bbox_count: 1646 }) : json(sourcesFixture),
    );
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("methane-plumes", { bbox: [-110, 28, -98, 36], zoom: 5 });
      expect(res.status).toBe(200);
      const plumes = stub.mock.calls.map((c) => new URL(String(c[0]))).find((u) => u.pathname.endsWith("/plumes/annotated"));
      expect(plumes?.searchParams.get("sort")).toBe("emissions_desc");
      expect(plumes?.searchParams.get("limit")).toBe("500");
      expect(res.body).toMatchObject({
        total: 1646 + 5,
        truncated: true,
        coverageNote: expect.stringMatching(/^Showing the 11 largest of 1,651 \(ranked by emission rate in kg\/h\); zoom in under 500,000 km² for all; kind 'plume'/),
      });
      expect((res.body as { coverageNote: string }).coverageNote).not.toMatch(/largest of 1646 plumes/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
