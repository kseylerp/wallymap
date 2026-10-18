import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { normalizeGroves } from "./sequoia-groves";
import raw from "./__fixtures__/sequoia-groves.seki.json";
import { contractProblems, labelsOf, legendOf, timeShapeOf } from "./contract";

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
    expect(layer.hardMaxAreaKm2).toBeUndefined();
    expect(layer.wide).toEqual({ orderBy: "acres", limit: 1000 });
    expect(layer.input.parse({})).toEqual({});
    expect(layer.style).toEqual({ geometry: "polygon", color: "#9FB693", unit: "acres", fillOpacity: 0.4 });
  });

  it("has no time, a sage grove key that names the 2024 draft map, and labels the five largest groves", () => {
    const data = normalizeGroves(fixture);
    expect(timeShapeOf(layer, data)).toEqual({ shape: "none" });
    const legend = legendOf(layer, data);
    expect(legend).toMatchObject({ kind: "symbol", items: [{ label: "Giant sequoia grove", color: "#9FB693", symbol: "polygon" }] });
    expect(legend.note).toMatch(/2024/);
    expect(labelsOf(layer)).toEqual({ field: "name", max: 5, rankBy: "acres" });
    const top = [...data.features].sort((a, b) => Number(b.properties?.acres) - Number(a.properties?.acres))[0];
    // The fixture's largest grove, the first the labels name.
    expect(top.properties).toMatchObject({ name: "Atwell", acres: 916.4 });
    expect(contractProblems(layer)).toEqual([]);
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

  it("answers a wide box largest first with a count, and runLayer writes the note", async () => {
    const stub = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return url.searchParams.get("returnCountOnly") === "true" ? json({ count: 96 }) : json(fixture);
    });
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("sequoia-groves", { bbox: [-122, 35, -117, 40], zoom: 6 });
      expect(res.status).toBe(200);
      const data = stub.mock.calls.map((c) => new URL(String(c[0]))).find((u) => !u.searchParams.has("returnCountOnly"));
      expect(data?.searchParams.get("orderByFields")).toBe("Acres DESC");
      expect(data?.searchParams.get("resultRecordCount")).toBe("1000");
      expect(res.body).toMatchObject({
        total: 96,
        truncated: true,
        coverageNote: `Showing the ${fixture.features.length} largest of 96 (ranked by acres); zoom in under 120,000 km² for all`,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses through runLayer only a box over four times the soft cap", async () => {
    const res = await runLayer("sequoia-groves", { bbox: [-125, 30, -115, 40], zoom: 5 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ hint: "zoom_in", error: expect.stringMatching(/zoom in to under 480000 km²$/) });
  });

  it("describes the groves and points to the fire-death layer", () => {
    expect(layer.description).toMatch(/giant sequoia/i);
    expect(layer.description).toMatch(/sequoia-mortality/);
  });
});
