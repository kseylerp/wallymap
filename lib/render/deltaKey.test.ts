import { describe, expect, it } from "vitest";
import { deltaKey } from "@/lib/render/compareView";
import { DELTA_COLORS } from "@/lib/render/palette";
import type { LoadedLayer } from "@/lib/render/state";

const layer = (geometry: "polygon" | "point", changeNoun?: string): LoadedLayer =>
  ({
    id: "glaciers",
    title: "Glaciers",
    style: { geometry, color: "#5E4B8B" },
    result: { kind: "geojson", data: { type: "FeatureCollection", features: [] }, citation: { source: "GLIMS", url: "", retrieved: "" } },
    receivedAt: "",
    time: { shape: "snapshots", ...(changeNoun && { changeNoun }) },
  }) as LoadedLayer;

describe("deltaKey", () => {
  it("says what a matched area lost, kept and gained, in three plain items with the edge explained (glaciers on a phone)", () => {
    const key = deltaKey(layer("polygon", "Ice"), "the 1960s", "the 2010s", { aOnly: 3, bOnly: 0, both: 120 });
    expect(key.map((e) => e.label)).toEqual(["Ice lost since the 1960s (pink; the pink line is its edge then)", "Ice in the 2010s"]);
    // With the lost ground measured, the key states it (US layers in mi² first).
    const measured = deltaKey(layer("polygon", "Ice"), "the 1960s", "the 2010s", { aOnly: 3, bOnly: 0, both: 120, lostKm2: 20.5 });
    expect(measured[0].label).toBe("Ice lost since the 1960s, 20.5 km² (pink; the pink line is its edge then)");
    expect(key.map((e) => e.color)).toEqual([DELTA_COLORS["a-only"], DELTA_COLORS.both]);
    const gained = deltaKey(layer("polygon", "Ice"), "the 1960s", "the 2010s", { aOnly: 3, bOnly: 2, both: 120 });
    expect(gained[2]).toEqual({ label: "New ice since the 1960s", color: DELTA_COLORS["b-only"] });
  });

  it("reads Area without a noun, and Only in / In both for points", () => {
    expect(deltaKey(layer("polygon"), "2021", "2026", null)[0].label).toMatch(/^Area lost since 2021/);
    expect(deltaKey(layer("point"), "2021", "2026", null).map((e) => e.label)).toEqual(["Only in 2021", "In both", "Only in 2026"]);
  });
});
