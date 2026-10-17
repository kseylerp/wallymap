import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { SPARQL_ENDPOINT, normalizePeaks, peaksQuery, widePeaksQuery } from "./peaks";
import fixture from "./__fixtures__/peaks.tahoe.json";

/** The fixture is a real Wikidata SPARQL answer for this box (recorded 2026-10-09 with the layer's own query). */
vi.mock("./_shared/wikimedia", async (importOriginal) => {
  const real = await importOriginal<typeof import("./_shared/wikimedia")>();
  return { ...real, wikimediaFetch: (f: never, u: string, i?: never) => real.wikimediaFetch(f, u, i, { sleep: async () => {} }) };
});

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

describe("peaksQuery", () => {
  it("puts the south-west and north-east corners as Point(lon lat) and asks for normalised metres", () => {
    const q = peaksQuery(TAHOE);
    expect(q).toContain('wikibase:cornerSouthWest "Point(-120.2 38.8)"^^geo:wktLiteral');
    expect(q).toContain('wikibase:cornerNorthEast "Point(-119.8 39.2)"^^geo:wktLiteral');
    expect(q).toContain("p:P2044/psn:P2044/wikibase:quantityAmount");
    expect(q).toContain("p:P2660/psn:P2660/wikibase:quantityAmount");
    expect(q).toContain("wd:Q8502");
    expect(q).toContain("ORDER BY DESC(?elev) DESC(?prom)");
    expect(q).toContain("wdt:P1705");
    expect(q).toContain('wikibase:language "en,mul"');
    expect(q).toContain("LIMIT 1000");
  });
});

describe("widePeaksQuery", () => {
  it("starts from items with a prominence, filters to the box and ranks by prominence with a little slack for unnamed rows", () => {
    const q = widePeaksQuery([-108.5, 37, -104.5, 41], 1000);
    expect(q).toContain("p:P2660/psn:P2660/wikibase:quantityAmount ?promM");
    expect(q).toContain("geof:longitude(?c) >= -108.5 && geof:longitude(?c) <= -104.5 && geof:latitude(?c) >= 37 && geof:latitude(?c) <= 41");
    expect(q).not.toContain("wikibase:box");
    expect(q).toContain("wdt:P31/wdt:P279* ?cls");
    expect(q.trimEnd().endsWith("ORDER BY DESC(?prom)\nLIMIT 1050")).toBe(true);
  });
});

describe("normalizePeaks", () => {
  const features = normalizePeaks(bindings);

  it("turns each named item into a point with elevation, prominence and v = elevation", () => {
    expect(bindings.length).toBeGreaterThan(uniqueItems);
    expect(features).toHaveLength(uniqueItems);
    const freel = features.find((f) => f.properties?.name === "Freel Peak");
    expect(freel?.geometry).toEqual({ type: "Point", coordinates: [-119.9, 38.8575] });
    expect(freel?.properties).toMatchObject({
      elevation: 3318,
      prominence: 959,
      v: 3318,
      url: expect.stringMatching(/^https:\/\/www\.wikidata\.org\/wiki\/Q\d+$/),
    });
    expect(freel?.properties).not.toHaveProperty("rankedBy");
  });

  it("uses elevation for v on every peak that has one and leaves v off the rest", () => {
    for (const f of features) {
      const p = f.properties ?? {};
      if (p.elevation !== undefined) expect(p.v).toBe(p.elevation);
      else expect(p).not.toHaveProperty("v");
    }
    const prominenceOnly = features.find((f) => f.properties?.prominence !== undefined && f.properties?.elevation === undefined);
    const elevationOnly = features.find((f) => f.properties?.elevation !== undefined && f.properties?.prominence === undefined);
    expect(elevationOnly?.properties).toHaveProperty("v");
    if (prominenceOnly) expect(prominenceOnly.properties).not.toHaveProperty("v");
    const bare = features.find((f) => f.properties?.name === "Becker Peak");
    expect(bare?.properties).not.toHaveProperty("v");
  });

  it("falls back to the native label when there is no English one", () => {
    const item = (q: string) => ({ value: `http://www.wikidata.org/entity/${q}` });
    const out = normalizePeaks([
      { item: item("Q10"), itemLabel: { value: "Q10" }, native: { value: "Cerro Torre" }, coord: { value: "Point(-73.1 -49.3)" }, elev: { value: "3128" } },
      { item: item("Q11"), itemLabel: { value: "Q11" }, coord: { value: "Point(-73 -49)" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].properties).toMatchObject({ name: "Cerro Torre", v: 3128 });
  });

  it("lists one summit once when Wikidata holds it twice at one point (Mount Watkins), keeping the one with the elevation", () => {
    const item = (q: string) => ({ value: `http://www.wikidata.org/entity/${q}` });
    const out = normalizePeaks([
      { item: item("Q3322181"), itemLabel: { value: "Mount Watkins" }, coord: { value: "Point(-119.5176494 37.7828327)" }, elev: { value: "2590" } },
      { item: item("Q131056543"), itemLabel: { value: "Mount Watkins" }, coord: { value: "Point(-119.5176494 37.7828327)" } },
      { item: item("Q99"), itemLabel: { value: "Mount Watkins" }, coord: { value: "Point(-110 40)" } },
    ]);
    expect(out.map((f) => f.properties?.wikidata)).toEqual(["Q3322181", "Q99"]);
  });

  it("drops unnamed items, repeated ids and bad coordinates", () => {
    const item = (q: string) => ({ value: `http://www.wikidata.org/entity/${q}` });
    const out = normalizePeaks([
      { item: item("Q1"), itemLabel: { value: "Q1" }, coord: { value: "Point(-120 39)" } },
      { item: item("Q2"), coord: { value: "Point(-120 39)" } },
      { item: item("Q3"), itemLabel: { value: "Good Peak" }, coord: { value: "Point(-120.5 39.5)" }, elev: { value: "2500.4" } },
      { item: item("Q3"), itemLabel: { value: "Good Peak" }, coord: { value: "Point(-120.5 39.5)" } },
      { item: item("Q4"), itemLabel: { value: "Odd Peak" }, coord: { value: "somewhere" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].properties).toMatchObject({ name: "Good Peak", elevation: 2500, v: 2500, wikidata: "Q3" });
  });
});

describe("peaks layer", () => {
  it("declares global coverage, CC0, no env and the extrude hint", () => {
    expect(layer.id).toBe("peaks");
    expect(layer.coverage).toBe("global");
    expect(layer.license).toBe("CC0 (Wikidata)");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(40_000);
    expect(layer.hardMaxAreaKm2).toBe(600_000);
    expect(layer.wide).toEqual({ orderBy: "prominence", rank: "most prominent", limit: 1000 });
    expect(layer.input.parse({})).toEqual({});
    expect(layer.style).toMatchObject({ geometry: "point", extrude: "v", unit: "m" });
  });

  it("POSTs the query with a descriptive User-Agent and the cache key", async () => {
    const stub = vi.fn(async () => json(fixture));
    const r = geojson(await layer.query(ctx(stub, "peaks:key"), {}));
    expect(r.data.features).toHaveLength(uniqueItems);
    expect(r.citation.source).toContain("Wikidata");
    expect(r.coverageNote).toBeUndefined();

    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit & { cacheKey?: string }];
    expect(url).toBe(SPARQL_ENDPOINT);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["user-agent"]).toBe("WallyMap/0.1 (https://wallymap.vercel.app)");
    expect(new URLSearchParams(String(init.body)).get("query")).toContain("Point(-120.2 38.8)");
    expect(init.cacheKey).toBe("peaks:key");
  });

  it("says when the 1,000 peak cap is hit", async () => {
    const many = Array.from({ length: 1000 }, (_, i) => bindings[i % bindings.length]);
    const stub = vi.fn(async () => json({ results: { bindings: many } }));
    const r = geojson(await layer.query(ctx(stub), {}));
    expect(r.coverageNote).toContain("1,000 highest peaks");
  });

  it("says so when nothing is found", async () => {
    const stub = vi.fn(async () => json({ results: { bindings: [] } }));
    const r = geojson(await layer.query(ctx(stub), {}));
    expect(r.data.features).toEqual([]);
    expect(r.coverageNote).toBe("No named peaks in Wikidata for this area");
  });

  it("retries once when Wikidata says 429 and returns the answer", async () => {
    let calls = 0;
    const stub = vi.fn(async () => (++calls === 1 ? new Response("slow", { status: 429 }) : json(fixture)));
    const r = geojson(await layer.query(ctx(stub), {}));
    expect(stub).toHaveBeenCalledTimes(2);
    expect(r.data.features).toHaveLength(uniqueItems);
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

  it("rejects a view over the hard cap (600,000 km², a whole range) through runLayer", async () => {
    const r = await runLayer("peaks", { bbox: [-115, 33, -103, 45] });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ hint: "zoom_in", error: expect.stringMatching(/zoom in to under 600000 km²$/) });
  });

  it("answers a Colorado box of about 155,000 km² wide: the most prominent, ranked by prominence, with a note", async () => {
    const stub = vi.fn(async () => json(fixture));
    vi.stubGlobal("fetch", stub);
    try {
      const r = await runLayer("peaks", { bbox: [-108.5, 37, -104.5, 41], zoom: 6 });
      expect(r.status).toBe(200);
      const init = stub.mock.calls[0] as unknown as [string, RequestInit];
      const query = new URLSearchParams(String(init[1].body)).get("query") ?? "";
      expect(query).toContain("ORDER BY DESC(?prom)\nLIMIT 1050");
      expect(r.body).toMatchObject({
        coverageNote: `Showing all ${uniqueItems} in this wide view (ranked by prominence); only peaks with a recorded prominence are listed at this scale`,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps at most the wide limit and leaves the truncation note to run.ts", async () => {
    const item = (i: number) => ({
      item: { value: `http://www.wikidata.org/entity/Q${i}` },
      itemLabel: { value: `Peak ${i}` },
      coord: { value: "Point(-106 39)" },
      prom: { value: String(3000 - i) },
    });
    const stub = vi.fn(async () => json({ results: { bindings: Array.from({ length: 1050 }, (_, i) => item(i)) } }));
    const r = geojson(await layer.query({ ...ctx(stub), wide: true, wideStrategy: layer.wide }, {}));
    expect(r.data.features).toHaveLength(1000);
    expect(r.data.features[0].properties).toMatchObject({ name: "Peak 0", prominence: 3000 });
    expect(r.coverageNote).toBe("only peaks with a recorded prominence are listed at this scale");
  });
});
