import type { Feature, FeatureCollection } from "geojson";
import type { Attribute } from "@/layers/types";
import { applyFilters } from "@/lib/render/filters";
import { bucketAt } from "@/lib/render/reducer";
import type { LoadedLayer, MapState, TimeState } from "@/lib/render/state";
import { nounOf } from "@/lib/render/hexCells";

/**
 * Time series and the live aggregate (spec §13: "while time plays, the layer's measure is totalled for the current
 * frame with a bar against the period's low and high, and the date is prominent"), the pure half. A series layer's
 * features hold one value per frame (`properties.series[key]`, layers/types.ts SeriesAxis); a dated layer's features
 * fall into the scrubber's buckets by `t`. Either way each frame has a total of the layer's aggregate measure (its sum,
 * largest or mean), or a count of features, and the period has a low and a high.
 */

/** The frame the scrubber shows: the bucket at the window's end. */
export function frameIndex(time: Pick<TimeState, "index" | "window">): number {
  return bucketAt(time.index, time.window[1]);
}

/** A feature's values of `key` per frame of its layer's series, or undefined when it has none. */
export function seriesOf(f: Feature, key: string): (number | null)[] | undefined {
  const arr = (f.properties?.series as Record<string, unknown> | undefined)?.[key];
  return Array.isArray(arr) ? (arr as (number | null)[]) : undefined;
}

/** For each scrubber bucket, the frame of a layer's own series at or before it (or -1 before its first frame). */
const frameMaps = new WeakMap<object, Map<string, number[]>>();
export function layerFrames(layer: LoadedLayer, buckets: readonly { start: string }[]): number[] {
  const series = layer.result.kind === "geojson" ? layer.result.series : undefined;
  if (!series) return [];
  let byKey = frameMaps.get(series);
  if (!byKey) {
    byKey = new Map();
    frameMaps.set(series, byKey);
  }
  const key = `${buckets.length}|${buckets[0]?.start ?? ""}|${buckets[buckets.length - 1]?.start ?? ""}`;
  const hit = byKey.get(key);
  if (hit) return hit;
  const times = series.times.map((t) => Date.parse(t));
  let k = -1;
  const out = buckets.map((b) => {
    const ms = Date.parse(b.start);
    while (k + 1 < times.length && times[k + 1] <= ms) k += 1;
    return k;
  });
  byKey.set(key, out);
  return out;
}

/** A value at a fractional frame: linear between the two frames around it, the nearer one when the other is missing. */
export function valueAt(values: readonly (number | null | undefined)[], frame: number): number | null {
  if (values.length === 0 || !Number.isFinite(frame)) return null;
  const k = Math.min(values.length - 1, Math.max(0, Math.floor(frame)));
  const a = values[k];
  const b = values[Math.min(values.length - 1, k + 1)];
  const phase = Math.min(1, Math.max(0, frame - k));
  const na = typeof a === "number" && Number.isFinite(a) ? a : null;
  const nb = typeof b === "number" && Number.isFinite(b) ? b : null;
  if (na === null) return phase > 0 ? nb : null;
  if (nb === null || phase === 0) return na;
  return na + (nb - na) * phase;
}

export type AggregateKind = "sum" | "max" | "mean" | "count";

/** The live aggregate of one layer over the scrubber's frames. */
export type FrameAggregate = {
  layerId: string;
  /** "Highest flow in view", "Total fire power", "Earthquakes". */
  label: string;
  unit?: string;
  kind: AggregateKind;
  /** One total per scrubber bucket (cumulative mode: the running total); null where nothing was there. */
  values: (number | null)[];
  low: { value: number; at: number } | null;
  high: { value: number; at: number } | null;
};

/** The measure a layer totals per frame: its first measure with an `aggregate`, if its data holds it. */
export function aggregateMeasure(layer: Pick<LoadedLayer, "attributes">): (Attribute & { aggregate: NonNullable<Attribute["aggregate"]> }) | undefined {
  return (layer.attributes ?? []).find((a): a is Attribute & { aggregate: NonNullable<Attribute["aggregate"]> } => a.type === "measure" && a.aggregate !== undefined);
}

function label(kind: AggregateKind, attr: Pick<Attribute, "label" | "aggregateLabel"> | undefined, layer: LoadedLayer): string {
  if (attr?.aggregateLabel) return attr.aggregateLabel;
  const word = attr?.label.toLowerCase() ?? "";
  if (kind === "sum") return `Total ${word}`;
  if (kind === "max") return `Highest ${word} in view`;
  if (kind === "mean") return `Mean ${word}`;
  const noun = nounOf(layer.title);
  return noun.charAt(0).toUpperCase() + noun.slice(1);
}

function combine(kind: AggregateKind, values: number[]): number | null {
  if (kind === "count") return values.length;
  if (values.length === 0) return null;
  if (kind === "sum") return values.reduce((a, b) => a + b, 0);
  if (kind === "max") return values.reduce((a, b) => Math.max(a, b), -Infinity);
  return values.reduce((a, b) => a + b, 0) / values.length;
}

const memo = new WeakMap<FeatureCollection, Map<string, FrameAggregate>>();

/**
 * One layer's aggregate per scrubber bucket, its filters applied. A series layer totals its features' values at each
 * frame; a dated layer the features dated inside each bucket (in cumulative mode, every bucket up to it). Without an
 * aggregate measure it counts features.
 */
export function layerAggregate(layer: LoadedLayer, time: Pick<TimeState, "index" | "mode">, filters?: Parameters<typeof applyFilters>[1]): FrameAggregate | null {
  if (layer.result.kind !== "geojson") return null;
  const data = filters ? applyFilters(layer.result.data, filters) : layer.result.data;
  const measure = aggregateMeasure(layer);
  const series = layer.result.series;
  const buckets = time.index.buckets;
  const cacheKey = `${time.mode}|${buckets.length}|${buckets[0]?.start}|${buckets[buckets.length - 1]?.start}|${JSON.stringify(filters ?? {})}`;
  let byKey = memo.get(layer.result.data);
  if (!byKey) {
    byKey = new Map();
    memo.set(layer.result.data, byKey);
  }
  const hit = byKey.get(cacheKey);
  if (hit) return hit;
  const kind: AggregateKind = measure?.aggregate ?? "count";
  let values: (number | null)[];
  if (series) {
    if (!measure) return null;
    const frames = layerFrames(layer, buckets);
    // Only the features the measure is totalled over (river pulse: its outlets), so no water is counted twice.
    const over = measure.aggregateOver;
    const columns = data.features
      .filter((f) => !over || f.properties?.[over] === true)
      .map((f) => seriesOf(f, measure.key))
      .filter((v): v is (number | null)[] => v !== undefined);
    values = frames.map((k) => {
      if (k < 0) return null;
      const at = columns.map((c) => c[k]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      return at.length > 0 ? combine(kind, at) : null;
    });
  } else {
    const timeKey = layer.style.timeField ?? "t";
    const perBucket: number[][] = buckets.map(() => []);
    let dated = 0;
    for (const f of data.features) {
      const t = f.properties?.[timeKey];
      const ms = typeof t === "string" ? Date.parse(t) : Number.NaN;
      if (!Number.isFinite(ms)) continue;
      dated += 1;
      const at = bucketAt(time.index, new Date(ms).toISOString());
      const v = measure ? f.properties?.[measure.key] : 1;
      if (typeof v === "number" && Number.isFinite(v)) perBucket[at].push(v);
      else if (!measure) perBucket[at].push(1);
    }
    if (dated === 0) return null;
    if (time.mode === "cumulative" && (kind === "sum" || kind === "count")) {
      let running = 0;
      values = perBucket.map((vs) => (running += combine(kind, vs) ?? 0));
    } else {
      values = perBucket.map((vs) => (kind === "count" ? vs.length : combine(kind, vs)));
    }
  }
  let low: FrameAggregate["low"] = null;
  let high: FrameAggregate["high"] = null;
  values.forEach((v, at) => {
    if (v === null) return;
    if (!low || v < low.value) low = { value: v, at };
    if (!high || v > high.value) high = { value: v, at };
  });
  const out: FrameAggregate = {
    layerId: layer.id,
    label: label(kind, measure, layer),
    ...(kind !== "count" && measure?.unit && { unit: measure.unit }),
    kind,
    values,
    low,
    high,
  };
  byKey.set(cacheKey, out);
  return out;
}

/**
 * The aggregate the scrubber shows: the top-most shown layer the scrubber steps (a series layer first, else a dated
 * one) that has something to total.
 */
export function frameAggregate(state: Pick<MapState, "time" | "layers" | "renderOps">): FrameAggregate | null {
  const time = state.time;
  if (!time) return null;
  const ops = [...state.renderOps].reverse().filter((op) => op.visible && time.index.layerIds.includes(op.layerId));
  const ordered = [
    ...ops.filter((op) => state.layers[op.layerId]?.result.kind === "geojson" && (state.layers[op.layerId].result as { series?: unknown }).series),
    ...ops,
  ];
  for (const op of ordered) {
    const layer = state.layers[op.layerId];
    if (!layer) continue;
    const agg = layerAggregate(layer, time, op.filters);
    if (agg && agg.high) return agg;
  }
  return null;
}

/** Where a value sits between the period's low and high, 0..1 (0.5 when they are equal). */
export function shareOfRange(value: number, agg: Pick<FrameAggregate, "low" | "high">): number {
  if (!agg.low || !agg.high) return 0.5;
  const span = agg.high.value - agg.low.value;
  return span > 0 ? Math.min(1, Math.max(0, (value - agg.low.value) / span)) : 0.5;
}

/** Day of the year as a share of the year (0 on 1 January), for the year dial. */
export function yearFraction(ms: number): number {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const end = Date.UTC(d.getUTCFullYear() + 1, 0, 1);
  return (ms - start) / (end - start);
}

/** True when the scrubber's span covers enough of a year for a dial to say where in the year a frame is (two months). */
export function wantsYearDial(index: Pick<TimeState["index"], "buckets" | "bucket">): boolean {
  if (index.bucket === "year" || index.buckets.length < 2) return false;
  const span = Date.parse(index.buckets[index.buckets.length - 1].end) - Date.parse(index.buckets[0].start);
  return span >= 60 * 86_400_000;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The frame's date as the scrubber shows it, large: "Wed 14 Oct 2026", "Wed 14 Oct, 09:00 UTC", "Mar 2024", "2019". */
export function frameDate(ms: number, bucket: TimeState["index"]["bucket"]): string {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "";
  if (bucket === "year") return String(d.getUTCFullYear());
  if (bucket === "month") return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  const day = `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  if (bucket === "hour") return `${day}, ${String(d.getUTCHours()).padStart(2, "0")}:00 UTC`;
  return `${day} ${d.getUTCFullYear()}`;
}
