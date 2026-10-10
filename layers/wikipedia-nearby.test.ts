import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { articleUrl, buildFeatures, cellsOf, cleanExtract, extractsUrl, geosearchUrl } from "./wikipedia-nearby";
import geoFixture from "./__fixtures__/wikipedia-nearby.geosearch.json";
import extractsFixture from "./__fixtures__/wikipedia-nearby.extracts.json";

/** Fixtures are real English Wikipedia answers for this box (South Lake Tahoe), recorded 2026-10-09: 23 articles, 20 extracts. */
vi.mock("./_shared/wikimedia", async (importOriginal) => {
  const real = await importOriginal<typeof import("./_shared/wikimedia")>();
  return { ...real, wikimediaFetch: (f: never, u: string, i?: never) => real.wikimediaFetch(f, u, i, { sleep: async () => {} }) };
});

const SLT: [number, number, number, number] = [-120.02, 38.9, -119.94, 38.97];
const hits = geoFixture.query.geosearch;
const pages = extractsFixture.query.pages as Record<string, { pageid: number; extract?: string; thumbnail?: { source: string } }>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Geosearch answers with the geosearch fixture; extracts answer with the fixture pages whose ids were asked for. */
function routed(overrides: { geo?: () => Response; extracts?: (url: string) => Response } = {}) {
  return vi.fn(async (url: string) => {
    if (url.includes("list=geosearch")) return overrides.geo ? overrides.geo() : json(geoFixture);
    if (url.includes("prop=extracts")) {
      if (overrides.extracts) return overrides.extracts(url);
      const asked = new URL(url).searchParams.get("pageids")?.split("|") ?? [];
      const out: Record<string, unknown> = {};
      for (const id of asked) if (pages[id]) out[id] = pages[id];
      return json({ query: { pages: out } });
    }
    throw new Error(`unexpected url ${url}`);
  });
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string, bbox = SLT) {
  return { bbox, zoom: 12, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

function geojson(r: Awaited<ReturnType<typeof layer.query>>) {
  if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
  return r;
}

describe("urls", () => {
  it("orders gsbbox as north|west|south|east and asks for the main namespace", () => {
    expect(geosearchUrl(SLT)).toBe(
      "https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gsbbox=38.97|-120.02|38.9|-119.94" +
        "&gsnamespace=0&gslimit=500&format=json",
    );
    expect(geosearchUrl(SLT, "fr").startsWith("https://fr.wikipedia.org/")).toBe(true);
  });

  it("asks for two-sentence intro extracts and 320 px thumbnails for the page ids", () => {
    const url = new URL(extractsUrl([1, 2, 3]));
    expect(url.searchParams.get("pageids")).toBe("1|2|3");
    expect(url.searchParams.get("prop")).toBe("extracts|pageimages");
    expect(url.searchParams.get("exsentences")).toBe("2");
    expect(url.searchParams.get("exintro")).toBe("1");
    expect(url.searchParams.get("explaintext")).toBe("1");
    expect(url.searchParams.get("pithumbsize")).toBe("320");
  });

  it("builds article links from the title", () => {
    expect(articleUrl("Lake Tahoe")).toBe("https://en.wikipedia.org/wiki/Lake_Tahoe");
    expect(articleUrl("South Lake Tahoe, California")).toBe("https://en.wikipedia.org/wiki/South_Lake_Tahoe%2C_California");
    expect(articleUrl("Category:Foo/Bar")).toBe("https://en.wikipedia.org/wiki/Category:Foo/Bar");
  });
});

describe("cellsOf", () => {
  it("keeps a small view as one cell and cuts a large one into cells of at most 18 km", () => {
    expect(cellsOf(SLT)).toEqual({ cells: [SLT], total: 1 });
    const { cells, total } = cellsOf([-120.4, 38.7, -119.9, 39.1]); // about 43 by 44 km
    expect(total).toBe(9);
    expect(cells.length).toBe(9);
    for (const [w, s, e, n] of cells) {
      expect((n - s) * 110.57).toBeLessThanOrEqual(18.01);
      expect((e - w) * 111.32 * Math.cos((38.9 * Math.PI) / 180)).toBeLessThanOrEqual(18.01);
    }
  });

  it("caps the number of cells, keeping the ones nearest the centre", () => {
    const view: [number, number, number, number] = [-121, 38, -119, 40]; // about 170 by 220 km
    const { cells, total } = cellsOf(view);
    expect(total).toBeGreaterThan(64);
    expect(cells).toHaveLength(64);
    const small = cellsOf(view, 4);
    expect(small.cells).toHaveLength(4);
    for (const [w, s, e, n] of small.cells) {
      expect((w + e) / 2).toBeGreaterThan(-120.3);
      expect((w + e) / 2).toBeLessThan(-119.7);
      expect((s + n) / 2).toBeGreaterThan(38.8);
      expect((s + n) / 2).toBeLessThan(39.2);
    }
  });
});

describe("cleanExtract", () => {
  it("removes the empty brackets left by stripped pronunciations and collapses spaces", () => {
    expect(cleanExtract("Lake Tahoe () is a freshwater lake.  It is large .")).toBe("Lake Tahoe is a freshwater lake. It is large.");
    expect(cleanExtract("Foo (; ) bar")).toBe("Foo bar");
  });

  it("clips long text with an ellipsis", () => {
    const out = cleanExtract("word ".repeat(200));
    expect(out.length).toBeLessThanOrEqual(420);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("buildFeatures", () => {
  it("joins hits to summaries and leaves extract and thumbnail off when unknown", () => {
    const features = buildFeatures(
      [
        { pageid: 1, title: "Lake Tahoe", lat: 39, lon: -120 },
        { pageid: 2, title: "Ghost", lat: 39.1, lon: -120.1 },
      ],
      new Map([[1, { extract: "A lake.", thumbnail: "https://thumb.example/a.jpg" }]]),
    );
    expect(features[0].geometry).toEqual({ type: "Point", coordinates: [-120, 39] });
    expect(features[0].properties).toEqual({
      name: "Lake Tahoe",
      title: "Lake Tahoe",
      url: "https://en.wikipedia.org/wiki/Lake_Tahoe",
      extract: "A lake.",
      thumbnail: "https://thumb.example/a.jpg",
    });
    expect(features[1].properties).toEqual({ name: "Ghost", title: "Ghost", url: "https://en.wikipedia.org/wiki/Ghost" });
  });
});

describe("wikipedia-nearby layer", () => {
  it("declares global coverage, CC BY-SA, no env, a lang input and the cluster hint", () => {
    expect(layer.id).toBe("wikipedia-nearby");
    expect(layer.coverage).toBe("global");
    expect(layer.license).toContain("CC BY-SA 4.0");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(1_000);
    expect(layer.input.parse({})).toEqual({ lang: "en" });
    expect(() => layer.input.parse({ lang: "en.evil.com/" })).toThrow();
    expect(layer.style).toMatchObject({ geometry: "point", cluster: true });
  });

  it("returns every article with its extract and thumbnail, fetching extracts in batches of 20", async () => {
    const stub = routed();
    const r = geojson(await layer.query(ctx(stub, "wikipedia-nearby:key"), { lang: "en" }));
    expect(r.data.features).toHaveLength(hits.length);
    expect(r.coverageNote).toBeUndefined();

    const urls = stub.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes("list=geosearch"))).toHaveLength(1);
    expect(urls.filter((u) => u.includes("prop=extracts"))).toHaveLength(2); // 23 articles = 20 + 3

    const lake = r.data.features.find((f) => f.properties?.title === "South Lake Tahoe, California");
    expect(lake?.properties?.extract).toContain("South Lake Tahoe is the most populous city");
    expect(lake?.properties?.thumbnail).toMatch(/^https:\/\/thumb\.wikimedia\.org\//);
    expect(lake?.properties?.url).toBe("https://en.wikipedia.org/wiki/South_Lake_Tahoe%2C_California");
    // The 3 articles past the first 20 got no summary but are still on the map.
    expect(r.data.features.filter((f) => f.properties?.extract === undefined).length).toBeGreaterThanOrEqual(3);

    const keys = (stub.mock.calls as unknown as [string, { cacheKey?: string; headers?: Record<string, string> }][]).map((c) => c[1].cacheKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => k?.startsWith("wikipedia-nearby:key:"))).toBe(true);
    expect((stub.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1].headers["user-agent"]).toBe("WallyMap/0.1 (https://wallymap.vercel.app)");
    expect(r.citation.source).toContain("CC BY-SA 4.0");
  });

  it("uses the chosen language edition", async () => {
    const stub = routed();
    const r = geojson(await layer.query(ctx(stub), { lang: "fr" }));
    expect(stub.mock.calls.every((c) => String(c[0]).startsWith("https://fr.wikipedia.org/"))).toBe(true);
    expect(r.data.features[0].properties?.url).toMatch(/^https:\/\/fr\.wikipedia\.org\/wiki\//);
  });

  it("keeps the 100 articles nearest the centre when there are more", async () => {
    const many = Array.from({ length: 130 }, (_, i) => ({
      pageid: 1000 + i,
      ns: 0,
      title: `Place ${i}`,
      lat: 38.9 + (i % 13) * 0.005,
      lon: -120.02 + Math.floor(i / 13) * 0.008,
    }));
    const stub = routed({ geo: () => json({ query: { geosearch: many } }) });
    const r = geojson(await layer.query(ctx(stub), { lang: "en" }));
    expect(r.data.features).toHaveLength(100);
    expect(r.coverageNote).toContain("100 of 130 articles nearest the centre");
    expect(stub.mock.calls.filter((c) => String(c[0]).includes("prop=extracts"))).toHaveLength(5);
  });

  it("retries a rate-limited search once", async () => {
    let calls = 0;
    const stub = vi.fn(async (url: string) => {
      if (url.includes("list=geosearch")) return ++calls === 1 ? new Response("slow", { status: 429 }) : json(geoFixture);
      return json({ query: { pages: {} } });
    });
    const r = geojson(await layer.query(ctx(stub), { lang: "en" }));
    expect(r.data.features).toHaveLength(hits.length);
    expect(calls).toBe(2);
  });

  it("falls back to title and link when the summaries fail", async () => {
    const stub = routed({ extracts: () => new Response("slow down", { status: 429 }) });
    const r = geojson(await layer.query(ctx(stub), { lang: "en" }));
    expect(r.data.features).toHaveLength(hits.length);
    expect(r.data.features.every((f) => f.properties?.extract === undefined)).toBe(true);
    expect(r.coverageNote).toBe(
      "Article summaries could not be loaded (Wikipedia is rate-limiting requests), so those points have a title and link only",
    );
  });

  it("says so when the area has no articles", async () => {
    const stub = routed({ geo: () => json({ query: { geosearch: [] } }) });
    const r = geojson(await layer.query(ctx(stub), { lang: "en" }));
    expect(r.data.features).toEqual([]);
    expect(r.coverageNote).toBe("No Wikipedia articles with coordinates in this area");
  });

  it("maps failures of the search itself to hinted errors", async () => {
    const input = { lang: "en" };
    expect(await layer.query(ctx(vi.fn(async () => new Response("slow", { status: 429 }))), input)).toEqual({
      error: "Wikipedia is rate-limiting requests",
      hint: "upstream",
    });
    expect(await layer.query(ctx(vi.fn(async () => json({ error: { code: "toobig" } }))), input)).toEqual({
      error: "Wikipedia error: toobig",
      hint: "upstream",
    });
    expect(await layer.query(ctx(vi.fn(async () => new Response("<html>"))), input)).toMatchObject({ hint: "upstream" });
    const slow = vi.fn(async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    expect(await layer.query(ctx(slow), input)).toMatchObject({ error: expect.stringContaining("timed out"), hint: "upstream" });
  });

  it("rejects a view over the area cap through runLayer", async () => {
    const r = await runLayer("wikipedia-nearby", { bbox: [-121, 38, -120, 39] });
    expect(r.status).toBe(422);
  });
});
