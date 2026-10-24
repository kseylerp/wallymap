import { describe, expect, it } from "vitest";
import type { Feature, Point } from "geojson";
import { attachWater, buildWaterNearCampsQuery, parseWater } from "./water-near";

const camp = (name: string, at: [number, number], kind = "camp_site"): Feature<Point> => ({ type: "Feature", geometry: { type: "Point", coordinates: at }, properties: { name, kind } });

describe("water near camps", () => {
  it("finds the water around the box's camp sites in one Overpass call", () => {
    const q = buildWaterNearCampsQuery([-121.9, 46.7, -121.5, 47]);
    expect(q).toContain('node["tourism"="camp_site"](46.7,-121.9,47,-121.5)');
    expect(q).toContain('way(around.c:200)["waterway"~"^(stream|river)$"]');
    expect(q).toContain('node(around.c:200)["natural"="spring"]');
  });

  it("puts the nearest water within 200 m on each camp, in words, and none on parking", () => {
    const water = parseWater({
      elements: [
        { type: "way", tags: { natural: "water", name: "Snow Lake" }, geometry: [{ lat: 46.8, lon: -121.7 }, { lat: 46.8, lon: -121.699 }] },
        { type: "way", tags: { waterway: "stream" }, geometry: [{ lat: 46.8005, lon: -121.71 }, { lat: 46.8005, lon: -121.69 }] },
        { type: "node", lat: 46.9, lon: -121.6, tags: { natural: "spring" } },
        { type: "node", lat: 46.9, lon: -121.6, tags: { amenity: "toilets" } },
      ],
    });
    expect(water.map((w) => w.kind)).toEqual(["lake", "stream", "spring"]);
    const lakeside = camp("Snow Lake Camp", [-121.6995, 46.8002]);
    const dry = camp("Dry Camp", [-121.5, 46.95]);
    const lot = camp("Lot", [-121.6995, 46.8002], "parking");
    expect(attachWater([lakeside, dry, lot], water)).toBe(1);
    expect(lakeside.properties).toMatchObject({ nearWater: true, water: "Snow Lake (lake) · a stream" });
    expect(lakeside.properties?.waterM).toBeLessThan(40);
    expect(dry.properties?.nearWater).toBeUndefined();
    expect(lot.properties?.nearWater).toBeUndefined();
  });
});
