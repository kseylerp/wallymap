import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import layer, { MAX_TRAILS, OVERPASS_WAY_LIMIT, buildOverpassQuery, normalizeOverpass, overpassFailure } from "./osm-trails";
import fixture from "./__fixtures__/osm-trails.tahoe.json";

const TAHOE: [number, number, number, number] = [-120.2, 38.85, -120, 39];

describe("osm-trails layer", () => {
  it("builds a query for highway=path|footway|track with out geom", () => {
    const q = buildOverpassQuery(TAHOE, { namedOnly: false });
    expect(q).toContain('["highway"~"^(path|footway|track)$"]');
    expect(q).toContain(`out geom ${OVERPASS_WAY_LIMIT};`);
    expect(q).toContain("(38.85,-120.2,39,-120)");
    expect(q).not.toContain('["name"]');
  });

  it("adds a name selector when namedOnly is true", () => {
    const q = buildOverpassQuery(TAHOE, { namedOnly: true });
    expect(q).toContain('["name"]');
  });

  it("normalizes fixture to LineStrings with trail tags", () => {
    const fc = normalizeOverpass(fixture);
    expect(fc.features.length).toBeGreaterThan(0);
    expect(fc.features[0].geometry.type).toBe("LineString");
    expect(fc.features.every((f) => typeof f.properties?.osmId === "string")).toBe(true);
    expect(fc.features.every((f) => /^way\/\d+$/.test(String(f.properties?.osmId)))).toBe(true);

    const way = fixture.elements[0];
    const first = fc.features[0];
    expect(first.properties?.osmId).toBe(`way/${way.id}`);
    if (first.geometry.type !== "LineString") throw new Error("expected LineString");
    expect(first.geometry.coordinates[0]).toEqual([way.geometry[0].lon, way.geometry[0].lat]);
  });

  it("rejects a bbox over 2500 km2 with zoom_in", async () => {
    const stub = vi.fn();
    const r = await layer.query(
      { bbox: [-122, 36, -119, 39], zoom: 7, env: {}, fetch: stub as unknown as CachedFetch },
      { namedOnly: false },
    );
    expect(r).toMatchObject({ hint: "zoom_in" });
    expect(stub).not.toHaveBeenCalled();
  });

  it("maps 429 to upstream error after fallback", async () => {
    const stub = vi.fn(async () => new Response("slow down", { status: 429 }));
    const r = await layer.query(
      { bbox: TAHOE, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch },
      { namedOnly: false },
    );
    expect(r).toMatchObject({ hint: "upstream", error: "Overpass returned 429" });
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("returns a cited FeatureCollection on success", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    const r = await layer.query(
      { bbox: TAHOE, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch },
      { namedOnly: false },
    );
    expect(stub).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ kind: "geojson" });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features.length).toBeGreaterThan(0);
    expect(r.citation.source).toBe("OpenStreetMap contributors (ODbL)");
  });

  it("passes ctx.cacheKey to the primary request and a fallback key to the retry", async () => {
    const stub = vi.fn(async () => new Response("slow down", { status: 429 }));
    await layer.query(
      { bbox: TAHOE, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch, cacheKey: "osm-trails:k" },
      { namedOnly: false },
    );
    const keys = stub.mock.calls.map((call: unknown[]) => (call[1] as { cacheKey?: string }).cacheKey);
    expect(keys[0]).toMatch(/^osm-trails:k:overpass:[0-9a-f]+$/);
    expect(keys[1]).toBe(`${keys[0]}:fallback`);
  });

  it("treats a blank OVERPASS_URL as unset", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    await layer.query(
      { bbox: TAHOE, zoom: 11, env: { OVERPASS_URL: "" }, fetch: stub as unknown as CachedFetch },
      { namedOnly: false },
    );
    expect(stub.mock.calls.map((call: unknown[]) => call[0])).toEqual(["https://overpass-api.de/api/interpreter"]);
  });

  it("sets a timeout on each request and reports a timeout as upstream", async () => {
    const stub = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const r = await layer.query(
      { bbox: TAHOE, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch },
      { namedOnly: false },
    );
    expect(r).toMatchObject({ hint: "upstream" });
    expect((r as { error: string }).error).toContain("timed out");
    expect(stub).toHaveBeenCalledTimes(2);
    for (const call of stub.mock.calls as unknown[][]) {
      expect((call[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("filters by sacScaleMax, keeping untagged and easier trails", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    const r = await layer.query(
      { bbox: TAHOE, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch },
      { namedOnly: false, sacScaleMax: "hiking" },
    );
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const scales = r.data.features.map((f) => f.properties?.sac_scale as string | undefined);
    expect(scales.every((s) => s === undefined || s === "hiking")).toBe(true);
    expect(r.data.features.length).toBeLessThan(normalizeOverpass(fixture).features.length);
  });

  it("retries a thrown network error against the public endpoint", async () => {
    const env = { OVERPASS_URL: "https://overpass.example.test/api/interpreter" };
    const stub = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(new Response(JSON.stringify(fixture), { status: 200 }));
    const r = await layer.query(
      { bbox: TAHOE, zoom: 11, env, fetch: stub as unknown as CachedFetch },
      { namedOnly: false },
    );
    expect(r).toMatchObject({ kind: "geojson" });
    expect(stub.mock.calls.map((c) => c[0])).toEqual([
      "https://overpass.example.test/api/interpreter",
      "https://overpass-api.de/api/interpreter",
    ]);
  });

  it("treats a 200 with a timeout remark as an upstream failure after retry", async () => {
    const remark = 'runtime error: Query timed out in "query" at line 1 after 26 seconds.';
    const stub = vi.fn(
      async () => new Response(JSON.stringify({ remark, elements: [] }), { status: 200 }),
    );
    const r = await layer.query(
      { bbox: TAHOE, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch },
      { namedOnly: false },
    );
    expect(r).toMatchObject({ hint: "upstream" });
    expect((r as { error: string }).error).toContain("Query timed out");
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("treats a 200 body with no elements array as an upstream failure", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify({ version: 0.6 }), { status: 200 }));
    const r = await layer.query(
      { bbox: TAHOE, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch },
      { namedOnly: false },
    );
    expect(r).toMatchObject({ hint: "upstream" });
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("overpassFailure accepts a good body and flags bad ones", () => {
    expect(overpassFailure(fixture)).toBeNull();
    expect(overpassFailure({ elements: [] })).toBeNull();
    expect(overpassFailure({ remark: "out of memory", elements: [] })).toBe("out of memory");
    expect(overpassFailure(null)).not.toBeNull();
  });

  it("caps a dense box at MAX_TRAILS, named trails first, with a coverage note", async () => {
    const way = (id: number, named: boolean) => ({
      type: "way",
      id,
      tags: { highway: "path", ...(named ? { name: `Trail ${id}` } : {}) },
      geometry: [
        { lat: 38.9, lon: -120.1 },
        { lat: 38.91, lon: -120.11 },
      ],
    });
    // Unnamed ways first in the body, so the named ones must be pulled forward.
    const elements = [
      ...Array.from({ length: MAX_TRAILS + 400 }, (_, i) => way(i, false)),
      ...Array.from({ length: 100 }, (_, i) => way(100_000 + i, true)),
    ];
    const stub = vi.fn(async () => new Response(JSON.stringify({ elements }), { status: 200 }));
    const r = await layer.query({ bbox: TAHOE, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch }, { namedOnly: false });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(MAX_TRAILS);
    expect(r.data.features.slice(0, 100).every((f) => typeof f.properties?.name === "string")).toBe(true);
    expect(r.coverageNote).toMatch(/^Showing 2,000 trails, named ones first/);
  });

  it("adds no coverage note when nothing was cut", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    const r = await layer.query({ bbox: TAHOE, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch }, { namedOnly: false });
    expect(r).not.toHaveProperty("coverageNote");
  });
});
