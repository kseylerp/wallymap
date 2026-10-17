import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { hardMaxAreaKm2 } from "./types";
import layer, {
  COMMODITY_CODES,
  MRDS_NAMED,
  MRDS_URL,
  USMIN_NAMED,
  USMIN_URL,
  commodityWhere,
  commoditiesOf,
  dedupeMines,
  normalizeMrds,
  normalizeUsmin,
} from "./mines";
import mrdsRaw from "./__fixtures__/mines.mrds.json";
import usminRaw from "./__fixtures__/mines.usmin.json";

/** Live USGS answers for this Moab box, the first 10 records of each dataset, recorded 2026-10-10. */
const mrds = mrdsRaw as unknown as FeatureCollection;
const usmin = usminRaw as unknown as FeatureCollection;
const MOAB: [number, number, number, number] = [-109.8, 38.4, -109.4, 38.7];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function upstream(overrides: { mrds?: () => Response; usmin?: () => Response } = {}) {
  return vi.fn(async (url: string) => {
    if (url.startsWith(`${MRDS_URL}/query`)) return overrides.mrds ? overrides.mrds() : json(mrds);
    if (url.startsWith(`${USMIN_URL}/query`)) return overrides.usmin ? overrides.usmin() : json(usmin);
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

describe("commodities", () => {
  it("names the codes in a list and keeps unknown codes", () => {
    expect(commoditiesOf(" U CU V")).toEqual(["uranium", "copper", "vanadium"]);
    expect(commoditiesOf(" AU AG")).toEqual(["gold", "silver"]);
    expect(commoditiesOf(" XYZ")).toEqual(["xyz"]);
    expect(commoditiesOf("")).toEqual([]);
  });

  it("writes the filter so U does not match AU or the end of the list", () => {
    expect(commodityWhere("U")).toBe("code_list LIKE '% U %' OR code_list LIKE '% U' OR code_list LIKE 'U %' OR code_list = 'U'");
    expect(Object.values(COMMODITY_CODES)).toContain("U");
  });
});

describe("normalizers", () => {
  it("turns MRDS rows into points whose kind is the main commodity, with status, all commodities and a USGS link", () => {
    const points = normalizeMrds(mrds);
    expect(points).toHaveLength(10);
    expect(points[0].geometry.type).toBe("Point");
    expect(points[0].properties).toEqual({
      name: "Discovery",
      kind: "uranium",
      source: "MRDS",
      commodities: "uranium, copper, vanadium",
      status: "Past Producer",
      grade: "D",
      id: "10015101",
      url: "https://mrdata.usgs.gov/mrds/show-mrds.php?dep_id=10015101",
    });
  });

  it("turns USMIN rows into points whose kind is the feature type, with the source map", () => {
    const points = normalizeUsmin(usmin);
    expect(points).toHaveLength(10);
    expect(points[0].properties).toEqual({
      name: "Mine",
      kind: "Adit",
      source: "USMIN",
      topoName: "Moab",
      topoYear: 1968,
      state: "UT",
      county: "Grand",
    });
  });

  it("skips rows that are not points and fills in missing names", () => {
    const point = { type: "Point" as const, coordinates: [-109.5, 38.5] };
    expect(normalizeMrds({ type: "FeatureCollection", features: [{ type: "Feature", geometry: null as never, properties: {} }] })).toEqual([]);
    expect(normalizeMrds({ type: "FeatureCollection", features: [{ type: "Feature", geometry: point, properties: { code_list: " " } }] })[0].properties).toEqual({
      name: "Unnamed site",
      kind: "unknown",
      source: "MRDS",
    });
    expect(
      normalizeUsmin({ type: "FeatureCollection", features: [{ type: "Feature", geometry: point, properties: { ftr_type: "Quarry", ftr_name: "N/A", topo_date: 0 } }] })[0].properties,
    ).toEqual({ name: "Quarry", kind: "Quarry", source: "USMIN" });
  });
});

describe("mines layer", () => {
  it("declares US coverage, a public-domain license, no env, a 15,000 km2 limit and commodity and source inputs", () => {
    expect(layer.id).toBe("mines");
    expect(layer.coverage).toBe("us");
    expect(layer.license).toContain("Public domain");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(15_000);
    expect(layer.wide).toEqual({ mode: "named", limit: 2000 });
    expect(hardMaxAreaKm2(layer)).toBe(1_200_000);
    expect(layer.input.parse({})).toEqual({ source: "both" });
    expect(layer.input.safeParse({ commodity: "uranium", source: "mrds" }).success).toBe(true);
    expect(layer.input.safeParse({ commodity: "unobtainium" }).success).toBe(false);
    expect(layer.style).toMatchObject({ geometry: "point", cluster: true });
  });

  it("queries both datasets by default, caches a week and warns that MRDS is historic", async () => {
    const stub = upstream();
    const r = geojson(await layer.query(ctx(stub, MOAB, "mines:k"), { source: "both" }));
    expect(r.data.features).toHaveLength(20);
    expect(r.data.features.filter((f) => f.properties?.source === "MRDS")).toHaveLength(10);
    expect(r.coverageNote).toBe("MRDS is a historic record (about 2011): most sites are closed or only prospects");
    const calls = stub.mock.calls as unknown as [string, { cacheKey?: string; ttlSeconds?: number }][];
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c[1].ttlSeconds === 7 * 86_400)).toBe(true);
    const mrdsCall = calls.find((c) => c[0].startsWith(MRDS_URL));
    expect(mrdsCall?.[1].cacheKey).toBe("mines:k:mines:mrds:all");
    expect(new URL(mrdsCall?.[0] ?? "").searchParams.get("where")).toBe("1=1");
    expect(calls.find((c) => c[0].startsWith(USMIN_URL))?.[1].cacheKey).toBe("mines:k:mines:usmin");
  });

  it("filters MRDS by commodity and then skips USMIN, which carries no commodity", async () => {
    const stub = upstream();
    const r = geojson(await layer.query(ctx(stub, MOAB, "k"), { commodity: "uranium", source: "both" }));
    expect(stub).toHaveBeenCalledTimes(1);
    const [url, init] = stub.mock.calls[0] as unknown as [string, { cacheKey?: string }];
    expect(url.startsWith(MRDS_URL)).toBe(true);
    expect(new URL(url).searchParams.get("where")).toBe(commodityWhere("U"));
    expect(init.cacheKey).toBe("k:mines:mrds:uranium");
    expect(r.data.features.every((f) => f.properties?.source === "MRDS")).toBe(true);

    const note = geojson(await layer.query(ctx(upstream()), { commodity: "gold", source: "usmin" }));
    expect(note.coverageNote).toContain("USMIN symbols carry no commodity");
  });

  it("asks one dataset only when source says so", async () => {
    const stub = upstream();
    const r = geojson(await layer.query(ctx(stub), { source: "usmin" }));
    expect(r.data.features.every((f) => f.properties?.source === "USMIN")).toBe(true);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(r.coverageNote).toBeUndefined();
  });

  it("says when a dataset hits its cap, and keeps what loaded when the other fails", async () => {
    const capped = upstream({ usmin: () => json({ ...usmin, properties: { exceededTransferLimit: true } }) });
    expect(geojson(await layer.query(ctx(capped), { source: "both" })).coverageNote).toContain("Showing 2,000 records from USMIN; zoom in for the rest");

    const partial = upstream({ usmin: () => json({}, 500) });
    const r = geojson(await layer.query(ctx(partial), { source: "both" }));
    expect(r.data.features).toHaveLength(10);
    expect(r.coverageNote).toContain("Missing USMIN (ArcGIS service returned 500)");
  });

  it("maps a total outage to an upstream error and notes empty areas", async () => {
    const down = upstream({ mrds: () => json({}, 503), usmin: () => json({ error: { code: 500, message: "busy" } }) });
    expect(await layer.query(ctx(down), { source: "both" })).toEqual({
      error: "Mine records unavailable: MRDS (ArcGIS service returned 503); USMIN (ArcGIS service error: busy)",
      hint: "upstream",
    });
    const empty = upstream({ mrds: () => json({ type: "FeatureCollection", features: [] }), usmin: () => json({ type: "FeatureCollection", features: [] }) });
    expect(geojson(await layer.query(ctx(empty), { source: "both" })).coverageNote).toBe("No mines or prospects recorded in this area");
    expect(geojson(await layer.query(ctx(empty), { commodity: "gold", source: "both" })).coverageNote).toBe("No MRDS sites listing gold in this area");
  });

  it("returns nothing outside the US, and rejects an oversized area and a bad commodity through runLayer", async () => {
    const stub = vi.fn();
    expect(geojson(await layer.query(ctx(stub, [5, 45, 5.2, 45.2]), { source: "both" })).coverageNote).toBe("No data outside the United States");
    expect(stub).not.toHaveBeenCalled();
    expect((await runLayer("mines", { bbox: [-125, 30, -100, 49] })).status).toBe(422);
    expect((await runLayer("mines", { bbox: MOAB, input: { commodity: "cheese" } })).status).toBe(400);
  });

  it("answers a wide box (about 31,000 km²) with named sites, the limit split between records, and a count of all", async () => {
    const stub = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const counting = url.searchParams.get("returnCountOnly") === "true";
      if (String(input).startsWith(MRDS_URL)) return counting ? json({ count: 3932 }) : json(mrds);
      return counting ? json({ count: 6010 }) : json(usmin);
    });
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("mines", { bbox: [-110.5, 38, -108.5, 39.6], zoom: 7 });
      expect(res.status).toBe(200);
      const urls = stub.mock.calls.map((c) => new URL(String(c[0])));
      const data = urls.filter((u) => !u.searchParams.has("returnCountOnly"));
      const counts = urls.filter((u) => u.searchParams.has("returnCountOnly"));
      expect(data.map((u) => u.searchParams.get("where")).sort()).toEqual([USMIN_NAMED, MRDS_NAMED].sort());
      expect(data.every((u) => u.searchParams.get("resultRecordCount") === "1000")).toBe(true);
      expect(counts.map((u) => u.searchParams.get("where"))).toEqual(["1=1", "1=1"]);
      expect(res.body).toMatchObject({
        total: 9942,
        truncated: true,
        coverageNote: expect.stringMatching(/^Showing the 20 named of 9,942; zoom in under 15,000 km² for all; MRDS is a historic record/),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the commodity filter on both the named query and the count in wide mode, with the whole limit for MRDS", async () => {
    const stub = vi.fn(async (url: string) => (new URL(url).searchParams.get("returnCountOnly") === "true" ? json({ count: 3471 }) : json(mrds)));
    const r = geojson(
      await layer.query({ ...ctx(stub, [-110.5, 38, -108.5, 39.6], "mines:w"), wide: true, wideStrategy: layer.wide }, { commodity: "uranium", source: "both" }),
    );
    expect(r.total).toBe(3471);
    expect(r.coverageNote).not.toMatch(/zoom in/);
    const urls = (stub.mock.calls as unknown as [string][]).map((c) => new URL(c[0]));
    expect(urls.find((u) => !u.searchParams.has("returnCountOnly"))?.searchParams.get("where")).toBe(`(${commodityWhere("U")}) AND ${MRDS_NAMED}`);
    expect(urls.find((u) => !u.searchParams.has("returnCountOnly"))?.searchParams.get("resultRecordCount")).toBe("2000");
    expect(urls.find((u) => u.searchParams.has("returnCountOnly"))?.searchParams.get("where")).toBe(commodityWhere("U"));
  });

  it("leaves the total out of a wide answer when a record fails", async () => {
    const stub = vi.fn(async (url: string) => {
      if (url.startsWith(USMIN_URL)) return json({}, 500);
      return new URL(url).searchParams.get("returnCountOnly") === "true" ? json({ count: 3932 }) : json(mrds);
    });
    const r = geojson(await layer.query({ ...ctx(stub), wide: true, wideStrategy: layer.wide }, { source: "both" }));
    expect(r.total).toBeUndefined();
    expect(r.coverageNote).toContain("Missing USMIN");
  });

  it("answers a state (Nevada, 402,000 km²) with every MRDS deposit, paged, and only counts USMIN", async () => {
    const stub = vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.searchParams.get("returnCountOnly") === "true") return json({ count: url.startsWith(MRDS_URL) ? 4500 : 153150 });
      return json(mrds);
    });
    const r = geojson(await layer.query({ ...ctx(stub, [-120, 35, -114, 42], "mines:nv"), wide: true, wideStrategy: layer.wide }, { source: "both" }));
    const pages = (stub.mock.calls as unknown as [string][]).map((c) => new URL(c[0])).filter((u) => !u.searchParams.has("returnCountOnly"));
    expect(pages.map((u) => u.searchParams.get("resultOffset") ?? "0")).toEqual(["0", "2000", "4000"]);
    expect(pages.every((u) => u.href.startsWith(MRDS_URL) && u.searchParams.get("orderByFields") === "objectid_1")).toBe(true);
    // Three pages of the same ten rows stand in for 4,500: 30 records, 20 repeats merged, 10 sites drawn.
    expect(r.total).toBe(4480);
    expect(r.coverageNote).toMatch(/every MRDS deposit is drawn, the first 30 of 4,500 \(20 records repeating one site within 1 km merged\)/);
    expect(r.coverageNote).toMatch(/every MRDS deposit is drawn/);
    expect(r.coverageNote).toMatch(/USMIN's 153,150 mine symbols from old topographic maps are left out/);
    // The same ten fixture rows on every page are one site each.
    expect(r.data.features).toHaveLength(10);
  });

  it("lists a mine once when MRDS and USMIN both have it, and keeps separate generic workings", () => {
    const pt = (lon: number, lat: number, props: Record<string, unknown>) => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [lon, lat] }, properties: props });
    const kept = dedupeMines([
      pt(-117.32, 40.94, { name: "Silver King Mine", kind: "Mine", source: "USMIN" }),
      pt(-117.3201, 40.9401, { name: "Silver King Mine", kind: "silver", source: "MRDS" }),
      pt(-117.1, 40.6, { name: "Tunnel", kind: "Adit", source: "USMIN" }),
      pt(-117.101, 40.601, { name: "Tunnel", kind: "Adit", source: "USMIN" }),
      pt(-117.5, 40.5, { name: "Big Pay Mine", kind: "gold", source: "MRDS" }),
      pt(-117.503, 40.501, { name: "Big Pay Mine", kind: "gold", source: "MRDS" }),
      pt(-114.47, 37.9, { name: "Prince Mine", kind: "lead", source: "MRDS" }),
      pt(-114.47, 37.9, { name: "Prince Mine", kind: "silver", source: "MRDS" }),
    ]);
    expect(kept.map((f) => `${f.properties?.name} ${f.properties?.source}`)).toEqual(["Silver King Mine MRDS", "Big Pay Mine MRDS", "Prince Mine MRDS", "Tunnel USMIN", "Tunnel USMIN"]);
  });

  it("tells the model the data are historic and old workings are unsafe", () => {
        expect(layer.description).toMatch(/around 2011/);
    expect(layer.description).toMatch(/does not mean a mine is open or safe/);
  });
});
