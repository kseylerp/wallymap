import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
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
    expect(q).toContain('rel["route"="ski"](45.85,6.8,46,7.05)');
    expect(q).toContain(".w out count;");
    expect(q).toContain(".w out tags geom 2000;");
    expect(q).toContain(".r out geom 50;");
  });

  it("filters ways and relations to one kind", () => {
    const q = buildSkiQuery(CHAMONIX, { kind: "nordic", includeRoutes: true });
    expect(q).toContain('way["piste:type"="nordic"]');
    expect(q).toContain('rel["route"="ski"]["piste:type"="nordic"]');
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

  it("has no coverage note when everything matched came back", async () => {
    const elements = fixture.elements.filter((e) => e.type !== "count");
    const stub = vi.fn(async () => new Response(JSON.stringify({ elements }), { status: 200 }));
    const r = await layer.query(ctx(stub), DEFAULTS);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toBeUndefined();
  });

  it("maps a failing Overpass to an upstream error after the fallback", async () => {
    const stub = vi.fn(async () => new Response("slow down", { status: 429 }));
    const r = await layer.query(ctx(stub), DEFAULTS);
    expect(r).toEqual({ error: "Overpass returned 429", hint: "upstream" });
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("returns 422 zoom_in from runLayer over 2,500 km2 and 400 for a bad kind", async () => {
    const big = await runLayer("ski-routes", { bbox: [6, 45, 8, 46.5] });
    expect(big.status).toBe(422);
    expect(big.body).toMatchObject({ hint: "zoom_in" });
    const bad = await runLayer("ski-routes", { bbox: CHAMONIX, input: { kind: "snowboard" } });
    expect(bad.status).toBe(400);
  });
});
