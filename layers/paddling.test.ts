import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { hardMaxAreaKm2 } from "./types";
import layer, { WIDE_LIMIT, buildPaddlingQuery, buildWidePaddlingQuery, normalizePaddling, paddlingKind } from "./paddling";
import trentino from "./__fixtures__/paddling.trentino.json";
import bern from "./__fixtures__/paddling.bern.json";

const TRENTINO: [number, number, number, number] = [11, 46.1, 11.6, 46.4];
const BERN: [number, number, number, number] = [7.35, 46.75, 7.65, 46.98];
const DEFAULTS = { whitewaterOnly: false };

function ctx(stub: ReturnType<typeof vi.fn>, bbox = TRENTINO, cacheKey?: string) {
  return { bbox, zoom: 12, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

describe("buildPaddlingQuery", () => {
  it("selects whitewater elements, rapids, graded sections and canoe routes in (south,west,north,east) order, with counts", () => {
    const q = buildPaddlingQuery(TRENTINO, DEFAULTS);
    expect(q).toContain('nw["whitewater"](46.1,11,46.4,11.6)');
    expect(q).toContain('nw["whitewater:rapid_grade"](46.1,11,46.4,11.6)');
    expect(q).toContain('nw["waterway"="rapids"](46.1,11,46.4,11.6)');
    expect(q).toContain('way["whitewater:section_grade"](46.1,11,46.4,11.6)');
    expect(q).toContain('rel["route"="canoe"](46.1,11,46.4,11.6)');
    expect(q).toContain(".p out count;.s out count;");
    expect(q).toContain(".r out count;");
    expect(q).toContain(".p out tags geom 1500;.s out tags geom 1500;");
  });

  it("fetches canoe route members clipped to the box, never the relation's whole geometry", () => {
    const q = buildPaddlingQuery(TRENTINO, DEFAULTS);
    expect(q).toContain("way(r.r)(46.1,11,46.4,11.6)->.rw;");
    expect(q).toContain(".r out body 50;");
    expect(q).toContain(".rw out tags geom 3000;");
    expect(q).not.toContain(".r out geom");
  });

  it("drops the canoe routes when whitewaterOnly is true", () => {
    const q = buildPaddlingQuery(TRENTINO, { whitewaterOnly: true });
    expect(q).not.toContain("canoe");
    expect(q).not.toContain(".r ");
  });
});

describe("paddlingKind", () => {
  it("sorts elements into rapid, access, hazard, portage and feature", () => {
    expect(paddlingKind({ whitewater: "rapid" }, "other")).toBe("rapid");
    expect(paddlingKind({ "whitewater:rapid_grade": "3", waterway: "weir" }, "other")).toBe("rapid");
    expect(paddlingKind({ waterway: "rapids" }, "other")).toBe("rapid");
    for (const ww of ["put_in", "egress", "put_in;egress", "put-in;egress", "put_in_out"]) {
      expect(paddlingKind({ whitewater: ww }, "other")).toBe("access");
    }
    expect(paddlingKind({ whitewater: "hazard" }, "other")).toBe("hazard");
    expect(paddlingKind({ whitewater: "portage_way" }, "other")).toBe("portage");
    expect(paddlingKind({ whitewater: "playspot" }, "other")).toBe("feature");
    expect(paddlingKind({}, "section")).toBe("section");
    expect(paddlingKind({}, "route")).toBe("route");
  });
});

describe("normalizePaddling", () => {
  it("turns the Trentino fixture into graded rapid points and section lines with v = class", () => {
    const fc = normalizePaddling(trentino);
    expect(fc.features).toHaveLength(20);
    const rapids = fc.features.filter((f) => f.properties?.kind === "rapid");
    expect(rapids).toHaveLength(14);
    expect(rapids.every((f) => f.geometry.type === "Point")).toBe(true);
    expect(rapids[0].properties).toMatchObject({ osmId: "node/257437934", grade: "3", v: 3 });
    const sections = fc.features.filter((f) => f.properties?.kind === "section");
    expect(sections).toHaveLength(6);
    expect(sections.every((f) => f.geometry.type === "LineString")).toBe(true);
    expect(sections[0].properties).toMatchObject({ name: "Torrente Avisio", grade: "2", v: 2 });
    expect(sections.map((f) => f.properties?.v)).toEqual([2, 3, 2, 2, 2, 3]);
  });

  it("turns the Bern fixture into access points, an ungraded rapid, a graded rapid line, sections and a canoe route", () => {
    const fc = normalizePaddling(bern);
    const by = (kind: string) => fc.features.filter((f) => f.properties?.kind === kind);
    expect(by("access")).toHaveLength(3);
    expect(by("access").every((f) => f.geometry.type === "Point")).toBe(true);
    expect(by("access")[0].properties).toMatchObject({ name: "Thun", whitewater: "put_in" });
    const graded = fc.features.find((f) => f.properties?.name === "Uttigenschwelle");
    expect(graded?.geometry.type).toBe("LineString");
    expect(graded?.properties).toMatchObject({ kind: "rapid", v: 2 });
    const ungraded = fc.features.find((f) => f.properties?.name === "Bahnbrücke Uttigen");
    expect(ungraded?.properties).toMatchObject({ kind: "rapid" });
    expect(ungraded?.properties).not.toHaveProperty("v");
    expect(by("section").length).toBeGreaterThan(0);
    const route = by("route");
    expect(route).toHaveLength(1);
    expect(route[0].properties).toMatchObject({ name: "Berner Aare Kanu", distanceKm: 20, ref: "60", network: "rpn" });
    expect(route[0].properties).not.toHaveProperty("v");
    expect(["LineString", "MultiLineString"]).toContain(route[0].geometry.type);
  });

  it("puts a closed pier way at its middle as a point, reads class ranges and roman numerals, and keeps check_date as t", () => {
    const ring = [
      { lat: 1, lon: 1 }, { lat: 1, lon: 1.002 }, { lat: 1.002, lon: 1.002 }, { lat: 1.002, lon: 1 }, { lat: 1, lon: 1 },
    ];
    const fc = normalizePaddling({
      elements: [
        { type: "way", id: 1, geometry: ring, tags: { whitewater: "put_in", man_made: "pier" } },
        {
          type: "way",
          id: 2,
          geometry: ring.slice(0, 2),
          tags: { "whitewater:section_name": "Upper Gorge", name: "Rogue", "whitewater:section_grade": "III-IV", check_date: "2025-05-05" },
        },
        { type: "node", id: 3, lat: 5, lon: 6, tags: { whitewater: "rapid", "whitewater:rapid_grade": "V+" } },
        { type: "node", id: 4, lat: 5, lon: 6, tags: { whitewater: "rapid", "whitewater:rapid_grade": "unknown" } },
        { type: "way", id: 5, geometry: [ring[0]], tags: { whitewater: "rapid" } },
      ],
    });
    expect(fc.features).toHaveLength(4);
    expect(fc.features[0].geometry).toEqual({ type: "Point", coordinates: [1.001, 1.001] });
    expect(fc.features[1].properties).toMatchObject({ kind: "section", name: "Upper Gorge", river: "Rogue", v: 4, t: "2025-05-05" });
    expect(fc.features[2].properties).toMatchObject({ v: 5.5 });
    expect(fc.features[3].properties).toMatchObject({ grade: "unknown" });
    expect(fc.features[3].properties).not.toHaveProperty("v");
  });

  it("draws a canoe route from clipped member ways without turning those ways into features", () => {
    const pts = [{ lat: 46.8, lon: 7.4 }, { lat: 46.81, lon: 7.41 }];
    const fc = normalizePaddling({
      elements: [
        { type: "way", id: 1, tags: { waterway: "river", name: "Aare" }, geometry: pts },
        { type: "way", id: 2, tags: { waterway: "river" }, geometry: pts },
        { type: "relation", id: 7, tags: { route: "canoe", name: "Aare Kanu" }, members: [{ type: "way", ref: 1 }, { type: "way", ref: 2 }] },
      ],
    });
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toMatchObject({ kind: "route", name: "Aare Kanu" });
    expect(fc.features[0].geometry.type).toBe("MultiLineString");
  });

  it("returns nothing for a malformed body", () => {
    expect(normalizePaddling(null).features).toHaveLength(0);
    expect(normalizePaddling({ elements: "x" }).features).toHaveLength(0);
  });
});

describe("paddling layer", () => {
  it("declares global ODbL coverage, a 2,500 km2 cap, line style and the activity words", () => {
    expect(layer.coverage).toBe("global");
    expect(layer.license).toContain("ODbL");
    expect(layer.maxAreaKm2).toBe(2500);
    expect(layer.wide).toEqual({ mode: "named", limit: 1000 });
    expect(hardMaxAreaKm2(layer)).toBe(100_000);
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.optionalEnv).toContain("OVERPASS_URL");
    expect(layer.style.geometry).toBe("line");
    for (const word of ["whitewater", "kayaking", "canoe"]) expect(layer.description).toContain(word);
  });

  it("posts one Overpass query and reports when the box holds more than came back", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(trentino), { status: 200 }));
    const r = await layer.query(ctx(stub, TRENTINO, "paddling:k"), DEFAULTS);
    expect(stub).toHaveBeenCalledTimes(1);
    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit & { cacheKey?: string }];
    expect(url).toBe("https://overpass-api.de/api/interpreter");
    expect(init.method).toBe("POST");
    expect(init.cacheKey).toBe("paddling:k:paddling");
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(20);
    expect(r.citation.source).toContain("OpenStreetMap");
    expect(r.coverageNote).toBe(
      "Showing 20 of 51 paddling features in this box (lowest OpenStreetMap ids first); zoom in for the rest",
    );
  });

  it("says the box was not truncated when everything matched came back", async () => {
    const elements = bern.elements.filter((e) => e.type !== "count");
    const stub = vi.fn(async () => new Response(JSON.stringify({ elements }), { status: 200 }));
    const r = await layer.query(ctx(stub, BERN), DEFAULTS);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toBe("Returned 13 paddling features; the box was not truncated");
    expect(r.data.features.some((f) => f.properties?.kind === "route")).toBe(true);
  });

  it("keeps only features graded at or above minGrade", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(trentino), { status: 200 }));
    const r = await layer.query(ctx(stub), { whitewaterOnly: false, minGrade: 3 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const vs = r.data.features.map((f) => f.properties?.v);
    expect(vs.length).toBeGreaterThan(0);
    expect(vs.every((v) => typeof v === "number" && v >= 3)).toBe(true);
    expect(r.data.features.length).toBeLessThan(20);
    // The note counts the filtered result and names the filter.
    expect(r.coverageNote).toMatch(/^Showing \d+ of 51 paddling features in this box \(lowest OpenStreetMap ids first after the minimum grade hid \d+\)/);
  });

  it("maps a failing Overpass to an upstream error after the fallback", async () => {
    const stub = vi.fn(async () => new Response("slow down", { status: 429 }));
    const r = await layer.query(ctx(stub), DEFAULTS);
    expect(r).toEqual({ error: "Overpass returned 429", hint: "upstream" });
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("returns 422 zoom_in from runLayer over the 100,000 km2 hard cap and 400 for a bad minGrade", async () => {
    // The Alps east of Bern, about 200,000 km².
    const big = await runLayer("paddling", { bbox: [8, 44, 14, 48] });
    expect(big.status).toBe(422);
    expect(big.body).toMatchObject({ hint: "zoom_in" });
    const bad = await runLayer("paddling", { bbox: TRENTINO, input: { minGrade: 9 } });
    expect(bad.status).toBe(400);
  });
});

// The Aare from Bern to Thun, about 7,200 km²: over the 2,500 km² soft cap, under the 100,000 km² hard cap.
const AARE: [number, number, number, number] = [7, 46.3, 8.2, 47];

describe("paddling wide mode", () => {
  const count = (total: number) => ({ type: "count", id: 0, tags: { total: String(total) } });
  const body = {
    elements: [
      count(59),
      count(3),
      { type: "node", id: 1, lat: 46.75, lon: 7.6, tags: { whitewater: "put_in", name: "Thun" } },
      { type: "node", id: 2, lat: 46.8, lon: 7.55, tags: { whitewater: "rapid", "whitewater:rapid_grade": "3" } },
      {
        type: "way",
        id: 3,
        tags: { "whitewater:section_grade": "2", "whitewater:section_name": "Aareschlucht", name: "Aare" },
        geometry: [
          { lat: 46.7, lon: 8.1 },
          { lat: 46.72, lon: 8.15 },
        ],
      },
      { type: "relation", id: 4, tags: { route: "canoe", name: "Aare Canoe Trail" }, members: [{ type: "way", ref: 5 }] },
      {
        type: "way",
        id: 5,
        geometry: [
          { lat: 46.9, lon: 7.4 },
          { lat: 46.95, lon: 7.45 },
        ],
      },
    ],
  };

  it("answers a whitewater region (Colorado, about 71,500 km²) instead of asking to zoom in", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("paddling", { bbox: [-108, 38, -105, 40.5], zoom: 7 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ total: 59, truncated: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("answers through runLayer with the named features only, every feature as total and run.ts's note", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("paddling", { bbox: AARE, zoom: 8 });
      expect(res.status).toBe(200);
      expect(stub).toHaveBeenCalledTimes(1);
      const query = decodeURIComponent(String((stub.mock.calls[0] as unknown as [string, RequestInit])[1].body));
      expect(query).toContain('node.all["whitewater:rapid_name"];');
      expect(query).toContain(`.nw out tags geom ${WIDE_LIMIT};`);
      expect(query).toContain("rel.named->.r;");
      if (!("kind" in res.body) || res.body.kind !== "geojson") throw new Error("expected geojson");
      expect(res.body.data.features.map((f) => f.properties?.kind)).toEqual(["access", "section", "route"]);
      expect(res.body.data.features[1].properties).toMatchObject({ name: "Aareschlucht", river: "Aare", v: 2 });
      expect(res.body).toMatchObject({
        total: 59,
        truncated: true,
        coverageNote: "Showing the 3 named of 59; zoom in under 2,500 km² for all",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("skips canoe routes for whitewaterOnly and notes what minGrade hid", async () => {
    expect(buildWidePaddlingQuery(AARE, { whitewaterOnly: true }, 10)).not.toContain("canoe");
    const stub = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    const r = await layer.query(
      { bbox: AARE, zoom: 8, env: {}, fetch: stub as unknown as CachedFetch, wide: true, wideStrategy: layer.wide },
      { whitewaterOnly: false, minGrade: 2 },
    );
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features.map((f) => f.properties?.name)).toEqual(["Aareschlucht"]);
    expect(r.total).toBe(59);
    expect(r.coverageNote).toBe("The minimum grade hid 2 of the named features");
  });
});
