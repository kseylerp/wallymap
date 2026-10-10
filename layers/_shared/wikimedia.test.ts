import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { WIKIMEDIA_USER_AGENT, retryDelayMs, wikimediaFetch } from "./wikimedia";

function stubOf(...responses: Response[]) {
  const queue = [...responses];
  return vi.fn(async () => queue.shift() ?? new Response("{}", { status: 200 }));
}

const asFetch = (stub: ReturnType<typeof vi.fn>) => stub as unknown as CachedFetch;

describe("retryDelayMs", () => {
  it("reads seconds, HTTP dates, and falls back to 2 seconds", () => {
    expect(retryDelayMs("3")).toBe(3000);
    expect(retryDelayMs("0")).toBe(0);
    expect(retryDelayMs(null)).toBe(2000);
    expect(retryDelayMs("soon")).toBe(2000);
    const now = Date.parse("2026-10-10T00:00:00Z");
    expect(retryDelayMs("Sat, 10 Oct 2026 00:00:05 GMT", now)).toBe(5000);
  });
});

describe("wikimediaFetch", () => {
  it("sends one descriptive User-Agent with no email, keeps caller headers, and passes the cache key", async () => {
    const stub = stubOf(new Response("ok"));
    const res = await wikimediaFetch(asFetch(stub), "https://x.test/", { cacheKey: "k", headers: { accept: "application/json" } });
    expect(res.status).toBe(200);
    const [, init] = stub.mock.calls[0] as unknown as [string, RequestInit & { cacheKey?: string }];
    expect(init.cacheKey).toBe("k");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual({ accept: "application/json", "user-agent": WIKIMEDIA_USER_AGENT });
    expect(WIKIMEDIA_USER_AGENT).toBe("WallyMap/0.1 (https://wallymap.vercel.app)");
    expect(WIKIMEDIA_USER_AGENT).not.toContain("@");
  });

  it("retries once on 429 after the Retry-After seconds", async () => {
    const stub = stubOf(new Response("slow", { status: 429, headers: { "retry-after": "3" } }), new Response("ok"));
    const sleep = vi.fn(async () => {});
    const res = await wikimediaFetch(asFetch(stub), "https://x.test/", {}, { sleep });
    expect(res.status).toBe(200);
    expect(stub).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("retries once on 503 after 2 seconds when there is no header", async () => {
    const stub = stubOf(new Response("down", { status: 503 }), new Response("ok"));
    const sleep = vi.fn(async () => {});
    expect((await wikimediaFetch(asFetch(stub), "https://x.test/", {}, { sleep })).status).toBe(200);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("returns the second failure instead of retrying again", async () => {
    const stub = stubOf(new Response("a", { status: 429 }), new Response("b", { status: 429 }));
    const res = await wikimediaFetch(asFetch(stub), "https://x.test/", {}, { sleep: async () => {} });
    expect(res.status).toBe(429);
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("does not wait for a long Retry-After and does not retry other errors", async () => {
    const long = stubOf(new Response("a", { status: 429, headers: { "retry-after": "60" } }));
    const sleep = vi.fn(async () => {});
    expect((await wikimediaFetch(asFetch(long), "https://x.test/", {}, { sleep })).status).toBe(429);
    expect(long).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();

    const bad = stubOf(new Response("nope", { status: 500 }));
    expect((await wikimediaFetch(asFetch(bad), "https://x.test/", {}, { sleep })).status).toBe(500);
    expect(bad).toHaveBeenCalledTimes(1);
  });
});
