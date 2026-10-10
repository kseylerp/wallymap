import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { normalizePlants, normalizeSolar, normalizeTurbines, plantsWhere, usgsUrl } from "./power-plants";
import eia from "./__fixtures__/power-plants.eia-bay-area.json";
import wind from "./__fixtures__/power-plants.wind-tehachapi.json";
import solar from "./__fixtures__/power-plants.solar-mojave.json";

const eiaFc = eia as unknown as FeatureCollection;

const BAY: [number, number, number, number] = [-122.5, 37.5, -121.5, 38.3];
const TEHACHAPI: [number, number, number, number] = [-118.5, 35, -118.1, 35.3];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function ctx(stub: ReturnType<typeof vi.fn>, bbox = BAY, cacheKey?: string) {
  return { bbox, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

type Call = [string, RequestInit & { cacheKey?: string; ttlSeconds?: number }];

describe("power-plants layer", () => {
  it("declares US coverage, extruded clustered points in dark grey, and source and fuel inputs", () => {
    expect(layer.id).toBe("power-plants");
    expect(layer.coverage).toBe("us");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(250_000);
    expect(layer.style).toEqual({ geometry: "point", color: "#3A3A3C", extrude: "v", cluster: true });
    expect(layer.input.parse({})).toEqual({ source: "plants" });
    expect(layer.input.parse({ source: "wind-turbines" })).toEqual({ source: "wind-turbines" });
    expect(layer.input.parse({ fuel: "coal" })).toEqual({ source: "plants", fuel: "coal" });
    expect(() => layer.input.parse({ fuel: "unobtainium" })).toThrow();
    expect(() => layer.input.parse({ source: "fusion" })).toThrow();
  });

  it("normalizes EIA plants with MW as v and the fuel as kind", () => {
    const fc = normalizePlants(eiaFc);
    expect(fc.features).toHaveLength(eiaFc.features.length);
    for (const f of fc.features) {
      expect(f.geometry.type).toBe("Point");
      expect(f.properties?.v).toBe(f.properties?.mw);
      expect(f.properties).not.toHaveProperty("t");
    }
    const kinds = new Set(fc.features.map((f) => f.properties?.kind));
    expect(kinds.has("natural gas")).toBe(true);
    expect(kinds.has("wind")).toBe(true);
    expect(fc.features[0].properties).toMatchObject({ dataPeriod: "2025-02", state: "California" });
    expect(typeof fc.features[0].properties?.utility).toBe("string");
  });

  it("skips non-points and tolerates missing fields in plants", () => {
    const fc = normalizePlants({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: null as never, properties: { Plant_Name: "Ghost" } },
        { type: "Feature", geometry: { type: "Point", coordinates: [-100, 40] }, properties: {} },
      ],
    });
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toEqual({ name: "Unnamed plant", kind: "other" });
  });

  it("builds a fuel filter only when a fuel is set", () => {
    expect(plantsWhere(undefined)).toBeUndefined();
    expect(plantsWhere("natural gas")).toBe("PrimSource='natural gas'");
  });

  it("builds PostgREST requests with repeated bounds, biggest first and one row over the cap", () => {
    const url = new URL(usgsUrl("https://energy.usgs.gov/api/uswtdb/v1/turbines", ["a", "b"], "t_cap.desc.nullslast", TEHACHAPI, 3000));
    expect(url.origin + url.pathname).toBe("https://energy.usgs.gov/api/uswtdb/v1/turbines");
    expect(url.searchParams.getAll("xlong")).toEqual(["gte.-118.5", "lte.-118.1"]);
    expect(url.searchParams.getAll("ylat")).toEqual(["gte.35", "lte.35.3"]);
    expect(url.searchParams.get("select")).toBe("a,b");
    expect(url.searchParams.get("order")).toBe("t_cap.desc.nullslast");
    expect(url.searchParams.get("limit")).toBe("3001");
  });

  it("normalizes turbines: own rating as v, else the project average, with the year online as t", () => {
    const fc = normalizeTurbines(wind);
    expect(fc.features).toHaveLength(wind.length);
    const oasis = fc.features[0];
    expect(oasis.properties).toMatchObject({
      kind: "wind",
      project: "Oasis Repowering",
      mw: 3.6,
      v: 3.6,
      turbines: 21,
      projectMw: 72,
      manufacturer: "Vestas",
      hubHeightM: 82,
      rotorDiameterM: 136,
      state: "CA",
      year: 2020,
      t: "2020-01-01T00:00:00.000Z",
    });
    const unrated = fc.features.find((f) => f.properties?.project?.startsWith("Mojave 16"));
    expect(unrated?.properties?.v).toBeCloseTo(84.75 / 297, 2);
    expect(unrated?.properties).not.toHaveProperty("manufacturer");
    const old = fc.features.find((f) => f.properties?.project === "Cameron Ridge");
    expect(old?.properties).toMatchObject({ mw: 0.7, t: "1999-01-01T00:00:00.000Z" });
  });

  it("normalizes solar projects with AC megawatts as v and the year online as t", () => {
    const fc = normalizeSolar(solar);
    expect(fc.features).toHaveLength(solar.length);
    const eland = fc.features.find((f) => f.properties?.name === "Eland Solar & Storage Center, Phase 1 Hy");
    expect(eland?.properties).toMatchObject({ kind: "solar", mw: 309.6, v: 309.6, battery: "batteries", year: 2024, t: "2024-01-01T00:00:00.000Z" });
    expect(eland?.properties).toHaveProperty("mwDc");
  });

  it("drops rows without coordinates and ignores silly years", () => {
    const fc = normalizeTurbines([{ p_name: "No location" }, { xlong: -118, ylat: 35, p_year: 1066 }, null]);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toEqual({ name: "Wind turbine", kind: "wind" });
  });

  it("queries the EIA mirror for plants, largest first, with the fuel filter and a week of cache", async () => {
    const stub = vi.fn(async () => json(eiaFc));
    const r = await layer.query(ctx(stub, BAY, "power-plants:k"), { source: "plants", fuel: "natural gas" });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const calls = stub.mock.calls as unknown as Call[];
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0][0]);
    expect(url.origin + url.pathname).toBe(
      "https://services2.arcgis.com/FiaPA4ga0iQKduv3/ArcGIS/rest/services/Power_Plants_in_the_US/FeatureServer/0/query",
    );
    expect(url.searchParams.get("where")).toBe("PrimSource='natural gas'");
    expect(url.searchParams.get("orderByFields")).toBe("Total_MW DESC");
    expect(url.searchParams.get("resultRecordCount")).toBe("2000");
    expect(calls[0][1].ttlSeconds).toBe(7 * 86_400);
    expect(r.data.features).toHaveLength(eiaFc.features.length);
    expect(r.citation.source).toMatch(/Feb 2025/);
    expect(r.coverageNote).toBeUndefined();
  });

  it("says when the plants result was capped", async () => {
    const stub = vi.fn(async () => json({ ...eiaFc, exceededTransferLimit: true }));
    const r = await layer.query(ctx(stub), { source: "plants" });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toMatch(/2,000 largest plants/);
  });

  it("queries the wind database once and returns turbines", async () => {
    const stub = vi.fn(async () => json(wind));
    const r = await layer.query(ctx(stub, TEHACHAPI, "power-plants:w"), { source: "wind-turbines" });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const calls = stub.mock.calls as unknown as Call[];
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toContain("https://energy.usgs.gov/api/uswtdb/v1/turbines?");
    expect(calls[0][1].cacheKey).toBe("power-plants:w:wind");
    expect(r.data.features).toHaveLength(wind.length);
    expect(r.citation.source).toContain("Wind Turbine Database");
    expect(r.coverageNote).toBeUndefined();
  });

  it("trims to the cap and says so when the database returns the extra row", async () => {
    const rows = Array.from({ length: 3001 }, (_, i) => ({ xlong: -118.3, ylat: 35.1, t_cap: 2000, p_name: `P${i}` }));
    const stub = vi.fn(async () => json(rows));
    const r = await layer.query(ctx(stub, TEHACHAPI), { source: "wind-turbines" });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(3000);
    expect(r.coverageNote).toMatch(/3,000 largest turbines/);
  });

  it("queries the solar database and returns projects", async () => {
    const stub = vi.fn(async () => json(solar));
    const r = await layer.query(ctx(stub, [-118.5, 34.5, -117.5, 35.3]), { source: "solar-projects" });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect((stub.mock.calls as unknown as Call[])[0][0]).toContain("https://energy.usgs.gov/api/uspvdb/v1/projects?");
    expect(r.data.features).toHaveLength(solar.length);
    expect(r.citation.source).toContain("Solar Photovoltaic");
  });

  it("maps errors from each source to upstream errors", async () => {
    const arc = vi.fn(async () => json({ error: { code: 400, message: "Unable to complete operation." } }));
    expect(await layer.query(ctx(arc), { source: "plants" })).toMatchObject({ hint: "upstream" });
    const http = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(await layer.query(ctx(http), { source: "wind-turbines" })).toMatchObject({ hint: "upstream" });
    const notList = vi.fn(async () => json({ code: "PGRST100", message: "bad request" }));
    expect(await layer.query(ctx(notList), { source: "solar-projects" })).toMatchObject({ hint: "upstream", error: expect.stringContaining("did not return a list") });
    const down = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await layer.query(ctx(down), { source: "wind-turbines" })).toMatchObject({ hint: "upstream" });
  });

  it("returns a coverage note without calling upstream outside the US", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub, [2, 45, 3, 46]), { source: "plants" });
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toBe("No data outside the United States");
  });

  it("rejects an oversized bbox through runLayer", async () => {
    expect((await runLayer("power-plants", { bbox: [-125, 30, -105, 45], zoom: 4 })).status).toBe(422);
  });

  it("says the plants mirror lags EIA and warns against double counting wind and solar", () => {
    expect(layer.description).toMatch(/lags EIA/);
    expect(layer.description).toMatch(/do not add its wind and solar counts/);
    expect(layer.description).toMatch(/megawatts/);
  });
});
