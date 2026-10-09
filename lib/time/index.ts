/**
 * Time scrubber core (pure): which layers carry time, how to bucket it, which features fall inside a
 * window, how to step a window, and how to point a time-aware tile layer at the window.
 * Features carry an optional `t` (ISO 8601 string); features without a valid `t` are never hidden.
 */
import type { FeatureCollection } from "geojson";
import type { LoadedLayer } from "@/lib/render/state";

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

const NIGHT_DATE = /\/\d{4}-\d{2}-\d{2}\//;

/** Newest year of tree cover loss GFW serves; later years answer 422 (layers/forest-loss.ts caps endYear here too). */
export const FOREST_LOSS_LATEST_YEAR = 2025;
/** The newest night-lights day that is reliably processed is about this many days back (layers/night-lights.ts). */
export const NIGHT_LIGHTS_DAYS_BACK = 3;

/**
 * Points a time-aware tile layer's URL at the window: night-lights gets the end date, forest-loss the end year
 * (start year never exceeds it). Both are clamped to the latest period the upstream publishes, so a window that
 * ends today still draws the newest imagery instead of blank tiles. Other layers are unchanged.
 */
export function tileUrlForTime(layerId: string, url: string, window: TimeWindow, now: number = Date.now()): string {
  const end = new Date(window[1]);
  if (Number.isNaN(end.getTime())) return url;
  if (layerId === "night-lights") {
    const latest = now - NIGHT_LIGHTS_DAYS_BACK * DAY_MS;
    const day = new Date(Math.min(end.getTime(), latest)).toISOString().slice(0, 10);
    return url.replace(NIGHT_DATE, `/${day}/`);
  }
  if (layerId === "forest-loss") {
    const endYear = Math.min(end.getUTCFullYear(), FOREST_LOSS_LATEST_YEAR);
    const m = /[?&]start_year=(\d+)/.exec(url);
    const startYear = m ? Math.min(Number(m[1]), endYear) : endYear;
    return setParam(setParam(url, "start_year", startYear), "end_year", endYear);
  }
  return url;
}

/** Sets a query parameter by text so tile template braces ({z}/{x}/{y}) are never percent-encoded. */
function setParam(url: string, key: string, value: number): string {
  const re = new RegExp(`([?&]${key}=)[^&]*`);
  if (re.test(url)) return url.replace(re, `$1${value}`);
  return url + (url.includes("?") ? "&" : "?") + `${key}=${value}`;
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
