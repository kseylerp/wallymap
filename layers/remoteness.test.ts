import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import { latLngToCell } from "h3-js";
import { z } from "zod";
import type { CachedFetch } from "@/lib/fetch";
import { cacheKeyFor } from "@/lib/fetch/cache";
import { clearRegistry, registerLayer } from "./registry";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext } from "./types";
import { cardTitle, contractProblems, labelsOf, legendOf, timeShapeOf } from "./contract";
import remoteness, {
  buildRoadsQuery,
  cellPolygon,
  placePoints,
  ROADLESS_URL,
  roadDistanceName,
  roadlessName,
  collapseToGrid,
  cellsForBBox,
  padBBox,
  roadDistanceScore,
  roadVertices,
  scoreCells,
  splitBBox,
} from "./remoteness";

const SMALL: BBox = [-120.2, 39.0, -120.0, 39.15];

/** A north-south road along longitude -120.1 through the small bbox. */
const ROAD_JSON = {
  elements: [
    {
      type: "way",
      id: 1,
      geometry: [
        { lat: 38.9, lon: -120.1 },
        { lat: 39.3, lon: -120.1 },
      ],
    },
  ],
};

function point(coord: [number, number], properties: Record<string, unknown> = {}): Feature {
  return { type: "Feature", geometry: { type: "Point", coordinates: coord }, properties };
}

type Outcome = LayerResult | LayerError;

function fakeLayer(id: string, outcome: () => Outcome, maxAreaKm2 = 1e9) {
  return defineLayer({
    id,
    title: id,
    description: id,
    coverage: "global",
    surface: "any",
    license: "test",
    requiredEnv: [],
    maxAreaKm2,
    input: z.object({}).passthrough(),
    style: { geometry: "point", color: "#000" },
    query: vi.fn(async () => outcome()),
  });
}

function ok(features: Feature[], coverageNote?: string): LayerResult {
  const data: FeatureCollection = { type: "FeatureCollection", features };
  return {
    kind: "geojson",
    data,
    citation: { source: "test", url: "https://example.com", retrieved: "2026-10-09T00:00:00Z" },
    ...(coverageNote ? { coverageNote } : {}),
  };
}

// A wilderness square covering the east part of the small bbox.
const WILDERNESS: Feature = {
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-120.05, 39.0],
        [-119.9, 39.0],
        [-119.9, 39.2],
        [-120.05, 39.2],
        [-120.05, 39.0],
      ],
    ],
  },
  properties: { name: "Test Wilderness" },
};

let wild: () => Outcome;
let camps: () => Outcome;
let fakes: ReturnType<typeof fakeLayer>[];
let roadsBody: unknown;
let roadlessBody: () => Response;

/** Answers the Forest Service roadless-area query with `roadlessBody`, everything else (Overpass) with `roadsBody`. */
function fetchStub() {
  return vi.fn(async (url: string) => (String(url).startsWith(ROADLESS_URL) ? roadlessBody() : new Response(JSON.stringify(roadsBody), { status: 200 })));
}

function ctx(bbox: BBox = SMALL, fetch = fetchStub(), cacheKey?: string): QueryContext {
  return { bbox, zoom: 10, env: {}, fetch: fetch as unknown as CachedFetch, cacheKey };
}

function features(result: Outcome): Feature<Polygon>[] {
  if ("error" in result || result.kind !== "geojson") throw new Error(`expected features, got ${JSON.stringify(result)}`);
  return result.data.features as Feature<Polygon>[];
}

beforeEach(() => {
  clearRegistry();
  roadsBody = ROAD_JSON;
  roadlessBody = () => Response.json({ type: "FeatureCollection", features: [] });
  wild = () => ok([WILDERNESS]);
  camps = () => ok([point([-120.1, 39.05], { kind: "camp_site" }), point([-120.1, 39.06], { kind: "parking", capacity: 5 })]);
  fakes = [fakeLayer("wilderness", () => wild()), fakeLayer("campsites", () => camps(), 10_000)];
  fakes.forEach((f) => registerLayer(f));
});

afterAll(() => clearRegistry());

describe("helpers", () => {
  it("fills a small bbox with H3 cells at resolution 7", () => {
    const cells = cellsForBBox(SMALL, 7);
    expect(cells.length).toBeGreaterThan(0);
    // ~280 km² at ~5 km² per cell.
    expect(cells.length).toBeGreaterThan(30);
    expect(cells.length).toBeLessThan(100);
  });

  it("returns the centre cell for a bbox smaller than one hexagon", () => {
    expect(cellsForBBox([-120.1, 39.1, -120.0999, 39.1001], 5)).toHaveLength(1);
  });

  it("draws hexagons as closed [lng, lat] rings", () => {
    const poly = cellPolygon(latLngToCell(39.1, -120.1, 7));
    const ring = poly.coordinates[0];
    expect(ring.length).toBe(7);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    for (const [lng, lat] of ring) {
      expect(lng).toBeCloseTo(-120.1, 0);
      expect(lat).toBeCloseTo(39.1, 0);
    }
  });

  it("builds a roads query without paths or footways", () => {
    const q = buildRoadsQuery(SMALL);
    expect(q).toContain("(39,-120.2,39.15,-120)");
    expect(q).toContain("track");
    expect(q).toContain("out ids geom");
    expect(q).not.toMatch(/path|footway|steps|cycleway/);
  });

  it("densifies long road segments and thins to a maximum", () => {
    const pts = roadVertices(ROAD_JSON);
    // 0.4 degrees of latitude is ~44 km, so ~43 points are added between the ends.
    expect(pts.length).toBeGreaterThan(40);
    expect(roadVertices(ROAD_JSON, 10)).toHaveLength(10);
    expect(roadVertices({ nope: true })).toEqual([]);
  });

  it("keeps every point of a lone track while collapsing a dense town grid", () => {
    // A sparse track: 30 vertices ~3 km apart heading north.
    const track = Array.from({ length: 30 }, (_, i) => ({ lat: 39 + i * 0.027, lon: -120.5 }));
    // A dense town: 300 x 300 street vertices every ~10 m in a ~3 km square, 20 km east.
    const town: { lat: number; lon: number }[] = [];
    for (let i = 0; i < 300; i++) for (let j = 0; j < 300; j++) town.push({ lat: 39.2 + i * 0.0001, lon: -120.27 + j * 0.0001 });
    const json = {
      elements: [
        { type: "way", id: 1, geometry: track },
        ...Array.from({ length: 300 }, (_, i) => ({ type: "way", id: 100 + i, geometry: town.slice(i * 300, (i + 1) * 300) })),
      ],
    };
    const pts = roadVertices(json, 50_000);
    expect(pts.length).toBeLessThan(50_000);
    const kept = new Set(pts.map((p) => `${p[0]},${p[1]}`));
    for (const v of track) expect(kept.has(`${v.lon},${v.lat}`)).toBe(true);
    // One point per ~200 m square: the first wins.
    expect(collapseToGrid([[0, 0], [0.0001, 0.0001], [1, 1]], 0.2)).toEqual([[0, 0], [1, 1]]);
  });

  it("scores road distance from 0 at the road to 1 at the cap", () => {
    expect(roadDistanceScore(0)).toBe(0);
    expect(roadDistanceScore(20)).toBe(1);
    expect(roadDistanceScore(50)).toBe(1);
    expect(roadDistanceScore(10)).toBeGreaterThan(roadDistanceScore(2));
  });

  it("pads and splits bboxes", () => {
    const padded = padBBox(SMALL, 3);
    expect(padded[0]).toBeLessThan(SMALL[0]);
    expect(padded[3]).toBeGreaterThan(SMALL[3]);
    const big: BBox = [-121, 38, -119.5, 39];
    const parts = splitBBox(big, 5_000);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(bboxAreaKm2(p)).toBeLessThanOrEqual(5_000);
  });
});

describe("scoreCells", () => {
  it("scores a cell 10 km from any road above one on a road", () => {
    const onRoad = latLngToCell(39.1, -120.1, 7);
    // 10 km east of the road at latitude 39.1.
    const far = latLngToCell(39.1, -120.1 + 10 / (111.32 * Math.cos((39.1 * Math.PI) / 180)), 7);
    const out = scoreCells({
      cells: [onRoad, far],
      roads: roadVertices(ROAD_JSON),
      wilderness: [],
      camps: [],
      refLat: 39.1,
    });
    const [a, b] = out;
    expect(a.properties?.signals.roadDistanceKm).toBeLessThan(2);
    expect(b.properties?.signals.roadDistanceKm).toBeGreaterThan(8);
    expect(b.properties?.v).toBeGreaterThan(a.properties?.v as number);
    for (const f of out) {
      expect(f.properties?.v).toBeGreaterThanOrEqual(0);
      expect(f.properties?.v).toBeLessThanOrEqual(100);
    }
  });

  it("caps road distance at 20 km when there are no roads, and adds the bonuses", () => {
    const cell = latLngToCell(39.1, -120.0, 7);
    const [f] = scoreCells({ cells: [cell], roads: [], wilderness: [WILDERNESS], camps: [], refLat: 39.1 });
    expect(f.properties?.signals).toEqual({ roadDistanceKm: 20, inWilderness: true, campsitesWithin2km: 0 });
    expect(f.properties?.v).toBe(100);
  });

  it("marks unknown signals as null and scores them as no bonus", () => {
    const cell = latLngToCell(39.1, -120.0, 7);
    const [f] = scoreCells({ cells: [cell], roads: [], wilderness: null, camps: null, refLat: 39.1 });
    expect(f.properties?.signals).toEqual({ roadDistanceKm: 20, inWilderness: null, campsitesWithin2km: null });
    expect(f.properties?.v).toBe(70);
  });
});

describe("remoteness layer", () => {
  it("returns closed hexagons with scores and signals for a small bbox", async () => {
    const fetch = fetchStub();
    const out = features(await remoteness.query(ctx(SMALL, fetch, "remoteness:k"), { resolution: 7, minScore: 0 }));
    expect(out.length).toBeGreaterThan(0);
    for (const f of out) {
      const ring = f.geometry.coordinates[0];
      expect(ring[0]).toEqual(ring[ring.length - 1]);
      expect(f.properties?.v).toBeGreaterThanOrEqual(0);
      expect(f.properties?.v).toBeLessThanOrEqual(100);
      expect(f.properties?.signals).toEqual(
        expect.objectContaining({ roadDistanceKm: expect.any(Number), inWilderness: expect.any(Boolean) }),
      );
    }
    // Wilderness cells far from the road beat cells on it.
    const byV = [...out].sort((a, b) => (b.properties?.v as number) - (a.properties?.v as number));
    expect(byV[0].properties?.signals.inWilderness).toBe(true);
    expect(byV[byV.length - 1].properties?.signals.roadDistanceKm).toBeLessThan(2);

    // Roads go through Overpass with their own cache suffix; composed layers get theirs. None
    // depend on resolution, so the keys leave it out and every resolution shares them.
    const base = cacheKeyFor("remoteness", SMALL, {});
    const roadCall = fetch.mock.calls.find(([url]) => !String(url).startsWith(ROADLESS_URL)) as unknown as [string, { cacheKey?: string }];
    expect(roadCall[1].cacheKey).toBe(`${base}:roads-places`);
    const roadlessCall = fetch.mock.calls.find(([url]) => String(url).startsWith(ROADLESS_URL)) as unknown as [string, { cacheKey?: string }];
    expect(roadlessCall[1].cacheKey).toBe(`${base}:roadless`);
    const wildCtx = vi.mocked(fakes[0].query).mock.calls[0][0] as QueryContext;
    expect(wildCtx.cacheKey).toBe(`${base}:wilderness`);
    expect((vi.mocked(fakes[1].query).mock.calls[0][0] as QueryContext).cacheKey).toBe(`${base}:campsites:0`);
    expect(vi.mocked(fakes[1].query).mock.calls[0][1]).toMatchObject({ includeParking: false });
  });

  it("counts only camp sites, not parking, within 2 km", async () => {
    const out = features(await remoteness.query(ctx(), { resolution: 7, minScore: 0 }));
    const near = out.find((f) => f.properties?.h3 === latLngToCell(39.05, -120.1, 7));
    expect(near?.properties?.signals.campsitesWithin2km).toBe(1);
  });

  it("steps the resolution down until the view fits and says which one it used", async () => {
    const big: BBox = [-120.5, 39.0, -120.0, 39.5]; // ~2,400 km², ~3,300 cells at resolution 8
    const wide: BBox = [-121, 39.0, -120.0, 39.5]; // ~4,300 km², over the cap at resolution 8
    // Under the cap at resolution 8 keeps the resolution and adds no note.
    const fits = await remoteness.query(ctx(big), { resolution: 8, minScore: 0 });
    expect(features(fits).length).toBeLessThanOrEqual(4_000);
    expect("coverageNote" in fits && fits.coverageNote).toBeFalsy();
    // Over the cap at resolution 8 drops to 7.
    const stepped = await remoteness.query(ctx(wide), { resolution: 8, minScore: 0 });
    const cells = features(stepped);
    expect(cells.length).toBeLessThanOrEqual(4_000);
    expect(cells.length).toBeGreaterThan(0);
    expect("coverageNote" in stepped && stepped.coverageNote).toMatch(/resolution 7 instead of 8/);
  });

  it("steps down more than once for a large view (7 to 6)", async () => {
    const large: BBox = [-122, 38.5, -120.0, 40.0]; // ~28,700 km², ~5,500 cells at resolution 7
    roadsBody = { elements: [] };
    const result = await remoteness.query(ctx(large), { resolution: 7, minScore: 0 });
    expect(features(result).length).toBeLessThanOrEqual(4_000);
    expect("coverageNote" in result && result.coverageNote).toMatch(/resolution 6 instead of 7/);
  });

  it("declares a 60,000 km2 cap", () => {
    expect(remoteness.maxAreaKm2).toBe(60_000);
  });

  it("returns an error when the roads query fails", async () => {
    const fetch = vi.fn(async (url: string) => (String(url).startsWith(ROADLESS_URL) ? roadlessBody() : new Response("busy", { status: 504 })));
    const result = await remoteness.query(ctx(SMALL, fetch), { resolution: 7, minScore: 0 });
    expect(result).toMatchObject({ hint: "upstream" });
  });

  it("degrades with a note when wilderness or campsites fail", async () => {
    wild = () => ({ error: "ArcGIS returned 500", hint: "upstream" });
    camps = () => {
      throw new Error("boom");
    };
    const result = await remoteness.query(ctx(), { resolution: 7, minScore: 0 });
    const out = features(result);
    expect("coverageNote" in result && result.coverageNote).toMatch(/wilderness bonus.*500.*no-campsite bonus/);
    expect(out[0].properties?.signals.inWilderness).toBeNull();
    expect(out[0].properties?.signals.campsitesWithin2km).toBeNull();
  });

  it("skips wilderness outside the US and says scores top out at 80", async () => {
    const alps: BBox = [7.0, 46.0, 7.1, 46.1];
    roadsBody = { elements: [] };
    const result = await remoteness.query(ctx(alps), { resolution: 7, minScore: 0 });
    expect(vi.mocked(fakes[0].query)).not.toHaveBeenCalled();
    expect("coverageNote" in result && result.coverageNote).toMatch(/at most 80/);
    for (const f of features(result)) expect(f.properties?.v).toBeLessThanOrEqual(80);
  });

  it("splits the campsites request when the padded view is over the campsites limit, one piece at a time after roads", async () => {
    const wide: BBox = [-121.2, 38.6, -120.0, 39.5]; // ~10,400 km², over the fake's 10,000
    let inFlight = 0;
    let maxInFlight = 0;
    const fetch = vi.fn(async (url: string) => {
      if (String(url).startsWith(ROADLESS_URL)) return roadlessBody();
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return new Response(JSON.stringify(roadsBody), { status: 200 });
    });
    const campsFake = fakes[1];
    vi.mocked(campsFake.query).mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return ok([]);
    });
    await remoteness.query(ctx(wide, fetch), { resolution: 6, minScore: 0 });
    expect(vi.mocked(campsFake.query).mock.calls.length).toBeGreaterThan(1);
    expect(maxInFlight).toBe(1);
  });

  it("passes the campsites coverage note through", async () => {
    camps = () => ok([], "Showing 5,000 of 6,000 sites");
    const result = await remoteness.query(ctx(), { resolution: 7, minScore: 0 });
    expect("coverageNote" in result && result.coverageNote).toMatch(/^Campsites: Showing 5,000 of 6,000 sites/);
  });
});

// A roadless area covering the west part of the small bbox (west of the road), and a named peak 1 km east of the road.
const ROADLESS: Feature = {
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-120.3, 39.0],
        [-120.15, 39.0],
        [-120.15, 39.2],
        [-120.3, 39.2],
        [-120.3, 39.0],
      ],
    ],
  },
  properties: { name: "Granite Chief", forest: "Tahoe" },
};

describe("places, roadless areas and the default threshold", () => {
  it("reads named peaks, lakes and glaciers from the roads answer, and asks for them", () => {
    expect(buildRoadsQuery(SMALL)).toContain('node["natural"="peak"]["name"]');
    const places = placePoints({
      elements: [
        { type: "way", id: 1, geometry: [{ lat: 39, lon: -120 }] },
        { type: "node", id: 2, lat: 39.1, lon: -120.08, tags: { natural: "peak", name: "Test Peak" } },
        { type: "way", id: 3, center: { lat: 39.12, lon: -120.05 }, tags: { natural: "water", name: "Test Lake" } },
        { type: "node", id: 4, lat: 39.1, lon: -120.08, tags: { natural: "peak" } },
      ],
    });
    expect(places).toEqual([
      { name: "Test Peak", kind: "peak", coord: [-120.08, 39.1] },
      { name: "Test Lake", kind: "lake", coord: [-120.05, 39.12] },
    ]);
  });

  it("names a hexagon for the nearest named place, else its wilderness, else its distance from a road; never 'Feature'", () => {
    const nearPeak = latLngToCell(39.1, -120.08, 7);
    const inWild = latLngToCell(39.1, -119.95, 7);
    // 8 km west of the road, outside the wilderness and over 5 km from the peak.
    const plain = latLngToCell(39.1, -120.1 - 8 / (111.32 * Math.cos((39.1 * Math.PI) / 180)), 7);
    const out = scoreCells({
      cells: [nearPeak, inWild, plain],
      roads: roadVertices(ROAD_JSON),
      wilderness: [WILDERNESS],
      camps: [],
      places: [{ name: "Test Peak", kind: "peak", coord: [-120.08, 39.1] }],
      refLat: 39.1,
    });
    // The wilderness cell is over 5 km from the peak, so it takes the wilderness's name.
    expect(out.map((f) => f.properties?.name)).toEqual([
      "Near Test Peak",
      "In Test Wilderness",
      expect.stringMatching(/^\d+(\.\d)? km from the nearest road$/),
    ]);
    expect(out[0].properties).toMatchObject({ near: "Test Peak", nearKind: "peak" });
    expect(out[1].properties?.wilderness).toBe("Test Wilderness");
    for (const f of out) expect(cardTitle(remoteness, f)).not.toMatch(/feature/i);
    expect(roadDistanceName(20)).toBe("20 km or more from the nearest road");
    expect(roadDistanceName(3.24)).toBe("3.2 km from the nearest road");
  });

  it("gives a Forest Service roadless area half the wilderness bonus", () => {
    const cell = latLngToCell(39.1, -120.25, 7);
    const roadless = [{ ...ROADLESS, properties: { name: roadlessName(ROADLESS.properties ?? {}) } }];
    const [f] = scoreCells({ cells: [cell], roads: [], wilderness: [], roadless, camps: [], refLat: 39.1 });
    expect(f.properties?.signals).toEqual({ roadDistanceKm: 20, inWilderness: false, inRoadlessArea: true, campsitesWithin2km: 0 });
    expect(f.properties?.v).toBe(90);
    expect(f.properties?.roadlessArea).toBe("Granite Chief roadless area (Tahoe National Forest)");
  });

  it("returns only hexagons scoring 40 and up by default and says so; minScore 0 returns every one", async () => {
    roadlessBody = () => Response.json({ type: "FeatureCollection", features: [ROADLESS] });
    const all = features(await remoteness.query(ctx(), { resolution: 7, minScore: 0 }));
    const result = await remoteness.query(ctx(), remoteness.input.parse({}));
    const remote = features(result);
    expect(remote.length).toBeGreaterThan(0);
    expect(remote.length).toBeLessThan(all.length);
    expect(remote.every((f) => (f.properties?.v as number) >= 40)).toBe(true);
    expect("coverageNote" in result && result.coverageNote).toMatch(new RegExp(`Showing the ${remote.length} of ${all.length} hexagons scoring 40 or more`));
    expect(all.some((f) => f.properties?.signals.inRoadlessArea === true)).toBe(true);
  });

  it("says when no hexagon is remote enough", async () => {
    const result = await remoteness.query(ctx(), { resolution: 7, minScore: 100 });
    expect(features(result)).toEqual([]);
    expect("coverageNote" in result && result.coverageNote).toMatch(/No hexagon in view scores 100 or more/);
  });

  it("degrades with a note when the roadless-area service fails", async () => {
    roadlessBody = () => new Response("down", { status: 503 });
    const result = await remoteness.query(ctx(), { resolution: 7, minScore: 0 });
    expect("coverageNote" in result && result.coverageNote).toMatch(/without Forest Service roadless areas \(ArcGIS service returned 503\)/);
    expect(features(result)[0].properties?.signals).not.toHaveProperty("inRoadlessArea");
  });

  it("declares no time, a worded score legend, labels by place and a card without the cell id", () => {
    expect(timeShapeOf(remoteness)).toEqual({ shape: "none" });
    const legend = legendOf(remoteness);
    expect(legend.kind).toBe("ramp");
    expect(legend.stops?.map((s) => s.value)).toEqual([0, 40, 70, 100]);
    expect(legend.stops?.every((s) => /[a-z]/i.test(s.label))).toBe(true);
    expect(legend.note).toMatch(/under 40 are hidden by default/);
    expect(labelsOf(remoteness)).toEqual({ field: "name", max: 5, rankBy: "v" });
    expect(remoteness.card?.hidden).toContain("h3");
    expect(remoteness.input.parse({})).toEqual({ resolution: 7, minScore: 40 });
    expect(contractProblems(remoteness)).toEqual([]);
  });
});
