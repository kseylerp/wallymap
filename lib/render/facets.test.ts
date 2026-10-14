import type { Feature, FeatureCollection } from "geojson";
import { describe, expect, it } from "vitest";
import type { Facet } from "@/layers/types";
import {
  clearFacet,
  facetColorStops,
  facetGroups,
  facetRangeField,
  groupColors,
  hatchStepOf,
  isGroupPicked,
  sizeScale,
  toggleGroup,
  topFeatures,
  versionSides,
} from "@/lib/render/facets";
import { applyFilters } from "@/lib/render/filters";
import { PURPLE, SAGE } from "@/lib/render/palette";

const line = (props: Record<string, unknown>): Feature => ({
  type: "Feature",
  geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
  properties: props,
});
const fc = (features: Feature[]): FeatureCollection => ({ type: "FeatureCollection", features });

/** Singletrack Scale as mtb-trails declares it: 0 and 1 Easy, 2 Moderate, 3 Hard, 4 to 6 Expert. */
const mtb: Facet = {
  key: "v",
  label: "Difficulty",
  kind: "category",
  encode: "color",
  values: [
    { value: 0, label: "Easy" },
    { value: 1, label: "Easy" },
    { value: 2, label: "Moderate" },
    { value: 3, label: "Hard" },
    { value: 4, label: "Expert" },
    { value: 5, label: "Expert" },
    { value: 6, label: "Expert" },
  ],
};
const trails = fc([0, 1, 1, 2, 3, 3, 4, 6].map((v, i) => line({ name: `t${i}`, v })));

describe("facet chips write the filters engine (spec §12a)", () => {
  it("groups values that share a label into one chip, in declared order, with counts", () => {
    const groups = facetGroups(mtb, trails);
    expect(groups.map((g) => [g.label, g.count])).toEqual([
      ["Easy", 3],
      ["Moderate", 1],
      ["Hard", 2],
      ["Expert", 2],
    ]);
    expect(groups[0].values).toEqual(["0", "1"]);
  });

  it("pressing Hard keeps only hard trails; Expert joins it; pressing every chip clears the facet", () => {
    const groups = facetGroups(mtb, trails);
    const hard = toggleGroup({}, mtb, groups[2], groups);
    expect(hard).toEqual({ v: { include: ["3"] } });
    expect(applyFilters(trails, hard).features).toHaveLength(2);
    expect(isGroupPicked(hard, mtb, groups[2])).toBe(true);
    const both = toggleGroup(hard, mtb, groups[3], groups);
    expect(both.v.include).toEqual(["3", "4", "5", "6"]);
    expect(applyFilters(trails, both).features).toHaveLength(4);
    let all = both;
    for (const g of [groups[0], groups[1]]) all = toggleGroup(all, mtb, g, groups);
    expect(all).toEqual({});
    expect(toggleGroup(hard, mtb, groups[2], groups)).toEqual({});
  });

  it("keeps other facets, and 'all' clears the facet", () => {
    const filters = { v: { include: ["2"] }, kind: { include: ["mtb"] } };
    const groups = facetGroups(mtb, trails);
    const next = toggleGroup(filters, mtb, groups[2], groups);
    expect(next).toEqual({ kind: { include: ["mtb"] }, v: { include: ["2", "3"] } });
    expect(clearFacet(next, mtb)).toEqual({ kind: { include: ["mtb"] } });
  });

  it("colors the classes easy to hard on the sage → pink → purple ramp, the same for values that share a label", () => {
    const stops = new Map(facetColorStops(mtb));
    expect(stops.get("0")).toBe(stops.get("1"));
    expect(stops.get("0")).toBe(SAGE);
    expect(stops.get("6")).toBe(PURPLE);
    expect(groupColors(4)).toHaveLength(4);
  });

  it("shows a value the declaration does not name as its own chip, so nothing filterable hides", () => {
    const groups = facetGroups(mtb, fc([...trails.features, line({ v: 9 })]));
    expect(groups.at(-1)).toMatchObject({ label: "9", values: ["9"], count: 1 });
  });

  it("a range facet slides over the data in its unit; one number leaves nothing to slide", () => {
    const acres: Facet = { key: "acres", label: "Burned area", kind: "range", unit: "acres" };
    const fires = fc([10, 500, 9000].map((acres) => line({ acres })));
    expect(facetRangeField(acres, fires)).toEqual({ key: "acres", label: "Burned area", kind: "range", min: 10, max: 9000, integer: true, unit: "acres" });
    expect(facetRangeField(acres, fc([line({ acres: 5 })]))).toBeNull();
  });

  it("sizes, hatches and ranks by the measure", () => {
    expect(sizeScale(0, [0, 100])).toBeCloseTo(0.7);
    expect(sizeScale(100, [0, 100])).toBeCloseTo(1.8);
    expect(hatchStepOf(10, [10, 100_000])).toBe(0);
    expect(hatchStepOf(100_000, [10, 100_000])).toBe(4);
    expect(topFeatures(trails, "v", 2).map((f) => f.properties?.v)).toEqual([6, 4]);
  });

  it("finds the two versions of a versions facet, earliest first", () => {
    const kind: Facet = { key: "kind", label: "Boundary", kind: "category", versions: true, values: [{ value: "2021", label: "2021 boundary" }, { value: "current", label: "Current boundary" }] };
    const sides = versionSides(kind, fc([line({ kind: "current" }), line({ kind: "2021" })]));
    expect(sides?.a.label).toBe("2021 boundary");
    expect(sides?.b.values).toEqual(["current"]);
    expect(versionSides(kind, fc([line({ kind: "current" })]))).toBeNull();
  });
});

describe("facetFilterSummary", () => {
  it("says the filter in the facet's words, never 'Value 3–3'", async () => {
    const { facetFilterSummary } = await import("@/lib/render/facets");
    expect(facetFilterSummary([mtb], { v: { include: ["3", "4", "5", "6"] } })).toBe("Difficulty: Hard, Expert");
    const acres: Facet = { key: "acres", label: "Burned area", kind: "range", unit: "acres" };
    expect(facetFilterSummary([acres], { acres: { range: [1000, 380000] } })).toBe("Burned area 1,000–380,000 acres");
  });
});

describe("a hand-written range on a class facet (the model's v 3–6)", () => {
  it("presses the chips it covers and turns into an include list when a chip is pressed", () => {
    const groups = facetGroups(mtb, trails);
    const filters = { v: { range: [3, 6] as [number, number] } };
    expect(groups.map((g) => isGroupPicked(filters, mtb, g))).toEqual([false, false, true, true]);
    expect(toggleGroup(filters, mtb, groups[3], groups)).toEqual({ v: { include: ["3"] } });
  });
});
