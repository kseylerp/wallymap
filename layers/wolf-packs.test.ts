import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { cardContent } from "@/lib/render/card";
import { summarizeFeature } from "@/lib/render/inspect";
import layer, { LATEST_KNOWN_YEAR, YEARS_URL, newestYearOf, normalizePacks, simplifyOffset, yearWhere } from "./wolf-packs";
import { contractProblems, labelsOf, legendOf, timeShapeOf } from "./contract";
import raw from "./__fixtures__/wolf-packs.ne-washington.json";
import years from "./__fixtures__/wolf-packs.years.json";

const fixture = raw as unknown as FeatureCollection;

const NE_WASHINGTON: [number, number, number, number] = [-118.5, 48.4, -117, 49];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** The year list (a live distinct-values answer, 2014 to 2025, recorded 2026-10-18) for that URL, else the packs (or `packs`). */
function upstream(yearsResponse?: Response, packs: unknown = fixture) {
  return vi.fn(async (url: string) => {
    if (url === YEARS_URL) return yearsResponse ?? json(years);
    const where = new URL(url).searchParams.get("where");
    const m = /^Year=(\d+)$/.exec(where ?? "");
    const fc = packs as FeatureCollection;
    return json(m ? { ...fc, features: fc.features.filter((f) => f.properties?.Year === Number(m[1])) } : fc);
  });
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string) {
  return { bbox: NE_WASHINGTON, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

describe("wolf-packs layer", () => {
  it("declares sage polygons, no env and an optional year input", () => {
    expect(layer.id).toBe("wolf-packs");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(300_000);
    expect(layer.hardMaxAreaKm2).toBeUndefined();
    expect(layer.wide).toEqual({ orderBy: "year", limit: 1000, rank: "newest" });
    expect(layer.license).toMatch(/terms not stated/);
    expect(layer.style).toEqual({ geometry: "polygon", color: "#9FB693", fillOpacity: 0.3 });
    expect(layer.input.parse({})).toEqual({ allYears: false });
    expect(layer.input.parse({ year: 2023 })).toEqual({ year: 2023, allYears: false });
    expect(layer.input.parse({ allYears: true })).toEqual({ allYears: true });
    expect(() => layer.input.parse({ year: 2023.5 })).toThrow();
  });

  it("normalizes packs to polygons with year, status, kind and t", () => {
    const fc = normalizePacks(fixture);
    expect(fc.features).toHaveLength(fixture.features.length);
    const breeding = fc.features.find((f) => f.properties?.pack === "Dirty Shirt");
    expect(breeding?.properties).toEqual({
      heading: "Dirty Shirt",
      pack: "Dirty Shirt",
      year: 2023,
      t: "2023-01-01T00:00:00.000Z",
      status: "Breeding Pairs",
      kind: "Breeding Pairs",
    });
    const early = fc.features.find((f) => f.properties?.year === 2016);
    expect(early?.properties).toMatchObject({ kind: "Not recorded", t: "2016-01-01T00:00:00.000Z" });
    expect(early?.properties).not.toHaveProperty("status");
    for (const f of fc.features) expect(f.geometry.type).toBe("Polygon");
  });

  it("skips rows without geometry and tolerates missing fields", () => {
    const fc = normalizePacks({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: null as never, properties: { Pack: "Ghost", Year: 2020 } },
        { type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: {} },
      ],
    });
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toEqual({ heading: "Unnamed pack", pack: "Unnamed pack", kind: "Not recorded" });
  });

  it("builds a year filter only when a year is given", () => {
    expect(yearWhere(undefined)).toBeUndefined();
    expect(yearWhere(2023)).toBe("Year=2023");
  });

  it("simplifies finer when zoomed in, within bounds", () => {
    expect(simplifyOffset([0, 0, 0.1, 0.1])).toBe(0.001);
    expect(simplifyOffset(NE_WASHINGTON)).toBeCloseTo(0.005, 6);
    expect(simplifyOffset([-125, 45, -100, 49])).toBe(0.02);
  });

  it("by default reads the newest year from the service and shows only that year's packs, and says so", async () => {
    const stub = upstream();
    const r = await layer.query(ctx(stub, "wolf-packs:k"), { allYears: false });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const calls = stub.mock.calls as unknown as [string, RequestInit & { ttlSeconds?: number; cacheKey?: string }][];
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe(YEARS_URL);
    expect(calls[0][1].cacheKey).toBe("wolf-packs:k:years");
    const url = new URL(calls[1][0]);
    expect(url.origin + url.pathname).toBe(
      "https://geodataservices.wdfw.wa.gov/arcgis/rest/services/WP_Statewide/Wolf_PackPolygons/MapServer/1/query",
    );
    expect(url.searchParams.get("where")).toBe("Year=2025");
    expect(url.searchParams.get("outFields")).toBe("Pack,Year,PackStatus");
    expect(url.searchParams.get("geometry")).toBe(NE_WASHINGTON.join(","));
    expect(calls[1][1].cacheKey).toBe("wolf-packs:k:wolves:2025");
    expect(r.coverageNote).toMatch(/^Packs in 2025, the newest year published/);
  });

  it("keeps the newest year in the answer when the year list fails", async () => {
    const stub = upstream(new Response("nope", { status: 500 }));
    const r = await layer.query(ctx(stub), { allYears: false });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(new URL((stub.mock.calls as unknown as [string][])[1][0]).searchParams.get("where")).toBe("1=1");
    expect(r.data.features.map((f) => f.properties?.year)).toEqual([2025, 2025, 2025]);
    expect(r.coverageNote).toMatch(/Packs in 2025/);
  });

  it("returns every year with allYears, and one year when asked, without reading the year list", async () => {
    const all = vi.fn(async () => json(fixture));
    const r = await layer.query(ctx(all), { allYears: true });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(all).toHaveBeenCalledTimes(1);
    expect(new URL((all.mock.calls as unknown as [string][])[0][0]).searchParams.get("where")).toBe("1=1");
    expect(r.data.features).toHaveLength(fixture.features.length);
    expect(r.coverageNote).toBeUndefined();
    const one = vi.fn(async () => json(fixture));
    await layer.query(ctx(one), { year: 2023, allYears: false });
    expect(one).toHaveBeenCalledTimes(1);
    expect(new URL((one.mock.calls as unknown as [string][])[0][0]).searchParams.get("where")).toBe("Year=2023");
  });

  it("reads the newest year from a distinct-values answer (the max statistic is wrong on this server)", () => {
    expect(newestYearOf(years)).toBe(2025);
    expect(newestYearOf({ features: [] })).toBeUndefined();
    expect(newestYearOf(null)).toBeUndefined();
  });

  it("titles the card with the pack's name, labels packs by name, and steps one snapshot per real year", () => {
    const data = normalizePacks(fixture);
    const dirty = data.features.find((f) => f.properties?.pack === "Dirty Shirt");
    if (!dirty) throw new Error("no Dirty Shirt");
    expect(summarizeFeature(dirty).name).toBe("Dirty Shirt");
    const card = cardContent(dirty, { card: layer.card, fieldHelp: layer.fieldHelp });
    expect(card.facts.map((f) => [f.label, f.value])).toEqual([
      ["Year", "2023"],
      ["Pack status", "Breeding pair"],
    ]);
    expect(labelsOf(layer)).toEqual({ field: "pack", max: 60 });
    const time = timeShapeOf(layer, data);
    expect(time.shape).toBe("snapshots");
    expect(time.step).toBe("year");
    expect(time.dates?.[0]).toBe("2014");
    expect(time.dates?.at(-1)).toBe(String(LATEST_KNOWN_YEAR));
    expect(time.dates).toHaveLength(LATEST_KNOWN_YEAR - 2014 + 1);
    const legend = legendOf(layer, data);
    expect(legend.kind).toBe("categories");
    expect(legend.items?.map((i) => i.label)).toEqual(["Breeding pair", "Pack, not breeding", "Single wolf's territory", "Not published for this year"]);
    expect(contractProblems(layer)).toEqual([]);
  });

  it("says when the service capped the result", async () => {
    const stub = vi.fn(async () => json({ ...fixture, exceededTransferLimit: true }));
    const r = await layer.query(ctx(stub), { allYears: true });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toMatch(/pick a year/);
  });

  it("returns a note without calling upstream outside Washington", async () => {
    const stub = vi.fn();
    const r = await layer.query({ bbox: [-110, 44, -109, 45], zoom: 9, env: {}, fetch: stub as unknown as CachedFetch }, { allYears: false });
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toMatch(/Washington/);
  });

  it("says the data starts in 2014 for an earlier year, without calling upstream", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub), { year: 2010, allYears: false });
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toMatch(/start in 2014/);
    expect(r.coverageNote).toMatch(/2010/);
  });

  it("maps an ArcGIS error body and an HTTP error to upstream errors", async () => {
    const body = vi.fn(async () => json({ error: { code: 400, message: "Unable to complete operation." } }));
    expect(await layer.query(ctx(body), { allYears: false })).toMatchObject({ hint: "upstream" });
    const http = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(await layer.query(ctx(http), { allYears: true })).toMatchObject({ hint: "upstream" });
  });

  it("rejects through runLayer only a box over four times the soft cap", async () => {
    const res = await runLayer("wolf-packs", { bbox: [-125, 40, -110, 50], zoom: 4 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ hint: "zoom_in", error: expect.stringMatching(/zoom in to under 1200000 km²$/) });
  });

  it("answers the Pacific Northwest wide: newest first, no count request (the server's count is unreliable), and runLayer's note", async () => {
    const stub = vi.fn(async () => json(fixture));
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("wolf-packs", { bbox: [-125, 44, -114, 50], zoom: 5, input: { allYears: true } });
      expect(res.status).toBe(200);
      expect(stub).toHaveBeenCalledTimes(1);
      const data = new URL(String((stub.mock.calls[0] as unknown as [string])[0]));
      expect(data.searchParams.get("orderByFields")).toBe("Year DESC");
      expect(data.searchParams.get("resultRecordCount")).toBe("1000");
      expect(res.body).toMatchObject({ coverageNote: `Showing all ${fixture.features.length} in this wide view (ranked by year)` });
      expect(res.body).not.toHaveProperty("truncated");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("says Washington only and names California's PDFs", () => {
    expect(layer.description).toMatch(/Washington only/);
    expect(layer.description).toMatch(/California publishes reports as PDFs only/);
  });
});
