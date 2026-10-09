import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { BBoxSchema, bboxAreaKm2, defineLayer } from "./types";
import { registerLayer, getLayer, listLayers, clearRegistry } from "./registry";

const fake = defineLayer({
  id: "fake", title: "Fake", description: "d", coverage: "global", license: "CC0",
  requiredEnv: [], maxAreaKm2: 100, input: z.object({ n: z.number().optional() }),
  query: async () => ({ error: "nope" }), style: { geometry: "point", color: "#000" },
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
