import type { FeatureCollection } from "geojson";
import { compareEntries, effectiveMode } from "@/lib/render/compareView";
import { applyFilters, type LayerFilters } from "@/lib/render/filters";
import { isAggregateFeature } from "@/lib/render/inspect";
import { activeFilters, fullWindow } from "@/lib/render/reducer";
import type { LoadedLayer, MapState, Selection } from "@/lib/render/state";
import { scenarioOf, scenarioTileUrl } from "@/lib/render/scenario";
import { filterByWindow, inWindow, tileUrlForTime, type TimeWindow } from "@/lib/time";

/**
 * How many derived versions of one layer are kept: up to 64 (a played year-by-year span fits) for small layers, fewer
 * for dense ones, since each version's data carries its own cluster index, hex bins and columns (lib/render/deck.ts).
 * About 32,000 features across a layer's versions, never fewer than 8 versions.
 */
const MAX_PER_LAYER = 64;
const MIN_PER_LAYER = 8;
const FEATURE_BUDGET = 32_000;

export function variantsKept(features: number): number {
  return Math.max(MIN_PER_LAYER, Math.min(MAX_PER_LAYER, Math.floor(FEATURE_BUDGET / Math.max(1, features))));
}

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
  const features = layer.result.kind === "geojson" ? layer.result.data.features.length : 0;
  if (byKey.size >= variantsKept(features)) byKey.clear();
  const next = derive();
  byKey.set(key, next);
  return next;
}

function withData(layer: LoadedLayer, data: FeatureCollection): LoadedLayer {
  if (layer.result.kind !== "geojson" || data === layer.result.data) return layer;
  return { ...layer, result: { ...layer.result, data } };
}

/** A layer's filters that restrict something, from its render op. */
function filtersOf(state: MapState, layerId: string): LayerFilters | undefined {
  return activeFilters(state.renderOps.find((op) => op.layerId === layerId)?.filters);
}

/** The scenario layer's tile URL at the scrubber's amount, or undefined when the scrubber is not on this layer. */
function scenarioUrl(state: MapState, layer: LoadedLayer): string | undefined {
  const contract = scenarioOf(layer);
  if (!contract || state.scenario?.layerId !== layer.id || !contract.values.includes(state.scenario.value)) return undefined;
  return scenarioTileUrl(contract, state.scenario.value);
}

function visibleLayer(
  layer: LoadedLayer,
  filters: LayerFilters | undefined,
  window: TimeWindow | undefined,
  rewriteTiles: boolean,
  scenario?: string,
): LoadedLayer {
  if (layer.result.kind === "geojson") {
    if (!window && !filters) return layer;
    const data = layer.result.data;
    const key = `f:${filters ? JSON.stringify(filters) : ""}|t:${window ? `${window[0]}|${window[1]}` : ""}`;
    return remember(layer, key, () => {
      const filtered = applyFilters(data, filters);
      // applyFilters copies even when it keeps everything; the original keeps deck from re-uploading.
      const kept = filtered.features.length === data.features.length ? data : filtered;
      return withData(layer, window ? filterByWindow(kept, window) : kept);
    });
  }
  const tiles = layer.result;
  // The scenario scrubber's amount; a layer that follows time is pointed at the window (no layer publishes both).
  const base = scenario ?? tiles.data.url;
  const url = window && rewriteTiles ? tileUrlForTime(base, tiles.data.time, window) : base;
  if (url === tiles.data.url) return layer;
  return remember(layer, `u:${url}`, () => ({ ...layer, result: { ...tiles, data: { ...tiles.data, url } } }));
}

/**
 * What the map, the layer counts, the inspect card and the export show: `state` with each GeoJSON layer's features
 * narrowed by its render op's attribute filters and to the time window (features without `t` always stay), and time-aware tile layers (night lights, forest
 * loss) pointed at the window's end once the window is narrower than the whole span, and a scenario tile layer (sea level
 * rise) pointed at the scenario scrubber's amount (`MapState.scenario`). Pure and memoized: the same
 * state gives the same object, the same layer and window give the same data object (so deck does not re-upload),
 * and nothing to narrow returns `state` itself. While a compare is on, the compared layer is replaced by its compare
 * entries (lib/render/compareView.ts): side A under its id and side B under `compareBId(id)`, or the delta collection.
 */
export function visibleState(state: MapState): MapState {
  const cached = stateMemo.get(state);
  if (cached) return cached;
  const window = activeWindow(state);
  const rewriteTiles = !isFullSpan(state);
  let changed = false;
  const layers: MapState["layers"] = {};
  const compare = state.compare;
  const mode = effectiveMode(state);
  for (const [id, layer] of Object.entries(state.layers)) {
    if (compare && mode && compare.layerId === id) {
      // The compared layer shows its two windows (or their delta) instead of the scrubber's window.
      Object.assign(layers, compareEntries(layer, filtersOf(state, id), compare, mode));
      changed = true;
      continue;
    }
    const next = visibleLayer(layer, filtersOf(state, id), window, rewriteTiles, scenarioUrl(state, layer));
    if (next !== layer) changed = true;
    layers[id] = next;
  }
  const out = changed ? { ...state, layers } : state;
  stateMemo.set(state, out);
  return out;
}

/**
 * Whether the selected feature is still drawn (inside the time window and the layer's filters); the inspect card
 * closes when it is not. The compared layer ignores the scrubber's window (compare wins, as in `visibleState`), and a
 * feature picked on side B stays inspectable only while a swipe or toggle compare of its layer draws side B.
 */
export function isSelectionVisible(state: MapState, selection: Selection): boolean {
  const compared = state.compare?.layerId === selection.layerId && effectiveMode(state) !== undefined;
  if (selection.side === "b") {
    const mode = effectiveMode(state);
    if (!compared || (mode !== "swipe" && mode !== "toggle")) return false;
  }
  const layer = state.layers[selection.layerId];
  // Vector tile features are not filtered (only GeoJSON layers are).
  if (layer?.result.kind !== "geojson") return true;
  // A hex tile, column or blob was built from the already filtered features: it has no `v` or `t` of its own, so
  // running the filters on it would close its card the moment any filter is on.
  if (isAggregateFeature(selection.feature)) return true;
  const filters = filtersOf(state, selection.layerId);
  if (filters && applyFilters({ type: "FeatureCollection", features: [selection.feature] }, filters).features.length === 0) {
    return false;
  }
  if (compared) return true;
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
