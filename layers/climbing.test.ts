import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, {
  buildClimbingQuery,
  gradeSummary,
  mergeCrags,
  dedupeSameName,
  openbetaBody,
  openbetaCrags,
  osmCrags,
  osmGradeSummary,
  osmRouteCount,
} from "./climbing";
import osmFixture from "./__fixtures__/climbing.rrg.osm.json";
import openbetaFixture from "./__fixtures__/climbing.rrg.openbeta.json";

const RRG: [number, number, number, number] = [-83.7, 37.75, -83.55, 37.85];
const DEFAULTS = { includeGyms: false };

function reply(osm: unknown, openbeta: unknown, status = { osm: 200, openbeta: 200 }) {
  return vi.fn(async (url: string) =>
    url.includes("openbeta")
      ? new Response(JSON.stringify(openbeta), { status: status.openbeta })
      : new Response(JSON.stringify(osm), { status: status.osm }),
  );
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string) {
  return { bbox: RRG, zoom: 12, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

function geojson(r: Awaited<ReturnType<typeof layer.query>>) {
  if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
  return r;
}

describe("requests", () => {
  it("asks Overpass for sport=climbing places that are not single routes, in (south,west,north,east) order", () => {
    const q = buildClimbingQuery(RRG);
    expect(q).toContain('nwr["sport"="climbing"]["climbing"!~"^(route|route_bottom|route_top)$"](37.75,-83.7,37.85,-83.55)');
    expect(q).toContain(".c out count;");
    expect(q).toContain(".c out tags center 3000;");
  });

  it("asks OpenBeta for crags within the box at zoom 12 (west,south,east,north)", () => {
    const body = JSON.parse(openbetaBody(RRG));
    expect(body.variables).toEqual({ f: { bbox: [-83.7, 37.75, -83.55, 37.85], zoom: 12 } });
    expect(body.query).toContain("cragsWithin(filter:$f)");
    expect(body.query).toContain("totalClimbs");
  });
});

describe("grade and count parsing", () => {
  it("summarises OpenBeta grade counts as a YDS range and a V range", () => {
    expect(
      gradeSummary([
        { label: "5.13b", count: 1 },
        { label: "5.7", count: 4 },
        { label: "5.10d", count: 1 },
        { label: "5.10b", count: 1 },
        { label: "5.9+", count: 1 },
        { label: "V4", count: 1 },
        { label: "V0-", count: 2 },
      ]),
    ).toBe("5.7 to 5.13b; V0- to V4");
    expect(gradeSummary([{ label: "5.8", count: 2 }])).toBe("5.8");
    expect(gradeSummary([{ label: "6a", count: 1 }])).toBeUndefined();
    expect(gradeSummary(null)).toBeUndefined();
  });

  it("summarises OSM grade tags, preferring YDS over French over UIAA", () => {
    expect(osmGradeSummary({ "climbing:grade:uiaa:min": "3", "climbing:grade:uiaa:max": "10+" })).toBe("3 to 10+ (uiaa)");
    expect(
      osmGradeSummary({
        "climbing:grade:uiaa:min": "3",
        "climbing:grade:yds_class:min": "5.6",
        "climbing:grade:yds_class:max": "5.12a",
      }),
    ).toBe("5.6 to 5.12a (yds_class)");
    expect(osmGradeSummary({ name: "x" })).toBeUndefined();
  });

  it("counts OSM routes from climbing:routes, else the numeric discipline counts", () => {
    expect(osmRouteCount({ "climbing:routes": "57", "climbing:sport": "12" })).toBe(57);
    expect(osmRouteCount({ "climbing:sport": "12", "climbing:trad": "5", "climbing:boulder": "yes" })).toBe(17);
    expect(osmRouteCount({ "climbing:sport": "yes" })).toBeUndefined();
    expect(osmRouteCount({})).toBeUndefined();
  });
});

describe("osmCrags", () => {
  it("turns the Red River Gorge fixture into points with v from climbing:routes and the grade range", () => {
    const crags = osmCrags(osmFixture, false);
    expect(crags).toHaveLength(14);
    const long = crags.find((c) => c.props.name === "Long Wall");
    expect(long?.position).toEqual([expect.any(Number), 37.8477001]);
    expect(long?.props).toMatchObject({
      kind: "crag",
      source: "osm",
      v: 57,
      grades: "4 to 10+ (uiaa)",
      // UIAA 4 is Beginner and 10+ Elite, so the wall spans every band; the original grades stay on the card.
      gradeBands: ["beginner", "intermediate", "advanced", "elite"],
      disciplines: ["sport", "trad", "boulder"],
      maxLengthM: 42.67,
    });
  });

  it("classifies boulders, areas and cliffs, centers ways, and drops routes, gyms (unless asked) and other sport=climbing things", () => {
    const body = {
      elements: [
        { type: "node", id: 1, lat: 1, lon: 2, tags: { sport: "climbing", climbing: "boulder", name: "B", check_date: "2025-01-02" } },
        { type: "node", id: 2, lat: 1, lon: 2, tags: { sport: "climbing", climbing: "area" } },
        { type: "way", id: 3, center: { lat: 3, lon: 4 }, tags: { sport: "climbing", natural: "cliff" } },
        { type: "node", id: 4, lat: 1, lon: 2, tags: { sport: "climbing", climbing: "route_bottom" } },
        { type: "way", id: 5, center: { lat: 5, lon: 6 }, tags: { sport: "climbing", leisure: "sports_centre", name: "Gym" } },
        { type: "node", id: 6, lat: 1, lon: 2, tags: { sport: "climbing", shop: "sports" } },
        { type: "way", id: 7, tags: { sport: "climbing", natural: "cliff" } },
        { type: "node", id: 8, lat: 1, lon: 2, tags: { climbing: "crag" } },
      ],
    };
    const kinds = (c: ReturnType<typeof osmCrags>) => c.map((x) => `${x.props.osmId}:${x.props.kind}`);
    expect(kinds(osmCrags(body, false))).toEqual(["node/1:boulder", "node/2:area", "way/3:crag"]);
    expect(kinds(osmCrags(body, true))).toEqual(["node/1:boulder", "node/2:area", "way/3:crag", "way/5:gym"]);
    expect(osmCrags(body, false)[0].props).toMatchObject({ name: "B", t: "2025-01-02" });
    expect(osmCrags(body, false)[2].position).toEqual([4, 3]);
  });

  it("returns nothing for a malformed body", () => {
    expect(osmCrags(null, false)).toEqual([]);
    expect(osmCrags({ elements: "x" }, false)).toEqual([]);
  });
});

describe("openbetaCrags", () => {
  const crags = openbetaCrags(openbetaFixture) ?? [];

  it("turns the fixture into points with v = totalClimbs, an OpenBeta link, region, grades and discipline totals", () => {
    expect(crags).toHaveLength(12);
    const gv = crags.find((c) => c.props.name === "Global Village");
    expect(gv?.position).toEqual([-83.65731, 37.75161]);
    expect(gv?.props).toMatchObject({
      kind: "crag",
      source: "openbeta",
      v: 18,
      region: "Kentucky > Red River Gorge > Natural Bridge Region",
      sport: 8,
      trad: 6,
      boulder: 4,
      url: "https://openbeta.io/areas/d126636f-b705-5f9e-876f-45b7169da5c9",
    });
    expect(gv?.props.grades).toMatch(/^5\.\d/);
  });

  it("marks boulders and non-leaf areas, and rejects a GraphQL error body", () => {
    const body = {
      data: {
        cragsWithin: [
          { uuid: "a", area_name: "Boulders", totalClimbs: 3, metadata: { lat: 1, lng: 2, leaf: true, isBoulder: true } },
          { uuid: "b", area_name: "Region", totalClimbs: null, metadata: { lat: 1, lng: 2, leaf: false, isBoulder: false } },
        ],
      },
    };
    expect(openbetaCrags(body)?.map((c) => c.props.kind)).toEqual(["boulder", "area"]);
    expect(openbetaCrags({ errors: [{ message: "boom" }] })).toBeNull();
    expect(openbetaCrags(null)).toBeNull();
  });
});

describe("mergeCrags", () => {
  const osm = osmCrags(osmFixture, false);
  const ob = openbetaCrags(openbetaFixture) ?? [];

  it("merges an OpenBeta crag into the OSM crag of the same name within 500 m and keeps the larger route count", () => {
    const { crags, both } = mergeCrags(osm, ob);
    const long = crags.find((c) => c.props.name === "Long Wall");
    expect(long?.props).toMatchObject({
      source: "osm+openbeta",
      v: 57,
      sport: expect.any(Number),
      url: "https://openbeta.io/areas/" + long?.props.openbetaId,
    });
    expect(long?.props.osmId).toBe("node/7313037395");
    expect(both).toBeGreaterThanOrEqual(5);
    expect(crags).toHaveLength(osm.length + ob.length - both);
    // OpenBeta-only crags stay.
    expect(crags.find((c) => c.props.name === "Emerald City")?.props.source).toBe("openbeta");
  });

  it("does not merge crags 200 m apart with different names or 1 km apart with the same name; merges within 50 m regardless of name", () => {
    const a = { position: [0, 0] as [number, number], props: { kind: "crag", name: "Wall", source: "osm" } };
    const near = { position: [0.002, 0] as [number, number], props: { kind: "crag", name: "Boulders", source: "openbeta", v: 5 } };
    const far = { position: [0.01, 0] as [number, number], props: { kind: "crag", name: "Wall", source: "openbeta", v: 5 } };
    expect(mergeCrags([a], [near]).crags).toHaveLength(2);
    expect(mergeCrags([a], [far]).crags).toHaveLength(2);
    const close = { position: [0.0005, 0] as [number, number], props: { kind: "crag", name: "Other", source: "openbeta", v: 5 } };
    const merged = mergeCrags([a], [close]);
    expect(merged.crags).toHaveLength(1);
    expect(merged.both).toBe(1);
  });

  it("lets each OSM crag absorb only one OpenBeta crag", () => {
    const a = { position: [0, 0] as [number, number], props: { kind: "crag", name: "Cliff", source: "osm" } };
    const b1 = { position: [0.0002, 0] as [number, number], props: { kind: "crag", name: "Cliff Left", source: "openbeta", v: 1 } };
    const b2 = { position: [0.0003, 0] as [number, number], props: { kind: "crag", name: "Cliff Right", source: "openbeta", v: 2 } };
    expect(mergeCrags([a], [b1, b2]).crags).toHaveLength(2);
  });
});

describe("climbing layer", () => {
  it("declares global coverage, a 10,000 km2 soft cap ranked by route count above it, 3D and heat hints and the activity words", () => {
    expect(layer.coverage).toBe("global");
    expect(layer.license).toContain("ODbL");
    expect(layer.maxAreaKm2).toBe(10_000);
    expect(layer.hardMaxAreaKm2).toBeUndefined();
    expect(layer.wide).toEqual({ orderBy: "route count", limit: 1000 });
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.style).toMatchObject({ geometry: "point", extrude: "v", heat: true });
    for (const word of ["bouldering", "crag", "OpenBeta"]) expect(layer.description).toContain(word);
  });

  it("queries both sources once, merges them and reports counts and no truncation", async () => {
    // The recorded Overpass body is a 14-element excerpt of a 39-element box; drop its count so this is a complete answer.
    const stub = reply({ elements: osmFixture.elements.filter((e) => e.type !== "count") }, openbetaFixture);
    const r = geojson(await layer.query(ctx(stub, "climbing:k"), DEFAULTS));
    expect(stub).toHaveBeenCalledTimes(2);
    const calls = stub.mock.calls as unknown as [string, RequestInit & { cacheKey?: string }][];
    const ob = calls.find(([u]) => u === "https://api.openbeta.io/");
    const op = calls.find(([u]) => u === "https://overpass-api.de/api/interpreter");
    expect(ob?.[1].method).toBe("POST");
    expect(ob?.[1].cacheKey).toBe("climbing:k:openbeta");
    expect(op?.[1].cacheKey).toBe("climbing:k:climbing");
    expect(r.data.features.length).toBeGreaterThan(14);
    expect(r.data.features.every((f) => f.geometry.type === "Point")).toBe(true);
    expect(r.coverageNote).toMatch(/^Returned \d+ climbing places \(14 from OpenStreetMap, 12 from OpenBeta, \d+ in both\); the box was not truncated$/);
    expect(r.citation.source).toBe("OpenStreetMap contributors (ODbL, openstreetmap.org/copyright) and OpenBeta (openbeta.io)");
  });

  it("says the box was truncated when Overpass counted more than it returned", async () => {
    const body = { elements: [{ type: "count", id: 0, tags: { total: "3500" } }, ...osmFixture.elements.filter((e) => e.type !== "count")] };
    const r = geojson(await layer.query(ctx(reply(body, openbetaFixture)), DEFAULTS));
    expect(r.coverageNote).toContain("the box was truncated (OpenStreetMap stopped at 3,000 (lowest ids kept)), zoom in for the rest");
    expect(r.coverageNote).not.toContain("largest by route count");
  });

  it("does not call the box truncated when the only elements left out are gyms", async () => {
    const body = {
      elements: [
        { type: "count", id: 0, tags: { total: "3" } },
        { type: "node", id: 1, lat: 37.8, lon: -83.6, tags: { sport: "climbing", climbing: "crag", name: "Wall" } },
        { type: "node", id: 2, lat: 37.8, lon: -83.6, tags: { sport: "climbing", leisure: "sports_centre", name: "Gym A" } },
        { type: "node", id: 3, lat: 37.8, lon: -83.6, tags: { sport: "climbing", leisure: "sports_centre", name: "Gym B" } },
      ],
    };
    const r = geojson(await layer.query(ctx(reply(body, { data: { cragsWithin: [] } })), DEFAULTS));
    expect(r.data.features).toHaveLength(1);
    expect(r.coverageNote).toBe("Returned 1 climbing places (1 from OpenStreetMap, 0 from OpenBeta); the box was not truncated");
  });

  it("says when OpenBeta sent more than it kept, by route count", async () => {
    const many = Array.from({ length: 3001 }, (_, i) => ({
      uuid: `u${i}`,
      area_name: `Crag ${i}`,
      totalClimbs: i,
      metadata: { lat: 37.75 + i * 0.00003, lng: -83.7 + i * 0.00003, leaf: true, isBoulder: false },
    }));
    const r = geojson(await layer.query(ctx(reply({ elements: [] }, { data: { cragsWithin: many } })), DEFAULTS));
    expect(r.data.features).toHaveLength(3000);
    expect(r.coverageNote).toContain("OpenBeta kept the 3,000 with the most routes");
  });

  it("states the OpenBeta licence honestly and cites both sources", async () => {
    expect(layer.license).toBe(
      "ODbL (OpenStreetMap contributors); OpenBeta (open data; licence not stated by the project, verify before commercial use)",
    );
    const r = geojson(await layer.query(ctx(reply(osmFixture, openbetaFixture)), DEFAULTS));
    expect(r.citation.source).toContain("OpenStreetMap contributors (ODbL");
    expect(r.citation.source).toContain("openstreetmap.org/copyright");
    expect(r.citation.source).toContain("OpenBeta (openbeta.io)");
  });

  it("falls back to OpenStreetMap alone when OpenBeta fails, and says so", async () => {
    const r = geojson(await layer.query(ctx(reply(osmFixture, { errors: [{ message: "boom" }] })), DEFAULTS));
    expect(r.data.features).toHaveLength(14);
    expect(r.coverageNote).toContain("OpenBeta did not answer (OpenBeta returned an unexpected response), so OpenStreetMap crags only");
    expect(r.citation.source).toBe("OpenStreetMap contributors (ODbL, openstreetmap.org/copyright)");
  });

  it("falls back to OpenBeta alone when Overpass fails, and says so", async () => {
    const r = geojson(await layer.query(ctx(reply("slow down", openbetaFixture, { osm: 429, openbeta: 200 })), DEFAULTS));
    expect(r.data.features).toHaveLength(12);
    expect(r.coverageNote).toContain("OpenStreetMap did not answer (Overpass returned 429), so OpenBeta crags only");
  });

  it("returns an upstream error when both sources fail", async () => {
    const r = await layer.query(ctx(reply("x", "y", { osm: 500, openbeta: 503 })), DEFAULTS);
    expect(r).toEqual({ error: "Overpass returned 500; OpenBeta returned 503", hint: "upstream" });
  });

  it("returns 422 zoom_in from runLayer only over the default hard cap of 40,000 km2", async () => {
    const res = await runLayer("climbing", { bbox: [-86, 36, -83, 38] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ hint: "zoom_in", error: expect.stringMatching(/under 40000 km²$/) });
  });

  it("keeps the 1,000 places with the most routes in wide mode and counts every merged place as total", async () => {
    const many = Array.from({ length: 1500 }, (_, i) => ({
      uuid: `u${i}`,
      area_name: `Crag ${i}`,
      totalClimbs: i,
      metadata: { lat: 37 + i * 0.001, lng: -84 + i * 0.001, leaf: true, isBoulder: false },
    }));
    const osm = { elements: [{ type: "count", id: 0, tags: { total: "1" } }, { type: "node", id: 1, lat: 36.5, lon: -84.5, tags: { sport: "climbing", climbing: "crag", name: "Wall", "climbing:routes": "2000" } }] };
    const stub = reply(osm, { data: { cragsWithin: many } });
    vi.stubGlobal("fetch", stub);
    try {
      // About 35,000 km² around the Red River Gorge and the Obed.
      const res = await runLayer("climbing", { bbox: [-85, 36.2, -83, 38], zoom: 7 });
      expect(res.status).toBe(200);
      expect(stub).toHaveBeenCalledTimes(2);
      if (!("kind" in res.body) || res.body.kind !== "geojson") throw new Error("expected geojson");
      const v = res.body.data.features.map((f) => f.properties?.v as number);
      expect(v).toHaveLength(1000);
      expect(v[0]).toBe(2000);
      expect(Math.min(...v)).toBe(1500 - 999);
      expect(res.body.total).toBe(1501);
      expect(res.body.truncated).toBe(true);
      expect(res.body.coverageNote).toBe(
        "Showing the 1,000 largest of 1,501 (ranked by route count); zoom in under 10,000 km² for all; Returned 1,000 climbing places (1 from OpenStreetMap, 1,500 from OpenBeta)",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leaves total out in wide mode when Overpass held more than it sent, and says the ranking saw part of the box", async () => {
    const osm = { elements: [{ type: "count", id: 0, tags: { total: "3500" } }, ...osmFixture.elements.filter((e) => e.type !== "count")] };
    const r = geojson(
      await layer.query({ ...ctx(reply(osm, openbetaFixture)), wide: true, wideStrategy: layer.wide }, DEFAULTS),
    );
    expect(r.total).toBeUndefined();
    expect(r.coverageNote).toContain("ranked from part of the box (OpenStreetMap stopped at 3,000 (lowest ids kept))");
    expect(r.coverageNote).not.toContain("zoom in");
  });
});

describe("one place per wall", () => {
  const crag = (lng: number, props: Record<string, string | number | boolean | string[]>) => ({ position: [lng, 37.815] as [number, number], props });
  it("joins a wall mapped as a node and as a cliff line (same name within 500 m), keeping the larger route count", () => {
    const node = crag(-83.6698, { kind: "crag", source: "osm", osmId: "node/7314110512", name: "Military Wall", v: 110, disciplines: ["sport"] });
    const way = crag(-83.6708, { kind: "crag", source: "osm", osmId: "way/364439327", name: "Military Wall", disciplines: ["trad"], gradeBands: ["elite"] });
    const far = crag(-83.5, { kind: "crag", source: "osm", osmId: "node/9", name: "Military Wall", v: 3 });
    const out = dedupeSameName([way, node, far]);
    expect(out).toHaveLength(2);
    expect(out[0].props).toMatchObject({ osmId: "node/7314110512", v: 110, disciplines: ["sport", "trad"], gradeBands: ["elite"], osmIds: ["node/7314110512", "way/364439327"] });
    const { crags } = mergeCrags(out, [crag(-83.6707, { kind: "crag", source: "openbeta", name: "Military Wall", v: 42, openbetaId: "e2" })]);
    expect(crags).toHaveLength(2);
    expect(crags[0].props).toMatchObject({ v: 110, routesOsm: 110, routesOpenbeta: 42, source: "osm+openbeta" });
  });
});
