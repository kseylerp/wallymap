import type { Feature } from "geojson";
import { describe, expect, it } from "vitest";
import {
  askAboutText,
  featureBBox,
  featureCenter,
  formatDate,
  friendlyKey,
  isLineFeature,
  layerIdFromDeckId,
  pickToSelection,
  summarizeFeature,
} from "@/lib/render/inspect";
import { pickPasses as pickPassesOf, skipHoverPicking } from "@/lib/render/inspect";

const trail: Feature = {
  type: "Feature",
  geometry: { type: "LineString", coordinates: [[-120.2, 39.0], [-120.0, 39.2]] },
  properties: { name: "Rubicon Trail", sac_scale: "mountain_hiking", surface: "dirt", osmId: 123 },
};
const known = { "osm-trails": {}, "public-lands": {}, popularity: {} };

describe("layerIdFromDeckId", () => {
  it("strips the render mode", () => {
    expect(layerIdFromDeckId("osm-trails:lines")).toBe("osm-trails");
    expect(layerIdFromDeckId("fire-perimeters:polygons")).toBe("fire-perimeters");
  });
  it("drops the 3D tag of a layer draped on terrain", () => {
    expect(layerIdFromDeckId("osm-trails@3d:lines")).toBe("osm-trails");
    expect(layerIdFromDeckId("osm-trails@3d:lines:casing")).toBeNull();
  });
  it("ignores casings and unknown suffixes", () => {
    expect(layerIdFromDeckId("osm-trails:lines:casing")).toBeNull();
    expect(layerIdFromDeckId("osm-trails")).toBeNull();
    expect(layerIdFromDeckId("osm-trails:lines-heatmap")).toBeNull();
  });
});

describe("pickToSelection", () => {
  it("maps a deck pick to the layer id, the picked feature and the click", () => {
    const sel = pickToSelection(
      { object: trail, layer: { id: "osm-trails:lines" }, coordinate: [-120.1, 39.1, 0], x: 400, y: 300 },
      known,
    );
    expect(sel).toEqual({ layerId: "osm-trails", feature: trail, lngLat: [-120.1, 39.1], screen: { x: 400, y: 300 } });
    // The selection holds the very object deck drew, so the highlight can match it by reference.
    expect(sel?.feature).toBe(trail);
  });

  it("ignores casing layers, empty picks and layers that are not loaded", () => {
    expect(pickToSelection({ object: trail, layer: { id: "osm-trails:lines:casing" }, coordinate: [0, 0] }, known)).toBeNull();
    expect(pickToSelection({ object: null, layer: null, coordinate: [0, 0] }, known)).toBeNull();
    expect(pickToSelection({ object: trail, layer: { id: "gone:lines" }, coordinate: [0, 0] }, known)).toBeNull();
    expect(pickToSelection({ object: { not: "a feature" }, layer: { id: "osm-trails:lines" } }, known)).toBeNull();
    expect(pickToSelection(null, known)).toBeNull();
  });

  it("falls back to the feature center when deck gives no coordinate", () => {
    const sel = pickToSelection({ object: trail, layer: { id: "osm-trails:lines" } }, known);
    expect(sel?.lngLat[0]).toBeCloseTo(-120.1);
    expect(sel?.lngLat[1]).toBeCloseTo(39.1);
  });

  it("maps a vector tile feature by its tiles-<id> source to a plain GeoJSON copy", () => {
    const props = { name: "Eldorado National Forest", agency: "USFS" };
    const tileFeature = {
      id: 7,
      source: "tiles-public-lands",
      layer: { id: "tiles-public-lands" },
      geometry: { type: "Polygon" as const, coordinates: [[[-120, 38], [-119, 38], [-119, 39], [-120, 38]]] },
      properties: props,
    };
    const sel = pickToSelection({ feature: tileFeature, lngLat: [-119.5, 38.5], point: { x: 10, y: 20 } }, known);
    expect(sel).toEqual({
      layerId: "public-lands",
      feature: { type: "Feature", id: 7, geometry: tileFeature.geometry, properties: props },
      lngLat: [-119.5, 38.5],
      screen: { x: 10, y: 20 },
    });
    expect(sel?.feature.properties).not.toBe(props);
  });

  it("maps the polygon outline layer back to its layer and rejects unknown tile sources", () => {
    const outline = { layer: { id: "tiles-public-lands-line" }, geometry: { type: "Point" as const, coordinates: [0, 0] } };
    expect(pickToSelection({ feature: outline, lngLat: [0, 0] }, known)?.layerId).toBe("public-lands");
    const basemap = { source: "composite", layer: { id: "road" }, geometry: { type: "Point" as const, coordinates: [0, 0] } };
    expect(pickToSelection({ feature: basemap, lngLat: [0, 0] }, known)).toBeNull();
  });
});

describe("feature geometry helpers", () => {
  it("computes bbox and center", () => {
    expect(featureBBox(trail)).toEqual([-120.2, 39.0, -120.0, 39.2]);
    const [lng, lat] = featureCenter(trail)!;
    expect(lng).toBeCloseTo(-120.1);
    expect(lat).toBeCloseTo(39.1);
    expect(featureBBox({ type: "Feature", geometry: { type: "GeometryCollection", geometries: [] }, properties: {} })).toBeNull();
  });
  it("detects line features", () => {
    expect(isLineFeature(trail)).toBe(true);
    expect(isLineFeature({ ...trail, geometry: { type: "Point", coordinates: [0, 0] } })).toBe(false);
  });
});

describe("summarizeFeature", () => {
  it("names the feature, friendly-labels rows and moves ids into details", () => {
    const s = summarizeFeature(trail);
    expect(s.name).toBe("Rubicon Trail");
    expect(s.rows).toEqual([
      { key: "sac_scale", label: "Difficulty (SAC)", value: "mountain hiking" },
      { key: "surface", label: "Surface", value: "dirt" },
    ]);
    expect(s.details).toEqual([{ key: "osmId", label: "Osm id", value: "123" }]);
  });

  it("formats t as a date and v with the layer unit", () => {
    const fire: Feature = { ...trail, properties: { name: "Caldor", t: "2021-08-14", v: 221835, acres: 221835, year: 2021 } };
    const s = summarizeFeature(fire, "ac");
    expect(s.date).toBe("Aug 14, 2021");
    // `v` copies `acres`, so the stat is labelled Acres and the duplicate row is dropped.
    expect(s.value).toEqual({ key: "v", label: "Acres", value: "221,835 ac" });
    expect(s.rows).toEqual([{ key: "year", label: "Year", value: "2021" }]);
    const plain = summarizeFeature({ ...trail, properties: { v: 12.5 } }, "MW");
    expect(plain.value).toEqual({ key: "v", label: "Value", value: "12.5 MW" });
  });

  it("reads scores out of 100 and lists signals, parsing stringified vector tile objects", () => {
    const cell: Feature = {
      ...trail,
      properties: { h3: "8828308281fffff", v: 82, signals: JSON.stringify({ roadDistanceKm: 4.2, inWilderness: true, campsitesWithin2km: null }) },
    };
    const s = summarizeFeature(cell, "score");
    expect(s.name).toBeNull();
    expect(s.value?.value).toBe("82 / 100");
    expect(s.signals).toEqual([
      { key: "roadDistanceKm", label: "Nearest road", value: "4.2 km" },
      { key: "inWilderness", label: "In designated wilderness", value: "Yes" },
      { key: "campsitesWithin2km", label: "Campsites within 2 km", value: "n/a" },
    ]);
    expect(s.details.map((r) => r.key)).toEqual(["h3"]);
  });

  it("caps plain rows and spills the rest into details", () => {
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`field${i}`, i]));
    const s = summarizeFeature({ ...trail, properties: many }, undefined, 8);
    expect(s.rows).toHaveLength(8);
    expect(s.details).toHaveLength(4);
  });
});

describe("text helpers", () => {
  it("friendlyKey and formatDate", () => {
    expect(friendlyKey("trail_visibility")).toBe("Trail visibility");
    expect(friendlyKey("someCamelKey")).toBe("Some camel key");
    // A trail's own `informal` flag is not the popularity signal of the same name.
    expect(friendlyKey("informal")).toBe("Informal trail");
    expect(friendlyKey("informal", true)).toBe("Informal trails within 500 m");
    expect(formatDate("2021-08-14")).toBe("Aug 14, 2021");
    expect(formatDate("not a date")).toBe("not a date");
  });

  it("askAboutText names the layer and feature with a property summary", () => {
    const text = askAboutText("OSM trails", { layerId: "osm-trails", feature: trail, lngLat: [-120.1, 39.1] });
    expect(text).toBe(
      'Tell me about OSM trails "Rubicon Trail" (Difficulty (SAC): mountain hiking; Surface: dirt; at 39.1000, -120.1000).',
    );
  });
});

describe("pickPasses", () => {
  it("picks symbols without the terrain mesh, and draped areas through it only when there are some", () => {
    const layer = (id: string, props: Record<string, unknown>) => ({ id, props });
    const layers = [
      layer("wally-terrain", { pickable: true }),
      layer("campsites@3d:points", { pickable: true, terrainDrawMode: "offset" }),
      layer("fire-perimeters@3d:polygons:casing", { pickable: false, terrainDrawMode: "drape" }),
      layer("fire-perimeters@3d:polygons", { pickable: true, terrainDrawMode: "drape" }),
    ];
    expect(pickPassesOf(layers)).toEqual({ direct: ["campsites@3d:points"], draped: true });
    expect(pickPassesOf(layers.slice(0, 2))).toEqual({ direct: ["campsites@3d:points"], draped: false });
    expect(pickPassesOf([layer("trails:points", { pickable: true })])).toEqual({ direct: ["trails:points"], draped: false });
  });
});

describe("skipHoverPicking", () => {
  it("draws nothing in deck's hover pick, and everything elsewhere (the app picks on hover itself)", () => {
    expect(skipHoverPicking({ renderPass: "picking:hover" })).toBe(false);
    expect(skipHoverPicking({ renderPass: "picking:hover:z" })).toBe(false);
    expect(skipHoverPicking({ renderPass: "picking:query" })).toBe(true);
    expect(skipHoverPicking({ renderPass: "screen" })).toBe(true);
  });
});
