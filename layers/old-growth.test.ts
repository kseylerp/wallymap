import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { normalizeOldGrowth, simplifyOffset } from "./old-growth";
import raw from "./__fixtures__/old-growth.cascades.json";

const fixture = raw as unknown as FeatureCollection;

const CASCADES: [number, number, number, number] = [-122.5, 43.5, -122, 44];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string) {
  return { bbox: CASCADES, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

describe("old-growth layer", () => {
  it("declares US coverage, sage extruded polygons, no env and no input", () => {
    expect(layer.id).toBe("old-growth");
    expect(layer.coverage).toBe("us");
    expect(layer.license).toMatch(/Public domain/);
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(300_000);
    expect(layer.input.parse({})).toEqual({});
    expect(layer.style).toEqual({ geometry: "polygon", color: "#9FB693", fillOpacity: 0.35, extrude: "v" });
  });

  it("normalizes firesheds to polygons with old-growth acres as v, mature acres and the survey error", () => {
    const fc = normalizeOldGrowth(fixture);
    expect(fc.features).toHaveLength(fixture.features.length);
    for (const f of fc.features) expect(["Polygon", "MultiPolygon"]).toContain(f.geometry.type);
    expect(fc.features[0].properties).toMatchObject({
      name: "McCredie Springs, Oregon",
      oldGrowthAcres: 130822,
      v: 130822,
      matureAcres: 40847,
      forestType: "Douglas-fir",
    });
    expect(typeof fc.features[0].properties?.oldGrowthErrorPercent).toBe("number");
  });

  it("skips rows without geometry and tolerates missing fields", () => {
    const fc = normalizeOldGrowth({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: null as never, properties: { Fireshed_Name: "Ghost" } },
        { type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: {} },
      ],
    });
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toEqual({ name: "Unnamed fireshed" });
  });

  it("simplifies coarser over a wide view, within bounds", () => {
    expect(simplifyOffset([0, 0, 0.1, 0.1])).toBe(0.002);
    expect(simplifyOffset(CASCADES)).toBeCloseTo(0.0025, 6);
    expect(simplifyOffset([-125, 30, -105, 45])).toBe(0.02);
  });

  it("asks the verified layer for 200 firesheds, most old growth first, with a week of cache", async () => {
    const stub = vi.fn(async () => json(fixture));
    const r = await layer.query(ctx(stub, "old-growth:k"), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");

    const calls = stub.mock.calls as unknown as [string, RequestInit & { ttlSeconds?: number }][];
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0][0]);
    expect(url.origin + url.pathname).toBe(
      "https://apps.fs.usda.gov/fsgisx02/rest/services/wo_nfs_gstc/WO_OSC_GapAnalysis_OldGrowthAndMatureForests/MapServer/29/query",
    );
    expect(url.searchParams.get("resultRecordCount")).toBe("200");
    expect(url.searchParams.get("orderByFields")).toBe("OLD_GROWTH_ACRES DESC");
    expect(url.searchParams.get("geometry")).toBe(CASCADES.join(","));
    expect(calls[0][1].ttlSeconds).toBe(7 * 86_400);
    expect(r.data.features.length).toBe(fixture.features.length);
    expect(r.coverageNote).toBeUndefined();
  });

  it("says when the service capped the result", async () => {
    const stub = vi.fn(async () => json({ ...fixture, exceededTransferLimit: true }));
    const r = await layer.query(ctx(stub), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toMatch(/200 firesheds/);
  });

  it("maps an ArcGIS error body and an HTTP error to upstream errors", async () => {
    const body = vi.fn(async () => json({ error: { code: 400, message: "Unable to complete operation." } }));
    expect(await layer.query(ctx(body), {})).toMatchObject({ hint: "upstream" });
    const http = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(await layer.query(ctx(http), {})).toMatchObject({ hint: "upstream" });
  });

  it("returns a coverage note without calling upstream outside the US", async () => {
    const stub = vi.fn();
    const r = await layer.query({ bbox: [2, 45, 3, 46], zoom: 9, env: {}, fetch: stub as unknown as CachedFetch }, {});
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toBe("No data outside the United States");
  });

  it("rejects an oversized bbox with zoom_in through runLayer", async () => {
    const res = await runLayer("old-growth", { bbox: [-125, 25, -66, 49], zoom: 3 });
    expect(res.status).toBe(422);
  });

  it("says the finest unit is a 250,000-acre fireshed and that figures are estimates", () => {
    expect(layer.description).toMatch(/250,000 acres/);
    expect(layer.description).toMatch(/finest unit/);
    expect(layer.description).toMatch(/estimates/);
    expect(layer.description).toMatch(/federal/i);
  });
});
