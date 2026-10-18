import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import layer, { HALF_ZONES, HARDINESS_SOURCE_LAYER, HARDINESS_TILE_URL, ZONE_COLORS, zoneLabel } from "./hardiness-zones";
import { contractProblems, legendOf, timeShapeOf } from "./contract";

const DENVER: [number, number, number, number] = [-105.2, 39.5, -104.7, 39.9];

function ctx(bbox = DENVER) {
  const stub = vi.fn();
  return { stub, ctx: { bbox, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch } };
}

describe("hardiness-zones layer", () => {
  it("declares sage polygons, no env, no input and both credits in the license", () => {
    expect(layer.id).toBe("hardiness-zones");
    expect(layer.coverage).toBe("us");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.input.parse({})).toEqual({});
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
    expect(layer.style).toEqual({ geometry: "polygon", color: "#9FB693", fillOpacity: 0.3 });
    expect(layer.license).toBe("USDA-ARS / Oregon State University PRISM; community copy; show both credits");
  });

  it("returns vector tiles with the verified template and source layer, and makes no upstream call", async () => {
    const { stub, ctx: c } = ctx();
    const r = await layer.query(c, {});
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.data).toEqual({
      url: HARDINESS_TILE_URL,
      minzoom: 0,
      maxzoom: 12,
      format: "vector",
      sourceLayer: "phzm_us_zones_shp_2023",
      geometry: "polygon",
    });
    expect(HARDINESS_SOURCE_LAYER).toBe("phzm_us_zones_shp_2023");
    expect(r.data.url).toContain("{z}/{y}/{x}.pbf");
    expect(r.data.url).toContain("rKbpcgHXWYYaP4pQ/arcgis/rest/services/phzm_us_zones_shp_2023_view/VectorTileServer");
    expect(r.coverageNote).toBeUndefined();
  });

  it("credits both USDA and Oregon State and says it is a copy", async () => {
    const { ctx: c } = ctx();
    const r = await layer.query(c, {});
    if ("error" in r) throw new Error("unexpected error");
    expect(r.citation.source).toMatch(/USDA/);
    expect(r.citation.source).toMatch(/Oregon State/);
    expect(r.citation.source).toMatch(/community/);
  });

  it("still returns the tiles, with a note, for a view outside the lower 48", async () => {
    for (const bbox of [[2, 45, 3, 46], [-158, 21, -157, 22], [-150, 61, -149, 62]] as const) {
      const { ctx: c } = ctx([...bbox] as [number, number, number, number]);
      const r = await layer.query(c, {});
      if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
      expect(r.coverageNote).toMatch(/lower 48/);
    }
  });

  it("fills every half-zone in its own color and keys each one with the USDA label and °F band", () => {
    expect(HALF_ZONES).toHaveLength(19);
    expect(new Set(ZONE_COLORS).size).toBe(19);
    for (const c of ZONE_COLORS) expect(c).toMatch(/^#[0-9A-F]{6}$/i);
    // Cold end purple, warm end pink (the approved palette).
    expect(ZONE_COLORS[0].toUpperCase()).toBe("#6E5BFF");
    expect(ZONE_COLORS[18].toUpperCase()).toBe("#F57272");
    expect(zoneLabel("3a")).toBe("Zone 3a (−40 to −35 °F)");
    expect(zoneLabel("7a")).toBe("Zone 7a (0 to 5 °F)");
    expect(zoneLabel("9b")).toBe("Zone 9b (25 to 30 °F)");
    expect(zoneLabel("12a")).toBe("Zone 12a (50 to 55 °F)");
    const legend = legendOf(layer);
    expect(legend).toMatchObject({ kind: "categories", field: "_symbol", unit: "°F" });
    expect(legend.items?.[8]).toEqual({ label: "Zone 7a (0 to 5 °F)", value: 8, color: ZONE_COLORS[8], symbol: "polygon" });
    // The color attribute reads the tile's `_symbol` index with the same labels, and the card spells the index out.
    const attr = layer.attributes?.find((a) => a.key === "_symbol");
    expect(attr).toMatchObject({ type: "category", encode: "color", primary: true });
    expect(attr?.levels?.[0]).toEqual({ value: 0, label: "Zone 3a (−40 to −35 °F)" });
    expect(layer.card?.facts?.[0].values?.["13"]).toBe("Zone 9b (25 to 30 °F)");
    expect(timeShapeOf(layer)).toEqual({ shape: "none" });
    expect(contractProblems(layer)).toEqual([]);
  });

  it("tells the model the zones are colored, not to state a place's zone itself, and where to look one up", () => {
    expect(layer.description).toMatch(/its own color/);
    expect(layer.description).toMatch(/do not state a place's zone yourself/);
    expect(layer.description).not.toMatch(/one tint/);
    expect(layer.description).toMatch(/planthardiness\.ars\.usda\.gov/);
    expect(layer.description).toMatch(/3a/);
    expect(layer.description).toMatch(/Lower 48/);
  });
});
