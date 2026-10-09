import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { mvumWhere, normalizeMvum } from "./forest-roads";
import raw from "./__fixtures__/forest-roads.tahoe.json";

const fixture = raw as unknown as FeatureCollection;
const TAHOE: [number, number, number, number] = [-120.2, 38.85, -120, 39];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string, bbox = TAHOE) {
  return { bbox, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

function params(url: unknown): URLSearchParams {
  return new URL(String(url)).searchParams;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mvumWhere", () => {
  it("keeps only roads open to ordinary highway-legal vehicles by default", () => {
    expect(mvumWhere(false)).toBe("symbol IN ('1','2','3','4')");
  });

  it("adds the special-designation roads (symbols 11 and 12) when all roads are requested", () => {
    expect(mvumWhere(true)).toBe("symbol IN ('1','2','3','4','11','12')");
  });
});

describe("normalizeMvum", () => {
  it("maps fixture rows to road lines with route id, access class, seasonality and vehicle flags", () => {
    const fc = normalizeMvum(fixture);
    expect(fc.features).toHaveLength(fixture.features.length);
    for (const f of fc.features) {
      expect(f.geometry.type).toBe("LineString");
      const p = f.properties ?? {};
      expect(typeof p.routeId).toBe("string");
      expect(typeof p.access).toBe("string");
      expect(typeof p.seasonal).toBe("boolean");
      expect(typeof p.passengerCar).toBe("boolean");
      expect(typeof p.highClearance).toBe("boolean");
      // The national MVUM service has no dispersed-camping attribute, so none is claimed.
      expect(p).not.toHaveProperty("dispersedCamping");
    }
    const tallac = fc.features.find((f) => f.properties?.routeId === "1302");
    expect(tallac?.properties).toMatchObject({
      name: "TALLAC HISTORIC SITE",
      forest: "Lake Tahoe Basin Management Unit",
      access: "Roads open to highway legal vehicles only, Seasonal",
      seasonal: true,
      passengerCar: true,
      highClearance: true,
      surface: "AC - ASPHALT",
    });
  });

  it("omits name when the service has none and derives seasonality from the symbol when the field is null", () => {
    const fc = normalizeMvum({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
          properties: { id: "9", name: null, symbol: "12", seasonal: null, passengervehicle: "restricted" },
        },
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
          properties: { id: "10", symbol: "3", seasonal: null },
        },
      ],
    });
    expect(fc.features[0].properties).not.toHaveProperty("name");
    expect(fc.features[0].properties).toMatchObject({ seasonal: true, passengerCar: false });
    expect(fc.features[1].properties).toMatchObject({ seasonal: false });
  });

  it("skips rows with no geometry or no route id", () => {
    const fc = normalizeMvum({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: null as never, properties: { id: "1" } },
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
          properties: { name: "No id" },
        },
      ],
    });
    expect(fc.features).toHaveLength(0);
  });
});

describe("forest-roads layer", () => {
  it("declares US coverage, no key and a 20,000 km2 cap", () => {
    expect(layer.coverage).toBe("us");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(20_000);
    expect(layer.style).toEqual({ geometry: "line", color: "#C4633F" });
    expect(layer.license).toBe("Public domain (USDA Forest Service)");
  });

  it("queries MVUM roads layer 1 with the filter, a 24 hour cache and a cache key", async () => {
    const stub = vi.fn(async () => json(fixture));
    const r = await layer.query(ctx(stub, "forest-roads:k"), { includeAllRoads: false });
    const [url, init] = stub.mock.calls[0] as unknown as [
      string,
      RequestInit & { cacheKey?: string; ttlSeconds?: number },
    ];
    expect(url.startsWith("https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MVUM_01/MapServer/1/query?")).toBe(true);
    expect(params(url).get("where")).toBe("symbol IN ('1','2','3','4')");
    expect(params(url).get("geometry")).toBe("-120.2,38.85,-120,39");
    expect(params(url).get("outFields")).toContain("mvum_symbol_name");
    expect(init.ttlSeconds).toBe(86_400);
    expect(init.cacheKey).toBe("forest-roads:k:mvum-roads");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(fixture.features.length);
    expect(r.citation.source).toContain("Forest Service");
    expect(r.coverageNote).toBeUndefined();
  });

  it("uses the wider where clause when includeAllRoads is true", async () => {
    const stub = vi.fn(async (_url: string) => json(fixture));
    await layer.query(ctx(stub), { includeAllRoads: true });
    expect(params(stub.mock.calls[0][0]).get("where")).toBe("symbol IN ('1','2','3','4','11','12')");
  });

  it("maps a 200 ArcGIS { error } body to an upstream error", async () => {
    const stub = vi.fn(async () => json({ error: { code: 400, message: "Unable to complete operation." } }));
    const r = await layer.query(ctx(stub), { includeAllRoads: false });
    expect(r).toEqual({ error: "ArcGIS service error: Unable to complete operation.", hint: "upstream" });
  });

  it("maps a non-2xx response to an upstream error", async () => {
    const stub = vi.fn(async () => new Response("down", { status: 503 }));
    const r = await layer.query(ctx(stub), { includeAllRoads: false });
    expect(r).toEqual({ error: "ArcGIS service returned 503", hint: "upstream" });
  });

  it("flags a truncated result", async () => {
    const stub = vi.fn(async () => json({ ...fixture, exceededTransferLimit: true }));
    const r = await layer.query(ctx(stub), { includeAllRoads: false });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toBe("Showing the first 2,000 road segments; zoom in for the rest");
  });

  it("returns an empty result with a note, without calling upstream, outside the US", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub, undefined, [2, 48, 3, 49]), { includeAllRoads: false });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toBe("No data outside the United States");
    expect(stub).not.toHaveBeenCalled();
  });

  it("returns 422 zoom_in from runLayer for a bbox over 20,000 km2", async () => {
    const res = await runLayer("forest-roads", { bbox: [-122, 37, -119, 40] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ hint: "zoom_in" });
  });
});
