import { afterEach, describe, expect, it, vi } from "vitest";
import { overpassBodyCacheable, overpassQuery } from "@/layers/_shared/overpass";
import { arcgisQuery } from "@/layers/_shared/arcgis";
import { firmsBodyCacheable } from "@/layers/fire-detections";
import type { QueryContext } from "@/layers/types";
import { createLayerFetch, EMPTY_BODY_HEADER, looksLikeUpstreamFailure, type Cache } from "./index";

/** A private Map-backed cache so tests never share entries. */
function mapCache(): Cache & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => {
      store.set(k, v);
    },
  };
}

let seq = 0;
function stubFetch(body: string) {
  const stub = vi.fn(async () => new Response(body, { status: 200 }));
  globalThis.fetch = stub as unknown as typeof fetch;
  const cache = mapCache();
  const f = createLayerFetch(`poison-${seq++}`, { capacity: 100, refillPerSecond: 100, cache });
  return { stub, cache, f };
}

const ctx = (f: QueryContext["fetch"]): QueryContext => ({ bbox: [-120.2, 38.85, -120, 39], zoom: 11, env: {}, fetch: f, cacheKey: "k" });

describe("upstream failures that arrive as HTTP 200", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it.each([
    ["ArcGIS error", '{"error":{"code":400,"message":"Invalid query parameters"}}'],
    ["Commons busy", '{"error":{"code":"cirrussearch-too-busy-error","info":"Too many requests"}}'],
    ["Overpass timeout remark", '{"elements":[],"remark":"runtime error: Query timed out in \\"query\\" at line 1 after 26 seconds."}'],
  ])("does not cache a %s", async (_name, body) => {
    expect(looksLikeUpstreamFailure(body)).toBe(true);
    const { stub, cache, f } = stubFetch(body);
    expect(await (await f("https://up.test/a")).text()).toBe(body);
    await f("https://up.test/a");
    expect(stub).toHaveBeenCalledTimes(2);
    expect(cache.store.size).toBe(0);
  });

  it.each([
    ["empty FeatureCollection", '{"type":"FeatureCollection","features":[]}'],
    ["empty Commons search", '{"batchcomplete":"","query":{"geosearch":[]}}'],
  ])("caches a genuine %s", async (_name, body) => {
    expect(looksLikeUpstreamFailure(body)).toBe(false);
    const { stub, f } = stubFetch(body);
    await f("https://up.test/b");
    await f("https://up.test/b");
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("ArcGIS: an error body is reported and not cached", async () => {
    const { stub, cache, f } = stubFetch('{"error":{"code":500,"message":"Unable to complete operation."}}');
    const res = await arcgisQuery(ctx(f), "https://arcgis.test/FeatureServer/0", { outFields: ["*"], bbox: [-120.2, 38.85, -120, 39] });
    expect(res).toMatchObject({ ok: false, error: "ArcGIS service error: Unable to complete operation." });
    expect(cache.store.size).toBe(0);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("Overpass: a failure remark on both attempts caches nothing; an empty result is cached", async () => {
    const failing = stubFetch('{"elements":[],"remark":"runtime error: out of memory"}');
    expect(await overpassQuery(ctx(failing.f), "q")).toMatchObject({ ok: false });
    expect(failing.cache.store.size).toBe(0);

    const empty = stubFetch('{"version":0.6,"elements":[]}');
    expect(await overpassQuery(ctx(empty.f), "q")).toMatchObject({ ok: true });
    await overpassQuery(ctx(empty.f), "q");
    expect(empty.stub).toHaveBeenCalledTimes(1);
  });

  it("Overpass body check works on text", () => {
    expect(overpassBodyCacheable('{"elements":[]}')).toBe(true);
    expect(overpassBodyCacheable('{"elements":[{"type":"way"}],"remark":"runtime error: Query timed out"}')).toBe(false);
    expect(overpassBodyCacheable("<html>busy</html>")).toBe(false);
  });

  it("FIRMS: an Invalid MAP_KEY answer is not cached; an empty or real CSV is", async () => {
    expect(firmsBodyCacheable("Invalid MAP_KEY.")).toBe(false);
    expect(firmsBodyCacheable("<html>maintenance</html>")).toBe(false);
    expect(firmsBodyCacheable("")).toBe(true);
    expect(firmsBodyCacheable("latitude,longitude,bright_ti4\n37.4,-121.9,330\n")).toBe(true);

    const { stub, cache, f } = stubFetch("Invalid MAP_KEY.");
    await f("https://firms.test/csv", { shouldCache: firmsBodyCacheable });
    await f("https://firms.test/csv", { shouldCache: firmsBodyCacheable });
    expect(stub).toHaveBeenCalledTimes(2);
    expect(cache.store.size).toBe(0);
  });
});

describe("answers with no body", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("passes a 204 back as an empty, marked, uncached response instead of throwing", async () => {
    const stub = vi.fn(async () => new Response(null, { status: 204 }));
    globalThis.fetch = stub as unknown as typeof fetch;
    const cache = mapCache();
    const f = createLayerFetch(`no-body-${seq++}`, { capacity: 100, refillPerSecond: 100, cache });
    const res = await f("https://example.test/page/9", { cacheKey: "page9", validate: () => false });
    expect(res.status).toBe(204);
    expect(res.ok).toBe(true);
    expect(res.headers.get(EMPTY_BODY_HEADER)).toBe("1");
    expect(await res.text()).toBe("");
    expect(cache.store.size).toBe(0);
    await f("https://example.test/page/9", { cacheKey: "page9" });
    expect(stub).toHaveBeenCalledTimes(2);
  });
});
