import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { COMMODITY_CODES, MRDS_URL, USMIN_URL, commodityWhere, commoditiesOf, normalizeMrds, normalizeUsmin } from "./mines";
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
    expect((await runLayer("mines", { bbox: [-111, 36, -108, 40] })).status).toBe(422);
    expect((await runLayer("mines", { bbox: MOAB, input: { commodity: "cheese" } })).status).toBe(400);
  });

  it("tells the model the data are historic and old workings are unsafe", () => {
    expect(layer.description).toMatch(/historic record/);
    expect(layer.description).toMatch(/around 2011/);
    expect(layer.description).toMatch(/stay out of old workings/);
  });
});
