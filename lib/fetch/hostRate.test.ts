import { afterEach, describe, expect, it, vi } from "vitest";
import { createLayerFetch, HOST_RATES, type Cache } from "./index";

/** No caching, so every call reaches the (stubbed) network and the rate limiter. */
const noCache: Cache = { get: async () => null, set: async () => {} };

let seq = 0;
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("per-host rates and the post-slot timeout", () => {
  it("lists the many-small-calls hosts at 5 requests a second", () => {
    for (const host of ["api.weather.gov", "api.tidesandcurrents.noaa.gov", "waterservices.usgs.gov"]) {
      expect(HOST_RATES[host]).toEqual({ capacity: 5, refillPerSecond: 5 });
    }
  });

  it("sends listed hosts through their own bucket, not the layer's slow one", async () => {
    const stub = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = stub as unknown as typeof fetch;
    // A layer bucket of one token that takes ~1000 s to refill: a second call would hang if it were used.
    const f = createLayerFetch(`host-rate-${seq++}`, { capacity: 1, refillPerSecond: 0.001, cache: noCache });
    const started = Date.now();
    for (let i = 0; i < 4; i++) await f(`https://api.weather.gov/points/39,-120?i=${i}`);
    expect(stub).toHaveBeenCalledTimes(4);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("starts timeoutMs after the rate-limit wait, so a queued call is not aborted", async () => {
    const seen: boolean[] = [];
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(init?.signal?.aborted ?? false);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    // One token, refilling every 200 ms: the second and third calls wait 200 and 400 ms, longer than the timeout.
    const f = createLayerFetch(`timeout-${seq++}`, { capacity: 1, refillPerSecond: 5, cache: noCache });
    await Promise.all([1, 2, 3].map((i) => f(`https://example.test/${i}`, { timeoutMs: 150 })));
    expect(seen).toEqual([false, false, false]);
  });

  it("still honours a caller's own signal alongside timeoutMs", async () => {
    let signal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const f = createLayerFetch(`both-${seq++}`, { capacity: 5, refillPerSecond: 5, cache: noCache });
    const controller = new AbortController();
    await f("https://example.test/x", { timeoutMs: 10_000, signal: controller.signal });
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });
});
