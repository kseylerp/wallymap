import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { areaKm2, haversineM } from "./geo";
import { circle, driveReach, isochroneUrl, parseIsochrone } from "./reach";

/** A Valhalla isochrone answer as the public instance returns it (trimmed): one polygon feature per contour. */
const VALHALLA_BODY = {
  features: [
    {
      properties: { contour: 30, metric: "time" },
      geometry: { type: "Polygon", coordinates: [[[-109.8, 38.4], [-109.3, 38.4], [-109.3, 38.8], [-109.8, 38.8], [-109.8, 38.4]]] },
      type: "Feature",
    },
  ],
  type: "FeatureCollection",
};

describe("drive reach", () => {
  it("asks Valhalla for one auto contour as a cacheable GET", () => {
    const url = new URL(isochroneUrl([-109.5498, 38.5733], 30));
    expect(url.host).toBe("valhalla1.openstreetmap.de");
    expect(JSON.parse(url.searchParams.get("json")!)).toMatchObject({ costing: "auto", contours: [{ time: 30 }], polygons: true, locations: [{ lat: 38.5733, lon: -109.5498 }] });
  });

  it("reads the polygon, and keeps the largest part of a multipolygon", () => {
    expect(parseIsochrone(VALHALLA_BODY)?.coordinates[0]).toHaveLength(5);
    const multi = { features: [{ geometry: { type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [0, 1], [0, 0]]], [[[0, 0], [2, 0], [2, 2], [1, 3], [0, 2], [0, 0]]]] } }] };
    expect(parseIsochrone(multi)?.coordinates[0]).toHaveLength(6);
    expect(parseIsochrone({ error: "x" })).toBeNull();
  });

  it("uses the road network when Valhalla answers", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(VALHALLA_BODY), { status: 200 })) as unknown as CachedFetch;
    const reach = await driveReach([-109.55, 38.57], 30, fetch);
    expect(reach.method).toBe("valhalla");
    expect(reach.caveat).toBeUndefined();
    expect(reach.area.properties).toMatchObject({ minutes: 30 });
  });

  it("falls back to a straight-line circle at 1 km a minute, and says so", async () => {
    const fetch = vi.fn(async () => new Response("busy", { status: 503 })) as unknown as CachedFetch;
    const reach = await driveReach([-109.55, 38.57], 45, fetch);
    expect(reach.method).toBe("straight-line");
    expect(reach.caveat).toMatch(/straight-line 45 km circle/);
    const ring = reach.area.geometry.coordinates[0];
    expect(haversineM([-109.55, 38.57], ring[0])).toBeCloseTo(45_000, -3);
    expect(haversineM([-109.55, 38.57], ring[16])).toBeCloseTo(45_000, -3);
    expect(areaKm2(circle([0, 45], 10))).toBeCloseTo(Math.PI * 100, -1);
  });
});
