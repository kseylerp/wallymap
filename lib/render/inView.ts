import { useSyncExternalStore } from "react";
import type { Feature, FeatureCollection } from "geojson";
import type { BBox } from "@/layers/types";
import { featureBBox } from "@/lib/render/inspect";
import { valuesOf } from "@/lib/render/encode";

/**
 * What the map shows right now, for the legends (owner, 2026-10-18: "legends list what is in view"; the hardiness key
 * read 3a, 6a, 9a, 12a over Denver, which is 5b and 6a). The map writes it when it comes to rest (components/MapCanvas.tsx):
 * the visible bounds, and for vector tile layers the key field's value at a grid of points over the canvas (tiles have
 * no features to count). The legend reads it: categories keep only the classes in view with their counts (or their
 * share of the view for tiles), ramps mark the view's range on their fixed scale.
 */
export type TileSample = { field: string; values: string[] };
export type InView = { bounds: BBox | null; tiles: Record<string, TileSample> };

const EMPTY: InView = { bounds: null, tiles: {} };
let current: InView = EMPTY;
const listeners = new Set<() => void>();

export function setInView(next: InView): void {
  current = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The latest in-view snapshot (EMPTY until the map first comes to rest). */
export function useInView(): InView {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => EMPTY,
  );
}

const boxMemo = new WeakMap<Feature, BBox | null>();
function boxOf(f: Feature): BBox | null {
  if (!boxMemo.has(f)) boxMemo.set(f, featureBBox(f));
  return boxMemo.get(f) ?? null;
}

/** True when two boxes overlap (west, south, east, north; a view across the antimeridian splits in two). */
function overlaps(a: BBox, b: BBox): boolean {
  if (b[0] > b[2]) return overlaps(a, [b[0], b[1], 180, b[3]]) || overlaps(a, [-180, b[1], b[2], b[3]]);
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

const viewMemo = new WeakMap<FeatureCollection, { key: string; out: FeatureCollection }>();

/** The features whose extent meets the view (all of them without bounds); the same object when every one does. */
export function featuresInView(data: FeatureCollection, bounds: BBox | null): FeatureCollection {
  if (!bounds) return data;
  const key = bounds.map((n) => n.toFixed(4)).join(",");
  const memo = viewMemo.get(data);
  if (memo?.key === key) return memo.out;
  const features = data.features.filter((f) => {
    const box = boxOf(f);
    return box !== null && overlaps(box, bounds);
  });
  const out = features.length === data.features.length ? data : { ...data, features };
  viewMemo.set(data, { key, out });
  return out;
}

/** The smallest and largest number under `key` among `data`'s features (a series' frames included), or null. */
export function rangeOf(data: FeatureCollection, key: string): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of data.features) {
    for (const v of valuesOf(f, key)) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return Number.isFinite(lo) ? [lo, hi] : null;
}

/** Each sampled value's share of the sampled points (0..1). */
export function tileShares(sample: TileSample | undefined): Map<string, number> | undefined {
  if (!sample || sample.values.length === 0) return undefined;
  const out = new Map<string, number>();
  for (const v of sample.values) out.set(v, (out.get(v) ?? 0) + 1);
  for (const [k, n] of out) out.set(k, n / sample.values.length);
  return out;
}

/** The numeric range of a tile sample (a ramp keyed on tiles, such as geology's ages), or null. */
export function tileRange(sample: TileSample | undefined): [number, number] | null {
  if (!sample) return null;
  const nums = sample.values.map(Number).filter((n) => Number.isFinite(n));
  return nums.length > 0 ? [Math.min(...nums), Math.max(...nums)] : null;
}
