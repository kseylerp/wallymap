import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { attributeGroups, chipAttribute } from "@/lib/render/attributes";
import { applyFilters } from "@/lib/render/filters";
import { normalizeFilters } from "@/lib/agent/renderInput";
import { cardContent } from "@/lib/render/card";
import { hardMaxAreaKm2 } from "./types";
import { cardTitle, contractProblems, legendOf, timeShapeOf } from "./contract";
import layer, { WIDE_LIMIT, bikesAllowed, buildMtbQuery, imbaScale, mtbScale, normalizeMtb, riderLevels } from "./mtb-trails";
import fixture from "./__fixtures__/mtb-trails.truckee.json";
import moab from "./__fixtures__/mtb-trails.moab.json";
import sedona from "./__fixtures__/mtb-trails.sedona.json";

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

  it("makes v the IMBA color: the IMBA rating where tagged (Matt's Trail S1, IMBA 2 is blue), else Singletrack converted", () => {
    const matt = fc.features.find((f) => f.properties?.name === "Matt's Trail");
    expect(matt?.properties).toMatchObject({ kind: "mtb", v: 2, singletrack: 1, imba: 2, highway: "path", surface: "ground" });
    const imbaOnly = fc.features.find((f) => f.properties?.name === "Springboard");
    expect(imbaOnly?.properties).toMatchObject({ kind: "imba", imba: 2, v: 2 });
    expect(imbaOnly?.properties).not.toHaveProperty("singletrack");
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

  it("gives a named route its length in view, its full length and its rating when tagged, as a way gets its length", () => {
    const a = [{ lat: 38.6, lon: -109.5 }, { lat: 38.6, lon: -109.4 }];
    const b = [{ lat: 38.6, lon: -109.4 }, { lat: 38.65, lon: -109.3 }];
    const out = normalizeMtb({
      elements: [
        { type: "way", id: 1, tags: { "mtb:scale": "2", name: "Rocky" }, geometry: a },
        { type: "way", id: 2, tags: { highway: "track" }, geometry: a },
        { type: "way", id: 3, tags: { highway: "track" }, geometry: b },
        {
          type: "relation",
          id: 9,
          tags: { route: "mtb", name: "Kokopelli's Trail", distance: "228", "mtb:scale": "2" },
          members: [{ type: "way", ref: 2 }, { type: "way", ref: 3 }],
        },
      ],
    });
    const way = out.features.find((f) => f.properties?.osmId === "way/1");
    const route = out.features.find((f) => f.properties?.osmId === "relation/9");
    if (!way || !route) throw new Error("expected the way and the route");
    expect(way.properties?.lengthKm).toBeCloseTo(8.7, 1);
    expect(route.properties).toMatchObject({ kind: "route", distanceKm: 228, singletrack: 2 });
    expect(route.properties?.inViewKm).toBeGreaterThan(17);
    const card = cardContent(route, { card: layer.card, fieldHelp: layer.fieldHelp });
    const facts = Object.fromEntries(card.facts.map((r) => [r.label, r.value]));
    expect(facts).toMatchObject({ Kind: "Named route", "Singletrack Scale": "S2, moderate: bigger roots and steps, tighter turns.", "Full length": "228 km" });
    expect(facts["Length in view"]).toMatch(/^1\d(\.\d)? km$/);
    const wayCard = cardContent(way, { card: layer.card, fieldHelp: layer.fieldHelp });
    expect(wayCard.facts.find((r) => r.label === "Length")?.value).toMatch(/^8(\.\d)? km$/);
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
    expect(layer.wide).toEqual({ mode: "named", orderBy: "length in km", limit: 1000 });
    expect(hardMaxAreaKm2(layer)).toBe(100_000);
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
      "Showing 15 of 152 rated trail ways and routes in this box (lowest OpenStreetMap ids first); zoom in for the rest. 1 line is a named route with no difficulty of its own, which a difficulty filter (v, level) leaves out",
    );
  });

  it("says the box was not truncated when everything matched came back", async () => {
    const elements = fixture.elements.filter((e) => e.type !== "count");
    const stub = vi.fn(async () => new Response(JSON.stringify({ elements }), { status: 200 }));
    const r = await layer.query(ctx(stub), DEFAULTS);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toBe("Returned 15 rated trail ways and routes; the box was not truncated. 1 line is a named route with no difficulty of its own, which a difficulty filter (v, level) leaves out");
  });

  it("keeps trails at or under maxScale (IMBA-only ones by their IMBA rating), plus routes", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    const r = await layer.query(ctx(stub), { includeRoutes: true, maxScale: 0 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    // maxScale reads the Singletrack Scale (an IMBA-only way by its IMBA number), not the IMBA color in v.
    const vs = r.data.features.flatMap((f) => {
      const x = f.properties?.singletrack ?? f.properties?.imba;
      return typeof x === "number" ? [x] : [];
    });
    expect(vs.length).toBeGreaterThan(0);
    expect(Math.max(...vs)).toBe(0);
    expect(r.data.features.some((f) => f.properties?.kind === "route")).toBe(true);
    // The note counts what is left after the filter and names it.
    expect(r.coverageNote).toMatch(/^Showing \d+ of 152 rated trail ways and routes in this box \(lowest OpenStreetMap ids first after the difficulty limit hid \d+\)/);
  });

  it("counts the filtered result in the note when nothing was truncated", async () => {
    const elements = fixture.elements.filter((e) => e.type !== "count");
    const stub = vi.fn(async () => new Response(JSON.stringify({ elements }), { status: 200 }));
    const r = await layer.query(ctx(stub), { includeRoutes: true, maxScale: 0 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toBe(`Returned ${r.data.features.length} rated trail ways and routes after the difficulty limit hid ${15 - r.data.features.length}; the box was not truncated. 1 line is a named route with no difficulty of its own, which a difficulty filter (v, level) leaves out`);
  });

  it("maps a failing Overpass to an upstream error after the fallback", async () => {
    const stub = vi.fn(async () => new Response("slow down", { status: 429 }));
    const r = await layer.query(ctx(stub), DEFAULTS);
    expect(r).toEqual({ error: "Overpass returned 429", hint: "upstream" });
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("returns 422 zoom_in from runLayer for a bbox over the 100,000 km2 hard cap and 400 for a bad input", async () => {
    // Utah and Colorado, about 290,000 km².
    const big = await runLayer("mtb-trails", { bbox: [-112, 36, -106, 41] });
    expect(big.status).toBe(422);
    expect(big.body).toMatchObject({ hint: "zoom_in" });
    const bad = await runLayer("mtb-trails", { bbox: TRUCKEE, input: { maxScale: 9 } });
    expect(bad.status).toBe(400);
  });
});

// Central Utah, about 9,700 km²: over the 2,500 km² soft cap, under the 100,000 km² hard cap.
const UTAH: [number, number, number, number] = [-112.5, 38, -111.5, 39];

describe("mtb-trails wide mode", () => {
  const count = (total: number) => ({ type: "count", id: 0, tags: { total: String(total) } });
  const bounds = (lat: number, size: number) => ({ minlat: lat, minlon: -112, maxlat: lat + size, maxlon: -112 + size });
  const scan = {
    elements: [
      count(72),
      count(3),
      { type: "way", id: 11, bounds: bounds(38.5, 0.01) },
      { type: "way", id: 12, bounds: bounds(38.5, 0.1) },
      { type: "relation", id: 21, bounds: bounds(38.2, 0.6) },
    ],
  };
  const line = (from: number, to: number) => [
    { lat: from, lon: -112 },
    { lat: to, lon: -112 },
  ];
  const geometry = {
    elements: [
      { type: "way", id: 11, tags: { name: "Short", "mtb:scale": "3" }, geometry: line(38.5, 38.51) },
      { type: "way", id: 12, tags: { name: "Long", "mtb:scale:imba": "2" }, geometry: line(38.5, 38.6) },
      { type: "relation", id: 21, tags: { route: "mtb", name: "Big Loop" }, members: [{ type: "way", ref: 31, role: "" }] },
      { type: "way", id: 31, geometry: line(38.2, 38.8) },
    ],
  };
  const respond = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    new Response(JSON.stringify(decodeURIComponent(String(init?.body)).includes("out ids bb") ? scan : geometry), { status: 200 }),
  );

  it("answers through runLayer with the longest named trails, every rated way as total and run.ts's note", async () => {
    respond.mockClear();
    vi.stubGlobal("fetch", respond);
    try {
      const res = await runLayer("mtb-trails", { bbox: UTAH, zoom: 8 });
      expect(res.status).toBe(200);
      const bodies = respond.mock.calls.map((c) => decodeURIComponent(String((c[1] as RequestInit).body)));
      expect(bodies[0]).toContain('way["mtb:scale"](38,-112.5,39,-111.5);');
      expect(bodies[0]).toContain('(way.all["name"];rel.all["name"];)->.named;.named out count;rel.named->.nr;.nr out ids bb 5000;way.named->.nw;.nw out ids bb 5000;');
      expect(bodies[1]).toContain("way(id:12,11);out tags geom;rel(id:21)->.r;");
      if (!("kind" in res.body) || res.body.kind !== "geojson") throw new Error("expected geojson");
      expect(res.body.data.features.map((f) => f.properties?.name)).toEqual(["Big Loop", "Long", "Short"]);
      expect(res.body.data.features.map((f) => f.properties?.kind)).toEqual(["route", "imba", "mtb"]);
      expect(res.body).toMatchObject({
        total: 72,
        truncated: true,
        coverageNote: "Showing the 3 named of 72 (ranked by length in km); zoom in under 2,500 km² for all; 1 line is a named route with no difficulty of its own, which a difficulty filter (v, level) leaves out",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("answers a regional box (south-east Utah, about 72,500 km²) instead of asking to zoom in", async () => {
    respond.mockClear();
    vi.stubGlobal("fetch", respond);
    try {
      const res = await runLayer("mtb-trails", { bbox: [-112, 37, -109, 39.5], zoom: 7 });
      expect(res.status).toBe(200);
      if (!("kind" in res.body) || res.body.kind !== "geojson") throw new Error("expected geojson");
      expect(res.body.data.features.map((f) => f.properties?.name)).toEqual(["Big Loop", "Long", "Short"]);
      expect(res.body.coverageNote).toMatch(/^Showing the 3 named of 72 \(ranked by length in km\)/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the limit, applies maxScale and says what it hid", async () => {
    respond.mockClear();
    const r = await layer.query(
      { bbox: UTAH, zoom: 8, env: {}, fetch: respond as unknown as CachedFetch, wide: true, wideStrategy: { mode: "named", limit: 2 } },
      { includeRoutes: true, maxScale: 2 },
    );
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(WIDE_LIMIT).toBe(1000);
    // The limit of 2 picks the relation and the long way; the short one is never fetched.
    expect(decodeURIComponent(String((respond.mock.calls[1][1] as RequestInit).body))).toContain("way(id:12);");
    expect(r.data.features.map((f) => f.properties?.name)).toEqual(["Big Loop", "Long"]);
    expect(r.total).toBe(72);
    expect(r.coverageNote).toBe("1 line is a named route with no difficulty of its own, which a difficulty filter (v, level) leaves out");

    const scaled = await layer.query(
      { bbox: UTAH, zoom: 8, env: {}, fetch: respond as unknown as CachedFetch, wide: true, wideStrategy: layer.wide },
      { includeRoutes: false, maxScale: 2 },
    );
    if (!("kind" in scaled) || scaled.kind !== "geojson") throw new Error("expected geojson");
    expect(scaled.coverageNote).toBe("The difficulty limit hid 1 of the named trails; 1 line is a named route with no difficulty of its own, which a difficulty filter (v, level) leaves out");
  });
});

describe("mtb-trails near Moab: ratings in words, IMBA-only trails on the ramp, and whether bikes are allowed", () => {
  const fc = normalizeMtb(moab);
  const card = (name: string | undefined) => {
    const f = fc.features.find((x) => x.properties?.name === name);
    if (!f) throw new Error(`expected ${name}`);
    return cardContent(f, { card: layer.card, fieldHelp: layer.fieldHelp });
  };
  const rows = (c: ReturnType<typeof card>) => c.facts.map((r) => `${r.label}: ${r.value}`);

  it("shows Slickrock's Singletrack grade and IMBA color in words with no bare number, and that bikes are allowed", () => {
    const c = card("Slickrock");
    expect(c.measure).toBeNull();
    expect(rows(c)).toEqual(
      expect.arrayContaining([
        "Singletrack Scale: S3, hard: blocks, high steps, switchbacks, slippery sections.",
        "IMBA color: Black diamond, difficult (IMBA 3)",
        "Bikes: Allowed, signed as a bike trail",
      ]),
    );
    expect([...c.facts, ...c.details].some((r) => r.value.includes("way/"))).toBe(false);
  });

  it("puts an IMBA-only trail in the difficulty chips by its IMBA color, so few lines read unrated", () => {
    expect(fc.features.map((f) => f.properties?.v)).toEqual([3, 3, 1]);
    const v = layer.attributes?.find((a) => a.key === "v");
    if (!v) throw new Error("expected the difficulty attribute");
    expect(attributeGroups(v, fc).map((g) => `${g.label} ${g.count}`)).toEqual(["Green 1", "Black 2"]);
    expect(rows(card("Cliff Hanger Trail"))).toEqual(expect.arrayContaining(["IMBA color: Black diamond, difficult (IMBA 3)", "Bikes: Allowed", "Kind: IMBA rated only"]));
  });

  it("titles an unnamed segment by what it is, not by its rating", () => {
    const unnamed = fc.features.find((f) => f.properties?.name === undefined);
    if (!unnamed) throw new Error("expected an unnamed track");
    expect(cardTitle(layer, unnamed)).toBe("Unnamed track");
  });

  it("reads bikes from the bicycle tag, else an access tag that closes the trail", () => {
    expect(bikesAllowed({ bicycle: "no" })).toBe("no");
    expect(bikesAllowed({ access: "private" })).toBe("private");
    expect(bikesAllowed({ access: "no", bicycle: "permissive" })).toBe("permissive");
    expect(bikesAllowed({ access: "yes" })).toBeUndefined();
  });

  it("declares no time, a difficulty legend that names the unrated routes, and labels by name", () => {
    expect(contractProblems(layer)).toEqual([]);
    expect(timeShapeOf(layer, fc)).toEqual({ shape: "none" });
    expect(legendOf(layer).items?.map((i) => i.label)).toEqual([
      "Green: IMBA white or green circle, or Singletrack S0",
      "Blue: IMBA blue square, or Singletrack S1 to S2",
      "Black: IMBA black diamond, or Singletrack S3",
      "Double black: IMBA double black diamond, or Singletrack S4 to S6",
      "Named route, not rated",
    ]);
    expect(layer.labels).toEqual({ field: "name", max: 8, rankBy: "v" });
  });
});

describe("mtb-trails in Sedona: IMBA colors as chips, and 'intermediate' as IMBA blue or Singletrack 1 to 2 (UC05)", () => {
  // Recorded 2026-10-23 from Overpass (Sedona, -111.95,34.75 to -111.65,34.95), trimmed to 7 rated ways, one route and
  // two of its member ways, 6 vertices each.
  const fc = normalizeMtb(sedona);
  const names = (x: { features: { properties: Record<string, unknown> | null }[] }) => x.features.map((f) => String(f.properties?.name)).sort();
  const props = (name: string) => fc.features.find((f) => f.properties?.name === name)?.properties ?? {};

  it("offers one difficulty chip set in IMBA colors (mtb:scale:imba 0 to 4, else Singletrack converted) on v, the row's chip set", () => {
    const imba = layer.attributes?.find((a) => a.key === "v");
    expect(imba).toMatchObject({ type: "ordinal", primary: true, encode: "color" });
    expect(layer.attributes?.some((a) => a.key === "imba")).toBe(false);
    expect(chipAttribute(layer)?.key).toBe("v");
    expect(imba?.levels?.map((l) => `${l.value} ${l.label}`)).toEqual([
      "0 Green",
      "1 Green",
      "2 Blue",
      "3 Black",
      "4 Double black",
    ]);
    // OK Trail (S1 only) is blue and Airport Loop (S3 only) black by conversion; the route has no color.
    expect(attributeGroups(imba!, fc).map((g) => `${g.label} ${g.count}`)).toEqual(["Green 1", "Blue 4", "Black 2"]);
  });

  it("keeps every IMBA-blue trail on v = 2, Grand Central (Singletrack 3, IMBA blue) included, and an S1-only trail by conversion", () => {
    expect(names(applyFilters(fc, { v: { include: ["2"] } }))).toEqual(["Andante Trail", "Grand Central Trail", "OK Trail", "Phone Trail Extension"]);
    // The model's words land on the values: "blue" is 2, "green" 0 and 1, the label key Difficulty is v.
    const include = (words: string[]) => (normalizeFilters({ Difficulty: { include: words } }, layer.attributes ?? []).v as { include: string[] }).include;
    expect(include(["blue"])).toEqual(["2"]);
    expect(include(["Green"])).toEqual(["0", "1"]);
    expect(include(["Black", "Double black"])).toEqual(["3", "4"]);
  });

  it("puts a trail at every level either scale gives, so level = intermediate is IMBA blue or Singletrack 1 to 2", () => {
    expect(props("Grand Central Trail").level).toEqual(["intermediate", "advanced"]);
    expect(props("Bell Rock Pathway").level).toEqual(["beginner", "intermediate"]);
    const kept = applyFilters(fc, { level: { include: ["intermediate"] } });
    expect(names(kept)).toEqual(["Andante Trail", "Bell Rock Pathway", "Grand Central Trail", "OK Trail", "Phone Trail Extension"]);
    for (const f of kept.features) {
      const st = f.properties?.singletrack as number | undefined;
      expect(f.properties?.imba === 2 || (st !== undefined && st >= 1 && st <= 2)).toBe(true);
    }
    expect(riderLevels(undefined, undefined)).toEqual([]);
    expect(riderLevels(5, 4)).toEqual(["expert"]);
    expect(riderLevels(0, undefined)).toEqual(["beginner"]);
  });

  it("names the IMBA color and the Singletrack grade in words on the card, and keeps the level list off it", () => {
    const f = fc.features.find((x) => x.properties?.name === "Grand Central Trail")!;
    const c = cardContent(f, { card: layer.card, fieldHelp: layer.fieldHelp });
    const rows = c.facts.map((r) => `${r.label}: ${r.value}`);
    expect(rows).toEqual(
      expect.arrayContaining(["IMBA color: Blue square, intermediate (IMBA 2)", "Singletrack Scale: S3, hard: blocks, high steps, switchbacks, slippery sections."]),
    );
    expect([...c.facts, ...c.details].map((r) => r.key)).not.toContain("level");
  });

  it("says in the note how many lines a difficulty filter leaves out, and tells the model which key each word filters", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(sedona), { status: 200 }));
    const r = await layer.query({ ...ctx(stub), bbox: [-111.95, 34.75, -111.65, 34.95] }, DEFAULTS);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features.filter((f) => !Array.isArray(f.properties?.level)).map((f) => f.properties?.name)).toEqual(["Flagstaff Sedona MTB Trail"]);
    expect(r.coverageNote).toContain("1 line is a named route with no difficulty of its own, which a difficulty filter (v, level) leaves out");
    expect(layer.description).toContain("a trail color is render.filters v (blue = [2]");
    expect(layer.description).toContain("'intermediate' is v = [2], or level = intermediate");
  });
});
