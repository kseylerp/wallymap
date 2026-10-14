import type { LineString, MultiLineString, Position } from "geojson";
import { describe, expect, it } from "vitest";
import {
  dartIconSpec,
  directionDarts,
  gradientColors,
  gradientExpression,
  gradientPaths,
  gradientRgbAt,
  lineLengthMeters,
  markerInterval,
  METERS_PER_MILE,
  mileMarkers,
  routeLayerSpecs,
} from "@/lib/render/wally/routeLine";

/** Meters per degree of latitude for the haversine radius used by layers/_shared/geo.ts. */
const M_PER_DEG = (6371.0088 * 1000 * Math.PI) / 180;
const LAT0 = 39;
const LNG0 = -120;
const mPerDegLng = M_PER_DEG * Math.cos((LAT0 * Math.PI) / 180);

/** A point `north` and `east` meters from the origin. */
const at = (north: number, east = 0): Position => [LNG0 + east / mPerDegLng, LAT0 + north / M_PER_DEG];

/** A straight line north from the origin, `meters` long, with a vertex every 50 m. */
function northLine(meters: number): LineString {
  const coords: Position[] = [];
  for (let m = 0; m < meters; m += 50) coords.push(at(m));
  coords.push(at(meters));
  return { type: "LineString", coordinates: coords };
}

describe("directionDarts", () => {
  it("draws no darts on a route under 400 m", () => {
    expect(directionDarts(northLine(390))).toEqual([]);
  });

  it("draws one dart on a 450 m route", () => {
    expect(directionDarts(northLine(450))).toHaveLength(1);
  });

  it("spaces darts about 500 m apart, pointing along the line", () => {
    const line = northLine(3000);
    const darts = directionDarts(line);
    expect(darts).toHaveLength(6);
    const norths = darts.map((d) => (d.geometry.coordinates[1] - LAT0) * M_PER_DEG);
    expect(norths[0]).toBeCloseTo(250, 0);
    for (let i = 1; i < norths.length; i++) expect(norths[i] - norths[i - 1]).toBeCloseTo(500, 0);
    for (const dart of darts) expect(dart.properties.bearing === 0 || dart.properties.bearing === 360).toBe(true);
  });

  it("caps a long route at 12 darts, spread evenly", () => {
    const darts = directionDarts(northLine(20_000));
    expect(darts).toHaveLength(12);
  });

  it("measures each dart's bearing over ±40 m around it", () => {
    // East for 1 km, then north for 1 km: the dart nearest the corner still points mostly along its own leg.
    const coords = [at(0, 0), at(0, 1000), at(1000, 1000)];
    const darts = directionDarts({ type: "LineString", coordinates: coords });
    expect(darts).toHaveLength(4);
    expect(darts[0].properties.bearing).toBeCloseTo(90, 0);
    expect(darts[3].properties.bearing).toBeCloseTo(0, 0);
  });

  it("drops the opposing darts on the return leg of an out-and-back", () => {
    const out = [at(0), at(1000), at(2000)];
    const back = [at(2000, 6), at(1000, 6), at(0, 6)];
    const darts = directionDarts({ type: "LineString", coordinates: [...out, ...back] });
    // Eight slots of 500 m; the four on the way back run beside the way out in the other direction.
    expect(darts).toHaveLength(4);
    for (const dart of darts) expect(dart.properties.bearing).toBeCloseTo(0, 0);
  });

  it("keeps every dart on a loop that does not retrace itself", () => {
    const loop = [at(0, 0), at(1000, 0), at(1000, 1000), at(0, 1000), at(0, 0)];
    expect(directionDarts({ type: "LineString", coordinates: loop })).toHaveLength(8);
  });
});

describe("mileMarkers", () => {
  const miles = (n: number) => northLine(n * METERS_PER_MILE);

  it("marks every mile under 15 miles", () => {
    const markers = mileMarkers(miles(14.9));
    expect(markers.map((m) => m.properties.label)).toEqual(Array.from({ length: 14 }, (_, i) => `${i + 1} mi`));
    expect((markers[0].geometry.coordinates[1] - LAT0) * M_PER_DEG).toBeCloseTo(METERS_PER_MILE, 0);
  });

  it("marks every 2 miles at 40 miles, every 5 at 80, every 10 at 200, never at the end", () => {
    const labels = (n: number) => mileMarkers(miles(n)).map((m) => m.properties.label);
    expect(labels(40)).toEqual(Array.from({ length: 19 }, (_, i) => `${(i + 1) * 2} mi`));
    expect(labels(80)).toEqual(Array.from({ length: 15 }, (_, i) => `${(i + 1) * 5} mi`));
    expect(labels(200)).toEqual(Array.from({ length: 19 }, (_, i) => `${(i + 1) * 10} mi`));
  });

  it("uses kilometers when asked", () => {
    expect(mileMarkers(northLine(3500), "km").map((m) => m.properties.label)).toEqual(["1 km", "2 km", "3 km"]);
  });

  it("picks the 1/2/5/10 schedule", () => {
    expect([0.5, 14.9, 15, 49, 50, 99, 100, 500].map(markerInterval)).toEqual([1, 1, 2, 2, 5, 5, 10, 10]);
  });

  it("measures the line in meters", () => {
    expect(lineLengthMeters(northLine(1234))).toBeCloseTo(1234, 3);
  });
});

describe("route line styling", () => {
  it("builds a 24-stop purple-to-coral gradient over line-progress", () => {
    const expr = gradientExpression() as unknown[];
    expect(expr.slice(0, 3)).toEqual(["interpolate", ["linear"], ["line-progress"]]);
    const stops = expr.slice(3);
    expect(stops).toHaveLength(48);
    expect(stops[0]).toBe(0);
    expect(stops[1]).toBe("#6E5BFF");
    expect(stops[46]).toBe(1);
    expect(stops[47]).toBe("#F57272");
    const colors = gradientColors();
    expect(colors).toHaveLength(24);
    expect(new Set(colors).size).toBe(24);
  });

  it("puts a 7px white casing under a 4.5px gradient line with round caps and joins", () => {
    const [casing, line] = routeLayerSpecs("abc");
    expect(casing).toMatchObject({
      id: "route-abc-casing",
      type: "line",
      source: "route-abc",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#FFFFFF", "line-width": 7 },
    });
    expect(line).toMatchObject({
      id: "route-abc-line",
      type: "line",
      source: "route-abc",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-width": 4.5, "line-gradient": gradientExpression() },
    });
  });

  it("draws the dart as a 16px SVG at 2x", () => {
    const spec = dartIconSpec();
    expect(spec).toMatchObject({ width: 32, height: 32, pixelRatio: 2 });
    expect(spec.url.startsWith("data:image/svg+xml")).toBe(true);
    expect(decodeURIComponent(spec.url)).toContain('fill="#FFFFFF"');
  });
});

describe("gradient paths for deck lines", () => {
  const line: LineString = { type: "LineString", coordinates: [[-105, 40], [-105, 40.1], [-105, 40.3]] };

  it("runs the 24 stops: purple at the start, pink at the end, the stops between", () => {
    expect(gradientRgbAt(0)).toEqual([0x6e, 0x5b, 0xff]);
    expect(gradientRgbAt(1)).toEqual([0xf5, 0x72, 0x72]);
    const colors = gradientColors();
    const stop = (i: number) => [Number.parseInt(colors[i].slice(1, 3), 16), Number.parseInt(colors[i].slice(3, 5), 16), Number.parseInt(colors[i].slice(5, 7), 16)];
    expect(gradientRgbAt(5 / 23).map(Math.round)).toEqual(stop(5));
    expect(gradientRgbAt(-1)).toEqual(gradientRgbAt(0));
    expect(gradientRgbAt(Number.NaN)).toEqual(gradientRgbAt(0));
  });

  it("gives every vertex its fraction by length, 0 at the start and 1 at the end, cutting long segments", () => {
    const [{ path, t }] = gradientPaths(line);
    expect(path[0]).toEqual([-105, 40]);
    expect(path[path.length - 1]).toEqual([-105, 40.3]);
    expect(t[0]).toBe(0);
    expect(t[t.length - 1]).toBeCloseTo(1, 6);
    expect(t.every((x, i) => i === 0 || x > t[i - 1])).toBe(true);
    // The original middle vertex is 1/3 of the way along.
    expect(t[path.findIndex((p) => p[1] === 40.1)]).toBeCloseTo(1 / 3, 2);
    // No piece is longer than 1/96 of the line, so the color can change along a two-segment line.
    expect(path.length).toBeGreaterThan(90);
  });

  it("runs one gradient across the parts of a multi-line in order", () => {
    const multi: MultiLineString = { type: "MultiLineString", coordinates: [[[0, 0], [0, 0.1]], [[0, 0.2], [0, 0.3]]] };
    const [first, second] = gradientPaths(multi);
    expect(first.t[0]).toBe(0);
    expect(first.t[first.t.length - 1]).toBeCloseTo(0.5, 2);
    expect(second.t[0]).toBeCloseTo(0.5, 2);
    expect(second.t[second.t.length - 1]).toBeCloseTo(1, 6);
  });

  it("skips parts with fewer than two usable vertices and does not divide by zero", () => {
    expect(gradientPaths({ type: "LineString", coordinates: [[0, 0]] })).toEqual([]);
    const dot = gradientPaths({ type: "LineString", coordinates: [[1, 1], [1, 1]] });
    expect(dot[0].t.every((x) => x === 0)).toBe(true);
  });
});
