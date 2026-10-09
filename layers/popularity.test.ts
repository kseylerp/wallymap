import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Feature, FeatureCollection } from "geojson";
import { z } from "zod";
import type { CachedFetch } from "@/lib/fetch";
import { clearRegistry, registerLayer } from "./registry";
import { defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext } from "./types";
import popularity, { rankNormalize, samplePoints, scorePopularity } from "./popularity";

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

// Trail A sits by a photo cluster and a 50-car lot; trail B is ~5 km east with nothing nearby.
const TRAIL_A = line(
  [
    [-120.1, 39.1],
    [-120.098, 39.101],
  ],
  { osmId: "way/1", name: "Popular Trail", informal: false, wikidata: "Q1" },
);
const TRAIL_B = line(
  [
    [-120.04, 39.1],
    [-120.038, 39.101],
  ],
  { osmId: "way/2", informal: false },
);
const SOCIAL = line(
  [
    [-120.0995, 39.1003],
    [-120.0992, 39.1006],
  ],
  { osmId: "way/3", informal: true },
);
const PHOTOS = Array.from({ length: 20 }, (_, i) => point([-120.1 + i * 0.0001, 39.1005], { source: "commons", v: 1 }));
const PARKING = point([-120.101, 39.103], { kind: "parking", capacity: 50, v: 50 });
const CAMP = point([-120.0995, 39.1002], { kind: "camp_site", name: "Busy Camp" });
const QUIET_CAMP = point([-120.03, 39.12], { kind: "camp_site" });

type Outcome = LayerResult | LayerError;

function fakeLayer(id: string, outcome: () => Outcome) {
  return defineLayer({
    id,
    title: id,
    description: id,
    coverage: "global",
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
let fakes: ReturnType<typeof fakeLayer>[];

function ctx(cacheKey?: string): QueryContext {
  return { bbox: BBOX, zoom: 12, env: {}, fetch: vi.fn() as unknown as CachedFetch, cacheKey };
}

async function run(target: "trails" | "campsites" = "trails", cacheKey?: string) {
  return popularity.query(ctx(cacheKey), { target });
}

function features(result: Outcome): Feature[] {
  if ("error" in result || result.kind !== "geojson") throw new Error(`expected features, got ${JSON.stringify(result)}`);
  return result.data.features;
}

beforeEach(() => {
  clearRegistry();
  trails = () => ok([TRAIL_A, TRAIL_B, SOCIAL]);
  camps = () => ok([PARKING, CAMP, QUIET_CAMP]);
  photos = () => ok(PHOTOS);
  fakes = [
    fakeLayer("osm-trails", () => trails()),
    fakeLayer("campsites", () => camps()),
    fakeLayer("photos", () => photos()),
  ];
  fakes.forEach((f) => registerLayer(f));
});

afterAll(() => clearRegistry());

describe("rankNormalize", () => {
  it("maps zero to 0, the largest to 1 and ties to the same rank", () => {
    expect(rankNormalize([0, 5, 5, 10])).toEqual([0, 0.75, 0.75, 1]);
    expect(rankNormalize([])).toEqual([]);
    expect(rankNormalize([0, 0])).toEqual([0, 0]);
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

describe("scorePopularity", () => {
  it("returns 0-100 scores with signals", () => {
    const out = scorePopularity({
      targets: [TRAIL_A, TRAIL_B, SOCIAL],
      photos: PHOTOS,
      parking: [PARKING],
      trails: [TRAIL_A, TRAIL_B, SOCIAL],
      targetsAreTrails: true,
      refLat: 39.1,
    });
    for (const f of out) {
      expect(f.properties?.v).toBeGreaterThanOrEqual(0);
      expect(f.properties?.v).toBeLessThanOrEqual(100);
    }
    expect(out[0].properties?.signals).toEqual({ photos: 20, parking: 50, wiki: true, informal: 1, named: true });
    expect(out[0].properties?.v).toBe(100);
    expect(out[1].properties?.signals).toEqual({ photos: 0, parking: 0, wiki: false, informal: 0, named: false });
    expect(out[1].properties?.v).toBe(0);
    // The social trail does not count itself as a nearby informal trail.
    expect(out[2].properties?.signals.informal).toBe(0);
  });
});

describe("popularity layer", () => {
  it("scores the trail near 20 photos and a 50-car lot above the one with none", async () => {
    const out = features(await run());
    const a = out.find((f) => f.properties?.osmId === "way/1");
    const b = out.find((f) => f.properties?.osmId === "way/2");
    expect(a?.properties?.v).toBeGreaterThan(b?.properties?.v as number);
    for (const f of out) {
      expect(f.properties?.v).toBeGreaterThanOrEqual(0);
      expect(f.properties?.v).toBeLessThanOrEqual(100);
      expect(f.properties?.signals).toEqual(
        expect.objectContaining({ photos: expect.any(Number), parking: expect.any(Number), wiki: expect.any(Boolean) }),
      );
      expect(f.properties?.popularityNote).toBe("estimate");
      expect(f.geometry.type).toBe("LineString");
    }
  });

  it("calls each composed layer with a distinct cacheKey suffix and the right input", async () => {
    await run("trails", "popularity:abc");
    const [trailsFake, campsFake, photosFake] = fakes;
    const keyOf = (fake: (typeof fakes)[number]) => (vi.mocked(fake.query).mock.calls[0][0] as QueryContext).cacheKey;
    expect(keyOf(trailsFake)).toBe("popularity:abc:trails");
    expect(keyOf(campsFake)).toBe("popularity:abc:campsites");
    expect(keyOf(photosFake)).toBe("popularity:abc:photos");
    expect(vi.mocked(trailsFake.query).mock.calls[0][1]).toMatchObject({ namedOnly: false });
    expect(vi.mocked(campsFake.query).mock.calls[0][1]).toMatchObject({ includeParking: true });
  });

  it("scores camp sites (not parking lots) when target is campsites", async () => {
    const out = features(await run("campsites"));
    expect(out.map((f) => f.properties?.kind)).toEqual(["camp_site", "camp_site"]);
    const [busy, quiet] = out;
    expect(busy.properties?.v).toBeGreaterThan(quiet.properties?.v as number);
    expect(busy.properties?.signals.informal).toBe(1);
  });

  it("degrades when photos fail: scores still span 0-100 and coverageNote names the missing signal", async () => {
    photos = () => ({ error: "Wikimedia Commons returned 503", hint: "upstream" });
    const result = await run();
    const out = features(result);
    expect("coverageNote" in result && result.coverageNote).toMatch(/photo counts.*503/);
    expect(out.find((f) => f.properties?.osmId === "way/1")?.properties?.signals.photos).toBeNull();
    expect(out.find((f) => f.properties?.osmId === "way/1")?.properties?.v).toBe(100);
  });

  it("degrades when a composed layer throws", async () => {
    camps = () => {
      throw new Error("boom");
    };
    const result = await run();
    expect("coverageNote" in result && result.coverageNote).toMatch(/parking capacity/);
    expect(features(result)[0].properties?.signals.parking).toBeNull();
  });

  it("returns the target layer's own error when it fails", async () => {
    trails = () => ({ error: "Overpass returned 504", hint: "upstream" });
    expect(await run()).toEqual({ error: "Overpass returned 504", hint: "upstream" });
  });

  it("passes composed layers' coverage notes through", async () => {
    photos = () => ok(PHOTOS, "Mapillary was skipped");
    const result = await run();
    expect("coverageNote" in result && result.coverageNote).toBe("Photos: Mapillary was skipped");
  });

  it("refuses an area over its limit", async () => {
    const result = await popularity.query({ ...ctx(), bbox: [-121, 38, -119, 40] }, { target: "trails" });
    expect(result).toMatchObject({ hint: "zoom_in" });
  });
});
