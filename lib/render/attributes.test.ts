import type { Feature, FeatureCollection } from "geojson";
import { describe, expect, it } from "vitest";
import type { Attribute } from "@/layers/types";
import {
  attributeFilterSummary,
  attributeGroups,
  clearAttribute,
  colorStops,
  groupColors,
  hatchStepOf,
  histogram,
  isFlagOn,
  isGroupPicked,
  isPresetPicked,
  pickedBins,
  presetCount,
  rankedTop,
  sizeScale,
  topPlaces,
  cardFeatureOf,
  toggleBin,
  toggleFlag,
  toggleGroup,
  togglePreset,
  topFeatures,
  versionSides,
  withNameQuery,
} from "@/lib/render/attributes";
import { applyFilters } from "@/lib/render/filters";
import { PURPLE, SAGE } from "@/lib/render/palette";

const line = (props: Record<string, unknown>): Feature => ({
  type: "Feature",
  geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
  properties: props,
});
const fc = (features: Feature[]): FeatureCollection => ({ type: "FeatureCollection", features });

/** Singletrack Scale as mtb-trails declares it: 0 and 1 Easy, 2 Moderate, 3 Hard, 4 to 6 Expert. */
const mtb: Attribute = {
  key: "v",
  label: "Difficulty",
  type: "ordinal",
  scale: "mtb:scale",
  encode: "color",
  levels: [
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

describe("chips write the filters engine (spec §12c)", () => {
  it("groups values that share a label into one chip, in declared order, with counts", () => {
    const groups = attributeGroups(mtb, trails);
    expect(groups.map((g) => [g.label, g.count])).toEqual([
      ["Easy", 3],
      ["Moderate", 1],
      ["Hard", 2],
      ["Expert", 2],
    ]);
    expect(groups[0].values).toEqual(["0", "1"]);
  });

  it("pressing Hard keeps only hard trails; Expert joins it; pressing every chip clears the attribute", () => {
    const groups = attributeGroups(mtb, trails);
    const hard = toggleGroup({}, mtb, groups[2], groups);
    expect(hard).toEqual({ v: { include: ["3"] } });
    expect(applyFilters(trails, hard).features).toHaveLength(2);
    expect(isGroupPicked(hard, mtb, groups[2])).toBe(true);
    const both = toggleGroup(hard, mtb, groups[3], groups);
    expect(both.v.include).toEqual(["3", "4", "5", "6"]);
    let all = both;
    for (const g of [groups[0], groups[1]]) all = toggleGroup(all, mtb, g, groups);
    expect(all).toEqual({});
    expect(toggleGroup(hard, mtb, groups[2], groups)).toEqual({});
  });

  it("keeps other attributes, and 'all' clears the attribute", () => {
    const filters = { v: { include: ["2"] }, kind: { include: ["mtb"] } };
    const groups = attributeGroups(mtb, trails);
    const next = toggleGroup(filters, mtb, groups[2], groups);
    expect(next).toEqual({ kind: { include: ["mtb"] }, v: { include: ["2", "3"] } });
    expect(clearAttribute(next, mtb)).toEqual({ kind: { include: ["mtb"] } });
  });

  it("colors an ordinal easy to hard on the sage → pink → purple ramp, the same for values that share a label", () => {
    const stops = new Map(colorStops(mtb));
    expect(stops.get("0")).toBe(stops.get("1"));
    expect(stops.get("0")).toBe(SAGE);
    expect(stops.get("6")).toBe(PURPLE);
    expect(groupColors(4)).toHaveLength(4);
  });

  it("shows a value the declaration does not name as its own chip, and a category without levels takes the data's values", () => {
    expect(attributeGroups(mtb, fc([...trails.features, line({ v: 9 })])).at(-1)).toMatchObject({ label: "9", values: ["9"], count: 1 });
    const species: Attribute = { key: "species", label: "Species", type: "category" };
    const data = fc(["elk", "elk", "bighorn_sheep"].map((species) => line({ species })));
    expect(attributeGroups(species, data).map((g) => [g.label, g.count])).toEqual([
      ["Elk", 2],
      ["Bighorn sheep", 1],
    ]);
  });

  it("a hand-written range on a class (the model's v 3–6) presses the chips it covers and becomes an include list", () => {
    const groups = attributeGroups(mtb, trails);
    const filters = { v: { range: [3, 6] as [number, number] } };
    expect(groups.map((g) => isGroupPicked(filters, mtb, g))).toEqual([false, false, true, true]);
    expect(toggleGroup(filters, mtb, groups[3], groups)).toEqual({ v: { include: ["3"] } });
  });
});

describe("a list property (a crag's disciplines)", () => {
  const disciplines: Attribute = {
    key: "disciplines",
    label: "Discipline",
    type: "category",
    multi: true,
    levels: [
      { value: "sport", label: "Sport" },
      { value: "trad", label: "Trad" },
      { value: "boulder", label: "Boulder" },
    ],
  };
  const crags = fc([["sport", "trad"], ["sport"], ["trad"], ["boulder"], []].map((d, i) => line({ name: `c${i}`, disciplines: d })));

  it("counts each crag once per chip it has, and a chip keeps every crag that lists it", () => {
    const groups = attributeGroups(disciplines, crags);
    expect(groups.map((g) => [g.label, g.count])).toEqual([
      ["Sport", 2],
      ["Trad", 2],
      ["Boulder", 1],
    ]);
    const sport = toggleGroup({}, disciplines, groups[0], groups);
    expect(sport).toEqual({ disciplines: { include: ["sport"] } });
    expect(applyFilters(crags, sport).features.map((f) => f.properties?.name)).toEqual(["c0", "c1"]);
  });
});

describe("measures: ranked, presets from the source's classes, the mini histogram", () => {
  const acres: Attribute = {
    key: "acres",
    label: "Acres burned",
    type: "measure",
    unit: "acres",
    presets: [
      { label: "Class G: 5,000 acres and up", min: 5_000 },
      { label: "Class A–C: under 100 acres", max: 99.9 },
    ],
  };
  const fires = fc([50, 120, 900, 4_000, 12_000, 60_000, 380_000].map((acres, i) => line({ name: `f${i}`, acres })));

  it("ranks the largest first and sizes by the square root of the share", () => {
    expect(topFeatures(fires, "acres", 2).map((f) => f.properties?.name)).toEqual(["f6", "f5"]);
    expect(sizeScale(0, [0, 100])).toBeCloseTo(0.7);
    expect(sizeScale(100, [0, 100])).toBeCloseTo(1.8);
    expect(hatchStepOf(10, [10, 100_000])).toBe(0);
    expect(hatchStepOf(100_000, [10, 100_000])).toBe(4);
  });

  it("a preset writes its range over the data and reads pressed; pressing it again clears; the summary names it", () => {
    const extent: [number, number] = [50, 380_000];
    expect(presetCount(fires, "acres", acres.presets![0])).toBe(3);
    const big = togglePreset({}, acres, acres.presets![0], extent);
    expect(big).toEqual({ acres: { range: [5_000, 380_000] } });
    expect(isPresetPicked(big, acres, acres.presets![0], extent)).toBe(true);
    expect(attributeFilterSummary([acres], big)).toBe("Class G: 5,000 acres and up");
    expect(togglePreset(big, acres, acres.presets![0], extent)).toEqual({});
    expect(attributeFilterSummary([acres], togglePreset({}, acres, acres.presets![1], extent))).toBe("Class A–C: under 100 acres");
  });

  it("bins on a log scale when most values sit low, and bars pick, grow, shrink and clear a band", () => {
    const hist = histogram(fires, "acres")!;
    expect(hist.log).toBe(true);
    expect(hist.bins).toHaveLength(12);
    expect(hist.bins.reduce((n, b) => n + b.count, 0)).toBe(7);
    const { bins } = hist;
    const one = toggleBin({}, "acres", bins, 11);
    expect(pickedBins(one, "acres", bins)).toEqual([11]);
    expect(one.acres.range?.[1]).toBe(380_000);
    const grown = toggleBin(one, "acres", bins, 8);
    expect(pickedBins(grown, "acres", bins)).toEqual([8, 9, 10, 11]);
    const shrunk = toggleBin(grown, "acres", bins, 8);
    expect(pickedBins(shrunk, "acres", bins)).toEqual([9, 10, 11]);
    expect(pickedBins(toggleBin(shrunk, "acres", bins, 10), "acres", bins)).toEqual([10]);
    expect(toggleBin(one, "acres", bins, 11)).toEqual({});
    expect(histogram(fc([line({ acres: 5 })]), "acres")).toBeNull();
  });
});

describe("flags, names and versions", () => {
  it("a flag keeps features where it is true; a name search keeps names with every word, accents ignored", () => {
    const sites = fc([line({ name: "Muir Valley", fee: true }), line({ name: "Pendergrass-Murray Recreational Preserve", fee: false }), line({ name: "Mūir Wall" })]);
    const fee = toggleFlag({}, { key: "fee" });
    expect(isFlagOn(fee, { key: "fee" })).toBe(true);
    expect(applyFilters(sites, fee).features).toHaveLength(1);
    expect(toggleFlag(fee, { key: "fee" })).toEqual({});
    const named = withNameQuery({}, { key: "name" }, "muir");
    expect(applyFilters(sites, named).features.map((f) => f.properties?.name)).toEqual(["Muir Valley", "Mūir Wall"]);
    expect(applyFilters(sites, withNameQuery({}, { key: "name" }, "muir valley")).features).toHaveLength(1);
    expect(withNameQuery(named, { key: "name" }, " ")).toEqual({});
    expect(attributeFilterSummary([{ key: "name", label: "Name", type: "name" }], named)).toBe('Name has "muir"');
  });

  it("finds the two versions of a versions category, earliest first", () => {
    const kind: Attribute = { key: "kind", label: "Boundary", type: "category", versions: true, levels: [{ value: "2021", label: "2021 boundary" }, { value: "current", label: "Current boundary" }] };
    const sides = versionSides(kind, fc([line({ kind: "current" }), line({ kind: "2021" })]));
    expect(sides?.a.label).toBe("2021 boundary");
    expect(sides?.b.values).toEqual(["current"]);
    expect(versionSides(kind, fc([line({ kind: "current" })]))).toBeNull();
  });

  it("says the filter in the attribute's words, never 'Value 3–3'", () => {
    expect(attributeFilterSummary([mtb], { v: { include: ["3", "4", "5", "6"] } })).toBe("Difficulty: Hard, Expert");
    const area: Attribute = { key: "acres", label: "Burned area", type: "measure", unit: "acres" };
    expect(attributeFilterSummary([area], { acres: { range: [1000, 380000] } })).toBe("Burned area 1,000–380,000 acres");
  });
});

describe("Rank by lists one row per named place", () => {
  const seg = (name: string, x: number, v: number): Feature => ({
    type: "Feature",
    geometry: { type: "LineString", coordinates: [[x, 39], [x + 0.005, 39.005]] },
    properties: { name, v },
  });
  const pt = (name: string, x: number, v: number): Feature => ({ type: "Feature", geometry: { type: "Point", coordinates: [x, 39] }, properties: { name, v } });
  const fc = (features: Feature[]): FeatureCollection => ({ type: "FeatureCollection", features });

  it("folds the touching segments of one trail into its best row (the owner's Rubicon Trail listed 7 times)", () => {
    const data = fc([seg("Rubicon Trail", -120.1, 78), seg("Rubicon Trail", -120.095, 76), seg("Vikingsholm Trail", -120.2, 70), seg("Rubicon Trail", -120.09, 72)]);
    expect(topPlaces(data, "v", 10).map((f) => [f.properties?.name, f.properties?.v])).toEqual([
      ["Rubicon Trail", 78],
      ["Vikingsholm Trail", 70],
    ]);
  });

  it("lists a wind project once, not each of its turbines (Ranchland Wind Project, kilometres apart)", () => {
    const turbine = (x: number): Feature => ({ type: "Feature", geometry: { type: "Point", coordinates: [x, 32.23] }, properties: { name: "Ranchland Wind Project", project: "Ranchland Wind Project", v: 6 } });
    expect(topPlaces(fc([turbine(-99.17), turbine(-99.21), turbine(-99.13), pt("Horse Hollow", -100, 4)]), "v", 10)).toHaveLength(2);
  });

  it("lists a glacier by its latest outline, so the row gives the area its card shows (PIO XI: 1,377.51 km² in 2001, 1,245.46 in 2016)", () => {
    const outline = (v: number, t: string, dx = 0): Feature => ({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [[[-73.6 + dx, -49.2], [-73.3 + dx, -49.2], [-73.3 + dx, -48.9], [-73.6 + dx, -48.9], [-73.6 + dx, -49.2]]] },
      properties: { name: "Pio XI", glacierId: "G286467E49128S", v, t },
    });
    const viedma: Feature = { ...outline(1000, "2016-03-12T00:00:00.000Z", 0.6), properties: { name: "Viedma Glacier", v: 1000, t: "2016-03-12T00:00:00.000Z" } };
    const data = fc([outline(1377.51, "2001-02-01T00:00:00.000Z"), outline(1245.46, "2016-03-12T00:00:00.000Z"), viedma]);
    expect(topPlaces(data, "v", 10).map((f) => [f.properties?.name, f.properties?.v])).toEqual([
      ["Pio XI", 1245.46],
      ["Viedma Glacier", 1000],
    ]);
    expect(cardFeatureOf(data.features[0], data).properties?.v).toBe(1245.46);
  });

  it("keeps one name at two far places, and every unnamed feature", () => {
    const data = fc([pt("The Gallery", -83.6, 9), pt("The Gallery", -84.5, 5), pt("", -83.6, 4), pt("", -83.6, 3)]);
    expect(topPlaces(data, "v", 10)).toHaveLength(4);
  });

  it("is what the row's ranked list shows", () => {
    const layer = { attributes: [{ key: "v", type: "measure", label: "Popularity" } as Attribute] };
    const data = fc([seg("Rubicon Trail", -120.1, 78), seg("Rubicon Trail", -120.095, 76)]);
    expect(rankedTop(layer, {}, data, data, 10)).toMatchObject({ key: "v", top: [{ properties: { v: 78 } }] });
  });

  it("says Year completed when the list is sorted by year, and shows no list under None", () => {
    const layer = { attributes: [{ key: "storageAf", type: "measure", label: "Storage" }, { key: "yearCompleted", type: "time", label: "Year completed" }] as Attribute[] };
    const dam = (name: string, lon: number, storageAf: number, yearCompleted: number): Feature => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, 36] }, properties: { name, storageAf, yearCompleted } });
    const data = fc([dam("Windy Gap", -106, 10, 1985), dam("Glen Canyon Dam", -111.5, 29_875_000, 1963)]);
    const byYear = rankedTop(layer, { rankBy: "yearCompleted" }, data, data, 10);
    expect(byYear.key).toBe("yearCompleted");
    expect(byYear.measures.map((m) => m.label)).toEqual(["Storage", "Year completed"]);
    expect(byYear.top.map((f) => f.properties?.name)).toEqual(["Windy Gap", "Glen Canyon Dam"]);
    expect(rankedTop(layer, { rankBy: "" }, data, data, 10)).toMatchObject({ key: undefined, top: [] });
    // A pick the select does not offer is None, not a list under "None".
    expect(rankedTop(layer, { rankBy: "heightFt" }, data, data, 10)).toMatchObject({ key: undefined, top: [] });
  });
});

describe("a measure where less is better", () => {
  it("ranks the nearest first: \"Top 10 by distance to waterfalls\" starts at the closest trail", async () => {
    const { rankedTop } = await import("@/lib/render/attributes");
    const trail = (name: string, distanceKm: number): Feature => ({ type: "Feature", geometry: { type: "Point", coordinates: [-82.5 + distanceKm, 35.5] }, properties: { name, distanceKm } });
    const data: FeatureCollection = { type: "FeatureCollection", features: [trail("Laurel Gap Trail", 0.48), trail("Slate Rock Creek Trail", 0.01), trail("Barnett Branch Trail", 0.03)] };
    const layer = { attributes: [{ key: "distanceKm", type: "measure", label: "Distance to waterfalls", unit: "km", lowFirst: true }] as Attribute[] };
    expect(rankedTop(layer, {}, data, data, 3).top.map((f) => f.properties?.name)).toEqual(["Slate Rock Creek Trail", "Barnett Branch Trail", "Laurel Gap Trail"]);
  });
});

describe("rowName", () => {
  it("names an unnamed trail by its high point, and anything else unnamed as Unnamed", async () => {
    const { rowName } = await import("@/lib/render/attributes");
    const f = (properties: Record<string, unknown>): Feature => ({ type: "Feature", geometry: null, properties });
    expect(rowName(f({ kind: "path", highM: 4181.4, gainM: 1179 }))).toBe("Unnamed path to 4,181 m");
    expect(rowName(f({ name: "Les Balcons de la Mer de Glace", highM: 2704 }))).toBe("Les Balcons de la Mer de Glace");
    expect(rowName(f({ kind: "camp_site" }))).toBe("Unnamed");
  });
});
