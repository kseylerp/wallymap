import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { buildCampsitesQuery, buildWideCampsitesQuery, normalizeCampsites, wayCentroid } from "./campsites";
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

  it("stays within 1 m of the mean on a ~10 m ring near lon -120, lat 39", () => {
    const lon0 = -120.0000123;
    const lat0 = 39.0000456;
    const dLon = 0.00012; // about 9 m east-west at this latitude
    const dLat = 0.00009; // about 10 m north-south
    const ring = [
      { lat: lat0, lon: lon0 },
      { lat: lat0, lon: lon0 + dLon },
      { lat: lat0 + dLat, lon: lon0 + dLon },
      { lat: lat0 + dLat, lon: lon0 },
      { lat: lat0, lon: lon0 },
    ];
    const [lon, lat] = wayCentroid(ring) ?? [NaN, NaN];
    const metresLon = Math.abs(lon - (lon0 + dLon / 2)) * 111_320 * Math.cos((39 * Math.PI) / 180);
    const metresLat = Math.abs(lat - (lat0 + dLat / 2)) * 110_570;
    expect(Math.hypot(metresLon, metresLat)).toBeLessThan(1);
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
  it("declares global ODbL coverage, a 25,000 km2 soft cap and a named wide mode up to 1,500,000 km2", () => {
    expect(layer.coverage).toBe("global");
    expect(layer.license).toContain("ODbL");
    expect(layer.maxAreaKm2).toBe(25_000);
    expect(layer.hardMaxAreaKm2).toBe(1_500_000);
    expect(layer.wide).toEqual({ mode: "named", limit: 2000 });
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

  it("returns 422 zoom_in from runLayer only over 1,500,000 km2", async () => {
    const res = await runLayer("campsites", { bbox: [-130, 25, -65, 50] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ hint: "zoom_in", error: expect.stringMatching(/under 1500000 km²$/) });
  });

  it("asks for named camp sites only (no parking) with counts in a wide box", () => {
    const q = buildWideCampsitesQuery([-114, 37, -109, 42], { backcountryOnly: true }, 2000);
    expect(q).toContain('nwr["tourism"="camp_site"]["backcountry"="yes"](37,-114,42,-109)');
    // The named ones are filtered from the first set, not searched for again (a second search is ten times slower).
    expect(q).toContain('.all out count;nwr.all["name"]->.named;.named out count;');
    expect(q.match(/\(37,-114,42,-109\)/g)).toHaveLength(1);
    expect(q).toContain(".named out tags center 2000;");
    expect(q).not.toContain("parking");
  });

  it("answers a Utah-sized box wide: named camp sites with way centres, the count of all as total, and a note through runLayer", async () => {
    const body = {
      elements: [
        { type: "count", id: 0, tags: { nodes: "3000", ways: "1512", relations: "0", total: "4512" } },
        { type: "count", id: 0, tags: { nodes: "1200", ways: "600", relations: "0", total: "1800" } },
        { type: "node", id: 1, lat: 38, lon: -111, tags: { tourism: "camp_site", name: "Devils Garden" } },
        { type: "way", id: 2, center: { lat: 39, lon: -112 }, tags: { tourism: "camp_site", name: "Oak Creek" } },
        { type: "relation", id: 3, center: { lat: 40, lon: -113 }, tags: { tourism: "camp_site", name: "Group Site" } },
      ],
    };
    const stub = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("campsites", { bbox: [-114, 37, -109, 42], zoom: 6 });
      expect(res.status).toBe(200);
      expect(stub).toHaveBeenCalledTimes(1);
      const init = (stub.mock.calls[0] as unknown as [string, RequestInit])[1];
      const ql = decodeURIComponent(String(init.body).replace(/^data=/, ""));
      expect(ql).toContain(".named out tags center 2000;");
      expect(ql).not.toContain("parking");
      if (!("kind" in res.body) || res.body.kind !== "geojson") throw new Error("expected geojson");
      expect(res.body.data.features.map((f) => f.geometry)).toEqual([
        { type: "Point", coordinates: [-111, 38] },
        { type: "Point", coordinates: [-112, 39] },
        { type: "Point", coordinates: [-113, 40] },
      ]);
      expect(res.body.total).toBe(4512);
      expect(res.body.truncated).toBe(true);
      expect(res.body.coverageNote).toBe("Showing the 3 named of 4,512; zoom in under 25,000 km² for all; Parking lots are left out at this scale");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects non-boolean input through runLayer", async () => {
    const res = await runLayer("campsites", { bbox: TAHOE, input: { backcountryOnly: "yes" } });
    expect(res.status).toBe(400);
  });
});

describe("the campsite card", () => {
  it("says the kind in words and shows the facts OpenStreetMap has, the website as a named link", async () => {
    const { cardContent } = await import("@/lib/render/card");
    const { getLayer } = await import("./registry");
    const layer = getLayer("campsites")!;
    const feature = {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [-109.3, 38.8] },
      properties: { kind: "camp_site", name: "Dewey Bridge Campground", capacity: 17, fee: true, tents: true, website: "https://www.blm.gov/visit/dewey-bridge", osmId: "way/1" },
    };
    const card = cardContent(feature, { card: layer.card, fieldHelp: layer.fieldHelp });
    expect(card.facts.map((r) => `${r.label}: ${r.value}`)).toEqual(["Type: Campsite", "Capacity: 17", "Fee: Yes, costs money", "Tents allowed: Yes"]);
    expect(card.links).toEqual([{ key: "website", label: "Website", url: "https://www.blm.gov/visit/dewey-bridge" }]);
  });
});

describe("the parking card", () => {
  it("names a lot's v as its spaces, not \"V 3\"", async () => {
    const { cardContent } = await import("@/lib/render/card");
    const { getLayer } = await import("./registry");
    const layer = getLayer("campsites")!;
    const lot = { type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [-109.5, 38.6] }, properties: { kind: "parking", capacity: 3, v: 3, osmId: "way/2" } };
    const card = cardContent(lot, { card: layer.card, fieldHelp: layer.fieldHelp });
    expect(card.measure).toMatchObject({ label: "Parking spaces", value: "3" });
    // Capacity is the same number as the measure, so it is not repeated.
    expect(card.facts.map((r) => r.label)).toEqual(["Type"]);
  });
});
