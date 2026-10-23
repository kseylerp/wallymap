import { describe, expect, it, vi } from "vitest";
import type { Polygon } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { countiesInBbox, decodeRing, polygonTouchesBox, simplifyRing } from "./counties";
import { pointInPolygon } from "./geo";

function ctx() {
  const fetch = vi.fn(async () => {
    throw new Error("no network: outlines are saved with the app");
  });
  return { stub: fetch, ctx: { bbox: [0, 0, 0, 0] as [number, number, number, number], zoom: 9, env: {}, fetch: fetch as unknown as CachedFetch } };
}

describe("saved Census county outlines", () => {
  it("decodes an encoded-polyline ring, longitude first, at 1/1000 degree", () => {
    // Google's documented example, here read as [lon, lat] pairs at 1e3: "_p~iF~ps|U" is 38.5, -120.2 at 1e5.
    expect(decodeRing("??_ibE_ibE", 1000)).toEqual([
      [0, 0],
      [100, 100],
    ]);
    expect(decodeRing("~ps|U_p~iF", 1e5)).toEqual([[-120.2, 38.5]]);
  });

  it("answers the SF Bay box from the saved file without asking any server, ordered by FIPS", async () => {
    const { stub, ctx: c } = ctx();
    const r = await countiesInBbox(c, [-122.7, 37.2, -121.7, 38.2]);
    expect(stub).not.toHaveBeenCalled();
    if (!r.ok) throw new Error(r.error);
    expect(r.truncated).toBe(false);
    expect(r.counties.map((x) => x.fips)).toEqual(["06001", "06013", "06041", "06055", "06067", "06075", "06081", "06085", "06087", "06095", "06097"]);
    const sf = r.counties.find((x) => x.fips === "06075");
    expect(sf).toMatchObject({ stateAbbr: "CA", countyFips: "075", name: "San Francisco County" });
    // Golden Gate Park is in San Francisco County; the Oakland hills are not.
    expect(pointInPolygon([-122.48, 37.77], sf!.geometry)).toBe(true);
    expect(pointInPolygon([-122.2, 37.8], sf!.geometry)).toBe(false);
  });

  it("finds Harris County for Houston, Connecticut's planning regions, and the Aleutians across 180°", async () => {
    const { ctx: c } = ctx();
    const houston = await countiesInBbox(c, [-95.8, 29.5, -95.0, 30.1]);
    expect(houston.ok && houston.counties.some((x) => x.fips === "48201" && x.name === "Harris County")).toBe(true);
    const ct = await countiesInBbox(c, [-73.7, 41.0, -71.8, 42.05]);
    expect(ct.ok && ct.counties.filter((x) => x.stateAbbr === "CT").map((x) => x.fips)).toContain("09110");
    const aleutians = await countiesInBbox(c, [172, 51, 180, 54]);
    expect(aleutians.ok && aleutians.counties.map((x) => x.fips)).toEqual(["02016"]);
  });

  it("returns the whole contiguous US (3,109 counties) under a megabyte of simplified outlines", async () => {
    const { ctx: c } = ctx();
    const r = await countiesInBbox(c, [-125, 24, -66, 50]);
    if (!r.ok) throw new Error(r.error);
    expect(r.counties.filter((x) => !["AK", "HI", "PR"].includes(x.stateAbbr))).toHaveLength(3109);
    expect(JSON.stringify(r.counties.map((x) => x.geometry)).length).toBeLessThan(1_000_000);
  });

  it("simplifies a ring for the view and keeps it closed with at least four points", () => {
    const ring = Array.from({ length: 101 }, (_, i) => {
      const a = (i / 100) * 2 * Math.PI;
      return [Math.cos(a), Math.sin(a)];
    });
    const out = simplifyRing(ring, 0.05);
    expect(out.length).toBeLessThan(ring.length);
    expect(out.length).toBeGreaterThanOrEqual(4);
    expect(out[0]).toEqual(out[out.length - 1]);
    expect(simplifyRing(ring, 5).length).toBe(ring.length);
  });

  it("counts a box that sits inside a county, or that a county edge crosses, and not one beside it", () => {
    const square: Polygon = { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };
    const ring = square.coordinates[0];
    expect(polygonTouchesBox(ring, [0, 0, 10, 10], [4, 4, 5, 5])).toBe(true);
    expect(polygonTouchesBox(ring, [0, 0, 10, 10], [9, 9, 12, 12])).toBe(true);
    const triangle = [[0, 0], [10, 0], [0, 10], [0, 0]];
    // Inside the triangle's box but past its long edge.
    expect(polygonTouchesBox(triangle, [0, 0, 10, 10], [8, 8, 9, 9])).toBe(false);
  });
});
