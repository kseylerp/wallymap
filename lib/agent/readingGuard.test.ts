import { describe, expect, it } from "vitest";
import "@/layers";
import type { BBox } from "@/layers/types";
import type { GeocodeResult } from "@/lib/agent/geocode";
import { applyReading, withReading, type GuardCall } from "@/lib/agent/readingGuard";
import { decideStep } from "@/lib/agent/stepGuard";
import { createTurn } from "@/lib/agent/turn";

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
