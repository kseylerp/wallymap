import { describe, expect, it } from "vitest";
import { formatValue, isYearLike } from "@/lib/format";
import { filterSummary, formatFilterNumber, type FilterField } from "@/lib/render/filters";
import { summarizeFeature } from "@/lib/render/inspect";
import { measureLabel } from "@/components/LayerStack";

describe("formatValue", () => {
  it("leaves years and dates without separators", () => {
    expect(formatValue("year", 2026)).toBe("2026");
    expect(formatValue("yearCompleted", 1931)).toBe("1931");
    expect(formatValue("start_year", 2016)).toBe("2016");
    expect(formatValue("t", 2024)).toBe("2024");
    expect(formatValue("v", 2026, "year")).toBe("2026");
  });
  it("keeps grouping for everything else", () => {
    expect(formatValue("acres", 2026)).toBe("2,026");
    expect(formatValue("v", 1234567)).toBe("1,234,567");
    expect(formatValue("acres", 12.3456)).toBe("12.35");
    expect(isYearLike("acres")).toBe(false);
  });
});

describe("year readouts", () => {
  const fields: FilterField[] = [{ key: "year", label: "Year", kind: "range", min: 2000, max: 2026, integer: true }];
  it("reads a filter summary and a range without commas", () => {
    expect(filterSummary(fields, { year: { range: [2016, 2026] } })).toBe("Year ≥ 2016");
    expect(filterSummary(fields, { year: { range: [2016, 2024] } })).toBe("Year 2016–2024");
    expect(formatFilterNumber(2026, true, "year")).toBe("2026");
    expect(formatFilterNumber(2026, true, "acres")).toBe("2,026");
  });
  it("reads the slider threshold and the inspect stat", () => {
    const range = { min: 1990, max: 2026, integer: true, curve: 1 as const };
    expect(measureLabel(2016, range, undefined, "year")).toBe("≥ 2016");
    expect(measureLabel(2016, { ...range, min: 0 }, "acres", "acres")).toBe("≥ 2,016 acres");
    const feature = { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { v: 2026, year: 2026 } } as const;
    expect(summarizeFeature(feature as never).value?.value).toBe("2026");
  });
});
