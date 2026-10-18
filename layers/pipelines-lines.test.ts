import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { FRESHNESS_NOTE, normalizeLines, perServiceCap, plainCase, sourcesFor, voltageBandOf, whereFor, wideOffset } from "./pipelines-lines";
import { legendOf } from "./contract";
import { cardContent } from "@/lib/render/card";
import gas from "./__fixtures__/pipelines-lines.gas.json";
import crude from "./__fixtures__/pipelines-lines.crude.json";
import hgl from "./__fixtures__/pipelines-lines.hgl.json";
import products from "./__fixtures__/pipelines-lines.products.json";
import transmission from "./__fixtures__/pipelines-lines.transmission.json";

const fixtures = {
  Natural_Gas_Interstate_and_Intrastate_Pipelines_1: gas,
  Crude_Oil_Trunk_Pipelines_1: crude,
  Hydrocarbon_Gas_Liquids_Pipelines_1: hgl,
  Petroleum_Products_Pipelines_1: products,
  US_Electric_Power_Transmission_Lines: transmission,
} as unknown as Record<string, FeatureCollection>;

const HOUSTON: [number, number, number, number] = [-97, 29, -95, 31];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** Answers each service URL with its fixture. */
function serviceStub(overrides: Record<string, () => Response> = {}) {
  return vi.fn(async (url: string) => {
    const name = Object.keys(fixtures).find((n) => url.includes(`/${n}/`));
    if (name === undefined) throw new Error(`unexpected url ${url}`);
    return overrides[name]?.() ?? json(fixtures[name]);
  });
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string) {
  return { bbox: HOUSTON, zoom: 8, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

type Call = [string, RequestInit & { cacheKey?: string; ttlSeconds?: number }];

describe("pipelines-lines layer", () => {
  it("declares US line coverage in dark grey with no env and a network and minKv input", () => {
    expect(layer.id).toBe("pipelines-lines");
    expect(layer.coverage).toBe("us");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(150_000);
    expect(layer.hardMaxAreaKm2).toBeUndefined();
    expect(layer.wide).toEqual({ orderBy: "length, power lines by voltage", limit: 3000 });
    expect(layer.style).toEqual({ geometry: "line", color: "#3A3A3C", encode: { color: "kind" } });
    expect(layer.input.parse({})).toEqual({ network: "all", minKv: 100 });
    expect(layer.input.parse({ network: "gas", minKv: 345 })).toEqual({ network: "gas", minKv: 345 });
    expect(() => layer.input.parse({ network: "water" })).toThrow();
  });

  it("maps a network choice to the services it queries", () => {
    expect(sourcesFor("all")).toEqual(["gas", "crude", "gas-liquids", "products", "transmission"]);
    expect(sourcesFor("pipelines")).toEqual(["gas", "crude", "gas-liquids", "products"]);
    expect(sourcesFor("transmission")).toEqual(["transmission"]);
  });

  it("limits power lines by voltage and status and leaves pipelines unfiltered", () => {
    expect(whereFor("gas", 100)).toBeUndefined();
    expect(whereFor("transmission", 100)).toBe("STATUS<>'INACTIVE' AND VOLTAGE>=100");
    expect(whereFor("transmission", 0)).toBe("STATUS<>'INACTIVE'");
  });

  it("normalizes gas pipelines with operator, interstate or intrastate and status", () => {
    const features = normalizeLines(fixtures.Natural_Gas_Interstate_and_Intrastate_Pipelines_1, "gas");
    expect(features).toHaveLength(5);
    expect(features[0].properties).toEqual({
      kind: "natural gas pipeline",
      name: "Gulf Connector Expansion Project",
      operator: "Gulf Connector Expansion Project",
      pipelineType: "interstate",
      status: "operating",
    });
    for (const f of features) expect(["LineString", "MultiLineString"]).toContain(f.geometry.type);
  });

  it("normalizes oil, liquids and product pipelines by pipe name", () => {
    const oil = normalizeLines(fixtures.Crude_Oil_Trunk_Pipelines_1, "crude");
    expect(oil[0].properties).toEqual({ kind: "crude oil pipeline", name: "Gray Oak Pipeline", operator: "PHILLIPS 66 PIPELINE" });
    expect(normalizeLines(fixtures.Hydrocarbon_Gas_Liquids_Pipelines_1, "gas-liquids")[0].properties?.kind).toBe("gas liquids pipeline");
    expect(normalizeLines(fixtures.Petroleum_Products_Pipelines_1, "products")[0].properties?.kind).toBe("petroleum products pipeline");
  });

  it("normalizes power lines with voltage as v and drops placeholder owners and voltages", () => {
    const lines = normalizeLines(fixtures.US_Electric_Power_Transmission_Lines, "transmission");
    expect(lines[0].properties).toEqual({
      kind: "transmission line",
      name: "Oncor Electric Delivery Co. 345 kV line",
      owner: "Oncor Electric Delivery Co.",
      status: "in service",
      voltageKv: 345,
      v: 345,
      voltageClass: "345 kV",
      voltageBand: "345",
      lineType: "ac; overhead",
    });
    const odd = normalizeLines(
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
            properties: { OWNER: "NOT AVAILABLE", VOLTAGE: -999999, VOLT_CLASS: "NOT AVAILABLE", STATUS: "NOT AVAILABLE" },
          },
          { type: "Feature", geometry: null as never, properties: {} },
        ],
      },
      "transmission",
    );
    expect(odd).toHaveLength(1);
    expect(odd[0].properties).toEqual({ kind: "transmission line", name: "Transmission line" });
  });

  it("queries every service in parallel with the voltage floor and a week of cache, and merges the kinds", async () => {
    const stub = serviceStub();
    const r = await layer.query(ctx(stub, "pipelines-lines:k"), { network: "all", minKv: 100 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const calls = stub.mock.calls as unknown as Call[];
    expect(calls).toHaveLength(5);
    const power = new URL(calls.find((c) => c[0].includes("US_Electric_Power_Transmission_Lines"))![0]);
    expect(power.searchParams.get("where")).toBe("STATUS<>'INACTIVE' AND VOLTAGE>=100");
    expect(power.searchParams.get("orderByFields")).toBe("VOLTAGE DESC");
    expect(power.searchParams.get("resultRecordCount")).toBe("600");
    expect(power.searchParams.get("geometry")).toBe(HOUSTON.join(","));
    const gasCall = new URL(calls.find((c) => c[0].includes("Natural_Gas"))![0]);
    expect(gasCall.searchParams.get("where")).toBe("1=1");
    for (const c of calls) expect(c[1].ttlSeconds).toBe(7 * 86_400);
    expect(calls.map((c) => c[1].cacheKey).sort()).toEqual([
      "pipelines-lines:k:pl-crude",
      "pipelines-lines:k:pl-gas",
      "pipelines-lines:k:pl-gas-liquids",
      "pipelines-lines:k:pl-products",
      "pipelines-lines:k:pl-transmission",
    ]);
    const kinds = new Set(r.data.features.map((f) => f.properties?.kind));
    expect(kinds).toEqual(
      new Set(["natural gas pipeline", "crude oil pipeline", "gas liquids pipeline", "petroleum products pipeline", "transmission line"]),
    );
    expect(r.data.features).toHaveLength(5 + 3 + 3 + 3 + 5);
    expect(r.coverageNote).toBe(FRESHNESS_NOTE);
    expect(r.citation.source).toMatch(/last updated mid-2025/);
  });

  it("shares about 3,000 features between the kinds of a view and allows 1,500 for a single kind", () => {
    expect(perServiceCap(5)).toBe(600);
    expect(perServiceCap(4)).toBe(750);
    expect(perServiceCap(1)).toBe(1500);
  });

  it("queries only the chosen network", async () => {
    const stub = serviceStub();
    await layer.query(ctx(stub), { network: "crude", minKv: 100 });
    const calls = stub.mock.calls as unknown as Call[];
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0][0]).searchParams.get("resultRecordCount")).toBe("1500");
    expect(calls[0][0]).toContain("/Crude_Oil_Trunk_Pipelines_1/");
  });

  it("says which kinds were capped and which failed, and still returns the rest", async () => {
    const stub = serviceStub({
      Natural_Gas_Interstate_and_Intrastate_Pipelines_1: () => json({ ...gas, exceededTransferLimit: true }),
      Crude_Oil_Trunk_Pipelines_1: () => new Response("no", { status: 500 }),
    });
    const r = await layer.query(ctx(stub), { network: "pipelines", minKv: 100 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toMatch(/750 natural gas pipeline/);
    expect(r.coverageNote).toMatch(/crude oil pipeline could not be loaded/);
    expect(r.data.features).toHaveLength(5 + 3 + 3);
  });

  it("returns an upstream error when every service fails", async () => {
    const stub = vi.fn(async () => new Response("no", { status: 500 }));
    expect(await layer.query(ctx(stub), { network: "all", minKv: 100 })).toMatchObject({ hint: "upstream" });
  });

  it("returns a coverage note without calling upstream outside the US", async () => {
    const stub = vi.fn();
    const r = await layer.query({ bbox: [2, 45, 3, 46], zoom: 9, env: {}, fetch: stub as unknown as CachedFetch }, { network: "all", minKv: 100 });
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toBe("No data outside the United States");
  });

  it("rejects through runLayer only a box over four times the soft cap", async () => {
    const res = await runLayer("pipelines-lines", { bbox: [-110, 30, -95, 40], zoom: 5 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ hint: "zoom_in", error: expect.stringMatching(/zoom in to under 600000 km²$/) });
  });

  it("simplifies a wide box more coarsely, never finer than the plain view", () => {
    expect(wideOffset([-104, 29, -96, 35])).toBe(0.008);
    expect(wideOffset([-97, 29, -96.5, 29.5])).toBe(0.003);
  });

  it("answers a wide box ranked per service, sharing the limit, with a summed count and no trim note of its own", async () => {
    const stub = vi.fn(async (url: string) => {
      if (new URL(url).searchParams.get("returnCountOnly") === "true") return json({ count: 1000 });
      const name = Object.keys(fixtures).find((n) => url.includes(`/${n}/`)) ?? "";
      return json({ ...fixtures[name], exceededTransferLimit: true });
    });
    const r = await layer.query(
      { ...ctx(stub, "pl:k"), bbox: [-104, 29, -96, 35], wide: true, wideStrategy: layer.wide },
      { network: "all", minKv: 100 },
    );
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.total).toBe(5000);
    expect(r.coverageNote).toBe(FRESHNESS_NOTE);
    const data = (stub.mock.calls as unknown as Call[]).map((c) => new URL(c[0])).filter((u) => !u.searchParams.has("returnCountOnly"));
    expect(data).toHaveLength(5);
    for (const u of data) {
      expect(u.searchParams.get("resultRecordCount")).toBe("600");
      expect(u.searchParams.get("maxAllowableOffset")).toBe("0.008");
    }
    expect(data.find((u) => u.pathname.includes("Natural_Gas"))?.searchParams.get("orderByFields")).toBe("Shape__Length DESC");
    expect(data.find((u) => u.pathname.includes("Transmission"))?.searchParams.get("orderByFields")).toBe("VOLTAGE DESC");
  });

  it("leaves the total out of a wide result when one service could not count", async () => {
    const stub = vi.fn(async (url: string) => {
      if (new URL(url).searchParams.get("returnCountOnly") === "true") {
        return url.includes("Crude_Oil") ? new Response("no", { status: 500 }) : json({ count: 10 });
      }
      const name = Object.keys(fixtures).find((n) => url.includes(`/${n}/`)) ?? "";
      return json(fixtures[name]);
    });
    const r = await layer.query({ ...ctx(stub), bbox: [-104, 29, -96, 35], wide: true, wideStrategy: layer.wide }, { network: "pipelines", minKv: 100 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.total).toBeUndefined();
  });

  it("colors lines by kind (the primary chips) and offers power line voltage bands", () => {
    const kind = layer.attributes?.find((a) => a.key === "kind");
    expect(kind).toMatchObject({ type: "category", primary: true, encode: "color" });
    expect(kind?.levels?.map((l) => l.label).sort()).toEqual(["Crude oil", "Gas liquids", "Gas pipeline", "Petroleum products", "Power line"]);
    const band = layer.attributes?.find((a) => a.key === "voltageBand");
    expect(band?.type).toBe("ordinal");
    expect(band?.levels?.map((l) => l.label)).toEqual(["Under 100 kV", "100 to 161 kV", "230 kV", "345 kV", "500 kV and up"]);
    const legend = legendOf(layer);
    expect(legend).toMatchObject({ kind: "categories", field: "kind" });
    expect(legend.items).toHaveLength(5);
    expect(layer.time).toEqual({ shape: "none" });
    expect(layer.labels).toEqual({ field: "name", max: 5, rankBy: "v" });
    expect(layer.display).toEqual({ units: "us", timeZone: "local" });
  });

  it("bands power lines by kV, else by the source's class (Cheyenne holds 115 to 345 kV)", () => {
    expect(voltageBandOf(69, undefined)).toBe("under-100");
    expect(voltageBandOf(115, "100-161")).toBe("100-161");
    expect(voltageBandOf(230, "220-287")).toBe("230");
    expect(voltageBandOf(345, "345")).toBe("345");
    expect(voltageBandOf(500, "DC")).toBe("500+");
    expect(voltageBandOf(undefined, "220-287")).toBe("230");
    expect(voltageBandOf(undefined, "735 AND ABOVE")).toBe("500+");
    expect(voltageBandOf(undefined, "NOT AVAILABLE")).toBeUndefined();
  });

  it("puts the voltage first on a power line's card and keeps the band off it", () => {
    const line = normalizeLines(fixtures.US_Electric_Power_Transmission_Lines, "transmission")[0];
    const card = cardContent(line, { card: layer.card, fieldHelp: layer.fieldHelp });
    expect(card.measure).toMatchObject({ label: "Voltage", value: "345 kV" });
    expect([...card.facts, ...card.details].map((r) => r.key)).not.toContain("voltageBand");
  });

  it("says the data was last updated in mid-2025 and is not for digging", () => {
    expect(layer.description).toMatch(/Last updated mid-2025/);
    expect(layer.description).toMatch(/frozen copy/);
    expect(layer.description).toMatch(/must not be used to dig/);
    expect(layer.description).toMatch(/minKv/);
  });

  it("names a power line by owner, voltage and the substations it joins, so two lines of one owner read apart", () => {
    const [line] = normalizeLines(
      { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] }, properties: { OWNER: "ONCOR ELECTRIC DELIVERY CO.", VOLTAGE: 345, SUB_1: "ODESSA EHV", SUB_2: "MOSS" } }] },
      "transmission",
    );
    expect(line.properties?.name).toBe("Oncor Electric Delivery Co. 345 kV line, Odessa EHV to Moss");
    expect(plainCase("WAPA-- WESTERN AREA POWER ADMINISTRATION")).toBe("WAPA Western Area Power Administration");
  });
});
