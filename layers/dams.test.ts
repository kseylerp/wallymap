import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { normalizeDams } from "./dams";
import raw from "./__fixtures__/dams.bayarea.json";

/** The fixture is the live National Inventory of Dams answer for this box, 12 largest by storage, recorded 2026-10-10. */
const fixture = raw as unknown as FeatureCollection;
const BAY: [number, number, number, number] = [-122.5, 37.2, -121.5, 38];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string, bbox = BAY) {
  return { bbox, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

function geojson(r: Awaited<ReturnType<typeof layer.query>>) {
  if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
  return r;
}

describe("dams layer", () => {
  it("declares US coverage, the public domain license, no env and no input, and draws columns by storage", () => {
    expect(layer.id).toBe("dams");
    expect(layer.coverage).toBe("us");
    expect(layer.license).toContain("Public domain");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(250_000);
    expect(layer.hardMaxAreaKm2).toBe(50_000_000);
    expect(layer.wide).toEqual({ orderBy: "storage in acre-feet", limit: 2000 });
    expect(layer.input.parse({})).toEqual({});
    expect(layer.style).toMatchObject({ geometry: "point", extrude: "v", unit: "acre-feet" });
  });

  it("turns service rows into points with storage in v, the year built in t and the purpose as kind", () => {
    const fc = normalizeDams(fixture);
    expect(fc.features).toHaveLength(fixture.features.length);
    const vaqueros = fc.features.find((f) => f.properties?.name === "Los Vaqueros");
    expect(vaqueros?.geometry.type).toBe("Point");
    expect(vaqueros?.properties).toMatchObject({
      nidId: "CA01396",
      v: 160000,
      storageAf: 160000,
      heightFt: 231,
      yearCompleted: 1997,
      t: "1997-01-01T00:00:00.000Z",
      purpose: "Water Supply",
      kind: "Water Supply",
      hazard: "High",
      river: "Kellogg Creek",
      state: "California",
      owner: "Public Utility",
      damType: "Earth",
    });
    // A year in the 1800s stays a 4-digit year (Date.UTC would not).
    const crystal = fc.features.find((f) => f.properties?.name === "Ler Crystal Springs");
    expect(crystal?.properties?.t).toBe("1888-01-01T00:00:00.000Z");
  });

  it("drops rows with no geometry and leaves out missing, zero or implausible values", () => {
    const point = { type: "Point" as const, coordinates: [-120, 38] };
    const fc = normalizeDams({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: null as never, properties: { NAME: "Ghost" } },
        {
          type: "Feature",
          geometry: point,
          properties: { NAME: "Old pond", YEAR_COMPLETED: 0, NID_STORAGE: 12, NID_HEIGHT: 0, PRIMARY_PURPOSE: "N/A", RIVER_OR_STREAM: " " },
        },
        { type: "Feature", geometry: point, properties: { YEAR_COMPLETED: 25, NID_STORAGE: null } },
      ],
    });
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0].properties).toEqual({ name: "Old pond", storageAf: 12, v: 12 });
    expect(fc.features[1].properties).toEqual({ name: "Unnamed dam" });
  });

  it("asks for storage-ordered dams with a storage figure and a day of cache, and says when the cap is hit", async () => {
    const stub = vi.fn(async () => json(fixture));
    const r = geojson(await layer.query(ctx(stub, "dams:k"), {}));
    expect(r.data.features).toHaveLength(12);
    expect(r.coverageNote).toBe("Showing the 2,000 dams with the most storage; zoom in for the rest");

    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit & { cacheKey?: string; ttlSeconds?: number }];
    const params = new URL(url).searchParams;
    expect(url).toContain("National_Inventory_of_Dams_Public_Service/FeatureServer/0/query");
    expect(params.get("where")).toBe("NID_STORAGE > 0");
    expect(params.get("orderByFields")).toBe("NID_STORAGE DESC");
    expect(params.get("geometry")).toBe("-122.5,37.2,-121.5,38");
    expect(params.get("resultRecordCount")).toBe("2000");
    expect(params.get("outFields")).toContain("YEAR_COMPLETED");
    expect(init.ttlSeconds).toBe(86_400);
    expect(init.cacheKey).toBe("dams:k:dams");
  });

  it("says so when the area has no dams, and returns nothing outside the US without calling out", async () => {
    const empty = vi.fn(async () => json({ type: "FeatureCollection", features: [] }));
    expect(geojson(await layer.query(ctx(empty), {})).coverageNote).toBe("No dams in the National Inventory of Dams for this area");
    const stub = vi.fn();
    const abroad = geojson(await layer.query(ctx(stub, undefined, [5, 45, 6, 46]), {}));
    expect(abroad.coverageNote).toBe("No data outside the United States");
    expect(stub).not.toHaveBeenCalled();
  });

  it("maps upstream failures to upstream errors", async () => {
    expect(await layer.query(ctx(vi.fn(async () => new Response("x", { status: 500 }))), {})).toEqual({
      error: "ArcGIS service returned 500",
      hint: "upstream",
    });
    expect(await layer.query(ctx(vi.fn(async () => json({ error: { code: 400, message: "Invalid query" } }))), {})).toMatchObject({
      hint: "upstream",
    });
  });

  it("is registered and rejects through runLayer only a box wider than the whole US", async () => {
    const res = await runLayer("dams", { bbox: [-180, -60, 180, 80], zoom: 1 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ hint: "zoom_in", error: expect.stringMatching(/zoom in to under 50000000 km²$/) });
  });

  it("answers the Colorado River basin wide: biggest storage first, a count, and a note naming the total", async () => {
    const stub = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return url.searchParams.get("returnCountOnly") === "true" ? json({ count: 5321 }) : json({ ...fixture, exceededTransferLimit: true });
    });
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("dams", { bbox: [-117, 31, -105, 43.5], zoom: 5 });
      expect(res.status).toBe(200);
      const urls = stub.mock.calls.map((c) => new URL(String(c[0])));
      const data = urls.find((u) => !u.searchParams.has("returnCountOnly"));
      expect(data?.searchParams.get("orderByFields")).toBe("NID_STORAGE DESC");
      expect(data?.searchParams.get("resultRecordCount")).toBe("2000");
      expect(data?.searchParams.get("where")).toBe("NID_STORAGE > 0");
      expect(urls.find((u) => u.searchParams.has("returnCountOnly"))?.searchParams.get("where")).toBe("NID_STORAGE > 0");
      expect(res.body).toMatchObject({
        total: 5321,
        truncated: true,
        coverageNote: `Showing the ${fixture.features.length} largest of 5,321 (ranked by storage in acre-feet); zoom in under 250,000 km² for all`,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leaves the truncation note to runLayer in wide mode and passes the count through", async () => {
    const stub = vi.fn(async (url: string) =>
      new URL(url).searchParams.get("returnCountOnly") === "true" ? json({ count: 5321 }) : json({ ...fixture, exceededTransferLimit: true }),
    );
    const r = geojson(await layer.query({ ...ctx(stub, "dams:k", [-117, 31, -105, 43.5]), wide: true, wideStrategy: layer.wide }, {}));
    expect(r.total).toBe(5321);
    expect(r.coverageNote).toBeUndefined();
  });

  it("describes dams in the words people use and the hazard caveat", () => {
    expect(layer.description).toMatch(/hazard/);
    expect(layer.description).toMatch(/safety rating/);
    expect(layer.description).toMatch(/About 3% of dams have no storage figure and are left out/);
    expect(layer.description).toMatch(/decade/);
  });
});
