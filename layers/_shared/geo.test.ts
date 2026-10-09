import { describe, expect, it } from "vitest";
import type { Position } from "geojson";
import {
  GridIndex,
  centroid,
  countWithinKm,
  geometryBBox,
  haversineKm,
  lineMidpoint,
  nearestKm,
  pointInPolygon,
} from "./geo";

describe("haversineKm", () => {
  it("is about 111 km per degree of latitude and zero for the same point", () => {
    expect(haversineKm([0, 0], [0, 1])).toBeCloseTo(111.2, 0);
    expect(haversineKm([-120, 39], [-120, 39])).toBe(0);
  });

  it("shrinks degrees of longitude with latitude", () => {
    expect(haversineKm([0, 60], [1, 60])).toBeCloseTo(55.6, 0);
  });
});

describe("lineMidpoint", () => {
  it("returns the point halfway along by distance", () => {
    const mid = lineMidpoint([
      [0, 0],
      [0, 1],
      [0, 3],
    ]);
    expect(mid?.[0]).toBeCloseTo(0, 9);
    expect(mid?.[1]).toBeCloseTo(1.5, 6);
  });

  it("handles one-point and empty lines", () => {
    expect(lineMidpoint([[5, 5]])).toEqual([5, 5]);
    expect(lineMidpoint([])).toBeNull();
  });
});

describe("centroid", () => {
  it("uses the point, the line midpoint, or the outer-ring vertex average", () => {
    expect(centroid({ type: "Feature", geometry: { type: "Point", coordinates: [1, 2] }, properties: {} })).toEqual([1, 2]);
    expect(
      centroid({ type: "Feature", geometry: { type: "LineString", coordinates: [[0, 0], [2, 0]] }, properties: {} })?.[0],
    ).toBeCloseTo(1, 6);
    expect(
      centroid({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] },
        properties: {},
      }),
    ).toEqual([1, 1]);
    expect(centroid({ type: "Feature", geometry: null as never, properties: {} })).toBeNull();
  });
});

describe("countWithinKm and nearestKm", () => {
  const pts: Position[] = [
    [-120, 39],
    [-120, 39.003], // ~0.33 km north
    [-120, 39.1], // ~11 km north
  ];

  it("counts points within a radius", () => {
    expect(countWithinKm([-120, 39], pts, 0.5)).toBe(2);
    expect(countWithinKm([-120, 39], pts, 20)).toBe(3);
  });

  it("finds the nearest distance, Infinity for none", () => {
    expect(nearestKm([-120, 39.1], pts)).toBe(0);
    expect(nearestKm([-120, 39.05], pts)).toBeCloseTo(5.23, 1);
    expect(nearestKm([0, 0], [])).toBe(Infinity);
  });
});

describe("GridIndex", () => {
  it("agrees with the linear scan on random points", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pts: Position[] = Array.from({ length: 400 }, () => [-120.5 + rand(), 38.5 + rand()]);
    const grid = new GridIndex<number>(1, 39);
    pts.forEach((p, i) => grid.add(p, i));

    for (let k = 0; k < 30; k++) {
      const q: Position = [-120.5 + rand(), 38.5 + rand()];
      let n = 0;
      grid.forEachWithin(q, 3, () => (n += 1));
      expect(n).toBe(countWithinKm(q, pts, 3));
      expect(grid.nearestKm(q, 50)).toBeCloseTo(nearestKm(q, pts), 9);
    }
  });

  it("returns Infinity when nothing is within the search limit", () => {
    const grid = new GridIndex(1, 0);
    expect(grid.nearestKm([0, 0], 20)).toBe(Infinity);
    grid.add([0, 1], 0);
    expect(grid.nearestKm([0, 0], 20)).toBe(Infinity);
    expect(grid.nearestKm([0, 0], 200)).toBeCloseTo(111.2, 0);
  });
});

describe("pointInPolygon", () => {
  const square = { type: "Polygon" as const, coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]] };

  it("is true inside, false outside and inside a hole", () => {
    expect(pointInPolygon([3, 3], square)).toBe(true);
    expect(pointInPolygon([5, 3], square)).toBe(false);
    expect(pointInPolygon([1.5, 1.5], square)).toBe(false);
  });

  it("handles MultiPolygon and non-polygons", () => {
    const multi = { type: "MultiPolygon" as const, coordinates: [square.coordinates, [[[10, 10], [11, 10], [11, 11], [10, 10]]]] };
    expect(pointInPolygon([10.8, 10.2], multi)).toBe(true);
    expect(pointInPolygon([1, 1], { type: "Point", coordinates: [1, 1] })).toBe(false);
    expect(pointInPolygon([1, 1], null)).toBe(false);
  });

  it("geometryBBox covers every ring", () => {
    expect(geometryBBox(square)).toEqual([0, 0, 4, 4]);
    expect(geometryBBox(null)).toBeNull();
  });
});
