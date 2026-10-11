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
import { compareBaseId, compareBId, compareSideShown, effectiveMode } from "@/lib/render/compareView";
import { hatchImage, hatchPatternId, HATCH_SCALE } from "@/lib/render/hatch";
import { areaRecipe, DARK_GREY, isPaletteColor, LINE, SYMBOL, WHITE, type HatchColor } from "@/lib/render/palette";
import { rampColor, rgbaString } from "@/lib/render/ramp";
import { rasterPaint } from "@/lib/render/rasterCalm";
import { featureCenter } from "@/lib/render/inspect";
import type { Basemap, MapState } from "@/lib/render/state";

const PREFIX = "tiles-";

/**
 * Vector tile areas (public lands) draw with the deck area recipe (lib/render/palette.ts): a tint of the role color
 * (sage for protected land) fading with zoom so trails and symbols read at trailhead zooms, a 45° hatch in the same
 * color (Mapbox `fill-pattern`, images from lib/render/hatch.ts), and a dark grey outline over a white casing. The
 * PAD-US `agency` stays in the picked properties but draws nothing.
 */
export function landFillOpacity(opacity = 1, tint = 0.12): ExpressionSpecification {
  const stops: [number, number][] = [
    [9, tint],
    [12, tint * 0.8],
    [13.5, tint * 0.5],
    [15, tint * 0.3],
  ];
  return ["interpolate", ["linear"], ["zoom"], ...stops.flatMap(([z, o]) => [z, Math.round(o * opacity * 1000) / 1000])];
}

/** The hatch over vector tile areas: full strength regionally, half by trailhead zooms. */
export function landHatchOpacity(opacity = 1, alpha = 0.9): ExpressionSpecification {
  const at = (o: number) => Math.round(o * alpha * opacity * 1000) / 1000;
  return ["interpolate", ["linear"], ["zoom"], 12, at(1), 15, at(0.5)];
}

/** Polygon outlines on vector tiles: the outline over a white casing, at 80%. */
export const LAND_OUTLINE = { opacity: 0.8 } as const;

type VectorLayerSpec = FillLayerSpecification | LineLayerSpecification | CircleLayerSpecification;

/** The hatch pattern a vector tile area layer draws with (its id is a Mapbox image added by `ensureHatchImages`). */
export function vectorHatchPattern(id: string, color?: string): string {
  const recipe = areaRecipe(id, color);
  return hatchPatternId(recipe.color as HatchColor, recipe.step);
}

/**
 * The Mapbox layers that draw one vector tile layer: for polygons a tint (fading with zoom), a hatch, then an outline
 * over a white casing; lines dark grey over a white casing; points off-white circles stroked dark grey. Every layer
 * reads source `tiles-<id>`; picking queries `tiles-<id>` (the tint, the line core or the circles).
 */
export function vectorTileLayerSpecs(
  id: string,
  style: StyleHints,
  sourceLayer: string,
  geometry: "point" | "line" | "polygon",
  visible: boolean,
  /** The layer panel's color (a palette color only) and opacity (render op), when set. */
  paint: { color?: string; opacity?: number } = {},
): VectorLayerSpec[] {
  const layerId = `${PREFIX}${id}`;
  const requested = isPaletteColor(paint.color) ? paint.color.trim().toUpperCase() : undefined;
  const opacity = Math.min(1, Math.max(0, paint.opacity ?? 1));
  const common = { source: layerId, "source-layer": sourceLayer };
  const layout = { visibility: visible ? ("visible" as const) : ("none" as const) };
  if (geometry === "polygon") {
    const r = areaRecipe(id, requested);
    const lineLayout = { ...layout, "line-join": "round" as const };
    return [
      {
        id: layerId,
        type: "fill",
        ...common,
        layout,
        paint: { "fill-color": r.color, "fill-opacity": landFillOpacity(opacity, r.tint) },
      },
      {
        id: `${layerId}-hatch`,
        type: "fill",
        ...common,
        layout,
        paint: { "fill-pattern": vectorHatchPattern(id, requested), "fill-opacity": landHatchOpacity(opacity, r.hatchAlpha) },
      },
      {
        id: `${layerId}-casing`,
        type: "line",
        ...common,
        layout: lineLayout,
        paint: { "line-color": WHITE, "line-width": r.outlineWidth + 2 * r.casing, "line-opacity": LAND_OUTLINE.opacity * opacity },
      },
      {
        id: `${layerId}-line`,
        type: "line",
        ...common,
        layout: lineLayout,
        paint: { "line-color": r.outline, "line-width": r.outlineWidth, "line-opacity": LAND_OUTLINE.opacity * opacity },
      },
    ];
  }
  if (geometry === "line") {
    const lineLayout = { ...layout, "line-join": "round" as const, "line-cap": "round" as const };
    return [
      {
        id: `${layerId}-casing`,
        type: "line",
        ...common,
        layout: lineLayout,
        paint: { "line-color": WHITE, "line-width": LINE.casing, "line-opacity": LINE.casingOpacity * opacity },
      },
      {
        id: layerId,
        type: "line",
        ...common,
        layout: lineLayout,
        paint: { "line-color": requested ?? DARK_GREY, "line-width": LINE.width, "line-opacity": opacity },
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
        "circle-color": requested ?? SYMBOL.fill,
        "circle-radius": 4,
        "circle-stroke-color": SYMBOL.stroke,
        "circle-stroke-width": SYMBOL.strokeWidth,
        "circle-opacity": opacity * SYMBOL.fillOpacity,
        "circle-stroke-opacity": opacity,
      },
    },
  ];
}

/** Adds every hatch pattern the style needs as a Mapbox image (once per style: a style swap drops images). */
export function ensureHatchImages(map: MapboxMap, ids: Iterable<string>): void {
  for (const id of ids) {
    if (map.hasImage(id)) continue;
    const match = /^hatch-([0-9A-F]{6})-(\d)$/.exec(id);
    if (!match) continue;
    map.addImage(id, hatchImage(`#${match[1]}` as HatchColor, Number(match[2])), { pixelRatio: HATCH_SCALE });
  }
}

/** The first label (symbol) layer, so data drawn before it sits under place names; undefined puts it on top. */
export function insertBeforeId(styleLayers: readonly { id: string; type: string }[]): string | undefined {
  return styleLayers.find((layer) => layer.type === "symbol")?.id;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Loaded layers bottom first: render-op order (a compare's side B right above its side A), then any layer without an op. */
function layersInRenderOrder(state: MapState) {
  const ordered = state.renderOps
    .flatMap((op) => [state.layers[op.layerId], state.layers[compareBId(op.layerId)]])
    .filter((l) => l !== undefined);
  const placed = new Set(ordered.map((l) => l.id));
  const rest = Object.values(state.layers).filter((l) => !placed.has(l.id));
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
    // Honor a hide toggle if the agent has issued a render op for this layer (a compare's side B follows its layer's op).
    const op = state.renderOps.find((o) => o.layerId === compareBaseId(loaded.id));
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
      ensureHatchImages(
        map,
        specs.flatMap((spec) => (spec.type === "fill" && typeof spec.paint?.["fill-pattern"] === "string" ? [spec.paint["fill-pattern"]] : [])),
      );
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
    // A compare in toggle mode hides the side not showing by opacity, not visibility, so both sides keep their tiles
    // loaded and the 1 Hz flip is instant.
    const shown = compareSideShown(state, loaded.id) ? 1 : 0;
    // The layer's raster hint calms third-party colors (lib/render/rasterCalm.ts); paint only, so the scrubber and
    // compare keep working on the same source.
    const paint = rasterPaint(loaded.style.raster, opacity * shown);
    if (!map.getLayer(id)) {
      map.addLayer({ id, type: "raster", source: id, paint: { ...paint, "raster-opacity-transition": { duration: 0 } } });
    }
    map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    for (const [property, value] of Object.entries(paint)) map.setPaintProperty(id, property as never, value as never);
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

/** The lightest weight a feature takes in a heatmap: a zero (or tiny) `v` still marks where the feature is. */
export const HEAT_MIN_WEIGHT = 0.05;

/**
 * One point per feature for the heatmap (lines and polygons contribute their center), weighted by `v` over the 95th
 * percentile of the layer's positive `v` (nearest rank), clamped to [HEAT_MIN_WEIGHT, 1]: one huge fire no longer
 * shrinks every other weight toward zero, and a zero `v` gets the minimum weight. A layer with no positive `v` (and a
 * feature without a numeric `v`) weighs 1.
 */
export function heatPointsCollection(data: FeatureCollection): FeatureCollection {
  const values = data.features.map((f) => {
    const v = f.properties?.v;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  });
  const positive = values.filter((v): v is number => v !== null && v > 0).sort((a, b) => a - b);
  const scale = positive.length > 0 ? positive[Math.max(0, Math.ceil(0.95 * positive.length) - 1)] : 0;
  const weight = (v: number | null): number => {
    // No positive v anywhere: nothing to weigh by, so every feature counts the same.
    if (scale === 0 || v === null) return 1;
    return Math.min(1, Math.max(HEAT_MIN_WEIGHT, v / scale));
  };
  const features: FeatureCollection["features"] = [];
  data.features.forEach((f, i) => {
    const w = weight(values[i]);
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

/** Heat stops: (density, ramp position, alpha). Density 0 is transparent. */
const HEAT_STOPS: [number, number, number][] = [
  [0.2, 0.08, 0.35],
  [0.4, 0.35, 0.55],
  [0.6, 0.6, 0.7],
  [0.8, 0.82, 0.8],
  [1, 1, 0.85],
];

/**
 * Heat color: the density ramp (off-white → sage → purple → dark grey, OKLCH, lib/render/ramp.ts), growing more
 * opaque with density. The layer panel's color is ignored.
 */
export function heatColor(): ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["heatmap-density"],
    0,
    rgbaString(rampColor("density", 0), 0),
    ...HEAT_STOPS.flatMap(([d, t, a]) => [d, rgbaString(rampColor("density", t), a)]),
  ] as ExpressionSpecification;
}

export function heatLayerSpec(layerId: string, opacity: number): HeatmapLayerSpecification {
  const id = `${HEAT_PREFIX}${layerId}`;
  return {
    id,
    type: "heatmap",
    source: id,
    paint: {
      "heatmap-weight": ["get", "w"],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 6, 8, 26, 14, 50],
      // Wide and low, so a few hundred sightings in a valley still show the whole ramp (off-white, sage, purple) and
      // only the true hotspots reach dark grey; at 0.6 to 1.2 (radius 16 px at z8) every group saturated to a flat
      // dark grey blob.
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 0.12, 9, 0.18, 14, 0.45],
      "heatmap-opacity": Math.min(1, Math.max(0, opacity)) * 0.9,
      "heatmap-color": heatColor(),
    },
  };
}

/** The geojson result each map last received per heat source, so a data upload happens only on change. */
const heatData = new WeakMap<MapboxMap, Map<string, FeatureCollection>>();

/** One Mapbox heatmap to draw: its layer and source id, the data, the op's opacity, and whether it shows now. */
export type HeatEntry = { id: string; data: FeatureCollection; opacity: number; shown: boolean };

/**
 * The heatmaps `view` (the visible state, lib/render/view.ts) needs, one per visible `heat` op. A compared heat layer
 * is the exception, since Mapbox draws heat on the map's own canvas, which cannot be clipped to one side of a swipe:
 * a toggle compare gets one heatmap per side (side B under `heat-<id>~b`) with only the side on screen shown, so the
 * flip never re-uploads; a swipe draws its two sides as points in the clipped side overlays and a delta as its
 * discs (lib/render/deck.ts), so neither has a heatmap.
 */
export function heatEntries(view: MapState): HeatEntry[] {
  const entries: HeatEntry[] = [];
  const compare = view.compare;
  const compareMode = effectiveMode(view);
  for (const op of view.renderOps) {
    if (op.mode !== "heat" || !op.visible) continue;
    const opacity = op.opacity ?? 1;
    const compared = compare?.layerId === op.layerId && compareMode !== undefined;
    if (compared && compareMode !== "toggle") continue;
    const ids = compared ? [op.layerId, compareBId(op.layerId)] : [op.layerId];
    for (const id of ids) {
      const loaded = view.layers[id];
      if (loaded?.result.kind !== "geojson") continue;
      entries.push({ id: `${HEAT_PREFIX}${id}`, data: loaded.result.data, opacity, shown: compareSideShown(view, id) });
    }
  }
  return entries;
}

/**
 * Makes the map's Mapbox heatmap layers match `heatEntries(state)`. Mapbox draws heat (not deck) because deck's
 * HeatmapLayer renders nothing in globe projection. No-op until the style is loaded.
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
  for (const { id, data, opacity, shown } of heatEntries(state)) {
    wanted.add(id);
    const source = map.getSource(id) as GeoJSONSource | undefined;
    if (!source) map.addSource(id, { type: "geojson", data: heatPointsCollection(data) });
    else if (uploaded.get(id) !== data) source.setData(heatPointsCollection(data));
    uploaded.set(id, data);
    const spec = heatLayerSpec(id.slice(HEAT_PREFIX.length), opacity);
    const visibility = shown ? "visible" : "none";
    if (!map.getLayer(id)) map.addLayer({ ...spec, layout: { visibility } }, beforeId);
    else {
      for (const [property, value] of Object.entries(spec.paint ?? {})) map.setPaintProperty(id, property as never, value as never);
      map.setLayoutProperty(id, "visibility", visibility);
    }
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
