import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { LIMIT, SPARQL_ENDPOINT, lakesQuery, normalizeLakes } from "./lakes";
import fixture from "./__fixtures__/lakes.tahoe.json";

/** The fixture is a real Wikidata SPARQL answer for this box (recorded 2026-10-09 with the layer's own query, no name filter). */
const TAHOE: [number, number, number, number] = [-120.2, 38.8, -119.8, 39.2];
const bindings = fixture.results.bindings;
/** An item with two coordinate statements comes back as two rows; the layer keeps one point per item. */
const uniqueItems = new Set(bindings.map((b) => b.item.value)).size;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string) {
  return { bbox: TAHOE, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

function geojson(r: Awaited<ReturnType<typeof layer.query>>) {
  if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
  return r;
}

describe("lakesQuery", () => {
  it("puts the corners as Point(lon lat), asks for normalised values and caps the rows", () => {
    const q = lakesQuery(TAHOE);
    expect(q).toContain('wikibase:cornerSouthWest "Point(-120.2 38.8)"^^geo:wktLiteral');
    expect(q).toContain('wikibase:cornerNorthEast "Point(-119.8 39.2)"^^geo:wktLiteral');
    expect(q).toContain("p:P4511/psn:P4511/wikibase:quantityAmount");
    expect(q).toContain("wd:Q23397");
    expect(q).toContain("wd:Q131681");
    expect(q).toContain(`LIMIT ${LIMIT}`);
    expect(q).not.toContain("CONTAINS");
  });

  it("adds a lower-cased, escaped name filter", () => {
    expect(lakesQuery(TAHOE, "  Tahoe ")).toContain('FILTER(CONTAINS(LCASE(STR(?label)), "tahoe"))');
    expect(lakesQuery(TAHOE, 'a"b\\c')).toContain('"a\\"b\\\\c"');
  });
});

describe("normalizeLakes", () => {
  const features = normalizeLakes(bindings);

  it("turns Lake Tahoe into a point with depth in v and the other measures in friendly units", () => {
    expect(bindings.length).toBeGreaterThan(uniqueItems);
    expect(features).toHaveLength(uniqueItems);
    const tahoe = features.find((f) => f.properties?.name === "Lake Tahoe");
    expect(tahoe?.geometry).toEqual({ type: "Point", coordinates: [-120.033333333, 39.083333333] });
    expect(tahoe?.properties).toMatchObject({
      v: 501,
      depthM: 501,
      kind: "lake",
      areaKm2: 502,
      elevationM: 1899.5,
      volumeKm3: 150,
      wikipedia: "https://en.wikipedia.org/wiki/Lake_Tahoe",
      wikidata: "Q169962",
      url: "https://www.wikidata.org/wiki/Q169962",
    });
  });

  it("gives null depth, not zero, when Wikidata has none, and marks reservoirs", () => {
    const cascade = features.find((f) => f.properties?.name === "Cascade Lake");
    expect(cascade?.properties).toMatchObject({ v: null, depthM: null, kind: "lake" });
    expect(cascade?.properties).not.toHaveProperty("areaKm2");
    const spooner = features.find((f) => f.properties?.name === "Spooner Lake");
    expect(spooner?.properties?.kind).toBe("reservoir");
  });

  it("drops unnamed items, repeated ids and bad coordinates, and ignores non-positive numbers", () => {
    const item = (q: string) => ({ value: `http://www.wikidata.org/entity/${q}` });
    const out = normalizeLakes([
      { item: item("Q1"), label: { value: "Q1" }, coord: { value: "Point(-120 39)" } },
      { item: item("Q2"), coord: { value: "Point(-120 39)" } },
      { item: item("Q3"), label: { value: "Good Lake" }, coord: { value: "Point(-120.5 39.5)" }, depth: { value: "12.34" }, area: { value: "0" } },
      { item: item("Q3"), label: { value: "Good Lake" }, coord: { value: "Point(-120.5 39.5)" } },
      { item: item("Q4"), label: { value: "Odd Lake" }, coord: { value: "somewhere" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].properties).toMatchObject({ name: "Good Lake", v: 12.3, wikidata: "Q3" });
    expect(out[0].properties).not.toHaveProperty("areaKm2");
  });
});

describe("lakes layer", () => {
  it("declares global coverage, CC0, no env, a name input and the cluster hint", () => {
    expect(layer.id).toBe("lakes");
    expect(layer.coverage).toBe("global");
    expect(layer.license).toBe("CC0 (Wikidata)");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(20_000);
    expect(layer.input.parse({})).toEqual({});
    expect(layer.input.parse({ name: " tahoe " })).toEqual({ name: "tahoe" });
    expect(layer.style).toMatchObject({ geometry: "point", cluster: true, unit: "m" });
  });

  it("POSTs the query with a descriptive User-Agent, the name filter and the cache key", async () => {
    const stub = vi.fn(async () => json(fixture));
    const r = geojson(await layer.query(ctx(stub, "lakes:key"), { name: "tahoe" }));
    expect(r.data.features).toHaveLength(uniqueItems);
    expect(r.citation.source).toContain("Wikidata");
    expect(r.coverageNote).toContain("1 of 27 lakes have a recorded maximum depth");

    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit & { cacheKey?: string }];
    expect(url).toBe(SPARQL_ENDPOINT);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["user-agent"]).toContain("WildMap");
    const query = new URLSearchParams(String(init.body)).get("query");
    expect(query).toContain("Point(-120.2 38.8)");
    expect(query).toContain('"tahoe"');
    expect(init.cacheKey).toBe("lakes:key");
  });

  it("says when the 500 lake cap is hit", async () => {
    const many = Array.from({ length: LIMIT }, (_, i) => bindings[i % bindings.length]);
    const stub = vi.fn(async () => json({ results: { bindings: many } }));
    const r = geojson(await layer.query(ctx(stub), {}));
    expect(r.coverageNote).toContain(`${LIMIT} largest lakes`);
  });

  it("says so when nothing is found, naming the filter", async () => {
    const stub = vi.fn(async () => json({ results: { bindings: [] } }));
    expect(geojson(await layer.query(ctx(stub), {})).coverageNote).toBe("No named lakes in Wikidata for this area");
    expect(geojson(await layer.query(ctx(stub), { name: "zzz" })).coverageNote).toBe("No lake named like 'zzz' in Wikidata for this area");
  });

  it("maps rate limiting, errors and timeouts to hinted errors", async () => {
    expect(await layer.query(ctx(vi.fn(async () => new Response("slow down", { status: 429 }))), {})).toEqual({
      error: "Wikidata is rate-limiting requests; try again in a minute",
      hint: "upstream",
    });
    expect(await layer.query(ctx(vi.fn(async () => new Response("boom", { status: 500 }))), {})).toEqual({
      error: "Wikidata returned 500",
      hint: "upstream",
    });
    expect(await layer.query(ctx(vi.fn(async () => new Response("<html>"))), {})).toMatchObject({ hint: "upstream" });
    expect(await layer.query(ctx(vi.fn(async () => json({ head: {} }))), {})).toEqual({
      error: "Wikidata returned an unexpected response",
      hint: "upstream",
    });
    const slow = vi.fn(async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    expect(await layer.query(ctx(slow), {})).toMatchObject({ error: expect.stringContaining("timed out"), hint: "upstream" });
  });

  it("rejects a view over the area cap through runLayer", async () => {
    const r = await runLayer("lakes", { bbox: [-110, 35, -105, 40] });
    expect(r.status).toBe(422);
  });
});
