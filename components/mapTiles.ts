import type { FogSpecification, Map as MapboxMap, StyleSpecification } from "mapbox-gl";
import {
  hybridPaintOverrides,
  isHillshadeLayer,
  isWaterFill,
  occludingLayerIds,
  scaleOpacity,
  type PaintOverride,
  type StyleLayerLike,
} from "@/lib/render/hybridStyle";
import type { Basemap, MapState } from "@/lib/render/state";

const PREFIX = "tiles-";

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

/**
 * Makes the map's raster sources/layers match the `kind: "tiles"` results in `state`.
 * No-op until the style is loaded; callers re-run it on `style.load` because a style swap drops sources.
 */
export function syncTileLayers(map: MapboxMap, state: MapState): void {
  const style = loadedStyle(map);
  if (!style) return;

  const wanted = new Set<string>();
  for (const loaded of Object.values(state.layers)) {
    if (loaded.result.kind !== "tiles") continue;
    const id = `${PREFIX}${loaded.id}`;
    const { url, minzoom, maxzoom, format } = loaded.result.data;
    if (format === "vector") {
      // Vector tile rendering arrives with its own task; skip rather than draw it as raster.
      console.warn(`Skipping vector tile layer "${loaded.id}": vector rendering is not supported yet.`);
      continue;
    }
    wanted.add(id);

    // A reloaded layer may point at a new tile URL; raster sources cannot change URL in place.
    const existing = style.sources[id];
    const existingUrl = existing?.type === "raster" ? existing.tiles?.[0] : undefined;
    if (existing && existingUrl !== url) {
      if (map.getLayer(id)) map.removeLayer(id);
      map.removeSource(id);
    }
    if (!map.getSource(id)) {
      map.addSource(id, { type: "raster", tiles: [url], minzoom, maxzoom, tileSize: 256 });
    }
    if (!map.getLayer(id)) {
      map.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": 0.8 } });
    }

    // Honor a hide toggle if the agent has issued a render op for this layer.
    const op = state.renderOps.find((o) => o.layerId === loaded.id);
    map.setLayoutProperty(id, "visibility", op && !op.visible ? "none" : "visible");
  }

  for (const layer of style.layers) {
    if (layer.id.startsWith(PREFIX) && !wanted.has(layer.id)) map.removeLayer(layer.id);
  }
  for (const sourceId of Object.keys(style.sources)) {
    if (sourceId.startsWith(PREFIX) && !wanted.has(sourceId)) map.removeSource(sourceId);
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
