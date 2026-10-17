import { describe, expect, it } from "vitest";
import { naturalName, withNaturalName } from "./names";

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
