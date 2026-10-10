import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { cdfwWhere, idsWhere, normalizeCdfw, normalizeIds, planYears } from "./tree-mortality";
import ids from "./__fixtures__/tree-mortality.ids-tahoe.json";
import cdfw from "./__fixtures__/tree-mortality.cdfw-tahoe.json";

const idsFc = ids as unknown as FeatureCollection;
const cdfwFc = cdfw as unknown as FeatureCollection;

const TAHOE: [number, number, number, number] = [-120.5, 38.9, -120, 39.3];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** Answers the Forest Service URL with its fixture and the California URL with its fixture. */
function serviceStub(overrides: { ids?: () => Response; cdfw?: () => Response } = {}) {
  return vi.fn(async (url: string) => {
    if (url.includes("EDW_InsectandDiseaseSurvey_01")) return overrides.ids?.() ?? json(idsFc);
    if (url.includes("biosds2783_fpu")) return overrides.cdfw?.() ?? json(cdfwFc);
    throw new Error(`unexpected url ${url}`);
  });
}

function ctx(stub: ReturnType<typeof vi.fn>, bbox = TAHOE, cacheKey?: string) {
  return { bbox, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

type Call = [string, RequestInit & { cacheKey?: string; ttlSeconds?: number }];
const urls = (stub: ReturnType<typeof vi.fn>) => (stub.mock.calls as unknown as Call[]).map((c) => new URL(c[0]));

describe("tree-mortality layer", () => {
  it("declares US coverage, pink polygons, no env and an optional years input", () => {
    expect(layer.id).toBe("tree-mortality");
    expect(layer.coverage).toBe("us");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(20_000);
    expect(layer.style).toEqual({ geometry: "polygon", color: "#F57272", fillOpacity: 0.4 });
    expect(layer.input.parse({})).toEqual({});
    expect(layer.input.parse({ years: { from: 2015, to: 2019 } })).toEqual({ years: { from: 2015, to: 2019 } });
    expect(() => layer.input.parse({ years: { from: 1900, to: 2019 } })).toThrow();
    expect(() => layer.input.parse({ years: { from: 2015 } })).toThrow();
  });

  it("sends 2021 and later to the Forest Service survey and 2019 and earlier to the California copy", () => {
    expect(planYears(undefined)).toMatchObject({ ids: [2021, 2025], cdfw: null, includes2020: false });
    expect(planYears({ from: 2015, to: 2019 })).toMatchObject({ ids: null, cdfw: [2015, 2019], includes2020: false });
    expect(planYears({ from: 2018, to: 2023 })).toMatchObject({ ids: [2021, 2023], cdfw: [2018, 2019], includes2020: true });
    expect(planYears({ from: 2020, to: 2020 })).toMatchObject({ ids: null, cdfw: null, includes2020: true });
    expect(planYears({ from: 2024, to: 2022 })).toMatchObject({ from: 2022, to: 2024, ids: [2022, 2024] });
    expect(planYears({ from: 1973, to: 2025 })).toMatchObject({ ids: [2021, 2025], cdfw: [1973, 2019] });
  });

  it("builds mortality-only year filters", () => {
    expect(idsWhere([2021, 2023])).toBe("survey_year>=2021 AND survey_year<=2023 AND damage_type='Mortality'");
    expect(cdfwWhere([2014, 2019])).toBe("RPT_YR>=2014 AND RPT_YR<=2019 AND DMG_TYPE1='Mortality'");
  });

  it("normalizes Forest Service rows with percent of trees as v", () => {
    const features = normalizeIds(idsFc);
    expect(features).toHaveLength(idsFc.features.length);
    expect(features[0].properties).toEqual({
      source: "USFS IDS",
      measure: "percent of trees",
      year: 2022,
      t: "2022-01-01T00:00:00.000Z",
      agent: "fir engraver",
      host: "California red fir",
      v: 20,
      percentAffected: "Moderate (11-29%)",
      acres: 11079,
    });
    expect(new Set(features.map((f) => f.properties?.year))).toEqual(new Set([2022, 2023, 2025]));
  });

  it("normalizes California rows with trees killed as v", () => {
    const features = normalizeCdfw(cdfwFc);
    expect(features).toHaveLength(cdfwFc.features.length);
    expect(features[0].properties).toMatchObject({
      source: "CDFW ADS",
      measure: "trees killed",
      year: 2015,
      t: "2015-01-01T00:00:00.000Z",
      agent: "fir engraver",
      host: "white fir",
      treesKilled: 12060,
      v: 12060,
      treesPerAcre: 3,
      forestType: "Mixed conifers, California",
    });
  });

  it("skips rows without geometry or a year and tolerates missing fields", () => {
    const fc = (properties: Record<string, unknown>, geometry: unknown = { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }) =>
      ({ type: "FeatureCollection", features: [{ type: "Feature", geometry, properties }] }) as unknown as FeatureCollection;
    expect(normalizeIds(fc({ survey_year: 2022 }, null))).toHaveLength(0);
    expect(normalizeIds(fc({ dca_common_name: "x" }))).toHaveLength(0);
    expect(normalizeCdfw(fc({ RPT_YR: 2016 }))[0].properties).toEqual({
      source: "CDFW ADS",
      measure: "trees killed",
      year: 2016,
      t: "2016-01-01T00:00:00.000Z",
      agent: "unknown agent",
    });
  });

  it("asks only the Forest Service survey by default, mortality only, biggest first, with a week of cache", async () => {
    const stub = serviceStub();
    const r = await layer.query(ctx(stub, TAHOE, "tree-mortality:k"), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const [url] = urls(stub);
    expect(urls(stub)).toHaveLength(1);
    expect(url.origin + url.pathname).toBe("https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_InsectandDiseaseSurvey_01/MapServer/1/query");
    expect(url.searchParams.get("where")).toBe("survey_year>=2021 AND survey_year<=2025 AND damage_type='Mortality'");
    expect(url.searchParams.get("orderByFields")).toBe("acres DESC");
    expect(url.searchParams.get("resultRecordCount")).toBe("1000");
    expect(url.searchParams.get("geometry")).toBe(TAHOE.join(","));
    expect((stub.mock.calls as unknown as Call[])[0][1].ttlSeconds).toBe(7 * 86_400);
    expect(r.data.features).toHaveLength(idsFc.features.length);
    expect(r.coverageNote).toBeUndefined();
    expect(r.citation.source).toMatch(/Forest Service/);
  });

  it("asks the California copy for years up to 2019", async () => {
    const stub = serviceStub();
    const r = await layer.query(ctx(stub), { years: { from: 2014, to: 2019 } });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const all = urls(stub);
    expect(all).toHaveLength(1);
    expect(all[0].origin + all[0].pathname).toBe(
      "https://services2.arcgis.com/Uq9r85Potqm3MfRV/arcgis/rest/services/biosds2783_fpu/FeatureServer/0/query",
    );
    expect(all[0].searchParams.get("where")).toBe("RPT_YR>=2014 AND RPT_YR<=2019 AND DMG_TYPE1='Mortality'");
    expect(all[0].searchParams.get("orderByFields")).toBe("NO_TREES_TOTAL DESC");
    expect(r.data.features).toHaveLength(cdfwFc.features.length);
  });

  it("queries both and warns about units and the missing 2020 when the years span them", async () => {
    const stub = serviceStub();
    const r = await layer.query(ctx(stub), { years: { from: 2018, to: 2023 } });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(urls(stub)).toHaveLength(2);
    expect(r.data.features).toHaveLength(cdfwFc.features.length + idsFc.features.length);
    expect(r.coverageNote).toMatch(/2020 was never flown/);
    expect(r.coverageNote).toMatch(/trees killed up to 2019 and percent of trees from 2021/);
  });

  it("makes no call for 2020 alone and says why", async () => {
    const stub = serviceStub();
    const r = await layer.query(ctx(stub), { years: { from: 2020, to: 2020 } });
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toMatch(/2020 was never flown/);
  });

  it("skips the California copy outside California and says so", async () => {
    const stub = serviceStub();
    const r = await layer.query(ctx(stub, [-106, 39, -105.5, 39.5]), { years: { from: 2010, to: 2019 } });
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toMatch(/California only/);
  });

  it("says which source was capped, and keeps the other when one fails", async () => {
    const capped = serviceStub({ ids: () => json({ ...idsFc, exceededTransferLimit: true }) });
    const a = await layer.query(ctx(capped), {});
    if (!("kind" in a) || a.kind !== "geojson") throw new Error("expected geojson");
    expect(a.coverageNote).toMatch(/1,000 biggest Forest Service survey/);

    const half = serviceStub({ cdfw: () => new Response("no", { status: 500 }) });
    const b = await layer.query(ctx(half), { years: { from: 2018, to: 2023 } });
    if (!("kind" in b) || b.kind !== "geojson") throw new Error("expected geojson");
    expect(b.data.features).toHaveLength(idsFc.features.length);
    expect(b.coverageNote).toMatch(/California survey .* could not be loaded/);
  });

  it("returns an upstream error when the only source fails", async () => {
    const stub = serviceStub({ ids: () => json({ error: { code: 400, message: "Unable to complete operation." } }) });
    expect(await layer.query(ctx(stub), {})).toMatchObject({ hint: "upstream" });
  });

  it("returns a coverage note without calling upstream outside the US", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub, [2, 45, 3, 46]), {});
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toBe("No data outside the United States");
  });

  it("rejects an oversized bbox through runLayer", async () => {
    expect((await runLayer("tree-mortality", { bbox: [-125, 36, -118, 42], zoom: 5 })).status).toBe(422);
  });

  it("explains the two units, the missing 2020 and the rough survey", () => {
    expect(layer.description).toMatch(/2020 was never flown/);
    expect(layer.description).toMatch(/percent of trees dead/);
    expect(layer.description).toMatch(/number of trees killed/);
    expect(layer.description).toMatch(/1,000 to 2,000 feet/);
  });
});
