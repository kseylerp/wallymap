import type { FogSpecification, Map as MapboxMap, StyleSpecification } from "mapbox-gl";
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
/** Outdoors area fills that would paint over the imagery. Water, hillshade, contours, roads, paths and labels stay. */
const OCCLUDING_FILL = /^(landcover|landuse|national-park|land-structure-polygon|wetland|park|pitch|glacier|snow|sand|scrub|wood|grass|golf)/;
/** Terrain shading stays, but lighter, so it adds relief without muddying the photo. */
const HILLSHADE_SCALE = 0.5;
const HILLSHADE_FALLBACK_OPACITY = 0.3;
/** Outdoors' white fog washes out imagery; a clearer, bluer atmosphere suits a satellite globe. */
const HYBRID_FOG: FogSpecification = {
  range: [0.8, 8],
  color: "rgb(214, 222, 228)",
  "high-color": "rgb(70, 118, 186)",
  "horizon-blend": 0.03,
  "space-color": "rgb(12, 14, 20)",
  "star-intensity": 0.3,
};

type HybridMemo = {
  hidden: string[];
  hillshade: { id: string; property: string; value: unknown }[];
  fog: FogSpecification | null | undefined;
};
/** What the hybrid changed on each map's current style, so switching back to plain Outdoors can undo it. */
const hybridMemo = new WeakMap<MapboxMap, HybridMemo>();

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

function dimHillshade(map: MapboxMap, layer: StyleSpecification["layers"][number], memo: HybridMemo): void {
  const property =
    layer.type === "fill" ? "fill-opacity" : layer.type === "hillshade" ? "hillshade-exaggeration" : null;
  if (!property) return;
  const value: unknown = map.getPaintProperty(layer.id, property as never);
  memo.hillshade.push({ id: layer.id, property, value });
  // Zoom expressions must stay top-level, so only plain numbers (or the default of 1) can be scaled.
  const next =
    typeof value === "number" ? value * HILLSHADE_SCALE : value === undefined ? HILLSHADE_SCALE : HILLSHADE_FALLBACK_OPACITY;
  map.setPaintProperty(layer.id, property as never, next as never);
}

/**
 * Makes the `outdoors-satellite` hybrid match `basemap`: on, it adds the Mapbox satellite raster just above
 * the Outdoors land layer, hides the area fills that would cover it, and dims the hillshade; off, it undoes
 * that. Idempotent; callers run it on `style.load` and when switching between basemaps that share a style.
 */
export function syncSatelliteHybrid(map: MapboxMap, basemap: Basemap): void {
  const style = loadedStyle(map);
  if (!style) return;
  const wanted = basemap === "outdoors-satellite";
  const memo = hybridMemo.get(map);
  const active = Boolean(map.getLayer(SATELLITE_ID));

  if (wanted && !active) {
    const next: HybridMemo = { hidden: [], hillshade: [], fog: map.getFog() };
    if (!map.getSource(SATELLITE_ID)) {
      map.addSource(SATELLITE_ID, { type: "raster", url: "mapbox://mapbox.satellite", tileSize: 256 });
    }
    const beforeId = style.layers[baseLayerIndex(style.layers) + 1]?.id;
    map.addLayer(
      { id: SATELLITE_ID, type: "raster", source: SATELLITE_ID, paint: { "raster-opacity": SATELLITE_OPACITY } },
      beforeId,
    );
    for (const layer of style.layers) {
      if (layer.id.includes("hillshade")) {
        dimHillshade(map, layer, next);
      } else if (layer.type === "fill" && OCCLUDING_FILL.test(layer.id) && map.getLayoutProperty(layer.id, "visibility") !== "none") {
        map.setLayoutProperty(layer.id, "visibility", "none");
        next.hidden.push(layer.id);
      }
    }
    map.setFog(HYBRID_FOG);
    hybridMemo.set(map, next);
    return;
  }

  if (!wanted && active) {
    map.removeLayer(SATELLITE_ID);
    if (map.getSource(SATELLITE_ID)) map.removeSource(SATELLITE_ID);
    if (memo) {
      for (const id of memo.hidden) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "visible");
      for (const { id, property, value } of memo.hillshade) {
        if (map.getLayer(id)) map.setPaintProperty(id, property as never, value as never);
      }
      map.setFog(memo.fog ?? null);
    }
    hybridMemo.delete(map);
  }
}
