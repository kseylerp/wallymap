import { describe, expect, it } from "vitest";
import { bandsBetween, climbingBand, orderedBands } from "./bands";

describe("climbing grades on one band set (spec §12c: YDS, UIAA, French and V-scale)", () => {
  it.each([
    ["5.6", undefined, "beginner"],
    ["5.7+", undefined, "beginner"],
    ["5.8", undefined, "intermediate"],
    ["5.10d", undefined, "intermediate"],
    ["5.11a", undefined, "advanced"],
    ["5.12d", undefined, "advanced"],
    ["5.13a", undefined, "elite"],
    ["V0", undefined, "beginner"],
    ["V4", undefined, "intermediate"],
    ["V7", undefined, "advanced"],
    ["V12", undefined, "elite"],
    ["5b", "french", "beginner"],
    ["6a+", "french", "intermediate"],
    ["6c", "french", "advanced"],
    ["7c+", "french", "elite"],
    ["V+", "uiaa", "beginner"],
    ["6+", "uiaa", "intermediate"],
    ["VIII-", "uiaa", "advanced"],
    ["10", "uiaa", "elite"],
  ])("%s (%s) is %s", (grade, system, band) => {
    expect(climbingBand(grade, system)).toBe(band);
  });

  it("reads a range as every band between its ends, in order, and skips grades it cannot read", () => {
    expect(bandsBetween("elite", "intermediate")).toEqual(["intermediate", "advanced", "elite"]);
    expect(orderedBands(["elite", "beginner", "elite"])).toEqual(["beginner", "elite"]);
    expect(climbingBand("WI4", "ice")).toBeUndefined();
  });
});
