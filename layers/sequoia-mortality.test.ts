import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import type { Feature } from "geojson";
import { attributeProblems } from "./attributes";
import { cardTitle, contractProblems, legendOf, timeShapeOf } from "./contract";
import layer, { FILE_TIMEOUT_MS, parseCsv, parseStems, survivalNote, utm11ToLonLat } from "./sequoia-mortality";

const CSV = readFileSync(path.join(__dirname, "__fixtures__/sequoia-mortality.stems.csv"), "utf8");

const SEKI: [number, number, number, number] = [-119, 35.8, -118.3, 36.8];

function text(body: string): Response {
  return new Response(body, { status: 200 });
}

function ctx(stub: ReturnType<typeof vi.fn>, bbox = SEKI, cacheKey?: string) {
  return { bbox, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

/** Snyder's forward transverse Mercator (USGS PP 1395, eqs. 8-9 to 8-13) for UTM zone 11 north, to round-trip against. */
function forward(lon: number, lat: number): [number, number] {
  const a = 6378137;
  const f = 1 / 298.257222101;
  const e2 = 2 * f - f * f;
  const ep2 = e2 / (1 - e2);
  const k0 = 0.9996;
  const phi = (lat * Math.PI) / 180;
  const dl = ((lon + 117) * Math.PI) / 180;
  const n = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const t = Math.tan(phi) ** 2;
  const c = ep2 * Math.cos(phi) ** 2;
  const aa = dl * Math.cos(phi);
  const m =
    a *
    ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi -
      ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
  const x = k0 * n * (aa + ((1 - t + c) * aa ** 3) / 6 + ((5 - 18 * t + t ** 2 + 72 * c - 58 * ep2) * aa ** 5) / 120) + 500000;
  const y =
    k0 *
    (m +
      n * Math.tan(phi) * (aa ** 2 / 2 + ((5 - t + 9 * c + 4 * c ** 2) * aa ** 4) / 24 + ((61 - 58 * t + t ** 2 + 600 * c - 330 * ep2) * aa ** 6) / 720));
  return [x, y];
}

describe("utm11ToLonLat", () => {
  it("puts the central meridian at -117 and the equator at 0", () => {
    const [lon, lat] = utm11ToLonLat(500_000, 0);
    expect(lon).toBeCloseTo(-117, 9);
    expect(lat).toBeCloseTo(0, 9);
  });

  it("round-trips points across the sequoia range to within a centimetre", () => {
    for (const [lon, lat] of [[-118.78, 36.56], [-118.6, 36.25], [-118.9, 35.9], [-118.45, 36.75], [-120.3, 38.27]]) {
      const [e, n] = forward(lon, lat);
      const [lon2, lat2] = utm11ToLonLat(e, n);
      expect(Math.abs(lon2 - lon) * 111_320 * Math.cos((lat * Math.PI) / 180)).toBeLessThan(0.01);
      expect(Math.abs(lat2 - lat) * 110_570).toBeLessThan(0.01);
    }
  });

  it("places a survey point from the file in Garfield Grove", () => {
    const [lon, lat] = utm11ToLonLat(346046.2968, 4021017.975);
    // Garfield Grove's outline spans -118.7505 to -118.6958 and 36.3144 to 36.3499 (sequoia-groves service).
    expect(lon).toBeGreaterThan(-118.7505);
    expect(lon).toBeLessThan(-118.6958);
    expect(lat).toBeGreaterThan(36.3144);
    expect(lat).toBeLessThan(36.3499);
  });
});

describe("parseCsv", () => {
  it("handles quotes, doubled quotes, CRLF and blank lines", () => {
    expect(parseCsv('a,b\r\n"x,1","he said ""hi"""\n\nz,\n')).toEqual([["a", "b"], ["x,1", 'he said "hi"'], ["z", ""]]);
  });
});

describe("parseStems", () => {
  it("makes live and dead points with fire, grove and crown condition, and drops trees not found", () => {
    const { features, notFound } = parseStems(CSV);
    expect(notFound).toBe(4);
    expect(features).toHaveLength(29 - 4);
    const kinds = new Set(features.map((f) => f.properties?.kind));
    expect(kinds).toEqual(new Set(["live", "dead"]));
    for (const f of features) {
      expect(f.properties?.status).toBe(f.properties?.kind);
      expect(["Castle Fire", "KNP Complex Fire"]).toContain(f.properties?.fire);
      const [lon, lat] = f.geometry.coordinates;
      expect(lon).toBeGreaterThan(-119);
      expect(lon).toBeLessThan(-118.3);
      expect(lat).toBeGreaterThan(35.8);
      expect(lat).toBeLessThan(36.8);
    }
    const garfield = features.find((f) => f.properties?.grove === "Garfield" && f.properties?.fire === "Castle Fire");
    expect(garfield?.properties).toMatchObject({ t: "2020-08-19T00:00:00.000Z" });
    const knp = features.find((f) => f.properties?.fire === "KNP Complex Fire");
    expect(knp?.properties?.t).toBe("2021-09-09T00:00:00.000Z");
  });

  it("keeps crown percentages and the observation date, and omits NA values, a zero diameter and the NA grove", () => {
    const csv = [
      "TREE_ID,Grove,UTM_E,UTM_N,Last_Known_Status,Crown_Live_Percent,Crown_Scorch_Percent,Crown_Torch_Percent,Observation_Date,Diameter,Fire_name",
      "A,Redwood Mountain,330663.5992,4062396.652,Dead,NA,NA,NA,8/6/2024,0,KNP",
      "B,NA,346046.2968,4021017.975,Alive,80,15,5,7/6/2023,91.44,Castle",
    ].join("\n");
    const { features } = parseStems(csv);
    expect(features[0].properties).not.toHaveProperty("crownLivePercent");
    expect(features[0].properties).not.toHaveProperty("diameterCm");
    expect(features[0].properties).toMatchObject({ observed: "2024-08-06", grove: "Redwood Mountain" });
    expect(features[1].properties).toMatchObject({ crownLivePercent: 80, crownScorchPercent: 15, crownTorchPercent: 5, diameterCm: 91, observed: "2023-07-06" });
    expect(features[1].properties).not.toHaveProperty("grove");
  });

  it("filters to the bbox and counts only missing trees inside it", () => {
    const small = parseStems(CSV, [-118.8, 36.3, -118.6, 36.4]);
    const all = parseStems(CSV);
    expect(small.features.length).toBeGreaterThan(0);
    expect(small.features.length).toBeLessThan(all.features.length);
    expect(small.notFound).toBeLessThanOrEqual(all.notFound);
  });

  it("returns nothing for an empty or header-only file", () => {
    expect(parseStems("").features).toHaveLength(0);
    expect(parseStems("TREE_ID,Grove,UTM_E,UTM_N,Last_Known_Status\n").features).toHaveLength(0);
  });
});

describe("sequoia-mortality layer", () => {
  it("declares a clustered point layer in the hazard color with no input and no env", () => {
    expect(layer.id).toBe("sequoia-mortality");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.input.parse({})).toEqual({});
    expect(layer.style).toEqual({ geometry: "point", color: "#F57272", cluster: true, encode: { color: "kind" } });
    expect(layer.maxAreaKm2).toBe(400_000);
    expect(layer.wide).toEqual({ orderBy: "trunk diameter in cm", limit: 3000 });
    expect(layer.license).toMatch(/USGS/);
  });

  it("fetches the file once under a fixed week-long cache key, whatever the view, and filters to the view", async () => {
    const stub = vi.fn(async () => text(CSV));
    const r = await layer.query(ctx(stub, SEKI, "sequoia-mortality:view-a"), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const calls = stub.mock.calls as unknown as [string, RequestInit & { cacheKey?: string; ttlSeconds?: number }][];
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("https://www.sciencebase.gov/catalog/file/get/63d40479d34e06fef150e7b4?name=Sequoia_stemdata.csv");
    expect(calls[0][1].cacheKey).toBe("sequoia-mortality:stemdata-v4");
    expect(calls[0][1].ttlSeconds).toBe(7 * 86_400);
    // A slow ScienceBase gets 45 s, counted from the rate-limit slot (timeoutMs), not a signal whose clock ran in the queue.
    expect((calls[0][1] as { timeoutMs?: number }).timeoutMs).toBe(FILE_TIMEOUT_MS);
    expect(FILE_TIMEOUT_MS).toBe(45_000);
    expect(calls[0][1].signal).toBeUndefined();
    expect(r.data.features).toHaveLength(25);
    expect(r.coverageNote).toMatch(/4 surveyed trees/);
    expect(r.citation.source).toContain("USGS");
  });

  it("returns a note without calling upstream outside the parks", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub, [2, 45, 3, 46]), {});
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toMatch(/Sequoia and Kings Canyon/);
  });

  it("maps an HTTP error and a network failure to upstream errors", async () => {
    const bad = vi.fn(async () => new Response("nope", { status: 502 }));
    expect(await layer.query(ctx(bad), {})).toMatchObject({ hint: "upstream" });
    const down = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await layer.query(ctx(down), {})).toMatchObject({ hint: "upstream" });
    const slow = vi.fn(async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    expect(await layer.query(ctx(slow), {})).toEqual({ error: "ScienceBase timed out after 45 seconds", hint: "upstream" });
  });

  it("answers a box over 400,000 km² with every tree in it, biggest trunks first, and the count", async () => {
    const stub = vi.fn(async () => text(CSV));
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("sequoia-mortality", { bbox: [-123, 33, -114, 39], zoom: 5 });
      expect(res.status).toBe(200);
      if (!("data" in res.body) || res.body.kind !== "geojson") throw new Error("expected geojson");
      expect(res.body.data.features).toHaveLength(25);
      const diameters = res.body.data.features.map((f) => Number(f.properties?.diameterCm ?? -1));
      expect(diameters).toEqual([...diameters].sort((a, b) => b - a));
      expect(res.body).toMatchObject({ total: 25, coverageNote: expect.stringMatching(/^Showing all 25 in this wide view \(ranked by trunk diameter in cm\); \d+ of 25 surveyed trees dead \(\d+%\).*; 4 surveyed trees that could not be found on a later visit are left out$/) });
      expect(res.body).not.toHaveProperty("truncated");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("cuts a wide answer to the strategy's limit, keeping the biggest trunks", async () => {
    const stub = vi.fn(async () => text(CSV));
    const r = await layer.query({ ...ctx(stub), wide: true, wideStrategy: { orderBy: "trunk diameter in cm", limit: 5 } }, {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(5);
    expect(r.total).toBe(25);
    const all = parseStems(CSV).features.map((f) => Number(f.properties?.diameterCm ?? -1)).sort((a, b) => b - a);
    expect(r.data.features.map((f) => Number(f.properties?.diameterCm ?? -1))).toEqual(all.slice(0, 5));
  });

  it("rejects a huge area through runLayer", async () => {
    const res = await runLayer("sequoia-mortality", { bbox: [-125, 30, -105, 45], zoom: 4 });
    expect(res.status).toBe(422);
  });

  it("describes the fires, the survey limits and the unit", () => {
    expect(layer.description).toMatch(/Castle Fire/);
    expect(layer.description).toMatch(/not every sequoia/);
    expect(layer.description).toMatch(/sequoia-groves/);
  });

  it("colors alive vs dead, titles each tree, has no time scrubber, and answers 'how many died' in the note (audit 2026-10-17)", () => {
    expect(attributeProblems(layer)).toEqual([]);
    expect(contractProblems(layer)).toEqual([]);
    expect(legendOf(layer).items?.map((i) => i.label)).toEqual(["Dead", "Alive"]);
    expect(timeShapeOf(layer).shape).toBe("none");
    const tree = (kind: string, grove?: string): Feature => ({ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { kind, ...(grove && { grove }) } });
    const trees = [
      ...Array.from({ length: 30 }, (_, i) => tree(i < 24 ? "dead" : "live", "Redwood Mountain")),
      ...Array.from({ length: 40 }, (_, i) => tree(i < 10 ? "dead" : "live", "Muir")),
      tree("dead"),
    ];
    expect(survivalNote(trees)).toBe("35 of 71 surveyed trees dead (49%); most lost: Redwood Mountain 80% of 30, Muir 25% of 40");
    expect(survivalNote([])).toBeNull();
    expect(cardTitle(layer, { properties: { kind: "dead", heading: "Dead giant sequoia, Garfield grove" } })).toBe("Dead giant sequoia, Garfield grove");
  });
});
