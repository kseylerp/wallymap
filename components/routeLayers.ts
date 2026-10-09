import type { Feature, FeatureCollection, LineString, Point } from "geojson";
import type {
  CircleLayerSpecification,
  ExpressionSpecification,
  GeoJSONSource,
  LayerSpecification,
  Map as MapboxMap,
  StyleSpecification,
  SymbolLayerSpecification,
} from "mapbox-gl";
import type { MapState, RouteState } from "@/lib/render/state";
import {
  DART_ICON_ID,
  dartIconSpec,
  directionDarts,
  mileMarkers,
  routeLayerSpecs,
  routeSourceId,
} from "@/lib/render/wally/routeLine";

/**
 * Draws `state.routes` with Mapbox layers (docs/superpowers/specs/2026-10-09-wallymap-m3-design.md §3). Each route
 * has one GeoJSON source `route-<id>` (with `lineMetrics` for the gradient) holding the line, its darts, its mile
 * markers and its waypoint pins, told apart by `kind`. The casing, the gradient line and the mile dots sit above
 * the style's roads and under its labels; the darts, the mile labels and the pins sit on top. Like `syncTileLayers`
 * this is a no-op until the style has loaded, and the map calls it again on `style.load` because a style swap
 * drops every source, layer and image.
 */

const PREFIX = "route-";
/** Data layers from components/mapTiles.ts. */
const DATA_PREFIXES = ["tiles-", "heat-"];
const SLATE = "#3A3A3C";
const LABEL_FONT = ["DIN Pro Medium", "Arial Unicode MS Regular"];
const UNITS = "mi" as const;

export const PIN_IMAGES = {
  start: { id: "pin-start", url: "/pins/start.svg" },
  end: { id: "pin-end", url: "/pins/default.svg" },
  via: { id: "pin-via", url: "/pins/default.svg" },
} as const;
/** Draw order among pins (higher on top): the coral start pin stays visible on a loop. */
const PIN_SORT = { start: 2, end: 1, via: 0 } as const;

type Kind = "line" | "dart" | "mile" | "pin";
const kindIs = (kind: Kind): ExpressionSpecification => ["==", ["get", "kind"], kind];

/** The route's line, darts, mile markers and pins as one collection. */
export function routeFeatures(route: RouteState): FeatureCollection {
  const line: Feature<LineString> = { type: "Feature", geometry: route.line, properties: { kind: "line" } };
  const darts = directionDarts(route.line).map((f) => ({ ...f, properties: { kind: "dart", ...f.properties } }));
  const miles = mileMarkers(route.line, UNITS).map((f) => ({ ...f, properties: { kind: "mile", ...f.properties } }));
  const pins: Feature<Point>[] = route.waypoints.map((w) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: w.lngLat },
    properties: { kind: "pin", icon: PIN_IMAGES[w.type].id, sort: PIN_SORT[w.type] },
  }));
  return { type: "FeatureCollection", features: [line, ...darts, ...miles, ...pins] };
}

/** Every Mapbox layer for route `id`: `below` goes under the data tiles and labels, `above` on top of everything. */
export function routeMapLayers(id: string): { below: LayerSpecification[]; above: LayerSpecification[] } {
  const source = routeSourceId(id);
  const [casing, line] = routeLayerSpecs(id);
  const mileDots: CircleLayerSpecification = {
    id: `${source}-mile-dots`,
    type: "circle",
    source,
    filter: kindIs("mile"),
    paint: {
      "circle-radius": 5,
      "circle-color": "#FFFFFF",
      "circle-stroke-color": SLATE,
      "circle-stroke-opacity": 0.45,
      "circle-stroke-width": 1.5,
      "circle-pitch-alignment": "map",
    },
  };
  const darts: SymbolLayerSpecification = {
    id: `${source}-darts`,
    type: "symbol",
    source,
    filter: kindIs("dart"),
    layout: {
      "icon-image": DART_ICON_ID,
      "icon-rotate": ["get", "bearing"],
      "icon-rotation-alignment": "map",
      "icon-pitch-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  };
  const mileLabels: SymbolLayerSpecification = {
    id: `${source}-mile-labels`,
    type: "symbol",
    source,
    filter: kindIs("mile"),
    layout: {
      "text-field": ["get", "label"],
      "text-font": LABEL_FONT,
      "text-size": 10,
      "text-anchor": "left",
      "text-offset": [0.9, 0],
      "text-allow-overlap": true,
    },
    paint: { "text-color": SLATE, "text-halo-color": "#FFFFFF", "text-halo-width": 1.4 },
  };
  const pins: SymbolLayerSpecification = {
    id: `${source}-pins`,
    type: "symbol",
    source,
    filter: kindIs("pin"),
    layout: {
      "icon-image": ["get", "icon"],
      "icon-anchor": "bottom",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "symbol-sort-key": ["get", "sort"],
    },
  };
  return { below: [casing, line, mileDots], above: [darts, mileLabels, pins] };
}

/**
 * Where route base layers go: under the style's label block, the run of symbol layers after its last road,
 * bridge and boundary line. Not under the first symbol layer: Outdoors has one-way arrows among its tunnels, which
 * would put the route under every road. Our own layers and the data layers (tiles-, heat-) are skipped, so a
 * raster drawn on top of the style does not move the route above the labels.
 */
export function routeBeforeId(styleLayers: readonly { id: string; type: string }[]): string | undefined {
  const style = styleLayers.filter((l) => ![PREFIX, ...DATA_PREFIXES].some((p) => l.id.startsWith(p)));
  let lastDrawn = -1;
  style.forEach((l, i) => {
    if (l.type !== "symbol" && l.type !== "sky") lastDrawn = i;
  });
  return style.slice(lastDrawn + 1).find((l) => l.type === "symbol")?.id;
}

function loadedStyle(map: MapboxMap): StyleSpecification | undefined {
  try {
    return map.getStyle();
  } catch {
    return undefined; // getStyle throws "Style is not done loading" before `style.load`.
  }
}

/** The route each map's source currently holds, so an unchanged route is not re-uploaded every sync. */
const uploaded = new WeakMap<MapboxMap, Map<string, RouteState>>();

function isOurs(layer: StyleSpecification["layers"][number]): boolean {
  return "source" in layer && typeof layer.source === "string" && layer.source.startsWith(PREFIX);
}

/** Makes the map's route sources and layers match `state.routes`. */
export function syncRouteLayers(map: MapboxMap, state: MapState): void {
  const style = loadedStyle(map);
  if (!style) return;
  let sent = uploaded.get(map);
  if (!sent) {
    sent = new Map();
    uploaded.set(map, sent);
  }
  const wantedSources = new Set<string>();
  const wantedLayers = new Set<string>();
  const beforeId = routeBeforeId(style.layers);
  for (const route of Object.values(state.routes ?? {})) {
    const id = routeSourceId(route.id);
    wantedSources.add(id);
    const source = map.getSource(id) as GeoJSONSource | undefined;
    if (!source) map.addSource(id, { type: "geojson", data: routeFeatures(route), lineMetrics: true });
    else if (sent.get(id) !== route) source.setData(routeFeatures(route));
    sent.set(id, route);
    const { below, above } = routeMapLayers(route.id);
    for (const spec of below) {
      wantedLayers.add(spec.id);
      if (!map.getLayer(spec.id)) map.addLayer(spec, beforeId);
    }
    for (const spec of above) {
      wantedLayers.add(spec.id);
      if (!map.getLayer(spec.id)) map.addLayer(spec);
    }
  }
  for (const layer of style.layers) {
    if (isOurs(layer) && !wantedLayers.has(layer.id) && map.getLayer(layer.id)) map.removeLayer(layer.id);
  }
  for (const [sourceId, spec] of Object.entries(style.sources)) {
    if (sourceId.startsWith(PREFIX) && spec.type === "geojson" && !wantedSources.has(sourceId) && map.getSource(sourceId)) {
      map.removeSource(sourceId);
      sent.delete(sourceId);
    }
  }
}

type ImageSpec = { id: string; url: string; width: number; height: number; pixelRatio: number };

/** The dart and the three waypoint pins (the pin SVGs are 68×88, drawn at 2x for a 34×44 pin). */
export function routeImageSpecs(): ImageSpec[] {
  return [
    dartIconSpec(),
    ...Object.values(PIN_IMAGES).map(({ id, url }) => ({ id, url, width: 68, height: 88, pixelRatio: 2 })),
  ];
}

/** Decoded images by id, shared across style swaps so only the first style waits for them. */
const decoded = new Map<string, Promise<HTMLImageElement>>();

function decode({ id, url, width, height }: ImageSpec): Promise<HTMLImageElement> {
  let pending = decoded.get(id);
  if (!pending) {
    const image = new Image(width, height);
    image.src = url;
    pending = image.decode().then(() => image);
    decoded.set(id, pending);
    // A failed load is retried on the next style.
    pending.catch(() => decoded.delete(id));
  }
  return pending;
}

/** Registers the route images on the current style (once per style; a style swap drops them). */
export function ensureRouteImages(map: MapboxMap): void {
  for (const spec of routeImageSpecs()) {
    if (map.hasImage(spec.id)) continue;
    decode(spec)
      .then((image) => {
        // The style may have changed, or the map been removed, while the image decoded.
        try {
          if (!map.hasImage(spec.id)) map.addImage(spec.id, image, { pixelRatio: spec.pixelRatio });
        } catch {
          // Map removed; nothing to draw on.
        }
      })
      .catch((error: unknown) => console.warn(`Route image ${spec.id} failed to load`, error));
  }
}
