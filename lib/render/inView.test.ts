import { describe, expect, it } from "vitest";
import type { Feature } from "geojson";
import { featuresInView, rangeOf, tileRange, tileShares } from "@/lib/render/inView";

const box = (x: number, v: number): Feature => ({ type: "Feature", properties: { v }, geometry: { type: "Polygon", coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 0]]] } });

describe("what the map shows (lib/render/inView.ts)", () => {
  const data = { type: "FeatureCollection" as const, features: [box(0, 1), box(5, 2), box(170, 3)] };

  it("keeps the features whose extent meets the view, the same object when all do", () => {
    expect(featuresInView(data, [-1, -1, 6, 2]).features.map((f) => f.properties?.v)).toEqual([1, 2]);
    expect(featuresInView(data, null)).toBe(data);
    expect(featuresInView(data, [-180, -10, 180, 10])).toBe(data);
    // A view across the antimeridian.
    expect(featuresInView(data, [160, -1, -170, 2]).features.map((f) => f.properties?.v)).toEqual([3]);
  });

  it("gives a range, and a tile sample's shares and range", () => {
    expect(rangeOf(data, "v")).toEqual([1, 3]);
    expect(tileShares({ field: "k", values: ["a", "a", "b", "a"] })).toEqual(new Map([["a", 0.75], ["b", 0.25]]));
    expect(tileShares({ field: "k", values: [] })).toBeUndefined();
    expect(tileRange({ field: "age", values: ["0.01", "66", "x"] })).toEqual([0.01, 66]);
  });
});
