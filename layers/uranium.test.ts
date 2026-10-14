import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { bboxAreaKm2, hardMaxAreaKm2 } from "./types";
import layer, { DOE_NAMED, DOE_URL, DOE_WHERE, NAVAJO_NAMED, NAVAJO_URL, normalizeDoe, normalizeNavajo } from "./uranium";
import doeRaw from "./__fixtures__/uranium.doe.json";
import navajoRaw from "./__fixtures__/uranium.navajo.json";

/** Live answers recorded 2026-10-10: 8 Navajo Nation mines near Oljato, and the DOE uranium mill sites in a Grants, New Mexico box. */
const navajo = navajoRaw as unknown as FeatureCollection;
const doe = doeRaw as unknown as FeatureCollection;
const FOUR_CORNERS: [number, number, number, number] = [-112, 35, -106, 38];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function upstream(overrides: { navajo?: () => Response; doe?: () => Response } = {}) {
  return vi.fn(async (url: string) => {
    if (url.startsWith(`${NAVAJO_URL}/query`)) return overrides.navajo ? overrides.navajo() : json(navajo);
    if (url.startsWith(`${DOE_URL}/query`)) return overrides.doe ? overrides.doe() : json(doe);
    return new Response("not found", { status: 404 });
  });
}

function ctx(stub: ReturnType<typeof vi.fn>, bbox = FOUR_CORNERS, cacheKey?: string) {
  return { bbox, zoom: 7, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

function geojson(r: Awaited<ReturnType<typeof layer.query>>) {
  if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
  return r;
}

describe("normalizeNavajo", () => {
  it("makes each abandoned mine a point with the composite hazard score in v and the component scores", () => {
    const points = normalizeNavajo(navajo);
    expect(points).toHaveLength(8);
    expect(points[0].properties).toEqual({
      name: "Tract 15",
      kind: "abandoned mine",
      source: "Navajo Nation abandoned uranium mines (2007)",
      mineId: 397,
      chapter: "OLJATO",
      region: "North Central",
      hazardScore: 170,
      v: 170,
      groundwaterScore: 10,
      soilScore: 0,
      airScore: 0,
      surfaceWaterScore: 160,
    });
    expect(points[1].properties?.aliases).toBe("Tract 25");
  });

  it("skips non-points and tolerates missing scores", () => {
    const point = { type: "Point" as const, coordinates: [-110, 36] };
    const out = normalizeNavajo({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: null as never, properties: { Mine_Name: "Ghost" } },
        { type: "Feature", geometry: point, properties: { Aliases: " " } },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].properties).toEqual({ name: "Unnamed mine", kind: "abandoned mine", source: "Navajo Nation abandoned uranium mines (2007)" });
  });
});

describe("normalizeDoe", () => {
  it("makes each mill-tailings site a point with its program, links and transfer year", () => {
    const points = normalizeDoe(doe, 2026);
    expect(points).toHaveLength(5);
    expect(points[0].properties).toMatchObject({
      name: "Ambrosia Lake, NM, Disposal Site",
      kind: "mill tailings site",
      source: "DOE Office of Legacy Management",
      program: "UMTRCA Title I",
      state: "NM",
      siteId: "AMB",
      url: "https://www.energy.gov/lm/ambrosia-lake-new-mexico-disposal-site",
      factSheet: "https://www.energy.gov/sites/default/files/2021-07/AmbrosiaLakeFactSheet.pdf",
      transferYear: 1998,
    });
  });

  it("reports a transfer year in the future as expected, drops blank links, and calls ULP a leasing program", () => {
    const west = normalizeDoe(doe, 2026).find((f) => f.properties?.siteId === "AMW");
    expect(west?.properties).toMatchObject({ program: "UMTRCA Title II", expectedTransferYear: 2030 });
    expect(west?.properties).not.toHaveProperty("transferYear");
    expect(west?.properties).not.toHaveProperty("url");
    expect(west?.properties).not.toHaveProperty("factSheet");
    const point = { type: "Point" as const, coordinates: [-108, 39] };
    const ulp = normalizeDoe({ type: "FeatureCollection", features: [{ type: "Feature", geometry: point, properties: { siteRegulatoryDriver: "ULP", siteTransferYear: "n/a" } }] }, 2026);
    expect(ulp[0].properties).toMatchObject({ kind: "leasing program", program: "ULP" });
    expect(ulp[0].properties).not.toHaveProperty("transferYear");
  });
});

describe("uranium layer", () => {
  it("declares US coverage, a license that names both sources, no env or input, and the hazard color", () => {
    expect(layer.id).toBe("uranium");
    expect(layer.coverage).toBe("us");
    expect(layer.license).toMatch(/Navajo/);
    expect(layer.license).toMatch(/Department of Energy/);
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.input.parse({})).toEqual({});
    expect(layer.maxAreaKm2).toBe(20_000_000);
    expect(layer.wide).toEqual({ mode: "named", limit: 2000 });
    expect(hardMaxAreaKm2(layer)).toBe(80_000_000);
    expect(layer.style).toMatchObject({ geometry: "point", color: "#F57272" });
  });

  it("queries both services, the DOE one filtered to uranium programs, and notes the 2007 vintage", async () => {
    const stub = upstream();
    const r = geojson(await layer.query(ctx(stub, FOUR_CORNERS, "u:k"), {}));
    expect(r.data.features).toHaveLength(13);
    expect(r.data.features.filter((f) => f.properties?.kind === "abandoned mine")).toHaveLength(8);
    expect(r.coverageNote).toBe("Hazard scores are from a 2007 screening and do not reflect cleanup since");
    const calls = stub.mock.calls as unknown as [string, { cacheKey?: string; ttlSeconds?: number }][];
    expect(calls).toHaveLength(2);
    const doeCall = calls.find((c) => c[0].startsWith(DOE_URL));
    expect(new URL(doeCall?.[0] ?? "").searchParams.get("where")).toBe(DOE_WHERE);
    expect(doeCall?.[1].cacheKey).toBe("u:k:uranium:doe");
    expect(calls.find((c) => c[0].startsWith(NAVAJO_URL))?.[1].cacheKey).toBe("u:k:uranium:navajo");
    expect(calls.every((c) => c[1].ttlSeconds === 7 * 86_400)).toBe(true);
  });

  it("keeps what loaded when one service fails, and errors when both do", async () => {
    const partial = geojson(await layer.query(ctx(upstream({ doe: () => json({}, 500) })), {}));
    expect(partial.data.features).toHaveLength(8);
    expect(partial.coverageNote).toContain("Missing DOE sites (ArcGIS service returned 500)");
    expect(await layer.query(ctx(upstream({ navajo: () => json({}, 503), doe: () => json({ error: { code: 500, message: "busy" } }) })), {})).toEqual({
      error: "Uranium site data unavailable: Navajo mines (ArcGIS service returned 503); DOE sites (ArcGIS service error: busy)",
      hint: "upstream",
    });
  });

  it("says where else to look when nothing is found, and notes a cap", async () => {
    const empty = upstream({ navajo: () => json({ type: "FeatureCollection", features: [] }), doe: () => json({ type: "FeatureCollection", features: [] }) });
    expect(geojson(await layer.query(ctx(empty), {})).coverageNote).toContain("use mines with commodity uranium");
    const capped = upstream({ navajo: () => json({ ...navajo, properties: { exceededTransferLimit: true } }) });
    expect(geojson(await layer.query(ctx(capped), {})).coverageNote).toContain("Showing 2,000 Navajo mines records; zoom in for the rest");
  });

  it("returns nothing outside the US, and rejects an oversized area through runLayer", async () => {
    const stub = vi.fn();
    expect(geojson(await layer.query(ctx(stub, [5, 45, 6, 46]), {})).coverageNote).toBe("No data outside the United States");
    expect(stub).not.toHaveBeenCalled();
    expect((await runLayer("uranium", { bbox: [-180, -80, 180, 80] })).status).toBe(422);
  });

  it("answers a box wider than the lower 48 with named sites and a count of all, and says when it kept everything", async () => {
    const box: [number, number, number, number] = [-130, 20, -60, 55];
    expect(bboxAreaKm2(box)).toBeGreaterThan(20_000_000);
    const stub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const counting = new URL(url).searchParams.get("returnCountOnly") === "true";
      if (url.startsWith(NAVAJO_URL)) return counting ? json({ count: 8 }) : json(navajo);
      return counting ? json({ count: 5 }) : json(doe);
    });
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("uranium", { bbox: box, zoom: 3 });
      expect(res.status).toBe(200);
      const urls = stub.mock.calls.map((c) => new URL(String(c[0])));
      const data = urls.filter((u) => !u.searchParams.has("returnCountOnly"));
      expect(data.map((u) => u.searchParams.get("where")).sort()).toEqual([DOE_NAMED, NAVAJO_NAMED].sort());
      expect(data.every((u) => u.searchParams.get("resultRecordCount") === "1000")).toBe(true);
      expect(urls.filter((u) => u.searchParams.has("returnCountOnly")).map((u) => u.searchParams.get("where")).sort()).toEqual(["1=1", DOE_WHERE].sort());
      expect(res.body).toMatchObject({ total: 13, coverageNote: expect.stringMatching(/^Showing all 13 in this wide view; Hazard scores/) });
      expect(res.body).not.toHaveProperty("truncated");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("warns that scores are not exposure measures and points to mines for other uranium sites", () => {
    expect(layer.description).toMatch(/not a measured exposure/);
    expect(layer.description).toMatch(/mines with commodity uranium/);
    expect(layer.description).toMatch(/Navajo/);
  });
});
