import { describe, expect, it } from "vitest";
import "@/layers";
import { getLayer } from "@/layers/registry";
import { measureAsked, modeAsked, normalizeFilters, normalizeRenderInput, viewAsked } from "./renderInput";

const attrs = (id: string) => getLayer(id)?.attributes ?? [];
const include = (id: string, key: string, values: string[]) =>
  (normalizeFilters({ [key]: { include: values } }, attrs(id))[key] as { include: string[] }).include;

describe("render filters: labels and band names become the values the data holds (every ordinal band set)", () => {
  it("mountain bike Singletrack Scale: Hard is S3, Expert is S4 to S6, Easy is S0 and S1; codes S3 and values pass", () => {
    expect(include("mtb-trails", "v", ["Hard", "Expert"])).toEqual(["3", "4", "5", "6"]);
    expect(include("mtb-trails", "v", ["easy"])).toEqual(["0", "1"]);
    expect(include("mtb-trails", "v", ["Moderate"])).toEqual(["2"]);
    expect(include("mtb-trails", "v", ["S3"])).toEqual(["3"]);
    expect(include("mtb-trails", "v", ["3", "4"])).toEqual(["3", "4"]);
  });

  it("a filter keyed by the attribute's label lands on its key (Difficulty is mtb-trails' v)", () => {
    expect(normalizeFilters({ Difficulty: { include: ["Hard"] } }, attrs("mtb-trails"))).toEqual({ v: { include: ["3"] } });
  });

  it("SAC hiking scale: labels, T codes and spelled-out values", () => {
    expect(include("osm-trails", "sac_scale", ["Alpine hiking (T4)"])).toEqual(["alpine_hiking"]);
    expect(include("osm-trails", "sac_scale", ["T4", "T5"])).toEqual(["alpine_hiking", "demanding_alpine_hiking"]);
    expect(include("osm-trails", "sac_scale", ["alpine hiking"])).toEqual(["alpine_hiking"]);
    expect(include("osm-trails", "sac_scale", ["alpine_hiking"])).toEqual(["alpine_hiking"]);
  });

  it("piste difficulty: Easy, Moderate, Hard and Expert chips", () => {
    expect(include("ski-routes", "v", ["Hard"])).toEqual(["4"]);
    expect(include("ski-routes", "v", ["Expert"])).toEqual(["5", "6"]);
    expect(include("ski-routes", "v", ["Easy"])).toEqual(["1", "2"]);
  });

  it("whitewater class: Class IV, IV and class 4 all mean 4 and 4.5", () => {
    expect(include("paddling", "v", ["Class IV"])).toEqual(["4", "4.5"]);
    expect(include("paddling", "v", ["IV"])).toEqual(["4", "4.5"]);
    expect(include("paddling", "v", ["class 4"])).toEqual(["4", "4.5"]);
    expect(include("paddling", "v", ["Class III", "Class V"])).toEqual(["3", "3.5", "5", "5.5"]);
  });

  it("drought categories: the D code, the full label or the label without its code", () => {
    expect(include("drought", "kind", ["D3", "D4"])).toEqual(["D3", "D4"]);
    expect(include("drought", "kind", ["Extreme Drought"])).toEqual(["D3"]);
    expect(include("drought", "kind", ["D3 Extreme Drought"])).toEqual(["D3"]);
  });

  it("climbing grade bands: Elite, Advanced and the band values", () => {
    expect(include("climbing", "gradeBands", ["Elite"])).toEqual(["elite"]);
    expect(include("climbing", "gradeBands", ["Advanced", "elite"])).toEqual(["advanced", "elite"]);
    expect(include("climbing", "disciplines", ["Sport"])).toEqual(["sport"]);
  });

  it("other ordinals: fire detection confidence and mine status", () => {
    expect(include("fire-detections", "confidence", ["High"])).toEqual(["h"]);
    expect(include("mines", "status", ["Past Producer"])).toEqual(["Past Producer"]);
  });

  it("an unknown key or value passes through; a category without declared levels also tries the lower-case value", () => {
    expect(normalizeFilters({ nothing: { include: ["X"] } }, attrs("mtb-trails"))).toEqual({ nothing: { include: ["X"] } });
    expect(include("mtb-trails", "v", ["Gnarly"])).toEqual(["Gnarly"]);
    expect(include("power-plants", "kind", ["Wind"])).toEqual(expect.arrayContaining(["wind"]));
  });

  it("keeps ranges and text matches as they are", () => {
    expect(normalizeFilters({ v: { range: [3, 6] }, name: { match: "slick" } }, attrs("mtb-trails"))).toEqual({ v: { range: [3, 6] }, name: { match: "slick" } });
  });
});

describe("density by a measure, from the question's words", () => {
  it("reads the measure after 'most … by' and 'where is most of the'", () => {
    expect(measureAsked("Where are most of the wind farms by capacity in West Texas?")).toBe("capacity");
    expect(measureAsked("where is most of the capacity in Texas")).toBe("capacity");
    expect(measureAsked("Which fires burned the most acres?")).toBeNull();
    expect(measureAsked("Show hiking trails around Lake Tahoe")).toBeNull();
  });

  it("draws hex cells by the sum of the measure in the density view, over a ranked view the model asked for", () => {
    const out = normalizeRenderInput({ layerId: "power-plants", view: "ranked", mode: "symbols" }, getLayer("power-plants"), "Where are most of the wind farms by capacity in West Texas?");
    expect(out).toMatchObject({ layerId: "power-plants", view: "density", hexBasis: "sum" });
    expect(out.mode).toBeUndefined();
  });

  it("leaves the render alone when the question does not ask it, or the layer has no such measure", () => {
    const input = { layerId: "power-plants", view: "ranked" };
    expect(normalizeRenderInput(input, getLayer("power-plants"), "Which power plants are largest in Texas?")).toEqual(input);
    // Uranium has no capacity: no hex sum (the words still ask where most are, so the view is density).
    expect(normalizeRenderInput({ layerId: "uranium" }, getLayer("uranium"), "Where are most of the mines by capacity?")).toEqual({ layerId: "uranium", view: "density" });
  });
});

describe("the view a question asks for", () => {
  it("reads clear cues and leaves change questions and plain ones alone", () => {
    expect(viewAsked("Busiest ports on the Gulf Coast")).toBe("ranked");
    expect(viewAsked("Which counties in Florida had the most disaster declarations?")).toBe("ranked");
    expect(viewAsked("Where are most of the old mines in Nevada?")).toBe("density");
    expect(viewAsked("Where are the most groundwater wells around Phoenix?")).toBe("density");
    expect(viewAsked("Heatmap of brown bear sightings in Alaska")).toBe("density");
    expect(viewAsked("Where did beetles kill trees in Colorado over the last ten years?")).toBe("timeline");
    expect(viewAsked("Tell me about Mount Kilimanjaro")).toBe("detail");
    expect(viewAsked("Wolf packs in Washington since 2014")).toBe("timeline");
    expect(viewAsked("Earthquakes in Japan this month")).toBe("timeline");
    expect(viewAsked("How dry is Colorado this week?")).toBeNull();
    expect(viewAsked("How much less sea ice is in the Arctic this September than in 2012?")).toBeNull();
    expect(viewAsked("Has Grand Staircase-Escalante gotten smaller since 2021?")).toBeNull();
    expect(viewAsked("Which large fires burned in Oregon in 2020?")).toBeNull();
  });

  it("fills in the view the model left out, and puts density or timeline in place of ranked, on a layer that can draw it", () => {
    const ports = getLayer("ports");
    expect(normalizeRenderInput({ layerId: "ports" }, ports, "Busiest ports on the Gulf Coast").view).toBe("ranked");
    const trees = getLayer("tree-mortality");
    expect(normalizeRenderInput({ layerId: "tree-mortality", view: "ranked" }, trees, "Where did beetles kill trees in Colorado over the last ten years?").view).toBe("timeline");
    expect(normalizeRenderInput({ layerId: "wolf-packs", view: "detail" }, getLayer("wolf-packs"), "Wolf packs in Washington since 2014").view).toBe("timeline");
    expect(normalizeRenderInput({ layerId: "wolf-packs" }, getLayer("wolf-packs"), "Wolf packs in Washington since 2014").view).toBe("timeline");
    const mines = getLayer("mines");
    expect(normalizeRenderInput({ layerId: "mines", view: "ranked" }, mines, "Where are most of the old mines in Nevada?").view).toBe("density");
    // A specialised view the model chose stays.
    expect(normalizeRenderInput({ layerId: "ports", view: "density" }, ports, "Busiest ports on the Gulf Coast").view).toBe("density");
    expect(normalizeRenderInput({ layerId: "ports", view: "detail" }, ports, "Busiest ports on the Gulf Coast").view).toBe("ranked");
  });
});

describe("the mode a question asks for", () => {
  it("draws what the user named: a heatmap as heat, 3D columns as columns, only on layers that can", () => {
    expect(normalizeRenderInput({ layerId: "gbif-occurrences", mode: "clusters" }, getLayer("gbif-occurrences"), "Heatmap of brown bear sightings in Alaska").mode).toBe("heat");
    expect(normalizeRenderInput({ layerId: "power-plants", mode: "symbols" }, getLayer("power-plants"), "Show power plants in Arizona as 3D columns by megawatts").mode).toBe("columns");
    expect(modeAsked("Heatmap of fires", "polygon")).toBeNull();
    expect(modeAsked("Show hiking trails around Lake Tahoe", "line")).toBeNull();
  });
});
