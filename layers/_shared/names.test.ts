import { describe, expect, it } from "vitest";
import { displayName, isAcronymName, isAllCaps, naturalName, titleCase, withDisplayName, withNaturalName } from "./names";

describe("naturalName", () => {
  it("puts a trailing article back in front", () => {
    expect(naturalName("Oasis, The")).toBe("The Oasis");
    expect(naturalName("Narrows, the")).toBe("The Narrows");
    expect(naturalName("Wall of Tears, A ")).toBe("A Wall of Tears");
    expect(naturalName("Overhang, An")).toBe("An Overhang");
    expect(naturalName("Battery, THE")).toBe("The Battery");
  });

  it("leaves every other name as it is", () => {
    for (const name of ["The Oasis", "Lake Tahoe, CA", "Smith, John", "Thea", "Crag, Theatre", ", The", "Anvil"]) expect(naturalName(name)).toBe(name);
  });

  it("reads a feature's name and leaves the rest", () => {
    expect(withNaturalName({ name: "Oasis, The", kind: "crag" })).toEqual({ name: "The Oasis", kind: "crag" });
    const same = { name: "Red River Gorge" };
    expect(withNaturalName(same)).toBe(same);
    expect(withNaturalName(null)).toBeNull();
  });
});

describe("displayName", () => {
  it("writes names in capitals in ordinary capitals, keeping roman numerals and acronyms", () => {
    expect(displayName("BERNARDO", "glaciers")).toBe("Bernardo");
    expect(displayName("PIO XI", "glaciers")).toBe("Pio XI");
    expect(displayName("JORGE MONTT", "glaciers")).toBe("Jorge Montt");
    expect(displayName("O´HIGGINS", "glaciers")).toBe("O'Higgins");
    expect(displayName("LAGO DE LOS TRES")).toBe("Lago de los Tres");
    expect(displayName("MT. ST. HELENS")).toBe("Mount St. Helens");
    expect(displayName("BLM CAMPGROUND")).toBe("BLM Campground");
    expect(displayName("MCDONALD CREEK")).toBe("McDonald Creek");
    expect(titleCase("BLM")).toBe("BLM");
    expect(titleCase("Pío XI")).toBe("Pío XI");
  });

  it("spells out a source's abbreviations in the layers that use them", () => {
    expect(displayName("Gl. Upsala", "glaciers")).toBe("Upsala Glacier");
    expect(displayName("GL. VIEDMA", "glaciers")).toBe("Viedma Glacier");
    expect(displayName("Gl. Upsala", "peaks")).toBe("Gl. Upsala");
    expect(displayName("Lake Jb Thomas Dam", "dams")).toBe("Lake J.B. Thomas Dam");
    expect(displayName("Mt. Hood")).toBe("Mount Hood");
    expect(displayName("Pikes Pk")).toBe("Pikes Peak");
    expect(displayName("Bear Cr. Res.")).toBe("Bear Creek Reservoir");
    expect(displayName("L. Tahoe", "lakes")).toBe("Lake Tahoe");
    expect(displayName("John L. Smith Dam", "dams")).toBe("John L. Smith Dam");
    expect(displayName("Granby Dike 4", "dams")).toBe("Granby Dike 4");
    expect(displayName("St Mary Lake", "lakes")).toBe("St Mary Lake");
  });

  it("keeps the source's spelling as nameInSource when the name changed", () => {
    expect(withDisplayName({ name: "PIO XI", v: 1 }, "glaciers")).toEqual({ name: "Pio XI", nameInSource: "PIO XI", v: 1 });
    const same = { name: "Hoover Dam" };
    expect(withDisplayName(same, "dams")).toBe(same);
    expect(withDisplayName({ name: " Hoover Dam " }, "dams")).toEqual({ name: "Hoover Dam" });
  });

  it("tells a name in capitals from an acronym", () => {
    expect(isAllCaps("TEMPANO")).toBe(true);
    expect(isAllCaps("KOA")).toBe(false);
    expect(isAllCaps("Upsala Glacier")).toBe(false);
    expect(isAcronymName("BLM NWR")).toBe(true);
    expect(isAcronymName("PIO XI")).toBe(false);
  });
});
