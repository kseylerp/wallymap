import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheKeyFor, createCache } from "./cache";
import { createLayerFetch } from "./index";

describe("createCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("falls back to memory when KV env is absent", async () => {
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    const c = createCache();
    await c.set("k", "v", 10);
    expect(await c.get("k")).toBe("v");
  });

  it("expires memory entries", async () => {
    vi.useFakeTimers();
    const c = createCache();
    await c.set("k", "v", 1);
    vi.advanceTimersByTime(1500);
    expect(await c.get("k")).toBeNull();
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
});
