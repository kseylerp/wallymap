import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { GEOLOGY_SOURCE_LAYER, GEOLOGY_TILE_URL, identifyFeature } from "./geology";
import fixture from "./__fixtures__/geology.units.tahoe.json";

/** The fixture is a real Macrostrat response for (lon -120.0, lat 38.9): four units, one per map scale. */
const TAHOE_POINT = { lon: -120.0, lat: 38.9 };
const BBOX: [number, number, number, number] = [-120.2, 38.8, -119.8, 39.0];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string) {
  return { bbox: BBOX, zoom: 12, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

describe("geology layer", () => {
  it("declares global coverage, no env, no area cap, a point input and polygon style", () => {
    expect(layer.id).toBe("geology");
    expect(layer.coverage).toBe("global");
    expect(layer.license).toContain("CC BY 4.0");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
    expect(layer.input.parse({})).toEqual({});
    expect(layer.input.parse({ point: TAHOE_POINT })).toEqual({ point: TAHOE_POINT });
    expect(() => layer.input.parse({ point: { lon: 200, lat: 0 } })).toThrow();
    expect(layer.style).toMatchObject({ geometry: "polygon" });
  });

  it("without a point hands the map the vector tiles and makes no upstream call", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub), {});
    expect(r).toMatchObject({
      kind: "tiles",
      data: {
        url: "https://tiles.macrostrat.org/carto/{z}/{x}/{y}.mvt",
        minzoom: 0,
        maxzoom: 16,
        format: "vector",
        sourceLayer: "units",
        geometry: "polygon",
      },
    });
    expect(GEOLOGY_TILE_URL).toContain("{z}/{x}/{y}");
    expect(GEOLOGY_SOURCE_LAYER).toBe("units");
    expect(stub).not.toHaveBeenCalled();
  });

  it("with a point returns a one-feature GeoJSON for the most detailed unit", async () => {
    const stub = vi.fn(async () => json(fixture));
    const r = await layer.query(ctx(stub, "geology:key"), { point: TAHOE_POINT });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
    expect(r.data.features).toHaveLength(1);
    const f = r.data.features[0];
    expect(f.geometry).toEqual({ type: "Point", coordinates: [-120, 38.9] });
    expect(f.properties).toMatchObject({
      name: "Till",
      age: "Pleistocene",
      mapScale: "large",
      color: "#FFF2AE",
    });
    expect(String(f.properties?.description)).toContain("bouldery deposits");
    expect(String(f.properties?.alsoMapped)).toContain("medium map: Mesozoic granitic rocks");
    expect(String(f.properties?.alsoMapped)).toContain("tiny map: Mesozoic intrusive rocks");
    expect(String(f.properties?.reference).length).toBeGreaterThan(10);
    const [url, init] = stub.mock.calls[0] as unknown as [string, { cacheKey?: string; headers?: Record<string, string> }];
    expect(url).toBe("https://macrostrat.org/api/v2/geologic_units/map?lat=38.9&lng=-120");
    expect(init.cacheKey).toBe("geology:key:identify:38.9,-120");
    expect(init.headers?.["user-agent"]).toContain("WildMap");
    expect(r.citation.source).toContain("Macrostrat");
  });

  it("reports an age range and lithology for a multi-interval unit", () => {
    const units = (fixture as { success: { data: Parameters<typeof identifyFeature>[2] } }).success.data;
    const granite = identifyFeature(-120, 38.9, units.filter((u) => u.scale !== "large"));
    expect(granite?.properties).toMatchObject({
      name: expect.stringContaining("Mesozoic granitic rocks"),
      age: "Lopingian to Tertiary",
      ageTopMa: 2.588,
      ageBottomMa: 259.1,
      mapScale: "medium",
    });
    expect(String(granite?.properties?.lithology)).toContain("granodiorite");
    expect(String(granite?.properties?.formations).length).toBeLessThanOrEqual(200);
  });

  it("says so when there is no unit at the point", async () => {
    const stub = vi.fn(async () => json({ success: { v: 2, data: [] } }));
    const r = await layer.query(ctx(stub), { point: { lon: 0, lat: 0 } });
    expect(r).toMatchObject({ kind: "geojson", data: { features: [] }, coverageNote: "Macrostrat has no geologic map unit at this point" });
  });

  it("maps upstream failures to hinted errors", async () => {
    const input = { point: TAHOE_POINT };
    expect(await layer.query(ctx(vi.fn(async () => new Response("no", { status: 502 }))), input)).toEqual({
      error: "Macrostrat returned 502",
      hint: "upstream",
    });
    expect(await layer.query(ctx(vi.fn(async () => new Response("<html>"))), input)).toMatchObject({ hint: "upstream" });
    expect(await layer.query(ctx(vi.fn(async () => json({ error: "bad" }))), input)).toEqual({
      error: "Macrostrat returned an unexpected response",
      hint: "upstream",
    });
    const slow = vi.fn(async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    expect(await layer.query(ctx(slow), input)).toMatchObject({ error: expect.stringContaining("timed out"), hint: "upstream" });
  });

  it("accepts any size of view through runLayer (tiles need no area cap)", async () => {
    const r = await runLayer("geology", { bbox: [-170, -60, 170, 70] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: "tiles" });
  });
});
