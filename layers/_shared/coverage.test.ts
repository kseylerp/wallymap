import { describe, expect, it } from "vitest";
import { bboxesDisjoint, outsideUs } from "./coverage";

describe("outsideUs", () => {
  it("is false for boxes that touch the US, Alaska or Hawaii", () => {
    expect(outsideUs([-120.2, 38.85, -120, 39])).toBe(false);
    expect(outsideUs([-150, 61, -149, 62])).toBe(false);
    expect(outsideUs([-158, 21, -157, 22])).toBe(false);
  });

  it("is false for a box that only partly overlaps", () => {
    expect(outsideUs([-70, 40, -60, 45])).toBe(false);
  });

  it("is true for boxes wholly outside", () => {
    expect(outsideUs([2, 48, 3, 49])).toBe(true);
    expect(outsideUs([-60, -10, -50, 0])).toBe(true);
  });
});

describe("bboxesDisjoint", () => {
  it("finds disjoint and overlapping bboxes", () => {
    expect(bboxesDisjoint([0, 0, 1, 1], [2, 2, 3, 3])).toBe(true);
    expect(bboxesDisjoint([0, 0, 2, 2], [1, 1, 3, 3])).toBe(false);
    expect(bboxesDisjoint([0, 0, 1, 1], [1, 0, 2, 1])).toBe(false);
  });
});
