import type { FeatureCollection } from "geojson";
import { deltaFeatures, hexDelta, presetFor, splitWindows, type CompareMode, type CompareSpec } from "@/lib/render/compare";
import { applyFilters, type LayerFilters } from "@/lib/render/filters";
import type { CompareState, LoadedLayer, MapState } from "@/lib/render/state";
import { createStore } from "@/lib/render/wally/playback";
import { tileUrlForTime, type TimeWindow } from "@/lib/time";

/**
 * Compare over time, the view half (spec §7): what the map draws for the compared layer. The pure engine is
 * lib/render/compare.ts; this file turns a `MapState.compare` into layers. Swipe and toggle draw the layer twice: side
 * A under the layer's own id and side B under `compareBId(id)` (a view-only layer with no render op, so the layer
 * panel and the export never list it). Delta draws one collection whose features carry `delta` (a-only, b-only,
 * both). Tile layers (night lights, forest loss) become two raster sources and always compare by toggle.
 */

/** Approved palette (spec §11): side A purple, side B wally pink, unchanged dark grey. */
export const COMPARE_COLORS = { a: "#6E5BFF", b: "#F57272", both: "#3A3A3C" } as const;

/** Fill alpha for delta areas (12%, as hazard tints). */
export const DELTA_FILL_ALPHA = 0.12;

const B_SUFFIX = "~b";

/** The view-only id side B draws under. */
export function compareBId(layerId: string): string {
  return `${layerId}${B_SUFFIX}`;
}

/** The layer behind an id: side B's id maps back to its layer, any other id is itself. */
export function compareBaseId(id: string): string {
  return id.endsWith(B_SUFFIX) ? id.slice(0, -B_SUFFIX.length) : id;
}

/** Tile layers whose imagery is chosen by date (night lights) or year range (forest loss). */
export const TIME_TILE_LAYERS: ReadonlySet<string> = new Set(["night-lights", "forest-loss"]);

/** The layers that have a canned compare (presetFor). */
export const PRESET_LAYERS = ["forest-loss", "night-lights", "fire-perimeters"] as const;
export type PresetLayer = (typeof PRESET_LAYERS)[number];

export function hasPreset(layerId: string): layerId is PresetLayer {
  return (PRESET_LAYERS as readonly string[]).includes(layerId);
}

/** True when a layer can be compared: GeoJSON with dated features (`t`), or a date-driven tile layer. */
export function isComparable(layer: LoadedLayer): boolean {
  if (layer.result.kind === "tiles") return TIME_TILE_LAYERS.has(layer.id);
  return layer.result.data.features.some((f) => {
    const t = f.properties?.t;
    return typeof t === "string" && !Number.isNaN(Date.parse(t));
  });
}

/** Modes a layer supports: tiles have no features to split or diff, so they only toggle. */
export function modesFor(layer: LoadedLayer | undefined): CompareMode[] {
  return layer?.result.kind === "tiles" ? ["toggle"] : ["swipe", "toggle", "delta"];
}

/** The mode actually drawn: the asked-for mode when the layer supports it, else toggle. */
export function effectiveMode(state: MapState): CompareMode | undefined {
  const compare = state.compare;
  if (!compare) return undefined;
  return modesFor(state.layers[compare.layerId]).includes(compare.mode) ? compare.mode : "toggle";
}

/** True for features that are H3 cells (every feature has `h3`): their delta is a per-cell difference with heights. */
export function isHexCollection(fc: FeatureCollection): boolean {
  return fc.features.length > 0 && fc.features.every((f) => typeof f.properties?.h3 === "string" && f.properties.h3 !== "");
}

const YEAR = (iso: string): number => new Date(iso).getUTCFullYear();

/**
 * A date-driven tile URL pointed at one side's window: night lights shows the window's end date; forest loss shows the
 * loss from the window's start year to its end year (the scrubber's rewrite keeps the loaded start year instead).
 */
export function compareTileUrl(layerId: string, url: string, window: TimeWindow): string {
  const next = tileUrlForTime(layerId, url, window);
  if (layerId !== "forest-loss" || Number.isNaN(YEAR(window[0]))) return next;
  return next.replace(/([?&]start_year=)\d+/, `$1${Math.min(YEAR(window[0]), YEAR(window[1]))}`);
}

type Sides = { a: LoadedLayer; b: LoadedLayer; delta?: LoadedLayer };

/** Derived sides per layer object and compare key, so the same compare returns the same data (deck keeps its buffers). */
const memo = new WeakMap<LoadedLayer, Map<string, Sides>>();
const MAX_PER_LAYER = 16;

function withData(layer: LoadedLayer, data: FeatureCollection): LoadedLayer {
  if (layer.result.kind !== "geojson" || data === layer.result.data) return layer;
  return { ...layer, result: { ...layer.result, data } };
}

function withUrl(layer: LoadedLayer, id: string, url: string): LoadedLayer {
  if (layer.result.kind !== "tiles") return layer;
  if (id === layer.id && url === layer.result.data.url) return layer;
  return { ...layer, id, result: { ...layer.result, data: { ...layer.result.data, url } } };
}

function deriveSides(layer: LoadedLayer, filters: LayerFilters | undefined, spec: CompareSpec, withDelta: boolean): Sides {
  if (layer.result.kind === "tiles") {
    const url = layer.result.data.url;
    return {
      a: withUrl(layer, layer.id, compareTileUrl(layer.id, url, spec.a)),
      b: withUrl(layer, compareBId(layer.id), compareTileUrl(layer.id, url, spec.b)),
    };
  }
  const data = layer.result.data;
  const filtered = filters ? applyFilters(data, filters) : data;
  const { a, b } = splitWindows(filtered, spec);
  const sides: Sides = { a: withData(layer, a), b: { ...withData(layer, b), id: compareBId(layer.id) } };
  return withDelta ? withDeltaOf(layer, sides) : sides;
}

/** `sides` plus the delta of its two collections (side A and B objects kept, so deck keeps their buffers). */
function withDeltaOf(layer: LoadedLayer, sides: Sides): Sides {
  if (sides.a.result.kind !== "geojson" || sides.b.result.kind !== "geojson") return sides;
  const a = sides.a.result.data;
  const b = sides.b.result.data;
  const hex = isHexCollection({ type: "FeatureCollection", features: [...a.features, ...b.features] });
  return { ...sides, delta: withData(layer, hex ? hexDelta(a, b) : deltaFeatures(a, b)) };
}

/**
 * Side A, side B and (GeoJSON only, when `withDelta`: delta mode by default) the delta collection for `layer` under
 * `spec`, after the layer's filters. Memoized; the delta is only built when asked for.
 */
export function compareSides(
  layer: LoadedLayer,
  filters: LayerFilters | undefined,
  spec: CompareSpec,
  withDelta: boolean = spec.mode === "delta",
): Sides {
  let byKey = memo.get(layer);
  if (!byKey) {
    byKey = new Map();
    memo.set(layer, byKey);
  }
  const key = `${spec.a.join("|")}#${spec.b.join("|")}#${filters ? JSON.stringify(filters) : ""}`;
  const hit = byKey.get(key);
  if (hit && (hit.delta || !withDelta || layer.result.kind === "tiles")) return hit;
  if (hit) {
    const sides = withDeltaOf(layer, hit);
    byKey.set(key, sides);
    return sides;
  }
  if (byKey.size >= MAX_PER_LAYER) byKey.clear();
  const sides = deriveSides(layer, filters, spec, withDelta);
  byKey.set(key, sides);
  return sides;
}

/**
 * The view's entries for the compared layer, by id: delta mode puts the delta collection under the layer's id; swipe
 * and toggle put side A there and side B under `compareBId`. The scrubber's window does not apply (compare wins).
 */
export function compareEntries(layer: LoadedLayer, filters: LayerFilters | undefined, compare: CompareState, mode: CompareMode): Record<string, LoadedLayer> {
  const sides = compareSides(layer, filters, compare, mode === "delta");
  if (mode === "delta" && sides.delta) return { [layer.id]: sides.delta };
  return { [layer.id]: sides.a, [compareBId(layer.id)]: sides.b };
}

/**
 * Whether a drawn layer id is on screen: in toggle mode only the side showing is (A unless `side` is "b"); every
 * other layer, and both sides in swipe, always are.
 */
export function compareSideShown(state: MapState, id: string): boolean {
  const compare = state.compare;
  if (!compare || effectiveMode(state) !== "toggle") return true;
  if (id === compare.layerId) return compare.side !== "b";
  if (id === compareBId(compare.layerId)) return compare.side === "b";
  return true;
}

function isoDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * The compare the Compare button opens for a layer: its preset when it has one, else the dated span cut into two
 * halves (earlier half A, later half B), in the layer's natural mode (delta for features, toggle for tiles).
 */
export function defaultCompare(layer: LoadedLayer, today: Date): CompareState {
  if (hasPreset(layer.id)) return presetFor(layer.id, today);
  const mode: CompareMode = layer.result.kind === "tiles" ? "toggle" : "delta";
  let lo = Infinity;
  let hi = -Infinity;
  if (layer.result.kind === "geojson") {
    for (const f of layer.result.data.features) {
      const t = f.properties?.t;
      const ms = typeof t === "string" ? Date.parse(t) : NaN;
      if (Number.isNaN(ms)) continue;
      lo = Math.min(lo, ms);
      hi = Math.max(hi, ms);
    }
  }
  if (!Number.isFinite(lo)) {
    const end = today.toISOString().slice(0, 10);
    const start = `${today.getUTCFullYear() - 1}${end.slice(4)}`;
    return { layerId: layer.id, a: [start, start], b: [end, end], mode };
  }
  const mid = lo + (hi - lo) / 2;
  return {
    layerId: layer.id,
    a: [isoDay(new Date(lo).toISOString()), isoDay(new Date(mid).toISOString())],
    b: [isoDay(new Date(mid + 86_400_000).toISOString()), isoDay(new Date(hi).toISOString())],
    mode,
  };
}

/** True while the compared layer is hidden in the layer panel: nothing is drawn, so toggle does not tick. */
export function compareHidden(state: MapState): boolean {
  const compare = state.compare;
  return compare !== undefined && state.renderOps.find((op) => op.layerId === compare.layerId)?.visible === false;
}

/**
 * A window as people say it: "2015" for one whole year, "2016–2020" for whole years, "2021–today" when it runs from a
 * new year to today, else the days ("2020-01-01", "2024-03-01 – 2024-06-30").
 */
export function windowText([start, end]: [string, string], today: Date = new Date()): string {
  const s = start.slice(0, 10);
  const e = end.slice(0, 10);
  const yearStart = s.endsWith("-01-01");
  const endIsToday = e === today.toISOString().slice(0, 10);
  if (yearStart && e.endsWith("-12-31")) return s.slice(0, 4) === e.slice(0, 4) ? s.slice(0, 4) : `${s.slice(0, 4)}–${e.slice(0, 4)}`;
  if (s === e) return endIsToday ? "today" : s;
  if (yearStart && endIsToday) return `${s.slice(0, 4)}–today`;
  return `${s} – ${endIsToday ? "today" : e}`;
}

/**
 * Where the swipe handle sits, as a share of the map's width (0 = left edge). The handle writes it, the map clips its
 * two side canvases from it; React never re-renders for a drag.
 */
export const swipeStore = createStore<number>(0.5);
