import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { LEVELS, LEVEL_SPECS, levelForArea, levelForZoom, normalizeBasins } from "./river-basins";
import huc8Raw from "./__fixtures__/river-basins.huc8.json";
import huc2Raw from "./__fixtures__/river-basins.huc2.json";

/** Live WBD answers for the Four Corners box, recorded 2026-10-10 (huc8: the 6 largest of 19, with the transfer-limit flag removed; huc2: both regions). */
const huc8 = huc8Raw as unknown as FeatureCollection;
const huc2 = huc2Raw as unknown as FeatureCollection;
const FOUR_CORNERS: [number, number, number, number] = [-111.6, 36.8, -109, 38.5];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function ctx(stub: ReturnType<typeof vi.fn>, opts: { zoom?: number; bbox?: [number, number, number, number]; cacheKey?: string } = {}) {
  return { bbox: opts.bbox ?? FOUR_CORNERS, zoom: opts.zoom ?? 8, env: {}, fetch: stub as unknown as CachedFetch, cacheKey: opts.cacheKey };
}

function geojson(r: Awaited<ReturnType<typeof layer.query>>) {
  if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
  return r;
}

describe("level choice", () => {
  it("picks regions far out, subregions in between and subbasins close in", () => {
    expect([3, 5, 6, 7, 8, 12].map(levelForZoom)).toEqual(["huc2", "huc2", "huc4", "huc4", "huc8", "huc8"]);
  });

  it("steps up to a coarser level when the view is too big for the wanted one", () => {
    expect(levelForArea("huc8", 100_000)).toBe("huc8");
    expect(levelForArea("huc8", 300_000)).toBe("huc6");
    expect(levelForArea("huc8", 2_000_000)).toBe("huc4");
    expect(levelForArea("huc10", 15_000_000)).toBe("huc2");
    expect(levelForArea("huc2", 15_000_000)).toBe("huc2");
  });

  it("knows the service layer and code field of every level", () => {
    expect(LEVELS.map((l) => LEVEL_SPECS[l].layer)).toEqual([1, 2, 3, 4, 5]);
    expect(LEVELS.map((l) => LEVEL_SPECS[l].field)).toEqual(LEVELS);
  });
});

describe("normalizeBasins", () => {
  it("keeps polygons with name, huc code, level, area in v and states", () => {
    const fc = normalizeBasins(huc8, "huc8");
    expect(fc.features).toHaveLength(6);
    for (const f of fc.features) expect(["Polygon", "MultiPolygon"]).toContain(f.geometry.type);
    expect(fc.features[0].properties).toEqual({
      name: "Chinle",
      kind: "huc8",
      hucLevel: 8,
      huc: "14080204",
      areaSqKm: 10617,
      v: 10617,
      states: "AZ,NM,UT",
    });
    expect(normalizeBasins(huc2, "huc2").features[1].properties).toMatchObject({ name: "Upper Colorado Region", huc: "14", kind: "huc2" });
  });

  it("skips rows without geometry and tolerates missing fields", () => {
    const fc = normalizeBasins(
      {
        type: "FeatureCollection",
        features: [
          { type: "Feature", geometry: null as never, properties: { name: "Ghost" } },
          { type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: {} },
        ],
      },
      "huc4",
    );
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toEqual({ name: "Unnamed basin", kind: "huc4", hucLevel: 4 });
  });
});

describe("river-basins layer", () => {
  it("declares US coverage, a public-domain license, no env and an optional level", () => {
    expect(layer.id).toBe("river-basins");
    expect(layer.coverage).toBe("us");
    expect(layer.license).toContain("Public domain");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(20_000_000);
    expect(layer.input.parse({})).toEqual({});
    expect(layer.input.safeParse({ level: "huc8" }).success).toBe(true);
    expect(layer.input.safeParse({ level: "huc3" }).success).toBe(false);
    expect(layer.style).toMatchObject({ geometry: "polygon", color: "#9FB693" });
  });

  it("queries the subbasin layer at zoom 8 with simplification, largest first, and caches a week", async () => {
    const stub = vi.fn(async () => json(huc8));
    const r = geojson(await layer.query(ctx(stub, { cacheKey: "river-basins:k" }), {}));
    expect(r.data.features).toHaveLength(6);
    expect(r.coverageNote).toBeUndefined();
    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit & { cacheKey?: string; ttlSeconds?: number }];
    const params = new URL(url).searchParams;
    expect(url).toContain("/wbd/MapServer/4/query");
    expect(params.get("outFields")).toBe("huc8,name,areasqkm,states");
    expect(params.get("maxAllowableOffset")).toBe("0.004");
    expect(params.get("orderByFields")).toBe("areasqkm DESC");
    expect(init.ttlSeconds).toBe(7 * 86_400);
    expect(init.cacheKey).toBe("river-basins:k:river-basins:huc8");
  });

  it("uses regions far out, and the same box at two zooms never shares a cache key", async () => {
    const stub = vi.fn(async () => json(huc2));
    const far = geojson(await layer.query(ctx(stub, { zoom: 4, cacheKey: "k" }), {}));
    expect(far.data.features.map((f) => f.properties?.name)).toEqual(["Lower Colorado Region", "Upper Colorado Region"]);
    await layer.query(ctx(stub, { zoom: 10, cacheKey: "k" }), {});
    const keys = (stub.mock.calls as unknown as [string, { cacheKey?: string }][]).map((c) => c[1].cacheKey);
    expect(keys).toEqual(["k:river-basins:huc2", "k:river-basins:huc8"]);
  });

  it("honours level, and says so when a wide view forces a coarser one", async () => {
    const stub = vi.fn(async () => json(huc2));
    const wide: [number, number, number, number] = [-125, 24, -66, 50];
    const stepped = geojson(await layer.query(ctx(stub, { zoom: 10, bbox: wide }), {}));
    expect(stepped.coverageNote).toBe("Showing regions (huc2) because huc8 is too fine for this view; zoom in for finer basins");
    expect(await layer.query(ctx(stub, { bbox: wide }), { level: "huc8" })).toEqual({
      error: "Area is 15079415 km²; huc8 units need a view under 250000 km², or use a coarser level",
      hint: "zoom_in",
    });
    const six = vi.fn(async (_url: string) => json(huc8));
    await layer.query(ctx(six), { level: "huc6" });
    expect(six.mock.calls[0][0]).toContain("/wbd/MapServer/3/query");
  });

  it("says when the 2,000 cap is hit or the area is empty, and returns nothing outside the US", async () => {
    const capped = vi.fn(async () => json({ ...huc8, exceededTransferLimit: true }));
    expect(geojson(await layer.query(ctx(capped), {})).coverageNote).toBe("Showing the 2,000 largest subbasins; zoom in for the rest");
    const empty = vi.fn(async () => json({ type: "FeatureCollection", features: [] }));
    expect(geojson(await layer.query(ctx(empty), {})).coverageNote).toBe("No watershed boundaries for this area");
    const stub = vi.fn();
    expect(geojson(await layer.query(ctx(stub, { bbox: [5, 45, 6, 46] }), {})).coverageNote).toBe("No data outside the United States");
    expect(stub).not.toHaveBeenCalled();
  });

  it("maps upstream failures to upstream errors", async () => {
    expect(await layer.query(ctx(vi.fn(async () => new Response("x", { status: 502 }))), {})).toEqual({
      error: "ArcGIS service returned 502",
      hint: "upstream",
    });
  });

  it("is registered, validates level and rejects an oversized area through runLayer", async () => {
    expect((await runLayer("river-basins", { bbox: FOUR_CORNERS, input: { level: "nope" } })).status).toBe(400);
    expect((await runLayer("river-basins", { bbox: [-170, 0, 10, 80] })).status).toBe(422);
  });
});
