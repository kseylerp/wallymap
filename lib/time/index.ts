/**
 * Time scrubber core (pure): which layers carry time, how to bucket it, which features fall inside a
 * window, how to step a window, and how to point a time-aware tile layer at the window.
 * Features carry an optional `t` (ISO 8601 string); features without a valid `t` are never hidden.
 */
import type { FeatureCollection } from "geojson";
import type { LoadedLayer } from "@/lib/render/state";
import type { TileTime } from "@/layers/types";

export type Bucket = "day" | "month" | "year";
/** ISO inclusive start, inclusive end. */
export type TimeWindow = [string, string];
export type TimeIndex = {
  min: string;
  max: string;
  bucket: Bucket;
  buckets: { start: string; end: string; count: number }[];
  layerIds: string[];
};

const DAY_MS = 86_400_000;
const UNIT_MS: Record<Bucket, number> = { day: DAY_MS, month: 30.4375 * DAY_MS, year: 365.25 * DAY_MS };
const ORDER: Bucket[] = ["day", "month", "year"];

/** Day if the span is at most 90 days, month if at most 10 years, else year; then coarsened until it fits `maxBuckets`. */
export function chooseBucket(spanMs: number, maxBuckets = 60): Bucket {
  const span = Math.max(0, spanMs);
  let i = span <= 90 * DAY_MS ? 0 : span <= 10 * 365.25 * DAY_MS ? 1 : 2;
  while (i < ORDER.length - 1 && Math.floor(span / UNIT_MS[ORDER[i]]) + 1 > maxBuckets) i += 1;
  return ORDER[i];
}

function floorTo(ms: number, bucket: Bucket): number {
  const d = new Date(ms);
  if (bucket === "year") return Date.UTC(d.getUTCFullYear(), 0, 1);
  if (bucket === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function nextStart(ms: number, bucket: Bucket): number {
  const d = new Date(ms);
  if (bucket === "year") return Date.UTC(d.getUTCFullYear() + 1, 0, 1);
  if (bucket === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return ms + DAY_MS;
}

function parseT(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/** Builds the bucketed time index over every geojson feature with a valid `t`; null when there are none. */
export function timeIndex(layers: Record<string, LoadedLayer>, opts?: { maxBuckets?: number }): TimeIndex | null {
  const stamps: number[] = [];
  const layerIds: string[] = [];
  for (const layer of Object.values(layers)) {
    if (layer.result.kind !== "geojson") continue;
    let any = false;
    for (const f of layer.result.data.features) {
      const ms = parseT((f.properties as Record<string, unknown> | null)?.t);
      if (ms === null) continue;
      stamps.push(ms);
      any = true;
    }
    if (any) layerIds.push(layer.id);
  }
  if (stamps.length === 0) return null;

  let min = stamps[0];
  let max = stamps[0];
  for (const ms of stamps) {
    if (ms < min) min = ms;
    if (ms > max) max = ms;
  }
  const bucket = chooseBucket(max - min, opts?.maxBuckets ?? 60);

  const starts: number[] = [];
  for (let s = floorTo(min, bucket); s <= max; s = nextStart(s, bucket)) starts.push(s);
  const counts = new Array<number>(starts.length).fill(0);
  for (const ms of stamps) counts[bucketIndex(starts, ms)] += 1;

  const buckets = starts.map((s, i) => ({
    start: new Date(s).toISOString(),
    end: new Date((i + 1 < starts.length ? starts[i + 1] : nextStart(s, bucket)) - 1).toISOString(),
    count: counts[i],
  }));
  return { min: new Date(min).toISOString(), max: new Date(max).toISOString(), bucket, buckets, layerIds };
}

/** Index of the last bucket start at or before `ms`, clamped to the ends. */
function bucketIndex(starts: number[], ms: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= ms) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** True when `t` falls in the window (both ends inclusive). Missing or unparseable `t` stays visible. */
export function inWindow(t: string | undefined, window: TimeWindow): boolean {
  if (t === undefined) return true;
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) return true;
  const a = Date.parse(window[0]);
  const b = Date.parse(window[1]);
  return ms >= a && ms <= b;
}

/** Drops features whose `t` is outside the window; returns the same object when nothing is dropped. */
export function filterByWindow(fc: FeatureCollection, window: TimeWindow): FeatureCollection {
  const kept = fc.features.filter((f) => {
    const t = (f.properties as Record<string, unknown> | null)?.t;
    return inWindow(typeof t === "string" ? t : undefined, window);
  });
  return kept.length === fc.features.length ? fc : { ...fc, features: kept };
}

/** Moves the window one bucket. "slide" moves both ends (width kept, clamped to the data); "cumulative" keeps start = min and moves the end. */
export function stepWindow(index: TimeIndex, window: TimeWindow, direction: 1 | -1, mode: "slide" | "cumulative"): TimeWindow {
  const starts = index.buckets.map((b) => Date.parse(b.start));
  const last = index.buckets.length - 1;
  const i = bucketIndex(starts, Date.parse(window[0]));
  const j = bucketIndex(starts, Date.parse(window[1]));
  if (mode === "cumulative") {
    const nj = Math.min(last, Math.max(0, j + direction));
    return [index.min, index.buckets[nj].end];
  }
  const shift = direction === 1 ? Math.min(1, last - j) : -Math.min(1, i);
  if (shift === 0) return window;
  return [index.buckets[i + shift].start, index.buckets[j + shift].end];
}

/** Newest year of tree cover loss GFW serves; later years answer 422 (layers/forest-loss.ts caps endYear here too). */
export const FOREST_LOSS_LATEST_YEAR = 2025;
/** The newest night-lights day that is reliably processed is about this many days back (layers/night-lights.ts). */
export const NIGHT_LIGHTS_DAYS_BACK = 3;

const CADENCE_DAYS = { "8day": 8, "16day": 16 } as const;

function dayFloor(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Parses a `from`/`to` bound (YYYY, YYYY-MM-DD or a full ISO string) to epoch ms, or null. */
function boundMs(v: string | undefined): number | null {
  if (v === undefined) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Points a time-aware tile URL at the window using the layer's `data.time`: `{date}` gets the window end (clamped to
 * `from`, `to` and `daysBack` days before today, then snapped down to the cadence), `{year}` gets the window's end year
 * (clamped to `from`/`to`; a `start_year=` parameter above it is lowered to it). Because the end is clamped to the
 * newest published period, a window that ends today still draws the newest imagery instead of blank tiles.
 * Returns `url` unchanged when there is no `time` or the window end is not a date.
 */
export function tileUrlForTime(
  url: string,
  time: TileTime | undefined,
  window: TimeWindow,
  now: number = Date.now(),
): string {
  if (!time) return url;
  const endMs = Date.parse(window[1]);
  if (Number.isNaN(endMs)) return url;
  const fromMs = boundMs(time.from);
  const toMs = boundMs(time.to);

  if (time.template.includes("{year}")) {
    const latest = Math.min(endMs, toMs ?? Infinity, now - (time.daysBack ?? 0) * DAY_MS);
    let year = new Date(latest).getUTCFullYear();
    if (fromMs !== null) year = Math.max(year, new Date(fromMs).getUTCFullYear());
    if (toMs !== null) year = Math.min(year, new Date(toMs).getUTCFullYear());
    const filled = time.template.replace(/\{year\}/g, String(year));
    return filled.replace(/([?&]start_year=)(\d+)/, (_m, pre: string, v: string) => `${pre}${Math.min(Number(v), year)}`);
  }

  if (!time.template.includes("{date}")) return url;
  let ms = Math.min(endMs, toMs ?? Infinity, now - (time.daysBack ?? 0) * DAY_MS);
  if (fromMs !== null) ms = Math.max(ms, fromMs);
  const anchor = dayFloor(fromMs ?? Date.UTC(1970, 0, 1));
  let day = dayFloor(ms);
  if (time.cadence === "8day" || time.cadence === "16day") {
    const step = CADENCE_DAYS[time.cadence] * DAY_MS;
    day = anchor + Math.floor((day - anchor) / step) * step;
  } else if (time.cadence === "monthly") {
    day = floorTo(day, "month");
  } else if (time.cadence === "yearly") {
    day = floorTo(day, "year");
  }
  if (fromMs !== null) day = Math.max(day, anchor);
  return time.template.replace(/\{date\}/g, new Date(day).toISOString().slice(0, 10));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2016 – 2025", "Mar 2024 – Jun 2024", or "2024-06-01 – 2024-06-07" depending on the bucket. */
export function windowLabel(window: TimeWindow, bucket: Bucket): string {
  const fmt = (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    if (bucket === "year") return String(d.getUTCFullYear());
    if (bucket === "month") return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    return d.toISOString().slice(0, 10);
  };
  return `${fmt(window[0])} – ${fmt(window[1])}`;
}
