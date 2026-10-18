import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import { contractProblems, legendOf } from "./contract";
import layer, { FLOOD_ZONES_TILE_URL } from "./flood-zones";

const HOUSTON: [number, number, number, number] = [-95.5, 29.7, -95.3, 29.8];

function ctx(stub: ReturnType<typeof vi.fn>, bbox = HOUSTON) {
  return { bbox, zoom: 14, env: {}, fetch: stub as unknown as CachedFetch };
}

describe("flood-zones layer", () => {
  it("builds the verified MapServer export tile template for the Flood Hazard Zones sublayer", () => {
    expect(FLOOD_ZONES_TILE_URL).toBe(
      "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/export" +
        "?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&f=image&transparent=true&layers=show:28",
    );
  });

  it("declares US coverage, the public domain license and no env or input", () => {
    expect(layer.id).toBe("flood-zones");
    expect(layer.coverage).toBe("us");
    expect(layer.license).toBe("Public domain (FEMA)");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
    expect(layer.input.parse({})).toEqual({});
  });

  it("returns raster tiles that start at zoom 14 (the service draws nothing coarser) without calling upstream", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub), {});
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.data).toMatchObject({ format: "raster", minzoom: 14, maxzoom: 18, tileSize: 256, url: FLOOD_ZONES_TILE_URL });
    expect(r.coverageNote).toMatch(/zoom/i);
    expect(r.citation.source).toContain("FEMA");
  });

  it("returns an empty result with a coverage note outside the US", async () => {
    const r = await layer.query(ctx(vi.fn(), [2, 45, 3, 46]), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toEqual([]);
    expect(r.coverageNote).toMatch(/outside the United States/i);
  });

  it("summarizes to the tile URL and the zoom note for the model", async () => {
    const summary = summarizeLayerResult(await layer.query(ctx(vi.fn()), {}));
    expect(summary).toMatchObject({ kind: "tiles", format: "raster", url: FLOOD_ZONES_TILE_URL, minzoom: 14 });
    expect(summary).toHaveProperty("coverageNote", expect.stringMatching(/zoom in/i));
  });

  it("runs through runLayer", async () => {
    expect((await runLayer("flood-zones", { bbox: HOUSTON, zoom: 14 })).status).toBe(200);
  });

  it("describes floodplains in the words people use and says it only appears zoomed in", () => {
    expect(layer.description).toMatch(/floodplain/i);
    expect(layer.description).toMatch(/zoom 14/);
    expect(layer.description).toMatch(/not a forecast/i);
  });

  it("draws FEMA's tiles as served and keys them with the colors FEMA draws", () => {
    expect(layer.style.raster).toBeNull();
    const legend = legendOf(layer);
    expect(legend.kind).toBe("categories");
    expect(legend.items?.[0]).toMatchObject({ color: "#00E5FF", symbol: "raster" });
    expect(legend.items?.map((i) => i.color)).toContain("#FF8100");
    expect(legend.note).toMatch(/zoom 14/);
    expect(contractProblems(layer)).toEqual([]);
  });
});

describe("flood-zones identify (a tap on the tiles)", () => {
  it("names the zone at a point in plain words, with insurance and elevation when FEMA sets them", async () => {
    const { floodZoneFeature, floodZoneTitle } = await import("./flood-zones");
    const f = floodZoneFeature({ lon: -105.28, lat: 40.01 }, { FLD_ZONE: "AE", ZONE_SUBTY: "", SFHA_TF: "T", STATIC_BFE: "5301.2", DEPTH: "-9999", DFIRM_ID: "08013C" });
    expect(f?.properties).toEqual({ name: "1% annual chance flood (100-year)", zone: "AE", insurance: "Usually required (special flood hazard area)", bfeFt: 5301.2, study: "08013C" });
    expect(floodZoneTitle("AE", "FLOODWAY")).toBe("Regulatory floodway (1% annual chance flood)");
    expect(floodZoneTitle("X", "0.2 PCT ANNUAL CHANCE FLOOD HAZARD")).toBe("0.2% annual chance flood (500-year)");
    expect(floodZoneTitle("X", "AREA OF MINIMAL FLOOD HAZARD")).toMatch(/^Minimal flood hazard/);
    expect(floodZoneFeature({ lon: 0, lat: 0 }, {})).toBeNull();
  });
});
