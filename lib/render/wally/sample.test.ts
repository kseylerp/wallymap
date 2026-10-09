import type { Feature, LineString } from "geojson";
import { describe, expect, it } from "vitest";
import type { LoadedLayer } from "@/lib/render/state";
import { lengthMeters } from "@/lib/render/wally/playback";
import { gainLoss, MAX_SAMPLES, nearestValues, sampleAlong, samplePoints } from "@/lib/render/wally/sample";

const line: LineString = { type: "LineString", coordinates: [[-120, 39], [-120, 39.01]] }; // ~1.11 km north

function layer(id: string, features: Feature[], unit?: string): LoadedLayer {
  return {
    id,
    title: id.toUpperCase(),
    style: { geometry: "point", color: "#000000", unit },
    result: { kind: "geojson", data: { type: "FeatureCollection", features }, citation: { source: "s", url: "u", retrieved: "r" } },
    receivedAt: "now",
  };
}

const pt = (lng: number, lat: number, v?: unknown): Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lng, lat] },
  properties: v === undefined ? {} : { v },
});

describe("samplePoints", () => {
  it("samples every 50 m including both ends", () => {
    const { distancesM, points } = samplePoints(line);
    const total = lengthMeters(line);
    expect(distancesM[0]).toBe(0);
    expect(distancesM.at(-1)).toBeCloseTo(total, 6);
    expect(distancesM[1]).toBe(50);
    expect(distancesM.length).toBe(Math.ceil(total / 50) + 1);
    expect(points[0]).toEqual([-120, 39]);
    expect(points.at(-1)).toEqual([-120, 39.01]);
  });

  it("widens the step on a long line to stay under the cap", () => {
    const long: LineString = { type: "LineString", coordinates: [[-120, 30], [-120, 33]] }; // ~333 km
    expect(samplePoints(long).distancesM.length).toBeLessThanOrEqual(MAX_SAMPLES + 1);
  });
});

describe("nearestValues", () => {
  it("takes the nearest feature within 200 m, else null", () => {
    // 0.001° of longitude at 39°N is about 86 m; 0.003° is about 259 m.
    const near = pt(-119.999, 39, 5);
    const nearer = pt(-119.9995, 39, 7);
    const far = pt(-119.997, 39.01, 9);
    expect(nearestValues([[-120, 39], [-120, 39.01]], [near, nearer, far])).toEqual([7, null]);
  });

  it("counts a point inside a polygon as distance 0 and measures to lines", () => {
    const poly: Feature = {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [[[-120.01, 38.99], [-119.99, 38.99], [-119.99, 39.001], [-120.01, 39.001], [-120.01, 38.99]]] },
      properties: { v: 2016 },
    };
    const road: Feature = { type: "Feature", geometry: { type: "LineString", coordinates: [[-120.001, 39.009], [-120.001, 39.011]] }, properties: { v: 3 } };
    expect(nearestValues([[-120, 39], [-120, 39.01]], [poly, road])).toEqual([2016, 3]);
  });
});

describe("sampleAlong", () => {
  it("builds one series per visible layer with values near the route, at most three", () => {
    const layers = {
      a: layer("a", [pt(-120.0005, 39.005, 10)], "ac"),
      b: layer("b", [pt(-120.0005, 39.005, 20)]),
      none: layer("none", [pt(-121, 40, 1)]),
      text: layer("text", [pt(-120, 39.005, "x")]),
      c: layer("c", [pt(-120.0005, 39.005, 30)]),
      d: layer("d", [pt(-120.0005, 39.005, 40)]),
      hidden: layer("hidden", [pt(-120.0005, 39.005, 50)]),
    };
    const ops = ["a", "b", "none", "text", "c", "d", "hidden"].map((id) => ({
      layerId: id,
      mode: "points" as const,
      visible: id !== "hidden",
    }));
    const { series, distancesM } = sampleAlong(line, layers, ops);
    // Top of the draw order first.
    expect(series.map((s) => s.layerId)).toEqual(["d", "c", "b"]);
    expect(series[0].values).toHaveLength(distancesM.length);
    expect(series[0].values.filter((v) => v !== null).every((v) => v === 40)).toBe(true);
    expect(sampleAlong(line, { a: layers.a }, [ops[0]]).series[0]).toMatchObject({ title: "A", unit: "ac" });
  });
});

describe("gainLoss", () => {
  it("sums climbs and descents, ignoring noise and gaps", () => {
    expect(gainLoss([100, 110, null, 105, 120, 119, 121, 90])).toEqual({ gain: 25, loss: 35 });
    expect(gainLoss([null, null])).toEqual({ gain: 0, loss: 0 });
  });
});
