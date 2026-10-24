import { describe, expect, it } from "vitest";
import "@/layers";
import type { BBox } from "@/layers/types";
import { anchorsOf, answerTemplate, chooseFollowUps, forecastDay, type AnswerCall } from "./answer";

const BEND: BBox = [-121.4, 43.98, -121.2, 44.12];
const citation = { source: "test", url: "https://example.com", retrieved: "2026-10-23" };

const hike = (name: string, lon: number, roundTripKm: number, roundTripGainM: number, shape = "out_and_back") => ({
  type: "Feature" as const,
  geometry: { type: "LineString" as const, coordinates: [[lon, 44.05], [lon + 0.01, 44.06]] },
  properties: { name, kind: "path", lengthKm: roundTripKm / 2, roundTripKm, roundTripGainM, gainM: roundTripGainM / 2, shape },
});

const hikes: AnswerCall[] = [
  { toolName: "geocode", input: { place: "Bend" }, output: { bbox: BEND, center: [-121.31, 44.06], name: "Bend, Oregon, United States", source: "mapbox" } },
  {
    toolName: "query_osm-trails",
    input: { bbox: BEND },
    output: {
      kind: "geojson",
      data: { type: "FeatureCollection", features: [hike("Tumalo Falls Trail", -121.35, 11, 198), hike("Pilot Butte Trail", -121.28, 3, 146, "loop"), hike("Deschutes River Trail", -121.33, 9, 60)] },
      citation,
    },
  },
  { toolName: "render", input: { layerId: "osm-trails", view: "ranked", rankBy: "roundTripKm" }, output: { layerId: "osm-trails", view: "ranked", rankBy: "roundTripKm" } },
];

describe("answerTemplate (lib/agent/answer.ts)", () => {
  const t = answerTemplate({ calls: hikes, question: "Good day hikes near Bend", outputs: [], places: [{ name: "Bend, Oregon, United States", bbox: BEND }], view: null })!;

  it("reads the hikes off the map as ranked, in the person's units", () => {
    expect(t.layerId).toBe("osm-trails");
    expect(t.options.map((o) => o.name)).toEqual(["Tumalo Falls Trail", "Deschutes River Trail", "Pilot Butte Trail"]);
    expect(t.options[0].facts[0]).toBe("6.84 mi round trip");
    expect(t.options[0].facts[1]).toMatch(/^650 ft of climb$/);
  });

  it("answers in its first sentence with the deciding numbers", () => {
    expect(t.lead).toBe("3 hikes near Bend; the top is Tumalo Falls Trail, 6.84 mi round trip and 650 ft of climb.");
    expect(t.lines).toHaveLength(3);
  });

  it("offers three follow-ups that name what it found", () => {
    expect(t.followUps).toHaveLength(3);
    expect(t.followUps.filter((q) => q.includes("Tumalo Falls Trail") || q.includes("Bend")).length).toBeGreaterThanOrEqual(2);
  });
});

describe("follow-ups", () => {
  it("keeps the model's that name a feature, and fills from the template to three", () => {
    const anchors = anchorsOf(hikes, [{ name: "Bend, Oregon, United States" }]);
    expect(anchors).toEqual(expect.arrayContaining(["Tumalo Falls Trail", "Bend"]));
    const out = chooseFollowUps(["Want more trails?", "Is Pilot Butte Trail steep?"], ["Is Tumalo Falls Trail busy?", "What is the weather near Bend?"], anchors);
    expect(out).toEqual(["Is Pilot Butte Trail steep?", "Is Tumalo Falls Trail busy?", "What is the weather near Bend?"]);
  });
});

describe("forecastDay", () => {
  it("reads a forecast day plainly", () => {
    expect(forecastDay("Sat, Oct 24: high 44 °F, low 30 °F; 3% chance of rain or snow, 0.00 in; wind to 7 mph, gusts 15 mph; mostly cloudy")).toEqual({
      day: "Saturday",
      date: "Oct 24",
      text: "high 44 °F, low 30 °F, 3% chance of rain or snow, wind to 7 mph, gusts 15 mph, mostly cloudy",
    });
  });
});

describe("briefValue", () => {
  it("keeps a short value whole and a long rule's first clause", async () => {
    const { briefValue } = await import("./answer");
    expect(briefValue("Maintenance level 3")).toBe("Maintenance level 3");
    const rule = "Coconino National Forest, forest-wide, outside the Sedona orders: dispersed camping is allowed outside the closed areas the Motor Vehicle Use Map marks, up to 14 days in any 30; drive no more than 30 feet off a forest road to camp (Coconino camping guidance).";
    expect(briefValue(rule)).toBe("dispersed camping is allowed outside the closed areas the Motor Vehicle Use Map marks, up to 14 days in any 30");
  });
});
