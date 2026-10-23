import { describe, expect, it } from "vitest";
import type { Feature, Geometry } from "geojson";
import { areaKm2, haversineM, inArea, lengthKm, ringAreaM2 } from "./geo";
import { combineFeatures, combineProblem, geometryKind } from "./combine";

const f = (geometry: Geometry, properties: Record<string, unknown> = {}): Feature => ({ type: "Feature", geometry, properties });
const pt = (lon: number, lat: number, name: string) => f({ type: "Point", coordinates: [lon, lat] }, { name });
/** A square of side `deg` degrees with its south-west corner at (lon, lat). */
const square = (lon: number, lat: number, deg: number, name: string) =>
  f({ type: "Polygon", coordinates: [[[lon, lat], [lon + deg, lat], [lon + deg, lat + deg], [lon, lat + deg], [lon, lat]]] }, { name });

// A trail running east along latitude 46.85 near Mount Rainier, and camps at known distances north of it.
const trail = f({ type: "LineString", coordinates: [[-121.8, 46.85], [-121.7, 46.85], [-121.6, 46.85]] }, { name: "Wonderland Trail" });
const metresNorth = (m: number) => m / 111_195;
const camps = [
  pt(-121.75, 46.85 + metresNorth(200), "Camp 200 m"),
  pt(-121.65, 46.85 + metresNorth(900), "Camp 900 m"),
  pt(-121.7, 46.85 + metresNorth(3000), "Camp 3 km"),
  pt(-121.5, 46.85, "Camp past the end"), // 7.6 km east of the trail's end
];

describe("geometry helpers", () => {
  it("measures distances, lengths and areas on the sphere", () => {
    expect(haversineM([0, 0], [0, 1])).toBeCloseTo(111_195, -1);
    expect(lengthKm(trail.geometry)).toBeCloseTo(15.2, 1);
    // One degree square at the equator is about 12,364 km².
    expect(areaKm2(square(0, 0, 1, "eq").geometry)).toBeCloseTo(12_364, -2);
    expect(ringAreaM2([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]])).toBeGreaterThan(0);
  });

  it("finds a point inside a polygon and outside its hole", () => {
    const withHole = f({
      type: "Polygon",
      coordinates: [
        [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
        [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]],
      ],
    });
    expect(inArea([0.5, 0.5], withHole.geometry)).toBe(true);
    expect(inArea([2, 2], withHole.geometry)).toBe(false);
    expect(inArea([5, 5], withHole.geometry)).toBe(false);
  });
});

describe("combineFeatures", () => {
  it("along: keeps the camps within 1 km of the trail, nearest first, with the distance and the trail's name", () => {
    const out = combineFeatures({ op: "along", a: camps, b: [trail], distanceM: 1000 });
    expect(out.count).toBe(2);
    expect(out.of).toBe(4);
    expect(out.features.map((x) => x.properties?.name)).toEqual(["Camp 200 m", "Camp 900 m"]);
    expect(out.features[0].properties?.distanceKm).toBeCloseTo(0.2, 2);
    expect(out.features[1].properties?.distanceKm).toBeCloseTo(0.9, 2);
    expect(out.features[0].properties?.nearest).toBe("Wonderland Trail");
    expect(out.totals).toEqual({ minDistanceKm: 0.2, maxDistanceKm: 0.9 });
  });

  it("near: a wider distance reaches the camp 3 km out; a point inside an area is at distance 0", () => {
    expect(combineFeatures({ op: "near", a: camps, b: [trail], distanceM: 3500 }).count).toBe(3);
    const lake = square(-121.76, 46.85, 0.02, "Lake");
    const out = combineFeatures({ op: "near", a: camps, b: [lake], distanceM: 100 });
    expect(out.features.map((x) => [x.properties?.name, x.properties?.distanceKm])).toEqual([["Camp 200 m", 0]]);
  });

  it("within and outside: points by position, naming the area they are inside", () => {
    const park = square(-121.8, 46.84, 0.2, "Mount Rainier National Park");
    const inside = combineFeatures({ op: "within", a: camps, b: [park] });
    expect(inside.features.map((x) => x.properties?.name)).toEqual(["Camp 200 m", "Camp 900 m", "Camp 3 km"]);
    expect(inside.features[0].properties?.inside).toBe("Mount Rainier National Park");
    const outside = combineFeatures({ op: "outside", a: camps, b: [park] });
    expect(outside.features.map((x) => x.properties?.name)).toEqual(["Camp past the end"]);
  });

  it("within: a line counts as inside when most of it is", () => {
    const park = square(-121.85, 46.8, 0.2, "Park");
    expect(combineFeatures({ op: "within", a: [trail], b: [park] }).count).toBe(1);
    const east = square(-121.62, 46.8, 0.2, "East");
    expect(combineFeatures({ op: "within", a: [trail], b: [east] }).count).toBe(0);
  });

  it("overlap: clips each area to the other layer's, with acres, share and the names it overlaps", () => {
    // Allotment 1 overlaps half of its area with habitat; allotment 2 a quarter; allotment 3 none.
    const allotments = [square(0, 0, 1, "Allotment 1"), square(2, 0, 1, "Allotment 2"), square(5, 0, 1, "Allotment 3")];
    const habitat = [square(0.5, 0, 1, "Tortoise unit A"), f({ type: "Polygon", coordinates: [[[2.5, 0.5], [4, 0.5], [4, 2], [2.5, 2], [2.5, 0.5]]] }, { name: "Tortoise unit B" })];
    const out = combineFeatures({ op: "overlap", a: allotments, b: habitat });
    expect(out.count).toBe(2);
    expect(out.features.map((x) => x.properties?.name)).toEqual(["Allotment 1", "Allotment 2"]);
    expect(out.features[0].properties?.overlapShare).toBeCloseTo(0.5, 2);
    expect(out.features[1].properties?.overlapShare).toBeCloseTo(0.25, 2);
    expect(out.features[0].properties?.overlapWith).toBe("Tortoise unit A");
    expect(out.features[1].properties?.overlapWith).toBe("Tortoise unit B");
    expect(out.features[0].properties?.overlapAcres).toBe(Math.round((out.features[0].properties?.overlapKm2 as number) * 247.105381));
    // The clipped piece is what the map draws.
    expect(areaKm2(out.features[0].geometry)).toBeCloseTo(out.features[0].properties?.overlapKm2 as number, 1);
    expect(out.totals.share).toBeCloseTo(0.25, 2); // 0.75 of 3 squares' area
  });

  it("outside on areas: keeps the part of each area outside the other, with its share", () => {
    const oldGrowth = [square(0, 0, 1, "Stand 1"), square(3, 0, 1, "Stand 2")];
    const wilderness = [square(0, 0, 0.5, "Wilderness")];
    const out = combineFeatures({ op: "outside", a: oldGrowth, b: wilderness });
    expect(out.features.map((x) => [x.properties?.name, x.properties?.outsideShare])).toEqual([
      ["Stand 2", 1],
      ["Stand 1", expect.closeTo(0.75, 2)],
    ]);
    expect(out.totals.share).toBeCloseTo(0.875, 2);
  });

  it("drive_time: features inside the reachable area", () => {
    const reach = square(-121.8, 46.84, 0.12, "30-minute drive");
    expect(combineFeatures({ op: "drive_time", a: camps, b: [reach] }).count).toBe(2);
  });

  it("skips a broken outline instead of failing the whole join", () => {
    const broken = f({ type: "Polygon", coordinates: [[[0, 0], [1, 0]]] }, { name: "Broken" });
    const out = combineFeatures({ op: "overlap", a: [broken, square(0, 0, 1, "Fine")], b: [square(0.5, 0.5, 1, "B")] });
    expect(out.features.map((x) => x.properties?.name)).toEqual(["Fine"]);
  });
});

describe("combineProblem", () => {
  it("names the wrong geometry in words", () => {
    expect(geometryKind(camps)).toBe("point");
    expect(geometryKind([trail])).toBe("line");
    expect(combineProblem("within", "point", "line")).toMatch(/needs areas/);
    expect(combineProblem("overlap", "point", "polygon")).toMatch(/areas in both/);
    expect(combineProblem("along", "point", "point")).toMatch(/needs a line/);
    expect(combineProblem("near", "point", null)).toMatch(/no features/);
    expect(combineProblem("along", "point", "line")).toBeNull();
  });
});
