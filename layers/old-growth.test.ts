import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { OLD_GROWTH_CLASSES, normalizeOldGrowth, oldGrowthClass, simplifyOffset } from "./old-growth";
import { contractProblems, legendOf } from "./contract";
import { cardContent } from "@/lib/render/card";
import { hexToRgb, lightness } from "@/lib/render/ramp";
import { DARK_GREY, PURPLE, SAGE } from "@/lib/render/palette";
import { hardMaxAreaKm2 } from "./types";
import raw from "./__fixtures__/old-growth.cascades.json";

const fixture = raw as unknown as FeatureCollection;

const CASCADES: [number, number, number, number] = [-122.5, 43.5, -122, 44];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string) {
  return { bbox: CASCADES, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

describe("old-growth layer", () => {
  it("declares US coverage, sage extruded polygons, no env and no input", () => {
    expect(layer.id).toBe("old-growth");
    expect(layer.coverage).toBe("us");
    expect(layer.license).toMatch(/Public domain/);
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(300_000);
    expect(hardMaxAreaKm2(layer)).toBe(1_200_000);
    expect(layer.wide).toEqual({ orderBy: "old-growth acres", limit: 1000 });
    expect(layer.input.parse({})).toEqual({});
    expect(layer.style).toEqual({ geometry: "polygon", color: "#9FB693", unit: "acres", fillOpacity: 0.35, extrude: "v" });
  });

  it("normalizes firesheds to polygons with old-growth acres as v, mature acres and the survey error", () => {
    const fc = normalizeOldGrowth(fixture);
    expect(fc.features).toHaveLength(fixture.features.length);
    for (const f of fc.features) expect(["Polygon", "MultiPolygon"]).toContain(f.geometry.type);
    expect(fc.features[0].properties).toMatchObject({
      name: "McCredie Springs, Oregon",
      oldGrowthAcres: 130822,
      v: 130822,
      matureAcres: 40847,
      forestType: "Douglas-fir",
    });
    expect(typeof fc.features[0].properties?.oldGrowthErrorPercent).toBe("number");
  });

  it("skips rows without geometry and tolerates missing fields", () => {
    const fc = normalizeOldGrowth({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: null as never, properties: { Fireshed_Name: "Ghost" } },
        { type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: {} },
      ],
    });
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toEqual({ name: "Unnamed fireshed" });
  });

  it("simplifies coarser over a wide view, within bounds", () => {
    expect(simplifyOffset([0, 0, 0.1, 0.1])).toBe(0.002);
    expect(simplifyOffset(CASCADES)).toBeCloseTo(0.0025, 6);
    expect(simplifyOffset([-125, 30, -105, 45])).toBe(0.02);
    expect(simplifyOffset([-125, 30, -105, 45], true)).toBe(0.05);
  });

  it("asks the verified layer for 200 firesheds, most old growth first, with a week of cache", async () => {
    const stub = vi.fn(async () => json(fixture));
    const r = await layer.query(ctx(stub, "old-growth:k"), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");

    const calls = stub.mock.calls as unknown as [string, RequestInit & { ttlSeconds?: number }][];
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0][0]);
    expect(url.origin + url.pathname).toBe(
      "https://apps.fs.usda.gov/fsgisx02/rest/services/wo_nfs_gstc/WO_OSC_GapAnalysis_OldGrowthAndMatureForests/MapServer/31/query",
    );
    expect(url.searchParams.get("resultRecordCount")).toBe("200");
    expect(url.searchParams.get("orderByFields")).toBe("OLD_GROWTH_ACRES DESC");
    expect(url.searchParams.get("geometry")).toBe(CASCADES.join(","));
    expect(calls[0][1].ttlSeconds).toBe(7 * 86_400);
    expect(r.data.features.length).toBe(fixture.features.length);
    expect(r.coverageNote).toBeUndefined();
  });

  it("says when the service capped the result", async () => {
    const stub = vi.fn(async () => json({ ...fixture, exceededTransferLimit: true }));
    const r = await layer.query(ctx(stub), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toMatch(/200 firesheds/);
  });

  it("maps an ArcGIS error body and an HTTP error to upstream errors", async () => {
    const body = vi.fn(async () => json({ error: { code: 400, message: "Unable to complete operation." } }));
    expect(await layer.query(ctx(body), {})).toMatchObject({ hint: "upstream" });
    const http = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(await layer.query(ctx(http), {})).toMatchObject({ hint: "upstream" });
  });

  it("returns a coverage note without calling upstream outside the US", async () => {
    const stub = vi.fn();
    const r = await layer.query({ bbox: [2, 45, 3, 46], zoom: 9, env: {}, fetch: stub as unknown as CachedFetch }, {});
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toBe("No data outside the United States");
  });

  it("rejects with zoom_in through runLayer only a box over four times the soft cap", async () => {
    const res = await runLayer("old-growth", { bbox: [-125, 25, -66, 49], zoom: 3 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ hint: "zoom_in", error: expect.stringMatching(/zoom in to under 1200000 km²$/) });
  });

  it("answers the Pacific Northwest wide: a count, then the ordered 200-row pages it calls for, and runLayer's note", async () => {
    const stub = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return url.searchParams.get("returnCountOnly") === "true" ? json({ count: 1640 }) : json({ ...fixture, exceededTransferLimit: true });
    });
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("old-growth", { bbox: [-125, 42, -116, 49], zoom: 5 });
      expect(res.status).toBe(200);
      const data = stub.mock.calls.map((c) => new URL(String(c[0]))).filter((u) => !u.searchParams.has("returnCountOnly"));
      expect(data.map((u) => u.searchParams.get("resultOffset") ?? "0").sort()).toEqual(["0", "200", "400", "600", "800"]);
      for (const u of data) {
        expect(u.searchParams.get("orderByFields")).toBe("OLD_GROWTH_ACRES DESC");
        expect(u.searchParams.get("resultRecordCount")).toBe("200");
        expect(u.searchParams.get("maxAllowableOffset")).toBe("0.045");
      }
      expect(res.body).toMatchObject({
        total: 1640,
        truncated: true,
        coverageNote: `Showing the ${fixture.features.length * 5} largest of 1,640 (ranked by old-growth acres); zoom in under 300,000 km² for all`,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("asks only for the pages the count calls for", async () => {
    const stub = vi.fn(async (url: string) => (new URL(url).searchParams.get("returnCountOnly") === "true" ? json({ count: 390 }) : json(fixture)));
    const r = await layer.query({ ...ctx(stub), bbox: [-125, 42, -116, 49], wide: true, wideStrategy: layer.wide }, {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.total).toBe(390);
    const data = (stub.mock.calls as unknown as [string][]).map((c) => new URL(c[0])).filter((u) => !u.searchParams.has("returnCountOnly"));
    expect(data.map((u) => u.searchParams.get("resultOffset") ?? "0").sort()).toEqual(["0", "200"]);
  });

  it("keeps the first page when a later wide page fails, and errors only when the first does", async () => {
    const later = vi.fn(async (url: string) => {
      if (url.includes("resultOffset")) return new Response("no", { status: 500 });
      return new URL(url).searchParams.get("returnCountOnly") === "true" ? json({ count: 640 }) : json(fixture);
    });
    const r = await layer.query({ ...ctx(later), bbox: [-125, 42, -116, 49], wide: true, wideStrategy: layer.wide }, {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(fixture.features.length);
    expect(r.total).toBe(640);
    expect(r.coverageNote).toBeUndefined();
    const firstFails = vi.fn(async (url: string) => (url.includes("resultOffset") ? json(fixture) : new Response("no", { status: 500 })));
    expect(await layer.query({ ...ctx(firstFails), bbox: [-125, 42, -116, 49], wide: true, wideStrategy: layer.wide }, {})).toMatchObject({
      hint: "upstream",
    });
  });

  it("says the finest unit is a 250,000-acre fireshed and that figures are estimates", () => {
    expect(layer.description).toMatch(/250,000 acres/);
    expect(layer.description).toMatch(/finest unit/);
    expect(layer.description).toMatch(/estimates/);
    expect(layer.description).toMatch(/federal/i);
  });

  it("fills firesheds by old-growth class on the ramp, ranks by old-growth acres, and keys the legend to the classes", () => {
    expect([0, 4_999, 5_000, 21_334, 50_000, 130_822].map(oldGrowthClass)).toEqual(["under-5k", "under-5k", "5k-20k", "20k-50k", "50k-up", "50k-up"]);
    for (const f of normalizeOldGrowth(fixture).features) {
      expect(f.properties?.oldGrowthClass).toBe(oldGrowthClass(Number(f.properties?.oldGrowthAcres)));
    }
    const legend = legendOf(layer);
    expect(legend).toMatchObject({ kind: "categories", field: "oldGrowthClass", unit: "acres" });
    expect(legend.items?.map((i) => i.color)).toEqual(OLD_GROWTH_CLASSES.map((c) => c.color));
    expect(layer.attributes?.find((a) => a.key === "oldGrowthAcres")).toMatchObject({ type: "measure", encode: "size" });
    expect(layer.labels).toEqual({ field: "name", max: 6, rankBy: "oldGrowthAcres" });
    expect(layer.description).toMatch(/whole fireshed/);
    expect(contractProblems(layer)).toEqual([]);
  });

  it("ramps the four classes light to dark along the density ramp, not unrelated colors", () => {
    const colors = OLD_GROWTH_CLASSES.map((c) => c.color);
    expect([colors[0], colors[2], colors[3]]).toEqual([SAGE, PURPLE, DARK_GREY]);
    const l = colors.map((c) => lightness(hexToRgb(c)));
    for (let i = 1; i < l.length; i++) expect(l[i], colors[i]).toBeLessThan(l[i - 1]);
    expect(layer.attributes?.find((a) => a.key === "oldGrowthClass")).toMatchObject({ type: "ordinal", encode: "color", primary: true });
  });

  it("cards a fireshed's standard error as uncertainty, in plain words", () => {
    const fireshed = normalizeOldGrowth(fixture).features.find((f) => f.properties?.oldGrowthErrorPercent !== undefined)!;
    const card = cardContent(fireshed, { card: layer.card, fieldHelp: layer.fieldHelp });
    const labels = card.facts.map((r) => r.label);
    expect(labels).toContain("Uncertainty (±)");
    expect(labels.join(" ")).not.toMatch(/standard error/i);
    expect(card.facts.find((r) => r.label === "Uncertainty (±)")?.help?.text).toMatch(/^How far off the old-growth acres may be/);
  });
});
