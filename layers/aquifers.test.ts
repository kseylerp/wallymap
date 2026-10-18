import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { ESRI_COPY, NEVADA_COPY, OGALLALA_NOTE, ROCK_LEVELS, normalizeAquifers, offsetFor } from "./aquifers";
import { contractProblems, legendOf } from "./contract";
import { cardContent } from "@/lib/render/card";
import nebraskaRaw from "./__fixtures__/aquifers.esri-nebraska.json";
import nevadaRaw from "./__fixtures__/aquifers.nv-basin-range.json";

/** Live answers recorded 2026-10-10: the Esri copy for a Nebraska box, the Nevada copy for the six biggest polygons of a Nevada-Utah box. */
const nebraska = nebraskaRaw as unknown as FeatureCollection;
const nevada = nevadaRaw as unknown as FeatureCollection;
const NEBRASKA: [number, number, number, number] = [-102, 40, -98, 42];
const NEVADA: [number, number, number, number] = [-120, 38, -114, 41];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function ctx(stub: ReturnType<typeof vi.fn>, bbox: [number, number, number, number], cacheKey?: string) {
  return { bbox, zoom: 7, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

function geojson(r: Awaited<ReturnType<typeof layer.query>>) {
  if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
  return r;
}

describe("normalizeAquifers", () => {
  it("names the High Plains aquifer Ogallala and spells out the rock type", () => {
    const fc = normalizeAquifers(nebraska);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toEqual({
      name: "High Plains Aquifer",
      kind: "Unconsolidated sand and gravel",
      rockType: 100,
      aquiferCode: 107,
      alias: "Ogallala",
      ogallala: true,
      waterLevels: OGALLALA_NOTE,
    });
  });

  it("leaves the USGS aquifer code off the card (an identifier, not a fact)", () => {
    const [ogallala] = normalizeAquifers(nebraska).features;
    const card = cardContent(ogallala, { card: layer.card, fieldHelp: layer.fieldHelp });
    const keys = [...card.facts, ...card.details].map((r) => r.key);
    expect(keys).not.toContain("aquiferCode");
    expect(card.facts.map((r) => r.label)).toEqual(["Rock type", "Also called", "Water levels"]);
  });

  it("fills aquifers by rock type with a matching legend and offers the Ogallala as one chip", () => {
    const legend = legendOf(layer);
    expect(legend).toMatchObject({ kind: "categories", field: "rockType" });
    expect(legend.items?.map((i) => i.value)).toEqual([100, 200, 300, 400, 500, 600]);
    expect(new Set(ROCK_LEVELS.map((r) => r.color)).size).toBe(6);
    expect(layer.attributes?.find((a) => a.key === "ogallala")).toMatchObject({ type: "flag" });
    expect(OGALLALA_NOTE).toMatch(/groundwater layer/);
    expect(contractProblems(layer)).toEqual([]);
  });

  it("reads the Nevada copy the same way, with its sentence-case names", () => {
    const fc = normalizeAquifers(nevada);
    expect(fc.features).toHaveLength(6);
    expect(fc.features[2].properties).toMatchObject({ name: "Basin and Range carbonate-rock aquifers", kind: "Carbonate rock", rockType: 400 });
    expect(fc.features.some((f) => "alias" in (f.properties ?? {}))).toBe(false);
  });

  it("drops the blank 'Other rocks' class and rows without geometry", () => {
    const polygon = { type: "Polygon" as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
    const fc = normalizeAquifers({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: polygon, properties: { AQ_NAME: "Other rocks", ROCK_TYPE: 999, ROCK_NAME: " " } },
        { type: "Feature", geometry: null as never, properties: { AQ_NAME: "Ghost", ROCK_TYPE: 100 } },
        { type: "Feature", geometry: polygon, properties: { ROCK_NAME: "Odd rock" } },
      ],
    });
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toEqual({ name: "Unnamed aquifer", kind: "Odd rock" });
  });
});

describe("offsetFor", () => {
  it("is about 1/400 of the view width, between 0.002 and 0.2 degrees", () => {
    expect(offsetFor(NEBRASKA)).toBe(0.01);
    expect(offsetFor([-100, 40, -99.9, 40.1])).toBe(0.002);
    expect(offsetFor([-125, 24, -66, 50])).toBe(0.1475);
    expect(offsetFor([-179, 0, 179, 10])).toBe(0.2);
  });
});

describe("aquifers layer", () => {
  it("declares US coverage, a license that names the third-party copies, no env and no input", () => {
    expect(layer.id).toBe("aquifers");
    expect(layer.coverage).toBe("us");
    expect(layer.license).toMatch(/third-party copies/);
    expect(layer.license).toMatch(/Nevada/);
    expect(layer.license).toMatch(/Esri/);
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.input.parse({})).toEqual({});
    expect(layer.maxAreaKm2).toBe(6_000_000);
    expect(layer.hardMaxAreaKm2).toBeUndefined();
    expect(layer.wide).toEqual({ orderBy: "area", limit: 1000 });
    expect(layer.style).toMatchObject({ geometry: "polygon", color: "#9FB693" });
  });

  it("reads the Esri copy for a view east of the Nevada copy (the Ogallala)", async () => {
    const stub = vi.fn(async () => json(nebraska));
    const r = geojson(await layer.query(ctx(stub, NEBRASKA, "aquifers:k"), {}));
    expect(r.data.features[0].properties).toMatchObject({ name: "High Plains Aquifer", alias: "Ogallala" });
    expect(r.coverageNote).toBeUndefined();
    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit & { cacheKey?: string; ttlSeconds?: number }];
    expect(url.startsWith(`${ESRI_COPY}/query?`)).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get("where")).toBe("ROCK_TYPE <> 999");
    expect(params.get("orderByFields")).toBe("Shape__Area DESC");
    expect(params.get("maxAllowableOffset")).toBe("0.01");
    expect(init.ttlSeconds).toBe(7 * 86_400);
    expect(init.cacheKey).toBe("aquifers:k:aquifers:esri");
  });

  it("reads the Nevada copy for a western view", async () => {
    const stub = vi.fn(async () => json(nevada));
    const r = geojson(await layer.query(ctx(stub, NEVADA, "aquifers:k"), {}));
    expect(r.data.features).toHaveLength(6);
    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit & { cacheKey?: string }];
    expect(url.startsWith(`${NEVADA_COPY}/query?`)).toBe(true);
    expect(init.cacheKey).toBe("aquifers:k:aquifers:nv");
  });

  it("falls back to the Esri copy when the Nevada server fails", async () => {
    const stub = vi.fn(async (url: string) => (url.startsWith(NEVADA_COPY) ? new Response("down", { status: 503 }) : json(nevada)));
    const r = geojson(await layer.query(ctx(stub, NEVADA), {}));
    expect(r.data.features).toHaveLength(6);
    expect(stub).toHaveBeenCalledTimes(2);
    expect(String(stub.mock.calls[1][0]).startsWith(ESRI_COPY)).toBe(true);
  });

  it("reports an upstream error when the Esri copy fails too, and notes empty and capped results", async () => {
    expect(await layer.query(ctx(vi.fn(async () => new Response("x", { status: 500 })), NEBRASKA), {})).toEqual({
      error: "ArcGIS service returned 500",
      hint: "upstream",
    });
    const empty = vi.fn(async () => json({ type: "FeatureCollection", features: [] }));
    expect(geojson(await layer.query(ctx(empty, [-90, 44, -89, 45]), {})).coverageNote).toMatch(/glacial aquifers/);
    const capped = vi.fn(async () => json({ ...nebraska, properties: { exceededTransferLimit: true } }));
    expect(geojson(await layer.query(ctx(capped, NEBRASKA), {})).coverageNote).toBe("Showing the 2,000 largest aquifer polygons; zoom in for the rest");
  });

  it("returns nothing outside the US without calling out, and rejects through runLayer only a box over four times the soft cap", async () => {
    const stub = vi.fn();
    expect(geojson(await layer.query(ctx(stub, [5, 45, 6, 46]), {})).coverageNote).toBe("No data outside the United States");
    expect(stub).not.toHaveBeenCalled();
    const res = await runLayer("aquifers", { bbox: [-170, 0, 10, 80] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ hint: "zoom_in", error: expect.stringMatching(/zoom in to under 24000000 km²$/) });
  });

  it("answers the lower 48 wide from the Esri copy: largest first, 1,000 at most, and a count", async () => {
    const stub = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return url.searchParams.get("returnCountOnly") === "true" ? json({ count: 2950 }) : json({ ...nebraska, exceededTransferLimit: true });
    });
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("aquifers", { bbox: [-125, 24, -66, 50], zoom: 4 });
      expect(res.status).toBe(200);
      const data = stub.mock.calls.map((c) => String(c[0])).find((u) => !u.includes("returnCountOnly"));
      expect(data?.startsWith(ESRI_COPY)).toBe(true);
      const params = new URL(data ?? "").searchParams;
      expect(params.get("orderByFields")).toBe("Shape__Area DESC");
      expect(params.get("resultRecordCount")).toBe("1000");
      expect(params.get("maxAllowableOffset")).toBe("0.295");
      expect(res.body).toMatchObject({
        total: 2950,
        truncated: true,
        coverageNote: `Showing the ${nebraska.features.length} largest of 2,950 (ranked by area); zoom in under 6,000,000 km² for all`,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("describes the aquifer in the words people use and points to groundwater for wells", () => {
    expect(layer.description).toMatch(/Ogallala/);
    expect(layer.description).toMatch(/groundwater/);
    expect(layer.description).toMatch(/glacial/);
  });
});
