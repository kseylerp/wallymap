import { describe, expect, it } from "vitest";
import {
  arrivalPitch,
  buildingsSpec,
  easeInOut,
  firstSymbolLayerId,
  fitZoomOffset,
  fogSpec,
  pitchFor,
  skySpec,
  terrainSource,
  terrainSpec,
  TERRAIN_SOURCE_ID,
} from "@/lib/render/wally/terrain";

describe("terrain specs", () => {
  it("uses Wally's DEM source settings", () => {
    expect(terrainSource()).toEqual({
      type: "raster-dem",
      url: "mapbox://mapbox.mapbox-terrain-dem-v1",
      tileSize: 514,
      maxzoom: 14,
    });
  });

  it("exaggerates terrain 1.2x by default", () => {
    expect(terrainSpec()).toEqual({ source: TERRAIN_SOURCE_ID, exaggeration: 1.2 });
    expect(terrainSpec(2).exaggeration).toBe(2);
  });

  it("draws an atmosphere sky with a warm color", () => {
    const sky = skySpec();
    expect(sky.type).toBe("sky");
    expect(sky.paint?.["sky-type"]).toBe("atmosphere");
    expect(sky.paint?.["sky-atmosphere-color"]).toBe("#F4E4CC");
  });

  it("keeps the fog light", () => {
    const fog = fogSpec();
    expect(fog.range).toEqual([1, 12]);
    expect(fog["horizon-blend"]).toBeLessThan(0.1);
  });

  it("extrudes buildings in the off-white surface from zoom 13.5, fading to 0.6 over 1.5 zoom levels", () => {
    const spec = buildingsSpec();
    expect(spec.type).toBe("fill-extrusion");
    expect(spec.source).toBe("composite");
    expect(spec["source-layer"]).toBe("building");
    expect(spec.minzoom).toBe(13.5);
    expect(spec.paint?.["fill-extrusion-color"]).toBe("#ECEAE7");
    expect(spec.paint?.["fill-extrusion-opacity"]).toEqual(["interpolate", ["linear"], ["zoom"], 13.5, 0, 15, 0.6]);
    expect(buildingsSpec("streets").source).toBe("streets");
  });

  it("finds the first symbol layer so buildings sit below the labels", () => {
    expect(
      firstSymbolLayerId([
        { id: "land", type: "background" },
        { id: "road", type: "line" },
        { id: "road-label", type: "symbol" },
        { id: "place-label", type: "symbol" },
      ]),
    ).toBe("road-label");
    expect(firstSymbolLayerId([{ id: "land", type: "background" }])).toBeUndefined();
  });
});

describe("pitch presets", () => {
  it("maps Explore, Detail and Follow to 45, 72 and 65", () => {
    expect(pitchFor("explore")).toBe(45);
    expect(pitchFor("detail")).toBe(72);
    expect(pitchFor("follow")).toBe(65);
  });

  it("tilts an arriving camera to 45 at zoom 10 and above unless flattened", () => {
    expect(arrivalPitch(10, false)).toBe(45);
    expect(arrivalPitch(14, false)).toBe(45);
    expect(arrivalPitch(9.9, false)).toBe(0);
    expect(arrivalPitch(12, true)).toBe(0);
  });

  it("backs a pitched fit off 0.4 zoom at 45 degrees and 0.8 at 72", () => {
    expect(fitZoomOffset(0)).toBe(0);
    expect(fitZoomOffset(45)).toBeCloseTo(0.4);
    expect(fitZoomOffset(72)).toBeCloseTo(0.8);
    expect(fitZoomOffset(60)).toBeGreaterThan(0.4);
    expect(fitZoomOffset(60)).toBeLessThan(0.8);
    expect(fitZoomOffset(85)).toBeCloseTo(0.8);
  });

  it("eases in and out", () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(0.5)).toBeCloseTo(0.5);
    expect(easeInOut(1)).toBe(1);
  });
});
