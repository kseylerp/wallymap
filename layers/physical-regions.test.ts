/**
 * Fixture: layers/__fixtures__/ne-regions.sample.json (10 real Natural Earth 10m geography regions, fetched
 * 2026-10-09 from nvkelso/natural-earth-vector): Andes, Sierra Nevada (California), S. Nevada (Spain), Sahara,
 * Colorado Plateau, Great Basin, Great Plains, Arabian Peninsula, Hawaiian Islands, Siberia.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { resetNaturalEarthCache } from "@/lib/agent/naturalEarth";
import { runLayer } from "@/lib/layers/run";
import sample from "./__fixtures__/ne-regions.sample.json";
import layer, { regionKind } from "./physical-regions";

const fixture = sample as unknown as FeatureCollection;

const TAHOE: [number, number, number, number] = [-120.4, 38.7, -119.8, 39.3];
const NORTH_AFRICA: [number, number, number, number] = [-20, 0, 40, 40];
const SOUTH_AMERICA: [number, number, number, number] = [-80, -40, -40, 10];

function stubFetch(body: unknown = fixture, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

function ctx(stub: ReturnType<typeof stubFetch>, bbox: [number, number, number, number]) {
  return { bbox, zoom: 5, env: {}, fetch: stub as unknown as CachedFetch };
}

function names(r: Awaited<ReturnType<typeof layer.query>>): string[] {
  if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
  return r.data.features.map((f) => String(f.properties?.name)).sort();
}

describe("physical-regions layer", () => {
  beforeEach(() => {
    resetNaturalEarthCache();
  });

  it("declares global coverage, the public domain license, polygon style and no env", () => {
    expect(layer.id).toBe("physical-regions");
    expect(layer.coverage).toBe("global");
    expect(layer.license).toBe("Public domain (Natural Earth)");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.style).toEqual({ geometry: "polygon", color: "#9FB693", fillOpacity: 0 });
  });

  it("accepts an optional list of kinds and rejects unknown kinds", () => {
    expect(layer.input.parse({})).toEqual({});
    expect(layer.input.parse({ kinds: ["range", "desert"] })).toEqual({ kinds: ["range", "desert"] });
    expect(layer.input.safeParse({ kinds: ["volcano"] }).success).toBe(false);
  });

  it("maps Natural Earth feature classes to kinds", () => {
    expect(regionKind("Range/mtn")).toBe("range");
    expect(regionKind("Desert")).toBe("desert");
    expect(regionKind("Plain")).toBe("plain");
    expect(regionKind("Plateau")).toBe("plateau");
    expect(regionKind("Basin")).toBe("basin");
    expect(regionKind("Peninsula")).toBe("peninsula");
    expect(regionKind("Pen/cape")).toBe("peninsula");
    expect(regionKind("Island")).toBe("island");
    expect(regionKind("Island group")).toBe("island");
    expect(regionKind("Geoarea")).toBe("other");
    expect(regionKind("Delta")).toBe("other");
    expect(regionKind(undefined)).toBe("other");
  });

  it("returns only the regions whose bbox intersects the request (Tahoe: Sierra Nevada and Great Basin)", async () => {
    const r = await layer.query(ctx(stubFetch(), TAHOE), {});
    const found = names(r);
    expect(found).toContain("Sierra Nevada");
    expect(found).toContain("Great Basin");
    expect(found).not.toContain("Andes");
    expect(found).not.toContain("Sahara");
    expect(found).not.toContain("Hawaiian Islands");
  });

  it("returns polygons with name, kind and the source feature class", async () => {
    const r = await layer.query(ctx(stubFetch(), TAHOE), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    for (const f of r.data.features) {
      expect(["Polygon", "MultiPolygon"]).toContain(f.geometry.type);
    }
    const sierra = r.data.features.find((f) => f.properties?.name === "Sierra Nevada");
    expect(sierra?.properties).toMatchObject({ kind: "range", featureClass: "Range/mtn", region: "North America" });
    expect(r.citation.source).toContain("Natural Earth");
  });

  it("filters by kinds", async () => {
    const stub = stubFetch();
    expect(names(await layer.query(ctx(stub, NORTH_AFRICA), { kinds: ["desert"] }))).toEqual(["Sahara"]);
    expect(names(await layer.query(ctx(stub, NORTH_AFRICA), { kinds: ["peninsula"] }))).toEqual(["Arabian Peninsula"]);
    expect(names(await layer.query(ctx(stub, NORTH_AFRICA), { kinds: ["plateau"] }))).toEqual([]);
    expect(names(await layer.query(ctx(stub, SOUTH_AMERICA), { kinds: ["range", "island"] }))).toEqual(["Andes"]);
  });

  it("treats an empty kinds list as no filter", async () => {
    const stub = stubFetch();
    expect(names(await layer.query(ctx(stub, NORTH_AFRICA), { kinds: [] }))).toEqual(
      names(await layer.query(ctx(stub, NORTH_AFRICA), {})),
    );
  });

  it("leaves out whole continents and the placeholder class", async () => {
    const world = { type: "Polygon" as const, coordinates: [[[-180, -80], [180, -80], [180, 80], [-180, 80], [-180, -80]]] };
    const withExtras: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        ...fixture.features,
        { type: "Feature", geometry: world, properties: { NAME: "ASIA", NAME_EN: "Asia", FEATURECLA: "Continent", SCALERANK: 0 } },
        { type: "Feature", geometry: world, properties: { NAME: "Here", NAME_EN: "Here", FEATURECLA: "Dragons-be-here", SCALERANK: 0 } },
      ],
    };
    const found = names(await layer.query(ctx(stubFetch(withExtras), TAHOE), {}));
    expect(found).toContain("Sierra Nevada");
    expect(found).not.toContain("Asia");
    expect(found).not.toContain("Here");
  });

  it("returns the most prominent regions first and notes when it cuts the list", async () => {
    const box = (i: number, rank: number) => ({
      type: "Feature" as const,
      geometry: { type: "Polygon" as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      properties: { NAME: `Hill ${i}`, NAME_EN: `Hill ${i}`, FEATURECLA: "Range/mtn", SCALERANK: rank },
    });
    const many: FeatureCollection = {
      type: "FeatureCollection",
      features: [...Array.from({ length: 160 }, (_, i) => box(i, 5)), box(999, 0)],
    };
    const r = await layer.query(ctx(stubFetch(many), [-1, -1, 2, 2]), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(150);
    expect(r.data.features[0].properties?.name).toBe("Hill 999");
    expect(r.coverageNote).toMatch(/150 most prominent/);
  });

  it("downloads the regions file once however many queries run", async () => {
    const stub = stubFetch();
    await layer.query(ctx(stub, TAHOE), {});
    await layer.query(ctx(stub, NORTH_AFRICA), {});
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("maps a failed download to an upstream error", async () => {
    const r = await layer.query(ctx(stubFetch("nope", 500), TAHOE), {});
    expect(r).toMatchObject({ hint: "upstream" });
  });

  it("maps a body that is not GeoJSON to an upstream error", async () => {
    const r = await layer.query(ctx(stubFetch({ hello: "world" }), TAHOE), {});
    expect(r).toMatchObject({ hint: "upstream" });
  });

  it("describes what the regions are, their rough edges and how to filter", () => {
    expect(layer.description).toMatch(/mountain|range/i);
    expect(layer.description).toMatch(/approximate|generali[sz]ed|rough/i);
    expect(layer.description).toMatch(/kinds/);
  });

  it("rejects an oversized bbox with zoom_in through runLayer", async () => {
    const res = await runLayer("physical-regions", { bbox: [-180, -60, 180, 80], zoom: 1 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ hint: "zoom_in" });
  });
});
