import { describe, expect, it } from "vitest";
import "@/layers";
import { withEmptyLayers } from "@/lib/agent/turnAnswer";

const q = (layerId: string, drawable: boolean, ok = true) => ({ layerId, bbox: [0, 0, 1, 1] as [number, number, number, number], inputKey: "[]", ok, drawable, wide: false });

describe("layers that answered with nothing", () => {
  it("are named in one sentence at the end of the note", () => {
    const note = withEmptyLayers("Zion Canyon is mostly Navajo Sandstone, about 180 million years old.", { queries: [q("geology", true), q("faults", false)] });
    expect(note).toMatch(/\n\nQuaternary faults: none mapped in the area asked\.$/);
  });

  it("are left alone when the note already says so, when a later ask drew them, or when the source failed", () => {
    const said = "Zion is Navajo Sandstone, 180 million years old. No Quaternary faults are mapped in the canyon.";
    expect(withEmptyLayers(said, { queries: [q("faults", false)] })).toBe(said);
    expect(withEmptyLayers("A.", { queries: [q("faults", false), q("faults", true)] })).toBe("A.");
    expect(withEmptyLayers("A.", { queries: [q("faults", false, false)] })).toBe("A.");
  });
});

describe("who manages the land, for a camping answer", () => {
  it("ends the note with the two largest units when the note names no manager", async () => {
    const { withLandManagers } = await import("@/lib/agent/turnAnswer");
    const calls = [{ toolName: "query_public-lands", input: {}, output: { coverageNote: "Land here, largest units first: San Isabel National Forest (US Forest Service), Royal Gorge Field Office (Bureau of Land Management), Leadville National Fish Hatchery (US Fish and Wildlife Service); camping in general: national forest land allows dispersed camping" } }];
    expect(withLandManagers("62 campsites in this view.", { question: "Where can I camp around here?", calls })).toBe(
      "62 campsites in this view.\n\nLand here: San Isabel National Forest (US Forest Service) and Royal Gorge Field Office (Bureau of Land Management).",
    );
    expect(withLandManagers("62 campsites on San Isabel National Forest.", { question: "Where can I camp around here?", calls })).toBe("62 campsites on San Isabel National Forest.");
    expect(withLandManagers("12 hikes.", { question: "Good hikes here?", calls })).toBe("12 hikes.");
  });
});

describe("a picture layer the question asks for", () => {
  it("gets one clause from its coverage note when the note never mentions it", async () => {
    const { withAskedPictures } = await import("@/lib/agent/turnAnswer");
    const turn = {
      reading: { layers: [{ layerId: "fire-perimeters", because: "", strong: true }, { layerId: "burn-severity", because: "", strong: true }] },
      calls: [{ toolName: "query_burn-severity", input: {}, output: { kind: "tiles", coverageNote: "MTBS burn severity of large fires in 2024, the lower 48 states: low sage, moderate pink, high purple" } }],
    } as never;
    expect(withAskedPictures("Six fires burned 584,475 acres near Paradise since 2018.", turn)).toMatch(/\n\nMTBS burn severity of large fires in 2024, the lower 48 states: low sage, moderate pink, high purple\.$/);
    expect(withAskedPictures("Burn severity was mostly high.", turn)).toBe("Burn severity was mostly high.");
  });
});

describe("an ask that came back empty beside another ask of the same layer", () => {
  it("says what the source said of it (Big Sur's hidden condor sightings)", () => {
    const turn = {
      queries: [
        { layerId: "species", bbox: [0, 0, 1, 1] as [number, number, number, number], inputKey: "[]", ok: true, drawable: true, wide: false },
        { layerId: "species", bbox: [0, 0, 1, 1] as [number, number, number, number], inputKey: '[["taxon","condor"]]', ok: true, drawable: false, wide: false },
      ],
      calls: [
        { toolName: "query_species", input: {}, output: { kind: "geojson", data: { features: [{}] }, coverageNote: "1,770 sightings" } },
        { toolName: "query_species", input: { taxon: "condor" }, output: { kind: "geojson", data: { features: [] }, coverageNote: "All 67 sightings of California Condor (research grade) here in the last 365 days have hidden (obscured) locations, as iNaturalist does for threatened species, so none are drawn; read as California Condor" } },
      ],
    };
    expect(withEmptyLayers("Condors are present near Big Sur.", turn)).toBe(
      "Condors are present near Big Sur.\n\nAll 67 sightings of California Condor (research grade) here in the last 365 days have hidden (obscured) locations.",
    );
    expect(withEmptyLayers("All 67 condor sightings are hidden.", turn)).toBe("All 67 condor sightings are hidden.");
  });
});
