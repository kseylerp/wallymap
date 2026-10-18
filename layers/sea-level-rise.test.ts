import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { compactDescription } from "@/lib/agent/tools";
import { loadedScenarioValue, scenarioTileUrl } from "@/lib/render/scenario";
import { displayOf, legendOf } from "./contract";
import layer, { SLR_LEGEND, SLR_SCENARIO, slrTileUrl } from "./sea-level-rise";

const MIAMI: [number, number, number, number] = [-80.35, 25.65, -80.1, 25.9];

function ctx(stub: ReturnType<typeof vi.fn>, bbox = MIAMI) {
  return { bbox, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch };
}

describe("sea-level-rise", () => {
  it("defaults to 3 ft and builds the pre-tiled NOAA URL without calling upstream", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub), layer.input.parse({}));
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.data).toEqual({
      url: "https://coast.noaa.gov/arcgis/rest/services/dc_slr/slr_3ft/MapServer/tile/{z}/{y}/{x}",
      minzoom: 0,
      maxzoom: 16,
      format: "raster",
      scenario: SLR_SCENARIO,
    });
    expect(r.data.time).toBeUndefined();
    expect(loadedScenarioValue(r)).toBe(3);
    expect(r.coverageNote).toContain("3 ft");
  });

  it("takes whole feet 0 to 10", async () => {
    expect(slrTileUrl(0)).toContain("/slr_0ft/");
    const r = await layer.query(ctx(vi.fn()), layer.input.parse({ feet: 10 }));
    expect(r).toMatchObject({ data: { url: expect.stringContaining("/slr_10ft/") } });
    expect(layer.input.safeParse({ feet: 11 }).success).toBe(false);
    expect(layer.input.safeParse({ feet: 1.5 }).success).toBe(false);
  });

  it("publishes a scenario over every half foot, 0 to 10, mapped to NOAA's service names", () => {
    expect(SLR_SCENARIO).toMatchObject({ param: "feet", label: "Sea level rise", unit: "ft" });
    expect(SLR_SCENARIO.values).toHaveLength(21);
    expect(SLR_SCENARIO.values[0]).toBe(0);
    expect(SLR_SCENARIO.values[20]).toBe(10);
    expect(SLR_SCENARIO.template).toContain("{value}");
    expect(scenarioTileUrl(SLR_SCENARIO, 0)).toBe(slrTileUrl(0));
    expect(scenarioTileUrl(SLR_SCENARIO, 0.5)).toContain("/slr_0_5ft/");
    expect(scenarioTileUrl(SLR_SCENARIO, 9.5)).toContain("/slr_9_5ft/");
    expect(scenarioTileUrl(SLR_SCENARIO, 6)).toBe(slrTileUrl(6));
  });

  it("returns nothing outside the US", async () => {
    const r = await layer.query(ctx(vi.fn(), [2, 51, 4, 53]), layer.input.parse({}));
    expect(r).toMatchObject({ kind: "geojson", coverageNote: "No data outside the United States" });
  });

  it("draws NOAA's colors as served, with a key that names the newly flooded land, and US units", async () => {
    expect(layer.style.raster).toMatchObject({ saturation: 0 });
    expect(legendOf(layer)).toBe(SLR_LEGEND);
    expect(SLR_LEGEND.items?.map((i) => i.color)).toEqual(["#B6EDF0", "#2B90E1", "#090991", "#55FF00"]);
    expect(displayOf(layer).units).toBe("us");
    const r = await layer.query(ctx(vi.fn()), layer.input.parse({}));
    expect(r).toMatchObject({ coverageNote: expect.stringContaining("(pale cyan; navy is today's sea") });
    expect(layer.description).toContain("pale cyan where land newly floods");
    expect(compactDescription(layer.description, { inputs: ["feet"] })).toContain("pale cyan");
  });

  it("tells the model about MHHW, 2050, the scenario scrubber and compare by scenario", () => {
    for (const word of ["feet", "MHHW", "2050", "map tiles", "compare", "scenario", "never re-query", "sea level rise", "flooding by 2050"]) {
      expect(layer.description).toContain(word);
    }
    const trimmed = compactDescription(layer.description, { inputs: ["feet"] });
    expect(trimmed).toContain("feet (0 to 10, default 3)");
    expect(trimmed).toContain("compare");
  });
});
