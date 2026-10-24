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

describe("answers that name enough places (top-10 T04.2, T04.3, T06.3, T06.5)", () => {
  const pt = (name: string, lon: number, lat: number, props: Record<string, unknown> = {}) => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [lon, lat] }, properties: { name, ...props } });
  const box = (lon: number, lat: number, d: number) => ({ type: "Polygon" as const, coordinates: [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]] });
  const TAHOE: BBox = [-120.2, 38.9, -119.9, 39.3];
  const geo = (data: unknown[]) => ({ kind: "geojson", data: { type: "FeatureCollection", features: data }, citation });

  it("names the campgrounds a status filter hides: two open, the closed ones too", () => {
    const sites = [
      pt("Zephyr Cove Resort", -119.95, 39.0, { kind: "campground", status: "open" }),
      pt("Camp Richardson Resort", -120.04, 38.93, { kind: "campground", status: "open" }),
      pt("Fallen Leaf Campground", -120.05, 38.92, { kind: "campground", status: "closed" }),
      pt("D.L. Bliss State Park", -120.1, 38.98, { kind: "campground", status: "closed" }),
    ];
    const t = answerTemplate({
      calls: [
        { toolName: "geocode", input: { place: "Lake Tahoe" }, output: { bbox: TAHOE, center: [-120.05, 39.09], name: "Lake Tahoe", source: "mapbox" } },
        { toolName: "query_recreation-sites", input: { bbox: TAHOE }, output: geo(sites) },
        { toolName: "render", input: {}, output: { layerId: "recreation-sites", filters: { kind: { include: ["campground"] }, status: { include: ["open"] } }, view: "ranked" } },
      ],
      question: "Which campgrounds near Lake Tahoe are open now?",
      outputs: [],
      places: [{ name: "Lake Tahoe", bbox: TAHOE }],
      view: null,
    })!;
    expect(t.lines.join("\n")).toMatch(/^Closed now: Fallen Leaf Campground and D\.L\. Bliss State Park\.$/m);
  });

  it("says a camp's rule once under the options, without its owner", () => {
    const rule = "National Park Service, Mount Rainier National Park, Mount Rainier National Park backcountry, including the Wonderland Trail: a wilderness permit is required year-round for every overnight stay in the backcountry (Mount Rainier wilderness permits page, 2026-10-23)";
    const camps = ["Maple Creek Camp", "Indian Bar Camp", "Devil's Dream Camp"].map((n, i) => pt(n, -121.7 + i * 0.01, 46.8, { kind: "camp_site", campingRule: rule }));
    const t = answerTemplate({
      calls: [
        { toolName: "query_campsites", input: { bbox: [-122, 46.7, -121.5, 47] }, output: geo(camps) },
        { toolName: "render", input: {}, output: { layerId: "campsites" } },
      ],
      question: "Campsites near water along the Wonderland Trail",
      outputs: [],
      places: [],
      view: null,
    })!;
    expect(t.lines.filter((l) => l.startsWith("Camping rule here"))).toEqual(["Camping rule here: A wilderness permit is required year-round for every overnight stay in the backcountry."]);
  });

  it("says how close the nearest threat comes to the place, from the distances the query recorded", () => {
    const leases = [
      { type: "Feature" as const, geometry: box(-108.1, 35.9, 0.02), properties: { name: "Oil and gas lease NMNM1", acres: 2118, distanceToPlaceKm: 6.1 } },
      { type: "Feature" as const, geometry: box(-108.2, 35.95, 0.02), properties: { name: "Oil and gas lease NMNM2", acres: 900, distanceToPlaceKm: 14 } },
    ];
    const CHACO: BBox = [-108.19, 35.88, -107.74, 36.24];
    const t = answerTemplate({
      calls: [
        { toolName: "geocode", input: { place: "Chaco Canyon" }, output: { bbox: CHACO, center: [-107.97, 36.06], name: "Chaco Canyon (valley in San Juan County, New Mexico, United States)", source: "wikidata" } },
        { toolName: "query_mineral-leases", input: { bbox: CHACO }, output: geo(leases) },
        { toolName: "render", input: {}, output: { layerId: "mineral-leases", view: "ranked", rankBy: "acres" } },
      ],
      question: "Is Chaco Canyon threatened by oil and gas?",
      outputs: [],
      places: [{ name: "Chaco Canyon (valley in San Juan County, New Mexico, United States)", bbox: CHACO }],
      view: null,
    })!;
    expect(t.place).toBe("Chaco Canyon");
    expect(t.allLines).toContain("Closest to Chaco Canyon: Oil and gas lease NMNM1, 3.8 mi (6.1 km) from its centre.");
    expect(t.options.map((o) => o.name)).toEqual(["Oil and gas lease NMNM1", "Oil and gas lease NMNM2"]);
  });

  it("fills a short list of protected areas from the question's other layers, never the same place twice", () => {
    const VIEW: BBox = [-117.5, 42.5, -116.8, 43];
    const t = answerTemplate({
      calls: [
        { toolName: "query_wilderness", input: { bbox: VIEW }, output: geo([{ type: "Feature", geometry: box(-117.2, 42.6, 0.1), properties: { name: "North Fork Owyhee Wilderness", acres: 44027 } }]) },
        {
          toolName: "query_protected-areas-world",
          input: { bbox: VIEW },
          output: geo([
            { type: "Feature", geometry: box(-117.4, 42.7, 0.2), properties: { name: "Owyhee River Canyon", designation: "Wilderness Study Area", areaKm2: 759, v: 759 } },
            { type: "Feature", geometry: box(-117.2, 42.6, 0.1), properties: { name: "North Fork Owyhee", designation: "Wilderness Area", areaKm2: 181, v: 181 } },
            { type: "Feature", geometry: box(-117.0, 42.8, 0.1), properties: { name: "Clarks Butte", designation: "Wilderness Study Area", areaKm2: 127, v: 127 } },
          ]),
        },
        { toolName: "render", input: {}, output: { layerId: "wilderness", view: "ranked" } },
        { toolName: "render", input: {}, output: { layerId: "protected-areas-world" } },
      ],
      question: "Who manages this land and is it protected?",
      outputs: [],
      places: [],
      view: { bbox: VIEW },
      prefer: ["wilderness", "protected-areas-world", "public-lands"],
      viewPlace: "Rome",
    })!;
    expect(t.options.map((o) => o.name)).toEqual(["North Fork Owyhee Wilderness", "Owyhee River Canyon", "Clarks Butte"]);
    expect(t.followUps.some((q) => q.includes("Rome") || q.includes("Owyhee"))).toBe(true);
  });
});
