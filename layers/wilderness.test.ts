import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { normalizeWilderness } from "./wilderness";
import raw from "./__fixtures__/wilderness.tahoe.json";

const fixture = raw as unknown as FeatureCollection;

const TAHOE: [number, number, number, number] = [-120.4, 38.7, -119.8, 39.3];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string) {
  return { bbox: TAHOE, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

describe("wilderness layer", () => {
  it("declares US coverage, the public domain license and no env or input", () => {
    expect(layer.id).toBe("wilderness");
    expect(layer.coverage).toBe("us");
    expect(layer.license).toBe("Public domain (Wilderness.net / USGS)");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(400_000);
    expect(layer.input.parse({})).toEqual({});
    expect(layer.style).toEqual({ geometry: "polygon", color: "#B9A6FF", fillOpacity: 0.22 });
  });

  it("normalizes service rows to polygons with name, agency, acres, designated, t and v", () => {
    const fc = normalizeWilderness(fixture);
    expect(fc.features.length).toBe(fixture.features.length);
    for (const f of fc.features) {
      expect(["Polygon", "MultiPolygon"]).toContain(f.geometry.type);
      const p = f.properties ?? {};
      expect(typeof p.name).toBe("string");
      expect(typeof p.acres).toBe("number");
      expect(typeof p.designated).toBe("number");
      expect(p.v).toBe(p.acres);
      expect(p.t).toBe(`${p.designated}-01-01T00:00:00.000Z`);
    }
    const desolation = fc.features.find((f) => f.properties?.name === "Desolation Wilderness");
    expect(desolation?.properties).toMatchObject({
      agency: "USFS",
      acres: 64041,
      designated: 1969,
      state: "CA",
      t: "1969-01-01T00:00:00.000Z",
      v: 64041,
    });
  });

  it("skips rows without geometry and tolerates missing fields", () => {
    const fc = normalizeWilderness({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: null as never, properties: { NAME: "Ghost", Acreage: 5, Designated: 1990 } },
        {
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
          properties: { Acreage: 12 },
        },
      ],
    });
    expect(fc.features).toHaveLength(1);
    const p = fc.features[0].properties ?? {};
    expect(p.name).toBe("Unnamed wilderness");
    expect(p.acres).toBe(12);
    expect(p.v).toBe(12);
    expect(p).not.toHaveProperty("t");
    expect(p).not.toHaveProperty("designated");
  });

  it("queries the verified service with the display simplification and a 24 hour cache", async () => {
    const stub = vi.fn(async () => json(fixture));
    const r = await layer.query(ctx(stub, "wilderness:k"), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");

    const calls = stub.mock.calls as unknown as [string, RequestInit & { ttlSeconds?: number }][];
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0][0]);
    expect(url.origin + url.pathname).toBe(
      "https://services1.arcgis.com/ERdCHt0sNM6dENSD/arcgis/rest/services/Wilderness_Areas_in_the_United_States/FeatureServer/0/query",
    );
    expect(url.searchParams.get("maxAllowableOffset")).toBe("0.002");
    expect(url.searchParams.get("geometry")).toBe(TAHOE.join(","));
    expect(url.searchParams.get("outFields")).toBe("NAME,Agency,Acreage,Designated,STATE");
    expect(calls[0][1].ttlSeconds).toBe(86400);

    expect(r.data.features.some((f) => f.properties?.name === "Desolation Wilderness")).toBe(true);
    expect(r.citation.source).toContain("Wilderness");
    expect(r.coverageNote).toBeUndefined();
  });

  it("adds a coverage note when the service reports it capped the result", async () => {
    const stub = vi.fn(async () => json({ ...fixture, exceededTransferLimit: true }));
    const r = await layer.query(ctx(stub), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toMatch(/zoom in/i);
  });

  it("maps a 200 with an ArcGIS error body to an upstream error", async () => {
    const stub = vi.fn(async () => json({ error: { code: 400, message: "Unable to complete operation." } }));
    const r = await layer.query(ctx(stub), {});
    expect(r).toMatchObject({ hint: "upstream" });
    expect((r as { error: string }).error).toContain("Unable to complete operation.");
  });

  it("maps a non-2xx response to an upstream error", async () => {
    const stub = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(await layer.query(ctx(stub), {})).toMatchObject({ hint: "upstream" });
  });

  it("returns a coverage note without calling upstream when the bbox is outside the US", async () => {
    const stub = vi.fn();
    const r = await layer.query(
      { bbox: [2, 45, 3, 46], zoom: 9, env: {}, fetch: stub as unknown as CachedFetch },
      {},
    );
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toBe("No data outside the United States");
  });

  it("describes what a wilderness is and what the numbers mean", () => {
    expect(layer.description).toMatch(/Wilderness Act|designated/i);
    expect(layer.description).toMatch(/acres/i);
    expect(layer.description).toMatch(/United States only/i);
  });

  it("rejects an oversized bbox with zoom_in through runLayer", async () => {
    const res = await runLayer("wilderness", { bbox: [-125, 25, -66, 49], zoom: 3 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ hint: "zoom_in" });
  });
});
