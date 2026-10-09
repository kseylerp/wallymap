import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { commonsUrl, mapillaryUrl, tileBBox } from "./photos";
import commonsFixture from "./__fixtures__/photos.commons.json";
import mapillaryFixture from "./__fixtures__/photos.mapillary.json";

const SLT: [number, number, number, number] = [-120.02, 38.9, -119.94, 38.97];
const TOKEN = "MLY|test-token-0000";
/** About 48 km by 50 km (2,400 km2), just inside the layer cap. */
const BIG: [number, number, number, number] = [-120.3, 38.75, -119.74, 39.2];
const BOTH: { sources: ("commons" | "mapillary")[] } = { sources: ["commons", "mapillary"] };

type Init = RequestInit & { cacheKey?: string; ttlSeconds?: number };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Routes by host: Commons and Mapillary each get their own handler. */
function routed(handlers: {
  commons?: (url: string, init: Init) => Response | Promise<Response>;
  mapillary?: (url: string, init: Init) => Response | Promise<Response>;
}) {
  return vi.fn(async (url: string, init: Init = {}) => {
    if (url.startsWith("https://commons.wikimedia.org")) {
      return handlers.commons ? handlers.commons(url, init) : json(commonsFixture);
    }
    if (url.startsWith("https://graph.mapillary.com")) {
      return handlers.mapillary ? handlers.mapillary(url, init) : json(mapillaryFixture);
    }
    throw new Error(`unexpected url ${url}`);
  });
}

function ctx(
  stub: ReturnType<typeof vi.fn>,
  opts: { token?: string; bbox?: [number, number, number, number]; cacheKey?: string } = {},
) {
  return {
    bbox: opts.bbox ?? SLT,
    zoom: 12,
    env: opts.token === undefined ? {} : { MAPILLARY_TOKEN: opts.token },
    fetch: stub as unknown as CachedFetch,
    cacheKey: opts.cacheKey,
  };
}

function urlsOf(stub: ReturnType<typeof vi.fn>, host: string): string[] {
  return stub.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith(host));
}

function geojson(r: Awaited<ReturnType<typeof layer.query>>) {
  if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
  return r;
}

describe("commonsUrl", () => {
  it("orders gsbbox as top|left|bottom|right (north|west|south|east)", () => {
    const url = commonsUrl([-120.02, 38.9, -119.94, 38.97]);
    expect(url).toBe(
      "https://commons.wikimedia.org/w/api.php?action=query&list=geosearch" +
        "&gsbbox=38.97|-120.02|38.9|-119.94&gsnamespace=6&gslimit=500&format=json&origin=*",
    );
  });

  it("appends the continuation parameters", () => {
    const url = commonsUrl(SLT, { gscontinue: "0.5|123", continue: "-||" });
    expect(url.endsWith("&gscontinue=0.5%7C123&continue=-%7C%7C")).toBe(true);
  });
});

describe("mapillaryUrl", () => {
  it("orders bbox as west,south,east,north and asks for id, captured_at and geometry at limit 2000", () => {
    const url = new URL(mapillaryUrl(SLT, TOKEN));
    expect(url.origin + url.pathname).toBe("https://graph.mapillary.com/images");
    expect(url.searchParams.get("access_token")).toBe(TOKEN);
    expect(url.searchParams.get("bbox")).toBe("-120.02,38.9,-119.94,38.97");
    expect(url.searchParams.get("fields")).toBe("id,captured_at,geometry");
    expect(url.searchParams.get("limit")).toBe("2000");
  });
});

describe("tileBBox", () => {
  it("returns the box itself when it already fits", () => {
    expect(tileBBox([0, 0, 0.04, 0.04], 0.05, 0.05)).toEqual([[0, 0, 0.04, 0.04]]);
  });

  it("splits into equal squares no larger than the limits, covering the whole box", () => {
    const cells = tileBBox([0, 0, 0.12, 0.05], 0.05, 0.05);
    expect(cells).toHaveLength(3);
    for (const [w, s, e, n] of cells) {
      expect(e - w).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(n - s).toBeLessThanOrEqual(0.05 + 1e-9);
    }
    expect(Math.min(...cells.map((c) => c[0]))).toBe(0);
    expect(Math.max(...cells.map((c) => c[2]))).toBeCloseTo(0.12, 12);
  });
});

describe("photos layer", () => {
  it("declares global coverage, an optional token, no required key and a 2,500 km2 cap", () => {
    expect(layer.coverage).toBe("global");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.optionalEnv).toEqual(["MAPILLARY_TOKEN"]);
    expect(layer.maxAreaKm2).toBe(2_500);
    expect(layer.style).toEqual({ geometry: "point", color: "#FFD23F" });
    expect(layer.license).toBe("Wikimedia Commons (various free licenses); Mapillary (CC BY-SA 4.0)");
  });

  it("skips Mapillary without a token, says so, and still returns Commons photos", async () => {
    const stub = routed({});
    const r = geojson(await layer.query(ctx(stub), BOTH));
    expect(urlsOf(stub, "https://graph.mapillary.com")).toHaveLength(0);
    expect(urlsOf(stub, "https://commons.wikimedia.org")).toHaveLength(1);
    expect(r.coverageNote).toContain("Mapillary was skipped");
    expect(r.coverageNote).toContain("MAPILLARY_TOKEN");
    expect(r.data.features).toHaveLength(commonsFixture.query.geosearch.length);
    expect(r.data.features.every((f) => f.properties?.source === "commons")).toBe(true);
  });

  it("treats a blank token as missing", async () => {
    const stub = routed({});
    const r = geojson(await layer.query(ctx(stub, { token: "  " }), BOTH));
    expect(urlsOf(stub, "https://graph.mapillary.com")).toHaveLength(0);
    expect(r.coverageNote).toContain("Mapillary was skipped");
  });

  it("normalizes Commons hits to points with title, url and no t", async () => {
    const stub = routed({});
    const r = geojson(await layer.query(ctx(stub), { sources: ["commons"] }));
    const hit = commonsFixture.query.geosearch[0];
    const first = r.data.features[0];
    expect(first.geometry).toEqual({ type: "Point", coordinates: [hit.lon, hit.lat] });
    expect(first.properties).toEqual({
      source: "commons",
      title: hit.title.replace(/^File:/, ""),
      v: 1,
      url: `https://commons.wikimedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, "_")).replace(/%3A/g, ":")}`,
    });
    expect(first.properties).not.toHaveProperty("t");
    expect(r.coverageNote).toBeUndefined();
    expect(r.citation.source).toBe("Wikimedia Commons");
  });

  it("sends the Commons request with a User-Agent, a timeout and a cache key", async () => {
    const stub = routed({});
    await layer.query(ctx(stub, { cacheKey: "photos:k" }), { sources: ["commons"] });
    const [url, init] = stub.mock.calls[0] as unknown as [string, Init];
    expect(url).toContain("gsbbox=38.97|-120.02|38.9|-119.94");
    expect((init.headers as Record<string, string>)["user-agent"]).toContain("WildMap");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.cacheKey).toBe("photos:k:commons:-120.02,38.9,-119.94,38.97");
  });

  it("queries Mapillary with the token, caches 24 hours without the token in the key, and converts captured_at to ISO t", async () => {
    const stub = routed({});
    const r = geojson(await layer.query(ctx(stub, { token: TOKEN, cacheKey: "photos:k" }), { sources: ["mapillary"] }));
    const calls = stub.mock.calls.filter((c) => String(c[0]).startsWith("https://graph.mapillary.com"));
    expect(calls.length).toBeGreaterThan(0);
    for (const [url, init] of calls as unknown as [string, Init][]) {
      expect(new URL(url).searchParams.get("access_token")).toBe(TOKEN);
      expect(init.ttlSeconds).toBe(86_400);
      expect(init.cacheKey).toMatch(/^photos:k:mapillary:/);
      expect(init.cacheKey).not.toContain("MLY");
    }
    expect(urlsOf(stub, "https://commons.wikimedia.org")).toHaveLength(0);
    // The same fixture answers every square, and images are de-duplicated by id.
    expect(r.data.features).toHaveLength(mapillaryFixture.data.length);
    const first = r.data.features[0];
    const image = mapillaryFixture.data[0];
    expect(first.geometry).toEqual({ type: "Point", coordinates: image.geometry.coordinates });
    expect(first.properties).toEqual({
      source: "mapillary",
      v: 1,
      url: `https://www.mapillary.com/app/?pKey=${image.id}`,
      t: new Date(image.captured_at).toISOString(),
    });
    expect(first.properties?.t).toBe("2018-07-15T00:56:09.482Z");
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("merges both sources when a token is present", async () => {
    const stub = routed({});
    const r = geojson(await layer.query(ctx(stub, { token: TOKEN }), BOTH));
    const sources = new Set(r.data.features.map((f) => f.properties?.source));
    expect(sources).toEqual(new Set(["commons", "mapillary"]));
    expect(r.coverageNote).toBeUndefined();
    expect(r.citation.source).toContain("Mapillary");
    expect(r.citation.source).toContain("Commons");
  });

  it("reports unavailable without calling anything when only Mapillary is asked for and there is no token", async () => {
    const stub = routed({});
    const r = await layer.query(ctx(stub), { sources: ["mapillary"] });
    expect(r).toMatchObject({ hint: "unavailable" });
    expect(stub).not.toHaveBeenCalled();
  });

  it("follows a Commons continuation once, and no further", async () => {
    let n = 0;
    const stub = routed({
      commons: () => {
        n += 1;
        return json({
          query: { geosearch: [{ pageid: n, ns: 6, title: `File:P${n}.jpg`, lat: 38.9, lon: -120 }] },
          continue: { gscontinue: `c${n}`, continue: "-||" },
        });
      },
    });
    const r = geojson(await layer.query(ctx(stub), { sources: ["commons"] }));
    const urls = urlsOf(stub, "https://commons.wikimedia.org");
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("gscontinue=c1");
    expect(r.data.features).toHaveLength(2);
  });

  it("flags squares that hit the 500-photo Commons limit", async () => {
    const geosearch = Array.from({ length: 500 }, (_, i) => ({
      pageid: i + 1,
      ns: 6,
      title: `File:P${i}.jpg`,
      lat: 38.9,
      lon: -120,
    }));
    const stub = routed({ commons: () => json({ query: { geosearch } }) });
    const r = geojson(await layer.query(ctx(stub), { sources: ["commons"] }));
    expect(r.coverageNote).toContain("500 photos per square");
  });

  it("cuts a large view into Commons squares of about 15 km and de-duplicates shared photos", async () => {
    const stub = routed({});
    // About 50 km by 50 km: 4 x 4 squares.
    const r = geojson(await layer.query(ctx(stub, { bbox: BIG }), { sources: ["commons"] }));
    expect(urlsOf(stub, "https://commons.wikimedia.org")).toHaveLength(16);
    expect(r.data.features).toHaveLength(commonsFixture.query.geosearch.length);
  });

  it("asks Mapillary only for the 8 squares nearest the centre of a large view and says so", async () => {
    const stub = routed({});
    const r = geojson(
      await layer.query(ctx(stub, { token: TOKEN, bbox: BIG }), { sources: ["mapillary"] }),
    );
    const urls = urlsOf(stub, "https://graph.mapillary.com");
    expect(urls).toHaveLength(8);
    for (const u of urls) {
      const [w, s, e, n] = new URL(u).searchParams.get("bbox")!.split(",").map(Number);
      expect((e - w) * (n - s)).toBeLessThan(0.01);
    }
    expect(r.coverageNote).toContain("Mapillary covers only the 8 of 108 small map squares nearest the centre");
  });

  it("notes a Mapillary square that came back full", async () => {
    const data = Array.from({ length: 1950 }, (_, i) => ({
      id: String(i),
      captured_at: 1_600_000_000_000,
      geometry: { type: "Point", coordinates: [-120, 38.9] },
    }));
    const stub = routed({ mapillary: () => json({ data }) });
    const r = geojson(await layer.query(ctx(stub, { token: TOKEN, bbox: [-120.02, 38.9, -119.99, 38.93] }), { sources: ["mapillary"] }));
    expect(r.data.features).toHaveLength(1950);
    expect(r.coverageNote).toContain("one dense square has more than shown");
  });

  it("returns Commons with a note when Mapillary fails, without leaking the token", async () => {
    const stub = routed({
      mapillary: () => json({ error: { message: `bad ${TOKEN}`, code: 1 } }, 500),
    });
    const r = geojson(await layer.query(ctx(stub, { token: TOKEN }), BOTH));
    expect(r.data.features.every((f) => f.properties?.source === "commons")).toBe(true);
    expect(r.coverageNote).toMatch(/^All \d+ Mapillary requests failed .*; showing Commons photos only$/);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("says so when every Commons request fails but Mapillary works", async () => {
    const stub = routed({ commons: () => new Response("down", { status: 503 }) });
    const r = geojson(await layer.query(ctx(stub, { token: TOKEN }), BOTH));
    expect(r.data.features.every((f) => f.properties?.source === "mapillary")).toBe(true);
    expect(r.coverageNote).toBe("All 1 Wikimedia Commons requests failed; showing Mapillary photos only");
  });

  it("returns one upstream error naming both sources when every request to both fails", async () => {
    const stub = routed({
      commons: () => new Response("down", { status: 503 }),
      mapillary: () => json({ error: { message: `bad ${TOKEN}` } }, 500),
    });
    const r = await layer.query(ctx(stub, { token: TOKEN }), BOTH);
    expect(r).toEqual({
      error: "Both photo sources failed: Wikimedia Commons returned 503; Mapillary returned 500",
      hint: "upstream",
    });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("returns an upstream error, not a note about Mapillary, when Commons fails and there is no token", async () => {
    const stub = routed({ commons: () => new Response("down", { status: 503 }) });
    const r = await layer.query(ctx(stub), BOTH);
    expect(r).toEqual({ error: "Wikimedia Commons returned 503", hint: "upstream" });
    expect(JSON.stringify(r)).not.toContain("showing Mapillary");
  });

  it("maps a failure of every request to an upstream error that never mentions the token", async () => {
    const stub = routed({ mapillary: () => json({ error: { message: `bad ${TOKEN}` } }, 500) });
    const r = await layer.query(ctx(stub, { token: TOKEN }), { sources: ["mapillary"] });
    expect(r).toMatchObject({ hint: "upstream" });
    expect((r as { error: string }).error).toBe("Mapillary returned 500");
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("maps a Commons error body (HTTP 200) to an upstream error", async () => {
    const stub = routed({ commons: () => json({ error: { code: "toobig", info: "Bounding box is too big" } }) });
    const r = await layer.query(ctx(stub), { sources: ["commons"] });
    expect(r).toEqual({ error: "Wikimedia Commons error: toobig", hint: "upstream" });
  });

  it("maps a Commons 429 to an upstream error", async () => {
    const stub = routed({ commons: () => new Response("slow down", { status: 429 }) });
    const r = await layer.query(ctx(stub), { sources: ["commons"] });
    expect(r).toEqual({ error: "Wikimedia Commons returned 429", hint: "upstream" });
  });

  it("maps a thrown timeout to an upstream error", async () => {
    const stub = routed({
      commons: () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    });
    const r = await layer.query(ctx(stub), { sources: ["commons"] });
    expect(r).toMatchObject({ hint: "upstream" });
    expect((r as { error: string }).error).toContain("timed out");
  });

  it("keeps partial Commons results when some squares fail", async () => {
    let n = 0;
    const stub = routed({
      commons: () => {
        n += 1;
        return n === 1
          ? json({ error: { code: "cirrussearch-too-busy-error" } })
          : json({ query: { geosearch: [{ pageid: n, ns: 6, title: `File:P${n}.jpg`, lat: 38.9, lon: -120 }] } });
      },
    });
    const r = geojson(await layer.query(ctx(stub, { bbox: BIG }), { sources: ["commons"] }));
    expect(r.data.features).toHaveLength(15);
    expect(r.coverageNote).toBe("1 of 16 Wikimedia Commons requests failed, so some areas may be missing photos");
  });

  it("thins to 5,000 points across both sources and says so", async () => {
    const geosearch = Array.from({ length: 400 }, (_, i) => ({ pageid: i + 1, ns: 6, title: `File:P${i}.jpg`, lat: 38.9, lon: -120 }));
    const data = Array.from({ length: 1999 }, (_, i) => ({
      id: String(i),
      captured_at: 1_600_000_000_000,
      geometry: { type: "Point", coordinates: [-120 + i / 1e5, 38.9] },
    }));
    // Eight Mapillary squares of 1,999 distinct images each: 15,992 images.
    let m = 0;
    const stub = routed({
      commons: () => json({ query: { geosearch } }),
      mapillary: () => {
        m += 1;
        return json({ data: data.map((d) => ({ ...d, id: `${m}-${d.id}` })) });
      },
    });
    const r = geojson(await layer.query(ctx(stub, { token: TOKEN, bbox: BIG }), BOTH));
    expect(r.data.features).toHaveLength(5000);
    expect(r.coverageNote).toContain("Showing an evenly thinned 5,000 of");
    const commons = r.data.features.filter((f) => f.properties?.source === "commons").length;
    expect(commons).toBeGreaterThan(0);
    expect(commons).toBeLessThan(400 + 1);
  });

  it("rejects an empty or unknown sources list through runLayer", async () => {
    expect((await runLayer("photos", { bbox: SLT, input: { sources: [] } })).status).toBe(400);
    expect((await runLayer("photos", { bbox: SLT, input: { sources: ["flickr"] } })).status).toBe(400);
  });

  it("returns 422 zoom_in from runLayer for a bbox over 2,500 km2", async () => {
    const res = await runLayer("photos", { bbox: [-121, 38, -120, 39] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ hint: "zoom_in" });
  });
});
