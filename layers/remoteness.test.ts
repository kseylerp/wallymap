import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import { latLngToCell } from "h3-js";
import { z } from "zod";
import type { CachedFetch } from "@/lib/fetch";
import { clearRegistry, registerLayer } from "./registry";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext } from "./types";
import remoteness, {
  buildRoadsQuery,
  cellPolygon,
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

function fetchStub() {
  return vi.fn(async () => new Response(JSON.stringify(roadsBody), { status: 200 }));
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
    const out = features(await remoteness.query(ctx(SMALL, fetch, "remoteness:k"), { resolution: 7 }));
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

    // Roads go through Overpass with their own cache suffix; composed layers get theirs.
    const roadCall = fetch.mock.calls[0] as unknown as [string, { cacheKey?: string }];
    expect(roadCall[1].cacheKey).toBe("remoteness:k:roads");
    const wildCtx = vi.mocked(fakes[0].query).mock.calls[0][0] as QueryContext;
    expect(wildCtx.cacheKey).toBe("remoteness:k:wilderness");
    expect(vi.mocked(fakes[1].query).mock.calls[0][1]).toMatchObject({ includeParking: false });
  });

  it("counts only camp sites, not parking, within 2 km", async () => {
    const out = features(await remoteness.query(ctx(), { resolution: 7 }));
    const near = out.find((f) => f.properties?.h3 === latLngToCell(39.05, -120.1, 7));
    expect(near?.properties?.signals.campsitesWithin2km).toBe(1);
  });

  it("refuses too many hexagons with a hint to lower the resolution or zoom in", async () => {
    const big: BBox = [-120.5, 39.0, -120.0, 39.5]; // ~2,400 km², ~3,300 cells at resolution 8
    const result = await remoteness.query(ctx([-121, 39.0, -120.0, 39.5]), { resolution: 8 });
    expect(result).toMatchObject({ hint: "zoom_in" });
    expect((result as LayerError).error).toMatch(/4,000.*resolution \(7\)/);
    // Under the cap at resolution 8 still works.
    expect(features(await remoteness.query(ctx(big), { resolution: 8 })).length).toBeLessThanOrEqual(4_000);
  });

  it("returns an error when the roads query fails", async () => {
    const fetch = vi.fn(async () => new Response("busy", { status: 504 }));
    const result = await remoteness.query(ctx(SMALL, fetch), { resolution: 7 });
    expect(result).toMatchObject({ hint: "upstream" });
  });

  it("degrades with a note when wilderness or campsites fail", async () => {
    wild = () => ({ error: "ArcGIS returned 500", hint: "upstream" });
    camps = () => {
      throw new Error("boom");
    };
    const result = await remoteness.query(ctx(), { resolution: 7 });
    const out = features(result);
    expect("coverageNote" in result && result.coverageNote).toMatch(/wilderness bonus.*500.*no-campsite bonus/);
    expect(out[0].properties?.signals.inWilderness).toBeNull();
    expect(out[0].properties?.signals.campsitesWithin2km).toBeNull();
  });

  it("skips wilderness outside the US and says scores top out at 80", async () => {
    const alps: BBox = [7.0, 46.0, 7.1, 46.1];
    roadsBody = { elements: [] };
    const result = await remoteness.query(ctx(alps), { resolution: 7 });
    expect(vi.mocked(fakes[0].query)).not.toHaveBeenCalled();
    expect("coverageNote" in result && result.coverageNote).toMatch(/at most 80/);
    for (const f of features(result)) expect(f.properties?.v).toBeLessThanOrEqual(80);
  });

  it("splits the campsites request when the padded view is over the campsites limit", async () => {
    const wide: BBox = [-121.2, 38.6, -120.0, 39.5]; // ~10,400 km², over the fake's 10,000
    await remoteness.query(ctx(wide), { resolution: 6 });
    expect(vi.mocked(fakes[1].query).mock.calls.length).toBeGreaterThan(1);
  });
});
