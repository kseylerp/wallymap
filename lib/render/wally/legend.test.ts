import type { Feature } from "geojson";
import { describe, expect, it } from "vitest";
import { DARK_GREY, HATCH_SPACINGS, OFF_WHITE, PINK, PURPLE, SAGE, TRAIL_LINE, WHITE } from "@/lib/render/palette";
import { pinIconFor } from "@/lib/render/wally/pins";
import { hexTileLegend, legendSymbol, rampSamples } from "@/lib/render/wally/legend";

const blank: Feature = { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: {} };
const fire = (acres: number): Feature => ({ type: "Feature", geometry: null as never, properties: { acres, v: acres } });

describe("legendSymbol", () => {
  it.each(["campsites", "species", "photos", "streamflow", "snowpack", "fire-detections", "something-new"])(
    "keys %s points with the sprite deck draws",
    (layerId) => {
      expect(legendSymbol(layerId, "points")).toEqual({ kind: "symbol", spriteUrl: pinIconFor(layerId, blank).url });
    },
  );

  it("keys trails with the TRAIL_LINE recipe (T1): dark grey dashes over sage on a white casing", () => {
    expect(legendSymbol("osm-trails", "lines")).toEqual({
      kind: "line",
      color: TRAIL_LINE.over.color,
      under: TRAIL_LINE.under,
      dash: [8, 8],
      casing: WHITE,
      width: 2.5,
      casingWidth: 4.5,
    });
  });

  it("keys forest roads thin dark grey dashes, use trails sage dots, other lines solid sage", () => {
    expect(legendSymbol("forest-roads", "lines")).toMatchObject({ color: DARK_GREY, dash: [4, 4], width: 1.75 });
    expect(legendSymbol("osm-trails", "lines", { feature: { ...blank, properties: { informal: true } } })).toMatchObject({
      color: SAGE,
      dash: [2.5, 6],
    });
    expect(legendSymbol("some-river", "lines")).toMatchObject({ color: SAGE, dash: [0, 0] });
  });

  it("keys a route feature with the Wally gradient on a white casing, whatever its layer", () => {
    const route: Feature = { ...blank, properties: { kind: "route" } };
    for (const layerId of ["ski-routes", "mtb-trails", "paddling", "osm-trails"]) {
      const key = legendSymbol(layerId, "lines", { feature: route });
      expect(key).toMatchObject({ kind: "gradient", casing: WHITE, width: 3 });
      if (key.kind === "gradient") {
        expect(key.colors).toHaveLength(24);
        expect(key.colors[0]).toBe(PURPLE);
        expect(key.colors[23]).toBe(PINK);
        expect(key.casingWidth).toBeGreaterThan(key.width);
      }
    }
    expect(legendSymbol("ski-routes", "lines", { feature: { ...blank, properties: { kind: "nordic", route: true } } }).kind).toBe("gradient");
  });

  it("keys a layer of only routes with the gradient, a plain path or piste way as before, a compare side solid", () => {
    expect(legendSymbol("mtb-trails", "lines", { routes: true }).kind).toBe("gradient");
    expect(legendSymbol("ski-routes", "lines", { feature: { ...blank, properties: { kind: "nordic" } } })).toMatchObject({ kind: "line", color: SAGE, dash: [0, 0] });
    const route: Feature = { ...blank, properties: { kind: "route" } };
    expect(legendSymbol("mtb-trails", "lines", { feature: route, color: PINK })).toMatchObject({ kind: "line", color: PINK, dash: [0, 0] });
  });

  it("keys fire perimeters pink: tint, hatch and outline", () => {
    expect(legendSymbol("fire-perimeters", "polygons")).toEqual({
      kind: "area",
      tint: PINK,
      tintAlpha: 0.15,
      hatch: PINK,
      hatchAlpha: 0.6,
      spacing: HATCH_SPACINGS[2],
      outline: PINK,
      casing: WHITE,
    });
  });

  it("hatches a fire's own key at its density: larger fires denser", () => {
    expect(legendSymbol("fire-perimeters", "polygons", { feature: fire(50) })).toMatchObject({ spacing: 12 });
    expect(legendSymbol("fire-perimeters", "polygons", { feature: fire(5_000) })).toMatchObject({ spacing: 6 });
    expect(legendSymbol("fire-perimeters", "polygons", { feature: fire(250_000) })).toMatchObject({ spacing: 3 });
  });

  it("keys protected land sage with a dark grey outline, on deck and on vector tiles alike", () => {
    for (const id of ["wilderness", "physical-regions"]) {
      expect(legendSymbol(id, "polygons")).toMatchObject({ kind: "area", tint: SAGE, hatch: SAGE, outline: DARK_GREY });
    }
    expect(legendSymbol("public-lands", "vector-polygons")).toEqual(legendSymbol("public-lands", "polygons"));
  });

  it("recolors areas in a palette color a compare side draws them in, ignoring others", () => {
    expect(legendSymbol("fire-perimeters", "polygons", { color: PURPLE })).toMatchObject({ tint: PURPLE, hatch: PURPLE, outline: PURPLE });
    expect(legendSymbol("fire-perimeters", "polygons", { color: "#FF5A36" })).toMatchObject({ tint: PINK });
  });

  it("keys score areas and lines with their ramp", () => {
    expect(legendSymbol("remoteness", "polygons")).toEqual({ kind: "ramp", colors: rampSamples("remoteness") });
    expect(legendSymbol("popularity", "lines")).toEqual({ kind: "ramp", colors: rampSamples("scoreLineVisible") });
    expect(rampSamples("scoreLine")[0]).toBe(SAGE);
    expect(legendSymbol("any-grid", "polygons", { unit: "score" })).toEqual({ kind: "ramp", colors: rampSamples("density") });
    expect(legendSymbol("remoteness", "polygons", { unit: "km" }).kind).toBe("area");
  });

  it("keys one scored line with its own ramp color on a white casing (no dark outline on any line)", () => {
    const top = legendSymbol("popularity", "lines", { feature: { ...blank, properties: { v: 100 } } });
    expect(top).toMatchObject({ kind: "line", color: PURPLE, casing: WHITE });
    const low = legendSymbol("popularity", "lines", { feature: { ...blank, properties: { v: 0 } } });
    expect(low).toMatchObject({ kind: "line", color: PINK });
  });

  it("keys raster tiles as dark grey hatching, heat and hex tiles as their ramps", () => {
    expect(legendSymbol("night-lights", "tiles")).toEqual({ kind: "tiles", color: DARK_GREY });
    expect(legendSymbol("campsites", "heat")).toEqual({ kind: "ramp", colors: rampSamples("density") });
    expect(hexTileLegend()).toEqual({ kind: "ramp", colors: rampSamples("gray") });
    expect(rampSamples("gray")[0]).toBe(OFF_WHITE);
    expect(rampSamples("gray")[4]).toBe(DARK_GREY);
  });

  it("returns a fresh dash array each time, so callers cannot change the table", () => {
    const a = legendSymbol("forest-roads", "lines");
    if (a.kind !== "line") throw new Error("expected a line key");
    a.dash[0] = 99;
    expect(legendSymbol("forest-roads", "lines")).toMatchObject({ dash: [4, 4] });
  });
});
