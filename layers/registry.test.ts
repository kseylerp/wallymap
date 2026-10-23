import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { BBoxSchema, bboxAreaKm2, defineLayer } from "./types";
import { registerLayer, getLayer, listLayers, clearRegistry } from "./registry";
import "./index";
import { LAYER_ROLES, layerColor, PALETTE, RASTER_TILE_LAYERS, ROLE_COLORS } from "@/lib/render/palette";

/** Every real layer, captured before any test clears the registry. */
const registered = listLayers();

const fake = defineLayer({
  id: "fake", title: "Fake", description: "d", coverage: "global", surface: "any", license: "CC0",
  requiredEnv: [], maxAreaKm2: 100, input: z.object({ n: z.number().optional() }),
  query: async () => ({ error: "nope" }), style: { geometry: "point", color: "#000" },
});

describe("surface", () => {
  const SURFACES = ["land", "water", "coast", "any"];
  it("every layer says where its features belong", () => {
    expect(registered.length).toBeGreaterThanOrEqual(81);
    for (const l of registered) {
      const s = l.surface;
      if (typeof s === "string") expect(SURFACES, l.id).toContain(s);
      else {
        expect(SURFACES, l.id).toContain(s.default);
        for (const v of Object.values(s.by)) expect(SURFACES, l.id).toContain(v);
      }
    }
  });
  it("puts crags on land, buoys at sea, surf breaks and tide gauges at the coast", () => {
    const of = (id: string) => registered.find((l) => l.id === id)?.surface;
    expect(of("climbing")).toBe("land");
    expect(of("sea-ice")).toBe("water");
    expect(of("sea-level-trends")).toBe("coast");
    expect(of("surf")).toEqual({ key: "kind", by: { buoy: "water", station: "water", climatology: "water" }, default: "coast" });
  });
});

describe("BBoxSchema", () => {
  it("accepts a normal bbox", () => expect(BBoxSchema.parse([-120, 38, -119, 39])).toEqual([-120, 38, -119, 39]));
  it("rejects west > east", () => expect(() => BBoxSchema.parse([179, 38, -179, 39])).toThrow());
  it("rejects latitude over 90", () => expect(() => BBoxSchema.parse([0, 0, 1, 91])).toThrow());
});
describe("bboxAreaKm2", () => {
  it("is about 9600 km2 for a 1x1 degree box at 38N", () => {
    const area = bboxAreaKm2([-120, 38, -119, 39]);
    expect(area).toBeGreaterThan(9000);
    expect(area).toBeLessThan(10500);
  });
});
describe("registry", () => {
  beforeEach(clearRegistry);
  it("registers and lists", () => { registerLayer(fake); expect(listLayers().map(l => l.id)).toEqual(["fake"]); expect(getLayer("fake")).toBe(fake); });
  it("rejects duplicate ids", () => { registerLayer(fake); expect(() => registerLayer(fake)).toThrow(/duplicate/i); });
});
describe("palette roles per layer", () => {
  it("gives every registered layer a role, and no role to a layer that is not registered", () => {
    expect(registered.map((l) => l.id).sort()).toEqual(Object.keys(LAYER_ROLES).sort());
  });

  it.each(registered.map((l) => [l.id, l] as const))("%s draws in its role's palette color", (id, layer) => {
    expect(PALETTE.has(layer.style.color)).toBe(true);
    expect(layer.style.color).toBe(layerColor(id));
    expect(layer.style.color).toBe(ROLE_COLORS[LAYER_ROLES[id]]);
  });

  it("makes fire hazards pink, protected land sage, and other data dark grey", () => {
    expect(layerColor("fire-perimeters")).toBe("#F57272");
    expect(layerColor("fire-detections")).toBe("#F57272");
    for (const id of ["wilderness", "public-lands", "physical-regions"]) expect(layerColor(id)).toBe("#9FB693");
    for (const id of ["osm-trails", "forest-roads", "campsites", "snowpack", "streamflow"]) expect(layerColor(id)).toBe("#3A3A3C");
    for (const id of ["earthquakes", "smoke", "fire-weather", "weather-alerts", "drought"]) expect(layerColor(id)).toBe("#F57272");
    for (const id of ["glaciers", "critical-habitat"]) expect(layerColor(id)).toBe("#9FB693");
    expect(layerColor("unknown-layer")).toBe("#3A3A3C");
  });

  it("lists the raster tile layers, which draw their own imagery", () => {
    expect([...RASTER_TILE_LAYERS].sort()).toEqual([
      "burn-severity", "carbon-flux", "disturbance", "fire-hazard", "flood-extent", "forest-alerts",
      "forest-loss", "greenness", "imagery-by-date", "land-cover", "night-lights", "phenology", "population",
      "sea-ice", "sea-level-rise", "snow-cover", "surface-water", "terrain",
    ]);
  });
});
