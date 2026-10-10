import { describe, expect, it, vi } from "vitest";
import type { Polygon } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { glimsUrl, normalizeGlaciers, thinGeometry } from "./glaciers";
import raw from "./__fixtures__/glaciers.alps.json";

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

  it("drops non-outline rows and keeps only the newest outline per glacier id", () => {
    const { data } = normalizeGlaciers(raw);
    const ids = data.features.map((f) => f.properties?.glacierId);
    expect(ids).not.toContain("ROCK1");
    expect(new Set(ids).size).toBe(ids.length);
    const schwarzberg = data.features.find((f) => f.properties?.glacierId === "G007922E46000N");
    expect(schwarzberg?.properties?.date).toBe("2003-08-13");
  });

  it("calls a region code or placeholder an unnamed glacier", () => {
    const poly = { type: "Polygon", coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]] };
    const row = (name: string | null, id: string) => ({
      type: "Feature",
      geometry: poly,
      properties: { line_type: "glac_bound", glac_id: id, glac_name: name, db_area: 1.5, src_date: "1984-09-09T00:00:00Z" },
    });
    const { data } = normalizeGlaciers({ type: "FeatureCollection", features: [row("CA", "a"), row(null, "b"), row("None", "c"), row("Rainier", "d")] });
    expect(data.features.map((f) => f.properties?.name).sort()).toEqual(["Rainier", "Unnamed glacier", "Unnamed glacier", "Unnamed glacier"]);
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

  it("queries the WFS once with a cache key and returns geojson with a citation", async () => {
    const stub = vi.fn(async () => json(raw));
    const r = await layer.query(ctx(stub, "glaciers:k"), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");

    const calls = stub.mock.calls as unknown as [string, RequestInit & { cacheKey?: string; ttlSeconds?: number }][];
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(glimsUrl(MONTE_ROSA));
    expect(calls[0][1].cacheKey).toBe("glaciers:k:glims");
    expect(calls[0][1].ttlSeconds).toBe(7 * 86_400);
    expect(r.data.features.length).toBe(5);
    expect(r.coverageNote).toBeUndefined();
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

  it("refuses an area over the cap without calling upstream", async () => {
    const stub = vi.fn();
    const r = await layer.query({ bbox: [6, 44, 9, 47], zoom: 8, env: {}, fetch: stub as unknown as CachedFetch }, {});
    expect(r).toMatchObject({ hint: "zoom_in" });
    expect(stub).not.toHaveBeenCalled();
  });

  it("is registered and rejects a large area through runLayer", async () => {
    const r = await runLayer("glaciers", { bbox: [6, 44, 9, 47], zoom: 8 });
    expect(r.status).toBe(422);
  });

  it("describes glaciers in the words people use and warns the outlines are dated", () => {
    expect(layer.description).toMatch(/glacier/i);
    expect(layer.description).toMatch(/not a current survey|date/i);
  });
});
