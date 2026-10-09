import { describe, expect, it } from "vitest";
import { lineDashFor } from "@/lib/render/deck";
import { legendDash, legendSymbol } from "@/lib/render/wally/legend";

describe("legendSymbol", () => {
  it.each([
    ["campsites", "/pins/camp.svg"],
    ["popularity-campsites", "/pins/camp.svg"],
    ["species", "/pins/species.svg"],
    ["photos", "/pins/photo.svg"],
    ["streamflow", "/pins/gauge.svg"],
    ["snowpack", "/pins/snow.svg"],
    ["fire-detections", "/pins/fire.svg"],
    ["something-new", "/pins/point.svg"],
  ])("keys %s points with the %s sprite", (layerId, url) => {
    expect(legendSymbol(layerId, "points")).toEqual({ kind: "symbol", spriteUrl: url });
  });

  it("keys lines with the layer's dash pattern", () => {
    expect(legendSymbol("osm-trails", "lines")).toEqual({ kind: "line", dash: [0, 0] });
    expect(legendSymbol("forest-roads", "lines")).toEqual({ kind: "line", dash: [4, 3] });
  });

  it.each(["osm-trails", "forest-roads", "popularity", "some-river", "x", "fire-perimeters"])(
    "passes deck's dash for %s through unchanged",
    (layerId) => {
      expect(legendSymbol(layerId, "lines").dash).toEqual(lineDashFor(layerId));
      expect(legendDash(layerId)).toEqual(lineDashFor(layerId));
    },
  );

  it("keys polygons as an outlined square, and score polygons as the gray ramp", () => {
    expect(legendSymbol("fire-perimeters", "polygons")).toEqual({ kind: "polygon" });
    expect(legendSymbol("public-lands", "polygons")).toEqual({ kind: "polygon" });
    expect(legendSymbol("remoteness", "polygons")).toEqual({ kind: "score" });
    expect(legendSymbol("any-grid", "polygons", "score")).toEqual({ kind: "score" });
    expect(legendSymbol("remoteness", "polygons", "km")).toEqual({ kind: "polygon" });
  });

  it("keys raster tiles as hatching and heat as a ramp", () => {
    expect(legendSymbol("night-lights", "tiles")).toEqual({ kind: "tiles" });
    expect(legendSymbol("campsites", "heat")).toEqual({ kind: "score" });
  });

  it("returns a fresh dash array each time, so callers cannot change the table", () => {
    const a = legendSymbol("forest-roads", "lines").dash!;
    a[0] = 99;
    expect(legendSymbol("forest-roads", "lines").dash).toEqual([4, 3]);
  });
});
