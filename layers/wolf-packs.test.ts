import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { normalizePacks, simplifyOffset, yearWhere } from "./wolf-packs";
import raw from "./__fixtures__/wolf-packs.ne-washington.json";

const fixture = raw as unknown as FeatureCollection;

const NE_WASHINGTON: [number, number, number, number] = [-118.5, 48.4, -117, 49];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string) {
  return { bbox: NE_WASHINGTON, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

describe("wolf-packs layer", () => {
  it("declares sage polygons, no env and an optional year input", () => {
    expect(layer.id).toBe("wolf-packs");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.license).toMatch(/terms not stated/);
    expect(layer.style).toEqual({ geometry: "polygon", color: "#9FB693", fillOpacity: 0.3 });
    expect(layer.input.parse({})).toEqual({});
    expect(layer.input.parse({ year: 2023 })).toEqual({ year: 2023 });
    expect(() => layer.input.parse({ year: 2023.5 })).toThrow();
  });

  it("normalizes packs to polygons with year, status, kind and t", () => {
    const fc = normalizePacks(fixture);
    expect(fc.features).toHaveLength(fixture.features.length);
    const breeding = fc.features.find((f) => f.properties?.pack === "Dirty Shirt");
    expect(breeding?.properties).toEqual({
      pack: "Dirty Shirt",
      year: 2023,
      t: "2023-01-01T00:00:00.000Z",
      status: "Breeding Pairs",
      kind: "Breeding Pairs",
    });
    const early = fc.features.find((f) => f.properties?.year === 2016);
    expect(early?.properties).toMatchObject({ kind: "Not recorded", t: "2016-01-01T00:00:00.000Z" });
    expect(early?.properties).not.toHaveProperty("status");
    for (const f of fc.features) expect(f.geometry.type).toBe("Polygon");
  });

  it("skips rows without geometry and tolerates missing fields", () => {
    const fc = normalizePacks({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: null as never, properties: { Pack: "Ghost", Year: 2020 } },
        { type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: {} },
      ],
    });
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toEqual({ pack: "Unnamed pack", kind: "Not recorded" });
  });

  it("builds a year filter only when a year is given", () => {
    expect(yearWhere(undefined)).toBeUndefined();
    expect(yearWhere(2023)).toBe("Year=2023");
  });

  it("simplifies finer when zoomed in, within bounds", () => {
    expect(simplifyOffset([0, 0, 0.1, 0.1])).toBe(0.001);
    expect(simplifyOffset(NE_WASHINGTON)).toBeCloseTo(0.005, 6);
    expect(simplifyOffset([-125, 45, -100, 49])).toBe(0.02);
  });

  it("queries the all-years layer once, all years by default, with the verified fields", async () => {
    const stub = vi.fn(async () => json(fixture));
    const r = await layer.query(ctx(stub, "wolf-packs:k"), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const calls = stub.mock.calls as unknown as [string, RequestInit & { ttlSeconds?: number; cacheKey?: string }][];
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0][0]);
    expect(url.origin + url.pathname).toBe(
      "https://geodataservices.wdfw.wa.gov/arcgis/rest/services/WP_Statewide/Wolf_PackPolygons/MapServer/1/query",
    );
    expect(url.searchParams.get("where")).toBe("1=1");
    expect(url.searchParams.get("outFields")).toBe("Pack,Year,PackStatus");
    expect(url.searchParams.get("geometry")).toBe(NE_WASHINGTON.join(","));
    expect(calls[0][1].cacheKey).toBe("wolf-packs:k:wolves");
    expect(r.data.features).toHaveLength(fixture.features.length);
    expect(r.coverageNote).toBeUndefined();
  });

  it("filters to one year when asked", async () => {
    const stub = vi.fn(async () => json(fixture));
    await layer.query(ctx(stub), { year: 2023 });
    const url = new URL((stub.mock.calls as unknown as [string][])[0][0]);
    expect(url.searchParams.get("where")).toBe("Year=2023");
  });

  it("says when the service capped the result", async () => {
    const stub = vi.fn(async () => json({ ...fixture, exceededTransferLimit: true }));
    const r = await layer.query(ctx(stub), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toMatch(/pick a year/);
  });

  it("returns a note without calling upstream outside Washington", async () => {
    const stub = vi.fn();
    const r = await layer.query({ bbox: [-110, 44, -109, 45], zoom: 9, env: {}, fetch: stub as unknown as CachedFetch }, {});
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toMatch(/Washington/);
  });

  it("says the data starts in 2014 for an earlier year, without calling upstream", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub), { year: 2010 });
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toMatch(/start in 2014/);
    expect(r.coverageNote).toMatch(/2010/);
  });

  it("maps an ArcGIS error body and an HTTP error to upstream errors", async () => {
    const body = vi.fn(async () => json({ error: { code: 400, message: "Unable to complete operation." } }));
    expect(await layer.query(ctx(body), {})).toMatchObject({ hint: "upstream" });
    const http = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(await layer.query(ctx(http), {})).toMatchObject({ hint: "upstream" });
  });

  it("rejects an oversized bbox through runLayer", async () => {
    expect((await runLayer("wolf-packs", { bbox: [-125, 40, -110, 50], zoom: 4 })).status).toBe(422);
  });

  it("says Washington only and names California's PDFs", () => {
    expect(layer.description).toMatch(/Washington only/);
    expect(layer.description).toMatch(/California publishes reports as PDFs only/);
  });
});
