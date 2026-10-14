import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { cdfwWhere, idsWhere, normalizeCdfw, normalizeIds, offsetFor, planYears, surveyYears } from "./tree-mortality";
import ids from "./__fixtures__/tree-mortality.ids-tahoe.json";
import cdfw from "./__fixtures__/tree-mortality.cdfw-tahoe.json";

const idsFc = ids as unknown as FeatureCollection;
const cdfwFc = cdfw as unknown as FeatureCollection;

const TAHOE: [number, number, number, number] = [-120.5, 38.9, -120, 39.3];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** Rows of a fixture whose year falls inside the survey_year / RPT_YR range of the request's where clause. */
function inRange(fc: FeatureCollection, url: string, field: "survey_year" | "RPT_YR"): FeatureCollection {
  const where = new URL(url).searchParams.get("where") ?? "";
  const m = new RegExp(`${field}>=(\\d+) AND ${field}<=(\\d+)`).exec(where);
  if (m === null) return fc;
  return { ...fc, features: fc.features.filter((f) => (f.properties?.[field] as number) >= Number(m[1]) && (f.properties?.[field] as number) <= Number(m[2])) };
}

/** Answers the Forest Service URL with its fixture and the California URL with its fixture, each cut to the requested years. */
function serviceStub(overrides: { ids?: () => Response; cdfw?: () => Response } = {}) {
  return vi.fn(async (url: string) => {
    if (url.includes("EDW_InsectandDiseaseSurvey_01")) return overrides.ids?.() ?? json(inRange(idsFc, url, "survey_year"));
    if (url.includes("biosds2783_fpu")) return overrides.cdfw?.() ?? json(inRange(cdfwFc, url, "RPT_YR"));
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
    expect(layer.hardMaxAreaKm2).toBeUndefined();
    expect(layer.wide).toEqual({ orderBy: "trees killed, or percent dead from 2021", limit: 2000, rank: "worst" });
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

  it("asks only the Forest Service survey by default, one request per survey year, mortality only, biggest first", async () => {
    const stub = serviceStub();
    const r = await layer.query(ctx(stub, TAHOE, "tree-mortality:k"), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const all = urls(stub);
    expect(all).toHaveLength(5);
    expect(all.map((u) => u.searchParams.get("where")).sort()).toEqual(
      [2021, 2022, 2023, 2024, 2025].map((y) => `survey_year>=${y} AND survey_year<=${y} AND damage_type='Mortality'`),
    );
    for (const url of all) {
      expect(url.origin + url.pathname).toBe("https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_InsectandDiseaseSurvey_01/MapServer/1/query");
      expect(url.searchParams.get("orderByFields")).toBe("acres DESC");
      expect(url.searchParams.get("resultRecordCount")).toBe("300");
      expect(url.searchParams.get("geometry")).toBe(TAHOE.join(","));
    }
    for (const c of stub.mock.calls as unknown as Call[]) expect(c[1].ttlSeconds).toBe(7 * 86_400);
    expect((stub.mock.calls as unknown as Call[]).map((c) => c[1].cacheKey).sort()[0]).toBe("tree-mortality:k:ids-2021-2021");
    expect(r.data.features).toHaveLength(idsFc.features.length);
    expect(r.coverageNote).toBeUndefined();
    expect(r.citation.source).toMatch(/Forest Service/);
  });

  it("asks the California copy once per year for years up to 2019", async () => {
    const stub = serviceStub();
    const r = await layer.query(ctx(stub), { years: { from: 2014, to: 2019 } });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const all = urls(stub);
    expect(all).toHaveLength(6);
    expect(all[0].origin + all[0].pathname).toBe(
      "https://services2.arcgis.com/Uq9r85Potqm3MfRV/arcgis/rest/services/biosds2783_fpu/FeatureServer/0/query",
    );
    expect(all.map((u) => u.searchParams.get("where")).sort()[0]).toBe("RPT_YR>=2014 AND RPT_YR<=2014 AND DMG_TYPE1='Mortality'");
    expect(all[0].searchParams.get("orderByFields")).toBe("NO_TREES_TOTAL DESC");
    expect(all[0].searchParams.get("resultRecordCount")).toBe("300");
    expect(r.data.features).toHaveLength(cdfwFc.features.length);
  });

  it("falls back to one request of 1,000 for a range longer than ten survey years", async () => {
    const stub = serviceStub();
    await layer.query(ctx(stub), { years: { from: 2005, to: 2019 } });
    const all = urls(stub);
    expect(all).toHaveLength(1);
    expect(all[0].searchParams.get("where")).toBe("RPT_YR>=2005 AND RPT_YR<=2019 AND DMG_TYPE1='Mortality'");
    expect(all[0].searchParams.get("resultRecordCount")).toBe("1000");
  });

  it("lists the flown years of a range, leaving out 2020", () => {
    expect(surveyYears([2018, 2022])).toEqual([2018, 2019, 2021, 2022]);
    expect(surveyYears([2020, 2020])).toEqual([]);
  });

  it("queries both and warns about units and the missing 2020 when the years span them", async () => {
    const stub = serviceStub();
    const r = await layer.query(ctx(stub), { years: { from: 2018, to: 2023 } });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    // California 2018 and 2019, Forest Service 2021, 2022 and 2023
    expect(urls(stub)).toHaveLength(5);
    const years = new Set(r.data.features.map((f) => f.properties?.year));
    expect([...years].every((y) => (y as number) >= 2018 && (y as number) <= 2023)).toBe(true);
    expect(r.data.features.some((f) => f.properties?.source === "USFS IDS")).toBe(true);
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

  it("names the years that were capped, and keeps the rest when some years fail", async () => {
    const capped = serviceStub({ ids: () => json({ ...idsFc, features: [], exceededTransferLimit: true }) });
    const a = await layer.query(ctx(capped), { years: { from: 2024, to: 2025 } });
    if (!("kind" in a) || a.kind !== "geojson") throw new Error("expected geojson");
    expect(a.coverageNote).toMatch(/300 biggest Forest Service survey .* polygons for 2024 and 2025/);

    const half = serviceStub({ cdfw: () => new Response("no", { status: 500 }) });
    const b = await layer.query(ctx(half), { years: { from: 2018, to: 2023 } });
    if (!("kind" in b) || b.kind !== "geojson") throw new Error("expected geojson");
    expect(b.data.features.every((f) => f.properties?.source === "USFS IDS")).toBe(true);
    expect(b.data.features.length).toBeGreaterThan(0);
    expect(b.coverageNote).toMatch(/California survey .* could not be loaded for 2018 and 2019/);
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

  it("rejects through runLayer only a box over four times the soft cap", async () => {
    const res = await runLayer("tree-mortality", { bbox: [-125, 36, -118, 42], zoom: 5 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ hint: "zoom_in", error: expect.stringMatching(/zoom in to under 80000 km²$/) });
  });

  it("simplifies a wide box more coarsely, within bounds", () => {
    expect(offsetFor(TAHOE)).toBe(0.002);
    expect(offsetFor([-121.5, 38.5, -119.5, 40], true)).toBe(0.004);
    expect(offsetFor([-125, 36, -118, 42], true)).toBe(0.01);
  });

  it("answers a wide box worst first: one request over the whole range, ordered by v, with a count", async () => {
    const stub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (new URL(url).searchParams.get("returnCountOnly") === "true") return json({ count: 700 });
      return json({ ...inRange(idsFc, url, "survey_year"), exceededTransferLimit: true });
    });
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("tree-mortality", { bbox: [-121.5, 38.5, -119.5, 40], zoom: 7 });
      expect(res.status).toBe(200);
      const data = stub.mock.calls.map((c) => new URL(String(c[0]))).filter((u) => !u.searchParams.has("returnCountOnly"));
      expect(data).toHaveLength(1);
      expect(data[0].searchParams.get("where")).toBe("survey_year>=2021 AND survey_year<=2025 AND damage_type='Mortality'");
      expect(data[0].searchParams.get("orderByFields")).toBe("percent_mid DESC, acres DESC");
      expect(data[0].searchParams.get("resultRecordCount")).toBe("2000");
      expect(data[0].searchParams.get("maxAllowableOffset")).toBe("0.004");
      expect(res.body).toMatchObject({
        total: 700,
        truncated: true,
        coverageNote: `Showing the ${idsFc.features.length} worst of 700 (ranked by trees killed, or percent dead from 2021); zoom in under 20,000 km² for all`,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("orders the California copy by trees killed in wide mode and shares the limit across both sources", async () => {
    const stub = vi.fn(async (url: string) => {
      if (new URL(url).searchParams.get("returnCountOnly") === "true") return json({ count: 10 });
      return url.includes("biosds2783_fpu") ? json(inRange(cdfwFc, url, "RPT_YR")) : json(inRange(idsFc, url, "survey_year"));
    });
    const r = await layer.query(
      { ...ctx(stub, [-121.5, 38.5, -119.5, 40]), wide: true, wideStrategy: layer.wide },
      { years: { from: 2016, to: 2022 } },
    );
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const data = urls(stub).filter((u) => !u.searchParams.has("returnCountOnly"));
    expect(data).toHaveLength(2);
    expect(data.find((u) => u.pathname.includes("biosds2783_fpu"))?.searchParams.get("orderByFields")).toBe("NO_TREES_TOTAL DESC");
    expect(data.every((u) => u.searchParams.get("resultRecordCount") === "1000")).toBe(true);
    expect(r.total).toBe(20);
    expect(r.coverageNote).not.toMatch(/Showing the/);
  });

  it("says each year is fetched separately with a cap per year", () => {
    expect(layer.description).toMatch(/Each survey year is fetched separately/);
    expect(layer.description).toMatch(/300 polygons per year/);
  });

  it("explains the two units, the missing 2020 and the rough survey", () => {
    expect(layer.description).toMatch(/2020 was never flown/);
    expect(layer.description).toMatch(/percent of trees dead/);
    expect(layer.description).toMatch(/number of trees killed/);
    expect(layer.description).toMatch(/1,000 to 2,000 feet/);
  });
});
