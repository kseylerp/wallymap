import type { FeatureCollection } from "geojson";
import { deltaFeatures, hexDelta, presetFor, splitWindows, type CompareMode, type CompareSpec, type DeltaOptions } from "@/lib/render/compare";
import { applyFilters, type LayerFilters } from "@/lib/render/filters";
import type { CompareState, LoadedLayer, MapState } from "@/lib/render/state";
import { createStore } from "@/lib/render/wally/playback";
import { currentScenarioValue, scenarioOf, scenarioText, scenarioTileUrl } from "@/lib/render/scenario";
import type { TileTime } from "@/layers/types";
import { tileUrlForTime, type TimeWindow } from "@/lib/time";
import { versionSides, versionsAttribute } from "@/lib/render/attributes";
import { epochLabel, epochWindow, identityKey, snapshotEpochs } from "@/lib/render/change";
import { timeShape } from "@/lib/render/contract";
import { DELTA_COLORS } from "@/lib/render/palette";

/**
 * Compare over time, the view half (spec §7): what the map draws for the compared layer. The pure engine is
 * lib/render/compare.ts; this file turns a `MapState.compare` into layers. Swipe and toggle draw the layer twice: side
 * A under the layer's own id and side B under `compareBId(id)` (a view-only layer with no render op, so the layer
 * panel and the export never list it). Delta draws one collection whose features carry `delta` (a-only, b-only,
 * both). Tile layers (night lights, forest loss) become two raster sources and compare by toggle; a scenario tile layer
 * (sea level rise, `data.scenario`) compares two amounts instead of two windows, by swipe (lib/render/tileSides.ts draws
 * its sides in the clipped overlays) or toggle.
 */

/** Approved palette (spec §11, lib/render/palette.ts): side A purple, side B wally pink, unchanged dark grey. */
export { COMPARE_COLORS } from "@/lib/render/palette";

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

/** The layers that have a canned compare (presetFor). */
export const PRESET_LAYERS = ["forest-loss", "night-lights", "fire-perimeters"] as const;
export type PresetLayer = (typeof PRESET_LAYERS)[number];

export function hasPreset(layerId: string): layerId is PresetLayer {
  return (PRESET_LAYERS as readonly string[]).includes(layerId);
}

/**
 * The compare by version of a layer with a `versions` attribute (monument boundaries 2021 against current), or null: the
 * earliest version present as A, the newest as B, labelled in the attribute's words, delta (spec §12 change view).
 */
export function versionCompare(layer: LoadedLayer): CompareState | null {
  if (layer.result.kind !== "geojson") return null;
  const facet = versionsAttribute(layer);
  const sides = facet ? versionSides(facet, layer.result.data) : null;
  if (!facet || !sides) return null;
  return {
    layerId: layer.id,
    a: ["", ""],
    b: ["", ""],
    mode: "delta",
    by: { key: facet.key, a: sides.a.values, b: sides.b.values },
    aLabel: sides.a.label,
    bLabel: sides.b.label,
  };
}

/**
 * True when a layer can be compared: GeoJSON with dated features (`t`) or two versions (a `versions` attribute), or a tile
 * layer that publishes `data.time` or `data.scenario`.
 */
export function isComparable(layer: LoadedLayer): boolean {
  if (layer.result.kind === "tiles") return layer.result.data.time !== undefined || layer.result.data.scenario !== undefined;
  if (versionCompare(layer)) return true;
  return layer.result.data.features.some((f) => {
    const t = f.properties?.t;
    return typeof t === "string" && !Number.isNaN(Date.parse(t));
  });
}

/**
 * Modes a layer supports: tiles have no features to split or diff, so they toggle; a scenario tile layer also swipes
 * (its two amounts draw as deck bitmaps in the clipped side overlays, lib/render/tileSides.ts).
 */
export function modesFor(layer: LoadedLayer | undefined): CompareMode[] {
  if (layer?.result.kind !== "tiles") return ["swipe", "toggle", "delta"];
  return layer.result.data.scenario ? ["swipe", "toggle"] : ["toggle"];
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
 * A time tile URL pointed at one side's window: `{date}` layers show the window's end date; `{year}` layers show the
 * loss from the window's start year to its end year (the scrubber's rewrite keeps the loaded start year instead).
 */
export function compareTileUrl(url: string, time: TileTime | undefined, window: TimeWindow): string {
  const next = tileUrlForTime(url, time, window);
  if (!time?.template.includes("{year}") || Number.isNaN(YEAR(window[0]))) return next;
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

/** A compare's spec, with the two amounts of a scenario compare when it has them (CompareState["scenario"]). */
export type CompareSides = CompareSpec & Pick<CompareState, "scenario">;

function deriveSides(layer: LoadedLayer, filters: LayerFilters | undefined, spec: CompareSides, withDelta: boolean): Sides {
  if (layer.result.kind === "tiles") {
    const { url, time, scenario } = layer.result.data;
    // A scenario compare draws two amounts where a time compare draws two windows.
    if (scenario && spec.scenario) {
      return {
        a: withUrl(layer, layer.id, scenarioTileUrl(scenario, spec.scenario.a)),
        b: withUrl(layer, compareBId(layer.id), scenarioTileUrl(scenario, spec.scenario.b)),
      };
    }
    return {
      a: withUrl(layer, layer.id, compareTileUrl(url, time, spec.a)),
      b: withUrl(layer, compareBId(layer.id), compareTileUrl(url, time, spec.b)),
    };
  }
  const data = layer.result.data;
  const filtered = filters ? applyFilters(data, filters) : data;
  const { a, b } = splitWindows(filtered, spec);
  const sides: Sides = { a: withData(layer, a), b: { ...withData(layer, b), id: compareBId(layer.id) } };
  return withDelta ? withDeltaOf(layer, sides, spec) : sides;
}

/**
 * How a delta matches one thing on both sides: by the property that names it across dates or versions (a glacier's id,
 * a monument's name), so a glacier that shrank is "both" with its earlier edge, never "lost" and "new" at once.
 */
export function deltaOptions(layer: LoadedLayer, spec: Pick<CompareSpec, "by">): DeltaOptions {
  if (layer.result.kind !== "geojson") return {};
  const field = spec.by?.key ?? layer.style.timeField ?? "t";
  const idKey = identityKey(layer.result.data.features, field);
  const measureKey = layer.result.data.features.some((f) => typeof f.properties?.areaKm2 === "number") ? "areaKm2" : undefined;
  return { ...(idKey && { idKey }), timeField: layer.style.timeField ?? "t", ...(measureKey && { measureKey }) };
}

/** `sides` plus the delta of its two collections (side A and B objects kept, so deck keeps their buffers). */
function withDeltaOf(layer: LoadedLayer, sides: Sides, spec: Pick<CompareSpec, "by">): Sides {
  if (sides.a.result.kind !== "geojson" || sides.b.result.kind !== "geojson") return sides;
  const a = sides.a.result.data;
  const b = sides.b.result.data;
  const hex = isHexCollection({ type: "FeatureCollection", features: [...a.features, ...b.features] });
  return { ...sides, delta: withData(layer, hex ? hexDelta(a, b) : deltaFeatures(a, b, deltaOptions(layer, spec))) };
}

/**
 * Side A, side B and (GeoJSON only, when `withDelta`: delta mode by default) the delta collection for `layer` under
 * `spec`, after the layer's filters. Memoized; the delta is only built when asked for.
 */
export function compareSides(
  layer: LoadedLayer,
  filters: LayerFilters | undefined,
  spec: CompareSides,
  withDelta: boolean = spec.mode === "delta",
): Sides {
  let byKey = memo.get(layer);
  if (!byKey) {
    byKey = new Map();
    memo.set(layer, byKey);
  }
  const amounts = spec.scenario ? `${spec.scenario.a}~${spec.scenario.b}` : "";
  const by = spec.by ? JSON.stringify(spec.by) : "";
  const key = `${spec.a.join("|")}#${spec.b.join("|")}#${filters ? JSON.stringify(filters) : ""}#${amounts}#${by}`;
  const hit = byKey.get(key);
  if (hit && (hit.delta || !withDelta || layer.result.kind === "tiles")) return hit;
  if (hit) {
    const sides = withDeltaOf(layer, hit, spec);
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
export function defaultCompare(layer: LoadedLayer, today: Date, state?: Pick<MapState, "scenario" | "layers">): CompareState {
  if (hasPreset(layer.id)) return presetFor(layer.id, today);
  const byVersion = versionCompare(layer);
  if (byVersion) return byVersion;
  const bySnapshot = snapshotCompare(layer);
  if (bySnapshot) return bySnapshot;
  const scenario = scenarioOf(layer);
  if (scenario) return defaultScenarioCompare(layer, scenario.values, state);
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

/** The snapshot epochs of a layer's data: survey campaigns, oldest first (lib/render/change.ts). */
export function layerEpochs(layer: LoadedLayer): string[][] {
  if (layer.result.kind !== "geojson") return [];
  const field = layer.style.timeField ?? "t";
  const days = new Set<string>();
  for (const f of layer.result.data.features) {
    const t = f.properties?.[field];
    if (typeof t === "string" && !Number.isNaN(Date.parse(t))) days.add(t.slice(0, 10));
  }
  return snapshotEpochs([...days]);
}

/**
 * The compare between a snapshot layer's first and last epoch (1960s–70s against the 2010s for glacier surveys), delta,
 * labelled by epoch; null when the layer is not snapshots or has one epoch.
 */
export function snapshotCompare(layer: LoadedLayer): CompareState | null {
  if (layer.result.kind !== "geojson" || timeShape(layer).shape !== "snapshots") return null;
  const epochs = layerEpochs(layer);
  if (epochs.length < 2) return null;
  const first = epochs[0];
  const last = epochs[epochs.length - 1];
  return { layerId: layer.id, a: epochWindow(first), b: epochWindow(last), mode: "delta", aLabel: epochLabel(first), bLabel: epochLabel(last) };
}

/** The amounts a scenario compare opens on: A 1 and B 5 when listed (sea level rise in feet), else the amount shown and the last. */
const SCENARIO_DEFAULT = { a: 1, b: 5 } as const;

function defaultScenarioCompare(layer: LoadedLayer, values: number[], state?: Pick<MapState, "scenario" | "layers">): CompareState {
  const listed = values.includes(SCENARIO_DEFAULT.a) && values.includes(SCENARIO_DEFAULT.b);
  const shown = (state && currentScenarioValue(state, layer.id)) ?? values[0];
  const last = values[values.length - 1];
  const scenario = listed ? { ...SCENARIO_DEFAULT } : { a: shown === last ? values[0] : shown, b: last };
  // The windows are not used by a scenario compare; empty, they never read as dates.
  return { layerId: layer.id, a: ["", ""], b: ["", ""], mode: "swipe", scenario };
}

/**
 * How a compare side is named on screen: the agent's label, else a scenario amount ("5 ft") or the window
 * (`windowText`).
 */
export function compareSideText(compare: CompareState, which: "a" | "b", layer: LoadedLayer | undefined): string {
  const label = which === "a" ? compare.aLabel : compare.bLabel;
  if (label) return label;
  const contract = scenarioOf(layer);
  if (compare.scenario && contract) return scenarioText(contract, compare.scenario[which]);
  return windowText(compare[which]);
}

/** "12,280 km² (4,741 mi²)" for US layers, "3.2 km²" elsewhere: the lost ground in the change key. */
export function lostAreaText(km2: number, us: boolean): string {
  const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : n >= 10 ? 1 : 2 });
  return us ? `${fmt(km2 / 2.589988)} mi² (${fmt(km2)} km²)` : `${fmt(km2)} km²`;
}

/** One entry of the delta's key: the label people read, its color, whether it draws as a line, and its count. */
export type DeltaKeyEntry = { label: string; color: string; outline?: boolean; count?: number };

/**
 * The change view's key in plain words, shared by the compare strip and the phone caption. Areas matched across dates
 * (a glacier by its id) read as what was lost, what is there at B, and what is new, with the earlier edge explained in
 * the first item: "Ice lost since the 1960s (the pink line is its edge then)", "Ice in the 2010s", "New ice since the
 * 1960s" (only when there is some). Points and lines read "Only in A", "In both", "Only in B".
 */
export function deltaKey(
  layer: LoadedLayer,
  a: string,
  b: string,
  summary: { aOnly: number; bOnly: number; both: number; lostKm2?: number } | null,
): DeltaKeyEntry[] {
  const count = (n: number | undefined) => (n === undefined ? {} : { count: n });
  // Only one area at two dates (snapshots: a glacier, a monument) loses or gains ground; fires in two windows do not.
  if (layer.style.geometry === "polygon" && timeShape(layer).shape === "snapshots") {
    const noun = timeShape(layer).changeNoun ?? layer.time?.changeNoun ?? "Area";
    const lower = noun.toLowerCase();
    return [
      // No counts: an area that shrank is both lost and kept, so the strip's matched sentence carries the numbers.
      { label: `${noun} lost since ${a}${summary?.lostKm2 ? `, ${lostAreaText(summary.lostKm2, layer.coverage === "us")}` : ""} (pink; the pink line is its edge then)`, color: DELTA_COLORS["a-only"] },
      { label: `${noun} in ${b}`, color: DELTA_COLORS.both },
      ...(summary === null || summary.bOnly > 0 ? [{ label: `New ${lower} since ${a}`, color: DELTA_COLORS["b-only"] }] : []),
    ];
  }
  return [
    { label: `Only in ${a}`, color: DELTA_COLORS["a-only"], ...count(summary?.aOnly) },
    { label: "In both", color: DELTA_COLORS.both, ...count(summary?.both) },
    { label: `Only in ${b}`, color: DELTA_COLORS["b-only"], ...count(summary?.bOnly) },
  ];
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
