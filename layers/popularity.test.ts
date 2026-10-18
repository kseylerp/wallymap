/**
 * Trail popularity, checked against trails a visitor knows (recorded fixtures, offline).
 *
 * Fixtures (layers/__fixtures__/popularity.<region>.json) were recorded 2026-10-18 from the live sources (osm-trails,
 * photos, the Overpass extras query and Wikipedia page views) and trimmed: named ways and route members only, geometry
 * simplified to about 5 m, photos near the trails, views by reference.
 *
 * Ranks, before (the old per-way score, live 2026-10-18, rank among all OpenStreetMap ways) and after (one feature per
 * named trail, live 2026-10-18):
 *   Yosemite Valley (-119.65,37.70,-119.50,37.78), 510 ways before, 49 named trails after:
 *     Mist Trail 395th → 8th; Half Dome Trail 407th → 5th; Upper Yosemite Fall Trail 36th → 7th; Four Mile Trail 73rd → 2nd;
 *     Lower Yosemite Fall Trail → 1st. Before, the top 25 were Valley Loop Trail ways (8 slots) and "Unnamed" ways (9).
 *     (The audit, at its wider view, had Mist Trail 83rd, Four Mile 102nd and Half Dome 563rd of 901 ways.)
 *   Zion Canyon (-113.0,37.19,-112.9,37.32), 30 named trails after:
 *     West Rim Trail 3rd → 1st; The Narrows 1st → 2nd; Angels Landing 14th → 3rd; Lower Emerald Pool Trail 4th → 7th;
 *     closed trails (Hidden Canyon, East Rim "Closed Indefinitely") 4th and 5th before → score 0.
 *   Mount Rainier, Paradise and Longmire (-121.78,46.76,-121.68,46.82), 27 named trails after:
 *     Wonderland Trail 1st; Skyline Trail 2nd → 2nd; Myrtle Falls Trail 10th; Alta Vista 5th → 12th.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Feature, FeatureCollection } from "geojson";
import { z } from "zod";
import type { CachedFetch } from "@/lib/fetch";
import { clearRegistry, registerLayer } from "./registry";
import { defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext } from "./types";
import { legendOf, labelsOf, timeShapeOf, contractProblems } from "./contract";
import { SAGE } from "@/lib/render/palette";
import popularity, {
  distanceTagKm,
  extrasQuery,
  fetchPageViews,
  groupTrails,
  isClosed,
  logNormalize,
  mapillaryPartial,
  pageKey,
  parseExtras,
  popularityCampsites,
  rankNormalize,
  samplePoints,
  scorePopularity,
  scoreTrails,
  sitelinkPage,
  type Destination,
  type PageViews,
  type ParkingLot,
  type RouteRelation,
} from "./popularity";
import yosemite from "./__fixtures__/popularity.yosemite.json";
import zion from "./__fixtures__/popularity.zion.json";
import rainier from "./__fixtures__/popularity.rainier.json";

const BBOX: BBox = [-120.2, 39.05, -120.0, 39.15];

function line(coords: [number, number][], properties: Record<string, unknown> = {}): Feature {
  return { type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties };
}

function point(coord: [number, number], properties: Record<string, unknown> = {}): Feature {
  return { type: "Feature", geometry: { type: "Point", coordinates: coord }, properties };
}

function fc(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

/* ---------- Recorded regions ---------- */

type Fixture = {
  bbox: number[];
  trails: Feature[];
  photos: [number, number, number][];
  relations: RouteRelation[];
  destinations: Destination[];
  parking: ParkingLot[];
  /** Reference → [page, views over 60 days]. */
  views: Record<string, [string, number]>;
};

function rankRegion(raw: unknown): Feature[] {
  const d = raw as Fixture;
  const views: PageViews = new Map(Object.entries(d.views).map(([ref, [page, n]]) => [ref, { page, views: n, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page)}` }]));
  const photos = d.photos.map(([lon, lat, m]) => point([lon, lat], { source: m ? "mapillary" : "commons" }));
  const { groups } = groupTrails(d.trails, d.relations);
  return scoreTrails({ groups, destinations: d.destinations, parking: d.parking, routesKnown: true, views, photos, refLat: (d.bbox[1] + d.bbox[3]) / 2 });
}

const rankOf = (ranked: Feature[], name: string) => ranked.findIndex((f) => String(f.properties?.name).toLowerCase().includes(name.toLowerCase())) + 1;

describe("famous trails rank near the top (recorded 2026-10-18)", () => {
  it("Yosemite Valley: Mist Trail, Half Dome, Upper Yosemite Fall and Four Mile are in the top 10 named trails", () => {
    const ranked = rankRegion(yosemite);
    for (const name of ["Mist Trail", "Half Dome Trail", "Upper Yosemite Fall Trail", "Four Mile Trail", "Lower Yosemite Fall Trail"]) {
      const rank = rankOf(ranked, name);
      expect(rank, name).toBeGreaterThan(0);
      expect(rank, name).toBeLessThanOrEqual(10);
    }
    // The Valley Loop no longer fills the list: it is one trail with one slot, and not first.
    expect(ranked.filter((f) => /valley loop/i.test(String(f.properties?.name)))).toHaveLength(1);
    expect(rankOf(ranked, "Valley Loop")).toBeGreaterThan(3);
  });

  it("Zion Canyon: Angels Landing, West Rim and the Narrows lead; Emerald Pools are in the top 10; closed trails score 0", () => {
    const ranked = rankRegion(zion);
    for (const name of ["Angels Landing", "West Rim Trail", "Narrows"]) expect(rankOf(ranked, name), name).toBeLessThanOrEqual(3);
    expect(rankOf(ranked, "Emerald Pool")).toBeLessThanOrEqual(10);
    for (const f of ranked.filter((x) => isClosed(String(x.properties?.name)))) {
      expect(f.properties?.v).toBe(0);
      expect(f.properties?.status).toBe("Closed");
    }
  });

  it("Mount Rainier: Skyline Trail is in the top 3", () => {
    expect(rankOf(rankRegion(rainier), "Skyline Trail")).toBeLessThanOrEqual(3);
  });

  it("names every ranked trail once, never 'Unnamed', and ranks them 1..n by score", () => {
    for (const region of [yosemite, zion, rainier]) {
      const ranked = rankRegion(region);
      const names = ranked.map((f) => String(f.properties?.name));
      expect(names.every((n) => n.trim() !== "" && !/^unnamed$/i.test(n))).toBe(true);
      expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
      ranked.forEach((f, i) => {
        expect(f.properties?.rank).toBe(i + 1);
        if (i > 0) expect(f.properties?.v).toBeLessThanOrEqual(ranked[i - 1].properties?.v as number);
      });
    }
  });
});

/* ---------- Pieces of the trail score ---------- */

describe("rankNormalize and logNormalize", () => {
  it("rankNormalize ranks only non-zero values: zero is 0, the smallest non-zero 1/k, the largest 1", () => {
    expect(rankNormalize([0, 5, 5, 10])).toEqual([0, 2 / 3, 2 / 3, 1]);
    expect(rankNormalize([])).toEqual([]);
    expect(rankNormalize([0, 0])).toEqual([0, 0]);
  });

  it("logNormalize scales counts on a log scale against the largest", () => {
    const out = logNormalize([0, 9, 99]);
    expect(out[0]).toBe(0);
    expect(out[2]).toBe(1);
    expect(out[1]).toBeCloseTo(Math.log(10) / Math.log(100), 9);
    expect(logNormalize([0, 0])).toEqual([0, 0]);
  });
});

describe("samplePoints", () => {
  it("caps long lines and always includes the end and the midpoint", () => {
    const coords = Array.from({ length: 500 }, (_, i) => [i * 0.001, 0] as [number, number]);
    const pts = samplePoints(line(coords));
    expect(pts.length).toBeLessThanOrEqual(30);
    expect(pts).toContainEqual(coords[499]);
  });
});

describe("OpenStreetMap extras", () => {
  it("asks for hiking routes with members and bounds, named destinations and parking in the box", () => {
    const q = extrasQuery(BBOX);
    expect(q).toContain("(39.05,-120.2,39.15,-120)");
    expect(q).toContain('rel(bw.w)["route"~"^(hiking|foot)$"]');
    expect(q).toContain("out body bb");
    expect(q).toContain('nwr["amenity"="parking"]');
  });

  it("reads a route's distance tag in km or miles", () => {
    expect(distanceTagKm("19.5")).toBe(19.5);
    expect(distanceTagKm("12 mi")).toBeCloseTo(19.31, 2);
    expect(distanceTagKm("800 m")).toBe(0.8);
    expect(distanceTagKm("about 3 km")).toBe(0);
    expect(distanceTagKm(undefined)).toBe(0);
  });

  it("parses routes, destinations and lots; a route is at least as long as its bounds are across", () => {
    const extras = parseExtras({
      elements: [
        { type: "relation", id: 1, bounds: { minlat: 37, minlon: -119.6, maxlat: 37.1, maxlon: -119.5 }, tags: { name: "Mist Trail", network: "lwn", wikidata: "Q6879984" }, members: [{ type: "way", ref: 10 }, { type: "node", ref: 5 }] },
        { type: "relation", id: 2, tags: { name: "John Muir Trail", distance: "343.9" }, members: [{ type: "way", ref: 10 }] },
        { type: "node", id: 3, lat: 37.72, lon: -119.54, tags: { natural: "waterfall", name: "Vernal Fall", wikipedia: "en:Vernal Fall" } },
        { type: "way", id: 4, center: { lat: 37.73, lon: -119.55 }, tags: { amenity: "parking", capacity: "120" } },
        { type: "node", id: 6, lat: 37.73, lon: -119.55, tags: { amenity: "parking" } },
        { type: "node", id: 7, lat: 37.73, lon: -119.55, tags: { natural: "tree" } },
      ],
    });
    expect(extras.relations).toHaveLength(2);
    expect(extras.relations[0]).toMatchObject({ id: 1, name: "Mist Trail", network: "lwn", wikidata: "Q6879984", wayIds: [10] });
    expect(extras.relations[0].totalKm).toBeGreaterThan(13);
    expect(extras.relations[1].totalKm).toBeCloseTo(343.9, 1);
    expect(extras.destinations).toEqual([{ name: "Vernal Fall", kind: "waterfall", coord: [-119.54, 37.72], wikipedia: "en:Vernal Fall" }]);
    expect(extras.parking).toEqual([
      { coord: [-119.55, 37.73], spaces: 120 },
      { coord: [-119.55, 37.73], spaces: 10 },
    ]);
  });
});

describe("groupTrails", () => {
  const route = (id: number, name: string, wayIds: number[], extra: Partial<RouteRelation> = {}): RouteRelation => ({ id, name, totalKm: 5, wayIds, network: "lwn", ...extra });
  const way = (id: number, x: number, props: Record<string, unknown> = {}, len = 0.01) =>
    line([[x, 37], [x + len, 37]], { osmId: `way/${id}`, ...props });

  it("merges ways by name, joins a route by its name, and leaves out unnamed ways in no route", () => {
    const ways = [
      way(1, 0, { name: "Valley Loop Trail" }),
      way(2, 0.1, { name: "Valley Loop Trail" }),
      way(3, 0.2), // unnamed member of the route
      way(4, 0.3), // unnamed, in no route
      way(5, 0.4, { name: "The Cables" }, 0.002), // a short named piece of Half Dome Trail
      way(6, 0.5, { name: "Mist Trail" }),
    ];
    const relations = [route(10, "Yosemite Valley Loop Trail", [1, 3]), route(11, "Half Dome Trail", [5, 6], { network: "rwn" }), route(12, "Mist Trail", [])];
    const { groups, unnamed } = groupTrails(ways, relations);
    expect(unnamed).toBe(1);
    const byName = Object.fromEntries(groups.map((g) => [g.name, g]));
    expect(Object.keys(byName).sort()).toEqual(["Half Dome Trail", "Mist Trail", "Yosemite Valley Loop Trail"]);
    expect(byName["Yosemite Valley Loop Trail"].osmIds).toEqual(["way/1", "way/2", "way/3"]);
    expect(byName["Yosemite Valley Loop Trail"].own.map((r) => r.id)).toEqual([10]);
    expect(byName["Half Dome Trail"].osmIds).toEqual(["way/5"]);
    // A way named for a route in view joins that route even when it is mapped as a member of another one.
    expect(byName["Mist Trail"].osmIds).toEqual(["way/6"]);
    expect(byName["Mist Trail"].routes.map((r) => r.name)).toEqual(["Half Dome Trail"]);
  });

  it("drops stubs shorter than 50 m", () => {
    const { groups } = groupTrails([way(1, 0, { name: "Museum" }, 0.0002)], []);
    expect(groups).toEqual([]);
  });
});

describe("scoreTrails", () => {
  const refLat = 37;
  const base = { destinations: [] as Destination[], parking: [] as ParkingLot[], routesKnown: true, photos: [] as Feature[], refLat };

  it("counts only the share of a long route in view toward its own article", () => {
    const longRoute: RouteRelation = { id: 1, name: "Long Trail", totalKm: 300, wayIds: [1], wikidata: "Q1" };
    const shortTrail: RouteRelation = { id: 2, name: "Short Trail", totalKm: 2, wayIds: [2], wikidata: "Q2" };
    const ways = [
      line([[0, 37], [0.03, 37]], { osmId: "way/1", name: "Long Trail" }), // about 2.7 km in view
      line([[0, 37.1], [0.03, 37.1]], { osmId: "way/2", name: "Short Trail" }),
    ];
    const views: PageViews = new Map([
      ["wikidata:Q1", { page: "Long Trail", views: 10_000, url: "u1" }],
      ["wikidata:Q2", { page: "Short Trail", views: 1_000, url: "u2" }],
    ]);
    const { groups } = groupTrails(ways, [longRoute, shortTrail]);
    const out = scoreTrails({ ...base, groups, views });
    const by = Object.fromEntries(out.map((f) => [f.properties?.name, f.properties]));
    expect(by["Long Trail"].wikipediaViews).toBeLessThan(100);
    expect(by["Short Trail"].wikipediaViews).toBe(1_000);
    expect(out[0].properties?.name).toBe("Short Trail");
    expect(by["Short Trail"].wikipediaUrl).toBe("u2");
  });

  it("credits a trail's busiest kilometre of photos, not its length, and Mapillary images only on the trail", () => {
    // A 10 km trail with one photo every kilometre, and a 1 km trail with five photos along it.
    const long = line(Array.from({ length: 11 }, (_, i) => [i * 0.0113, 37] as [number, number]), { osmId: "way/1", name: "Long" });
    const short = line([[0, 37.2], [0.0113, 37.2]], { osmId: "way/2", name: "Short" });
    const photos = [
      ...Array.from({ length: 10 }, (_, i) => point([i * 0.0113 + 0.005, 37.0005], { source: "commons" })),
      ...Array.from({ length: 5 }, (_, i) => point([i * 0.002, 37.2005], { source: "commons" })),
      // Mapillary 150 m off the short trail (taken from a road): not counted.
      ...Array.from({ length: 20 }, (_, i) => point([i * 0.0005, 37.2014], { source: "mapillary" })),
      // Mapillary on the short trail: counted.
      point([0.003, 37.2001], { source: "mapillary" }),
    ];
    const { groups } = groupTrails([long, short], []);
    const out = scoreTrails({ ...base, groups, views: new Map(), photos });
    const by = Object.fromEntries(out.map((f) => [f.properties?.name, f.properties]));
    expect(by.Short.photos).toBe(6);
    expect(by.Long.photos).toBeLessThanOrEqual(2);
  });

  it("names what the trail leads to, best known first, and takes the largest lot near it", () => {
    const trail = line([[0, 37], [0.01, 37]], { osmId: "way/1", name: "Falls Trail" });
    const destinations: Destination[] = [
      { name: "Small Rock", kind: "rock", coord: [0.002, 37.001], wikidata: "Q9" },
      { name: "Big Fall", kind: "waterfall", coord: [0.01, 37.001], wikidata: "Q8" },
      { name: "Far Peak", kind: "summit", coord: [0.05, 37.05], wikidata: "Q7" },
    ];
    const views: PageViews = new Map([
      ["wikidata:Q8", { page: "Big Fall", views: 800, url: "u8" }],
      ["wikidata:Q9", { page: "Small Rock", views: 40, url: "u9" }],
      ["wikidata:Q7", { page: "Far Peak", views: 9_000, url: "u7" }],
    ]);
    const parking: ParkingLot[] = [
      { coord: [0, 37.002], spaces: 40 },
      { coord: [0.001, 37.001], spaces: 10 },
      { coord: [0.2, 37.2], spaces: 900 },
    ];
    const { groups } = groupTrails([trail], []);
    const [f] = scoreTrails({ ...base, groups, views, destinations, parking });
    expect(f.properties?.leadsTo).toEqual(["Big Fall", "Small Rock"]);
    expect(f.properties?.wikipediaViews).toBe(800 + 40 * 0.25);
    expect(f.properties?.parkingSpaces).toBe(40);
    expect(f.properties?.wikipediaUrl).toBe("u8");
  });

  it("drops a failed signal and reweights the rest, so scores still reach 100", () => {
    const ways = [line([[0, 37], [0.01, 37]], { osmId: "way/1", name: "A", wikidata: "Q1" }), line([[0, 37.1], [0.01, 37.1]], { osmId: "way/2", name: "B" })];
    const { groups } = groupTrails(ways, []);
    const out = scoreTrails({ groups, destinations: null, parking: null, routesKnown: false, views: null, photos: null, refLat });
    expect(out[0].properties?.name).toBe("A");
    expect(out[0].properties?.v).toBe(100);
    expect(out[0].properties).not.toHaveProperty("wikipediaViews");
    expect(out[1].properties?.v).toBe(0);
  });
});

describe("Wikipedia page views", () => {
  it("reads a tag as a page key, and picks a Wikidata item's English page, else another language", () => {
    expect(pageKey("en:Half_Dome")).toBe("en:Half Dome");
    expect(pageKey("Half Dome")).toBe("en:Half Dome");
    expect(sitelinkPage({ commonswiki: { title: "Category:X" }, frwiki: { title: "Sentier" }, enwiki: { title: "Trail" } })).toBe("en:Trail");
    expect(sitelinkPage({ commonswiki: { title: "Category:X" }, frwiki: { title: "Sentier du Half Dome" } })).toBe("fr:Sentier du Half Dome");
    expect(sitelinkPage({ commonswiki: { title: "Category:X" } })).toBeNull();
  });

  it("resolves Wikidata items through their sitelinks and sums 60 days of views, following redirects", async () => {
    const urls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.includes("wikidata.org")) {
        return Response.json({ entities: { Q1: { sitelinks: { enwiki: { title: "Mist Trail" } } }, Q2: { sitelinks: { frwiki: { title: "Sentier" } } }, Q3: { sitelinks: {} } } });
      }
      if (url.startsWith("https://en.wikipedia.org")) {
        expect(url).toContain("pvipdays=60");
        return Response.json({
          query: {
            normalized: [{ from: "half Dome", to: "Half Dome" }],
            redirects: [{ from: "Half Dome", to: "Half Dome (mountain)" }],
            pages: [
              { title: "Mist Trail", pageviews: { "2026-10-01": 10, "2026-10-02": null, "2026-10-03": 5 } },
              { title: "Half Dome (mountain)", pageviews: { "2026-10-01": 400 } },
            ],
          },
        });
      }
      return Response.json({ query: { pages: [{ title: "Sentier", pageviews: { "2026-10-01": 7 } }] } });
    });
    const views = await fetchPageViews({ fetch: fetch as unknown as CachedFetch }, ["wikidata:Q1", "wikidata:Q2", "wikidata:Q3", `wikipedia:${pageKey("en:Half_Dome")}`]);
    expect(views.get("wikidata:Q1")).toMatchObject({ page: "Mist Trail", views: 15, url: "https://en.wikipedia.org/wiki/Mist_Trail" });
    expect(views.get("wikidata:Q2")).toMatchObject({ page: "Sentier", views: 7 });
    expect(views.get("wikipedia:en:Half Dome")).toMatchObject({ page: "Half Dome (mountain)", views: 400 });
    expect(views.has("wikidata:Q3")).toBe(false);
    expect(urls.filter((u) => u.includes("wikidata.org"))).toHaveLength(1);
  });

  it("throws when Wikipedia answers with an error status", async () => {
    const fetch = vi.fn(async () => new Response("down", { status: 500 }));
    await expect(fetchPageViews({ fetch: fetch as unknown as CachedFetch }, ["wikipedia:en:X"])).rejects.toThrow(/500/);
  });
});

/* ---------- The layers, with composed layers and sources faked ---------- */

// Two ways of one named trail by a photo cluster and a 50-car lot; an unnamed way in no route; a quiet trail 5 km east.
const TRAIL_A1 = line([[-120.1, 39.1], [-120.098, 39.101]], { osmId: "way/1", name: "Popular Trail", informal: false, wikidata: "Q1" });
const TRAIL_A2 = line([[-120.098, 39.101], [-120.096, 39.102]], { osmId: "way/4", name: "Popular Trail", informal: false });
const TRAIL_B = line([[-120.04, 39.1], [-120.038, 39.101]], { osmId: "way/2", name: "Quiet Trail", informal: false });
const SOCIAL = line([[-120.0995, 39.1003], [-120.0992, 39.1006]], { osmId: "way/3", informal: true });
const PHOTOS = Array.from({ length: 20 }, (_, i) => point([-120.1 + i * 0.0001, 39.1005], { source: "commons", v: 1 }));
const PARKING = point([-120.101, 39.103], { kind: "parking", capacity: 50, v: 50 });
const CAMP = point([-120.0995, 39.1002], { kind: "camp_site", name: "Busy Camp" });
const QUIET_CAMP = point([-120.03, 39.12], { kind: "camp_site" });

const EXTRAS = {
  elements: [
    { type: "node", id: 100, lat: 39.1012, lon: -120.0965, tags: { natural: "waterfall", name: "Popular Falls", wikidata: "Q100" } },
    { type: "node", id: 101, lat: 39.1025, lon: -120.1008, tags: { amenity: "parking", capacity: "50" } },
  ],
};

type Outcome = LayerResult | LayerError;

function fakeLayer(id: string, outcome: () => Outcome) {
  return defineLayer({
    id,
    title: id,
    description: id,
    coverage: "global",
    surface: "any",
    license: "test",
    requiredEnv: [],
    maxAreaKm2: 1e9,
    input: z.object({}).passthrough(),
    style: { geometry: "point", color: "#000" },
    query: vi.fn(async () => outcome()),
  });
}

function ok(features: Feature[], coverageNote?: string): LayerResult {
  return {
    kind: "geojson",
    data: fc(features),
    citation: { source: "test", url: "https://example.com", retrieved: "2026-10-09T00:00:00Z" },
    ...(coverageNote ? { coverageNote } : {}),
  };
}

let trails: () => Outcome;
let camps: () => Outcome;
let photos: () => Outcome;
let overpass: () => Response;
let wiki: (url: string) => Response;
let fakes: ReturnType<typeof fakeLayer>[];

const sourceFetch = vi.fn(async (url: string) => {
  if (url.includes("overpass")) return overpass();
  return wiki(url);
});

function ctx(cacheKey?: string): QueryContext {
  return { bbox: BBOX, zoom: 12, env: {}, fetch: sourceFetch as unknown as CachedFetch, cacheKey };
}

async function run(target: "trails" | "campsites" = "trails", cacheKey?: string, bbox: BBox = BBOX) {
  const layer = target === "trails" ? popularity : popularityCampsites;
  return layer.query({ ...ctx(cacheKey), bbox }, {});
}

function features(result: Outcome): Feature[] {
  if ("error" in result || result.kind !== "geojson") throw new Error(`expected features, got ${JSON.stringify(result)}`);
  return result.data.features;
}

const note = (result: Outcome) => ("coverageNote" in result ? result.coverageNote : undefined);

beforeEach(() => {
  clearRegistry();
  sourceFetch.mockClear();
  trails = () => ok([TRAIL_A1, TRAIL_A2, TRAIL_B, SOCIAL]);
  camps = () => ok([PARKING, CAMP, QUIET_CAMP]);
  photos = () => ok(PHOTOS);
  overpass = () => Response.json(EXTRAS);
  wiki = (url) =>
    url.includes("wikidata.org")
      ? Response.json({ entities: { Q1: { sitelinks: { enwiki: { title: "Popular Trail" } } }, Q100: { sitelinks: { enwiki: { title: "Popular Falls" } } } } })
      : Response.json({ query: { pages: [{ title: "Popular Trail", pageviews: { d: 300 } }, { title: "Popular Falls", pageviews: { d: 900 } }] } });
  fakes = [
    fakeLayer("osm-trails", () => trails()),
    fakeLayer("campsites", () => camps()),
    fakeLayer("photos", () => photos()),
  ];
  fakes.forEach((f) => registerLayer(f));
});

afterAll(() => clearRegistry());

describe("popularity layer (trails)", () => {
  it("answers one feature per named trail, the busy one first, and leaves the unnamed path out", async () => {
    const result = await run();
    const out = features(result);
    expect(out.map((f) => f.properties?.name)).toEqual(["Popular Trail", "Quiet Trail"]);
    const [a, b] = out;
    expect(a.geometry.type).toBe("MultiLineString");
    expect(a.properties).toMatchObject({ rank: 1, osmIds: ["way/1", "way/4"], leadsTo: ["Popular Falls"], wikipediaViews: 1_200, parkingSpaces: 50, popularityNote: "estimate" });
    expect(a.properties?.wikipediaUrl).toBe("https://en.wikipedia.org/wiki/Popular_Trail");
    expect(a.properties?.v).toBeGreaterThan(b.properties?.v as number);
    expect(note(result)).toMatch(/1 unnamed path is left out/);
  });

  it("calls the trails and photos layers with distinct cacheKey suffixes, and Overpass for the extras", async () => {
    await run("trails", "popularity:abc");
    const [trailsFake, campsFake, photosFake] = fakes;
    const keyOf = (fake: (typeof fakes)[number]) => (vi.mocked(fake.query).mock.calls[0][0] as QueryContext).cacheKey;
    expect(keyOf(trailsFake)).toBe("popularity:abc:trails");
    expect(keyOf(photosFake)).toBe("popularity:abc:photos");
    expect(vi.mocked(campsFake.query)).not.toHaveBeenCalled();
    expect(vi.mocked(trailsFake.query).mock.calls[0][1]).toMatchObject({ namedOnly: false });
    expect(sourceFetch.mock.calls.some(([url]) => String(url).includes("overpass"))).toBe(true);
  });

  it("asks photos for Commons only when Mapillary would cover just the centre, and says so", async () => {
    const wide: BBox = [-120.2, 39.0, -120.0, 39.15]; // 4 x 3 Mapillary squares, over its 8
    expect(mapillaryPartial(wide)).toBe(true);
    expect(mapillaryPartial(BBOX)).toBe(false); // exactly 8 squares
    const result = await run("trails", "popularity:abc", wide);
    const photosFake = fakes[2];
    expect(vi.mocked(photosFake.query).mock.calls[0][1]).toMatchObject({ sources: ["commons"] });
    expect((vi.mocked(photosFake.query).mock.calls[0][0] as QueryContext).cacheKey).toBe("popularity:abc:photos:commons");
    expect(note(result)).toMatch(/Wikimedia Commons only/);
  });

  it("degrades when Wikipedia fails: the other signals are reweighted and the note says why", async () => {
    wiki = () => new Response("busy", { status: 500 });
    const result = await run();
    const out = features(result);
    expect(note(result)).toMatch(/Wikipedia page views \(Wikidata returned 500\)/);
    expect(out[0].properties?.name).toBe("Popular Trail");
    expect(out[0].properties).not.toHaveProperty("wikipediaViews");
  });

  it("degrades when the Overpass extras fail: no destinations, routes or lots, and the note says so", async () => {
    overpass = () => new Response("gateway", { status: 504 });
    const result = await run();
    expect(note(result)).toMatch(/hiking routes, destinations and parking lots \(Overpass returned 504\)/);
    expect(features(result)[0].properties).not.toHaveProperty("leadsTo");
  });

  it("degrades when photos fail", async () => {
    photos = () => ({ error: "Wikimedia Commons returned 503", hint: "upstream" });
    const result = await run();
    expect(note(result)).toMatch(/photo counts.*503/);
    expect(features(result)[0].properties).not.toHaveProperty("photos");
  });

  it("returns the trails layer's own error when it fails", async () => {
    trails = () => ({ error: "Overpass returned 504", hint: "upstream" });
    expect(await run()).toEqual({ error: "Overpass returned 504", hint: "upstream" });
  });

  it("refuses an area over its limit", async () => {
    const result = await popularity.query({ ...ctx(), bbox: [-121, 38, -119, 40] }, {});
    expect(result).toMatchObject({ hint: "zoom_in" });
  });

  it("declares no time, a ramp legend that starts at a visible tone, labels for the top 10 and a plain card", () => {
    expect(timeShapeOf(popularity)).toEqual({ shape: "none" });
    const legend = legendOf(popularity);
    expect(legend.kind).toBe("ramp");
    expect(legend.stops?.[0].color?.toUpperCase()).not.toBe(SAGE.toUpperCase());
    // No hard-coded 0 to 100: the stops name the ends of the range the map draws, which comes from the scores loaded.
    expect(legend.stops?.map((s) => s.value)).toEqual([undefined, undefined, undefined]);
    expect(legend.stops?.map((s) => s.label)).toEqual(["Quietest trail in view", "Middle", "Busiest trail in view"]);
    expect(labelsOf(popularity)).toEqual({ field: "name", max: 10, rankBy: "v" });
    expect(popularity.style.encode).toEqual({ size: "v", color: "v" });
    expect(popularity.card?.hidden).toContain("osmIds");
    expect(popularity.fieldHelp?.v.text).toMatch(/Wikipedia/);
    expect(contractProblems(popularity)).toEqual([]);
    expect(contractProblems(popularityCampsites)).toEqual([]);
  });
});

describe("popularity-campsites layer", () => {
  it("registers trails as lines and campsites as points", () => {
    expect(popularity.id).toBe("popularity");
    expect(popularity.style.geometry).toBe("line");
    expect(popularityCampsites.id).toBe("popularity-campsites");
    expect(popularityCampsites.style.geometry).toBe("point");
    expect(popularityCampsites.style.color).toBe(popularity.style.color);
  });

  it("scores camp sites (not parking lots) as points", async () => {
    const out = features(await run("campsites"));
    expect(out.map((f) => f.properties?.kind)).toEqual(["camp_site", "camp_site"]);
    const [busy, quiet] = out;
    expect(busy.properties?.v).toBeGreaterThan(quiet.properties?.v as number);
    expect(busy.properties?.signals.informal).toBe(1);
  });

  it("scorePopularity returns 0-100 scores with signals", () => {
    const out = scorePopularity({ targets: [CAMP, QUIET_CAMP], photos: PHOTOS, parking: [PARKING], trails: [TRAIL_A1, SOCIAL], targetsAreTrails: false, refLat: 39.1 });
    expect(out[0].properties?.signals).toEqual({ photos: 20, parking: 50, wiki: false, informal: 1, named: true });
    // Every signal but the wiki link (15%), which neither site has.
    expect(out[0].properties?.v).toBe(85);
    expect(out[1].properties?.v).toBe(0);
  });

  it("degrades when a composed layer throws, and passes coverage notes through", async () => {
    trails = () => {
      throw new Error("boom");
    };
    photos = () => ok(PHOTOS, "Mapillary was skipped");
    const result = await run("campsites");
    expect(note(result)).toMatch(/informal trail counts/);
    expect(note(result)).toMatch(/Photos: Mapillary was skipped/);
  });
});
