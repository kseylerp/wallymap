import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import layer, {
  MAX_AREAS,
  PROTECTION_LEVELS,
  WDPA_POLYGONS,
  WDPA_POLYGONS_FALLBACK,
  WDPA_WHERE,
  countryName,
  mergeDesignations,
  normalizeProtectedAreas,
  simplifyOffset,
} from "./protected-areas-world";
import { contractProblems, legendOf } from "./contract";
import { cardContent } from "@/lib/render/card";
import guiana from "./__fixtures__/protected-areas-world.guiana.json";
import type { FeatureCollection } from "geojson";

const WORLD: [number, number, number, number] = [-179, -60, 179, 80];

describe("protected-areas-world layer", () => {
  it("reads UNEP-WCMC's hosted copy first and keeps the old server as the fallback", () => {
    expect(WDPA_POLYGONS).toBe("https://services5.arcgis.com/Mj0hjvkNtV7NRhA7/arcgis/rest/services/WDPA_v0/FeatureServer/1");
    expect(WDPA_POLYGONS_FALLBACK).toBe("https://data-gis.unep-wcmc.org/server/rest/services/ProtectedSites/The_World_Database_of_Protected_Areas/MapServer/1");
    expect(WDPA_WHERE).toBe("desig_type <> 'International'");
  });

  it("declares global coverage and a non-commercial license, with no env", () => {
    expect(layer.id).toBe("protected-areas-world");
    expect(layer.coverage).toBe("global");
    expect(layer.license).toMatch(/non-commercial/i);
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(25_000_000);
    expect(layer.input.parse({})).toEqual({});
  });

  it("asks the whole world to zoom in instead of timing out", async () => {
    const r = await runLayer("protected-areas-world", { bbox: WORLD, zoom: 3 });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ hint: "zoom_in" });
  });

  it("fills each area by how strictly it is protected, with a matching legend", () => {
    const legend = legendOf(layer);
    expect(legend).toMatchObject({ kind: "categories", field: "protection" });
    expect(legend.items?.map((i) => i.value)).toEqual(["strict", "park", "habitat", "sustainable", "none"]);
    expect(new Set(legend.items?.map((i) => i.color)).size).toBe(5);
    expect(legend.items?.[1]).toMatchObject({ label: "National park", color: "#9FB693", help: expect.stringMatching(/^IUCN II:/) });
    // Chip labels fit a row; the IUCN categories each holds are in its help.
    for (const l of PROTECTION_LEVELS) expect(l.label.length, l.label).toBeLessThanOrEqual(28);
    expect(PROTECTION_LEVELS.find((l) => l.value === "sustainable")?.help).toMatch(/^IUCN V and VI:/);
    expect(PROTECTION_LEVELS.map((l) => l.value)).toEqual(legend.items?.map((i) => i.value));
    expect(layer.attributes?.find((a) => a.key === "protection")).toMatchObject({ encode: "color", primary: true });
    expect(contractProblems(layer)).toEqual([]);
  });

  it("describes protection in the words people use and warns about the licence and what is left out", () => {
    expect(layer.description).toMatch(/protected/i);
    expect(layer.description).toMatch(/non-commercial/i);
    expect(layer.description).toMatch(/International designations .* are left out/);
    expect(layer.description).toMatch(/returns an error saying so rather than an empty map/);
  });
});

// French Guiana, about 136,000 km²: under the features cap, so the layer returns named polygons.
const GUIANA: [number, number, number, number] = [-54.6, 2.1, -51.6, 5.8];

describe("protected-areas-world named polygons for a region", () => {
  const ctxAt = (stub: ReturnType<typeof vi.fn>) => ({ bbox: GUIANA, zoom: 7, env: {}, fetch: stub as unknown as CachedFetch });

  it("queries the hosted WDPA polygons, national and regional only, largest first, capped and simplified", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(guiana), { status: 200 }));
    await layer.query(ctxAt(stub), {});
    expect(stub).toHaveBeenCalledTimes(1);
    const url = new URL(String((stub.mock.calls[0] as unknown[])[0]));
    expect(url.origin + url.pathname).toBe(`${WDPA_POLYGONS}/query`);
    expect(url.searchParams.get("where")).toBe(WDPA_WHERE);
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
      protection: "habitat",
      areaKm2: 1066,
      v: 1066,
      country: "French Guiana",
    });
    expect(r.coverageNote).toMatch(/^5 national and regional protected areas in this region, largest first; international designations .*non-commercial/);
    expect(r.citation.source).toMatch(/non-commercial/i);
  });

  it("names the country on the card instead of its ISO3 code", () => {
    expect(countryName("CRI")).toBe("Costa Rica");
    expect(countryName("USA")).toBe("United States");
    expect(countryName("COD")).toBe("Democratic Republic of the Congo");
    expect(countryName("BRA;PER")).toBe("Brazil · Peru");
    expect(countryName("ABNJ")).toBe("Areas beyond national jurisdiction");
    expect(countryName("ZZZ")).toBe("ZZZ");
    const nouragues = normalizeProtectedAreas(guiana as FeatureCollection).features.find((f) => f.properties?.name === "Nouragues")!;
    const card = cardContent(nouragues, { card: layer.card, fieldHelp: layer.fieldHelp });
    expect(card.facts.find((r) => r.key === "country")).toMatchObject({ label: "Country", value: "French Guiana" });
    expect(card.facts.find((r) => r.key === "protection")?.value).toBe("Monument or habitat area");
  });

  it("leaves out IUCN placeholders and says when the service capped the list", async () => {
    const fc = normalizeProtectedAreas({
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { name: "X", iucn_cat: "Not Reported", gis_area: 2.34 } }],
    } as FeatureCollection);
    expect(fc.features[0].properties).toEqual({ name: "X", protection: "none", areaKm2: 2.3, v: 2.3 });

    const capped = { ...guiana, exceededTransferLimit: true };
    const stub = vi.fn(async () => new Response(JSON.stringify(capped), { status: 200 }));
    const r = await layer.query(ctxAt(stub), {});
    expect(r).toMatchObject({ kind: "geojson", coverageNote: expect.stringMatching(/^The 5 largest national and regional protected areas in this region/) });
  });

  it("asks the old server when the hosted copy fails, and says the source is fine when it answers", async () => {
    const stub = vi.fn(async (url: string) => (url.startsWith(WDPA_POLYGONS) ? new Response("down", { status: 500 }) : new Response(JSON.stringify(guiana), { status: 200 })));
    const r = await layer.query(ctxAt(stub), {});
    expect(stub).toHaveBeenCalledTimes(2);
    expect(String((stub.mock.calls[1] as unknown[])[0])).toContain(WDPA_POLYGONS_FALLBACK);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(5);
    expect(r.sourceStatus).toEqual({ ok: true });
  });

  it("returns an upstream error with the source status when both servers fail, never a blank map", async () => {
    const stub = vi.fn(async () => new Response("down", { status: 500 }));
    const r = await layer.query(ctxAt(stub), {});
    expect(r).toMatchObject({ hint: "upstream", sourceStatus: { ok: false, reason: "server-error" } });
    expect("error" in r && r.error).toMatch(/did not answer/);
  });

  it("summarizes the largest parks by name for the note", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(guiana), { status: 200 }));
    const summary = summarizeLayerResult(await layer.query(ctxAt(stub), {}), "protected-areas-world");
    expect(summary).toHaveProperty("top");
    expect((summary as { top: string[] }).top[0]).toBe("Guyane (Parc Amazonien), National Park - Core Area, 20,218 km² (French Guiana)");
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
