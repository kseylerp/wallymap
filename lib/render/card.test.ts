import { describe, expect, it } from "vitest";
import { factValue } from "./card";

describe("factValue km", () => {
  it("keeps one decimal at any length, so a full length never reads shorter than the length in view (207.1, not 207)", () => {
    expect(factValue({ key: "distanceKm", label: "Full length", format: "km" }, { distanceKm: 207.1 })).toBe("207.1 km");
    expect(factValue({ key: "distanceKm", label: "Full length", format: "km" }, { distanceKm: 12 })).toBe("12 km");
    expect(factValue({ key: "distanceKm", label: "Full length", format: "km" }, { distanceKm: 4265.04 })).toBe("4,265 km");
  });
});
