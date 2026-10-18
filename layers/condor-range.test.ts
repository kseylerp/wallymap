import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { VINTAGE, normalizeRange, simplifyOffset } from "./condor-range";
import { cardTitle, labelsOf, legendOf, timeShapeOf } from "./contract";
import current from "./__fixtures__/condor-range.current.json";
import historic from "./__fixtures__/condor-range.historic.json";

const currentFc = current as unknown as FeatureCollection;
const historicFc = historic as unknown as FeatureCollection;

const WEST: [number, number, number, number] = [-125, 29, -107, 52];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** Answers the current-range URL with the current fixture and the historic one with the historic fixture. */
function serviceStub() {
  return vi.fn(async (url: string) => json(url.includes("/Historic_Range/") ? historicFc : currentFc));
}

function ctx(stub: ReturnType<typeof vi.fn>, bbox = WEST, cacheKey?: string) {
  return { bbox, zoom: 4, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

describe("condor-range layer", () => {
  it("declares sage polygons, no env and no input", () => {
    expect(layer.id).toBe("condor-range");
    expect(layer.license).toMatch(/terms not stated/);
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(20_000_000);
    expect(layer.hardMaxAreaKm2).toBeUndefined();
    expect(layer.wide).toEqual({ orderBy: "area", limit: 1000 });
    expect(layer.input.parse({})).toEqual({});
    expect(layer.style).toEqual({ geometry: "polygon", color: "#9FB693", fillOpacity: 0.25, encode: { color: "era" } });
  });

  it("labels the three current polygons current or experimental, and the historic one historic", () => {
    const now = normalizeRange(currentFc, false);
    expect(now.map((f) => [f.properties?.name, f.properties?.kind])).toEqual([
      ["Current California Range For California Condors", "current"],
      ["Current Southwest Experimental Range For California Condors", "experimental"],
      ["Current Baja California Experimental Range For California Condors", "experimental"],
    ]);
    for (const f of now) expect(f.properties?.era).toBe("today");
    expect(now.map((f) => cardTitle(layer, f))).toEqual([
      "Today: California range",
      "Today: Arizona and Utah release area",
      "Today: Baja California release area",
    ]);
    const old = normalizeRange(historicFc, true);
    expect(old).toHaveLength(1);
    expect(old[0].properties).toMatchObject({ kind: "historic", era: "early 1800s", heading: "Early 1800s range" });
  });

  it("queries both services with the bbox and returns four polygons with a citation", async () => {
    const stub = serviceStub();
    const r = await layer.query(ctx(stub, WEST, "condor-range:k"), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const calls = stub.mock.calls as unknown as [string, RequestInit & { cacheKey?: string; ttlSeconds?: number }][];
    expect(calls.map((c) => new URL(c[0]).pathname).sort()).toEqual([
      "/fBc8EJBxQRMcHlei/ArcGIS/rest/services/Current_Range/FeatureServer/0/query",
      "/fBc8EJBxQRMcHlei/ArcGIS/rest/services/Historic_Range/FeatureServer/0/query",
    ]);
    expect(calls.map((c) => c[1].cacheKey).sort()).toEqual(["condor-range:k:condor-current", "condor-range:k:condor-historic"]);
    expect(calls[0][1].ttlSeconds).toBe(7 * 86_400);
    expect(r.data.features).toHaveLength(4);
    // The early-1800s outline comes first, so today's ranges draw over it.
    expect(r.data.features.map((f) => f.properties?.era)).toEqual(["early 1800s", "today", "today", "today"]);
    expect(r.coverageNote).toBe("Range as mapped by NPS in 2018; northern California releases since 2022 are not in it");
    expect(r.citation.source).toContain("National Park Service");
  });

  it("keeps the other range and says so when one service fails, and errors when both do", async () => {
    const half = vi.fn(async (url: string) => (url.includes("/Historic_Range/") ? new Response("no", { status: 500 }) : json(currentFc)));
    const r = await layer.query(ctx(half), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(3);
    expect(r.coverageNote).toMatch(/historic range could not be loaded/);
    expect(r.coverageNote).toContain(VINTAGE);

    const none = vi.fn(async () => new Response("no", { status: 500 }));
    expect(await layer.query(ctx(none), {})).toMatchObject({ hint: "upstream" });
  });

  it("returns a note without calling upstream outside western North America", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub, [2, 45, 3, 46]), {});
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toMatch(/western North America/);
  });

  it("simplifies coarser over a wide view, within bounds", () => {
    expect(simplifyOffset([0, 0, 0.1, 0.1])).toBe(0.002);
    expect(simplifyOffset(WEST)).toBe(0.05);
  });

  it("answers a box over 20 million km² largest first with a count from both services", async () => {
    const stub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (new URL(url).searchParams.get("returnCountOnly") === "true") return json({ count: url.includes("/Historic_Range/") ? 1 : 3 });
      return json(url.includes("/Historic_Range/") ? historicFc : currentFc);
    });
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("condor-range", { bbox: [-170, 18, -60, 72], zoom: 2 });
      expect(res.status).toBe(200);
      const data = stub.mock.calls.map((c) => new URL(String(c[0]))).filter((u) => !u.searchParams.has("returnCountOnly"));
      expect(data).toHaveLength(2);
      for (const u of data) {
        expect(u.searchParams.get("orderByFields")).toBe("Shape__Area DESC");
        expect(u.searchParams.get("resultRecordCount")).toBe("1000");
      }
      expect(res.body).toMatchObject({ total: 4, coverageNote: `Showing all 4 in this wide view (ranked by area); ${VINTAGE}` });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses a whole hemisphere through runLayer", async () => {
    expect((await runLayer("condor-range", { bbox: [-180, -80, 0, 80], zoom: 1 })).status).toBe(422);
  });

  it("describes ranges as outlines, not sightings", () => {
    expect(layer.description).toMatch(/not nesting sites/);
    expect(layer.description).toMatch(/early 1800s/);
    expect(layer.description).toMatch(/as mapped by NPS in 2018; northern California releases since 2022/);
  });

  it("keys today filled in sage and the early 1800s as an outline, with the 2018 vintage on the legend and every card", () => {
    const era = layer.attributes?.find((a) => a.key === "era");
    expect(era).toMatchObject({ type: "category", encode: "color", primary: true });
    expect(era?.levels?.map((l) => l.label)).toEqual(["Today", "Early 1800s"]);
    const legend = legendOf(layer);
    expect(legend.items).toEqual([
      expect.objectContaining({ label: "Today", color: "#9FB693", symbol: "polygon" }),
      expect.objectContaining({ label: "Early 1800s", color: "#3A3A3C", symbol: "line" }),
    ]);
    expect(legend.note).toBe(`${VINTAGE}.`);
    const when = layer.card?.facts?.find((f) => f.key === "era");
    expect(when?.values?.today).toMatch(/NPS in 2018/);
    expect(when?.values?.["early 1800s"]).toMatch(/early 1800s/);
    expect(labelsOf(layer)).toEqual({ field: "heading", max: 4 });
    expect(timeShapeOf(layer)).toEqual({ shape: "none" });
  });
});
