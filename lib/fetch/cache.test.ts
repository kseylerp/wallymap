import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KV_MAX_VALUE_BYTES,
  MEMORY_CACHE_MAX_BYTES,
  cacheKeyFor,
  createCache,
  createMemoryCache,
  kvCache,
  resetCacheWarnings,
  type Cache,
} from "./cache";
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

  it("holds a large station list alongside many small entries", async () => {
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    const c = createCache();
    expect(MEMORY_CACHE_MAX_BYTES).toBe(64 * 1024 * 1024);
    const stationList = "x".repeat(2_000_000);
    await c.set("bytes:stations", stationList, 600);
    // A cold weather-alerts view writes about 41 small entries; the old 50-entry cap evicted the list.
    for (let i = 0; i < 500; i++) await c.set(`bytes:zone-${i}`, `{"zone":${i}}`, 600);
    expect(await c.get("bytes:stations")).toBe(stationList);
    expect(await c.get("bytes:zone-0")).toBe('{"zone":0}');
  });
});

describe("createMemoryCache", () => {
  it("evicts least recently used entries once the byte budget is full", async () => {
    const c = createMemoryCache(200);
    for (let i = 0; i < 9; i++) await c.set(`k${i}`, String(i).repeat(18), 60); // 20 bytes each with the key
    expect(c.bytes()).toBe(180);
    // Reading k0 makes k1 the least recently used.
    expect(await c.get("k0")).not.toBeNull();
    await c.set("e", "e".repeat(44), 60); // 45 bytes: k1 and k2 must go
    expect(await c.get("k1")).toBeNull();
    expect(await c.get("k2")).toBeNull();
    expect(await c.get("k0")).not.toBeNull();
    expect(await c.get("k3")).not.toBeNull();
    expect(await c.get("e")).not.toBeNull();
    expect(c.bytes()).toBe(185);
  });

  it("replacing a key frees its old size, and an entry over a quarter of the budget is not stored", async () => {
    const c = createMemoryCache(100);
    await c.set("k", "1".repeat(19), 60);
    await c.set("k", "2".repeat(9), 60);
    expect(c.bytes()).toBe(10);
    await c.set("huge", "h".repeat(30), 60);
    expect(await c.get("huge")).toBeNull();
    expect(await c.get("k")).toBe("2".repeat(9));
  });
});

describe("kvCache", () => {
  function fakeKv({ refuse = false } = {}) {
    const store = new Map<string, string>();
    const client = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        if (refuse) throw new Error("ERR max request size exceeded");
        store.set(key, value);
        return "OK";
      }),
    };
    return { store, client };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    resetCacheWarnings();
  });

  it("writes ordinary values to KV", async () => {
    const { store, client } = fakeKv();
    const c = kvCache(async () => client as never, createMemoryCache(10_000_000));
    await c.set("kv:small", "v", 60);
    expect(store.get("kv:small")).toBe("v");
    expect(await c.get("kv:small")).toBe("v");
  });

  it("keeps a value over the KV limit in memory and warns once for that key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { store, client } = fakeKv();
    const c = kvCache(async () => client as never, createMemoryCache(10_000_000));
    const big = "t".repeat(KV_MAX_VALUE_BYTES + 1);
    await c.set("tides:stations:predictions", big, 60);
    await c.set("tides:stations:predictions", big, 60);
    expect(client.set).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
    expect(await c.get("tides:stations:predictions")).toBe(big);
    expect(client.get).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("tides:stations:predictions");

    await c.set("surf:ndbc-latest", big, 60);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("falls back to memory when KV rejects a write, warning once per key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = fakeKv({ refuse: true });
    const c = kvCache(async () => client as never, createMemoryCache(10_000_000));
    await c.set("kv:refused", "body", 60);
    await c.set("kv:refused", "body", 60);
    expect(await c.get("kv:refused")).toBe("body");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("kv:refused");
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
