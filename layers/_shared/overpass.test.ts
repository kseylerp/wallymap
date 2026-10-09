import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import type { QueryContext } from "../types";
import { overpassFailure, overpassQuery } from "./overpass";

const PUBLIC = "https://overpass-api.de/api/interpreter";
const GOOD = { elements: [{ type: "node", id: 1 }] };

function ctxWith(
  stub: ReturnType<typeof vi.fn>,
  extra: Partial<QueryContext> = {},
): QueryContext {
  return { bbox: [-120.2, 38.85, -120, 39], zoom: 11, env: {}, fetch: stub as unknown as CachedFetch, ...extra };
}

describe("overpassQuery", () => {
  it("POSTs the query form-encoded to the public endpoint when OVERPASS_URL is unset", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(GOOD), { status: 200 }));
    const r = await overpassQuery(ctxWith(stub), "[out:json];node(1);out;");
    expect(r).toEqual({ ok: true, json: GOOD });
    expect(stub).toHaveBeenCalledTimes(1);
    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(PUBLIC);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(`data=${encodeURIComponent("[out:json];node(1);out;")}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses OVERPASS_URL first, then retries once on the public endpoint after a 429", async () => {
    const env = { OVERPASS_URL: "https://overpass.example.test/api/interpreter" };
    const stub = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(GOOD), { status: 200 }));
    const r = await overpassQuery(ctxWith(stub, { env }), "q");
    expect(r).toEqual({ ok: true, json: GOOD });
    expect(stub.mock.calls.map((c) => c[0])).toEqual([env.OVERPASS_URL, PUBLIC]);
  });

  it("reports a 429 on both attempts as a failure carrying the status", async () => {
    const stub = vi.fn(async () => new Response("slow down", { status: 429 }));
    const r = await overpassQuery(ctxWith(stub), "q");
    expect(r).toEqual({ ok: false, error: "Overpass returned 429", status: 429 });
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("treats a 200 with a failure remark as a failure", async () => {
    const remark = 'runtime error: Query timed out in "query" at line 1 after 26 seconds.';
    const stub = vi.fn(async () => new Response(JSON.stringify({ remark, elements: [] }), { status: 200 }));
    const r = await overpassQuery(ctxWith(stub), "q");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.error).toContain("Query timed out");
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("keys the primary request by ctx.cacheKey plus suffix and the retry with :fallback", async () => {
    const stub = vi.fn(async () => new Response("no", { status: 500 }));
    await overpassQuery(ctxWith(stub, { cacheKey: "layer:k" }), "q", { cacheSuffix: "s" });
    const keys = stub.mock.calls.map((c: unknown[]) => (c[1] as { cacheKey?: string }).cacheKey);
    expect(keys).toEqual(["layer:k:s", "layer:k:s:fallback"]);
  });

  it("leaves the cache key undefined when ctx has none", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(GOOD), { status: 200 }));
    await overpassQuery(ctxWith(stub), "q");
    expect((stub.mock.calls[0] as unknown as [string, { cacheKey?: string }])[1].cacheKey).toBeUndefined();
  });
});

describe("overpassFailure", () => {
  it("accepts a good body and flags bad ones", () => {
    expect(overpassFailure(GOOD)).toBeNull();
    expect(overpassFailure({ remark: "out of memory", elements: [] })).toBe("out of memory");
    expect(overpassFailure({ version: 0.6 })).not.toBeNull();
    expect(overpassFailure(null)).not.toBeNull();
  });
});
