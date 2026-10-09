import { describe, expect, it } from "vitest";
import { lineDashFor } from "@/lib/render/palette";
import { legendSymbol } from "@/lib/render/wally/legend";

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

  it("passes deck's dash (palette lineDashFor) through unchanged", () => {
    expect(legendSymbol("some-river", "lines").dash).toEqual(lineDashFor("some-river"));
  });

  it("keys polygons with the wash deck draws: 10% for events, outline only for boundaries", () => {
    expect(legendSymbol("fire-perimeters", "polygons")).toEqual({ kind: "polygon", fill: 0.1 });
    expect(legendSymbol("something-new", "polygons")).toEqual({ kind: "polygon", fill: 0.1 });
    for (const id of ["wilderness", "public-lands", "physical-regions"]) {
      expect(legendSymbol(id, "polygons")).toEqual({ kind: "polygon", fill: 0 });
    }
  });

  it("keys vector tile areas (public lands on Mapbox) with their regional gray tint", () => {
    expect(legendSymbol("public-lands", "vector-polygons")).toEqual({ kind: "polygon", fill: 0.1 });
  });

  it("keys score polygons as the gray ramp", () => {
    expect(legendSymbol("remoteness", "polygons")).toEqual({ kind: "score" });
    expect(legendSymbol("any-grid", "polygons", "score")).toEqual({ kind: "score" });
    expect(legendSymbol("remoteness", "polygons", "km")).toEqual({ kind: "polygon", fill: 0.1 });
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
