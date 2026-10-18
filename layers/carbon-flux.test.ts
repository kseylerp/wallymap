import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { compactDescription } from "@/lib/agent/tools";
import layer, { carbonTileUrl } from "./carbon-flux";
import { contractProblems, legendOf, timeShapeOf } from "./contract";

const AMAZON: [number, number, number, number] = [-64, -12, -58, -8];

async function tiles(input: Record<string, unknown>) {
  const stub = vi.fn();
  const r = await layer.query({ bbox: AMAZON, zoom: 6, env: {}, fetch: stub as unknown as CachedFetch }, layer.input.parse(input));
  expect(stub).not.toHaveBeenCalled();
  if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
  return r;
}

describe("carbon-flux", () => {
  it("defaults to net flux at 30% canopy, 256 px raster tiles", async () => {
    const r = await tiles({});
    expect(r.data).toEqual({
      url: "https://tiles.globalforestwatch.org/gfw_forest_carbon_net_flux/latest/dynamic/{z}/{x}/{y}.png?tree_cover_density_threshold=30",
      minzoom: 2,
      maxzoom: 12,
      format: "raster",
    });
    expect(r.data.tileSize).toBeUndefined();
    expect(r.citation.source).toContain("CC BY 4.0");
    expect(r.coverageNote).toContain("2001-2025");
  });

  it("switches dataset with product", async () => {
    expect((await tiles({ product: "emissions" })).data.url).toContain("/gfw_forest_carbon_gross_emissions/latest/");
    expect((await tiles({ product: "removals" })).data.url).toContain("/gfw_forest_carbon_gross_removals/latest/");
    expect(carbonTileUrl("net-flux")).toContain("tree_cover_density_threshold=30");
    expect(layer.input.safeParse({ product: "co2" }).success).toBe(false);
  });

  it("tells the model the unit, sink versus source and that it is tiles", () => {
    for (const word of ["CO2 equivalent per hectare per year", "sink", "source", "map tiles", "carbon"]) {
      expect(layer.description).toContain(word);
    }
    expect(layer.license).toContain("CC BY 4.0");
    expect(compactDescription(layer.description, { inputs: ["product"] })).toContain("'net-flux' (default)");
  });

  it("keys source purple to sink green, one 2001-2025 average, and lifts the pale sinks (audit 2026-10-17: grey haze, no key)", () => {
    expect(contractProblems(layer)).toEqual([]);
    const legend = legendOf(layer);
    expect(legend).toMatchObject({ kind: "ramp", unit: "Mg CO₂e per hectare per year" });
    expect(legend.stops?.map((s) => s.color)).toEqual(["#7B3B7F", "#E9E7DD", "#9EC09F"]);
    expect(timeShapeOf(layer).shape).toBe("single");
    expect(layer.style.raster).toMatchObject({ saturation: 0.4, contrast: 0.25 });
  });
});
