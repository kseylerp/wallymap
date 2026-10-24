import { describe, expect, it } from "vitest";
import "@/layers";
import { readQuestion, ydsBands } from "@/lib/agent/reading";

/** The top 10 use cases' plans (docs/top-10-use-cases.md): the layers, filters and views a decision is read from. */
const NOW = new Date("2026-10-23T12:00:00Z");
const strongIds = (q: string) => readQuestion(q, NOW).layers.filter((l) => l.strong).map((l) => l.layerId);
const views = (q: string) => Object.fromEntries(readQuestion(q, NOW).views.map((v) => [v.layerId, v.view]));

describe("plans read before the model chooses", () => {
  it("ranks hikes, keeps a day hike to a half day, and asks the viewpoints for a hike with a view", () => {
    expect(views("Good day hikes near Bend")["osm-trails"]).toBe("ranked");
    expect(readQuestion("Good day hikes near Bend", NOW).filters).toContainEqual(expect.objectContaining({ layerId: "osm-trails", key: "roundTripKm", range: [3, 25] }));
    expect(readQuestion("Loop hikes under 6 miles near Asheville", NOW).filters.some((f) => f.key === "roundTripKm")).toBe(false);
    expect(strongIds("An easy hike with a view near Lake Tahoe")).toContain("outdoor-features");
    const loops = readQuestion("Loop hikes under 6 miles with a waterfall near Asheville, under 1,500 ft of climb", NOW);
    expect(loops.filters).toContainEqual(expect.objectContaining({ layerId: "osm-trails", key: "gainM", range: [0, 457] }));
    expect(loops.rankBy).toEqual([]);
  });

  it("reads snow on the ground from the stations, open campgrounds from the federal sites, camping with who manages the land", () => {
    expect(strongIds("Is there snow on the ground at Lake Tahoe right now?")).toEqual(expect.arrayContaining(["snowpack", "snow-cover"]));
    const open = readQuestion("Which campgrounds near Lake Tahoe are open now?", NOW);
    expect(open.layers.filter((l) => l.strong).map((l) => l.layerId)).toContain("recreation-sites");
    expect(open.filters).toContainEqual(expect.objectContaining({ layerId: "recreation-sites", key: "status", include: ["open"] }));
    expect(strongIds("Camping near Moab")).toEqual(expect.arrayContaining(["campsites", "public-lands"]));
    expect(strongIds("Campsites near water along the Wonderland Trail")).toContain("campsites");
  });

  it("reads protection, rocks, burn scars, oil and gas, wildlife and time", () => {
    expect(strongIds("What protects Grand Staircase-Escalante?")).toContain("monuments");
    expect(strongIds("Jaguar records outside protected areas")).not.toContain("monuments");
    expect(strongIds("What rock types and ages make up Zion Canyon?")).toEqual(expect.arrayContaining(["geology", "geologic-unit"]));
    expect(views("Burn scars around Paradise, California since 2018")["fire-perimeters"]).toBe("timeline");
    expect(strongIds("Is Chaco Canyon threatened by oil and gas?")).toEqual(expect.arrayContaining(["pipelines-lines", "methane-plumes"]));
    expect(views("What wildlife has been seen around here?").species).toBe("density");
    expect(views("Research-grade moose sightings near Jackson Hole in the last year, by month").species).toBe("timeline");
  });

  it("reads route grades as their bands", () => {
    expect(ydsBands("Sport crags with 5.10 to 5.11 routes")).toEqual(["intermediate", "advanced"]);
    expect(ydsBands("easy 5.6 climbs")).toEqual(["beginner"]);
    expect(ydsBands("crags near Moab")).toEqual([]);
  });
});
