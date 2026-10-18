import { describe, expect, it } from "vitest";
import { getLayer } from "@/layers/registry";
import "@/layers/index";
import { RASTER_CALM } from "@/lib/render/palette";
import { rasterKeyFilter, rasterPaint } from "@/lib/render/rasterCalm";

describe("rasterPaint", () => {
  it("defaults third-party rasters to the calm saturation and opacity", () => {
    expect(rasterPaint(undefined)).toEqual({
      "raster-opacity": RASTER_CALM.opacity,
      "raster-saturation": RASTER_CALM.saturation,
      "raster-hue-rotate": 0,
      "raster-contrast": 0,
      "raster-brightness-min": 0,
      "raster-brightness-max": 1,
    });
  });

  it("takes the hint's values, clamped to Mapbox's ranges, and scales opacity by the panel", () => {
    const paint = rasterPaint({ saturation: -3, hueRotate: 40, brightnessMax: 0.92, opacity: 0.5 }, 0.5);
    expect(paint).toMatchObject({ "raster-saturation": -1, "raster-hue-rotate": 40, "raster-brightness-max": 0.92, "raster-opacity": 0.25 });
  });

  it("leaves null (imagery) as served at the old 0.8 opacity", () => {
    expect(rasterPaint(null)).toMatchObject({ "raster-opacity": 0.8, "raster-saturation": 0, "raster-hue-rotate": 0 });
  });
});

describe("rasterKeyFilter", () => {
  it("mirrors the paint as a CSS filter, and is empty for imagery", () => {
    expect(rasterKeyFilter({ saturation: -0.5, hueRotate: 40 })).toBe("saturate(0.50) hue-rotate(40deg)");
    expect(rasterKeyFilter({ brightnessMax: 0.92 })).toBe("saturate(0.45) brightness(0.92)");
    expect(rasterKeyFilter(null)).toBe("");
  });
});

describe("layer raster hints", () => {
  const hint = (id: string) => getLayer(id)?.style.raster;
  it("sets the calmed look on the GIBS and GFW layers, draws keyed classes as served, and leaves imagery alone", () => {
    // Flood water and forest loss are drawn in the colors their keys name, so they are not desaturated.
    expect(hint("flood-extent")).toMatchObject({ saturation: 0 });
    expect(hint("forest-loss")).toMatchObject({ saturation: 0 });
    expect(hint("snow-cover")).toMatchObject({ brightnessMax: 0.92 });
    expect(hint("land-cover")).toMatchObject({ saturation: -0.4, opacity: 0.65 });
    expect(hint("imagery-by-date")).toBeNull();
  });
});
