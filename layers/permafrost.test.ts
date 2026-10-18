import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { cardTitle, legendOf } from "./contract";
import layer, { dropSlivers, normalizePermafrost, permafrostOffset } from "./permafrost";
import fixture from "./__fixtures__/permafrost.fairbanks.json";

/** Recorded 2026-10-10 for [-150,63,-145,66] (permafrost classes only, largest first), trimmed to 10 small polygons. */
const FAIRBANKS: [number, number, number, number] = [-150, 63, -145, 66];

function ctx(stub: ReturnType<typeof vi.fn>, bbox = FAIRBANKS) {
  return { bbox, zoom: 7, env: {}, fetch: stub as unknown as CachedFetch, cacheKey: "permafrost:k" };
}

const ok = (body: unknown = fixture) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

describe("permafrost", () => {
  it("classifies extent, ground ice and landform in plain words", () => {
    const f = normalizePermafrost(fixture as FeatureCollection);
    expect(f).toHaveLength(10);
    expect(f[0].properties).toMatchObject({ kind: "continuous", percent: "90-100%", v: 95, groundIce: "medium (10-20%)" });
    expect(f.filter((x) => x.properties?.kind === "discontinuous")).toHaveLength(8);
    expect(f.find((x) => x.properties?.groundIce === "low (under 10%)")?.properties?.landform).toMatch(/mountains|lowland/);
    const extra: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "Point", coordinates: [0, 70] }, properties: { EXTENT: " ", COMBO: "g" } },
        { type: "Feature", geometry: { type: "Point", coordinates: [0, 70] }, properties: { EXTENT: "S", CONTENT: "h", LANDFORM: "f", RELICT: "yes" } },
      ],
    };
    expect(normalizePermafrost(extra).map((x) => x.properties)).toEqual([
      { name: "Sporadic permafrost zone", kind: "sporadic", percent: "10-50%", v: 30, groundIce: "high (over 20%)", landform: "lowland or highland with thick sediment", relict: "yes" },
    ]);
  });

  it("asks for permafrost classes only, simplified to the view and largest first, cached a month", async () => {
    const stub = ok();
    const r = await layer.query(ctx(stub), layer.input.parse({}));
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(10);
    const [url, init] = stub.mock.calls[0] as unknown as [string, { cacheKey: string; ttlSeconds: number }];
    const u = new URL(url);
    expect(u.searchParams.get("where")).toBe("EXTENT IN ('C','D','S','I')");
    expect(u.searchParams.get("orderByFields")).toBe("Shape__Area DESC");
    expect(u.searchParams.get("maxAllowableOffset")).toBe("0.013");
    expect(init).toMatchObject({ cacheKey: "permafrost:k:zones-v2", ttlSeconds: 2_592_000 });
    expect(permafrostOffset([-170, 55, -140, 72])).toBe(0.075);
    expect(r.citation.source).toContain("licence not stated");
  });

  it("notes a capped result (GeoJSON puts the flag under properties)", async () => {
    const r = await layer.query(ctx(ok({ ...fixture, properties: { exceededTransferLimit: true } })), layer.input.parse({}));
    expect(r).toMatchObject({ coverageNote: expect.stringContaining("Showing the 2000 largest") });
  });

  it("returns NRCan export tiles for canada", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub, [-120, 60, -100, 70]), layer.input.parse({ canada: true }));
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.data.url).toMatch(/^https:\/\/maps-cartes\.services\.geo\.ca\/.*permafrost_atlas_of_canada_en\/MapServer\/export\?bbox=\{bbox-epsg-3857\}/);
    expect(r.data.url).toContain("layers=show:6");
    expect(r.citation.source).toContain("Open Government Licence - Canada");
  });

  it("returns nothing south of 25°N and maps upstream failure", async () => {
    const none = vi.fn();
    expect(await layer.query(ctx(none, [-80, 0, -70, 10]), layer.input.parse({}))).toMatchObject({ coverageNote: expect.stringContaining("north of 25°N") });
    expect(none).not.toHaveBeenCalled();
    const down = vi.fn(async () => new Response("no", { status: 500 }));
    expect(await layer.query(ctx(down), layer.input.parse({}))).toMatchObject({ hint: "upstream" });
  });

  it("colors zones on the ordinal ramp, keys the four classes and titles the card by its zone", () => {
    expect(layer.style.encode).toEqual({ color: "kind" });
    const key = legendOf(layer);
    expect(key).toMatchObject({ kind: "categories", field: "kind" });
    expect(key.items?.map((i) => i.value)).toEqual(["isolated", "sporadic", "discontinuous", "continuous"]);
    const f = normalizePermafrost(fixture as FeatureCollection)[2];
    expect(cardTitle(layer, f)).toBe("Discontinuous permafrost zone");
  });

  it("drops the triangle slivers simplification leaves, keeping real polygons and multipolygon parts", () => {
    const tri = (x: number, size: number) => [[[x, 64], [x + size, 64], [x, 64 + size], [x, 64]]];
    const big = [[[0, 60], [1, 60], [1, 61], [0.5, 61.5], [0, 61], [0, 60]]];
    const features = [
      { type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: tri(0, 0.01) } },
      { type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: tri(0, 0.5) } },
      { type: "Feature" as const, properties: {}, geometry: { type: "MultiPolygon" as const, coordinates: [big, tri(2, 0.01)] } },
      { type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: big } },
    ];
    const { features: kept, dropped } = dropSlivers(features, 0.035);
    expect(dropped).toBe(2);
    expect(kept).toHaveLength(3);
    expect(kept[1].geometry).toEqual({ type: "MultiPolygon", coordinates: [big] });
  });

  it("states the unstated licence and the user's words", async () => {
    expect(layer.license).toMatch(/^Unstated/);
    for (const word of ["permafrost", "continuous", "discontinuous", "sporadic", "isolated", "canada", "map tiles"]) expect(layer.description).toContain(word);
    expect((await runLayer("permafrost", { bbox: [-170, 50, -100, 75] })).status).toBe(422);
  });
});
