import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { attributeGroups } from "@/lib/render/attributes";
import { cardContent } from "@/lib/render/card";
import { hardMaxAreaKm2 } from "./types";
import { cardTitle, contractProblems, legendOf, timeShapeOf } from "./contract";
import rainier from "./__fixtures__/osm-trails.rainier.json";
import layer, {
  MAX_ROUTES,
  MAX_TRAILS,
  ROUTE_KM_BUDGET,
  buildNamedGeometryQuery,
  buildNamedScanQuery,
  buildOverpassQuery,
  buildRouteGeometryQuery,
  buildRouteScanQuery,
  countedWays,
  distanceTagKm,
  longestNamedFirst,
  normalizeOverpass,
  normalizeRoutes,
  routeDisplayName,
  overpassFailure,
  pickNamedByLength,
  pickRoutes,
  routeLengthKm,
  routesNote,
  simplifyLine,
  simplifiedFeature,
} from "./osm-trails";
import fixture from "./__fixtures__/osm-trails.tahoe.json";
import routeScan from "./__fixtures__/osm-trails.routes-scan.guiana.json";
import routeGeometry from "./__fixtures__/osm-trails.routes-geom.guiana.json";

const TAHOE: [number, number, number, number] = [-120.2, 38.85, -120, 39];

describe("osm-trails layer", () => {
  it("builds a query for highway=path|footway|track: named ways first, counted, each set capped", () => {
    const q = buildOverpassQuery(TAHOE, { namedOnly: false });
    expect(q).toContain('way["highway"~"^(path|footway|track)$"]["name"](38.85,-120.2,39,-120)->.named;');
    expect(q).toContain('way["highway"~"^(path|footway|track)$"][!"name"](38.85,-120.2,39,-120)->.unnamed;');
    expect(q).toContain(".named out count;.unnamed out count;");
    expect(q.endsWith(`.named out geom ${MAX_TRAILS};.unnamed out geom ${MAX_TRAILS};`)).toBe(true);
  });

  it("leaves out the unnamed set when namedOnly is true", () => {
    const q = buildOverpassQuery(TAHOE, { namedOnly: true });
    expect(q).not.toContain("unnamed");
    expect(q).toContain(`.named out geom ${MAX_TRAILS};`);
  });

  it("reads the way total from out count elements", () => {
    const count = (ways: number) => ({ type: "count", id: 0, tags: { nodes: "0", ways: String(ways) } });
    expect(countedWays({ elements: [count(30), count(9000)] })).toBe(9030);
    expect(countedWays({ elements: [] })).toBeNull();
  });

  it("normalizes fixture to LineStrings with trail tags", () => {
    const fc = normalizeOverpass(fixture);
    expect(fc.features.length).toBeGreaterThan(0);
    expect(fc.features[0].geometry.type).toBe("LineString");
    expect(fc.features.every((f) => typeof f.properties?.osmId === "string")).toBe(true);
    expect(fc.features.every((f) => /^way\/\d+$/.test(String(f.properties?.osmId)))).toBe(true);

    const way = fixture.elements[0];
    const first = fc.features[0];
    expect(first.properties?.osmId).toBe(`way/${way.id}`);
    if (first.geometry.type !== "LineString") throw new Error("expected LineString");
    expect(first.geometry.coordinates[0]).toEqual([way.geometry[0].lon, way.geometry[0].lat]);
  });

  it("rejects a bbox over the 400,000 km2 hard cap with zoom_in", async () => {
    const stub = vi.fn();
    const r = await layer.query(
      { bbox: [-125, 30, -110, 45], zoom: 5, env: {}, fetch: stub as unknown as CachedFetch },
      { namedOnly: false },
    );
    expect(r).toMatchObject({ hint: "zoom_in" });
    expect((r as { error: string }).error).toContain("under 400000 km²");
    expect(stub).not.toHaveBeenCalled();
  });

  it("maps 429 to upstream error after fallback", async () => {
    const stub = vi.fn(async () => new Response("slow down", { status: 429 }));
    const r = await layer.query(
      { bbox: TAHOE, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch },
      { namedOnly: false },
    );
    expect(r).toMatchObject({ hint: "upstream", error: "Overpass returned 429" });
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("returns a cited FeatureCollection on success", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    const r = await layer.query(
      { bbox: TAHOE, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch },
      { namedOnly: false },
    );
    expect(stub).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ kind: "geojson" });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features.length).toBeGreaterThan(0);
    expect(r.citation.source).toBe("OpenStreetMap contributors (ODbL)");
  });

  it("passes ctx.cacheKey to the primary request and a fallback key to the retry", async () => {
    const stub = vi.fn(async () => new Response("slow down", { status: 429 }));
    await layer.query(
      { bbox: TAHOE, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch, cacheKey: "osm-trails:k" },
      { namedOnly: false },
    );
    const keys = stub.mock.calls.map((call: unknown[]) => (call[1] as { cacheKey?: string }).cacheKey);
    expect(keys[0]).toMatch(/^osm-trails:k:overpass:[0-9a-f]+$/);
    expect(keys[1]).toBe(`${keys[0]}:fallback`);
  });

  it("treats a blank OVERPASS_URL as unset", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    await layer.query(
      { bbox: TAHOE, zoom: 11, env: { OVERPASS_URL: "" }, fetch: stub as unknown as CachedFetch },
      { namedOnly: false },
    );
    expect(stub.mock.calls.map((call: unknown[]) => call[0])).toEqual(["https://overpass-api.de/api/interpreter"]);
  });

  it("sets a timeout on each request and reports a timeout as upstream", async () => {
    const stub = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const r = await layer.query(
      { bbox: TAHOE, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch },
      { namedOnly: false },
    );
    expect(r).toMatchObject({ hint: "upstream" });
    expect((r as { error: string }).error).toContain("timed out");
    expect(stub).toHaveBeenCalledTimes(2);
    for (const call of stub.mock.calls as unknown[][]) {
      expect((call[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("filters by sacScaleMax, keeping untagged and easier trails", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    const r = await layer.query(
      { bbox: TAHOE, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch },
      { namedOnly: false, sacScaleMax: "hiking" },
    );
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const scales = r.data.features.map((f) => f.properties?.sac_scale as string | undefined);
    expect(scales.every((s) => s === "not_rated" || s === "hiking")).toBe(true);
    expect(r.data.features.length).toBeLessThan(normalizeOverpass(fixture).features.length);
  });

  it("retries a thrown network error against the public endpoint", async () => {
    const env = { OVERPASS_URL: "https://overpass.example.test/api/interpreter" };
    const stub = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(new Response(JSON.stringify(fixture), { status: 200 }));
    const r = await layer.query(
      { bbox: TAHOE, zoom: 11, env, fetch: stub as unknown as CachedFetch },
      { namedOnly: false },
    );
    expect(r).toMatchObject({ kind: "geojson" });
    expect(stub.mock.calls.map((c) => c[0])).toEqual([
      "https://overpass.example.test/api/interpreter",
      "https://overpass-api.de/api/interpreter",
    ]);
  });

  it("treats a 200 with a timeout remark as an upstream failure after retry", async () => {
    const remark = 'runtime error: Query timed out in "query" at line 1 after 26 seconds.';
    const stub = vi.fn(
      async () => new Response(JSON.stringify({ remark, elements: [] }), { status: 200 }),
    );
    const r = await layer.query(
      { bbox: TAHOE, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch },
      { namedOnly: false },
    );
    expect(r).toMatchObject({ hint: "upstream" });
    expect((r as { error: string }).error).toContain("Query timed out");
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("treats a 200 body with no elements array as an upstream failure", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify({ version: 0.6 }), { status: 200 }));
    const r = await layer.query(
      { bbox: TAHOE, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch },
      { namedOnly: false },
    );
    expect(r).toMatchObject({ hint: "upstream" });
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("overpassFailure accepts a good body and flags bad ones", () => {
    expect(overpassFailure(fixture)).toBeNull();
    expect(overpassFailure({ elements: [] })).toBeNull();
    expect(overpassFailure({ remark: "out of memory", elements: [] })).toBe("out of memory");
    expect(overpassFailure(null)).not.toBeNull();
  });

  it("caps at MAX_TRAILS, named trails first, and says how many the box holds", async () => {
    const way = (id: number, named: boolean) => ({
      type: "way",
      id,
      tags: { highway: "path", ...(named ? { name: `Trail ${id}` } : {}) },
      geometry: [
        { lat: 38.9, lon: -120.1 },
        { lat: 38.91, lon: -120.11 },
      ],
    });
    const count = (ways: number) => ({ type: "count", id: 0, tags: { ways: String(ways) } });
    // Unnamed ways first in the body, so the named ones must be pulled forward.
    const elements = [
      count(100),
      count(9_000),
      ...Array.from({ length: MAX_TRAILS }, (_, i) => way(i, false)),
      ...Array.from({ length: 100 }, (_, i) => way(100_000 + i, true)),
    ];
    const stub = vi.fn(async () => new Response(JSON.stringify({ elements }), { status: 200 }));
    const r = await layer.query({ bbox: TAHOE, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch }, { namedOnly: false });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(MAX_TRAILS);
    expect(r.data.features.slice(0, 100).every((f) => typeof f.properties?.name === "string")).toBe(true);
    expect(r.coverageNote).toBe("Showing 2,000 of 9,100 trail ways in this box (named first); zoom in for the rest");
  });

  it("notes a cut made upstream even when fewer than MAX_TRAILS came back", async () => {
    const elements = [{ type: "count", id: 0, tags: { ways: "5000" } }, ...fixture.elements];
    const stub = vi.fn(async () => new Response(JSON.stringify({ elements }), { status: 200 }));
    const r = await layer.query({ bbox: TAHOE, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch }, { namedOnly: true });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toMatch(/^Showing \d[\d,]* of 5,000 trail ways in this box/);
  });

  it("adds no coverage note when nothing was cut", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    const r = await layer.query({ bbox: TAHOE, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch }, { namedOnly: false });
    expect(r).not.toHaveProperty("coverageNote");
  });
});

// French Guiana, about 136,000 km²: too wide for paths, so the layer answers with named hiking routes.
const GUIANA: [number, number, number, number] = [-54.6, 2.1, -51.6, 5.8];

describe("osm-trails named routes over a wide box", () => {
  const ctx = (stub: ReturnType<typeof vi.fn>) => ({ bbox: GUIANA, zoom: 7, env: {}, fetch: stub as unknown as CachedFetch });

  it("scans hiking and foot route relations with a count, then fetches the chosen ones clipped to the box", () => {
    expect(buildRouteScanQuery(GUIANA)).toBe(
      '[out:json][timeout:25];relation["route"~"^(hiking|foot)$"]["name"](2.1,-54.6,5.8,-51.6)->.r;.r out count;.r out tags bb 5000;',
    );
    expect(buildRouteGeometryQuery(GUIANA, [1, 2])).toBe("[out:json][timeout:25];relation(id:1,2)->.r;.r out geom(2.1,-54.6,5.8,-51.6);rel(br.r);out body;");
  });

  it("reads distance tags in km, miles or metres, and distrusts one that does not fit the route's extent", () => {
    expect(distanceTagKm("3.9 km")).toBe(3.9);
    expect(distanceTagKm("12,5")).toBe(12.5);
    expect(distanceTagKm("10 mi")).toBeCloseTo(16.09, 2);
    expect(distanceTagKm("about 5")).toBeUndefined();
    const bounds = { minlat: 45, minlon: 7, maxlat: 45.02, maxlon: 7.02 };
    // 5,956 "km" on a route 2.7 km across was metres: fall back to the extent.
    expect(routeLengthKm({ distance: "5956" }, bounds)).toBeCloseTo(2.7, 1);
    expect(routeLengthKm({ distance: "6" }, bounds)).toBe(6);
  });

  it("picks the longest routes first and stops at the km budget (keeping at least 20)", () => {
    expect(pickRoutes(routeScan, GUIANA)[0]).toBe(18158451); // Piste de Bélizon, 205 km
    // Each route's extent lies inside the box: 0.8 degrees across (about 125 km) or 0.02 (about 3 km).
    const relation = (id: number, km: number) => {
      const size = km > 100 ? 0.8 : 0.02;
      return { type: "relation", id, tags: { name: `R${id}`, distance: String(km) }, bounds: { minlat: 3, minlon: -53, maxlat: 3 + size, maxlon: -53 + size } };
    };
    const long = { elements: Array.from({ length: 300 }, (_, i) => relation(i + 1, 1_000)) };
    expect(pickRoutes(long, GUIANA)).toHaveLength(20);
    const short = { elements: Array.from({ length: 300 }, (_, i) => relation(i + 1, 5)) };
    expect(pickRoutes(short, GUIANA)).toHaveLength(MAX_ROUTES);
    expect(ROUTE_KM_BUDGET).toBeGreaterThan(20 * 5);
  });

  it("normalizes routes to lines, longest first, with name, length and network", () => {
    const fc = normalizeRoutes(routeGeometry);
    expect(fc.features.map((f) => f.properties?.name)).toEqual(["Piste de Bélizon", "Molokoï", "Sentier du Rorota", "Boucle Cascades"]);
    const belizon = fc.features[0].properties ?? {};
    expect(belizon).toMatchObject({ kind: "route", osmId: "relation/18158451", network: "regional", distanceKm: 205 });
    expect(belizon.v).toBe(belizon.lengthKm);
    expect(belizon.v as number).toBeGreaterThan(150);
    expect(fc.features.every((f) => f.geometry.type === "LineString" || f.geometry.type === "MultiLineString")).toBe(true);
  });

  it("splits a member way where it leaves the box and drops routes with nothing inside", () => {
    const p = (lat: number, lon: number) => ({ lat, lon });
    const body = {
      elements: [
        {
          type: "relation",
          id: 1,
          tags: { name: "Split" },
          members: [{ type: "way", geometry: [p(3, -53), p(3.1, -53), null, p(3.3, -53), p(3.4, -53)] }],
        },
        { type: "relation", id: 2, tags: { name: "Outside" }, members: [{ type: "way", geometry: [] }] },
      ],
    };
    const fc = normalizeRoutes(body);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry).toEqual({
      type: "MultiLineString",
      coordinates: [
        [[-53, 3], [-53, 3.1]],
        [[-53, 3.3], [-53, 3.4]],
      ],
    });
  });

  it("never shows a part longer than the whole: ADT California Seg 1 is tagged 48.1 km and maps 50.1 km in view", () => {
    const p = (lat: number, lon: number) => ({ lat, lon });
    // 0.45° of latitude, about 50 km, wholly inside the box; its distance tag says 29.89 mi (48.1 km).
    const way = { type: "way", ref: 7, geometry: [p(39.0, -120), p(39.45, -120)] };
    const seg = { type: "relation", id: 9154927, tags: { name: "ADT - California - T - Seg 1", distance: "29.89 mi", network: "nwn", ref: "ADT T1", operator: "American Discovery Trail Society" }, members: [way, way] };
    const parent = { type: "relation", id: 1, tags: { name: "American Discovery Trail", type: "superroute" }, members: [{ type: "relation", ref: 9154927 }] };
    const [f] = normalizeRoutes({ elements: [seg, parent] }).features;
    expect(f.properties).toMatchObject({ name: "American Discovery Trail (California segment 1)", osmName: "ADT - California - T - Seg 1", ref: "ADT T1" });
    // The way listed twice counts once, and the full length is what is drawn.
    expect(f.properties?.lengthKm).toBeCloseTo(50, 0);
    expect(Number(f.properties?.distanceKm)).toBeGreaterThanOrEqual(Number(f.properties?.lengthKm));
    // Clipped by the box: a tag shorter than the part in view is dropped.
    const clipped = { ...seg, members: [{ type: "way", ref: 8, geometry: [p(39.0, -120), p(39.45, -120), null] }] };
    expect(normalizeRoutes({ elements: [clipped] }).features[0].properties?.distanceKm).toBeUndefined();
  });

  it("names a coded section after its operator's trail when no parent route is mapped, and leaves real names alone", () => {
    expect(routeDisplayName({ name: "ADT - California - T - Seg 1", operator: "American Discovery Trail Society" })).toBe("American Discovery Trail (California segment 1)");
    expect(routeDisplayName({ name: "Tahoe Rim Trail" })).toBe("Tahoe Rim Trail");
    expect(routeDisplayName({ name: "TRT", official_name: "Tahoe Rim Trail" })).toBe("Tahoe Rim Trail");
  });

  it("simplifies a line but keeps its ends", () => {
    const line = [[0, 0], [1, 0.0001], [2, 0], [3, 1]];
    expect(simplifyLine(line, 0.01)).toEqual([[0, 0], [2, 0], [3, 1]]);
  });

  it("answers a wide box with named routes from two Overpass calls and a coverage note", async () => {
    const stub = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(routeScan), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(routeGeometry), { status: 200 }));
    const r = await layer.query(ctx(stub), { namedOnly: false });
    expect(stub).toHaveBeenCalledTimes(2);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features[0].properties?.name).toBe("Piste de Bélizon");
    expect(r.coverageNote).toBe("Showing 4 of 17 named hiking routes (longest first); individual paths appear under 2,500 km²");
    const second = decodeURIComponent(String((stub.mock.calls[1][1] as RequestInit).body));
    expect(second).toContain("relation(id:18158451,");
  });

  it("says so when the box holds no named routes, without a second call", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify({ elements: [{ type: "count", id: 0, tags: { relations: "0" } }] }), { status: 200 }));
    const r = await layer.query(ctx(stub), { namedOnly: false });
    expect(stub).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ kind: "geojson", coverageNote: routesNote(0, 0) });
    expect(routesNote(0, 0)).toContain("No named hiking routes");
    expect(routesNote(17, 17)).toBe("17 named hiking routes; individual paths appear under 2,500 km²");
  });

  it("maps a failing scan to an upstream error", async () => {
    const stub = vi.fn(async () => new Response("busy", { status: 429 }));
    expect(await layer.query(ctx(stub), { namedOnly: false })).toMatchObject({ hint: "upstream" });
  });

  it("describes both scales for the model", () => {
    expect(layer.maxAreaKm2).toBe(2_500);
    expect(layer.hardMaxAreaKm2).toBe(400_000);
    expect(hardMaxAreaKm2(layer)).toBe(400_000);
    expect(layer.wide).toEqual({ mode: "named", orderBy: "length in km", limit: MAX_ROUTES });
    expect(layer.description).toContain("Under 2,500 km²");
    expect(layer.description).toContain("named hiking routes");
  });

  it("answers a wide box through runLayer with the named routes, the route count as total and run.ts's note", async () => {
    const stub = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Response(JSON.stringify(decodeURIComponent(String(init?.body)).includes("out tags bb") ? routeScan : routeGeometry), { status: 200 }),
    );
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("osm-trails", { bbox: GUIANA, zoom: 7 });
      expect(res.status).toBe(200);
      expect(stub).toHaveBeenCalledTimes(2);
      expect(res.body).toMatchObject({
        kind: "geojson",
        total: 17,
        truncated: true,
        coverageNote: "Showing the 4 named of 17 (ranked by length in km); zoom in under 2,500 km² for all",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("caps the routes at the wide strategy's limit and leaves the note to run.ts", async () => {
    const stub = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(routeScan), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(routeGeometry), { status: 200 }));
    const wide = { mode: "named" as const, orderBy: "length in km", limit: 2 };
    const r = await layer.query({ ...ctx(stub), wide: true, wideStrategy: wide }, { namedOnly: false });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.total).toBe(17);
    expect(r.coverageNote).toBeUndefined();
    const second = decodeURIComponent(String((stub.mock.calls[1][1] as RequestInit).body));
    expect(second).toMatch(/relation\(id:\d+,\d+\)->\.r;/);
  });
});

describe("named-line helpers for the other OSM layers' wide mode", () => {
  const BOX: [number, number, number, number] = [-112.5, 38, -111.5, 39];

  it("scans every match and the named ones with counts, ids and bounds only", () => {
    expect(buildNamedScanQuery(['way["mtb:scale"]', 'rel["route"="mtb"]'], ["name"], BOX)).toBe(
      '[out:json][timeout:25];(way["mtb:scale"](38,-112.5,39,-111.5);rel["route"="mtb"](38,-112.5,39,-111.5);)->.all;.all out count;' +
        '(way.all["name"];rel.all["name"];)->.named;.named out count;rel.named->.nr;.nr out ids bb 5000;way.named->.nw;.nw out ids bb 5000;',
    );
  });

  it("picks the longest inside the box first, within the limit and the relation cap", () => {
    const box = (id: number, type: string, size: number) => ({ type, id, bounds: { minlat: 38.2, minlon: -112, maxlat: 38.2 + size, maxlon: -112 + size } });
    const scan = { elements: [{ type: "count", id: 0, tags: { total: "9" } }, box(1, "way", 0.01), box(2, "way", 0.1), box(3, "relation", 0.5), box(4, "relation", 0.4)] };
    expect(pickNamedByLength(scan, BOX, 10, 5)).toEqual({ ways: [2, 1], relations: [3, 4] });
    expect(pickNamedByLength(scan, BOX, 2, 5)).toEqual({ ways: [], relations: [3, 4] });
    expect(pickNamedByLength(scan, BOX, 10, 1)).toEqual({ ways: [2, 1], relations: [3] });
  });

  it("fetches the picked ways with tags and the relations with bare member geometry inside the box", () => {
    expect(buildNamedGeometryQuery(BOX, { ways: [2, 1], relations: [3] }, 3000)).toBe(
      "[out:json][timeout:25];way(id:2,1);out tags geom;rel(id:3)->.r;way(r.r)(38,-112.5,39,-111.5)->.rw;.r out body;.rw out skel geom 3000;",
    );
    expect(buildNamedGeometryQuery(BOX, { ways: [], relations: [3] }, 10)).not.toContain("way(id:");
  });

  it("simplifies a wide answer's lines and multi-lines to the view's tolerance, keeping their ends and properties", () => {
    const zigzag = [[0, 0], [1, 0.001], [2, 0], [3, 0.001], [4, 0]];
    const line = { type: "Feature" as const, geometry: { type: "LineString" as const, coordinates: zigzag }, properties: { name: "a" } };
    expect(simplifiedFeature(line, 0.01)).toEqual({ ...line, geometry: { type: "LineString", coordinates: [[0, 0], [4, 0]] } });
    const multi = { ...line, geometry: { type: "MultiLineString" as const, coordinates: [zigzag, [[5, 5], [6, 6]]] } };
    expect(simplifiedFeature(multi, 0.01).geometry.coordinates).toEqual([[[0, 0], [4, 0]], [[5, 5], [6, 6]]]);
    const point = { type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [1, 2] }, properties: {} };
    expect(simplifiedFeature(point, 0.01)).toBe(point);
  });

  it("keeps the named features, longest first, up to the limit", () => {
    const line = (name: string | undefined, lat: number) => ({
      type: "Feature" as const,
      geometry: { type: "LineString" as const, coordinates: [[-112, 38.2], [-112, lat]] },
      properties: name === undefined ? {} : { name },
    });
    const kept = longestNamedFirst([line("short", 38.21), line(undefined, 38.9), line("long", 38.5), line("mid", 38.3)], 2);
    expect(kept.map((f) => f.properties.name)).toEqual(["long", "mid"]);
  });
});

describe("osm-trails near Mount Rainier: unrated ways, kinds and length", () => {
  const fc = normalizeOverpass(rainier);
  const sac = layer.attributes?.find((a) => a.key === "sac_scale");
  const kind = layer.attributes?.find((a) => a.key === "kind");

  it("marks ways with no difficulty as not_rated, so they have a Not rated chip after the six levels", () => {
    expect(fc.features.map((f) => f.properties?.sac_scale)).toEqual(["mountain_hiking", "not_rated", "not_rated", "mountain_hiking"]);
    if (!sac) throw new Error("expected the difficulty attribute");
    const chips = attributeGroups(sac, fc);
    expect(chips.map((c) => `${c.label} ${c.count}`)).toEqual(["Mountain hiking (T2) 2", "Not rated 2"]);
    const legend = legendOf(layer, fc);
    expect(legend.items?.at(-1)).toMatchObject({ label: "Not rated", value: "not_rated" });
    expect(legend.items).toHaveLength(7);
  });

  it("says what each way is (Footpath, Path, Track) and titles an unnamed one by it", () => {
    expect(fc.features.map((f) => f.properties?.kind)).toEqual(["footway", "footway", "footway", "path"]);
    if (!kind) throw new Error("expected the kind attribute");
    expect(kind.levels?.map((l) => l.label)).toEqual(["Path", "Footpath", "Track", "Named route"]);
    expect(cardTitle(layer, fc.features[2])).toBe("Footpath");
    expect(cardTitle(layer, fc.features[3])).toBe("Path");
    const track = normalizeOverpass({ elements: [{ type: "way", id: 9, tags: { highway: "track" }, geometry: [{ lat: 46.8, lon: -121.7 }, { lat: 46.81, lon: -121.7 }] }] });
    expect(cardTitle(layer, track.features[0])).toBe("Track");
  });

  it("shows each way's length, difficulty in words and kind on the card, without the map id", () => {
    const unnamed = fc.features[2];
    expect(unnamed.properties?.lengthKm).toBeGreaterThan(0);
    const card = cardContent(unnamed, { card: layer.card, fieldHelp: layer.fieldHelp });
    expect(card.measure?.label).toBe("Length");
    expect(card.measure?.value).toMatch(/km$/);
    expect(card.facts.map((r) => `${r.label}: ${r.value}`)).toEqual(expect.arrayContaining(["Difficulty: Not rated", "Kind: Footpath"]));
    expect([...card.facts, ...card.details].some((r) => r.value.includes("way/"))).toBe(false);
  });

  it("declares no time, labels the longest named ways and passes the contract checks", () => {
    expect(contractProblems(layer)).toEqual([]);
    expect(timeShapeOf(layer, fc)).toEqual({ shape: "none" });
    expect(layer.labels).toEqual({ field: "name", max: 8, rankBy: "lengthKm" });
  });
});
