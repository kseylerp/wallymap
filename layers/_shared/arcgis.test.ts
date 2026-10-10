import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import type { QueryContext } from "../types";
import { arcgisQuery } from "./arcgis";

const SERVICE = "https://services.example.test/arcgis/rest/services/Trails/FeatureServer/0";
const BBOX: [number, number, number, number] = [-120.2, 38.85, -120, 39];

const fc: FeatureCollection = {
  type: "FeatureCollection",
  features: [{ type: "Feature", geometry: { type: "Point", coordinates: [-120.1, 38.9] }, properties: { NAME: "a" } }],
};

function ctxWith(stub: ReturnType<typeof vi.fn>, cacheKey?: string): QueryContext {
  return { bbox: BBOX, zoom: 10, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

describe("arcgisQuery", () => {
  it("builds the expected query string with defaults", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(fc), { status: 200 }));
    await arcgisQuery(ctxWith(stub), SERVICE, { outFields: ["NAME", "TYPE"], bbox: BBOX });
    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit & { cacheKey?: string }];
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(`${SERVICE}/query`);
    expect(parsed.searchParams.get("where")).toBe("1=1");
    expect(parsed.searchParams.get("outFields")).toBe("NAME,TYPE");
    expect(parsed.searchParams.get("geometry")).toBe("-120.2,38.85,-120,39");
    expect(parsed.searchParams.get("geometryType")).toBe("esriGeometryEnvelope");
    expect(parsed.searchParams.get("inSR")).toBe("4326");
    expect(parsed.searchParams.get("outSR")).toBe("4326");
    expect(parsed.searchParams.get("spatialRel")).toBe("esriSpatialRelIntersects");
    expect(parsed.searchParams.get("f")).toBe("geojson");
    expect(parsed.searchParams.get("resultRecordCount")).toBe("2000");
    expect(parsed.searchParams.has("maxAllowableOffset")).toBe(false);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.cacheKey).toBeUndefined();
  });

  it("honours where, maxRecords, maxAllowableOffset and cacheSuffix", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(fc), { status: 200 }));
    await arcgisQuery(ctxWith(stub, "layer:k"), SERVICE, {
      where: "TYPE='A'",
      outFields: ["*"],
      bbox: BBOX,
      maxRecords: 50,
      maxAllowableOffset: 0.001,
      cacheSuffix: "x",
    });
    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit & { cacheKey?: string }];
    const parsed = new URL(url);
    expect(parsed.searchParams.get("where")).toBe("TYPE='A'");
    expect(parsed.searchParams.get("resultRecordCount")).toBe("50");
    expect(parsed.searchParams.get("maxAllowableOffset")).toBe("0.001");
    expect(init.cacheKey).toBe("layer:k:x");
  });

  it("gives different queries under one ctx different cache keys", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(fc), { status: 200 }));
    const ctx = ctxWith(stub, "layer:k");
    await arcgisQuery(ctx, SERVICE, { where: "TYPE='A'", outFields: ["NAME"], bbox: BBOX });
    await arcgisQuery(ctx, SERVICE, { where: "TYPE='B'", outFields: ["NAME"], bbox: BBOX });
    const keys = stub.mock.calls.map((c: unknown[]) => (c[1] as { cacheKey?: string }).cacheKey);
    expect(keys[0]).toMatch(/^layer:k:arcgis:[0-9a-f]+$/);
    expect(keys[1]).toMatch(/^layer:k:arcgis:[0-9a-f]+$/);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("returns the FeatureCollection on success", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(fc), { status: 200 }));
    const r = await arcgisQuery(ctxWith(stub), SERVICE, { outFields: ["NAME"], bbox: BBOX });
    expect(r).toEqual({ ok: true, fc, truncated: false });
  });

  it("reports truncated when the service sets exceededTransferLimit", async () => {
    const stub = vi.fn(
      async () => new Response(JSON.stringify({ ...fc, exceededTransferLimit: true }), { status: 200 }),
    );
    const r = await arcgisQuery(ctxWith(stub), SERVICE, { outFields: ["NAME"], bbox: BBOX });
    expect(r).toMatchObject({ ok: true, truncated: true });
  });

  it("also reports truncated when the flag is only under properties", async () => {
    const stub = vi.fn(
      async () => new Response(JSON.stringify({ ...fc, properties: { exceededTransferLimit: true } }), { status: 200 }),
    );
    const r = await arcgisQuery(ctxWith(stub), SERVICE, { outFields: ["NAME"], bbox: BBOX });
    expect(r).toMatchObject({ ok: true, truncated: true });
  });

  it("forwards orderByFields and ttlSeconds", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(fc), { status: 200 }));
    await arcgisQuery(ctxWith(stub), SERVICE, {
      outFields: ["NAME"],
      bbox: BBOX,
      orderByFields: "GIS_ACRES DESC",
      ttlSeconds: 3600,
    });
    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit & { ttlSeconds?: number }];
    expect(new URL(url).searchParams.get("orderByFields")).toBe("GIS_ACRES DESC");
    expect(init.ttlSeconds).toBe(3600);
  });

  it("maps a 200 body with an error object to ok: false", async () => {
    const body = { error: { code: 400, message: "Invalid query parameters" } };
    const stub = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    const r = await arcgisQuery(ctxWith(stub), SERVICE, { outFields: ["NAME"], bbox: BBOX });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.error).toContain("Invalid query parameters");
  });

  it("maps a 200 body that is not a FeatureCollection to ok: false", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify({ hello: "world" }), { status: 200 }));
    const r = await arcgisQuery(ctxWith(stub), SERVICE, { outFields: ["NAME"], bbox: BBOX });
    expect(r.ok).toBe(false);
  });

  it("maps a non-2xx response to ok: false with the status", async () => {
    const stub = vi.fn(async () => new Response("nope", { status: 503 }));
    const r = await arcgisQuery(ctxWith(stub), SERVICE, { outFields: ["NAME"], bbox: BBOX });
    expect(r).toMatchObject({ ok: false, status: 503 });
  });

  it("maps a thrown timeout to ok: false", async () => {
    const stub = vi.fn(async () => {
      throw new DOMException("timeout", "TimeoutError");
    });
    const r = await arcgisQuery(ctxWith(stub), SERVICE, { outFields: ["NAME"], bbox: BBOX });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.error).toContain("timed out");
  });
});
