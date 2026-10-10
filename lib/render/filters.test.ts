import fs from "node:fs";
import path from "node:path";
import type { Feature, FeatureCollection } from "geojson";
import { describe, expect, it } from "vitest";
import { normalizeFirePerimeters } from "@/layers/fire-perimeters";
import { normalizeOverpass } from "@/layers/osm-trails";
import {
  applyFilters,
  deriveFilterFields,
  filterSummary,
  labelFor,
  MEASURE_STEPS,
  measureAt,
  measureKey,
  measureMinimum,
  measurePosition,
  measureRange,
  withMeasureMinimum,
  type FilterField,
} from "@/lib/render/filters";

function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "layers/__fixtures__", name), "utf8"));
}

const trails = normalizeOverpass(fixture("osm-trails.tahoe.json"));
const fireFixture = fixture("fire-perimeters.tahoe.json") as { history: FeatureCollection; wfigs: FeatureCollection };
const fires = normalizeFirePerimeters(fireFixture.history, fireFixture.wfigs);

function fc(rows: Record<string, unknown>[]): FeatureCollection {
  const features: Feature[] = rows.map((properties) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [0, 0] },
    properties,
  }));
  return { type: "FeatureCollection", features };
}

describe("deriveFilterFields on fixtures", () => {
  it("derives trail categories and never offers names or ids", () => {
    const fields = deriveFilterFields(trails);
    const keys = fields.map((f) => f.key);
    expect(keys).toContain("sac_scale");
    expect(keys).toContain("surface");
    expect(keys).toContain("highway");
    for (const banned of ["name", "osmId", "wikidata", "wikipedia"]) expect(keys).not.toContain(banned);
    const sac = fields.find((f) => f.key === "sac_scale");
    expect(sac).toMatchObject({ kind: "category", label: "Difficulty (sac_scale)" });
    if (sac?.kind !== "category") throw new Error("expected category");
    expect(sac.values).toEqual([
      { value: "mountain_hiking", count: 6 },
      { value: "hiking", count: 2 },
    ]);
  });

  it("derives fire year and acres ranges with integer flags, and skips t and name", () => {
    const fields = deriveFilterFields(fires);
    const keys = fields.map((f) => f.key);
    expect(keys).not.toContain("t");
    expect(keys).not.toContain("name");
    const year = fields.find((f) => f.key === "year");
    const acres = fields.find((f) => f.key === "acres");
    expect(year).toMatchObject({ kind: "range", integer: true, label: "Year" });
    expect(acres).toMatchObject({ kind: "range", integer: false, label: "Acres" });
  });

  it("puts categories before ranges", () => {
    const fields = deriveFilterFields(fires);
    const firstRange = fields.findIndex((f) => f.kind === "range");
    expect(fields.slice(firstRange).every((f) => f.kind === "range")).toBe(true);
  });
});

describe("deriveFilterFields rules", () => {
  it("excludes free text and ids", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ note: `free text ${i}`, thing_id: `x${i}`, rowId: i, kind: i % 2 ? "a" : "b" }));
    const keys = deriveFilterFields(fc(rows)).map((f) => f.key);
    expect(keys).toEqual(["kind"]);
  });

  it("treats mostly-unique short string columns as free text but keeps small repeated sets", () => {
    const unique = Array.from({ length: 10 }, (_, i) => ({ tag: `t${i}` }));
    expect(deriveFilterFields(fc(unique))).toEqual([]);
    const repeated = Array.from({ length: 10 }, (_, i) => ({ tag: i < 6 ? "a" : "b" }));
    expect(deriveFilterFields(fc(repeated)).map((f) => f.key)).toEqual(["tag"]);
  });

  it("caps categories at 12 by default and honors maxCategories", () => {
    const rows = Array.from({ length: 52 }, (_, i) => ({ c: `v${i % 13}` }));
    expect(deriveFilterFields(fc(rows))).toEqual([]);
    const twelve = Array.from({ length: 48 }, (_, i) => ({ c: `v${i % 12}` }));
    const fields = deriveFilterFields(fc(twelve));
    expect(fields).toHaveLength(1);
    expect(deriveFilterFields(fc(twelve), { maxCategories: 5 })).toEqual([]);
  });

  it("turns booleans into true/false categories and needs at least two values", () => {
    const rows = [{ informal: true }, { informal: false }, { informal: false }, { one: "x" }, { one: "x" }];
    const fields = deriveFilterFields(fc(rows));
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      key: "informal",
      kind: "category",
      values: [{ value: "false", count: 2 }, { value: "true", count: 1 }],
    });
  });

  it("sorts category values by count descending then value", () => {
    const rows = [{ c: "b" }, { c: "a" }, { c: "z" }, { c: "z" }, { c: "m" }, { c: "m" }, { c: "m" }];
    const f = deriveFilterFields(fc(rows))[0];
    if (f?.kind !== "category") throw new Error("expected category");
    expect(f.values.map((v) => v.value)).toEqual(["m", "z", "a", "b"]);
  });

  it("derives numeric ranges: 5 distinct values, or a span across 20 features", () => {
    expect(deriveFilterFields(fc([1, 2, 3, 4].map((n) => ({ n })))).length).toBe(0);
    const five = deriveFilterFields(fc([1, 2, 3, 4, 5.5].map((n) => ({ n }))));
    expect(five).toEqual([{ key: "n", label: "N", kind: "range", min: 1, max: 5.5, integer: false }]);
    const twenty = Array.from({ length: 20 }, (_, i) => ({ n: i < 10 ? 1 : 2 }));
    expect(deriveFilterFields(fc(twenty))[0]).toMatchObject({ key: "n", min: 1, max: 2, integer: true });
    const flat = Array.from({ length: 25 }, () => ({ n: 3 }));
    expect(deriveFilterFields(fc(flat))).toEqual([]);
  });

  it("ignores NaN and null numbers", () => {
    const rows = [1, 2, 3, 4, 5].map((n) => ({ n })).concat([{ n: NaN }, { n: null as unknown as number }]);
    const f = deriveFilterFields(fc(rows))[0];
    expect(f).toMatchObject({ min: 1, max: 5 });
  });

  it("does not offer v when it copies another property (fire perimeters: v = acres)", () => {
    expect(deriveFilterFields(fires).map((f) => f.key)).not.toContain("v");
    const copied = [1, 2, 3, 4, 5].map((n) => ({ v: n * 10, acres: n * 10 }));
    expect(deriveFilterFields(fc(copied)).map((f) => f.key)).toEqual(["acres"]);
    const own = [1, 2, 3, 4, 5].map((n) => ({ v: n * 10, acres: n * 7 }));
    expect(deriveFilterFields(fc(own)).map((f) => f.key)).toEqual(["v", "acres"]);
  });

  it("labels and units the v field", () => {
    const rows = [10, 20, 30, 40, 50].map((v) => ({ v }));
    expect(deriveFilterFields(fc(rows), { unitForV: "cfs" })[0]).toMatchObject({ label: "Value", unit: "cfs" });
    expect(deriveFilterFields(fc(rows), { unitForV: "score" })[0]).toMatchObject({ label: "Score (0–100)", unit: "score" });
    expect(deriveFilterFields(fc(rows))[0]).not.toHaveProperty("unit");
  });

  it("returns at most 8 fields, categories first, in order of first appearance", () => {
    const row = (i: number) => {
      const r: Record<string, unknown> = {};
      for (let k = 0; k < 6; k++) r[`cat${k}`] = i % 2 ? "x" : "y";
      for (let k = 0; k < 6; k++) r[`num${k}`] = i;
      return r;
    };
    const fields = deriveFilterFields(fc(Array.from({ length: 10 }, (_, i) => row(i))));
    expect(fields.map((f) => f.key)).toEqual(["cat0", "cat1", "cat2", "cat3", "cat4", "cat5", "num0", "num1"]);
  });
});

describe("applyFilters", () => {
  const data = fc([
    { k: "a", n: 1 },
    { k: "b", n: 5 },
    { k: "c", n: 10 },
    { n: 7 },
    { k: "a" },
  ]);

  it("returns the same object for undefined, empty, or inactive filters", () => {
    expect(applyFilters(data, undefined)).toBe(data);
    expect(applyFilters(data, {})).toBe(data);
    expect(applyFilters(data, { k: {} })).toBe(data);
    expect(applyFilters(data, { k: { include: [] } })).toBe(data);
  });

  it("keeps only included categories and drops features missing the key", () => {
    const out = applyFilters(data, { k: { include: ["a", "b"] } });
    expect(out.features.map((f) => f.properties)).toEqual([{ k: "a", n: 1 }, { k: "b", n: 5 }, { k: "a" }]);
  });

  it("matches booleans by their true/false text", () => {
    const b = fc([{ f: true }, { f: false }, { f: true }]);
    expect(applyFilters(b, { f: { include: ["true"] } }).features).toHaveLength(2);
  });

  it("treats range ends as inclusive and drops features without a number", () => {
    const out = applyFilters(data, { n: { range: [5, 10] } });
    expect(out.features.map((f) => f.properties?.n)).toEqual([5, 10, 7]);
    expect(applyFilters(data, { n: { range: [5, 10] } }).features.every((f) => typeof f.properties?.n === "number")).toBe(true);
  });

  it("combines filters across keys with AND and does not mutate the input", () => {
    const before = data.features.length;
    const out = applyFilters(data, { k: { include: ["a"] }, n: { range: [0, 3] } });
    expect(out.features.map((f) => f.properties)).toEqual([{ k: "a", n: 1 }]);
    expect(data.features).toHaveLength(before);
    expect(out.type).toBe("FeatureCollection");
  });

  it("filters the real fixtures", () => {
    const hard = applyFilters(trails, { sac_scale: { include: ["mountain_hiking"] } });
    expect(hard.features).toHaveLength(6);
    const big = applyFilters(fires, { acres: { range: [2000, Infinity] } });
    expect(big.features.length).toBeGreaterThan(0);
    expect(big.features.length).toBeLessThan(fires.features.length);
    expect(big.features.every((f) => (f.properties?.acres as number) >= 2000)).toBe(true);
  });
});

describe("review fixes: licence, long species lists, the measure key", () => {
  it("never offers a licence or a link as a filter", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ license: ["cc-by", "cc0", "cc-by-nc"][i % 3], url: `u${i % 3}` }));
    expect(deriveFilterFields(fc(rows))).toEqual([]);
  });

  it("offers the most common species of a long list, with the rest counted, and not the scientific name twice", () => {
    // 40 species over 200 sightings: elk is most common, then deer.
    const rows = Array.from({ length: 200 }, (_, i) => {
      const n = i < 30 ? 0 : i < 50 ? 1 : 2 + (i % 38);
      return { species: `s${n}`, scientificName: `Latin ${n}` };
    });
    const fields = deriveFilterFields(fc(rows));
    expect(fields.map((f) => f.key)).toEqual(["species"]);
    const species = fields[0] as Extract<FilterField, { kind: "category" }>;
    expect(species.values).toHaveLength(12);
    expect(species.values.slice(0, 2)).toEqual([{ value: "s0", count: 30 }, { value: "s1", count: 20 }]);
    expect(species.more).toBe(40 - 12);
    // A short list has no `more`.
    expect(deriveFilterFields(fc(rows.slice(0, 50)))[0]).not.toHaveProperty("more");
  });

  it("puts the threshold slider on the property v copies, so it and the panel's range are one filter", () => {
    expect(measureKey(fc([{ v: 10, acres: 10 }, { v: 2000, acres: 2000 }]))).toBe("acres");
    expect(measureKey(fc([{ v: 10, depth: 3 }, { v: 2000, depth: 3 }]))).toBe("v");
    const range = { min: 0, max: 100, integer: true, curve: 1 as const };
    expect(withMeasureMinimum({ acres: { range: [0, 70] } }, 30, range, "acres")).toEqual({ acres: { range: [30, 70] } });
    expect(measureMinimum({ acres: { range: [30, 70] } }, range, "acres")).toBe(30);
  });

  it("names a filter on v by its heading and formats the numbers", () => {
    expect(filterSummary([], { v: { range: [130341.73, 379802] } })).toBe("Value 130,342–379,802");
    expect(filterSummary([], { v: { range: [1.5, 2.25] } })).toBe("Value 1.5–2.25");
  });
});

describe("filterSummary", () => {
  const fields: FilterField[] = [
    { key: "sac_scale", label: "Difficulty (sac_scale)", kind: "category", values: [{ value: "hiking", count: 2 }] },
    { key: "acres", label: "Acres", kind: "range", min: 100, max: 9000, integer: false },
  ];

  it("joins categories and ranges with a middle dot", () => {
    expect(
      filterSummary(fields, { sac_scale: { include: ["hiking", "mountain_hiking"] }, acres: { range: [500, 9000] } }),
    ).toBe("Difficulty (sac_scale): hiking, mountain_hiking · Acres ≥ 500");
  });

  it("formats open lower ends, closed ranges, and skips full or empty filters", () => {
    expect(filterSummary(fields, { acres: { range: [100, 700] } })).toBe("Acres ≤ 700");
    expect(filterSummary(fields, { acres: { range: [200, 700] } })).toBe("Acres 200–700");
    expect(filterSummary(fields, { acres: { range: [100, 9000] } })).toBe("");
    expect(filterSummary(fields, { sac_scale: { include: [] } })).toBe("");
    expect(filterSummary([], {})).toBe("");
  });
});

describe("labelFor", () => {
  it("maps known keys", () => {
    expect(labelFor("sac_scale")).toBe("Difficulty (sac_scale)");
    expect(labelFor("trail_visibility")).toBe("Visibility");
    expect(labelFor("surface")).toBe("Surface");
    expect(labelFor("v")).toBe("Value");
    expect(labelFor("acres")).toBe("Acres");
    expect(labelFor("year")).toBe("Year");
    expect(labelFor("agency")).toBe("Agency");
    expect(labelFor("kind")).toBe("Type");
    expect(labelFor("confidence")).toBe("Confidence");
    expect(labelFor("species")).toBe("Species");
    expect(labelFor("scientificName")).toBe("Species");
  });

  it("humanizes everything else", () => {
    expect(labelFor("fire_name")).toBe("Fire name");
    expect(labelFor("bedCount")).toBe("Bed count");
  });
});

describe("measure threshold (the layer panel's fader on v)", () => {
  const fc = (vs: unknown[]): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: vs.map((v) => ({ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { v } })),
  });

  it("finds the range of numeric v, or null without two distinct numbers", () => {
    expect(measureRange(fc([10, 40, 90, "x", null]))).toEqual({ min: 10, max: 90, integer: true, curve: 1 });
    expect(measureRange(fc([0.5, 2.25, 3]))).toMatchObject({ integer: false });
    expect(measureRange(fc([50, 60, 70, 80, 380_000]))).toMatchObject({ curve: 3 });
    expect(measureRange(fc([5, 5, "x"]))).toBeNull();
    expect(measureRange(fc(["a", "b"]))).toBeNull();
  });

  it("maps the slider to a minimum on v and back, with no filter at the data minimum", () => {
    const range = { min: 0, max: 100, integer: true, curve: 1 as const };
    expect(measureAt(0, range)).toBe(0);
    expect(measureAt(MEASURE_STEPS / 2, range)).toBe(50);
    expect(measurePosition(50, range)).toBe(MEASURE_STEPS / 2);
    const cubic = { ...range, curve: 3 as const };
    expect(measurePosition(measureAt(700, cubic), cubic)).toBeCloseTo(700, -1);
    expect(withMeasureMinimum({}, 40, range)).toEqual({ v: { range: [40, 100] } });
    expect(withMeasureMinimum({ v: { range: [40, 100] }, kind: { include: ["a"] } }, 0, range)).toEqual({ kind: { include: ["a"] } });
    // An upper bound set in the filters panel stays.
    expect(withMeasureMinimum({ v: { range: [10, 70] } }, 30, range)).toEqual({ v: { range: [30, 70] } });
    // Back to "All" keeps that upper bound instead of dropping the whole v range.
    expect(withMeasureMinimum({ v: { range: [30, 70] } }, 0, range)).toEqual({ v: { range: [0, 70] } });
    expect(measureMinimum({ v: { range: [30, 70] } }, range)).toBe(30);
    expect(measureMinimum(undefined, range)).toBe(0);
  });
});
