import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { hardMaxAreaKm2 } from "./types";
import layer, { buildSkiQuery, difficultyRank, normalizeSki } from "./ski-routes";
import fixture from "./__fixtures__/ski-routes.chamonix.json";

const CHAMONIX: [number, number, number, number] = [6.8, 45.85, 7.05, 46];
const DEFAULTS = { includeRoutes: true };

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string) {
  return { bbox: CHAMONIX, zoom: 12, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

describe("buildSkiQuery", () => {
  it("selects piste ways (not area outlines) and route=ski relations in (south,west,north,east) order", () => {
    const q = buildSkiQuery(CHAMONIX, DEFAULTS);
    expect(q).toContain('way["piste:type"]["area"!="yes"](45.85,6.8,46,7.05)');
    expect(q).toContain('rel["route"~"^(ski|piste)$"](45.85,6.8,46,7.05)');
    expect(q).toContain(".w out count;");
    expect(q).toContain(".w out tags geom 2000;");
  });

  it("fetches route members clipped to the box, never the relation's whole geometry", () => {
    const q = buildSkiQuery(CHAMONIX, DEFAULTS);
    expect(q).toContain("way(r.r)(45.85,6.8,46,7.05)->.rw;");
    expect(q).toContain(".r out body 50;");
    expect(q).toContain(".rw out tags geom 3000;");
    expect(q).not.toContain(".r out geom");
  });

  it("filters ways and relations to one kind", () => {
    const q = buildSkiQuery(CHAMONIX, { kind: "nordic", includeRoutes: true });
    expect(q).toContain('way["piste:type"="nordic"]');
    // Relations with no piste:type stay in, so a kind never hides an untyped ski route.
    expect(q).toContain('rel["route"~"^(ski|piste)$"]["piste:type"="nordic"](45.85,6.8,46,7.05)');
    expect(q).toContain('rel["route"~"^(ski|piste)$"][!"piste:type"](45.85,6.8,46,7.05)');
  });

  it("drops the relations when includeRoutes is false", () => {
    const q = buildSkiQuery(CHAMONIX, { includeRoutes: false });
    expect(q).not.toContain("rel[");
    expect(q).not.toContain(".r ");
  });
});

describe("difficultyRank", () => {
  it("ranks novice 1 up to freeride and extreme 6, and ignores unknown words", () => {
    expect(difficultyRank("novice")).toBe(1);
    expect(difficultyRank("Easy")).toBe(2);
    expect(difficultyRank("intermediate")).toBe(3);
    expect(difficultyRank("advanced")).toBe(4);
    expect(difficultyRank("expert")).toBe(5);
    expect(difficultyRank("freeride")).toBe(6);
    expect(difficultyRank("extreme")).toBe(6);
    expect(difficultyRank("black")).toBeUndefined();
    expect(difficultyRank(undefined)).toBeUndefined();
  });
});

describe("normalizeSki", () => {
  const fc = normalizeSki(fixture);

  it("turns the Chamonix fixture into lines: piste ways are LineStrings, route=ski relations MultiLineStrings", () => {
    const ways = fixture.elements.filter((e) => e.type === "way").length;
    const rels = fixture.elements.filter((e) => e.type === "relation").length;
    expect(fc.features).toHaveLength(ways + rels);
    expect(fc.features.filter((f) => f.properties?.route === true)).toHaveLength(rels);
    const route = fc.features.find((f) => f.properties?.name === "La Moraine");
    expect(route?.geometry.type).toBe("MultiLineString");
    expect(route?.properties).toMatchObject({ kind: "nordic", route: true, osmId: expect.stringMatching(/^relation\//) });
  });

  it("carries kind, the difficulty word and its rank as v, and grooming", () => {
    const run = fc.features.find((f) => f.properties?.name === "Charlanon");
    expect(run?.properties).toMatchObject({ kind: "downhill", difficulty: "intermediate", v: 3, grooming: "classic" });
    const freeride = fc.features.find((f) => f.properties?.name === "Couloir de Poubelle");
    expect(freeride?.properties).toMatchObject({ difficulty: "freeride", v: 6, grooming: "backcountry" });
  });

  it("prefers piste:name, reads ref, lit, status and check_date, and skips areas and plain ways", () => {
    const pts = [{ lat: 1, lon: 2 }, { lat: 1.1, lon: 2.1 }];
    const out = normalizeSki({
      elements: [
        {
          type: "way",
          id: 1,
          geometry: pts,
          tags: {
            "piste:type": "nordic",
            "piste:name": "Washoe",
            name: "Alder Creek Road",
            "piste:ref": "W1",
            "piste:lit": "yes",
            "piste:status": "open",
            "piste:difficulty": "weird",
            check_date: "2025-12-01",
          },
        },
        { type: "way", id: 2, geometry: pts, tags: { "piste:type": "downhill", area: "yes" } },
        { type: "way", id: 3, geometry: pts, tags: { highway: "track" } },
        { type: "way", id: 4, geometry: [pts[0]], tags: { "piste:type": "downhill" } },
      ],
    });
    expect(out.features).toHaveLength(1);
    expect(out.features[0].properties).toEqual({
      kind: "nordic",
      osmId: "way/1",
      name: "Washoe",
      ref: "W1",
      difficulty: "weird",
      status: "open",
      lit: true,
      t: "2025-12-01",
    });
  });

  it("draws route=ski and route=piste relations from clipped member ways, and drops a relation of another kind", () => {
    const pts = [{ lat: 46, lon: 7 }, { lat: 46.01, lon: 7.01 }];
    const body = {
      elements: [
        { type: "way", id: 1, tags: { highway: "track" }, geometry: pts },
        { type: "relation", id: 8, tags: { route: "piste", "piste:type": "nordic", name: "Loop" }, members: [{ type: "way", ref: 1 }] },
        { type: "relation", id: 9, tags: { route: "ski", name: "Tour" }, members: [{ type: "way", ref: 1 }] },
        { type: "relation", id: 10, tags: { route: "ski", "piste:type": "downhill" }, members: [{ type: "way", ref: 1 }] },
      ],
    };
    const all = normalizeSki(body);
    expect(all.features.map((f) => `${f.properties?.osmId}:${f.properties?.kind}`)).toEqual([
      "relation/8:nordic",
      "relation/9:route",
      "relation/10:downhill",
    ]);
    expect(all.features[0].geometry.type).toBe("LineString");
    const nordic = normalizeSki(body, "nordic");
    expect(nordic.features.map((f) => f.properties?.osmId)).toEqual(["relation/8", "relation/9"]);
  });

  it("returns nothing for a malformed body", () => {
    expect(normalizeSki(null).features).toHaveLength(0);
    expect(normalizeSki({ elements: "x" }).features).toHaveLength(0);
  });
});

describe("ski-routes layer", () => {
  it("declares global ODbL coverage, a 2,500 km2 cap and the activity words in its description", () => {
    expect(layer.coverage).toBe("global");
    expect(layer.license).toContain("ODbL");
    expect(layer.maxAreaKm2).toBe(2500);
    expect(layer.wide).toEqual({ mode: "named", orderBy: "length in km", limit: 1000 });
    expect(hardMaxAreaKm2(layer)).toBe(100_000);
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.optionalEnv).toContain("OVERPASS_URL");
    expect(layer.style.geometry).toBe("line");
    for (const word of ["ski touring", "backcountry skiing", "nordic"]) expect(layer.description).toContain(word);
  });

  it("posts one Overpass query and says how many of the box's pistes came back", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    const r = await layer.query(ctx(stub, "ski-routes:k"), DEFAULTS);
    expect(stub).toHaveBeenCalledTimes(1);
    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit & { cacheKey?: string }];
    expect(url).toBe("https://overpass-api.de/api/interpreter");
    expect(init.method).toBe("POST");
    expect(decodeURIComponent(String(init.body))).toContain('"piste:type"');
    expect(init.cacheKey).toBe("ski-routes:k:ski-routes");
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(16);
    expect(r.citation.source).toContain("OpenStreetMap");
    expect(r.coverageNote).toBe(
      "Showing 16 of 317 piste ways and routes in this box (lowest OpenStreetMap ids first); zoom in for the rest",
    );
  });

  it("says the box was not truncated when everything matched came back", async () => {
    const elements = fixture.elements.filter((e) => e.type !== "count");
    const stub = vi.fn(async () => new Response(JSON.stringify({ elements }), { status: 200 }));
    const r = await layer.query(ctx(stub), DEFAULTS);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toBe("Returned 16 piste ways and routes; the box was not truncated");
  });

  it("maps a failing Overpass to an upstream error after the fallback", async () => {
    const stub = vi.fn(async () => new Response("slow down", { status: 429 }));
    const r = await layer.query(ctx(stub), DEFAULTS);
    expect(r).toEqual({ error: "Overpass returned 429", hint: "upstream" });
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("returns 422 zoom_in from runLayer over the 100,000 km2 hard cap and 400 for a bad kind", async () => {
    // The western Alps, about 128,000 km².
    const big = await runLayer("ski-routes", { bbox: [5.5, 44.5, 10.5, 47.5] });
    expect(big.status).toBe(422);
    expect(big.body).toMatchObject({ hint: "zoom_in" });
    const bad = await runLayer("ski-routes", { bbox: CHAMONIX, input: { kind: "snowboard" } });
    expect(bad.status).toBe(400);
  });
});

// Valais and Aosta, about 8,700 km²: over the 2,500 km² soft cap, under the 100,000 km² hard cap.
const ALPS: [number, number, number, number] = [6.5, 45.5, 7.5, 46.3];

describe("ski-routes wide mode", () => {
  const count = (total: number) => ({ type: "count", id: 0, tags: { total: String(total) } });
  const bounds = (size: number) => ({ minlat: 45.9, minlon: 7, maxlat: 45.9 + size, maxlon: 7 + size });
  const scan = {
    elements: [count(7657), count(2), { type: "way", id: 1, bounds: bounds(0.01) }, { type: "relation", id: 2, bounds: bounds(0.3) }],
  };
  const line = (to: number) => [
    { lat: 45.9, lon: 7 },
    { lat: to, lon: 7 },
  ];
  const geometry = {
    elements: [
      { type: "way", id: 1, tags: { "piste:type": "nordic", "piste:name": "Piste des Lacs", "piste:difficulty": "easy" }, geometry: line(45.91) },
      { type: "relation", id: 2, tags: { route: "ski", name: "Haute Route", "piste:type": "skitour" }, members: [{ type: "way", ref: 9 }] },
      { type: "way", id: 9, geometry: line(46.2) },
    ],
  };

  it("scans named pistes and routes of the chosen kind, then returns the longest with every piste as total", async () => {
    const stub = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Response(JSON.stringify(decodeURIComponent(String(init?.body)).includes("out ids bb") ? scan : geometry), { status: 200 }),
    );
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("ski-routes", { bbox: ALPS, zoom: 8, input: { kind: "nordic" } });
      expect(res.status).toBe(200);
      const first = decodeURIComponent(String((stub.mock.calls[0][1] as RequestInit).body));
      expect(first).toContain('way["piste:type"="nordic"]["area"!="yes"](45.5,6.5,46.3,7.5);');
      expect(first).toContain('rel["route"~"^(ski|piste)$"][!"piste:type"](45.5,6.5,46.3,7.5);');
      expect(first).toContain('way.all["piste:name"];');
      expect(first).toContain(".named out count;rel.named->.nr;.nr out ids bb 5000;way.named->.nw;.nw out ids bb 5000;");
      if (!("kind" in res.body) || res.body.kind !== "geojson") throw new Error("expected geojson");
      // The skitour relation is dropped by the nordic filter, as on the normal path.
      expect(res.body.data.features.map((f) => f.properties?.name)).toEqual(["Piste des Lacs"]);
      expect(res.body).toMatchObject({
        total: 7657,
        truncated: true,
        coverageNote: "Showing the 1 named of 7,657 (ranked by length in km); zoom in under 2,500 km² for all",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("answers a ski region (Switzerland, about 76,000 km²) instead of asking to zoom in", async () => {
    const stub = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Response(JSON.stringify(decodeURIComponent(String(init?.body)).includes("out ids bb") ? scan : geometry), { status: 200 }),
    );
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("ski-routes", { bbox: [6, 45.8, 10.5, 47.8], zoom: 7 });
      expect(res.status).toBe(200);
      if (!("kind" in res.body) || res.body.kind !== "geojson") throw new Error("expected geojson");
      expect(res.body.data.features.map((f) => f.properties?.name)).toEqual(["Haute Route", "Piste des Lacs"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("puts the longest first and writes no note of its own", async () => {
    const stub = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Response(JSON.stringify(decodeURIComponent(String(init?.body)).includes("out ids bb") ? scan : geometry), { status: 200 }),
    );
    const r = await layer.query(
      { bbox: ALPS, zoom: 8, env: {}, fetch: stub as unknown as CachedFetch, wide: true, wideStrategy: layer.wide },
      DEFAULTS,
    );
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features.map((f) => f.properties?.name)).toEqual(["Haute Route", "Piste des Lacs"]);
    expect(r.data.features[0].properties).toMatchObject({ kind: "skitour", route: true });
    expect(r.total).toBe(7657);
    expect(r.coverageNote).toBeUndefined();
  });
});
