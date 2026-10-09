import { describe, expect, it } from "vitest";
import { insertBeforeId, ownershipFillColor, vectorTileLayerSpecs } from "@/components/mapTiles";

const STYLE = { geometry: "polygon" as const, color: "#B9A6FF" };

describe("vectorTileLayerSpecs", () => {
  it("builds a fill and a white outline for polygons, keyed tiles-<id>", () => {
    const specs = vectorTileLayerSpecs("public-lands", STYLE, "padus", "polygon", true);
    expect(specs).toHaveLength(2);
    const [fill, line] = specs;
    expect(fill).toMatchObject({
      id: "tiles-public-lands",
      type: "fill",
      source: "tiles-public-lands",
      "source-layer": "padus",
      layout: { visibility: "visible" },
      paint: { "fill-opacity": 0.28 },
    });
    expect(line).toMatchObject({
      id: "tiles-public-lands-line",
      type: "line",
      source: "tiles-public-lands",
      "source-layer": "padus",
      layout: { visibility: "visible" },
      paint: { "line-color": "#FFFFFF", "line-width": 1.5, "line-opacity": 0.9 },
    });
  });

  it("colors polygon fills by manager, falling back to the layer style color", () => {
    const [fill] = vectorTileLayerSpecs("public-lands", STYLE, "padus", "polygon", true);
    expect(fill.type).toBe("fill");
    expect((fill as { paint: Record<string, unknown> }).paint["fill-color"]).toEqual(ownershipFillColor("#B9A6FF"));
  });

  it("hides every spec when not visible", () => {
    for (const spec of vectorTileLayerSpecs("x", STYLE, "s", "polygon", false)) {
      expect(spec.layout).toMatchObject({ visibility: "none" });
    }
  });

  it("draws lines as a single line layer in the style color", () => {
    const specs = vectorTileLayerSpecs("roads", { geometry: "line", color: "#123456" }, "roads", "line", true);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ id: "tiles-roads", type: "line", "source-layer": "roads", paint: { "line-color": "#123456" } });
  });

  it("draws points as a single circle layer in the style color", () => {
    const specs = vectorTileLayerSpecs("pts", { geometry: "point", color: "#654321" }, "pts", "point", true);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ id: "tiles-pts", type: "circle", paint: { "circle-color": "#654321" } });
  });
});

describe("ownershipFillColor", () => {
  it("maps the decoded PAD-US agency values to federal, state, private and local colors", () => {
    const expr = ownershipFillColor("#B9A6FF");
    const json = JSON.stringify(expr);
    // Federal managers seen in the tiles.
    for (const agency of ["USFS", "BLM", "NPS", "FWS", "USBR", "USACE"]) expect(json).toContain(`"${agency}"`);
    expect(json).toContain('"State Parks"');
    expect(json).toContain('"NGO"');
    for (const color of ["#B9A6FF", "#9FC4FF", "#D9D4FF", "#EDEDEA"]) expect(json).toContain(color);
  });

  it("uses the fallback color for features with neither agency nor designation", () => {
    const expr = ownershipFillColor("#ABCDEF") as unknown[];
    expect(expr[0]).toBe("case");
    expect(expr[expr.length - 1]).toBe("#ABCDEF");
  });
});

describe("insertBeforeId", () => {
  it("returns the first symbol layer so data sits under labels", () => {
    expect(
      insertBeforeId([
        { id: "land", type: "background" },
        { id: "water", type: "fill" },
        { id: "road-label", type: "symbol" },
        { id: "place-label", type: "symbol" },
      ]),
    ).toBe("road-label");
  });

  it("returns undefined when the style has no labels", () => {
    expect(insertBeforeId([{ id: "land", type: "background" }])).toBeUndefined();
    expect(insertBeforeId([])).toBeUndefined();
  });
});
