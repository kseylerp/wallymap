import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import layer, { WDPA_TILE_URL } from "./protected-areas-world";

const WORLD: [number, number, number, number] = [-179, -60, 179, 80];

function ctx(stub: ReturnType<typeof vi.fn>) {
  return { bbox: WORLD, zoom: 3, env: {}, fetch: stub as unknown as CachedFetch };
}

describe("protected-areas-world layer", () => {
  it("builds the verified MapServer export tile template for both sublayers", () => {
    expect(WDPA_TILE_URL).toBe(
      "https://data-gis.unep-wcmc.org/server/rest/services/ProtectedSites/The_World_Database_of_Protected_Areas/MapServer/export" +
        "?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&f=image&transparent=true&layers=show:0,1",
    );
  });

  it("declares global coverage and a non-commercial license, with no env", () => {
    expect(layer.id).toBe("protected-areas-world");
    expect(layer.coverage).toBe("global");
    expect(layer.license).toMatch(/non-commercial/i);
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
    expect(layer.input.parse({})).toEqual({});
  });

  it("returns a raster tiles result without calling upstream, and says it is non-commercial", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub), {});
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.data).toMatchObject({ format: "raster", minzoom: 3, maxzoom: 14, tileSize: 256, url: WDPA_TILE_URL });
    expect(r.data.time).toBeUndefined();
    expect(r.citation.source).toMatch(/non-commercial/i);
    expect(r.citation.source).toContain("UNEP-WCMC");
    expect(r.coverageNote).toMatch(/non-commercial/i);
  });

  it("summarizes to the tile URL and the licence note for the model", async () => {
    const summary = summarizeLayerResult(await layer.query(ctx(vi.fn()), {}));
    expect(summary).toMatchObject({ kind: "tiles", format: "raster", url: WDPA_TILE_URL });
    expect(summary).toHaveProperty("coverageNote", expect.stringMatching(/non-commercial/i));
  });

  it("runs through runLayer at world scale", async () => {
    const r = await runLayer("protected-areas-world", { bbox: WORLD, zoom: 3 });
    expect(r.status).toBe(200);
  });

  it("describes protection in the words people use and warns about the licence and the picture-only output", () => {
    expect(layer.description).toMatch(/protected/i);
    expect(layer.description).toMatch(/non-commercial/i);
    expect(layer.description).toMatch(/not features you can list/i);
  });
});
