import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheKeyFor, createCache, type Cache } from "./cache";
import { createLayerFetch } from "./index";

describe("createCache", () => {
  const savedUrl = process.env.KV_REST_API_URL;
  const savedToken = process.env.KV_REST_API_TOKEN;

  afterEach(() => {
    vi.useRealTimers();
    if (savedUrl === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = savedUrl;
    if (savedToken === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = savedToken;
  });

  it("falls back to memory when KV env is absent", async () => {
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    const c = createCache();
    await c.set("mem-fallback", "v", 10);
    expect(await c.get("mem-fallback")).toBe("v");
  });

  it("expires memory entries", async () => {
    vi.useFakeTimers();
    const c = createCache();
    await c.set("mem-expiry", "v", 1);
    vi.advanceTimersByTime(1500);
    expect(await c.get("mem-expiry")).toBeNull();
  });

  it("shares memory between createCache calls", async () => {
    await createCache().set("shared-key", "x", 10);
    expect(await createCache().get("shared-key")).toBe("x");
  });
});

describe("cacheKeyFor", () => {
  it("rounds bbox and sorts input", () => {
    expect(cacheKeyFor("osm", [-120.12345, 38, -119, 39], { b: 1, a: 2 })).toBe(
      'osm:-120.123,38,-119,39:{"a":2,"b":1}',
    );
  });
});

describe("createLayerFetch", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("caches 2xx and not 5xx", async () => {
    const stub = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      return u.includes("/ok")
        ? new Response('{"a":1}', { status: 200, headers: { "content-type": "application/json" } })
        : new Response("down", { status: 503 });
    });
    globalThis.fetch = stub as unknown as typeof fetch;
    const f = createLayerFetch("cache-test", { capacity: 100, refillPerSecond: 100 });

    const a = await f("https://example.test/ok");
    const b = await f("https://example.test/ok");
    expect(await a.text()).toBe('{"a":1}');
    expect(await b.text()).toBe('{"a":1}');
    expect(b.headers.get("x-cache")).toBe("HIT");
    expect(stub).toHaveBeenCalledTimes(1);

    stub.mockClear();
    const c = await f("https://example.test/fail");
    const d = await f("https://example.test/fail");
    expect(c.status).toBe(503);
    expect(d.status).toBe(503);
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("does not spend rate-limit tokens on cache hits", async () => {
    vi.useFakeTimers();
    try {
      const stub = vi.fn(async () => new Response("payload", { status: 200 }));
      globalThis.fetch = stub as unknown as typeof fetch;
      // Capacity 1: a single upstream call drains the bucket.
      const f = createLayerFetch("hit-no-tokens", { capacity: 1, refillPerSecond: 1 });
      await f("https://example.test/hit");
      for (let i = 0; i < 20; i++) {
        const r = await f("https://example.test/hit");
        expect(r.headers.get("x-cache")).toBe("HIT");
      }
      expect(stub).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not share a cached result between different URLSearchParams bodies", async () => {
    const stub = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Response(String(init?.body), { status: 200 }),
    );
    globalThis.fetch = stub as unknown as typeof fetch;
    const f = createLayerFetch("form-bodies", { capacity: 100, refillPerSecond: 100 });
    const post = (q: string) =>
      f("https://example.test/q", { method: "POST", body: new URLSearchParams({ q }) });

    const a = await post("one");
    const b = await post("two");
    expect(await a.text()).toBe("q=one");
    expect(await b.text()).toBe("q=two");
    expect(stub).toHaveBeenCalledTimes(2);
    await post("one");
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache for non-serialisable bodies unless a cacheKey is given", async () => {
    const stub = vi.fn(async () => new Response("bin", { status: 200 }));
    globalThis.fetch = stub as unknown as typeof fetch;
    const f = createLayerFetch("binary-bodies", { capacity: 100, refillPerSecond: 100 });
    const init = () => ({ method: "POST", body: new Uint8Array([1, 2, 3]) });

    await f("https://example.test/bin", init());
    await f("https://example.test/bin", init());
    expect(stub).toHaveBeenCalledTimes(2);

    await f("https://example.test/bin", { ...init(), cacheKey: "binary-bodies:explicit" });
    await f("https://example.test/bin", { ...init(), cacheKey: "binary-bodies:explicit" });
    expect(stub).toHaveBeenCalledTimes(3);
  });

  it("falls through to upstream when the cache throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stub = vi.fn(async () => new Response("live", { status: 200 }));
    globalThis.fetch = stub as unknown as typeof fetch;
    const broken: Cache = {
      get: () => Promise.reject(new Error("kv down")),
      set: () => Promise.reject(new Error("kv down")),
    };
    const f = createLayerFetch("broken-cache", {
      capacity: 100,
      refillPerSecond: 100,
      cache: broken,
    });
    const r = await f("https://example.test/live");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("live");
    expect(stub).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
