import { describe, expect, it, vi } from "vitest";
import type { Polygon } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { glimsCountUrl, glimsUrl, normalizeGlaciers, thinGeometry } from "./glaciers";
import raw from "./__fixtures__/glaciers.alps.json";
import lyell from "./__fixtures__/glaciers.lyell.json";

const MONTE_ROSA: [number, number, number, number] = [7.8, 45.8, 8.0, 46.0];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string) {
  return { bbox: MONTE_ROSA, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

describe("glaciers layer", () => {
  it("declares global coverage, the license, no env and extruded polygon style", () => {
    expect(layer.id).toBe("glaciers");
    expect(layer.coverage).toBe("global");
    expect(layer.license).toMatch(/GLIMS/);
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(8_000);
    expect(layer.hardMaxAreaKm2).toBe(3_000_000);
    expect(layer.wide).toEqual({ orderBy: "area in km²", limit: 1500 });
    expect(layer.input.parse({})).toEqual({});
    expect(layer.style).toMatchObject({ geometry: "polygon", extrude: "v" });
  });

  it("builds a WFS request with the bbox and outline filter, largest first", () => {
    const url = new URL(glimsUrl(MONTE_ROSA));
    expect(url.origin + url.pathname).toBe("https://www.glims.org/geoserver/ows");
    expect(url.searchParams.get("typeName")).toBe("GLIMS:GLIMS_Glacier_Outlines");
    expect(url.searchParams.get("outputFormat")).toBe("application/json");
    expect(url.searchParams.get("sortBy")).toBe("db_area D");
    expect(url.searchParams.get("cql_filter")).toBe(
      "BBOX(entity_geom,7.8,45.8,8,46,'EPSG:4326') AND line_type='glac_bound'",
    );
  });

  it("normalizes rows to named polygons with area as v, date and t, largest first", () => {
    const { data, truncated } = normalizeGlaciers(raw);
    expect(truncated).toBe(false);
    const names = data.features.map((f) => f.properties?.name);
    expect(names[0]).toBe("Gornergletscher");
    const areas = data.features.map((f) => f.properties?.v as number);
    expect([...areas].sort((a, b) => b - a)).toEqual(areas);

    const gorner = data.features[0].properties ?? {};
    expect(gorner).toMatchObject({
      glacierId: "G007800E45965N",
      areaKm2: 40.231,
      v: 40.231,
      date: "2009-09-15",
      t: "2009-09-15T00:00:00.000Z",
    });
    expect(typeof gorner.institution).toBe("string");
    for (const f of data.features) expect(["Polygon", "MultiPolygon"]).toContain(f.geometry.type);
  });

  it("drops non-outline rows and keeps every dated outline, one per glacier id and date", () => {
    const { data } = normalizeGlaciers(raw);
    const ids = data.features.map((f) => f.properties?.glacierId);
    expect(ids).not.toContain("ROCK1");
    const schwarzberg = data.features.filter((f) => f.properties?.glacierId === "G007922E46000N");
    expect(schwarzberg.map((f) => f.properties?.date)).toEqual(["2003-08-06", "2003-08-13"]);
    const keys = data.features.map((f) => `${f.properties?.glacierId}|${f.properties?.t}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(data.features).toHaveLength(6);
  });

  it("plays Lyell and Maclure retreat: two dated outlines each, oldest first, area shrinking", () => {
    const { data, truncated } = normalizeGlaciers(lyell);
    expect(truncated).toBe(false);
    // GLIMS gives Lyell Glacier two ids with a 1984 and a 2014 outline each; they merge into one series under the larger id.
    const lyellOutlines = data.features.filter((f) => f.properties?.name === "Lyell Glacier");
    expect(lyellOutlines.map((f) => f.properties?.glacierId)).toEqual(["G240738E37743N", "G240738E37743N"]);
    expect(lyellOutlines.map((f) => f.properties?.t)).toEqual(["1984-09-09T00:00:00.000Z", "2014-09-09T00:00:00.000Z"]);
    expect(lyellOutlines.map((f) => f.properties?.v)).toEqual([0.373, 0.253]);
    const maclure = data.features.filter((f) => f.properties?.glacierId === "G240720E37746N");
    expect(maclure.map((f) => f.properties?.date)).toEqual(["1984-09-09", "2014-09-09"]);
    expect(maclure[1].properties?.v as number).toBeLessThan(maclure[0].properties?.v as number);
    const patch = data.features.filter((f) => f.properties?.glacierId === "G240775E37720N");
    expect(patch.map((f) => f.properties?.date)).toEqual(["1975-09-09", "2014-09-09"]);
  });

  it("does not merge same-named glaciers far apart, or unnamed ones near each other", () => {
    const square = (x: number) => ({ type: "Polygon", coordinates: [[[x, 0], [x + 0.01, 0], [x + 0.01, 0.01], [x, 0.01], [x, 0]]] });
    const row = (id: string, name: string | null, x: number, area: number) => ({
      type: "Feature",
      geometry: square(x),
      properties: { line_type: "glac_bound", glac_id: id, glac_name: name, db_area: area, src_date: "2000-01-01T00:00:00Z" },
    });
    const far = normalizeGlaciers({ type: "FeatureCollection", features: [row("a", "North Glacier", 0, 2), row("b", "North Glacier", 1, 1)] });
    expect(far.data.features.map((f) => f.properties?.glacierId)).toEqual(["a", "b"]);
    const unnamed = normalizeGlaciers({ type: "FeatureCollection", features: [row("a", "CA", 0, 2), row("b", "CA", 0.005, 1)] });
    expect(unnamed.data.features).toHaveLength(2);
    const near = normalizeGlaciers({ type: "FeatureCollection", features: [row("a", "North Glacier", 0, 2), row("b", "North Glacier", 0.005, 1)] });
    expect(near.data.features).toHaveLength(1);
  });

  it("keeps the larger outline when one glacier has two for the same date", () => {
    const poly = { type: "Polygon", coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]] };
    const row = (area: number, inst: string) => ({
      type: "Feature",
      geometry: poly,
      properties: { line_type: "glac_bound", glac_id: "g1", glac_name: "Twice", db_area: area, src_date: "2000-01-01T00:00:00Z", chief_affl: inst },
    });
    const { data } = normalizeGlaciers({ type: "FeatureCollection", features: [row(1, "A"), row(2, "B")] });
    expect(data.features).toHaveLength(1);
    expect(data.features[0].properties).toMatchObject({ v: 2, institution: "B" });
  });

  it("keeps an outline with no date once, without t", () => {
    const poly = { type: "Polygon", coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]] };
    const { data } = normalizeGlaciers({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: poly, properties: { line_type: "glac_bound", glac_id: "g1", db_area: 1, src_date: null } },
        { type: "Feature", geometry: poly, properties: { line_type: "glac_bound", glac_id: "g1", db_area: 1, src_date: null } },
      ],
    });
    expect(data.features).toHaveLength(1);
    expect(data.features[0].properties).not.toHaveProperty("t");
  });

  it("draws Steffen once when two ids map it on one day under two spellings (STEFFEN, Steffen)", () => {
    const poly = (w: number, s: number) => ({ type: "Polygon", coordinates: [[[w, s], [w + 0.5, s], [w + 0.5, s + 0.6], [w, s + 0.6], [w, s]]] });
    const row = (name: string, id: string, w: number, s: number, area: number) => ({
      type: "Feature",
      geometry: poly(w, s),
      properties: { line_type: "glac_bound", glac_id: id, glac_name: name, db_area: area, src_date: "2001-03-11T00:00:00Z" },
    });
    const { data } = normalizeGlaciers({ type: "FeatureCollection", features: [row("STEFFEN", "G286460E47399S", -73.8, -47.7, 429.9), row("Steffen", "G286443E47304S", -73.79, -47.69, 428.5)] });
    expect(data.features).toHaveLength(1);
    expect(data.features[0].properties).toMatchObject({ name: "STEFFEN", glacierId: "G286460E47399S" });
  });

  it("calls a region code or placeholder an unnamed glacier", () => {
    const poly = { type: "Polygon", coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]] };
    const row = (name: string | null, id: string) => ({
      type: "Feature",
      geometry: poly,
      properties: { line_type: "glac_bound", glac_id: id, glac_name: name, db_area: 1.5, src_date: "1984-09-09T00:00:00Z" },
    });
    const { data } = normalizeGlaciers({ type: "FeatureCollection", features: [row("CA", "a"), row(null, "b"), row("None", "c"), row("Rainier", "d"), row("S/N", "e"), row("Sin nombre", "f")] });
    expect(data.features.map((f) => f.properties?.name).sort()).toEqual(["Rainier", ...Array(5).fill("Unnamed glacier")]);
  });

  it("thins dense vertices but keeps closed rings, and drops rings that collapse", () => {
    const ring: [number, number][] = [[0, 0]];
    for (let i = 1; i <= 100; i++) ring.push([i * 0.0001, 0]);
    ring.push([0.01, 0.01], [0, 0.01], [0, 0]);
    const thin = thinGeometry({ type: "Polygon", coordinates: [ring] }) as Polygon;
    expect(thin.coordinates[0].length).toBeLessThan(ring.length);
    expect(thin.coordinates[0][0]).toEqual(thin.coordinates[0][thin.coordinates[0].length - 1]);
    const tiny: [number, number][] = [[0, 0], [0.00001, 0], [0.00001, 0.00001], [0, 0]];
    expect(thinGeometry({ type: "Polygon", coordinates: [tiny] })).toBeNull();
    expect(thinGeometry({ type: "Point", coordinates: [0, 0] })).toBeNull();
  });

  it("caps the result at 300 glaciers and says so", async () => {
    const poly = { type: "Polygon", coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]] };
    const features = Array.from({ length: 320 }, (_, i) => ({
      type: "Feature",
      geometry: poly,
      properties: { line_type: "glac_bound", glac_id: `g${i}`, glac_name: `Glacier ${i}`, db_area: 400 - i, src_date: "2010-01-01T00:00:00Z" },
    }));
    const stub = vi.fn(async () => json({ type: "FeatureCollection", features }));
    const r = await layer.query(ctx(stub), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(300);
    expect(r.data.features[0].properties?.name).toBe("Glacier 0");
    expect(r.coverageNote).toMatch(/300 largest/);
  });

  it("keeps all dated outlines of the 300 largest glaciers, ranked by each glacier's biggest outline", async () => {
    const poly = { type: "Polygon", coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]] };
    const rows = (i: number) => [
      { type: "Feature", geometry: poly, properties: { line_type: "glac_bound", glac_id: `g${i}`, glac_name: `Glacier ${i}`, db_area: 400 - i, src_date: "1985-01-01T00:00:00Z" } },
      { type: "Feature", geometry: poly, properties: { line_type: "glac_bound", glac_id: `g${i}`, glac_name: `Glacier ${i}`, db_area: 300 - i, src_date: "2015-01-01T00:00:00Z" } },
    ];
    const features = Array.from({ length: 320 }, (_, i) => rows(i)).flat();
    const { data, truncated } = normalizeGlaciers({ type: "FeatureCollection", features });
    expect(truncated).toBe(true);
    expect(data.features).toHaveLength(600);
    expect(data.features.slice(0, 2).map((f) => f.properties?.date)).toEqual(["1985-01-01", "2015-01-01"]);
    expect(new Set(data.features.map((f) => f.properties?.glacierId)).size).toBe(300);
    expect(data.features.some((f) => f.properties?.glacierId === "g319")).toBe(false);
  });

  it("notes that later outlines may be missing when the row cap is reached without trimming glaciers", async () => {
    const poly = { type: "Polygon", coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]] };
    const features = Array.from({ length: 450 }, (_, i) =>
      [1985, 2015].map((y) => ({
        type: "Feature",
        geometry: poly,
        properties: { line_type: "glac_bound", glac_id: `g${i}`, glac_name: `Glacier ${i}`, db_area: 400 - i, src_date: `${y}-01-01T00:00:00Z` },
      })),
    ).flat();
    // 900 rows but 450 glaciers: over the glacier cap of 300, so the glacier note wins
    const stub = vi.fn(async () => json({ type: "FeatureCollection", features }));
    const r = await layer.query(ctx(stub), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toMatch(/300 largest glaciers/);

    const few = Array.from({ length: 900 }, (_, i) => ({
      type: "Feature",
      geometry: poly,
      properties: { line_type: "glac_bound", glac_id: `g${i % 100}`, glac_name: "G", db_area: 100 - (i % 100), src_date: `${1900 + Math.floor(i / 100)}-01-01T00:00:00Z` },
    }));
    const stub2 = vi.fn(async () => json({ type: "FeatureCollection", features: few }));
    const r2 = await layer.query(ctx(stub2), {});
    if (!("kind" in r2) || r2.kind !== "geojson") throw new Error("expected geojson");
    expect(r2.data.features).toHaveLength(900);
    expect(r2.coverageNote).toMatch(/900 biggest outlines/);
  });

  it("queries the WFS once with a cache key and returns geojson with a citation", async () => {
    const stub = vi.fn(async () => json(raw));
    const r = await layer.query(ctx(stub, "glaciers:k"), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");

    const calls = stub.mock.calls as unknown as [string, RequestInit & { cacheKey?: string; ttlSeconds?: number }][];
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(glimsUrl(MONTE_ROSA));
    expect(calls[0][1].cacheKey).toBe("glaciers:k:glims");
    expect(calls[0][1].ttlSeconds).toBe(7 * 86_400);
    expect(r.data.features.length).toBe(6);
    expect(r.coverageNote).toMatch(/Outlines exist only for the dates glaciers were mapped \(years in view: 2003, 2009, 2011, 2017\)/);
    expect(r.coverageNote).not.toMatch(/largest/);
    expect(r.citation.source).toContain("GLIMS");
  });

  it("maps an HTTP error, an XML error body and a network failure to upstream errors", async () => {
    const bad = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(await layer.query(ctx(bad), {})).toMatchObject({ hint: "upstream" });

    const xml = vi.fn(async () => new Response("<ServiceExceptionReport/>", { status: 200 }));
    expect(await layer.query(ctx(xml), {})).toMatchObject({ hint: "upstream", error: expect.stringContaining("not GeoJSON") });

    const down = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await layer.query(ctx(down), {})).toMatchObject({ hint: "upstream" });
  });

  it("builds a hits-only count request with the same filter", () => {
    const url = new URL(glimsCountUrl(MONTE_ROSA));
    expect(url.searchParams.get("version")).toBe("1.1.0");
    expect(url.searchParams.get("resultType")).toBe("hits");
    expect(url.searchParams.get("cql_filter")).toBe("BBOX(entity_geom,7.8,45.8,8,46,'EPSG:4326') AND line_type='glac_bound'");
  });

  it("in wide mode asks for the 1,500 largest outlines, keeps every glacier among them and quotes the count when the limit cut", async () => {
    const poly = { type: "Polygon", coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]] };
    const features = Array.from({ length: 1500 }, (_, i) => ({
      type: "Feature",
      geometry: poly,
      properties: { line_type: "glac_bound", glac_id: `g${i}`, glac_name: `Glacier ${i}`, db_area: 2000 - i, src_date: "2010-01-01T00:00:00Z" },
    }));
    const stub = vi.fn(async (url: string) =>
      url.includes("resultType=hits")
        ? new Response('<wfs:FeatureCollection numberOfFeatures="6621" timeStamp="x"/>', { status: 200 })
        : json({ type: "FeatureCollection", features }),
    );
    const r = await layer.query({ ...ctx(stub, "glaciers:w"), bbox: [-149, 60.6, -145, 61.8], wide: true, wideStrategy: layer.wide }, {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const urls = (stub.mock.calls as unknown as [string][]).map((c) => new URL(c[0]));
    const data = urls.find((u) => u.searchParams.get("resultType") === null);
    expect(data?.searchParams.get("maxFeatures")).toBe("1500");
    expect(data?.searchParams.get("sortBy")).toBe("db_area D");
    expect(r.data.features).toHaveLength(1500);
    expect(r.total).toBe(6621);
    expect(r.coverageNote).not.toMatch(/largest|zoom in/);
  });

  it("is registered, answers a 13,000 km² Alps box wide through runLayer, and rejects one over the hard cap", async () => {
    const stub = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("resultType=hits") ? new Response('<x numberOfFeatures="9"/>', { status: 200 }) : json(raw),
    );
    vi.stubGlobal("fetch", stub);
    try {
      const r = await runLayer("glaciers", { bbox: [7, 45.5, 8.5, 46.5], zoom: 8 });
      expect(r.status).toBe(200);
      // Fewer rows than the limit came back, so every outline is there and the count is not quoted.
      expect(r.body).toMatchObject({ coverageNote: expect.stringMatching(/^Showing all 6 in this wide view \(ranked by area in km²\)/) });
      expect(r.body).not.toHaveProperty("total");
    } finally {
      vi.unstubAllGlobals();
    }
    const far = await runLayer("glaciers", { bbox: [-170, 30, -100, 72], zoom: 3 });
    expect(far.status).toBe(422);
    expect(far.body).toMatchObject({ hint: "zoom_in", error: expect.stringMatching(/zoom in to under 3000000 km²$/) });
  });

  it("describes glaciers in the words people use and warns the outlines are dated", () => {
    expect(layer.description).toMatch(/glacier/i);
    expect(layer.description).toMatch(/not a current survey|date/i);
    expect(layer.description).toMatch(/retreat/);
    expect(layer.description).toMatch(/Lyell/);
  });
});
