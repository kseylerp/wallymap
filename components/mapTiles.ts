import type { FeatureCollection } from "geojson";
import type {
  CircleLayerSpecification,
  ExpressionSpecification,
  FillLayerSpecification,
  FogSpecification,
  GeoJSONSource,
  HeatmapLayerSpecification,
  LineLayerSpecification,
  Map as MapboxMap,
  StyleSpecification,
} from "mapbox-gl";
import type { StyleHints } from "@/layers/types";
import {
  hybridPaintOverrides,
  isHillshadeLayer,
  isWaterFill,
  occludingLayerIds,
  scaleOpacity,
  type PaintOverride,
  type StyleLayerLike,
} from "@/lib/render/hybridStyle";
import { hexToRgba } from "@/lib/render/deck";
import { featureCenter } from "@/lib/render/inspect";
import type { Basemap, MapState } from "@/lib/render/state";

const PREFIX = "tiles-";

/** Satellite data palette for land ownership (docs/superpowers/specs/2026-10-09-wildmap-restyle.md). */
const OWNERSHIP_COLORS = {
  federal: "#B9A6FF",
  state: "#9FC4FF",
  local: "#D9D4FF",
  private: "#EDEDEA",
} as const;

/** PAD-US manager abbreviations as decoded from the tiles, plus the raw PAD-US codes in case a rebuild uses them. */
const FEDERAL_AGENCIES = [
  "USFS", "BLM", "NPS", "FWS", "USBR", "BOR", "USACE", "DOD", "DOE", "TVA", "ARS", "NRCS", "NOAA", "BIA", "BOEM",
  "OTHF", "Federal", "FED",
];
const STATE_AGENCIES = ["State", "State Parks", "STAT", "SPR", "SDNR", "SFW", "SLB", "SDOL", "OTHS"];
const PRIVATE_AGENCIES = ["NGO", "Private", "PVT"];

/** True when the string expression starts with `prefix`. */
function startsWith(value: ExpressionSpecification, prefix: string): ExpressionSpecification {
  return ["==", ["slice", value, 0, prefix.length], prefix];
}

/**
 * A fill color that follows the land manager when features carry PAD-US `agency` / `designation` properties:
 * federal lavender, state blue, local or tribal pale lilac, private off-white. Features with neither property
 * (any other vector tile set) get `fallback`, the layer's own style color.
 */
export function ownershipFillColor(fallback: string): ExpressionSpecification {
  const designation: ExpressionSpecification = ["to-string", ["get", "designation"]];
  return [
    "case",
    ["has", "agency"],
    [
      "match",
      ["to-string", ["get", "agency"]],
      FEDERAL_AGENCIES,
      OWNERSHIP_COLORS.federal,
      STATE_AGENCIES,
      OWNERSHIP_COLORS.state,
      PRIVATE_AGENCIES,
      OWNERSHIP_COLORS.private,
      OWNERSHIP_COLORS.local,
    ],
    // About 7% of PAD-US features have no agency; their designation still says who holds them.
    ["has", "designation"],
    [
      "case",
      startsWith(designation, "Private"),
      OWNERSHIP_COLORS.private,
      startsWith(designation, "State"),
      OWNERSHIP_COLORS.state,
      ["any", startsWith(designation, "National"), startsWith(designation, "Federal"), startsWith(designation, "Military")],
      OWNERSHIP_COLORS.federal,
      OWNERSHIP_COLORS.local,
    ],
    fallback,
  ];
}

type VectorLayerSpec = FillLayerSpecification | LineLayerSpecification | CircleLayerSpecification;

/**
 * The Mapbox layers that draw one vector tile layer: a manager-colored fill plus a white outline for polygons,
 * else one line or circle layer in the style color. Every layer reads source `tiles-<id>`; the first layer is
 * `tiles-<id>`, the polygon outline `tiles-<id>-line`.
 */
export function vectorTileLayerSpecs(
  id: string,
  style: StyleHints,
  sourceLayer: string,
  geometry: "point" | "line" | "polygon",
  visible: boolean,
  /** The layer panel's color and opacity (render op), when set. */
  paint: { color?: string; opacity?: number } = {},
): VectorLayerSpec[] {
  const layerId = `${PREFIX}${id}`;
  const color = paint.color ?? style.color;
  const opacity = Math.min(1, Math.max(0, paint.opacity ?? 1));
  const common = { source: layerId, "source-layer": sourceLayer };
  const layout = { visibility: visible ? ("visible" as const) : ("none" as const) };
  if (geometry === "polygon") {
    return [
      {
        id: layerId,
        type: "fill",
        ...common,
        layout,
        paint: { "fill-color": ownershipFillColor(color), "fill-opacity": 0.28 * opacity },
      },
      {
        id: `${layerId}-line`,
        type: "line",
        ...common,
        layout: { ...layout, "line-join": "round" },
        paint: { "line-color": "#FFFFFF", "line-width": 1.5, "line-opacity": 0.9 * opacity },
      },
    ];
  }
  if (geometry === "line") {
    return [
      {
        id: layerId,
        type: "line",
        ...common,
        layout: { ...layout, "line-join": "round", "line-cap": "round" },
        paint: { "line-color": color, "line-width": 2, "line-opacity": 0.9 * opacity },
      },
    ];
  }
  return [
    {
      id: layerId,
      type: "circle",
      ...common,
      layout,
      paint: {
        "circle-color": color,
        "circle-radius": 4,
        "circle-stroke-color": "#FFFFFF",
        "circle-stroke-width": 1,
        "circle-opacity": opacity,
        "circle-stroke-opacity": opacity,
      },
    },
  ];
}

/** The first label (symbol) layer, so data drawn before it sits under place names; undefined puts it on top. */
export function insertBeforeId(styleLayers: readonly { id: string; type: string }[]): string | undefined {
  return styleLayers.find((layer) => layer.type === "symbol")?.id;
}

const RASTER_OPACITY = 0.8;
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Loaded layers bottom first: render-op order, then any layer without an op. */
function layersInRenderOrder(state: MapState) {
  const ordered = state.renderOps.map((op) => state.layers[op.layerId]).filter((l) => l !== undefined);
  const rest = Object.values(state.layers).filter((l) => !state.renderOps.some((op) => op.layerId === l.id));
  return [...ordered, ...rest];
}

/**
 * The style JSON once it has loaded, else undefined. `map.isStyleLoaded()` is not used as the gate
 * because it stays false while any basemap tile is in flight, which would skip most syncs.
 */
function loadedStyle(map: MapboxMap): StyleSpecification | undefined {
  try {
    return map.getStyle();
  } catch {
    return undefined; // getStyle throws "Style is not done loading" before `style.load`.
  }
}

/** Drops a tiles source (and every layer drawing from it) when its type or tile URL no longer matches. */
function dropStaleSource(map: MapboxMap, style: StyleSpecification, id: string, type: "raster" | "vector", url: string) {
  const existing = style.sources[id];
  if (!existing) return;
  const existingUrl = existing.type === "raster" || existing.type === "vector" ? existing.tiles?.[0] : undefined;
  if (existing.type === type && existingUrl === url) return;
  for (const layer of style.layers) {
    if ("source" in layer && layer.source === id && map.getLayer(layer.id)) map.removeLayer(layer.id);
  }
  if (map.getSource(id)) map.removeSource(id);
}

/**
 * Makes the map's tile sources/layers match the `kind: "tiles"` results in `state`: raster tiles as one raster
 * layer, vector tiles as fill/line/circle layers under the labels. No-op until the style is loaded; callers
 * re-run it on `style.load` because a style swap drops sources.
 */
export function syncTileLayers(map: MapboxMap, state: MapState): void {
  const style = loadedStyle(map);
  if (!style) return;

  const wantedLayers = new Set<string>();
  const wantedSources = new Set<string>();
  /** Our Mapbox layer ids, bottom first, in render-op order (the layer panel's drag order). */
  const order: string[] = [];
  /** Rasters sit on top of the style and vector layers under its labels; restacking keeps each where it was. */
  const rasterIds = new Set<string>();
  const beforeId = insertBeforeId(style.layers);
  for (const loaded of layersInRenderOrder(state)) {
    if (loaded.result.kind !== "tiles") continue;
    const id = `${PREFIX}${loaded.id}`;
    const { url, minzoom, maxzoom, format, tileSize, sourceLayer, geometry } = loaded.result.data;
    // Honor a hide toggle if the agent has issued a render op for this layer.
    const op = state.renderOps.find((o) => o.layerId === loaded.id);
    const visible = !(op && !op.visible);
    const opacity = Math.min(1, Math.max(0, op?.opacity ?? 1));

    if (format === "vector") {
      if (!sourceLayer) {
        console.warn(`Skipping vector tile layer "${loaded.id}": the result has no sourceLayer.`);
        continue;
      }
      wantedSources.add(id);
      // A reloaded layer may point at a new tile URL; sources cannot change URL in place.
      dropStaleSource(map, style, id, "vector", url);
      if (!map.getSource(id)) map.addSource(id, { type: "vector", tiles: [url], minzoom, maxzoom });
      const color = op?.color && HEX.test(op.color.trim()) ? op.color.trim() : undefined;
      const specs = vectorTileLayerSpecs(loaded.id, loaded.style, sourceLayer, geometry ?? loaded.style.geometry, visible, {
        color,
        opacity,
      });
      for (const spec of specs) {
        wantedLayers.add(spec.id);
        order.push(spec.id);
        if (!map.getLayer(spec.id)) {
          map.addLayer(spec, beforeId);
          continue;
        }
        map.setLayoutProperty(spec.id, "visibility", visible ? "visible" : "none");
        // Mapbox skips a paint update whose value is unchanged, so re-applying every sync is cheap.
        for (const [property, value] of Object.entries(spec.paint ?? {})) {
          map.setPaintProperty(spec.id, property as never, value as never);
        }
      }
      continue;
    }

    wantedSources.add(id);
    wantedLayers.add(id);
    order.push(id);
    rasterIds.add(id);
    dropStaleSource(map, style, id, "raster", url);
    if (!map.getSource(id)) {
      map.addSource(id, { type: "raster", tiles: [url], minzoom, maxzoom, tileSize: tileSize ?? 256 });
    }
    if (!map.getLayer(id)) {
      map.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": RASTER_OPACITY * opacity } });
    }
    map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    map.setPaintProperty(id, "raster-opacity", RASTER_OPACITY * opacity);
  }

  // Restack when the layer panel reordered layers that were already on the map (new ones arrive in order).
  const current = style.layers.map((l) => l.id).filter((id) => order.includes(id));
  const expected = order.filter((id) => current.includes(id));
  if (current.join("|") !== expected.join("|")) {
    for (const id of order) if (map.getLayer(id)) map.moveLayer(id, rasterIds.has(id) ? undefined : beforeId);
  }

  for (const layer of style.layers) {
    if (layer.id.startsWith(PREFIX) && !wantedLayers.has(layer.id) && map.getLayer(layer.id)) map.removeLayer(layer.id);
  }
  for (const sourceId of Object.keys(style.sources)) {
    if (sourceId.startsWith(PREFIX) && !wantedSources.has(sourceId) && map.getSource(sourceId)) map.removeSource(sourceId);
  }
}

/* ---------- Heat mode ---------- */

const HEAT_PREFIX = "heat-";

/**
 * One point per feature for the heatmap (lines and polygons contribute their center), weighted by `v` scaled
 * to 0..1 against the largest `v` (default 1), so acres and scores heat alike.
 */
export function heatPointsCollection(data: FeatureCollection): FeatureCollection {
  const raw = data.features.map((f) => {
    const v = Number(f.properties?.v ?? 1);
    return Number.isFinite(v) && v > 0 ? v : 1;
  });
  const max = Math.max(1e-9, ...raw);
  const features: FeatureCollection["features"] = [];
  data.features.forEach((f, i) => {
    const w = raw[i] / max;
    const positions =
      f.geometry?.type === "Point"
        ? [f.geometry.coordinates]
        : f.geometry?.type === "MultiPoint"
          ? f.geometry.coordinates
          : [featureCenter(f)].filter((p) => p !== null);
    for (const position of positions) {
      features.push({ type: "Feature", geometry: { type: "Point", coordinates: position.slice(0, 2) }, properties: { w } });
    }
  });
  return { type: "FeatureCollection", features };
}

/** Heat color: transparent, then a warm yellow-to-red ramp, or a tint-to-`color` ramp when one was picked. */
export function heatColor(color: string | undefined): ExpressionSpecification {
  const stops: [number, string][] = color
    ? (() => {
        const [r, g, b] = hexToRgba(color);
        const mix = (t: number) =>
          `rgba(${[r, g, b].map((c) => Math.round(255 + (c - 255) * t)).join(",")},${Math.round((0.2 + 0.75 * t) * 100) / 100})`;
        return [
          [0.15, mix(0.2)],
          [0.4, mix(0.45)],
          [0.7, mix(0.75)],
          [1, mix(1)],
        ];
      })()
    : [
        [0.15, "rgba(255,237,160,0.55)"],
        [0.4, "rgba(254,178,76,0.75)"],
        [0.7, "rgba(240,59,32,0.85)"],
        [1, "rgba(189,0,38,0.95)"],
      ];
  return ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(0,0,0,0)", ...stops.flat()] as ExpressionSpecification;
}

export function heatLayerSpec(layerId: string, opacity: number, color: string | undefined): HeatmapLayerSpecification {
  const id = `${HEAT_PREFIX}${layerId}`;
  return {
    id,
    type: "heatmap",
    source: id,
    paint: {
      "heatmap-weight": ["get", "w"],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 4, 8, 16, 14, 34],
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 0.6, 14, 1.2],
      "heatmap-opacity": Math.min(1, Math.max(0, opacity)) * 0.9,
      "heatmap-color": heatColor(color),
    },
  };
}

/** The geojson result each map last received per heat source, so a data upload happens only on change. */
const heatData = new WeakMap<MapboxMap, Map<string, FeatureCollection>>();

/**
 * Makes the map's Mapbox heatmap layers match the visible `heat` render ops. Mapbox draws heat (not deck)
 * because deck's HeatmapLayer renders nothing in globe projection. No-op until the style is loaded.
 */
export function syncHeatLayers(map: MapboxMap, state: MapState): void {
  const style = loadedStyle(map);
  if (!style) return;
  const beforeId = insertBeforeId(style.layers);
  let uploaded = heatData.get(map);
  if (!uploaded) {
    uploaded = new Map();
    heatData.set(map, uploaded);
  }
  const wanted = new Set<string>();
  for (const op of state.renderOps) {
    const loaded = state.layers[op.layerId];
    if (op.mode !== "heat" || !op.visible || loaded?.result.kind !== "geojson") continue;
    const id = `${HEAT_PREFIX}${op.layerId}`;
    wanted.add(id);
    const data = loaded.result.data;
    const source = map.getSource(id) as GeoJSONSource | undefined;
    if (!source) map.addSource(id, { type: "geojson", data: heatPointsCollection(data) });
    else if (uploaded.get(id) !== data) source.setData(heatPointsCollection(data));
    uploaded.set(id, data);
    const color = op.color && HEX.test(op.color.trim()) ? op.color.trim() : undefined;
    const spec = heatLayerSpec(op.layerId, op.opacity ?? 1, color);
    if (!map.getLayer(id)) map.addLayer(spec, beforeId);
    else for (const [property, value] of Object.entries(spec.paint ?? {})) map.setPaintProperty(id, property as never, value as never);
  }
  for (const layer of style.layers) {
    if (layer.id.startsWith(HEAT_PREFIX) && !wanted.has(layer.id) && map.getLayer(layer.id)) map.removeLayer(layer.id);
  }
  for (const sourceId of Object.keys(style.sources)) {
    if (sourceId.startsWith(HEAT_PREFIX) && !wanted.has(sourceId) && map.getSource(sourceId)) {
      map.removeSource(sourceId);
      uploaded.delete(sourceId);
    }
  }
}

const SATELLITE_ID = "wildmap-satellite";
const SATELLITE_OPACITY = 0.9;
/** Terrain shading stays, but lighter, so it adds relief without muddying the photo. */
const HILLSHADE_SCALE = 0.5;
/** Water reads as solid (hiding seams in the imagery mosaic) but slightly translucent. */
const WATER_SCALE = 0.9;

/** A CSS custom property from `:root` (see app/globals.css), or undefined outside a browser or when unset. */
function cssToken(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || undefined;
}

/** Outdoors' white fog washes out imagery; a clearer, bluer atmosphere suits a satellite globe. */
function hybridFog(): FogSpecification {
  const fog: FogSpecification = { range: [0.8, 8], "horizon-blend": 0.03, "star-intensity": 0.3 };
  const color = cssToken("--fog-color");
  const high = cssToken("--fog-high-color");
  const space = cssToken("--fog-space-color");
  if (color) fog.color = color;
  if (high) fog["high-color"] = high;
  if (space) fog["space-color"] = space;
  return fog;
}

type HybridMemo = {
  hidden: string[];
  /** Paint values the hybrid changed (hillshade, water, boundaries, labels), with their originals. */
  paint: PaintOverride[];
  fog: FogSpecification | null | undefined;
};
/** What the hybrid changed on each map's current style, so switching back to plain Outdoors can undo it. */
const hybridMemo = new WeakMap<MapboxMap, HybridMemo>();
/** Warn once per page if a style update leaves the hybrid with nothing to hide. */
let warnedNoOccluders = false;

/** Index of the last background/land layer near the bottom of the stack; imagery goes right above it. */
function baseLayerIndex(layers: StyleSpecification["layers"]): number {
  let index = -1;
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (layer.type === "background" || layer.id === "land") index = i;
    else if (index !== -1) break;
  }
  return index;
}

function dimLayer(map: MapboxMap, layer: StyleSpecification["layers"][number], factor: number, memo: HybridMemo): void {
  const property =
    layer.type === "fill" ? "fill-opacity" : layer.type === "hillshade" ? "hillshade-exaggeration" : null;
  if (!property) return;
  const value: unknown = map.getPaintProperty(layer.id, property as never);
  memo.paint.push({ id: layer.id, property, value });
  map.setPaintProperty(layer.id, property as never, scaleOpacity(value, factor) as never);
}

function overridePaint(map: MapboxMap, { id, property, value }: PaintOverride, memo: HybridMemo): void {
  memo.paint.push({ id, property, value: map.getPaintProperty(id, property as never) });
  map.setPaintProperty(id, property as never, value as never);
}

/**
 * Makes the `outdoors-satellite` hybrid match `basemap`: on, it adds the Mapbox satellite raster just above
 * the Outdoors land layer, hides the area fills and park/land-use outlines that would cover it, thins the
 * hillshade and water, whitens boundaries and labels; off, it undoes that. Idempotent; callers run it on `style.load` and when switching between basemaps that share a style.
 */
export function syncSatelliteHybrid(map: MapboxMap, basemap: Basemap): void {
  const style = loadedStyle(map);
  if (!style) return;
  const wanted = basemap === "outdoors-satellite";
  const memo = hybridMemo.get(map);
  const active = Boolean(map.getLayer(SATELLITE_ID));

  if (wanted && !active) {
    const next: HybridMemo = { hidden: [], paint: [], fog: map.getFog() };
    if (!map.getSource(SATELLITE_ID)) {
      map.addSource(SATELLITE_ID, { type: "raster", url: "mapbox://mapbox.satellite", tileSize: 256 });
    }
    const beforeId = style.layers[baseLayerIndex(style.layers) + 1]?.id;
    map.addLayer(
      { id: SATELLITE_ID, type: "raster", source: SATELLITE_ID, paint: { "raster-opacity": SATELLITE_OPACITY } },
      beforeId,
    );
    for (const layer of style.layers) {
      if (isHillshadeLayer(layer as StyleLayerLike)) dimLayer(map, layer, HILLSHADE_SCALE, next);
      else if (isWaterFill(layer as StyleLayerLike)) dimLayer(map, layer, WATER_SCALE, next);
    }
    for (const override of hybridPaintOverrides(style.layers as StyleLayerLike[])) overridePaint(map, override, next);
    for (const id of occludingLayerIds(style.layers as StyleLayerLike[])) {
      map.setLayoutProperty(id, "visibility", "none");
      next.hidden.push(id);
    }
    if (next.hidden.length === 0 && !warnedNoOccluders) {
      warnedNoOccluders = true;
      console.warn("outdoors-satellite: no Outdoors fill or outline layers matched, so the imagery may be covered. Check the style's layer ids.");
    }
    map.setFog(hybridFog());
    hybridMemo.set(map, next);
    return;
  }

  if (!wanted && active) {
    map.removeLayer(SATELLITE_ID);
    if (map.getSource(SATELLITE_ID)) map.removeSource(SATELLITE_ID);
    if (memo) {
      for (const id of memo.hidden) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "visible");
      // Restore in reverse so a property changed twice ends on its original value.
      for (const { id, property, value } of [...memo.paint].reverse()) {
        if (map.getLayer(id)) map.setPaintProperty(id, property as never, value as never);
      }
      map.setFog(memo.fog ?? null);
    }
    hybridMemo.delete(map);
  }
}
