import type { Map as MapboxMap } from "mapbox-gl";
import { describe, expect, it } from "vitest";
import {
  routeBeforeId,
  routeFeatures,
  routeImageSpecs,
  routeMapLayers,
  syncRouteLayers,
} from "@/components/routeLayers";
import { initialMapState, type MapState, type RouteState } from "@/lib/render/state";

type FakeLayer = { id: string; type: string; source?: string; layout?: Record<string, unknown> };
type FakeSource = { type: string; data?: unknown; lineMetrics?: boolean };

/** A stand-in for the Mapbox map that records every mutating call. */
function fakeMap(initialLayers: FakeLayer[] = [{ id: "land", type: "background" }, { id: "road-label", type: "symbol" }]) {
  const layers: FakeLayer[] = initialLayers.map((l) => ({ ...l }));
  const sources: Record<string, FakeSource> = {};
  const calls: string[] = [];
  const map = {
    getStyle: () => ({ layers: layers.map((l) => ({ ...l })), sources: { ...sources } }),
    getLayer: (id: string) => layers.find((l) => l.id === id),
    getSource: (id: string) =>
      sources[id] && {
        ...sources[id],
        setData: (data: unknown) => {
          calls.push(`setData ${id}`);
          sources[id] = { ...sources[id], data };
        },
      },
    addSource: (id: string, spec: FakeSource) => {
      calls.push(`addSource ${id}`);
      sources[id] = spec;
    },
    removeSource: (id: string) => {
      calls.push(`removeSource ${id}`);
      delete sources[id];
    },
    addLayer: (spec: FakeLayer, beforeId?: string) => {
      calls.push(`addLayer ${spec.id}${beforeId ? ` before ${beforeId}` : ""}`);
      const index = beforeId ? layers.findIndex((l) => l.id === beforeId) : -1;
      if (index === -1) layers.push(spec);
      else layers.splice(index, 0, spec);
    },
    removeLayer: (id: string) => {
      calls.push(`removeLayer ${id}`);
      layers.splice(layers.findIndex((l) => l.id === id), 1);
    },
  };
  return { map: map as unknown as MapboxMap, calls, layers, sources };
}

/** About 3.3 km north from Tahoe City. */
const route = (id: string): RouteState => ({
  id,
  name: "Test route",
  line: { type: "LineString", coordinates: [[-120.14, 39.17], [-120.14, 39.2]] },
  source: "tool",
  distanceKm: 3.34,
  waypoints: [
    { lngLat: [-120.14, 39.17], type: "start" },
    { lngLat: [-120.14, 39.18], type: "via" },
    { lngLat: [-120.14, 39.2], type: "end" },
  ],
});

const withRoutes = (...routes: RouteState[]): MapState => ({
  ...initialMapState,
  routes: Object.fromEntries(routes.map((r) => [r.id, r])),
});

describe("routeFeatures", () => {
  it("holds the line, darts, mile markers and pins, told apart by kind", () => {
    const { features } = routeFeatures(route("a"));
    const kinds = features.map((f) => f.properties?.kind);
    expect(kinds.filter((k) => k === "line")).toHaveLength(1);
    expect(kinds.filter((k) => k === "dart")).toHaveLength(7);
    expect(features.filter((f) => f.properties?.kind === "mile").map((f) => f.properties?.label)).toEqual(["1 mi", "2 mi"]);
    expect(features.filter((f) => f.properties?.kind === "pin").map((f) => f.properties?.icon)).toEqual([
      "pin-start",
      "pin-via",
      "pin-end",
    ]);
  });
});

describe("routeMapLayers", () => {
  it("puts casing, gradient and mile dots below; darts, mile labels and pins above", () => {
    const { below, above } = routeMapLayers("a");
    expect(below.map((l) => l.id)).toEqual(["route-a-casing", "route-a-line", "route-a-mile-dots"]);
    expect(above.map((l) => l.id)).toEqual(["route-a-darts", "route-a-mile-labels", "route-a-pins"]);
    for (const layer of [...below, ...above]) expect(layer).toMatchObject({ source: "route-a" });
    expect(above[0]).toMatchObject({
      layout: { "icon-image": "route-dart", "icon-rotate": ["get", "bearing"], "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": false },
    });
    expect(above[2]).toMatchObject({ layout: { "icon-image": ["get", "icon"], "icon-anchor": "bottom" } });
    expect(below[2]).toMatchObject({
      type: "circle",
      paint: { "circle-color": "#FFFFFF", "circle-stroke-color": "#3A3A3C", "circle-stroke-opacity": 0.45 },
    });
    expect(above[1]).toMatchObject({ type: "symbol", layout: { "text-size": 10 } });
  });

  it("places routes under the label block, above roads and one-way arrows", () => {
    expect(routeBeforeId([{ id: "land", type: "fill" }, { id: "road-label", type: "symbol" }])).toBe("road-label");
    const outdoors = [
      { id: "land", type: "background" },
      { id: "tunnel-street", type: "line" },
      { id: "tunnel-oneway-arrow-blue", type: "symbol" },
      { id: "road-primary", type: "line" },
      { id: "tiles-public-lands", type: "fill" },
      { id: "route-a-casing", type: "line" },
      { id: "admin-0-boundary", type: "line" },
      { id: "contour-label", type: "symbol" },
      { id: "road-label", type: "symbol" },
      { id: "wally-sky", type: "sky" },
      { id: "route-a-darts", type: "symbol" },
      { id: "tiles-night-lights", type: "raster" },
    ];
    expect(routeBeforeId(outdoors)).toBe("contour-label");
    expect(routeBeforeId([{ id: "land", type: "fill" }])).toBeUndefined();
  });
});

describe("syncRouteLayers", () => {
  it("adds one lineMetrics GeoJSON source per route and its six layers", () => {
    const { map, layers, sources } = fakeMap();
    syncRouteLayers(map, withRoutes(route("a")));
    expect(sources["route-a"]).toMatchObject({ type: "geojson", lineMetrics: true });
    expect(layers.map((l) => l.id)).toEqual([
      "land",
      "route-a-casing",
      "route-a-line",
      "route-a-mile-dots",
      "road-label",
      "route-a-darts",
      "route-a-mile-labels",
      "route-a-pins",
    ]);
  });

  it("does nothing more when nothing changed, and re-uploads a replaced route", () => {
    const { map, calls } = fakeMap();
    const state = withRoutes(route("a"));
    syncRouteLayers(map, state);
    calls.length = 0;
    syncRouteLayers(map, state);
    expect(calls).toEqual([]);
    syncRouteLayers(map, withRoutes({ ...route("a"), distanceKm: 9 }));
    expect(calls).toEqual(["setData route-a"]);
  });

  it("removes a route's layers and source when it leaves the state, leaving the style alone", () => {
    const { map, layers, sources } = fakeMap([
      { id: "land", type: "background" },
      { id: "route-shields", type: "symbol", source: "composite" },
      { id: "road-label", type: "symbol" },
    ]);
    syncRouteLayers(map, withRoutes(route("a"), route("b")));
    syncRouteLayers(map, withRoutes(route("b")));
    expect(Object.keys(sources)).toEqual(["route-b"]);
    expect(layers.filter((l) => l.id.startsWith("route-a"))).toEqual([]);
    expect(layers.some((l) => l.id === "route-shields")).toBe(true);
    syncRouteLayers(map, initialMapState);
    expect(Object.keys(sources)).toEqual([]);
    expect(layers.map((l) => l.id)).toEqual(["land", "route-shields", "road-label"]);
  });

  it("is a no-op before the style loads", () => {
    const { map } = fakeMap();
    const unloaded = {
      ...map,
      getStyle: () => {
        throw new Error("Style is not done loading");
      },
    } as unknown as MapboxMap;
    expect(() => syncRouteLayers(unloaded, withRoutes(route("a")))).not.toThrow();
  });
});

describe("routeImageSpecs", () => {
  it("registers the dart and coral start, end and via pins at 2x", () => {
    expect(routeImageSpecs().map(({ id, url, pixelRatio }) => [id, url.startsWith("data:") ? "data" : url, pixelRatio])).toEqual([
      ["route-dart", "data", 2],
      ["pin-start", "/pins/start.svg", 2],
      ["pin-end", "/pins/default.svg", 2],
      ["pin-via", "/pins/default.svg", 2],
    ]);
  });
});
