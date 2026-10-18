import { describe, expect, it } from "vitest";
import type { Feature } from "geojson";
import { fieldWords, isRawLabel, moreFilterFields, sameValues } from "@/lib/render/moreFields";

const plant = (v: number, mw: number, nameplateMw: number, kw: number): Feature => ({ type: "Feature", geometry: null as never, properties: { v, mw, nameplateMw, kw } });

describe("More filters fields (owner, 2026-10-18: power plants showed Capacity, Mw and Nameplate mw)", () => {
  const rows: [number, number][] = [[3937, 4209.6], [32.5, 32.5], [1632.8, 1779.2], [1312, 1312], [1286, 1326], [1070, 1070], [1042.9, 1277.1], [1039.7, 1039.4], [620, 640], [410, 455]];
  const data = { type: "FeatureCollection" as const, features: rows.map(([v, n]) => plant(v, v, n, v * 1000)) };
  const layer = { attributes: [{ key: "v", type: "measure" as const, label: "Capacity", unit: "MW" }], style: { unit: "MW" }, fieldHelp: { nameplateMw: { text: "Nameplate capacity.", unit: "MW" } } };

  it("drops a field equal to, or a unit conversion of, a declared attribute, and words the rest with their unit", () => {
    expect(sameValues(data.features, "mw", "v")).toBe(true);
    expect(sameValues(data.features, "kw", "v")).toBe(true);
    expect(sameValues(data.features, "nameplateMw", "v")).toBe(false);
    const fields = moreFilterFields(layer, data);
    expect(fields.map((f) => [f.key, f.label, f.kind === "range" ? f.unit : undefined])).toEqual([["nameplateMw", "Nameplate capacity", "MW"]]);
  });

  it("never labels a control with a raw key", () => {
    for (const raw of ["Mw", "mw", "nameplate_mw", "nameplateMw", ""]) expect(isRawLabel(raw), raw).toBe(true);
    expect(isRawLabel("Nameplate capacity")).toBe(false);
    expect(fieldWords("lengthKm")).toEqual({ label: "Length", unit: "km" });
  });
});
