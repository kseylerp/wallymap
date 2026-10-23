import { describe, expect, it } from "vitest";
import { getLayer, listLayers } from "@/layers";
import { attributeProblems } from "@/layers/attributes";
import { chipAttribute, encodedAttribute, primaryMeasure } from "@/lib/render/attributes";
import type { Layer } from "@/layers/types";

const base = { id: "x", style: { geometry: "line" as const, color: "#9FB693" } };

describe("attribute declarations (spec §12c) are checked at registry load", () => {
  it("passes every registered layer", () => {
    for (const layer of listLayers()) expect(attributeProblems(layer), layer.id).toEqual([]);
  });

  it("names each problem in a bad declaration", () => {
    const bad: Pick<Layer, "id" | "style" | "fieldHelp" | "card" | "attributes"> = {
      ...base,
      style: { ...base.style, geometry: "point" },
      attributes: [
        { key: "a", label: "", type: "ordinal", levels: [{ value: 1, label: "One" }] },
        { key: "a", label: "A", type: "measure", levels: [{ value: 1, label: "one" }], encode: "dash" },
        { key: "c", label: "C", type: "category", encode: "size", primary: true },
        { key: "d", label: "D", type: "flag", primary: true, presets: [{ label: "x" }] },
        { key: "e", label: "E", type: "measure", presets: [{ label: "Backwards", min: 5, max: 1 }, { label: "Open" }] },
      ],
      fieldHelp: { v: { text: " ", url: "http://example.com" } },
      card: { measure: { key: "v", label: "Value" } },
    };
    const problems = attributeProblems(bad).join(" | ");
    expect(problems).toContain("has no label");
    expect(problems).toContain("is an ordinal with fewer than two levels");
    expect(problems).toContain("does not name its source scale");
    expect(problems).toContain("repeats the key a");
    expect(problems).toContain("is a measure with levels");
    expect(problems).toContain("encodes dash on a point layer");
    expect(problems).toContain("encodes size but is a category");
    expect(problems).toContain("is primary but is a flag");
    expect(problems).toContain("is a flag with presets");
    expect(problems).toContain('preset "Backwards" runs backwards');
    expect(problems).toContain('preset "Open" has no bound');
    expect(problems).toContain("more than one attribute primary");
    expect(problems).toContain("has no text");
    expect(problems).toContain("not https");
    expect(problems).toContain('not "Value"');
  });

  it("refuses a repeated level and a versions category with fewer than two versions", () => {
    const problems = attributeProblems({
      ...base,
      attributes: [{ key: "k", label: "K", type: "category", versions: true, levels: [{ value: "1", label: "One" }, { value: "1", label: "One" }] }],
    });
    expect(problems.join(" ")).toMatch(/repeats the level 1/);
    expect(problems.join(" ")).toMatch(/fewer than two/);
  });

  it.each([
    ["climbing", "disciplines", "v"],
    ["osm-trails", "sac_scale", "lengthKm"],
    ["mtb-trails", "v", undefined],
    ["ski-routes", "kind", undefined],
    ["paddling", "kind", undefined],
    ["fire-perimeters", "agency", "acres"],
    ["power-plants", "kind", "v"],
    ["dams", "hazard", "storageAf"],
    ["monuments", "boundary", "areaKm2"],
    ["uranium", "kind", "hazardScore"],
    ["earthquakes", "kind", "v"],
    ["glaciers", "survey", "areaKm2"],
    ["drought", "kind", undefined],
    ["protected-areas-world", "protection", "areaKm2"],
    ["fire-detections", "confidence", "v"],
    ["gbif-occurrences", "basisOfRecord", undefined],
    ["species", "species", undefined],
    ["photos", "source", "nearby"],
    ["mines", "status", undefined],
  ])("declares %s's chip set on %s and its measure on %s", (id, chip, measure) => {
    const layer = getLayer(id)!;
    expect(layer.attributes?.length, id).toBeGreaterThan(0);
    expect(chipAttribute(layer)?.key).toBe(chip);
    expect(primaryMeasure(layer)?.key).toBe(measure);
  });

  it("puts difficulty on the line ramp with its source scale, and monuments as two versions (2021, then current)", () => {
    for (const id of ["osm-trails", "mtb-trails", "ski-routes", "paddling"]) {
      const encoded = encodedAttribute(getLayer(id)!);
      expect(encoded?.type, id).toBe("ordinal");
      expect(encoded?.scale, id).toBeTruthy();
    }
    const kind = chipAttribute(getLayer("monuments")!);
    expect(kind?.versions).toBe(true);
    expect(kind?.levels?.map((v) => v.value)).toEqual(["2021", "current"]);
    expect(encodedAttribute(getLayer("mtb-trails")!)?.levels?.map((v) => v.label)).toEqual(
      expect.arrayContaining(["Green", "Blue", "Black", "Double black"]),
    );
  });

  it("grades climbing on the shared bands, sizes fires and quakes by their sources' classes, and has flags and name search", () => {
    const climbing = getLayer("climbing")!;
    const grade = climbing.attributes!.find((a) => a.key === "gradeBands")!;
    expect(grade.type).toBe("ordinal");
    expect(grade.scale).toMatch(/YDS, UIAA, French and V-scale/);
    expect(grade.levels?.map((l) => l.label)).toEqual(["Beginner", "Intermediate", "Advanced", "Elite"]);
    expect(climbing.attributes!.some((a) => a.type === "flag")).toBe(true);
    expect(climbing.attributes!.some((a) => a.type === "name")).toBe(true);
    expect(primaryMeasure(getLayer("fire-perimeters")!)?.presets?.map((p) => p.label)).toContain("Class G: 5,000 acres and up");
    expect(primaryMeasure(getLayer("earthquakes")!)?.presets?.map((p) => p.label)).toContain("Strong: 6 to 6.9");
    expect(chipAttribute(getLayer("drought")!)?.levels?.map((l) => l.value)).toEqual(["D0", "D1", "D2", "D3", "D4"]);
  });

  it("keeps the uranium score explained in the Navajo AUM screening's words, and climbing's full card", () => {
    const help = getLayer("uranium")!.fieldHelp?.hazardScore;
    expect(help?.text).toMatch(/Navajo/);
    expect(help?.scale).toBeTruthy();
    const card = getLayer("climbing")!.card!;
    expect(card.measure).toMatchObject({ key: "v", label: "Routes" });
    expect(card.links?.map((l) => l.label)).toContain("Open on OpenBeta");
    expect(card.facts?.map((f) => f.key)).toEqual(expect.arrayContaining(["grades", "gradeBands"]));
  });
});
