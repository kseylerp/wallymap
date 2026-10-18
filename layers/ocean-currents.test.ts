import { describe, expect, it } from "vitest";
import { displayOf, legendOf, legendProblems, timeShapeOf } from "./contract";
import layer, { LEGEND } from "./ocean-currents";

describe("ocean-currents", () => {
  it("keys what the particles draw: color is water temperature, brightness is speed", () => {
    expect(legendOf(layer)).toBe(LEGEND);
    expect(legendProblems(LEGEND, "ocean-currents")).toEqual([]);
    expect(LEGEND).toMatchObject({ kind: "ramp", field: "sst", unit: "°C" });
    expect(LEGEND.note).toMatch(/brighter, longer streaks are faster/);
    expect(layer.style.encode).toEqual({ size: "speed", color: "sst" });
  });

  it("steps hourly and reads in metric first (a global model)", () => {
    expect(timeShapeOf(layer)).toEqual({ shape: "continuous", step: "hour" });
    expect(displayOf(layer).units).toBe("metric");
  });
});
