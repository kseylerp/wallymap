import { describe, expect, it } from "vitest";
import "@/layers";
import type { BBox } from "@/layers/types";
import type { GeocodeResult } from "@/lib/agent/geocode";
import { applyReading, matchingQuestion, withReading, type GuardCall } from "@/lib/agent/readingGuard";
import { decideStep } from "@/lib/agent/stepGuard";
import { createTurn } from "@/lib/agent/turn";
import { combineOf } from "@/lib/agent/reading";

const NOW = new Date("2026-10-23T18:00:00Z");
const SEDONA: BBox = [-112.14, 34.71, -111.66, 35.04];
const call = (toolName: string, input: Record<string, unknown>, id = toolName): GuardCall => ({ toolCallId: id, toolName, input });
const sedona: GeocodeResult = { bbox: SEDONA, center: [-111.76, 34.87], name: "Sedona, Arizona", source: "mapbox" };
const turnFor = (question: string) => createTurn({ question, now: NOW, geocoder: async () => sedona });

describe("applyReading", () => {
  it("drops river flow for flowy blue trails and queries mountain bike trails on the same box", () => {
    const turn = turnFor("Flowy blue trails in Sedona");
    const out = applyReading([call("query_river-pulse", { bbox: SEDONA, days: 92 })], turn, false);
    expect(out.calls.map((c) => c.toolName)).toEqual(["query_mtb-trails"]);
    expect(out.calls[0].input.bbox).toEqual(SEDONA);
    expect(out.rejected[0].reason).toContain("mtb-trails does");
    // Once per turn.
    expect(applyReading([call("query_streamflow", { bbox: SEDONA })], turn, false).calls).toEqual([]);
  });

  it("does not add a layer the model answered with another, or one the box is too wide for", () => {
    const costaRica: BBox = [-87.2, 5.4, -82.51, 11.22];
    const turn = turnFor("Jaguar records in Costa Rica outside protected areas");
    // GBIF answers for sightings; and Costa Rica is over the sightings layer's limit anyway.
    expect(applyReading([call("query_gbif-occurrences", { bbox: costaRica, scientificName: "Panthera onca" })], turn, false).calls.map((c) => c.toolName)).toEqual(["query_gbif-occurrences"]);
    expect(applyReading([call("query_protected-areas-world", { bbox: costaRica })], turnFor("Jaguar records in Costa Rica"), false).calls.map((c) => c.toolName)).toEqual(["query_protected-areas-world"]);
  });

  it("sends back a GBIF query with no species when the question names one, and gives sightings the species", () => {
    const turn = turnFor("Best place to see sandhill cranes in Nebraska in March");
    const out = applyReading([call("query_gbif-occurrences", { bbox: SEDONA, density: true }), call("query_species", { bbox: SEDONA })], turn, false);
    expect(out.rejected[0].reason).toContain("scientificName set to the Latin name of sandhill cranes");
    expect(out.calls.find((c) => c.toolName === "query_species")?.input.taxon).toBe("sandhill cranes");
    expect(applyReading([call("query_gbif-occurrences", { bbox: SEDONA, scientificName: "Grus canadensis" })], turn, false).rejected).toEqual([]);
  });

  it("sets the time inputs the question's phrase means", () => {
    const turn = turnFor("How much has Lake Powell dropped since 2000?");
    const out = applyReading([call("query_reservoir-levels", { bbox: SEDONA, years: 5, name: "Lake Powell" })], turn, false);
    expect(out.calls[0].input).toMatchObject({ years: 27, name: "Lake Powell" });
    expect(turn.log.join(" ")).toContain('years 5 → 27 ("since 2000")');
    const methane = applyReading([call("query_methane-plumes", { bbox: SEDONA, days: 730 })], turnFor("Biggest methane leaks in the Permian this year"), false);
    expect(methane.calls[0].input.days).toBe(296);
  });

  it("asks campsites without parking lots for a backpacker", () => {
    const turn = turnFor("Backpacking in the Wind Rivers: where are the water sources and campsites?");
    const out = applyReading([call("query_campsites", { bbox: SEDONA, includeParking: true, backcountryOnly: true })], turn, false);
    expect(out.calls.find((c) => c.toolName === "query_campsites")?.input.includeParking).toBe(false);
    // And the water layers the words name.
    expect(out.calls.map((c) => c.toolName)).toEqual(expect.arrayContaining(["query_outdoor-features", "query_lakes"]));
  });

  it("looks up the river a short name means", () => {
    const turn = turnFor("Is the Madison fishing well right now?");
    const out = applyReading([call("geocode", { place: "Madison fishing well" })], turn, false);
    expect(out.calls[0].input.place).toBe("Madison River");
    expect(applyReading([call("geocode", { place: "Madison River, Montana" })], turn, false).calls[0].input.place).toBe("Madison River, Montana");
  });

  it("turns a render of a layer never queried into its query", () => {
    const turn = turnFor("Which protected areas in Borneo lost the most forest?");
    turn.place = { ...sedona, name: "Borneo" };
    const out = applyReading([call("render", { layerId: "forest-loss" })], turn, false);
    expect(out.calls).toEqual([expect.objectContaining({ toolName: "query_forest-loss", input: expect.objectContaining({ bbox: SEDONA }) })]);
    // In the last two steps there is no room to query: the render is dropped with a reason.
    const late = applyReading([call("render", { layerId: "popularity" })], turnFor("Good day hikes near Boulder"), true);
    expect(late.calls).toEqual([]);
    expect(late.rejected[0].reason).toContain("was not queried this turn");
  });
});

describe("decideStep with the reading", () => {
  it("holds a note back while the question's layers are queried", async () => {
    const turn = turnFor("Flowy blue trails in Sedona");
    turn.place = sedona;
    const decision = await decideStep({ calls: [call("query_streamflow", { bbox: SEDONA }), call("note", { markdown: "Rivers." })], hasText: false }, turn, ["query_streamflow", "query_mtb-trails", "note", "render"]);
    expect(decision.calls.map((c) => c.toolName)).toEqual(["query_mtb-trails"]);
    expect(decision.dropText).toBe(true);
  });
});

describe("the combine tool (merging from the spatial branch)", () => {
  it("reads the relation a question asks between two layers", () => {
    expect(combineOf("Jaguar records in Costa Rica outside protected areas")).toMatchObject({ op: "outside" });
    expect(combineOf("Old-growth forest in Oregon that isn't in wilderness")).toMatchObject({ op: "outside" });
    expect(combineOf("Wild horse areas in Nevada that are in drought right now")).toMatchObject({ op: "overlap" });
    expect(combineOf("Where can I camp along the Wonderland Trail?")).toMatchObject({ op: "along", match: "Wonderland Trail" });
    expect(combineOf("Campsites within 2 miles of a lake near Bishop")).toMatchObject({ op: "near", distance: 2, unit: "mi" });
    expect(combineOf("Trailheads within 30 minutes' drive of Bend")).toMatchObject({ op: "drive_time", minutes: 30 });
    expect(combineOf("Trails near Boulder")).toBeNull();
    expect(combineOf("Is there flooding along the Zambezi right now?")).toBeNull();
  });

  it("holds the note back once until combine is called, when the tool exists", async () => {
    const turn = turnFor("Wild horse areas in Nevada that are in drought right now");
    turn.place = sedona;
    turn.queries.push(
      { layerId: "grazing-allotments", bbox: SEDONA, inputKey: "[]", ok: true, drawable: true, wide: false },
      { layerId: "drought", bbox: SEDONA, inputKey: "[]", ok: true, drawable: true, wide: false },
    );
    turn.drawn.add("grazing-allotments").add("drought");
    const tools = ["note", "render", "combine", "query_grazing-allotments", "query_drought"];
    const held = await decideStep({ calls: [call("note", { markdown: "Herds and drought are drawn." })], hasText: false }, turn, tools);
    expect(held.calls).toEqual([]);
    expect(held.rejected[0].reason).toContain('Call combine with op "overlap", a grazing-allotments, b drought');
    // Once only; and never without the tool.
    expect((await decideStep({ calls: [call("note", { markdown: "Herds and drought are drawn." })], hasText: false }, turn, tools)).calls.map((c) => c.toolName)).toEqual(["note"]);
    const without = turnFor("Wild horse areas in Nevada that are in drought right now");
    without.queries.push(...turn.queries);
    without.drawn.add("grazing-allotments").add("drought");
    expect((await decideStep({ calls: [call("note", { markdown: "x" })], hasText: false }, without, ["note", "render"])).calls.map((c) => c.toolName)).toEqual(["note"]);
  });
});

describe("matchingQuestion", () => {
  it("lists the features that pass the question's filters, top first by the measure asked", () => {
    const hike = (name: string, lengthKm: number, kind = "path") => ({ type: "Feature", geometry: null, properties: { name, lengthKm, kind, roundTripKm: lengthKm * 2 } });
    const body = { kind: "geojson", data: { type: "FeatureCollection", features: [hike("Royal Arch Trail", 2.1), hike("Mesa Trail", 10.1), hike("Mount Sanitas Trail", 3.4), hike("Pierson Park Road", 4, "track")] } };
    const turn = turnFor("Good day hikes near Boulder under 5 miles");
    expect(matchingQuestion(body, "osm-trails", turn)).toEqual({
      filters: { kind: { include: ["path", "footway"] }, lengthKm: { range: [0, 8.05] } },
      count: 2,
      rankedBy: "lengthKm",
      top: [
        { name: "Mount Sanitas Trail", lengthKm: 3.4, roundTripKm: 6.8, kind: "path" },
        { name: "Royal Arch Trail", lengthKm: 2.1, roundTripKm: 4.2, kind: "path" },
      ],
    });
    expect(matchingQuestion(body, "osm-trails", turnFor("Show hiking trails around Lake Tahoe"))).toBeNull();
  });
});

describe("withReading", () => {
  it("puts the trail color's filter in place of another difficulty scale on the same layer", () => {
    const turn = turnFor("Flowy blue trails in Sedona");
    turn.place = sedona;
    expect(withReading({ layerId: "mtb-trails", filters: { v: { include: ["2"] } } }, turn)).toMatchObject({ filters: { imba: { include: ["2"] } } });
    expect((withReading({ layerId: "mtb-trails", filters: { v: { include: ["2"] } } }, turn).filters as Record<string, unknown>).v).toBeUndefined();
  });

  it("adds the filters the question names that the model left out, and keeps the model's own", () => {
    const turn = turnFor("Beginner sport climbing at Red Rock near Las Vegas");
    expect(withReading({ layerId: "climbing" }, turn)).toMatchObject({ filters: { disciplines: { include: ["sport"] }, gradeBands: { include: ["beginner"] } } });
    expect(withReading({ layerId: "climbing", filters: { disciplines: { include: ["trad"] } } }, turn)).toMatchObject({ filters: { disciplines: { include: ["trad"] } } });
  });

  it("draws a snapshot layer in the change view when the question asks what changed", () => {
    const turn = turnFor("Show my class how the glaciers in Glacier National Park have shrunk");
    expect(withReading({ layerId: "glaciers", view: "detail" }, turn).view).toBe("change");
  });
});
