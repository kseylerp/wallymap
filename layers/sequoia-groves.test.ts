import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { normalizeGroves } from "./sequoia-groves";
import raw from "./__fixtures__/sequoia-groves.seki.json";

const fixture = raw as unknown as FeatureCollection;

const GIANT_FOREST: [number, number, number, number] = [-118.9, 36.4, -118.5, 36.7];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string) {
  return { bbox: GIANT_FOREST, zoom: 10, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

describe("sequoia-groves layer", () => {
  it("declares sage polygons, no env, no input and a public domain license", () => {
    expect(layer.id).toBe("sequoia-groves");
    expect(layer.license).toMatch(/terms not stated/);
    expect(layer.license).toMatch(/Save the Redwoods League/);
    expect(layer.license).toMatch(/University of California/);
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(120_000);
    expect(layer.input.parse({})).toEqual({});
    expect(layer.style).toEqual({ geometry: "polygon", color: "#9FB693", unit: "acres", fillOpacity: 0.3 });
  });

  it("normalizes grove rows to polygons with name, acres, v, stewards and kind", () => {
    const fc = normalizeGroves(fixture);
    expect(fc.features).toHaveLength(fixture.features.length);
    for (const f of fc.features) {
      expect(["Polygon", "MultiPolygon"]).toContain(f.geometry.type);
      const p = f.properties ?? {};
      expect(typeof p.name).toBe("string");
      expect(p.kind).toBe("grove");
      expect(p.v).toBe(p.acres);
    }
    const atwell = fc.features.find((f) => f.properties?.name === "Atwell");
    expect(atwell?.properties).toMatchObject({ acres: 916.4, v: 916.4, stewards: "NPS SEKI, Private" });
  });

  it("skips rows without geometry and tolerates missing fields", () => {
    const fc = normalizeGroves({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: null as never, properties: { Grove_Name: "Ghost" } },
        { type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: {} },
      ],
    });
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toEqual({ name: "Unnamed grove", kind: "grove" });
  });

  it("queries the service once with the bbox, the display simplification and a week of cache", async () => {
    const stub = vi.fn(async () => json(fixture));
    const r = await layer.query(ctx(stub, "sequoia-groves:k"), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");

    const calls = stub.mock.calls as unknown as [string, RequestInit & { ttlSeconds?: number; cacheKey?: string }][];
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0][0]);
    expect(url.origin + url.pathname).toBe(
      "https://services1.arcgis.com/fBc8EJBxQRMcHlei/ArcGIS/rest/services/PWR_Sequoia_Groves_2024/FeatureServer/0/query",
    );
    expect(url.searchParams.get("geometry")).toBe(GIANT_FOREST.join(","));
    expect(url.searchParams.get("outFields")).toBe("Grove_Name,Acres,Land_Steward_List");
    expect(calls[0][1].ttlSeconds).toBe(7 * 86_400);
    expect(calls[0][1].cacheKey).toBe("sequoia-groves:k:groves");
    expect(r.data.features.length).toBe(fixture.features.length);
    expect(r.citation.source).toContain("Sequoia and Kings Canyon");
  });

  it("returns a note without calling upstream when the view is outside the Sierra Nevada", async () => {
    const stub = vi.fn();
    const r = await layer.query({ bbox: [2, 45, 3, 46], zoom: 9, env: {}, fetch: stub as unknown as CachedFetch }, {});
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toMatch(/Sierra Nevada/);
  });

  it("maps an ArcGIS error body and an HTTP error to upstream errors", async () => {
    const body = vi.fn(async () => json({ error: { code: 400, message: "Unable to complete operation." } }));
    expect(await layer.query(ctx(body), {})).toMatchObject({ hint: "upstream" });
    const http = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(await layer.query(ctx(http), {})).toMatchObject({ hint: "upstream" });
  });

  it("refuses a huge area through runLayer", async () => {
    const res = await runLayer("sequoia-groves", { bbox: [-125, 30, -115, 40], zoom: 5 });
    expect(res.status).toBe(422);
  });

  it("describes the groves and points to the fire-death layer", () => {
    expect(layer.description).toMatch(/giant sequoia/i);
    expect(layer.description).toMatch(/sequoia-mortality/);
  });
});
