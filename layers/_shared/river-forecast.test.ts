import { describe, expect, it } from "vitest";
import { parseGauges } from "./river-forecast";

const gauge = (lid: string, primary: number, secondary: number) => ({
  lid,
  name: lid,
  latitude: 40.1,
  longitude: -105.9,
  status: { observed: { primary, primaryUnit: "ft", secondary, secondaryUnit: "kcfs", floodCategory: "not_defined", validTime: "2026-10-23T15:15:00Z" } },
});

describe("parseGauges", () => {
  it("reads a river's stage and flow, and leaves out a reservoir whose pool elevation and storage NWPS reports as stage and kcfs", () => {
    const gauges = parseGauges({ gauges: [gauge("CBGC2", 1.07, 0.025), gauge("GBYC2", 8234.91, 261)] });
    expect(gauges.find((g) => g.lid === "CBGC2")?.observed).toMatchObject({ stageFt: 1.07, flowCfs: 25 });
    expect(gauges.find((g) => g.lid === "GBYC2")?.observed).toBeUndefined();
  });
});
