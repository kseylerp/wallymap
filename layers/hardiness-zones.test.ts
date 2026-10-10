import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import layer, { HARDINESS_SOURCE_LAYER, HARDINESS_TILE_URL } from "./hardiness-zones";

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

  it("tells the model it cannot read a zone from the tiles and where to look one up", () => {
    expect(layer.description).toMatch(/cannot read a place's zone/);
    expect(layer.description).toMatch(/backdrop/);
    expect(layer.description).toMatch(/one tint/);
    expect(layer.description).not.toMatch(/Use it for 'what hardiness zone am I in'/);
    expect(layer.description).toMatch(/planthardiness\.ars\.usda\.gov/);
    expect(layer.description).toMatch(/3a/);
    expect(layer.description).toMatch(/Lower 48/);
  });
});
