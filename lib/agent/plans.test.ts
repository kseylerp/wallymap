import { describe, expect, it } from "vitest";
import "@/layers";
import { getLayer } from "@/layers";
import { planLayerIds, readQuestion, ydsBands } from "@/lib/agent/reading";

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
    expect(strongIds("Is Chaco Canyon threatened by oil and gas?")).toEqual(expect.arrayContaining(["mineral-leases", "pipelines-lines", "methane-plumes"]));
    expect(views("What wildlife has been seen around here?").species).toBe("density");
    expect(views("Research-grade moose sightings near Jackson Hole in the last year, by month").species).toBe("timeline");
  });

  it("joins a hike to the feature it reaches, asking those features, without the trails' own payoff chip", () => {
    const loops = readQuestion("Loop hikes under 6 miles with a waterfall near Asheville, under 1,500 ft of climb", NOW);
    expect(loops.combine).toMatchObject({ op: "near", distance: 0.5 });
    expect(loops.layers.filter((l) => l.strong).map((l) => l.layerId)).toEqual(expect.arrayContaining(["osm-trails", "outdoor-features"]));
    expect(loops.inputs).toContainEqual(expect.objectContaining({ layerId: "outdoor-features", input: { kinds: ["waterfall"] } }));
    expect(loops.filters.some((f) => f.key === "payoff")).toBe(false);
    // "near Lake Tahoe" is the place, not a lake to join to.
    expect(readQuestion("Campgrounds near Lake Tahoe", NOW).combine).toBeNull();
    expect(readQuestion("Campsites near a lake in the Sierra", NOW).combine).toMatchObject({ op: "near" });
  });

  it("reads bike trails as the mountain bike trails, with an easy level", () => {
    const easy = readQuestion("Easy bike trails here", NOW);
    expect(easy.layers.filter((l) => l.strong).map((l) => l.layerId)).toEqual(["mtb-trails"]);
    expect(easy.layers.map((l) => l.layerId)).not.toContain("osm-trails");
    expect(easy.filters).toContainEqual(expect.objectContaining({ layerId: "mtb-trails", key: "level", include: ["beginner"] }));
  });

  it("names only registered layers", () => {
    expect(planLayerIds().filter((id) => !getLayer(id))).toEqual([]);
  });

  it("reads the place layers: faults, soils, what grows, natural or planted, tree height, by month, depth, cross-section", () => {
    expect(strongIds("What rock types and ages make up Zion Canyon, and are there faults?")).toContain("faults");
    expect(strongIds("What's the soil like around Boulder?")).toContain("soils");
    expect(strongIds("What ecosystems cover the Great Smoky Mountains, with the share of each?")).toContain("vegetation-types");
    expect(strongIds("Is the forest around Mount Hood natural or planted, and how tall are the trees?")).toEqual(expect.arrayContaining(["forest-types", "canopy-height"]));
    expect(strongIds("How deep is the water here?")).toContain("water-depth");
    expect(strongIds("Elevation cross-section from Yosemite Valley to the top of Half Dome")).toContain("elevation-profile");
  });

  it("answers a typical month from the climate normals, never the 7-day forecast", () => {
    const typical = readQuestion("Typical temperature and precipitation by month at Lake Tahoe, and when the snow usually melts", NOW);
    expect(typical.layers.filter((l) => l.strong).map((l) => l.layerId)).toContain("climate-normals");
    expect(typical.layers.map((l) => l.layerId)).not.toContain("weather-forecast");
    expect(typical.avoid.map((a) => a.layerId)).toContain("weather-forecast");
    expect(strongIds("Forecast for Paradise on Mount Rainier this Saturday and Sunday")).toContain("weather-forecast");
  });

  it("reads route grades as their bands", () => {
    expect(ydsBands("Sport crags with 5.10 to 5.11 routes")).toEqual(["intermediate", "advanced"]);
    expect(ydsBands("easy 5.6 climbs")).toEqual(["beginner"]);
    expect(ydsBands("crags near Moab")).toEqual([]);
  });
});
