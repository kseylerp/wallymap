import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { compactDescription } from "@/lib/agent/tools";
import layer, { slrTileUrl } from "./sea-level-rise";

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
    });
    expect(r.data.time).toBeUndefined();
    expect(r.coverageNote).toContain("3 ft");
  });

  it("takes whole feet 0 to 10", async () => {
    expect(slrTileUrl(0)).toContain("/slr_0ft/");
    const r = await layer.query(ctx(vi.fn()), layer.input.parse({ feet: 10 }));
    expect(r).toMatchObject({ data: { url: expect.stringContaining("/slr_10ft/") } });
    expect(layer.input.safeParse({ feet: 11 }).success).toBe(false);
    expect(layer.input.safeParse({ feet: 1.5 }).success).toBe(false);
  });

  it("returns nothing outside the US", async () => {
    const r = await layer.query(ctx(vi.fn(), [2, 51, 4, 53]), layer.input.parse({}));
    expect(r).toMatchObject({ kind: "geojson", coverageNote: "No data outside the United States" });
  });

  it("tells the model about MHHW, 2050, scenarios and that compare cannot switch feet", () => {
    for (const word of ["feet", "MHHW", "2050", "map tiles", "compare", "sea level rise", "flooding by 2050"]) {
      expect(layer.description).toContain(word);
    }
    const trimmed = compactDescription(layer.description, { inputs: ["feet"] });
    expect(trimmed).toContain("feet (0 to 10, default 3)");
    expect(trimmed).toContain("compare");
  });
});
