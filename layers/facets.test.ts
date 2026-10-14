import { describe, expect, it } from "vitest";
import { listLayers, getLayer } from "@/layers";
import { facetProblems } from "@/layers/facets";
import type { Layer } from "@/layers/types";

const base = { id: "x", style: { geometry: "line" as const, color: "#9FB693" } };

describe("facet declarations (spec §12a) are checked at registry load", () => {
  it("passes every registered layer", () => {
    for (const layer of listLayers()) expect(facetProblems(layer), layer.id).toEqual([]);
  });

  it("names each problem in a bad declaration", () => {
    const bad: Pick<Layer, "id" | "style" | "fieldHelp" | "card"> = {
      ...base,
      style: {
        ...base.style,
        geometry: "point",
        facets: [
          { key: "a", label: "", kind: "category", values: [] },
          { key: "a", label: "A", kind: "range", values: [{ value: 1, label: "one" }], encode: "dash" },
          { key: "c", label: "C", kind: "range" },
        ],
      },
      fieldHelp: { v: { text: " ", url: "http://example.com" } },
      card: { measure: { key: "v", label: "Value" } },
    };
    const problems = facetProblems(bad).join(" | ");
    expect(problems).toContain("declares 3 facets");
    expect(problems).toContain("has no label");
    expect(problems).toContain("is a category with no values");
    expect(problems).toContain("repeats the key a");
    expect(problems).toContain("is a range with values");
    expect(problems).toContain("encodes dash on a point layer");
    expect(problems).toContain("has no text");
    expect(problems).toContain("not https");
    expect(problems).toContain('not "Value"');
  });

  it("refuses a repeated category value and a versions facet with fewer than two versions", () => {
    const problems = facetProblems({
      ...base,
      style: {
        ...base.style,
        facets: [{ key: "k", label: "K", kind: "category", versions: true, values: [{ value: "1", label: "One" }, { value: "1", label: "One" }] }],
      },
    });
    expect(problems.join(" ")).toMatch(/repeats the value 1/);
    expect(problems.join(" ")).toMatch(/fewer than two/);
  });

  it.each([
    ["osm-trails", "sac_scale"],
    ["mtb-trails", "v"],
    ["ski-routes", "v"],
    ["paddling", "v"],
    ["climbing", "v"],
    ["fire-perimeters", "acres"],
    ["power-plants", "kind"],
    ["dams", "storageAf"],
    ["monuments", "kind"],
    ["uranium", "hazardScore"],
    ["earthquakes", "v"],
    ["glaciers", "areaKm2"],
    ["drought", "kind"],
    ["protected-areas-world", "iucn"],
  ])("declares %s's primary facet on %s, with field help", (id, key) => {
    const layer = getLayer(id)!;
    expect(layer.style.facets?.[0]?.key).toBe(key);
    expect(Object.keys(layer.fieldHelp ?? {}).length).toBeGreaterThan(0);
  });

  it("encodes difficulty on the line ramp and monuments as two versions (2021, then current)", () => {
    for (const id of ["osm-trails", "mtb-trails", "ski-routes", "paddling"]) expect(getLayer(id)!.style.facets?.[0]?.encode).toBe("color");
    const kind = getLayer("monuments")!.style.facets?.[0];
    expect(kind?.versions).toBe(true);
    expect(kind?.values?.map((v) => v.value)).toEqual(["2021", "current"]);
    expect(getLayer("mtb-trails")!.style.facets?.[0]?.values?.map((v) => v.label)).toEqual(
      expect.arrayContaining(["Easy", "Moderate", "Hard", "Expert"]),
    );
  });

  it("explains the uranium hazard score in the Navajo AUM screening's words, and climbing has a full card", () => {
    const help = getLayer("uranium")!.fieldHelp?.hazardScore;
    expect(help?.text).toMatch(/Navajo/);
    expect(help?.scale).toBeTruthy();
    const card = getLayer("climbing")!.card!;
    expect(card.measure).toMatchObject({ key: "v", label: "Routes" });
    expect(card.links?.map((l) => l.label)).toContain("Open on OpenBeta");
  });
});
