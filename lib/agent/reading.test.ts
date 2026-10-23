import { describe, expect, it } from "vitest";
import "@/layers";
import { getLayer } from "@/layers/registry";
import { colorRegion, lengthRange, readingFilters, readingForPrompt, readQuestion, riverNames, timeInputs, timeWindow } from "@/lib/agent/reading";

// A Friday.
const NOW = new Date("2026-10-23T18:00:00Z");

describe("timeWindow: the time phrases people use", () => {
  it.each([
    ["How much has Lake Powell dropped since 2000?", "2000-01-01", "2026-10-23", false],
    ["Lake Powell's level back to 1999", "1999-01-01", "2026-10-23", false],
    ["Did Lake Mead shrink since the 1980s?", "1980-01-01", "2026-10-23", false],
    ["Biggest methane leaks in the Permian this year", "2026-01-01", "2026-10-23", false],
    ["Where are whales being seen off Monterey this week?", "2026-10-16", "2026-10-23", false],
    ["Where have bald eagles been seen near Seattle lately?", "2026-09-23", "2026-10-23", false],
    ["How much of the Deschutes burned in the last 10 years?", "2016-10-23", "2026-10-23", false],
    ["Bouldering near Bishop this weekend", "2026-10-24", "2026-10-25", true],
    ["Is it too windy to climb at Joshua Tree tomorrow?", "2026-10-24", "2026-10-24", true],
    ["How much snow fell last winter in Utah?", "2025-12-01", "2026-02-28", false],
    ["Compare forest loss in Rondônia between 2015 and 2025", "2015-01-01", "2025-12-31", false],
    ["Earthquakes in Japan this month", "2026-10-01", "2026-10-23", false],
    ["How warm was Fresno last month?", "2026-09-01", "2026-09-30", false],
    ["Fires in 2020 in Oregon", "2020-01-01", "2020-12-31", false],
  ])("%s", (question, from, to, future) => {
    expect(timeWindow(question, NOW)).toMatchObject({ from, to, future });
  });

  it("reads a month with no year as that month of every year", () => {
    expect(timeWindow("Best place to see sandhill cranes in Nebraska in March", NOW)).toMatchObject({ month: 3, from: "2026-03-01", to: "2026-03-31" });
    // Every March the sightings layer holds (its ten-year window), not the one March of the last 365 days.
    expect(timeInputs(getLayer("species")!, timeWindow("Best place to see sandhill cranes in Nebraska in March", NOW)!, NOW)).toEqual({ month: 3, days: 3650 });
    expect(timeWindow("Wildflowers in May near Bishop", NOW)).toMatchObject({ month: 5 });
    expect(timeWindow("What may be blooming near Bishop", NOW)).toBeNull();
  });

  it("reads now and today as today, and nothing as null", () => {
    expect(timeWindow("Is the Gauley running right now?", NOW)).toMatchObject({ from: "2026-10-23", to: "2026-10-23", future: false });
    expect(timeWindow("Climbing crags near Red River Gorge", NOW)).toBeNull();
  });

  it("starts this weekend today when it is already Saturday", () => {
    expect(timeWindow("Surf this weekend", new Date("2026-10-24T15:00:00Z"))).toMatchObject({ from: "2026-10-24", to: "2026-10-25" });
  });
});

describe("timeInputs: a window as each layer's own time inputs", () => {
  const input = (layerId: string, question: string) => timeInputs(getLayer(layerId)!, timeWindow(question, NOW)!, NOW);

  it("sets years, days, ranges and forecast days from the phrase", () => {
    // Audit: "since 2000" became years 5; "this year" became days 730.
    expect(input("reservoir-levels", "since 2000")).toEqual({ years: 27 });
    expect(input("methane-plumes", "this year")).toEqual({ days: 296 });
    expect(input("species", "this week")).toEqual({ days: 8 });
    expect(input("fire-perimeters", "in the last 10 years")).toEqual({ yearsBack: 10 });
    expect(input("wind-flow", "tomorrow")).toEqual({ days: 2 });
    expect(input("tree-mortality", "since 2020")).toMatchObject({ years: { from: 2020 } });
    expect(input("forest-loss", "since 2017")).toEqual({ startYear: 2017 });
  });

  it("leaves the layers' own defaults for today, and past inputs alone for a forecast", () => {
    expect(input("species", "right now")).toEqual({});
    expect(input("species", "tomorrow")).toEqual({});
  });

  it("holds values to the layer's bounds", () => {
    expect(input("species", "since 1990")).toEqual({ days: 3650 });
    // Yearly forest loss has no year past its latest: "this month" is its latest year.
    const loss = input("forest-loss", "this month");
    expect(loss.startYear).toBeLessThanOrEqual(2026);
  });
});

describe("readQuestion: the words the audit's questions use", () => {
  const read = (q: string) => readQuestion(q, NOW);
  const strong = (q: string) => read(q).layers.filter((l) => l.strong).map((l) => l.layerId);

  it("routes trail colors and flow trails to mountain bike trails, never river flow", () => {
    const r = read("Flowy blue trails in Sedona");
    expect(strong("Flowy blue trails in Sedona")).toContain("mtb-trails");
    expect(r.avoid.map((a) => a.layerId)).toEqual(expect.arrayContaining(["river-pulse", "streamflow"]));
    expect(r.layers.map((l) => l.layerId)).not.toContain("osm-trails");
    // The Difficulty chip (v) holds IMBA colors, converted from the Singletrack Scale where no IMBA rating is mapped.
    expect(readingFilters(r, "mtb-trails", [-111.76, 34.87])).toEqual([expect.objectContaining({ key: "v", include: ["2"], color: true })]);
  });

  it("reads a piste color by region: blue is intermediate in North America and easy in Europe", () => {
    const vail = read("Blue runs at Vail");
    expect(vail.colors).toEqual([{ word: "blue", activity: "ski" }]);
    expect(readingFilters(vail, "ski-routes", [-106.37, 39.64])).toEqual([expect.objectContaining({ key: "v", include: ["3"] })]);
    expect(readingFilters(read("Blue runs in Chamonix"), "ski-routes", [6.87, 45.92])).toEqual([expect.objectContaining({ key: "v", include: ["2"] })]);
    expect(readingFilters(read("Black diamond runs at Vail"), "ski-routes", [-106.37, 39.64])).toEqual([expect.objectContaining({ include: ["4"] })]);
    expect(colorRegion([6.87, 45.92])).toBe("europe");
  });

  it("routes hikes and trail runs to whole trails, with the length bound as a filter", () => {
    const r = read("Good day hikes near Boulder under 5 miles");
    expect(strong("Good day hikes near Boulder under 5 miles")).toContain("osm-trails");
    expect(r.filters).toContainEqual(expect.objectContaining({ layerId: "osm-trails", key: "lengthKm", range: [0, 8.05] }));
    expect(read("Flat trail runs over 10 miles near Portland").filters).toContainEqual(expect.objectContaining({ key: "lengthKm", range: [16.09, 100_000] }));
    expect(read("Long trail runs with big climbs near Chamonix").rankBy).toContainEqual(expect.objectContaining({ layerId: "osm-trails", key: "gainM" }));
    // Hikes are paths and footpaths, not tracks (Boulder's longest "trail" was Pierson Park Road).
    expect(r.filters).toContainEqual(expect.objectContaining({ layerId: "osm-trails", key: "kind", include: ["path", "footway"] }));
    expect(lengthRange("loops less than 8 km")).toEqual({ range: [0, 8], because: "less than 8 km" });
  });

  it("asks the water layers for water sources, and no parking lots for backpackers", () => {
    const r = read("Backpacking in the Wind Rivers: where are the water sources and campsites?");
    expect(strong("Backpacking in the Wind Rivers: where are the water sources and campsites?")).toEqual(expect.arrayContaining(["outdoor-features", "lakes"]));
    expect(r.inputs).toContainEqual(expect.objectContaining({ layerId: "campsites", input: { includeParking: false, backcountryOnly: true } }));
    // Camping is not parking, unless the question is about parking a van.
    expect(read("Camping and water along the Mojave Road").inputs).toContainEqual(expect.objectContaining({ layerId: "campsites", input: { includeParking: false } }));
    expect(read("Where can I park my van overnight on BLM land near Moab?").inputs).toEqual([]);
    // "Wind Rivers" is a place, not wind.
    expect(r.layers.map((l) => l.layerId)).not.toContain("wind-flow");
  });

  it.each([
    ["Free dispersed camping near Sedona", "public-lands"],
    ["Where can I park my van overnight on BLM land near Moab?", "public-lands"],
    ["Is there fall color near Asheville right now?", "imagery-by-date"],
    ["Class IV runs in Colorado with enough water right now", "paddling"],
    ["Which protected areas in Borneo lost the most forest?", "forest-loss"],
    ["How much forest did Pará lose since 2017 and to what?", "forest-loss"],
    ["Jaguar records in Costa Rica outside protected areas", "species"],
    ["Where are whales being seen off Monterey this week?", "species"],
    ["Which trails at Mount Rainier are snow free right now?", "snow-cover"],
    ["Where can I launch a kayak on Lake Tahoe?", "recreation-sites"],
    ["Where can I fly fish with public access near Asheville?", "public-lands"],
    ["Darkest skies for Milky Way photos near Moab", "night-lights"],
    ["Where can I camp along the Wonderland Trail?", "osm-trails"],
  ])("%s → %s", (question, layerId) => {
    expect(strong(question)).toContain(layerId);
  });

  it("rules greenness out of fall color, and filters the class a paddler names", () => {
    expect(read("Is there fall color near Asheville right now?").avoid.map((a) => a.layerId)).toContain("greenness");
    expect(read("Class IV runs in Colorado with enough water right now").filters).toContainEqual(expect.objectContaining({ layerId: "paddling", key: "v", include: ["4", "4.5"] }));
    expect(read("Where can I paddle class III near Asheville this weekend?").filters).toContainEqual(expect.objectContaining({ layerId: "paddling", key: "v", include: ["3", "3.5"] }));
  });

  it("picks chips the question names, but not the layer's own subject or a state it asks about", () => {
    expect(read("Beginner sport climbing at Red Rock near Las Vegas").filters).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "disciplines", include: ["sport"] }), expect.objectContaining({ key: "sportBands", include: ["beginner"] })]),
    );
    expect(read("Intermediate mountain bike trails near Bentonville").filters).toContainEqual(expect.objectContaining({ layerId: "mtb-trails", key: "level", include: ["intermediate"] }));
    expect(read("Show hiking trails around Lake Tahoe").filters).toEqual([]);
    expect(read("Are the fires near Missoula contained?").filters).toEqual([]);
    expect(read("Which crags near Moab are sport and shaded in the afternoon?").filters.map((f) => f.key)).toEqual(["disciplines"]);
  });

  it("spells out a river named short", () => {
    expect(riverNames("Is the Madison fishing well right now?")).toEqual([{ written: "the Madison", place: "Madison River" }]);
    expect(riverNames("Is the Gauley running right now?")).toEqual([{ written: "the Gauley", place: "Gauley River" }]);
    expect(riverNames("Is the French Broad going to flood in Asheville?")).toEqual([{ written: "the French Broad", place: "French Broad River" }]);
    expect(riverNames("Is the Carson River running high?")).toEqual([]);
    expect(riverNames("Show the Sierra Nevada")).toEqual([]);
  });

  it("asks for the change view when the question asks what changed", () => {
    expect(read("Show my class how the glaciers in Glacier National Park have shrunk").change).toBe(true);
    expect(read("Glaciers in the Wind River Range").change).toBe(false);
  });
});

describe("species, trout water and layers still to come", () => {
  it("names the species the question asks about", async () => {
    const { taxonOf } = await import("@/lib/agent/reading");
    expect(taxonOf("Best place to see sandhill cranes in Nebraska in March")).toBe("sandhill cranes");
    expect(taxonOf("Where can I see moose near Jackson Hole?")).toBe("moose");
    expect(taxonOf("Where have bald eagles been seen near Seattle lately?")).toBe("bald eagles");
    expect(taxonOf("Climbing crags near Red River Gorge")).toBeNull();
  });

  it("keeps trout water under 64 °F, and asks the avalanche center, not weather warnings, for avalanche danger", () => {
    expect(readQuestion("Trout streams near Denver that aren't too warm", NOW).filters).toContainEqual(expect.objectContaining({ layerId: "fishing", key: "tempBand", include: ["cold", "good"] }));
    const avalanche = readQuestion("Avalanche danger near Stevens Pass today", NOW);
    expect(avalanche.layers.map((l) => l.layerId)).toContain("avalanche");
    expect(avalanche.avoid.map((a) => a.layerId)).toContain("weather-alerts");
  });
});

describe("readingForPrompt", () => {
  it("writes one short block with the layers, filters, inputs and time", () => {
    const text = readingForPrompt(readQuestion("How much has Lake Powell dropped since 2000?", NOW), NOW);
    expect(text).toContain("Reading of this question");
    expect(text).toContain('"since 2000" means 2000-01-01 to today; inputs: reservoir-levels {"years":27}');
    expect(readingForPrompt(readQuestion("How has Arctic sea ice changed since 2012?", NOW), NOW)).toContain("query sea-ice with date 2012-10-23 and again for the newest day, then call compare");
    expect(readingForPrompt(readQuestion("Outline the Sierra Nevada", NOW), NOW)).toBe("");
  });
});
