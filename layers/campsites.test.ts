import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { buildCampsitesQuery, normalizeCampsites, wayCentroid } from "./campsites";
import fixture from "./__fixtures__/campsites.tahoe.json";

const TAHOE: [number, number, number, number] = [-120.2, 38.85, -120, 39];
const DEFAULTS = { backcountryOnly: false, includeParking: true };

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string) {
  return { bbox: TAHOE, zoom: 12, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

function geo(fc: ReturnType<typeof normalizeCampsites>) {
  return fc.features;
}

describe("buildCampsitesQuery", () => {
  it("unions camp_site nodes and ways with parking that has a capacity, in (south,west,north,east) order", () => {
    const q = buildCampsitesQuery(TAHOE, DEFAULTS);
    expect(q).toContain('node["tourism"="camp_site"](38.85,-120.2,39,-120)');
    expect(q).toContain('way["tourism"="camp_site"](38.85,-120.2,39,-120)');
    expect(q).toContain('node["amenity"="parking"]["capacity"](38.85,-120.2,39,-120)');
    expect(q).toContain('way["amenity"="parking"]["capacity"](38.85,-120.2,39,-120)');
    expect(q).toContain("out tags geom");
    expect(q).not.toContain('"backcountry"');
  });

  it("drops the parking selectors when includeParking is false", () => {
    const q = buildCampsitesQuery(TAHOE, { backcountryOnly: false, includeParking: false });
    expect(q).not.toContain("parking");
    expect(q).toContain('"tourism"="camp_site"');
  });

  it("restricts camp sites, but not parking, to backcountry=yes when backcountryOnly is true", () => {
    const q = buildCampsitesQuery(TAHOE, { backcountryOnly: true, includeParking: true });
    expect(q).toContain('node["tourism"="camp_site"]["backcountry"="yes"]');
    expect(q).toContain('way["tourism"="camp_site"]["backcountry"="yes"]');
    expect(q).not.toMatch(/parking"\]\["capacity"\]\["backcountry"/);
  });
});

describe("wayCentroid", () => {
  it("returns the center of a square ring", () => {
    const ring = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 2 },
      { lat: 2, lon: 2 },
      { lat: 2, lon: 0 },
      { lat: 0, lon: 0 },
    ];
    expect(wayCentroid(ring)).toEqual([1, 1]);
  });

  it("uses the area centroid, not the vertex average, for an uneven ring", () => {
    const ring = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 1 },
      { lat: 0, lon: 2 },
      { lat: 0, lon: 3 },
      { lat: 3, lon: 0 },
      { lat: 0, lon: 0 },
    ];
    const [lon, lat] = wayCentroid(ring) ?? [NaN, NaN];
    expect(lon).toBeCloseTo(1, 9);
    expect(lat).toBeCloseTo(1, 9);
  });

  it("averages the vertices of an open line and returns null for an empty geometry", () => {
    expect(wayCentroid([{ lat: 0, lon: 0 }, { lat: 2, lon: 4 }])).toEqual([2, 1]);
    expect(wayCentroid([])).toBeNull();
  });
});

describe("normalizeCampsites", () => {
  it("turns the Tahoe fixture into points: nodes keep their position, ways become centroids", () => {
    const fc = normalizeCampsites(fixture);
    expect(geo(fc).length).toBe(fixture.elements.length);
    expect(geo(fc).every((f) => f.geometry.type === "Point")).toBe(true);

    const node = fixture.elements.find((e) => e.type === "node");
    if (!node || node.type !== "node") throw new Error("fixture needs a node");
    const nodeFeature = geo(fc).find((f) => f.properties?.osmId === `node/${node.id}`);
    expect(nodeFeature?.geometry).toEqual({ type: "Point", coordinates: [node.lon, node.lat] });

    const way = fixture.elements.find((e) => e.type === "way" && e.tags?.tourism === "camp_site");
    if (!way || way.type !== "way") throw new Error("fixture needs a camp_site way");
    const wayFeature = geo(fc).find((f) => f.properties?.osmId === `way/${way.id}`);
    if (wayFeature?.geometry.type !== "Point") throw new Error("expected a point");
    const [lon, lat] = wayFeature.geometry.coordinates;
    const lons = (way.geometry ?? []).map((p) => p.lon);
    const lats = (way.geometry ?? []).map((p) => p.lat);
    expect(lon).toBeGreaterThanOrEqual(Math.min(...lons));
    expect(lon).toBeLessThanOrEqual(Math.max(...lons));
    expect(lat).toBeGreaterThanOrEqual(Math.min(...lats));
    expect(lat).toBeLessThanOrEqual(Math.max(...lats));
  });

  it("carries capacity as v and as a property on parking, and reads fee", () => {
    const fc = normalizeCampsites(fixture);
    const parking = geo(fc).filter((f) => f.properties?.kind === "parking");
    expect(parking).toHaveLength(1);
    expect(parking[0].properties).toMatchObject({ kind: "parking", capacity: 62, v: 62, fee: true });
  });

  it("marks camp sites with kind and parses backcountry, tents, caravans, fee and capacity tags", () => {
    const fc = normalizeCampsites({
      elements: [
        {
          type: "node",
          id: 1,
          lat: 39,
          lon: -120,
          tags: {
            tourism: "camp_site",
            name: "Lake View",
            backcountry: "yes",
            tents: "yes",
            caravans: "no",
            fee: "no",
            capacity: "12",
          },
        },
      ],
    });
    expect(geo(fc)[0].properties).toEqual({
      kind: "camp_site",
      osmId: "node/1",
      name: "Lake View",
      backcountry: true,
      tents: true,
      caravans: false,
      fee: false,
      capacity: 12,
    });
    expect(geo(fc)[0].properties).not.toHaveProperty("v");
  });

  it("skips parking whose capacity is not a plain positive number and elements without a position", () => {
    const fc = normalizeCampsites({
      elements: [
        { type: "node", id: 1, lat: 39, lon: -120, tags: { amenity: "parking", capacity: "10-20" } },
        { type: "node", id: 2, lat: 39, lon: -120, tags: { amenity: "parking", capacity: "0" } },
        { type: "way", id: 3, geometry: [], tags: { tourism: "camp_site" } },
        { type: "node", id: 4, tags: { tourism: "camp_site" } },
        { type: "node", id: 5, lat: 39, lon: -120, tags: { amenity: "parking", capacity: "8" } },
      ],
    });
    expect(geo(fc).map((f) => f.properties?.osmId)).toEqual(["node/5"]);
  });

  it("returns nothing for a malformed body", () => {
    expect(normalizeCampsites(null).features).toHaveLength(0);
    expect(normalizeCampsites({ elements: "x" }).features).toHaveLength(0);
  });
});

describe("campsites layer", () => {
  it("declares global ODbL coverage and a 10,000 km2 cap", () => {
    expect(layer.coverage).toBe("global");
    expect(layer.license).toContain("ODbL");
    expect(layer.maxAreaKm2).toBe(10_000);
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.optionalEnv).toContain("OVERPASS_URL");
  });

  it("posts one Overpass query and returns a cited collection", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    const r = await layer.query(ctx(stub, "campsites:k"), DEFAULTS);
    expect(stub).toHaveBeenCalledTimes(1);
    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit & { cacheKey?: string }];
    expect(url).toBe("https://overpass-api.de/api/interpreter");
    expect(init.method).toBe("POST");
    expect(decodeURIComponent(String(init.body))).toContain('["amenity"="parking"]["capacity"]');
    expect(init.cacheKey).toBe("campsites:k:campsites");
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(fixture.elements.length);
    expect(r.citation.source).toContain("OpenStreetMap");
    expect(r.coverageNote).toBeUndefined();
  });

  it("maps a failing Overpass to an upstream error after the fallback", async () => {
    const stub = vi.fn(async () => new Response("slow down", { status: 429 }));
    const r = await layer.query(ctx(stub), DEFAULTS);
    expect(r).toEqual({ error: "Overpass returned 429", hint: "upstream" });
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("caps at 5,000 points, keeping every camp site and the biggest parking lots, and says so", async () => {
    const elements = [
      { type: "node", id: 1, lat: 39, lon: -120, tags: { tourism: "camp_site" } },
      ...Array.from({ length: 5100 }, (_, i) => ({
        type: "node",
        id: 100 + i,
        lat: 39,
        lon: -120,
        tags: { amenity: "parking", capacity: String(i + 1) },
      })),
    ];
    const stub = vi.fn(async () => new Response(JSON.stringify({ elements }), { status: 200 }));
    const r = await layer.query(ctx(stub), DEFAULTS);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(5000);
    expect(r.data.features.some((f) => f.properties?.kind === "camp_site")).toBe(true);
    const caps = r.data.features.flatMap((f) => (f.properties?.kind === "parking" ? [f.properties.v as number] : []));
    expect(Math.min(...caps)).toBe(5100 - 4999 + 1); // 4,999 parking lots kept, smallest dropped first
    expect(Math.max(...caps)).toBe(5100);
    expect(r.coverageNote).toBe("Showing 5,000 of 5,101 sites (all camp sites, then the largest parking lots); zoom in for the rest");
  });

  it("returns 422 zoom_in from runLayer for a bbox over 10,000 km2", async () => {
    const res = await runLayer("campsites", { bbox: [-121, 38, -119, 40] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ hint: "zoom_in" });
  });

  it("rejects non-boolean input through runLayer", async () => {
    const res = await runLayer("campsites", { bbox: TAHOE, input: { backcountryOnly: "yes" } });
    expect(res.status).toBe(400);
  });
});
