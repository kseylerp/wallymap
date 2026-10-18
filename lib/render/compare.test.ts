import type { Feature, FeatureCollection, Point, Polygon } from "geojson";
import { describe, expect, it } from "vitest";
import {
  compareSummary,
  deltaFeatures,
  featureKey,
  hexDelta,
  presetFor,
  splitWindows,
  type CompareSpec,
} from "@/lib/render/compare";

const pt = (x: number, y: number): Point => ({ type: "Point", coordinates: [x, y] });
const fc = (features: Feature[]): FeatureCollection => ({ type: "FeatureCollection", features });
const feat = (properties: Record<string, unknown>, geometry: Feature["geometry"] = pt(-120, 39)): Feature => ({
  type: "Feature",
  geometry,
  properties,
});

describe("featureKey", () => {
  it("prefers osmId, then h3, id, siteId, name+year", () => {
    expect(featureKey(feat({ osmId: 7, h3: "x", id: "y", siteId: "z", name: "n", year: 1 }))).toBe("7");
    expect(featureKey(feat({ h3: "8928", id: "y" }))).toBe("8928");
    expect(featureKey(feat({ id: "abc", siteId: "z" }))).toBe("abc");
    expect(featureKey(feat({ siteId: "S-1", name: "n", year: 2020 }))).toBe("S-1");
    expect(featureKey(feat({ name: "Dixie", year: 2021 }))).toBe("Dixie|2021");
  });

  it("uses the top-level feature id when properties have none", () => {
    expect(featureKey({ ...feat({}), id: 42 })).toBe("42");
  });

  it("falls back to a stable geometry hash that ignores noise below 4 decimals", () => {
    const k1 = featureKey(feat({ name: "no year" }, pt(-120.000012, 39.000001)));
    const k2 = featureKey(feat({}, pt(-120.000013, 39.000002)));
    expect(k1).toMatch(/^geo:[0-9a-f]{8}$/);
    expect(k1).toBe(k2);
    expect(featureKey(feat({}, pt(-120.001, 39)))).not.toBe(k1);
  });

  it("distinguishes polygons that share a first coordinate but differ in extent", () => {
    const sq = (s: number): Polygon => ({
      type: "Polygon",
      coordinates: [[[0, 0], [s, 0], [s, s], [0, s], [0, 0]]],
    });
    expect(featureKey(feat({}, sq(1)))).not.toBe(featureKey(feat({}, sq(2))));
  });

  it("does not throw on null geometry", () => {
    const f = { type: "Feature", geometry: null, properties: null } as unknown as Feature;
    expect(featureKey(f)).toMatch(/^geo:/);
  });
});

describe("splitWindows", () => {
  const spec: CompareSpec = {
    layerId: "l",
    a: ["2015-01-01", "2015-12-31"],
    b: ["2025-01-01", "2025-12-31"],
    mode: "delta",
  };
  const input = fc([
    feat({ id: "a1", t: "2015-01-01T00:00:00Z" }),
    feat({ id: "a2", t: "2015-12-31T23:59:59Z" }),
    feat({ id: "gap", t: "2020-06-01T00:00:00Z" }),
    feat({ id: "b1", t: "2025-01-01T00:00:00Z" }),
    feat({ id: "nt" }),
    feat({ id: "bad", t: "not a date" }),
  ]);

  it("is inclusive at both ends, and a date-only end covers its whole day", () => {
    const { a, b } = splitWindows(input, spec);
    const ids = (c: FeatureCollection) => c.features.map((f) => f.properties!.id);
    expect(ids(a)).toEqual(["a1", "a2", "nt", "bad"]);
    expect(ids(b)).toEqual(["b1", "nt", "bad"]);
  });

  it("handles a single-day window and full ISO bounds", () => {
    const day: CompareSpec = { ...spec, a: ["2020-01-01", "2020-01-01"], b: ["2020-01-01T12:00:00Z", "2020-01-01T12:00:00Z"] };
    const c = fc([feat({ id: "x", t: "2020-01-01T12:00:00Z" }), feat({ id: "y", t: "2020-01-02T00:00:00Z" })]);
    const { a, b } = splitWindows(c, day);
    expect(a.features.map((f) => f.properties!.id)).toEqual(["x"]);
    expect(b.features.map((f) => f.properties!.id)).toEqual(["x"]);
  });

  it("does not mutate the input", () => {
    const copy = structuredClone(input);
    splitWindows(input, spec);
    expect(input).toEqual(copy);
  });
});

describe("deltaFeatures", () => {
  const a = fc([
    feat({ osmId: 1, v: 10 }, pt(0, 0)),
    feat({ osmId: 2, v: 5 }, pt(1, 1)),
    feat({ osmId: 3 }, pt(2, 2)),
  ]);
  const b = fc([
    feat({ osmId: 2, v: 8 }, pt(1.5, 1.5)),
    feat({ osmId: 3 }, pt(2, 2)),
    feat({ osmId: 4, v: 1 }, pt(3, 3)),
  ]);

  it("classifies and orders a-only, both, b-only", () => {
    const d = deltaFeatures(a, b);
    expect(d.features.map((f) => [f.properties!.osmId, f.properties!.delta])).toEqual([
      [1, "a-only"],
      [2, "both"],
      [3, "both"],
      [4, "b-only"],
    ]);
  });

  it("adds dv only for shared features with numeric v on both sides, and takes geometry from b", () => {
    const d = deltaFeatures(a, b);
    expect(d.features[1].properties!.dv).toBe(3);
    expect(d.features[1].geometry).toEqual(pt(1.5, 1.5));
    expect(d.features[2].properties).not.toHaveProperty("dv");
    expect(d.features[0].properties).not.toHaveProperty("dv");
  });

  it("does not mutate inputs", () => {
    const ca = structuredClone(a);
    const cb = structuredClone(b);
    deltaFeatures(a, b);
    expect(a).toEqual(ca);
    expect(b).toEqual(cb);
  });

  it("keeps the first of duplicate keys and handles empty sides", () => {
    const dup = fc([feat({ osmId: 1, v: 1 }), feat({ osmId: 1, v: 99 })]);
    expect(deltaFeatures(dup, fc([])).features).toHaveLength(1);
    expect(deltaFeatures(fc([]), fc([])).features).toEqual([]);
  });

  it("matches features without ids by geometry hash", () => {
    const d = deltaFeatures(fc([feat({}, pt(5, 5))]), fc([feat({}, pt(5, 5)), feat({}, pt(6, 6))]));
    expect(d.features.map((f) => f.properties!.delta)).toEqual(["both", "b-only"]);
  });
});

describe("hexDelta", () => {
  const cell = (h3: string, extra: Record<string, unknown> = {}, g = pt(0, 0)) => feat({ h3, ...extra }, g);

  it("uses count difference when no v is present, one feature per cell", () => {
    const a = fc([cell("c1"), cell("c1"), cell("c2")]);
    const b = fc([cell("c1"), cell("c3"), cell("c3"), cell("c3")]);
    const d = hexDelta(a, b);
    const byCell = Object.fromEntries(d.features.map((f) => [f.properties!.h3, f.properties!]));
    expect(d.features).toHaveLength(3);
    expect(byCell.c1).toMatchObject({ v: -1, delta: "a-only" });
    expect(byCell.c2).toMatchObject({ v: -1, delta: "a-only" });
    expect(byCell.c3).toMatchObject({ v: 3, delta: "b-only" });
  });

  it("uses summed v difference when v is present, with a zero class for unchanged cells", () => {
    const a = fc([cell("c1", { v: 4 }), cell("c2", { v: 2 })]);
    const b = fc([cell("c1", { v: 9 }, pt(1, 1)), cell("c2", { v: 2 })]);
    const d = hexDelta(a, b);
    expect(d.features[0].properties).toMatchObject({ h3: "c1", v: 5, vA: 4, vB: 9, delta: "b-only" });
    expect(d.features[0].geometry).toEqual(pt(1, 1));
    expect(d.features[1].properties).toMatchObject({ v: 0, delta: "both" });
  });

  it("ignores features without h3 and does not mutate inputs", () => {
    const a = fc([feat({ osmId: 1 }), cell("c1")]);
    const b = fc([cell("c1")]);
    const ca = structuredClone(a);
    expect(hexDelta(a, b).features).toHaveLength(1);
    expect(a).toEqual(ca);
  });
});

describe("compareSummary", () => {
  it("counts classes and averages dv over features that have one", () => {
    const d = deltaFeatures(
      fc([feat({ osmId: 1, v: 1 }), feat({ osmId: 2, v: 10 }), feat({ osmId: 3 })]),
      fc([feat({ osmId: 2, v: 14 }), feat({ osmId: 1, v: 2 }), feat({ osmId: 9 }), feat({ osmId: 10 })]),
    );
    expect(compareSummary(d)).toEqual({ aOnly: 1, bOnly: 2, both: 2, dvMean: 2.5 });
  });

  it("omits dvMean when no feature has dv", () => {
    const s = compareSummary(deltaFeatures(fc([feat({ osmId: 1 })]), fc([])));
    expect(s).toEqual({ aOnly: 1, bOnly: 0, both: 0 });
    expect(s).not.toHaveProperty("dvMean");
  });
});

describe("presetFor", () => {
  const today = new Date("2026-10-09T15:30:00Z");

  it("forest-loss compares 2015 and 2025 as a delta", () => {
    expect(presetFor("forest-loss", today)).toMatchObject({
      a: ["2015-01-01", "2015-12-31"],
      b: ["2025-01-01", "2025-12-31"],
      mode: "delta",
    });
  });

  it("night-lights toggles 2020-01-01 against three days ago", () => {
    expect(presetFor("night-lights", today)).toMatchObject({
      a: ["2020-01-01", "2020-01-01"],
      b: ["2026-10-06", "2026-10-06"],
      mode: "toggle",
    });
  });

  it("fire-perimeters runs 2016-2020 against 2021 through today", () => {
    expect(presetFor("fire-perimeters", today)).toMatchObject({
      a: ["2016-01-01", "2020-12-31"],
      b: ["2021-01-01", "2026-10-09"],
      mode: "delta",
    });
  });

  it("crosses month boundaries and does not mutate today", () => {
    const d = new Date("2026-03-02T00:00:00Z");
    expect(presetFor("night-lights", d).b).toEqual(["2026-02-27", "2026-02-27"]);
    expect(d.toISOString()).toBe("2026-03-02T00:00:00.000Z");
  });
});

describe("deltaFeatures: two outlines of one thing that share an id", () => {
  it("keeps the earlier outline as an edge when the shapes differ (a monument whose id is its name)", () => {
    const ring = (d: number): GeoJSON.Polygon => ({ type: "Polygon", coordinates: [[[0, 0], [d, 0], [d, d], [0, d], [0, 0]]] });
    const f = (d: number, boundary: string): GeoJSON.Feature => ({ type: "Feature", geometry: ring(d), properties: { id: "Bears Ears", name: "Bears Ears", boundary } });
    const out = deltaFeatures({ type: "FeatureCollection", features: [f(2, "2021")] }, { type: "FeatureCollection", features: [f(1, "current")] }, { idKey: "name" });
    expect(out.features.map((x) => [x.properties?.delta, x.properties?.deltaEdge ?? false])).toEqual([
      ["a-only", true],
      ["both", false],
    ]);
  });
});
