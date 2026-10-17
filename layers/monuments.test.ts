import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { CURRENT_URL, HISTORIC_URL, areaKm2, baseName, normalizeCurrent, normalizeHistoric, offsetFor } from "./monuments";
import currentRaw from "./__fixtures__/monuments.current.json";
import historicRaw from "./__fixtures__/monuments.historic.json";

/** Live answers recorded 2026-10-10 for this box: BLM's current layer (5 polygons) and the Utah AGRC 2021 monuments (3 polygons). */
const current = currentRaw as unknown as FeatureCollection;
const historic = historicRaw as unknown as FeatureCollection;
const UTAH: [number, number, number, number] = [-112, 36.5, -108.5, 38.5];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Answers each service with its own recording. */
function upstream(overrides: { current?: () => Response; historic?: () => Response } = {}) {
  return vi.fn(async (url: string) => {
    if (url.startsWith(CURRENT_URL)) return overrides.current ? overrides.current() : json(current);
    if (url.startsWith(HISTORIC_URL)) return overrides.historic ? overrides.historic() : json(historic);
    return new Response("not found", { status: 404 });
  });
}

function ctx(stub: ReturnType<typeof vi.fn>, bbox = UTAH, cacheKey?: string) {
  return { bbox, zoom: 8, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

function geojson(r: Awaited<ReturnType<typeof layer.query>>) {
  if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
  return r;
}

describe("names, areas and offsets", () => {
  it("drops the designation words from names and fixes the Escalante hyphen", () => {
    expect(baseName("Bears Ears National Monument")).toBe("Bears Ears");
    expect(baseName("Grand Staircase Escalante National Monument")).toBe("Grand Staircase-Escalante");
    expect(baseName("Red Cliffs NCA")).toBe("Red Cliffs");
    expect(baseName("Carrizo Plain")).toBe("Carrizo Plain");
  });

  it("measures a polygon with a hole in square kilometres", () => {
    const square = (w: number, s: number, e: number, n: number) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
    // 0.1 x 0.1 degrees at 40N is about 8.5 x 11.1 km; the hole is a quarter of that.
    const full = areaKm2({ type: "Polygon", coordinates: [square(-100, 40, -99.9, 40.1)] });
    expect(full).toBeGreaterThan(90);
    expect(full).toBeLessThan(99);
    const holed = areaKm2({ type: "Polygon", coordinates: [square(-100, 40, -99.9, 40.1), square(-99.97, 40.03, -99.93, 40.07)] });
    expect(holed).toBeLessThan(full);
    expect(areaKm2(null)).toBe(0);
    expect(areaKm2({ type: "Point", coordinates: [0, 0] })).toBe(0);
  });

  it("simplifies by about 1/500 of the view width, within bounds", () => {
    expect(offsetFor(UTAH)).toBe(0.007);
    expect(offsetFor([-100, 40, -99.99, 40.01])).toBe(0.0005);
    expect(offsetFor([-125, 24, -66, 50])).toBe(0.02);
    expect(offsetFor([-170, 18, -60, 72], true)).toBe(0.05);
  });
});

describe("normalizers", () => {
  it("gives the current Bears Ears and Grand Staircase-Escalante far smaller areas than the 2021 outlines", () => {
    const now = normalizeCurrent(current);
    const then = normalizeHistoric(historic);
    const area = (list: typeof now, name: string) => list.filter((f) => f.properties?.name === name).map((f) => Number(f.properties?.v));
    const bearsNow = area(now, "Bears Ears");
    const bearsThen = area(then, "Bears Ears");
    expect(bearsNow).toHaveLength(1);
    expect(bearsNow[0]).toBeGreaterThan(400);
    expect(bearsNow[0]).toBeLessThan(600);
    expect(Math.max(...bearsThen)).toBeGreaterThan(5_000);
    expect(area(now, "Grand Staircase-Escalante")[0]).toBeLessThan(900);
    expect(area(then, "Grand Staircase-Escalante")[0]).toBeGreaterThan(7_000);
  });

  it("labels current rows with kind, source, state, and a designation where one can be read", () => {
    const now = normalizeCurrent(current);
    expect(now).toHaveLength(5);
    const canyons = now.find((f) => f.properties?.name === "Canyons of the Ancients");
    expect(canyons?.properties).toMatchObject({
      kind: "current",
      designation: "National Monument",
      state: "CO",
      source: "BLM National Conservation Lands",
    });
    expect(canyons?.properties?.areaKm2).toBe(canyons?.properties?.v);
    const bears = now.find((f) => f.properties?.name === "Bears Ears");
    expect(bears?.properties).not.toHaveProperty("designation");
  });

  it("labels 2021 rows as National Monuments of kind '2021' and skips conservation areas and rows without geometry", () => {
    const then = normalizeHistoric(historic);
    expect(then).toHaveLength(3);
    expect(then.every((f) => f.properties?.kind === "2021" && f.properties?.designation === "National Monument")).toBe(true);
    const polygon = { type: "Polygon" as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
    const mixed = normalizeHistoric({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: polygon, properties: { NAME: "Red Cliffs NCA", NLCS_TYPE: "National Conservation Area" } },
        { type: "Feature", geometry: null as never, properties: { NAME: "Ghost National Monument", NLCS_TYPE: "National Monument" } },
        { type: "Feature", geometry: polygon, properties: { NLCS_TYPE: "National Monument" } },
      ],
    });
    expect(mixed).toEqual([]);
  });
});

describe("monuments layer", () => {
  it("declares US coverage, a public-domain license, no env and a version input", () => {
    expect(layer.id).toBe("monuments");
    expect(layer.coverage).toBe("us");
    expect(layer.license).toContain("Public domain");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(20_000_000);
    expect(layer.hardMaxAreaKm2).toBeUndefined();
    expect(layer.wide).toEqual({ orderBy: "area", limit: 1000 });
    expect(layer.input.parse({})).toEqual({ version: "both" });
    expect(layer.input.safeParse({ version: "2021" }).success).toBe(true);
    expect(layer.input.safeParse({ version: "2019" }).success).toBe(false);
    expect(layer.style).toMatchObject({ geometry: "polygon", color: "#9FB693" });
  });

  it("returns both versions, 2021 first and biggest first, and says what the kinds mean", async () => {
    const stub = upstream();
    const r = geojson(await layer.query(ctx(stub, UTAH, "monuments:k"), { version: "both" }));
    expect(r.data.features).toHaveLength(8);
    const kinds = r.data.features.map((f) => f.properties?.kind);
    expect(kinds).toEqual(["2021", "2021", "2021", "current", "current", "current", "current", "current"]);
    expect(r.data.features[0].properties).toMatchObject({ name: "Grand Staircase-Escalante", kind: "2021" });
    expect(r.coverageNote).toBe("Two outlines: the 2021 boundary of the Utah monuments and the current BLM boundary");

    const calls = stub.mock.calls as unknown as [string, { cacheKey?: string; ttlSeconds?: number }][];
    expect(calls).toHaveLength(2);
    const historicCall = calls.find((c) => c[0].startsWith(HISTORIC_URL));
    expect(new URL(historicCall?.[0] ?? "").searchParams.get("where")).toBe("NLCS_TYPE = 'National Monument'");
    expect(new URL(historicCall?.[0] ?? "").searchParams.get("maxAllowableOffset")).toBe("0.007");
    expect(historicCall?.[1].cacheKey).toBe("monuments:k:monuments:2021");
    expect(calls.find((c) => c[0].startsWith(CURRENT_URL))?.[1].cacheKey).toBe("monuments:k:monuments:current");
    expect(calls.every((c) => c[1].ttlSeconds === 86_400)).toBe(true);
  });

  it("asks only the service for the version wanted", async () => {
    const onlyNow = upstream();
    const now = geojson(await layer.query(ctx(onlyNow), { version: "current" }));
    expect(now.data.features.every((f) => f.properties?.kind === "current")).toBe(true);
    expect(onlyNow).toHaveBeenCalledTimes(1);
    expect(now.coverageNote).toBeUndefined();

    const onlyThen = upstream();
    const then = geojson(await layer.query(ctx(onlyThen), { version: "2021" }));
    expect(then.data.features).toHaveLength(3);
    expect(String(onlyThen.mock.calls[0][0]).startsWith(HISTORIC_URL)).toBe(true);
  });

  it("keeps the version that loaded and notes the one that did not, and errors when none loads", async () => {
    const partial = geojson(await layer.query(ctx(upstream({ historic: () => json({}, 500) })), { version: "both" }));
    expect(partial.data.features).toHaveLength(5);
    expect(partial.coverageNote).toBe("Missing the 2021 boundaries (ArcGIS service returned 500)");

    const down = upstream({ current: () => json({}, 503), historic: () => json({ error: { code: 500, message: "boom" } }) });
    expect(await layer.query(ctx(down), { version: "both" })).toEqual({
      error: "Monument boundaries unavailable: current boundaries (ArcGIS service returned 503); 2021 boundaries (ArcGIS service error: boom)",
      hint: "upstream",
    });
  });

  it("says so when nothing is in the area", async () => {
    const empty = upstream({
      current: () => json({ type: "FeatureCollection", features: [] }),
      historic: () => json({ type: "FeatureCollection", features: [] }),
    });
    expect(geojson(await layer.query(ctx(empty, [-90, 44, -89, 45]), { version: "both" })).coverageNote).toBe(
      "No BLM national monuments or conservation areas in this area",
    );
  });

  it("answers a box wider than 20 million km² largest first, counting both services", async () => {
    const stub = vi.fn(async (url: string) => {
      if (new URL(url).searchParams.get("returnCountOnly") === "true") return json({ count: url.startsWith(CURRENT_URL) ? 57 : 3 });
      return url.startsWith(CURRENT_URL) ? json(current) : json(historic);
    });
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("monuments", { bbox: [-170, 18, -60, 72], zoom: 2 });
      expect(res.status).toBe(200);
      const data = stub.mock.calls.map((c) => String(c[0])).filter((u) => !u.includes("returnCountOnly"));
      const cur = new URL(data.find((u) => u.startsWith(CURRENT_URL)) ?? "");
      const old = new URL(data.find((u) => u.startsWith(HISTORIC_URL)) ?? "");
      expect(cur.searchParams.get("orderByFields")).toBe("Shape.STArea() DESC");
      expect(old.searchParams.get("orderByFields")).toBe("Shape__Area DESC");
      expect(cur.searchParams.get("resultRecordCount")).toBe("1000");
      expect(cur.searchParams.get("maxAllowableOffset")).toBe("0.05");
      expect(res.body).toMatchObject({ total: 60, truncated: true });
      expect((res.body as { coverageNote?: string }).coverageNote).toMatch(/^Showing the 8 largest of 60 \(ranked by area\)/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("is registered, validates version and rejects an oversized area through runLayer", async () => {
    expect((await runLayer("monuments", { bbox: UTAH, input: { version: "later" } })).status).toBe(400);
    expect((await runLayer("monuments", { bbox: [-180, -80, 180, 80] })).status).toBe(422);
  });

  it("explains the July 2026 changes and how to compare", () => {
    expect(layer.description).toMatch(/July 2026/);
    expect(layer.description).toMatch(/Bears Ears/);
    expect(layer.description).toMatch(/compare/);
    expect(layer.description).toMatch(/2021/);
  });
});
