import type { FeatureCollection } from "geojson";
import { fullWindow } from "@/lib/render/reducer";
import type { LoadedLayer, MapState, Selection } from "@/lib/render/state";
import { filterByWindow, inWindow, tileUrlForTime, type TimeWindow } from "@/lib/time";

/** How many derived versions of one layer are kept (a played year-by-year span fits). */
const MAX_PER_LAYER = 64;

const stateMemo = new WeakMap<MapState, MapState>();
const layerMemo = new WeakMap<LoadedLayer, Map<string, LoadedLayer>>();

/** The scrubber's window, or undefined when there is no scrubber. */
function activeWindow(state: MapState): TimeWindow | undefined {
  return state.time?.window;
}

/** True when the window covers the data's whole span (the scrubber's opening state). */
function isFullSpan(state: MapState): boolean {
  if (!state.time) return true;
  const [lo, hi] = fullWindow(state.time.index);
  const [a, b] = state.time.window;
  return Date.parse(a) <= Date.parse(lo) && Date.parse(b) >= Date.parse(hi);
}

function remember(layer: LoadedLayer, key: string, derive: () => LoadedLayer): LoadedLayer {
  let byKey = layerMemo.get(layer);
  if (!byKey) {
    byKey = new Map();
    layerMemo.set(layer, byKey);
  }
  const hit = byKey.get(key);
  if (hit) return hit;
  if (byKey.size >= MAX_PER_LAYER) byKey.clear();
  const next = derive();
  byKey.set(key, next);
  return next;
}

function withData(layer: LoadedLayer, data: FeatureCollection): LoadedLayer {
  if (layer.result.kind !== "geojson" || data === layer.result.data) return layer;
  return { ...layer, result: { ...layer.result, data } };
}

function visibleLayer(layer: LoadedLayer, window: TimeWindow | undefined, rewriteTiles: boolean): LoadedLayer {
  if (layer.result.kind === "geojson") {
    if (!window) return layer;
    const data = layer.result.data;
    return remember(layer, `t:${window[0]}|${window[1]}`, () => withData(layer, filterByWindow(data, window)));
  }
  if (!window || !rewriteTiles) return layer;
  const tiles = layer.result;
  const url = tileUrlForTime(layer.id, tiles.data.url, window);
  if (url === tiles.data.url) return layer;
  return remember(layer, `u:${url}`, () => ({ ...layer, result: { ...tiles, data: { ...tiles.data, url } } }));
}

/**
 * What the map, the layer counts, the inspect card and the export show: `state` with each GeoJSON layer's features
 * narrowed to the time window (features without `t` always stay), and time-aware tile layers (night lights, forest
 * loss) pointed at the window's end once the window is narrower than the whole span. Pure and memoized: the same
 * state gives the same object, the same layer and window give the same data object (so deck does not re-upload),
 * and nothing to narrow returns `state` itself.
 */
export function visibleState(state: MapState): MapState {
  const cached = stateMemo.get(state);
  if (cached) return cached;
  const window = activeWindow(state);
  const rewriteTiles = !isFullSpan(state);
  let changed = false;
  const layers: MapState["layers"] = {};
  for (const [id, layer] of Object.entries(state.layers)) {
    const next = visibleLayer(layer, window, rewriteTiles);
    if (next !== layer) changed = true;
    layers[id] = next;
  }
  const out = changed ? { ...state, layers } : state;
  stateMemo.set(state, out);
  return out;
}

/** Whether the selected feature is still drawn (inside the time window); the inspect card closes when it is not. */
export function isSelectionVisible(state: MapState, selection: Selection): boolean {
  const window = activeWindow(state);
  if (!window) return true;
  const t = selection.feature.properties?.t;
  return inWindow(typeof t === "string" ? t : undefined, window);
}

/** Features shown and loaded for a GeoJSON layer, or null for tiles. */
export function featureCounts(state: MapState, layerId: string): { shown: number; total: number } | null {
  const layer = state.layers[layerId];
  if (!layer || layer.result.kind !== "geojson") return null;
  const shown = visibleState(state).layers[layerId];
  const total = layer.result.data.features.length;
  return { shown: shown?.result.kind === "geojson" ? shown.result.data.features.length : total, total };
}
