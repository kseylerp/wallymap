import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { hardMaxAreaKm2 } from "./types";
import layer, { NAMED, SERVICE_URL, byCaseNumberDesc, normalizeClaims } from "./mining-claims";
import activeRaw from "./__fixtures__/mining-claims.active.json";
import closedRaw from "./__fixtures__/mining-claims.closed.json";

/** Live BLM MLRS answers for this Moab box, the first 8 claims of each layer, recorded 2026-10-10. */
const active = activeRaw as unknown as FeatureCollection;
const closed = closedRaw as unknown as FeatureCollection;
const MOAB: [number, number, number, number] = [-109.8, 38.4, -109.4, 38.7];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function upstream(overrides: { active?: () => Response; closed?: () => Response } = {}) {
  return vi.fn(async (url: string) => {
    if (url.startsWith(`${SERVICE_URL}/1/`)) return overrides.active ? overrides.active() : json(active);
    if (url.startsWith(`${SERVICE_URL}/2/`)) return overrides.closed ? overrides.closed() : json(closed);
    return new Response("not found", { status: 404 });
  });
}

function ctx(stub: ReturnType<typeof vi.fn>, bbox = MOAB, cacheKey?: string) {
  return { bbox, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

function geojson(r: Awaited<ReturnType<typeof layer.query>>) {
  if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
  return r;
}

describe("normalizeClaims", () => {
  it("keeps each claim as a polygon with its name, case number, type, acres in v and the status as kind", () => {
    const claims = normalizeClaims(active, "active");
    expect(claims).toHaveLength(8);
    for (const c of claims) expect(["Polygon", "MultiPolygon"]).toContain(c.geometry.type);
    expect(claims[0].properties).toMatchObject({
      name: "WES-1",
      kind: "active",
      caseNumber: "UT105832859",
      claimType: "Lode Claim",
      disposition: "Filed",
      acres: 20.66,
      v: 20.66,
    });
    expect(normalizeClaims(closed, "closed")[0].properties).toMatchObject({ kind: "closed", disposition: "Closed" });
  });

  it("keeps only the first line of the long location-quality note, and skips rows with no geometry", () => {
    const polygon = { type: "Polygon" as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
    const out = normalizeClaims(
      {
        type: "FeatureCollection",
        features: [
          { type: "Feature", geometry: null as never, properties: { CSE_NAME: "Ghost" } },
          {
            type: "Feature",
            geometry: polygon,
            properties: { QLTY: "1: MIDPOINT\nTYPICAL QUARTER SECTION\naliquot\n36 sections retrieved", MC_PATENTED: " Y " },
          },
        ],
      },
      "active",
    );
    expect(out).toHaveLength(1);
    expect(out[0].properties).toEqual({ name: "Unnamed claim", kind: "active", locationQuality: "1: MIDPOINT", patented: "Y" });
  });
});

describe("ordering", () => {
  it("lists active claims before closed ones, and the newest case number first within a status", async () => {
    const stub = upstream();
    const r = geojson(await layer.query(ctx(stub), { status: "both" }));
    const kinds = r.data.features.map((f) => f.properties?.kind);
    expect(kinds).toEqual([...Array(8).fill("active"), ...Array(8).fill("closed")]);
    for (const kind of ["active", "closed"]) {
      const numbers = r.data.features.filter((f) => f.properties?.kind === kind).map((f) => String(f.properties?.caseNumber));
      expect(numbers).toEqual([...numbers].sort().reverse());
    }
    const point = { type: "Point" as const, coordinates: [0, 0] };
    const a = { type: "Feature" as const, geometry: point, properties: { caseNumber: "UT2" } };
    const none = { type: "Feature" as const, geometry: point, properties: {} };
    expect([none, a].sort(byCaseNumberDesc)).toEqual([a, none]);
  });
});

describe("mining-claims layer", () => {
  it("declares US coverage, a public-domain license, no env, a 2,500 km2 limit and a status input", () => {
    expect(layer.id).toBe("mining-claims");
    expect(layer.coverage).toBe("us");
    expect(layer.license).toContain("Public domain");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(2_500);
    expect(layer.wide).toEqual({ mode: "named", limit: 2000 });
    expect(hardMaxAreaKm2(layer)).toBe(10_000);
    expect(layer.input.parse({})).toEqual({ status: "active" });
    expect(layer.input.safeParse({ status: "all" }).success).toBe(false);
    expect(layer.style).toMatchObject({ geometry: "polygon", color: "#F57272" });
  });

  it("asks only the active layer by default, with light simplification and a day of cache", async () => {
    const stub = upstream();
    const r = geojson(await layer.query(ctx(stub, MOAB, "claims:k"), { status: "active" }));
    expect(r.data.features).toHaveLength(8);
    expect(r.coverageNote).toBeUndefined();
    expect(stub).toHaveBeenCalledTimes(1);
    const [url, init] = stub.mock.calls[0] as unknown as [string, { cacheKey?: string; ttlSeconds?: number }];
    const params = new URL(url).searchParams;
    expect(url.startsWith(`${SERVICE_URL}/1/query?`)).toBe(true);
    expect(params.get("geometry")).toBe("-109.8,38.4,-109.4,38.7");
    expect(params.get("maxAllowableOffset")).toBe("0.0001");
    expect(params.get("outFields")).toContain("BLM_PROD");
    expect(init.ttlSeconds).toBe(86_400);
    expect(init.cacheKey).toBe("claims:k:mining-claims:active");
  });

  it("asks the closed layer for status closed and both layers for both", async () => {
    const closedOnly = upstream();
    const c = geojson(await layer.query(ctx(closedOnly), { status: "closed" }));
    expect(c.data.features.every((f) => f.properties?.kind === "closed")).toBe(true);
    expect(String(closedOnly.mock.calls[0][0]).startsWith(`${SERVICE_URL}/2/`)).toBe(true);

    const bothStub = upstream();
    const both = geojson(await layer.query(ctx(bothStub), { status: "both" }));
    expect(both.data.features).toHaveLength(16);
    expect(both.data.features.map((f) => f.properties?.kind).sort()).toEqual([...Array(8).fill("active"), ...Array(8).fill("closed")]);
    expect(bothStub).toHaveBeenCalledTimes(2);
  });

  it("says when a status hits the 2,000 cap, and which layer failed when only one loads", async () => {
    const capped = upstream({ closed: () => json({ ...closed, exceededTransferLimit: true }) });
    expect(geojson(await layer.query(ctx(capped), { status: "both" })).coverageNote).toBe("Showing an arbitrary 2,000 closed claims, not the newest; zoom in for the rest");

    const partial = upstream({ closed: () => json({}, 500) });
    const r = geojson(await layer.query(ctx(partial), { status: "both" }));
    expect(r.data.features).toHaveLength(8);
    expect(r.coverageNote).toBe("Missing the closed claims (ArcGIS service returned 500)");
  });

  it("maps a total outage to an upstream error and notes an empty area", async () => {
    const down = upstream({ active: () => json({ error: { code: 500, message: "busy" } }) });
    expect(await layer.query(ctx(down), { status: "active" })).toEqual({
      error: "Mining claims unavailable: active claims (ArcGIS service error: busy)",
      hint: "upstream",
    });
    const empty = upstream({ active: () => json({ type: "FeatureCollection", features: [] }), closed: () => json({ type: "FeatureCollection", features: [] }) });
    expect(geojson(await layer.query(ctx(empty), { status: "active" })).coverageNote).toBe("No active mining claims in this area");
    expect(geojson(await layer.query(ctx(empty), { status: "both" })).coverageNote).toBe("No mining claims in this area");
  });

  it("returns nothing outside the US without calling out, and rejects an oversized area through runLayer", async () => {
    const stub = vi.fn();
    expect(geojson(await layer.query(ctx(stub, [5, 45, 5.2, 45.2]), { status: "active" })).coverageNote).toBe("No data outside the United States");
    expect(stub).not.toHaveBeenCalled();
    expect((await runLayer("mining-claims", { bbox: [-110, 38, -108, 40] })).status).toBe(422);
    expect((await runLayer("mining-claims", { bbox: MOAB, input: { status: "x" } })).status).toBe(400);
  });

  it("answers a wide box (about 5,400 km²) with named claims, the limit split by status, and a count of all claims", async () => {
    const stub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const counting = new URL(url).searchParams.get("returnCountOnly") === "true";
      if (url.startsWith(`${SERVICE_URL}/1/`)) return counting ? json({ count: 2438 }) : json({ ...active, exceededTransferLimit: true });
      return counting ? json({ count: 28528 }) : json({ ...closed, exceededTransferLimit: true });
    });
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("mining-claims", { bbox: [-110, 38.2, -109.2, 38.9], zoom: 8, input: { status: "both" } });
      expect(res.status).toBe(200);
      const urls = stub.mock.calls.map((c) => new URL(String(c[0])));
      const data = urls.filter((u) => !u.searchParams.has("returnCountOnly"));
      expect(data).toHaveLength(2);
      for (const u of data) {
        expect(u.searchParams.get("where")).toBe(NAMED);
        expect(u.searchParams.get("resultRecordCount")).toBe("1000");
      }
      expect(urls.filter((u) => u.searchParams.has("returnCountOnly")).map((u) => u.searchParams.get("where"))).toEqual(["1=1", "1=1"]);
      expect(res.body).toMatchObject({ total: 30966, truncated: true, coverageNote: "Showing the 16 named of 30,966; zoom in under 2,500 km² for all" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("gives the whole wide limit to one status and leaves the total out when the count fails", async () => {
    const stub = vi.fn(async (url: string) => (new URL(url).searchParams.get("returnCountOnly") === "true" ? json({}, 500) : json(active)));
    const r = geojson(await layer.query({ ...ctx(stub), wide: true, wideStrategy: layer.wide }, { status: "active" }));
    expect(r.total).toBeUndefined();
    const data = (stub.mock.calls as unknown as [string][]).map((c) => new URL(c[0])).find((u) => !u.searchParams.has("returnCountOnly"));
    expect(data?.searchParams.get("resultRecordCount")).toBe("2000");
  });

  it("warns that claims are survey-grid squares and not for deciding where to stake", () => {
    expect(layer.description).toMatch(/not its corners/);
    expect(layer.description).toMatch(/do not use it to decide/);
  });
});
