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
