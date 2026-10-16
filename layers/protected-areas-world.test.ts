import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import layer, { MAX_AREAS, WDPA_POLYGONS, WDPA_TILE_URL, mergeDesignations, normalizeProtectedAreas, simplifyOffset } from "./protected-areas-world";
import guiana from "./__fixtures__/protected-areas-world.guiana.json";
import type { FeatureCollection } from "geojson";

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

  it("describes protection in the words people use and warns about the licence and the picture-only output when wide", () => {
    expect(layer.description).toMatch(/protected/i);
    expect(layer.description).toMatch(/non-commercial/i);
    expect(layer.description).toContain("under 500,000 km² it returns named polygons");
    expect(layer.description).toMatch(/a picture you cannot list, count or name/i);
  });
});

// French Guiana, about 136,000 km²: under the features cap, so the layer returns named polygons.
const GUIANA: [number, number, number, number] = [-54.6, 2.1, -51.6, 5.8];

describe("protected-areas-world named polygons for a region", () => {
  const ctxAt = (stub: ReturnType<typeof vi.fn>) => ({ bbox: GUIANA, zoom: 7, env: {}, fetch: stub as unknown as CachedFetch });

  it("queries the WDPA polygon layer largest first, capped and simplified", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(guiana), { status: 200 }));
    await layer.query(ctxAt(stub), {});
    const url = new URL(String((stub.mock.calls[0] as unknown[])[0]));
    expect(url.origin + url.pathname).toBe(`${WDPA_POLYGONS}/query`);
    expect(url.searchParams.get("orderByFields")).toBe("gis_area DESC");
    expect(url.searchParams.get("resultRecordCount")).toBe(String(MAX_AREAS));
    expect(url.searchParams.get("maxAllowableOffset")).toBe(String(simplifyOffset(GUIANA)));
    expect(url.searchParams.get("outFields")).toContain("desig_eng");
  });

  it("returns named parks with designation, IUCN category and area, largest first, and keeps the licence note", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(guiana), { status: 200 }));
    const r = await layer.query(ctxAt(stub), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const names = r.data.features.map((f) => f.properties?.name);
    expect(names[0]).toBe("Guyane (Parc Amazonien)");
    expect(names).toContain("Guyane (Parc Amazonien) [Aire D'Adhésion]");
    expect(names).not.toContain("No Geometry Reserve");
    expect(r.data.features.find((f) => f.properties?.name === "Nouragues")?.properties).toMatchObject({
      designation: "National Nature Reserve",
      iucn: "IV",
      areaKm2: 1066,
      v: 1066,
      country: "GUF",
    });
    expect(r.coverageNote).toMatch(/^5 protected areas in this region, largest first; .*non-commercial/);
    expect(r.citation.source).toMatch(/non-commercial/i);
  });

  it("leaves out IUCN placeholders and says when the service capped the list", async () => {
    const fc = normalizeProtectedAreas({
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { name: "X", iucn_cat: "Not Reported", gis_area: 2.34 } }],
    } as FeatureCollection);
    expect(fc.features[0].properties).toEqual({ name: "X", areaKm2: 2.3, v: 2.3 });

    const capped = { ...guiana, exceededTransferLimit: true };
    const stub = vi.fn(async () => new Response(JSON.stringify(capped), { status: 200 }));
    const r = await layer.query(ctxAt(stub), {});
    expect(r).toMatchObject({ kind: "geojson", coverageNote: expect.stringMatching(/^The 5 largest protected areas in this region/) });
  });

  it("falls back to the tiles when the service fails", async () => {
    const stub = vi.fn(async () => new Response("down", { status: 500 }));
    const r = await layer.query(ctxAt(stub), {});
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.coverageNote).toMatch(/could not be loaded.*non-commercial/);
  });

  it("summarizes the largest parks by name for the note", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(guiana), { status: 200 }));
    const summary = summarizeLayerResult(await layer.query(ctxAt(stub), {}), "protected-areas-world");
    expect(summary).toHaveProperty("top");
    expect((summary as { top: string[] }).top[0]).toBe("Guyane (Parc Amazonien), National Park - Core Area, 20,218 km² (GUF)");
  });
});

describe("one place under two designations", () => {
  it("draws Väinamere once, listing both EU designations, and keeps a different place of the same name", () => {
    const area = (dx: number, designation: string, v: number): GeoJSON.Feature => ({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [[[22.5 + dx, 58.6], [23.5 + dx, 58.6], [23.5 + dx, 59], [22.5 + dx, 58.6]]] },
      properties: { name: "Väinamere", designation, v },
    });
    const out = mergeDesignations([
      area(0, "Special Protection Area (Birds Directive)", 2732),
      area(0.05, "Special Areas of Conservation (Habitats Directive)", 2539),
      area(5, "Nature Reserve", 12),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].properties?.designation).toBe("Special Protection Area (Birds Directive) · Special Areas of Conservation (Habitats Directive)");
    expect(out[1].properties?.designation).toBe("Nature Reserve");
    // A spelling with and without its accent (Irbes saurums, Irbes šaurums) is one place too.
    const accent = { ...area(0.02, "Baltic Sea Protected Area (HELCOM)", 1724), properties: { name: "Väinaméré", designation: "Baltic Sea Protected Area (HELCOM)", v: 1724 } };
    expect(mergeDesignations([area(0, "Special Protection Area (Birds Directive)", 2732), accent])).toHaveLength(1);
    const dashed = (name: string, designation: string) => ({ ...area(0, designation, 367), properties: { name, designation, v: 367 } });
    expect(mergeDesignations([dashed("Nida-Perkone", "Baltic Sea Protected Area (HELCOM)"), dashed("Nida - Pērkone", "Special Protection Area (Birds Directive)")])).toHaveLength(1);
  });
});
