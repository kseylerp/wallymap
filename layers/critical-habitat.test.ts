import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { normalizeCriticalHabitat, simplifyOffset, speciesWhere } from "./critical-habitat";
import finalRaw from "./__fixtures__/critical-habitat.tahoe.json";
import proposedRaw from "./__fixtures__/critical-habitat.proposed.json";

const finalFc = finalRaw as unknown as FeatureCollection;
const proposedFc = proposedRaw as unknown as FeatureCollection;

const TAHOE: [number, number, number, number] = [-120.4, 38.7, -119.8, 39.3];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** Answers the final layer (…/FeatureServer/0/query) and the proposed layer (…/2/query) separately. */
function serviceStub(finalBody: unknown, proposedBody: unknown) {
  return vi.fn(async (url: string) => (url.includes("/FeatureServer/2/query") ? json(proposedBody) : json(finalBody)));
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string) {
  return { bbox: TAHOE, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

describe("critical-habitat layer", () => {
  it("declares US coverage, the public domain license and its input defaults", () => {
    expect(layer.id).toBe("critical-habitat");
    expect(layer.coverage).toBe("us");
    expect(layer.license).toBe("Public domain (US Fish and Wildlife Service)");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(300_000);
    expect(layer.hardMaxAreaKm2).toBeUndefined();
    expect(layer.wide).toEqual({ orderBy: "area", limit: 1000 });
    expect(layer.input.parse({})).toEqual({ includeProposed: true });
    expect(layer.style).toMatchObject({ geometry: "polygon", fillOpacity: 0.25 });
  });

  it("normalizes rows to polygons with species as kind, status and the publication date as published (never t)", () => {
    const fc = normalizeCriticalHabitat(finalFc);
    expect(fc.features).toHaveLength(finalFc.features.length);
    const frog = fc.features.find((f) => f.properties?.scientificName === "Rana sierrae");
    expect(frog?.geometry.type).toMatch(/Polygon/);
    expect(frog?.properties).toEqual({
      species: "Sierra Nevada Yellow-legged Frog",
      kind: "Sierra Nevada Yellow-legged Frog",
      scientificName: "Rana sierrae",
      status: "Final",
      listingStatus: "Endangered",
      federalRegister: "81FR59046 59119",
      published: "2016-08-26",
    });
  });

  it("falls back to the scientific name, skips placeholder dates and drops rows without geometry", () => {
    const square = { type: "Polygon" as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
    const fc = normalizeCriticalHabitat({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: square, properties: { sciname: "Rana muscosa", pubdate: "Please check current species specific shapefile" } },
        { type: "Feature", geometry: null as never, properties: { comname: "Ghost" } },
        { type: "Feature", geometry: square, properties: {} },
      ],
    });
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0].properties).toEqual({ species: "Rana muscosa", kind: "Rana muscosa", scientificName: "Rana muscosa" });
    expect(fc.features[1].properties?.species).toBe("Unnamed species");
    for (const f of finalFc.features.length ? normalizeCriticalHabitat(finalFc).features : []) expect(f.properties).not.toHaveProperty("t");
  });

  it("builds a species filter that escapes quotes and strips LIKE wildcards", () => {
    expect(speciesWhere(undefined)).toBeUndefined();
    expect(speciesWhere("bull trout")).toBe("UPPER(comname) LIKE '%BULL TROUT%' OR UPPER(sciname) LIKE '%BULL TROUT%'");
    expect(speciesWhere("Parish's daisy")).toContain("PARISH''S DAISY");
    expect(speciesWhere("a%b_c")).toContain("'%ABC%'");
    expect(speciesWhere("%_")).toBeUndefined();
  });

  it("simplifies coarser for wider views", () => {
    expect(simplifyOffset([-120.4, 38.7, -120.3, 38.8])).toBe(0.001);
    expect(simplifyOffset([-122, 43, -119, 46])).toBeCloseTo(0.02, 5);
    expect(simplifyOffset([-130, 30, -100, 50])).toBe(0.03);
    expect(simplifyOffset([-130, 30, -100, 50], true)).toBe(0.05);
  });

  it("queries the final and proposed layers with the bbox, fields and a one day cache, and merges them", async () => {
    const stub = serviceStub(finalFc, proposedFc);
    const r = await layer.query(ctx(stub, "critical-habitat:k"), { includeProposed: true });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");

    const calls = stub.mock.calls as unknown as [string, RequestInit & { ttlSeconds?: number; cacheKey?: string }][];
    expect(calls).toHaveLength(2);
    const urls = calls.map(([u]) => new URL(u));
    expect(urls.map((u) => u.origin + u.pathname).sort()).toEqual([
      "https://services.arcgis.com/QVENGdaPbd4LUkLV/arcgis/rest/services/USFWS_Critical_Habitat/FeatureServer/0/query",
      "https://services.arcgis.com/QVENGdaPbd4LUkLV/arcgis/rest/services/USFWS_Critical_Habitat/FeatureServer/2/query",
    ]);
    for (const u of urls) {
      expect(u.searchParams.get("geometry")).toBe(TAHOE.join(","));
      expect(u.searchParams.get("outFields")).toBe("comname,sciname,status,listing_status,pubdate,fedreg");
      expect(u.searchParams.get("where")).toBe("1=1");
    }
    expect(calls.map(([, init]) => init.cacheKey).sort()).toEqual([
      "critical-habitat:k:ch-final",
      "critical-habitat:k:ch-proposed",
    ]);
    expect(calls[0][1].ttlSeconds).toBe(86_400);

    expect(r.data.features).toHaveLength(finalFc.features.length + proposedFc.features.length);
    expect(r.data.features.some((f) => f.properties?.status === "Proposed")).toBe(true);
    expect(r.coverageNote).toBeUndefined();
    expect(r.citation.source).toContain("Fish and Wildlife");
  });

  it("passes the species filter to the service and can skip the proposed layer", async () => {
    const stub = serviceStub(finalFc, proposedFc);
    await layer.query(ctx(stub), { species: "yellow-legged", includeProposed: false });
    expect(stub).toHaveBeenCalledTimes(1);
    const url = new URL((stub.mock.calls as unknown as [string][])[0][0]);
    expect(url.searchParams.get("where")).toContain("LIKE '%YELLOW-LEGGED%'");
    expect(url.pathname).toContain("/FeatureServer/0/query");
  });

  it("notes when the service capped the result, and when only the proposed layer failed", async () => {
    const capped = serviceStub({ ...finalFc, exceededTransferLimit: true }, proposedFc);
    const r1 = await layer.query(ctx(capped), { includeProposed: true });
    if (!("kind" in r1) || r1.kind !== "geojson") throw new Error("expected geojson");
    expect(r1.coverageNote).toMatch(/zoom in/i);

    const half = vi.fn(async (url: string) =>
      url.includes("/FeatureServer/2/query") ? new Response("down", { status: 500 }) : json(finalFc),
    );
    const r2 = await layer.query(ctx(half), { includeProposed: true });
    if (!("kind" in r2) || r2.kind !== "geojson") throw new Error("expected geojson");
    expect(r2.data.features).toHaveLength(finalFc.features.length);
    expect(r2.coverageNote).toMatch(/proposed/i);
  });

  it("maps an ArcGIS error body or a server error on the final layer to an upstream error", async () => {
    const arcgisError = serviceStub({ error: { code: 400, message: "Unable to complete operation." } }, proposedFc);
    const r = await layer.query(ctx(arcgisError), { includeProposed: true });
    expect(r).toMatchObject({ hint: "upstream", error: expect.stringContaining("Unable to complete operation.") });

    const down = vi.fn(async () => new Response("nope", { status: 503 }));
    expect(await layer.query(ctx(down), { includeProposed: true })).toMatchObject({ hint: "upstream" });
  });

  it("returns a coverage note without calling upstream outside the US", async () => {
    const stub = vi.fn();
    const r = await layer.query(
      { bbox: [2, 45, 3, 46], zoom: 9, env: {}, fetch: stub as unknown as CachedFetch },
      { includeProposed: true },
    );
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toEqual([]);
    expect(r.coverageNote).toMatch(/outside the United States/i);
  });

  it("answers a wide box largest first, with both layers counted and runLayer's note", async () => {
    const stub = vi.fn(async (url: string) => {
      const proposed = url.includes("/FeatureServer/2/query");
      if (new URL(url).searchParams.get("returnCountOnly") === "true") return json({ count: proposed ? 12 : 136 });
      return json(proposed ? proposedFc : finalFc);
    });
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("critical-habitat", { bbox: [-124, 32, -114, 42], zoom: 5 });
      expect(res.status).toBe(200);
      const data = stub.mock.calls.map((c) => new URL(String(c[0]))).filter((u) => !u.searchParams.has("returnCountOnly"));
      expect(data).toHaveLength(2);
      for (const u of data) {
        expect(u.searchParams.get("orderByFields")).toBe("Shape__Area DESC");
        expect(u.searchParams.get("resultRecordCount")).toBe("1000");
        expect(u.searchParams.get("maxAllowableOffset")).toBe("0.05");
      }
      const shown = finalFc.features.length + proposedFc.features.length;
      expect(res.body).toMatchObject({
        total: 148,
        truncated: true,
        coverageNote: `Showing the ${shown} largest of 148 (ranked by area); zoom in under 300,000 km² for all`,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leaves the total out of a wide result when the proposed layer failed", async () => {
    const stub = vi.fn(async (url: string) => {
      if (url.includes("/FeatureServer/2/query")) return new Response("no", { status: 500 });
      return new URL(url).searchParams.get("returnCountOnly") === "true" ? json({ count: 136 }) : json(finalFc);
    });
    const r = await layer.query({ ...ctx(stub), bbox: [-124, 32, -114, 42], wide: true, wideStrategy: layer.wide }, { includeProposed: true });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.total).toBeUndefined();
    expect(r.coverageNote).toBe("Proposed critical habitat could not be loaded; only final designations are shown");
    const only = await layer.query({ ...ctx(stub), bbox: [-124, 32, -114, 42], wide: true, wideStrategy: layer.wide }, { includeProposed: false });
    if (!("kind" in only) || only.kind !== "geojson") throw new Error("expected geojson");
    expect(only.total).toBe(136);
  });

  it("is registered, validates input and rejects through runLayer only a box over four times the soft cap", async () => {
    expect((await runLayer("critical-habitat", { bbox: [-120, 30, -80, 45] })).status).toBe(422);
    expect((await runLayer("critical-habitat", { bbox: TAHOE, input: { species: "" } })).status).toBe(400);
  });

  it("describes habitat in the words people use and says it is not a closure", () => {
    expect(layer.description).toMatch(/endangered species habitat/i);
    expect(layer.description).toMatch(/not a closure/i);
  });
});
