/**
 * Time scrubber core (pure): which layers carry time, how to bucket it, which features fall inside a
 * window, how to step a window, and how to point a time-aware tile layer at the window.
 * Features carry an optional `t` (ISO 8601 string); features without a valid `t` are never hidden. Tile layers whose
 * result carries `data.time` (a dated tile template) are scrubbable too: they add the dates they publish at their cadence.
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
  /**
   * Set when only dated tile layers are shown: the buckets are their publishing periods (one image each, no feature
   * counts), and this is the cadence the scrubber names ("per 16 days").
   */
  cadence?: TileTime["cadence"];
};

export type TimeIndexOptions = {
  maxBuckets?: number;
  /** Clock for tile layers' newest period (tests). */
  now?: number;
  /** Days a daily tile layer offers, ending at its newest day (default 30, at most MAX_TILE_STEPS). */
  tileDays?: number;
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

/**
 * Builds the bucketed time index over every geojson feature with a valid `t` and every tile layer with `data.time`;
 * null when there are neither. GeoJSON dates pick the bucket (a tile layer's periods only widen the span); with tile
 * layers alone the buckets are the finest cadence's own periods (tileSteps), so play steps one image at a time.
 */
export function timeIndex(layers: Record<string, LoadedLayer>, opts?: TimeIndexOptions): TimeIndex | null {
  const stamps: number[] = [];
  const layerIds: string[] = [];
  const tileSets: { cadence: TileTime["cadence"]; starts: number[] }[] = [];
  const now = opts?.now ?? Date.now();
  for (const layer of Object.values(layers)) {
    if (layer.result.kind === "tiles") {
      const time = layer.result.data.time;
      const starts = time ? tileSteps(time, layer.result.data.url, now, opts?.tileDays) : [];
      if (time && starts.length > 0) {
        tileSets.push({ cadence: time.cadence, starts });
        layerIds.push(layer.id);
      }
      continue;
    }
    let any = false;
    for (const f of layer.result.data.features) {
      const ms = parseT((f.properties as Record<string, unknown> | null)?.t);
      if (ms === null) continue;
      stamps.push(ms);
      any = true;
    }
    if (any) layerIds.push(layer.id);
  }
  if (stamps.length === 0 && tileSets.length === 0) return null;
  if (stamps.length === 0) return tileIndex(tileSets, layerIds);

  let min = stamps[0];
  let max = stamps[0];
  for (const ms of stamps) {
    if (ms < min) min = ms;
    if (ms > max) max = ms;
  }
  // Tile layers widen the span to the periods they publish, so their dates stay reachable on the scrubber.
  for (const { starts } of tileSets) {
    min = Math.min(min, starts[0]);
    max = Math.max(max, starts[starts.length - 1]);
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

/** Finest first: with tile layers of several cadences, the finest one sets the steps and the others follow it. */
const CADENCE_ORDER: TileTime["cadence"][] = ["daily", "8day", "16day", "monthly", "yearly"];
const CADENCE_BUCKET: Record<TileTime["cadence"], Bucket> = { daily: "day", "8day": "day", "16day": "day", monthly: "month", yearly: "year" };

/** The index of tile layers alone: one bucket per period of the finest cadence (union of those layers' periods). */
function tileIndex(sets: { cadence: TileTime["cadence"]; starts: number[] }[], layerIds: string[]): TimeIndex {
  const cadence = CADENCE_ORDER.find((c) => sets.some((t) => t.cadence === c)) ?? "daily";
  const union = [...new Set(sets.filter((t) => t.cadence === cadence).flatMap((t) => t.starts))].sort((a, b) => a - b);
  const starts = union.slice(-MAX_TILE_STEPS);
  const buckets = starts.map((s, i) => ({
    start: new Date(s).toISOString(),
    end: new Date((i + 1 < starts.length ? starts[i + 1] : periodNext(s, cadence)) - 1).toISOString(),
    count: 0,
  }));
  return {
    min: buckets[0].start,
    max: buckets[buckets.length - 1].start,
    bucket: CADENCE_BUCKET[cadence],
    buckets,
    layerIds,
    cadence,
  };
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

/**
 * Moves the window one bucket. "slide" moves both ends (width kept, clamped to the data); "cumulative" keeps start = min
 * and moves the end. A slide window over the whole span (how the scrubber opens) cannot move, so stepping from it
 * narrows to one bucket instead: the first going forward (as Play starts over), the newest going back.
 */
export function stepWindow(index: TimeIndex, window: TimeWindow, direction: 1 | -1, mode: "slide" | "cumulative"): TimeWindow {
  const starts = index.buckets.map((b) => Date.parse(b.start));
  const last = index.buckets.length - 1;
  const i = bucketIndex(starts, Date.parse(window[0]));
  const j = bucketIndex(starts, Date.parse(window[1]));
  if (mode === "cumulative") {
    const nj = Math.min(last, Math.max(0, j + direction));
    return [index.min, index.buckets[nj].end];
  }
  if (last > 0 && i === 0 && j === last) {
    const bucket = index.buckets[direction === 1 ? 0 : last];
    return [bucket.start, bucket.end];
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

/** Most periods a tile layer puts on the scrubber (the newest ones; about ten years of months). */
export const MAX_TILE_STEPS = 120;
/** Days a daily tile layer puts on the scrubber by default. */
export const TILE_DAYS_DEFAULT = 30;

function dayFloor(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * The start of the publishing period holding `ms`. 8-day and 16-day composites follow the MODIS calendar: they restart
 * every 1 January (1 Jan, 17 Jan, ... for 16 days), so the last period of a year is shorter.
 */
export function periodStart(ms: number, cadence: TileTime["cadence"]): number {
  const day = dayFloor(ms);
  if (cadence === "monthly") return floorTo(day, "month");
  if (cadence === "yearly") return floorTo(day, "year");
  if (cadence === "daily") return day;
  const jan1 = floorTo(day, "year");
  const step = CADENCE_DAYS[cadence];
  return jan1 + Math.floor((day - jan1) / DAY_MS / step) * step * DAY_MS;
}

/** The start of the period after the one starting at `start`. */
function periodNext(start: number, cadence: TileTime["cadence"]): number {
  if (cadence === "monthly") return nextStart(start, "month");
  if (cadence === "yearly") return nextStart(start, "year");
  if (cadence === "daily") return start + DAY_MS;
  return Math.min(start + CADENCE_DAYS[cadence] * DAY_MS, nextStart(start, "year"));
}

/** The date (`{date}`) or year (`{year}`) a tile URL was filled with, read against its template; null if unreadable. */
function loadedPeriod(url: string, template: string): number | null {
  for (const [token, pattern] of [["{date}", /^\d{4}-\d{2}-\d{2}/], ["{year}", /^\d{4}/]] as const) {
    const at = template.indexOf(token);
    if (at < 0 || !url.startsWith(template.slice(0, at))) continue;
    const m = pattern.exec(url.slice(at));
    if (!m) return null;
    const ms = Date.parse(m[0].length === 4 ? `${m[0]}-01-01` : m[0]);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * The period starts (epoch ms, oldest first) a dated tile layer offers the scrubber: daily layers the last `days`
 * days (default 30), other cadences every period from `from`, both capped at MAX_TILE_STEPS and ending at the newest
 * published period (`to`, or today less `daysBack`; a negative daysBack runs into forecast days). When the layer was
 * loaded for an older date than that range reaches, the range ends at the loaded period instead, so it stays on it.
 */
export function tileSteps(time: TileTime, url: string, now: number = Date.now(), days: number = TILE_DAYS_DEFAULT): number[] {
  const fromMs = boundMs(time.from);
  const toMs = boundMs(time.to);
  let latest = dayFloor(now - (time.daysBack ?? 0) * DAY_MS);
  if (toMs !== null) latest = Math.min(latest, toMs);
  if (fromMs !== null && latest < fromMs) return [];
  const first = fromMs === null ? -Infinity : periodStart(fromMs, time.cadence);
  const cap = time.cadence === "daily" ? Math.max(1, Math.min(MAX_TILE_STEPS, Math.floor(days))) : MAX_TILE_STEPS;

  let end = periodStart(latest, time.cadence);
  let oldest = end;
  for (let k = 1; k < cap && oldest > first; k++) oldest = periodStart(oldest - 1, time.cadence);
  const loaded = loadedPeriod(url, time.template);
  if (loaded !== null && loaded < oldest && loaded >= (fromMs ?? -Infinity)) end = periodStart(loaded, time.cadence);

  const starts: number[] = [];
  for (let s = end; starts.length < cap && s >= first; s = periodStart(s - 1, time.cadence)) starts.push(s);
  return starts.reverse();
}

const CADENCE_WORDS: Record<TileTime["cadence"], string> = {
  daily: "per day",
  "8day": "per 8 days",
  "16day": "per 16 days",
  monthly: "per month",
  yearly: "per year",
};

/** What one scrubber step is: "features per month", or for tile layers alone "one image per 16 days". */
export function stepLabel(index: TimeIndex): string {
  if (index.cadence) return `one image ${CADENCE_WORDS[index.cadence]}`;
  return `features per ${index.bucket}`;
}

/** Parses a `from`/`to` bound (YYYY, YYYY-MM-DD or a full ISO string) to epoch ms, or null. */
function boundMs(v: string | undefined): number | null {
  if (v === undefined) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Points a time-aware tile URL at the window using the layer's `data.time`: `{date}` gets the window end (clamped to
 * `from`, `to` and `daysBack` days before today, then snapped down to the cadence's period, see periodStart), `{year}` gets the window's end year
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
  let day = periodStart(ms, time.cadence);
  if (fromMs !== null) day = Math.max(day, dayFloor(fromMs));
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

/** A quick window beside the scrubber (spec §12c time presets): its words and the window it sets. */
export type TimePreset = { label: string; window: TimeWindow };

const MAX_PRESETS = 4;

/**
 * The presets that narrow this index's span and still hold data, finest first, ending at the span's end: the last 24
 * hours, 7 and 30 days for a short span; this year for a few years; since a decade for a long one. `now` anchors the
 * relative ones (tests pass a clock).
 */
export function timePresets(index: TimeIndex, now: number = Date.now()): TimePreset[] {
  if (index.buckets.length < 2) return [];
  const lo = Date.parse(index.buckets[0].start);
  const end = index.buckets[index.buckets.length - 1].end;
  const hi = Date.parse(end);
  const out: TimePreset[] = [];
  const add = (label: string, start: number) => {
    if (start > lo && start < hi && out.length < MAX_PRESETS) out.push({ label, window: [new Date(start).toISOString(), end] });
  };
  const span = hi - lo;
  if (span <= 120 * DAY_MS) {
    add("Last 24 hours", now - DAY_MS);
    add("Last 7 days", now - 7 * DAY_MS);
    add("Last 30 days", now - 30 * DAY_MS);
  }
  const year = new Date(now).getUTCFullYear();
  add("This year", Date.UTC(year, 0, 1));
  if (span > 3 * 365 * DAY_MS) add(`Since ${year - 5}`, Date.UTC(year - 5, 0, 1));
  for (const decade of [2020, 2010, 2000, 1990, 1980]) if (decade < year - 5) add(`Since ${decade}`, Date.UTC(decade, 0, 1));
  return out;
}
