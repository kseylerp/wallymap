/**
 * Time scrubber core (pure): which layers carry time, how to bucket it, which features fall inside a
 * window, how to step a window, and how to point a time-aware tile layer at the window.
 * Features carry an optional `t` (ISO 8601 string); features without a valid `t` are never hidden. Tile layers whose
 * result carries `data.time` (a dated tile template) are scrubbable too: they add the dates they publish at their cadence.
 */
import type { FeatureCollection } from "geojson";
import type { LoadedLayer } from "@/lib/render/state";
import type { TileTime } from "@/layers/types";
import { timeShape } from "@/lib/render/contract";

export type Bucket = "hour" | "day" | "month" | "year";
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
  /**
   * Set when a shown layer carries a value per frame (layers/types.ts SeriesAxis): the buckets are its frames, one per
   * day or hour, and the scrubber opens on `now` (the newest reading) one frame wide; frames from `forecastFrom` on
   * are forecast.
   */
  series?: { step: "day" | "hour"; now: number; forecastFrom?: number };
  /**
   * Set when every dated layer is a set of snapshots (docs/layer-contract.md: a few survey dates, glacier outlines):
   * the time panel is a stepper between `stops` (each a date at the data's resolution with its feature count), not a
   * scrubber, and compares the first epoch with the last.
   */
  snapshots?: { stops: SnapshotStop[] };
  /**
   * Tile layers only: every one fills the window's start as well as its end (`{start}` or `start_year=`), so a window
   * wider than one period draws something a single period cannot (forest loss since 2015). Presets need it.
   */
  ranged?: boolean;
};

/** One stop of a snapshot stepper: its window (one year, month or day), its label and how many features it holds. */
export type SnapshotStop = { start: string; end: string; label: string; count: number };

export type TimeIndexOptions = {
  maxBuckets?: number;
  /** Clock for tile layers' newest period (tests). */
  now?: number;
  /** Days a daily tile layer offers, ending at its newest day (default 30, at most MAX_TILE_STEPS). */
  tileDays?: number;
};

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const UNIT_MS: Record<Bucket, number> = { hour: HOUR_MS, day: DAY_MS, month: 30.4375 * DAY_MS, year: 365.25 * DAY_MS };
/** The buckets dated features are counted in; hours are only ever a series' own frames. */
const ORDER: Bucket[] = ["day", "month", "year"];
/** Most frames a series puts on the scrubber (the newest ones): six months of days, or about five weeks of hours. */
export const MAX_SERIES_FRAMES = 840;

/** Day if the span is at most 90 days, month if at most 10 years, else year; then coarsened until it fits `maxBuckets`. */
export function chooseBucket(spanMs: number, maxBuckets = 60): Bucket {
  const span = Math.max(0, spanMs);
  let i = span <= 90 * DAY_MS ? 0 : span <= 10 * 365.25 * DAY_MS ? 1 : 2;
  while (i < ORDER.length - 1 && Math.floor(span / UNIT_MS[ORDER[i]]) + 1 > maxBuckets) i += 1;
  return ORDER[i];
}

function floorTo(ms: number, bucket: Bucket): number {
  if (bucket === "hour") return Math.floor(ms / HOUR_MS) * HOUR_MS;
  const d = new Date(ms);
  if (bucket === "year") return Date.UTC(d.getUTCFullYear(), 0, 1);
  if (bucket === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function nextStart(ms: number, bucket: Bucket): number {
  if (bucket === "hour") return ms + HOUR_MS;
  const d = new Date(ms);
  if (bucket === "year") return Date.UTC(d.getUTCFullYear() + 1, 0, 1);
  if (bucket === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return ms + DAY_MS;
}

/** January 1 at midnight UTC, how a year-only date is written. */
const JAN_FIRST = /^\d{4}-01-01(?:[T ]00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)?)?$/;

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
  const seriesSets: { step: "day" | "hour"; starts: number[]; now: number; forecastFrom?: number }[] = [];
  const now = opts?.now ?? Date.now();
  // Every dated layer so far is a set of snapshots (the panel is then a stepper); a continuous one turns this off.
  let allSnapshots = true;
  let ranged = true;
  // Every date is January 1 at midnight: dates known only to the year (dams by year completed), stepped by year.
  let yearsOnly = true;
  for (const layer of Object.values(layers)) {
    if (layer.result.kind === "tiles") {
      const time = layer.result.data.time;
      const starts = time ? tileSteps(time, layer.result.data.url, now, opts?.tileDays) : [];
      if (time && starts.length > 0) {
        tileSets.push({ cadence: time.cadence, starts });
        layerIds.push(layer.id);
        if (!isRanged(time)) ranged = false;
      }
      continue;
    }
    const series = layer.result.series;
    if (series && series.times.length > 0) {
      const starts = series.times.map((t) => Date.parse(t)).filter((ms) => Number.isFinite(ms));
      if (starts.length > 0) {
        const at = (k: number | undefined) => (k === undefined ? undefined : Date.parse(series.times[Math.min(series.times.length - 1, Math.max(0, k))]));
        seriesSets.push({ step: series.step, starts, now: at(series.now) ?? starts[starts.length - 1], forecastFrom: at(series.forecastFrom) });
        layerIds.push(layer.id);
      }
    }
    // A layer whose time is not the question (dams by year built) or one reading per site gets no time panel: its dates
    // neither open the panel nor filter its features.
    const shape = series ? "continuous" : timeShape(layer).shape;
    if (shape === "none" || shape === "single") continue;
    let any = false;
    for (const f of layer.result.data.features) {
      const t = (f.properties as Record<string, unknown> | null)?.t;
      const ms = parseT(t);
      if (ms === null) continue;
      stamps.push(ms);
      if (!JAN_FIRST.test(String(t))) yearsOnly = false;
      any = true;
    }
    if (any) {
      layerIds.push(layer.id);
      if (shape !== "snapshots") allSnapshots = false;
    }
  }
  // A series sets the frames: dated features of other layers still filter by the frame's window.
  if (seriesSets.length > 0) return seriesIndex(seriesSets, layerIds);
  if (stamps.length === 0 && tileSets.length === 0) return null;
  if (stamps.length === 0) {
    const index = tileIndex(tileSets, layerIds);
    // Tile layers that list a dozen or fewer dates (imagery by date) step between them, as snapshots do.
    const listed = Object.values(layers).every((l) => l.result.kind !== "tiles" || !l.result.data.time || (l.result.data.time.dates?.length ?? 0) > 0);
    const stops =
      listed && index.buckets.length >= 2 && index.buckets.length <= MAX_LISTED_STOPS
        ? index.buckets.map((b) => ({ start: b.start, end: b.end, label: windowLabel([b.start, b.start], index.bucket), count: 0 }))
        : undefined;
    return { ...index, ...(ranged && { ranged: true }), ...(stops && { snapshots: { stops } }) };
  }

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
  const bucket = yearsOnly && tileSets.length === 0 ? "year" : chooseBucket(max - min, opts?.maxBuckets ?? 60);

  const starts: number[] = [];
  for (let s = floorTo(min, bucket); s <= max; s = nextStart(s, bucket)) starts.push(s);
  const counts = new Array<number>(starts.length).fill(0);
  for (const ms of stamps) counts[bucketIndex(starts, ms)] += 1;

  const buckets = starts.map((s, i) => ({
    start: new Date(s).toISOString(),
    end: new Date((i + 1 < starts.length ? starts[i + 1] : nextStart(s, bucket)) - 1).toISOString(),
    count: counts[i],
  }));
  const snapshots = allSnapshots && tileSets.length === 0 ? snapshotStops(stamps, max - min) : undefined;
  return {
    min: new Date(min).toISOString(),
    max: new Date(max).toISOString(),
    bucket,
    buckets,
    layerIds,
    ...(snapshots && snapshots.length >= 2 && { snapshots: { stops: snapshots } }),
  };
}

/** Most listed tile dates shown as a stepper; more get the scrubber. */
export const MAX_LISTED_STOPS = 12;

/** A tile template that fills the window's start as well as its end. */
function isRanged(time: TileTime): boolean {
  return time.template.includes("{start}") || /[?&]start_year=/.test(time.template);
}

/**
 * The stops of a snapshot stepper: the distinct dates at the resolution the span calls for (years over more than three
 * years, months over more than 90 days, else days), each with its feature count, oldest first.
 */
function snapshotStops(stamps: number[], spanMs: number): SnapshotStop[] {
  const unit: Bucket = spanMs > 3 * 365.25 * DAY_MS ? "year" : spanMs > 90 * DAY_MS ? "month" : "day";
  const counts = new Map<number, number>();
  for (const ms of stamps) {
    const k = floorTo(ms, unit);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, count]) => {
      const end = new Date(nextStart(start, unit) - 1).toISOString();
      const iso = new Date(start).toISOString();
      return { start: iso, end, label: windowLabel([iso, iso], unit), count };
    });
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

/**
 * The index of series layers: one bucket per frame of the finest step (hours over days), the union of those layers'
 * frames, the newest MAX_SERIES_FRAMES of them. `now` is the newest frame at or before any layer's query time.
 */
function seriesIndex(sets: { step: "day" | "hour"; starts: number[]; now: number; forecastFrom?: number }[], layerIds: string[]): TimeIndex {
  const step = sets.some((t) => t.step === "hour") ? "hour" : "day";
  const fine = sets.filter((t) => t.step === step);
  const union = [...new Set(fine.flatMap((t) => t.starts.map((ms) => floorTo(ms, step))))].sort((a, b) => a - b).slice(-MAX_SERIES_FRAMES);
  const buckets = union.map((s, i) => ({
    start: new Date(s).toISOString(),
    end: new Date((i + 1 < union.length ? union[i + 1] : nextStart(s, step)) - 1).toISOString(),
    count: 0,
  }));
  const nowMs = Math.max(...fine.map((t) => t.now));
  const now = Math.max(0, bucketIndex(union, nowMs));
  const forecasts = fine.map((t) => t.forecastFrom).filter((ms): ms is number => ms !== undefined);
  const forecastFrom = forecasts.length > 0 ? bucketIndex(union, Math.min(...forecasts)) : undefined;
  return {
    min: buckets[0].start,
    max: buckets[buckets.length - 1].start,
    bucket: step,
    buckets,
    layerIds,
    series: { step, now, ...(forecastFrom !== undefined && { forecastFrom }) },
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
  // A source that lists the dates it has (imagery by date) steps between exactly those, newest MAX_TILE_STEPS.
  if (time.dates && time.dates.length > 0) {
    const listed = [...new Set(time.dates.map((d) => Date.parse(d)).filter((ms) => Number.isFinite(ms)).map((ms) => periodStart(ms, time.cadence)))].sort((a, b) => a - b);
    return listed.slice(-MAX_TILE_STEPS);
  }
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
  if (index.series) return `one frame per ${index.series.step}`;
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

  const startMs = Date.parse(window[0]);
  const fromYear = fromMs === null ? -Infinity : new Date(fromMs).getUTCFullYear();

  if (time.template.includes("{year}")) {
    const latest = Math.min(endMs, toMs ?? Infinity, now - (time.daysBack ?? 0) * DAY_MS);
    let year = new Date(latest).getUTCFullYear();
    if (fromMs !== null) year = Math.max(year, new Date(fromMs).getUTCFullYear());
    if (toMs !== null) year = Math.min(year, new Date(toMs).getUTCFullYear());
    const filled = time.template.replace(/\{year\}/g, String(year));
    // The window's start year, when it has one: "since 2015" draws the loss from 2015 on, not the template's own start.
    const startYear = Number.isNaN(startMs) ? undefined : Math.max(fromYear, new Date(startMs).getUTCFullYear());
    return filled.replace(/([?&]start_year=)(\d+)/, (_m, pre: string, v: string) => `${pre}${Math.min(startYear ?? Number(v), year)}`);
  }

  if (!time.template.includes("{date}") && !time.template.includes("{end}")) return url;
  let ms = Math.min(endMs, toMs ?? Infinity, now - (time.daysBack ?? 0) * DAY_MS);
  if (fromMs !== null) ms = Math.max(ms, fromMs);
  let day = periodStart(ms, time.cadence);
  if (fromMs !== null) day = Math.max(day, dayFloor(fromMs));
  const endDay = new Date(day).toISOString().slice(0, 10);
  // `{start}`: the window's first day (clamped to `from` and to the end), so a source that takes a range draws it all.
  let first = Number.isNaN(startMs) ? day : Math.min(day, dayFloor(startMs));
  if (fromMs !== null) first = Math.max(first, dayFloor(fromMs));
  const startDay = new Date(first).toISOString().slice(0, 10);
  return time.template.replace(/\{date\}/g, endDay).replace(/\{end\}/g, endDay).replace(/\{start\}/g, startDay);
}

/**
 * The period a dated tile URL draws (the `{date}`, `{end}` or `{year}` it was filled with), as epoch ms; null when the
 * URL does not follow the template. The scrubber names it when it falls back to the loaded image.
 */
export function periodOfUrl(url: string, time: TileTime | undefined): number | null {
  if (!time) return null;
  return loadedPeriod(url, time.template.replace("{end}", "{date}"));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2016 – 2025", "Mar 2024 – Jun 2024", or "2024-06-01 – 2024-06-07" depending on the bucket. */
export function windowLabel(window: TimeWindow, bucket: Bucket): string {
  const fmt = (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    if (bucket === "year") return String(d.getUTCFullYear());
    if (bucket === "month") return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    if (bucket === "hour") return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 13)}:00`;
    return d.toISOString().slice(0, 10);
  };
  // One frame of a series (or one day) reads as itself, not as a range from a time to the same time.
  if (fmt(window[0]) === fmt(window[1])) return fmt(window[0]);
  return `${fmt(window[0])} – ${fmt(window[1])}`;
}

/** A quick window beside the scrubber (spec §12c time presets): its words and the window it sets. */
export type TimePreset = { label: string; window: TimeWindow };

const MAX_PRESETS = 4;

/** One frame of a series as a preset window. */
function framePreset(index: TimeIndex, label: string, ms: number): TimePreset | null {
  const starts = index.buckets.map((b) => Date.parse(b.start));
  if (ms < starts[0] || ms > Date.parse(index.buckets[index.buckets.length - 1].end)) return null;
  const k = bucketIndex(starts, ms);
  return { label, window: [index.buckets[k].start, index.buckets[k].end] };
}

/** A forecast series' presets: the frame now, then 24 hours and 3 days ahead, when the frames reach them. */
function forecastPresets(index: TimeIndex, now: number): TimePreset[] {
  const s = index.series;
  if (!s || s.forecastFrom === undefined) return [];
  const at = Date.parse(index.buckets[Math.min(index.buckets.length - 1, s.now)].start);
  const out = [framePreset(index, "Now", at), framePreset(index, "In 24 hours", at + DAY_MS), framePreset(index, "In 3 days", at + 3 * DAY_MS)];
  void now;
  return out.filter((p): p is TimePreset => p !== null);
}

/** A dated tile layer's presets: the period holding today's date one and two years back, when the steps reach it. */
function sameDatePresets(index: TimeIndex, now: number): TimePreset[] {
  const lastStart = Date.parse(index.buckets[index.buckets.length - 1].start);
  const out: TimePreset[] = [];
  for (const back of [1, 2]) {
    const d = new Date(lastStart);
    const ms = Date.UTC(d.getUTCFullYear() - back, d.getUTCMonth(), d.getUTCDate());
    const p = framePreset(index, back === 1 ? "Same date last year" : `Same date ${d.getUTCFullYear() - back}`, ms);
    if (p && Date.parse(p.window[0]) !== lastStart) out.push(p);
  }
  void now;
  return out;
}

/**
 * The presets that narrow this index's span and still hold data, finest first, ending at the span's end: the last 24
 * hours, 7 and 30 days for a short span; this year for a few years; since a decade for a long one. `now` anchors the
 * relative ones (tests pass a clock).
 */
export function timePresets(index: TimeIndex, now: number = Date.now()): TimePreset[] {
  if (index.buckets.length < 2 || index.snapshots) return [];
  // A series plays frame by frame: its presets are frames, now and ahead in the forecast ("In 24 hours", "In 3 days").
  if (index.series) return forecastPresets(index, now);
  // A tile layer that draws only the window's end shows the same image for every window ending today: its presets are
  // the same date in earlier years (a season against last year's).
  if (index.cadence && !index.ranged) return sameDatePresets(index, now);
  const lo = Date.parse(index.buckets[0].start);
  const end = index.buckets[index.buckets.length - 1].end;
  const hi = Date.parse(end);
  const out: TimePreset[] = [];
  // Features each window holds: a preset that holds everything, nothing, or the same as a finer preset selects
  // nothing new (glacier surveys: "Since 2010", "Since 2000" and "Since 1990" all held the same 141 outlines).
  const counted = index.cadence === undefined;
  const total = index.buckets.reduce((sum, b) => sum + b.count, 0);
  const held = (start: number) => index.buckets.reduce((sum, b) => (Date.parse(b.end) >= start ? sum + b.count : sum), 0);
  const seen = new Set<number>();
  const add = (label: string, start: number) => {
    if (!(start > lo && start < hi) || out.length >= MAX_PRESETS) return;
    if (counted) {
      const n = held(start);
      if (n === 0 || n === total || seen.has(n)) return;
      seen.add(n);
    }
    out.push({ label, window: [new Date(start).toISOString(), end] });
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
