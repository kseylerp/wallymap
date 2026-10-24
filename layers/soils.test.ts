import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { cardContent } from "@/lib/render/card";
import { attributeProblems } from "./attributes";
import { contractProblems, legendOf } from "./contract";
import layer, { depthText, mapUnitsOf, soilQueries, soilsNote, textureClassOf, TEXTURE_COLORS, unitProperties, wktPolygons } from "./soils";
import fixture from "./__fixtures__/soils.boulder.json";

/** A real Soil Data Access answer for a small box in Boulder (-105.29,40.0 to -105.27,40.015), 2026-10-23: the three queries. */
const BOX: [number, number, number, number] = [-105.29, 40.0, -105.27, 40.015];
type Table = { Table: (string | null)[][] };
const F = fixture as unknown as { polygons: Table; shares: Table; attributes: Table };

function sdaStub() {
  return vi.fn(async (_url: string, init?: { body?: string }) => {
    const query = String(JSON.parse(init?.body ?? "{}").query);
    const body = query.includes("STAsText") ? F.polygons : query.includes("GROUP BY") ? F.shares : F.attributes;
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

function ctx(stub: ReturnType<typeof vi.fn>, bbox = BOX, wide = false) {
  return { bbox, zoom: 13, env: {}, fetch: stub as unknown as CachedFetch, cacheKey: "soils:test", ...(wide && { wide, wideStrategy: layer.wide }) };
}

describe("soils layer", () => {
  it("declares a keyless US polygon layer colored by surface texture, with a clean contract", () => {
    expect(layer.id).toBe("soils");
    expect(layer.coverage).toBe("us");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.license).toContain("Public domain");
    expect(layer.maxAreaKm2).toBe(600);
    expect(layer.style).toMatchObject({ geometry: "polygon", encode: { color: "textureRank" } });
    expect(contractProblems(layer)).toEqual([]);
    expect(attributeProblems(layer)).toEqual([]);
  });

  it("groups SSURGO texture descriptions sand to clay, and names the rest", () => {
    const cases: [string | null, string, number | undefined][] = [
      ["Gravelly sand", "Sand", 0],
      ["Very gravelly loamy coarse sand", "Sand", 0],
      ["Very cobbly sandy loam", "Sandy loam", 1],
      ["Gravelly coarse sandy loam", "Sandy loam", 1],
      ["Loam", "Loam", 2],
      ["Silt loam", "Loam", 2],
      ["Sandy clay loam", "Clay loam", 3],
      ["Silty clay loam", "Clay loam", 3],
      ["Clay", "Clay", 4],
      ["Silty clay", "Clay", 4],
      ["Unweathered bedrock", "Bedrock", undefined],
      ["Slightly decomposed plant material", "Organic", undefined],
      [null, "Not rated", undefined],
    ];
    for (const [t, label, rank] of cases) expect(textureClassOf(t), String(t)).toEqual(rank === undefined ? { label } : { label, rank });
    expect(textureClassOf("Very gravelly loamy sand", "Rock outcrop", "Rock outcrop")).toEqual({ label: "Rock outcrop" });
    expect(textureClassOf(null, "Water", "Water")).toEqual({ label: "Water" });
  });

  it("reads polygons out of WKT, dropping lines and points from a clipped collection", () => {
    expect(wktPolygons("POLYGON ((0 0, 1 0, 1 1, 0 0))")).toEqual([[[[0, 0], [1, 0], [1, 1], [0, 0]]]]);
    expect(wktPolygons("MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)), ((2 2, 3 2, 3 3, 2 2), (2.1 2.1, 2.2 2.1, 2.2 2.2, 2.1 2.1)))")).toHaveLength(2);
    const gc = wktPolygons("GEOMETRYCOLLECTION (LINESTRING (5 5, 6 6), POLYGON ((0 0, 1 0, 1 1, 0 0)), POINT (3 3), MULTIPOLYGON (((2 2, 3 2, 3 3, 2 2))))");
    expect(gc).toHaveLength(2);
    expect(wktPolygons("LINESTRING (0 0, 1 1)")).toEqual([]);
    expect(wktPolygons("POLYGON EMPTY")).toEqual([]);
  });

  it("takes each map unit's main soil and its top mineral horizon", () => {
    const units = mapUnitsOf(F.attributes.Table.slice(1));
    expect(units.get("497567")).toMatchObject({ muname: "Boulder, bouldery-Sylvandale complex, 9 to 45 percent slopes", component: "Boulder", texture: { label: "Loam", rank: 2 }, textureDetail: "Gravelly loam" });
    expect(units.get("3210244")).toMatchObject({ bedrockCm: 28, texture: { label: "Sandy loam" }, hydGroup: "D" });
    expect(unitProperties(units.get("3210244")!)).toMatchObject({ bedrock: "11 in (28 cm)", bedrockIn: 11, hydGroup: "D: high runoff, water soaks in very slowly" });
    // An organic litter layer on top gives way to the mineral horizon under it.
    const litter = mapUnitsOf([
      ["1", "Sanitas", "Well drained", "49", "B", "Sanitas", "55", "Slightly decomposed plant material", "0"],
      ["1", "Sanitas", "Well drained", "49", "B", "Sanitas", "55", "Gravelly sandy loam", "3"],
    ]);
    expect(litter.get("1")?.texture).toEqual({ label: "Sandy loam", rank: 1 });
    expect(depthText(49)).toBe("19 in (49 cm)");
  });

  it("draws the clipped map unit polygons with their soil, and notes texture shares, the largest units and bedrock depth", async () => {
    const stub = sdaStub();
    const r = await layer.query(ctx(stub), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error(JSON.stringify(r));
    expect(stub).toHaveBeenCalledTimes(3);
    // Nine polygon rows, one of them a sliver line along the box edge.
    expect(r.data.features).toHaveLength(8);
    for (const f of r.data.features) expect(["Polygon", "MultiPolygon"]).toContain(f.geometry.type);
    expect(r.data.features.every((f) => typeof f.properties?.soil === "string" && f.properties?.name === undefined)).toBe(true);
    expect(r.coverageNote).toMatch(/^SSURGO soil map units in the box \(7 map units, 9 polygons\)/);
    expect(r.coverageNote).toContain("Surface texture by share of the box: loam about 54%, sandy loam about 43%, sand about 3%.");
    expect(r.coverageNote).toMatch(/Largest map units: Nederland very cobbly sandy loam, 1 to 12 percent slopes \(very cobbly sandy loam, about \d+%\)/);
    expect(r.coverageNote).toMatch(/Depth to bedrock: bedrock within the soil profile under about \d+% of the box, typically at 11 in \(28 cm\)/);
    expect(r.coverageNote).toContain("Mostly well drained");
  });

  it("asks only for the largest polygons in a wide box, and states the total", async () => {
    const q = soilQueries(BOX, 0.0005, 1500);
    expect(q.polygons).toMatch(/^SELECT TOP 1500 p\.mukey/);
    expect(q.polygons).toContain("ORDER BY area DESC");
    expect(soilQueries(BOX, 0.0005).polygons).not.toContain("TOP");
    const r = await layer.query(ctx(sdaStub(), BOX, true), {});
    expect(r).toMatchObject({ kind: "geojson", total: 9 });
  });

  it("returns nothing outside the United States without asking the service", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub, [10, 45, 10.1, 45.1]), {});
    expect(stub).not.toHaveBeenCalled();
    expect(r).toMatchObject({ kind: "geojson", coverageNote: expect.stringContaining("United States only") });
  });

  it("says when the box holds no soil map units", () => {
    expect(soilsNote(new Map(), new Map())).toBe("No SSURGO soil map units in this box");
  });

  it("keys texture sand to clay on the off-white to purple ramp and cards soil, texture, drainage, bedrock and hydrologic group", async () => {
    const legend = legendOf(layer);
    expect(legend).toMatchObject({ kind: "ramp", title: "Surface texture", field: "textureRank" });
    expect(legend.stops?.map((s) => s.label)).toEqual(["Sand", "Sandy loam", "Loam", "Clay loam", "Clay"]);
    expect(legend.stops?.map((s) => s.color)).toEqual(TEXTURE_COLORS);
    const r = await layer.query(ctx(sdaStub()), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const f = r.data.features.find((x) => x.properties?.bedrockCm !== undefined)!;
    const card = cardContent(f, { card: layer.card, fieldHelp: layer.fieldHelp });
    expect(card.facts.map((x) => x.label)).toEqual(["Soil", "Texture", "Texture class", "Drainage", "Depth to bedrock", "Hydrologic group", "Main soil"]);
    expect(card.facts.find((x) => x.label === "Depth to bedrock")?.value).toBe("11 in (28 cm)");
    expect(card.details).toEqual([]);
  });
});
