import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { buildFeaturesQuery, buildWideFeaturesQuery, classify, KINDS, normalizeFeatures } from "./outdoor-features";
import fixture from "./__fixtures__/outdoor-features.tahoe.json";

const TAHOE: [number, number, number, number] = [-120.3, 38.8, -119.9, 39.1];

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string) {
  return { bbox: TAHOE, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

function geojson(r: Awaited<ReturnType<typeof layer.query>>) {
  if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
  return r;
}

describe("buildFeaturesQuery", () => {
  it("makes one set per kind with a count and a capped listing, in (south,west,north,east) order", () => {
    const q = buildFeaturesQuery(TAHOE);
    for (const kind of KINDS) {
      expect(q).toContain(`)->.${kind};`);
      expect(q).toContain(`.${kind} out count;`);
      expect(q).toContain(`.${kind} out tags center ${kind === "peak" ? 2000 : 1000};`);
    }
    // Peaks with an elevation come first, then the ones without.
    expect(q).toContain('node["natural"="peak"]["name"]["ele"](38.8,-120.3,39.1,-119.9)');
    expect(q).toContain('node["natural"="peak"]["name"][!"ele"](38.8,-120.3,39.1,-119.9)');
    expect(q.indexOf(".peak out tags")).toBeLessThan(q.indexOf(".peak_noele out tags"));
    expect(q).toContain(".peak_noele out count;");
    expect(q).toContain(".peak_noele out tags center 1000;");
    expect(q).toContain('nwr["tourism"~"^(alpine_hut|wilderness_hut)$"](38.8,-120.3,39.1,-119.9)');
    expect(q).toContain('nwr["natural"="spring"](38.8,-120.3,39.1,-119.9)');
    expect(q).toContain('node["highway"="mountain_pass"]["name"]');
    expect(q).toContain('nwr["waterway"="waterfall"]');
    expect(q).toContain('nwr["natural"="cave_entrance"]');
    expect(q).toContain('nwr["natural"="hot_spring"]');
    expect(q).toContain('nwr["tourism"="viewpoint"]');
    expect(q).toContain('nwr["amenity"="drinking_water"]');
  });

  it("only includes the requested kinds", () => {
    const q = buildFeaturesQuery(TAHOE, ["hut", "spring"]);
    expect(q).toContain(".hut out count;");
    expect(q).toContain(".spring out tags center 1000;");
    expect(q).not.toContain("peak");
    expect(q).not.toContain("viewpoint");
  });
});

describe("classify", () => {
  it("maps tags to kinds, passes before saddles and peaks before viewpoints", () => {
    expect(classify({ tourism: "wilderness_hut" })).toBe("hut");
    expect(classify({ tourism: "alpine_hut" })).toBe("hut");
    expect(classify({ amenity: "shelter", shelter_type: "lean_to" })).toBe("shelter");
    expect(classify({ natural: "saddle", mountain_pass: "yes", name: "Echo Summit" })).toBe("pass");
    expect(classify({ natural: "saddle", name: "Col" })).toBe("saddle");
    expect(classify({ natural: "peak", tourism: "viewpoint", name: "Top" })).toBe("peak");
    expect(classify({ highway: "mountain_pass", name: "Donner Pass" })).toBe("pass");
  });

  it("drops bus and picnic shelters, and peaks, saddles and passes without a name", () => {
    expect(classify({ amenity: "shelter", shelter_type: "public_transport" })).toBeNull();
    expect(classify({ amenity: "shelter", bus: "yes" })).toBeNull();
    expect(classify({ amenity: "shelter", shelter_type: "picnic_shelter" })).toBeNull();
    expect(classify({ natural: "peak" })).toBeNull();
    expect(classify({ natural: "saddle" })).toBeNull();
    expect(classify({ mountain_pass: "yes" })).toBeNull();
  });

  it("only returns allowed kinds", () => {
    expect(classify({ natural: "peak", tourism: "viewpoint", name: "Top" }, ["viewpoint"])).toBe("viewpoint");
    expect(classify({ natural: "peak", name: "Top" }, ["hut"])).toBeNull();
  });
});

describe("normalizeFeatures", () => {
  const fc = normalizeFeatures(fixture);
  const of = (kind: string) => fc.features.filter((f) => f.properties?.kind === kind);

  it("turns the Tahoe fixture into one point per OSM element, each kind present and duplicates across sets removed", () => {
    const elements = fixture.elements.filter((e) => e.type !== "count");
    const ids = new Set(elements.map((e) => `${e.type}/${e.id}`));
    expect(elements.length).toBeGreaterThan(ids.size);
    expect(fc.features).toHaveLength(ids.size);
    expect(fc.features.every((f) => f.geometry.type === "Point")).toBe(true);
    for (const kind of ["hut", "shelter", "spring", "waterfall", "pass", "saddle", "peak", "viewpoint", "drinking_water"]) {
      expect(of(kind).length).toBeGreaterThan(0);
    }
  });

  it("gives peaks v = elevation, and passes and saddles ele without v", () => {
    const pyramid = of("peak").find((f) => f.properties?.name === "Pyramid Peak");
    expect(pyramid?.properties).toMatchObject({ ele: 3042.818, v: 3042.818, wikidata: "Q7263270" });
    const echo = of("pass").find((f) => f.properties?.name === "Echo Summit");
    expect(echo?.properties).toMatchObject({ ele: 2248.5, wikipedia: "en:Echo Summit" });
    expect(echo?.properties).not.toHaveProperty("v");
    expect(of("saddle").map((f) => f.properties?.name)).toEqual(["Armstrong Pass"]);
  });

  it("reads centres of ways, hut details, water potability and waterfall height", () => {
    const ludlow = of("hut").find((f) => f.properties?.name === "Ludlow Hut");
    expect(ludlow?.geometry.type).toBe("Point");
    expect(ludlow?.properties).toMatchObject({ osmId: "way/895647634", reservation: "required" });
    expect(of("spring").find((f) => f.properties?.name === "Glen Alpine Spring")?.properties).not.toHaveProperty("potable", false);
    expect(of("drinking_water")[0].properties).toMatchObject({ potable: true });
    expect(of("waterfall").find((f) => f.properties?.name === "Upper Pyramid Creek Cascade")?.properties).toMatchObject({ heightM: 13 });
  });

  it("parses capacity, fee, shelter type, check_date, feet elevations and the spring drinking_water tag", () => {
    const out = normalizeFeatures({
      elements: [
        {
          type: "node",
          id: 1,
          lat: 1,
          lon: 2,
          tags: { tourism: "alpine_hut", name: "Hut", beds: "12", fee: "yes", check_date: "2025-08-01", ele: "9000 ft" },
        },
        { type: "node", id: 2, lat: 1, lon: 2, tags: { amenity: "shelter", shelter_type: "lean_to", capacity: "6" } },
        { type: "node", id: 3, lat: 1, lon: 2, tags: { natural: "spring", drinking_water: "no", seasonal: "yes" } },
        { type: "way", id: 4, tags: { natural: "spring" } },
      ],
    });
    expect(out.features).toHaveLength(3);
    expect(out.features[0].properties).toMatchObject({ kind: "hut", capacity: 12, fee: true, t: "2025-08-01", ele: 2743.2 });
    expect(out.features[1].properties).toMatchObject({ kind: "shelter", shelterType: "lean_to", capacity: 6 });
    expect(out.features[2].properties).toMatchObject({ kind: "spring", potable: false, seasonal: "yes" });
  });

  it("returns nothing for a malformed body", () => {
    expect(normalizeFeatures(null).features).toHaveLength(0);
    expect(normalizeFeatures({ elements: "x" }).features).toHaveLength(0);
  });
});

describe("outdoor-features layer", () => {
  it("declares global ODbL coverage, a 10,000 km2 soft cap with a named wide mode to 1,500,000 km2, point style with 3D columns and clustering, and the activity words", () => {
    expect(layer.coverage).toBe("global");
    expect(layer.license).toContain("ODbL");
    expect(layer.maxAreaKm2).toBe(10_000);
    expect(layer.hardMaxAreaKm2).toBe(1_500_000);
    expect(layer.wide).toEqual({ mode: "named", limit: 2000 });
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.optionalEnv).toContain("OVERPASS_URL");
    expect(layer.style).toMatchObject({ geometry: "point", extrude: "v", cluster: true });
    for (const word of ["hut", "shelter", "spring", "water source", "viewpoint", "cave", "hot spring", "waterfall", "peak", "summit", "saddle", "pass"]) {
      expect(layer.description).toContain(word);
    }
  });

  it("posts one Overpass query, returns the points and says the box was truncated when counts exceed the listing", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    const r = geojson(await layer.query(ctx(stub, "outdoor-features:k"), {}));
    expect(stub).toHaveBeenCalledTimes(1);
    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit & { cacheKey?: string }];
    expect(url).toBe("https://overpass-api.de/api/interpreter");
    expect(init.method).toBe("POST");
    expect(init.cacheKey).toBe(`outdoor-features:k:outdoor-features:${KINDS.join(",")}`);
    expect(r.data.features).toHaveLength(normalizeFeatures(fixture).features.length);
    expect(r.citation.source).toContain("OpenStreetMap");
    expect(r.coverageNote).toMatch(/^Returned 30 outdoor features \(4 hut, 1 shelter, 4 spring, 4 waterfall, 4 pass, 1 saddle, 4 peak, 4 viewpoint, 4 drinking_water\); the box was truncated /);
    expect(r.coverageNote).toContain("holds 141 matches");
  });

  it("says the box was not truncated when everything matched came back", async () => {
    const elements = fixture.elements.filter((e) => e.type !== "count");
    const stub = vi.fn(async () => new Response(JSON.stringify({ elements }), { status: 200 }));
    const r = geojson(await layer.query(ctx(stub), { kinds: ["peak", "viewpoint"] }));
    expect(r.coverageNote).toMatch(/\(4 peak, 4 viewpoint\); the box was not truncated$/);
    expect(r.data.features.every((f) => f.properties?.kind === "peak" || f.properties?.kind === "viewpoint")).toBe(true);
    const [, init] = stub.mock.calls[0] as unknown as [string, RequestInit];
    expect(decodeURIComponent(String(init.body))).not.toContain("spring");
  });

  it("caps at 5,000 points, keeping huts first and the highest peaks, and says so", async () => {
    const elements = [
      ...Array.from({ length: 10 }, (_, i) => ({ type: "node", id: i + 1, lat: 39, lon: -120, tags: { tourism: "alpine_hut" } })),
      ...Array.from({ length: 5100 }, (_, i) => ({
        type: "node",
        id: 100 + i,
        lat: 39,
        lon: -120,
        tags: { natural: "peak", name: `P${i}`, ele: String(1000 + i) },
      })),
    ];
    const stub = vi.fn(async () => new Response(JSON.stringify({ elements }), { status: 200 }));
    const r = geojson(await layer.query(ctx(stub), {}));
    expect(r.data.features).toHaveLength(5000);
    expect(r.data.features.filter((f) => f.properties?.kind === "hut")).toHaveLength(10);
    const eles = r.data.features.flatMap((f) => (f.properties?.kind === "peak" ? [f.properties.v as number] : []));
    expect(Math.max(...eles)).toBe(1000 + 5099);
    expect(Math.min(...eles)).toBe(1000 + 5099 - 4989);
    expect(r.coverageNote).toContain("the box was truncated");
  });

  it("asks for the named elements of the requested kinds, peaks with or without an elevation, in a wide box", () => {
    const q = buildWideFeaturesQuery([5, 44, 14, 48], ["peak", "hut"]);
    expect(q).toContain('nwr["tourism"~"^(alpine_hut|wilderness_hut)$"](44,5,48,14)');
    expect(q).toContain('nwr["natural"="peak"](44,5,48,14)');
    expect(q).toContain('nwr.all["name"]->.named;');
    expect(q).not.toContain('"ele"');
    expect(q).not.toContain("spring");
  });

  it("folds kinds that share a key into one search in a wide box", () => {
    const q = buildWideFeaturesQuery([5, 44, 14, 48], KINDS);
    expect(q).toContain('nwr["natural"~"^(hot_spring|spring|cave_entrance|saddle|peak)$"](44,5,48,14)');
    expect(q).toContain('nwr["tourism"~"^(alpine_hut|wilderness_hut|viewpoint)$"](44,5,48,14)');
    expect(q).toContain('nwr["waterway"="waterfall"](44,5,48,14)');
    expect(q).toContain('nwr["amenity"="drinking_water"](44,5,48,14)');
    expect(q).toContain('node["mountain_pass"="yes"](44,5,48,14)');
    expect(q).toContain('nwr["amenity"="shelter"]');
    expect(q.match(/\(44,5,48,14\)/g)).toHaveLength(7);
    expect(q).toContain('(nwr.named["mountain_pass"="yes"];nwr.named["highway"="mountain_pass"];)->.pass;');
    expect(q).toContain(".all out count;");
    expect(q).toContain('(nwr.named["tourism"~"^(alpine_hut|wilderness_hut)$"];)->.hut;.hut out tags center 1000;');
    expect(q.indexOf(".hut out tags")).toBeLessThan(q.indexOf(".peak out tags"));
  });

  it("answers an Alps box wide through runLayer: named features, the count of all as total, and a per-kind note", async () => {
    const body = {
      elements: [
        { type: "count", id: 0, tags: { total: "98000" } },
        { type: "count", id: 0, tags: { total: "41000" } },
        { type: "node", id: 1, lat: 46, lon: 7, tags: { tourism: "alpine_hut", name: "Monte Rosa Hut" } },
        { type: "node", id: 2, lat: 45.8, lon: 6.9, tags: { natural: "peak", name: "Mont Blanc", ele: "4808" } },
        { type: "way", id: 3, center: { lat: 47, lon: 11 }, tags: { waterway: "waterfall", name: "Krimml Falls" } },
      ],
    };
    const stub = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("outdoor-features", { bbox: [5, 44, 14, 48], zoom: 6 });
      expect(res.status).toBe(200);
      expect(stub).toHaveBeenCalledTimes(1);
      const init = (stub.mock.calls[0] as unknown as [string, RequestInit])[1];
      expect(decodeURIComponent(String(init.body))).toContain(".hut out tags center 1000;");
      if (!("kind" in res.body) || res.body.kind !== "geojson") throw new Error("expected geojson");
      // Kind priority order: huts first, peaks last.
      expect(res.body.data.features.map((f) => f.properties?.kind)).toEqual(["hut", "waterfall", "peak"]);
      expect(res.body.total).toBe(98000);
      expect(res.body.truncated).toBe(true);
      expect(res.body.coverageNote).toBe("Showing the 3 named of 98,000; zoom in under 10,000 km² for all; By kind: 1 hut, 1 waterfall, 1 peak");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps huts ahead of peaks and the tallest fetched peaks when a wide answer passes 2,000", async () => {
    const elements = [
      { type: "count", id: 0, tags: { total: "9000" } },
      { type: "count", id: 0, tags: { total: "3000" } },
      ...Array.from({ length: 5 }, (_, i) => ({ type: "node", id: 5000 + i, lat: 46, lon: 7, tags: { tourism: "alpine_hut", name: `H${i}` } })),
      ...Array.from({ length: 2500 }, (_, i) => ({ type: "node", id: i + 1, lat: 46, lon: 7, tags: { natural: "peak", name: `P${i}`, ele: String(1000 + i) } })),
    ];
    const stub = vi.fn(async () => new Response(JSON.stringify({ elements }), { status: 200 }));
    const r = geojson(await layer.query({ ...ctx(stub), bbox: [5, 44, 14, 48], wide: true, wideStrategy: layer.wide }, {}));
    expect(r.data.features).toHaveLength(2000);
    expect(r.data.features.slice(0, 5).every((f) => f.properties?.kind === "hut")).toBe(true);
    expect(r.data.features[5].properties?.v).toBe(3499);
    expect(r.total).toBe(9000);
  });

  it("maps a failing Overpass to an upstream error after the fallback", async () => {
    const stub = vi.fn(async () => new Response("slow down", { status: 429 }));
    const r = await layer.query(ctx(stub), {});
    expect(r).toEqual({ error: "Overpass returned 429", hint: "upstream" });
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("returns 422 zoom_in from runLayer only over 1,500,000 km2 and 400 for an unknown kind", async () => {
    const big = await runLayer("outdoor-features", { bbox: [-130, 25, -65, 50] });
    expect(big.status).toBe(422);
    expect(big.body).toMatchObject({ hint: "zoom_in", error: expect.stringMatching(/under 1500000 km²$/) });
    const bad = await runLayer("outdoor-features", { bbox: TAHOE, input: { kinds: ["castle"] } });
    expect(bad.status).toBe(400);
  });
});
