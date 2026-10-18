import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { getLayer } from "./registry";
import layer, { normalizePorts, portsUrl } from "./ports";
import raw from "./__fixtures__/ports.gulf.json";
import { contractProblems, labelsOf, legendOf, timeShapeOf } from "./contract";

const GULF: [number, number, number, number] = [-97, 27, -88, 31];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string) {
  return { bbox: GULF, zoom: 6, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

describe("ports layer", () => {
  it("declares US coverage, extruded dark grey points, no env and no input", () => {
    expect(layer.id).toBe("ports");
    expect(layer.coverage).toBe("us");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.input.parse({})).toEqual({});
    expect(layer.style).toEqual({ geometry: "point", color: "#3A3A3C", unit: "short tons", extrude: "v", encode: { size: "tons" } });
    expect(layer.license).toMatch(/Public domain/);
  });

  it("builds a request that asks for centroids instead of polygons, biggest port first", () => {
    const url = new URL(portsUrl(GULF));
    expect(url.origin + url.pathname).toBe(
      "https://services7.arcgis.com/n1YM8pTrFmm7L4hs/ArcGIS/rest/services/Principal_Ports/FeatureServer/0/query",
    );
    expect(url.searchParams.get("returnCentroid")).toBe("true");
    expect(url.searchParams.get("returnGeometry")).toBe("false");
    expect(url.searchParams.get("f")).toBe("json");
    expect(url.searchParams.get("outSR")).toBe("4326");
    expect(url.searchParams.get("geometry")).toBe(GULF.join(","));
    expect(url.searchParams.get("orderByFields")).toBe("TOTAL DESC");
  });

  it("normalizes rows to points at the centroid with total tons as v", () => {
    const fc = normalizePorts(raw);
    expect(fc.features).toHaveLength(raw.features.length);
    for (const f of fc.features) expect(f.geometry.type).toBe("Point");
    const houston = fc.features[0];
    expect(houston.properties).toMatchObject({
      name: "Houston Port Authority, TX",
      kind: "Coastal",
      rank: 1,
      tons: 309531236,
      v: 309531236,
    });
    expect(houston.properties?.foreignTons).toBeTypeOf("number");
    const [lon, lat] = (houston.geometry as { coordinates: number[] }).coordinates;
    expect(lon).toBeCloseTo(-95.3925, 3);
    expect(lat).toBeCloseTo(29.8576, 3);
    expect(fc.features.some((f) => f.properties?.kind === "Internal")).toBe(true);
  });

  it("skips rows without a centroid and tolerates missing fields", () => {
    const fc = normalizePorts({
      features: [
        { attributes: { PORTNAME: "Ghost" } },
        { attributes: {}, centroid: { x: -90, y: 30 } },
      ],
    });
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toEqual({ name: "Unnamed port" });
    expect(normalizePorts(null).features).toHaveLength(0);
  });

  it("queries once with a cache key and a week of cache", async () => {
    const stub = vi.fn(async () => json(raw));
    const r = await layer.query(ctx(stub, "ports:k"), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const calls = stub.mock.calls as unknown as [string, RequestInit & { cacheKey?: string; ttlSeconds?: number }][];
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(portsUrl(GULF));
    expect(calls[0][1].cacheKey).toBe("ports:k:ports");
    expect(calls[0][1].ttlSeconds).toBe(7 * 86_400);
    expect(r.data.features).toHaveLength(raw.features.length);
    expect(r.citation.source).toContain("Army Corps");
  });

  it("maps an ArcGIS error body, a bad shape, an HTTP error and a network failure to upstream errors", async () => {
    const body = vi.fn(async () => json({ error: { code: 400, message: "Unable to complete operation." } }));
    expect(await layer.query(ctx(body), {})).toMatchObject({ hint: "upstream", error: expect.stringContaining("Unable to complete operation.") });
    const shape = vi.fn(async () => json({ nope: true }));
    expect(await layer.query(ctx(shape), {})).toMatchObject({ hint: "upstream" });
    const http = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(await layer.query(ctx(http), {})).toMatchObject({ hint: "upstream" });
    const down = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await layer.query(ctx(down), {})).toMatchObject({ hint: "upstream" });
  });

  it("returns a coverage note without calling upstream outside the US", async () => {
    const stub = vi.fn();
    const r = await layer.query({ bbox: [2, 45, 3, 46], zoom: 6, env: {}, fetch: stub as unknown as CachedFetch }, {});
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toBe("No data outside the United States");
  });

  it("is registered and has no area limit, since the whole country is 150 points", () => {
    expect(getLayer("ports")).toBe(layer);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
  });

  it("explains tonnage, the year and that a point is the port area's middle", () => {
    expect(layer.description).toMatch(/short tons/);
    expect(layer.description).toMatch(/2023/);
    expect(layer.description).toMatch(/middle of the port's area/);
  });

  it("sizes ports by tons, chips them by type, labels the five busiest and states the 2023 year", async () => {
    const data = normalizePorts(raw);
    expect(layer.attributes?.find((a) => a.key === "tons")).toMatchObject({ type: "measure", encode: "size", unit: "short tons" });
    const types = layer.attributes?.find((a) => a.key === "kind");
    expect(types?.levels?.map((l) => l.label)).toEqual(["Coastal", "Inland (rivers and waterways)", "Great Lakes"]);
    const legend = legendOf(layer, data);
    expect(legend).toMatchObject({ kind: "size", field: "tons", unit: "short tons", title: "Cargo in 2023" });
    expect(legend.note).toMatch(/2023/);
    expect(timeShapeOf(layer, data)).toEqual({ shape: "single", dates: ["2023"] });
    expect(labelsOf(layer)).toEqual({ field: "name", max: 5, rankBy: "tons" });
    // The labels rank by tons: Houston and South Louisiana lead the Gulf fixture.
    const top = [...data.features].sort((a, b) => Number(b.properties?.tons) - Number(a.properties?.tons)).slice(0, 2);
    expect(top.map((f) => f.properties?.name)).toEqual(["Houston Port Authority, TX", "South Louisiana, LA, Port of"]);
    expect(contractProblems(layer)).toEqual([]);
    const r = await layer.query(ctx(vi.fn(async () => json(raw))), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toMatch(/calendar year 2023/);
  });
});
