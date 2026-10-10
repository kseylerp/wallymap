import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { buildMtbQuery, imbaScale, mtbScale, normalizeMtb } from "./mtb-trails";
import fixture from "./__fixtures__/mtb-trails.truckee.json";

const TRUCKEE: [number, number, number, number] = [-120.25, 39.28, -120.1, 39.38];
const DEFAULTS = { includeRoutes: true };

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string) {
  return { bbox: TRUCKEE, zoom: 12, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

describe("buildMtbQuery", () => {
  it("selects rated ways and route=mtb relations in (south,west,north,east) order, with counts", () => {
    const q = buildMtbQuery(TRUCKEE, DEFAULTS);
    expect(q).toContain('way["mtb:scale"](39.28,-120.25,39.38,-120.1)');
    expect(q).toContain('way["mtb:scale:imba"](39.28,-120.25,39.38,-120.1)');
    expect(q).toContain('rel["route"="mtb"](39.28,-120.25,39.38,-120.1)');
    expect(q).toContain(".w out count;");
    expect(q).toContain(".w out tags geom 2000;");
  });

  it("fetches route members clipped to the box, never the relation's whole geometry", () => {
    const q = buildMtbQuery(TRUCKEE, DEFAULTS);
    expect(q).toContain("way(r.r)(39.28,-120.25,39.38,-120.1)->.rw;");
    expect(q).toContain(".r out body 100;");
    expect(q).toContain(".rw out tags geom 3000;");
    expect(q).not.toContain(".r out geom");
  });

  it("leaves the relations out when includeRoutes is false", () => {
    const q = buildMtbQuery(TRUCKEE, { includeRoutes: false });
    expect(q).not.toContain("route");
    expect(q).not.toContain(".r ");
  });
});

describe("scale parsing", () => {
  it("reads the Singletrack Scale with plus and minus marks and ranges", () => {
    expect(mtbScale("3")).toBe(3);
    expect(mtbScale("2+")).toBe(2);
    expect(mtbScale("1-2")).toBe(2);
    expect(mtbScale("0")).toBe(0);
    expect(mtbScale("7")).toBeUndefined();
    expect(mtbScale("hard")).toBeUndefined();
    expect(mtbScale(undefined)).toBeUndefined();
  });

  it("reads IMBA 0 to 4 only", () => {
    expect(imbaScale("4")).toBe(4);
    expect(imbaScale("5")).toBeUndefined();
  });
});

describe("normalizeMtb", () => {
  const fc = normalizeMtb(fixture);

  it("turns the Truckee fixture into lines: ways become LineStrings, the route a MultiLineString", () => {
    const ways = fixture.elements.filter((e) => e.type === "way").length;
    expect(fc.features).toHaveLength(ways + 1);
    expect(fc.features.filter((f) => f.geometry.type === "LineString")).toHaveLength(ways);
    const route = fc.features.find((f) => f.properties?.kind === "route");
    expect(route?.geometry.type).toBe("MultiLineString");
    expect(route?.properties).toMatchObject({ name: "Donner Lake Rim Trail", osmId: "relation/7669413" });
    expect(route?.properties).not.toHaveProperty("v");
  });

  it("carries the mtb:scale as v and kind mtb, and imba-only ways as kind imba without v", () => {
    const matt = fc.features.find((f) => f.properties?.name === "Matt's Trail");
    expect(matt?.properties).toMatchObject({ kind: "mtb", v: 1, imba: 2, highway: "path", surface: "ground" });
    const imbaOnly = fc.features.find((f) => f.properties?.name === "Springboard");
    expect(imbaOnly?.properties).toMatchObject({ kind: "imba", imba: 2 });
    expect(imbaOnly?.properties).not.toHaveProperty("v");
  });

  it("puts a valid check_date in t and keeps an odd rating text as mtbScale", () => {
    const out = normalizeMtb({
      elements: [
        {
          type: "way",
          id: 9,
          tags: { "mtb:scale": "2+", check_date: "2025-06-01", name: "Rocky" },
          geometry: [{ lat: 1, lon: 2 }, { lat: 1.1, lon: 2.1 }],
        },
        { type: "way", id: 10, tags: { highway: "path" }, geometry: [{ lat: 1, lon: 2 }, { lat: 1.1, lon: 2.1 }] },
        { type: "way", id: 11, tags: { "mtb:scale": "3" }, geometry: [{ lat: 1, lon: 2 }] },
      ],
    });
    expect(out.features).toHaveLength(1);
    expect(out.features[0].properties).toMatchObject({ v: 2, mtbScale: "2+", t: "2025-06-01", name: "Rocky", kind: "mtb" });
  });

  it("draws a route from the clipped member ways and does not repeat a rated way that is also a member", () => {
    const pts = [{ lat: 39.3, lon: -120.2 }, { lat: 39.31, lon: -120.19 }];
    const out = normalizeMtb({
      elements: [
        { type: "way", id: 1, tags: { "mtb:scale": "2" }, geometry: pts },
        { type: "way", id: 2, tags: { highway: "path" }, geometry: pts },
        { type: "way", id: 3, tags: { highway: "path" }, geometry: pts },
        { type: "way", id: 1, tags: { "mtb:scale": "2" }, geometry: pts },
        {
          type: "relation",
          id: 9,
          tags: { route: "mtb", name: "Rim" },
          members: [{ type: "way", ref: 2 }, { type: "way", ref: 3 }, { type: "way", ref: 404 }],
        },
      ],
    });
    expect(out.features.map((f) => f.properties?.osmId)).toEqual(["way/1", "relation/9"]);
    const route = out.features[1];
    expect(route.geometry.type).toBe("MultiLineString");
    if (route.geometry.type === "MultiLineString") expect(route.geometry.coordinates).toHaveLength(2);
  });

  it("returns nothing for a malformed body", () => {
    expect(normalizeMtb(null).features).toHaveLength(0);
    expect(normalizeMtb({ elements: "x" }).features).toHaveLength(0);
  });
});

describe("mtb-trails layer", () => {
  it("declares global ODbL coverage, a 2,500 km2 cap and the activity words in its description", () => {
    expect(layer.coverage).toBe("global");
    expect(layer.license).toContain("ODbL");
    expect(layer.maxAreaKm2).toBe(2500);
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.optionalEnv).toContain("OVERPASS_URL");
    expect(layer.style.geometry).toBe("line");
    expect(layer.description).toMatch(/mountain bik/i);
    expect(layer.description).toMatch(/singletrack/i);
  });

  it("posts one Overpass query and reports when the box holds more than came back", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    const r = await layer.query(ctx(stub, "mtb-trails:k"), DEFAULTS);
    expect(stub).toHaveBeenCalledTimes(1);
    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit & { cacheKey?: string }];
    expect(url).toBe("https://overpass-api.de/api/interpreter");
    expect(init.method).toBe("POST");
    expect(decodeURIComponent(String(init.body))).toContain('rel["route"="mtb"]');
    expect(init.cacheKey).toBe("mtb-trails:k:mtb-trails");
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(15);
    expect(r.citation.source).toContain("OpenStreetMap");
    // The fixture's count elements say 152 matched but only 15 are in the body.
    expect(r.coverageNote).toBe(
      "Showing 15 of 152 rated trail ways and routes in this box (lowest OpenStreetMap ids first); zoom in for the rest",
    );
  });

  it("says the box was not truncated when everything matched came back", async () => {
    const elements = fixture.elements.filter((e) => e.type !== "count");
    const stub = vi.fn(async () => new Response(JSON.stringify({ elements }), { status: 200 }));
    const r = await layer.query(ctx(stub), DEFAULTS);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toBe("Returned 15 rated trail ways and routes; the box was not truncated");
  });

  it("keeps trails at or under maxScale, plus unrated ones and routes", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    const r = await layer.query(ctx(stub), { includeRoutes: true, maxScale: 0 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const vs = r.data.features.flatMap((f) => (typeof f.properties?.v === "number" ? [f.properties.v] : []));
    expect(vs.length).toBeGreaterThan(0);
    expect(Math.max(...vs)).toBe(0);
    expect(r.data.features.some((f) => f.properties?.kind === "route")).toBe(true);
    // The note counts what is left after the filter and names it.
    expect(r.coverageNote).toMatch(/^Showing \d+ of 152 rated trail ways and routes in this box \(lowest OpenStreetMap ids first after maxScale hid \d+\)/);
  });

  it("counts the filtered result in the note when nothing was truncated", async () => {
    const elements = fixture.elements.filter((e) => e.type !== "count");
    const stub = vi.fn(async () => new Response(JSON.stringify({ elements }), { status: 200 }));
    const r = await layer.query(ctx(stub), { includeRoutes: true, maxScale: 0 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toBe(`Returned ${r.data.features.length} rated trail ways and routes after maxScale hid ${15 - r.data.features.length}; the box was not truncated`);
  });

  it("maps a failing Overpass to an upstream error after the fallback", async () => {
    const stub = vi.fn(async () => new Response("slow down", { status: 429 }));
    const r = await layer.query(ctx(stub), DEFAULTS);
    expect(r).toEqual({ error: "Overpass returned 429", hint: "upstream" });
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("returns 422 zoom_in from runLayer for a bbox over 2,500 km2 and 400 for a bad input", async () => {
    const big = await runLayer("mtb-trails", { bbox: [-121, 39, -120, 40] });
    expect(big.status).toBe(422);
    expect(big.body).toMatchObject({ hint: "zoom_in" });
    const bad = await runLayer("mtb-trails", { bbox: TRUCKEE, input: { maxScale: 9 } });
    expect(bad.status).toBe(400);
  });
});
