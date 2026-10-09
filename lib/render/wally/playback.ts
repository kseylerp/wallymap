import type { Feature, LineString, Position } from "geojson";
import type { ExpressionSpecification } from "mapbox-gl";
import type { MapAction, MapState, RouteState } from "@/lib/render/state";
import { bearingDeg, cumulativeMeters, gradientColors, GRADIENT_STOPS } from "@/lib/render/wally/routeLine";
import { pitchFor } from "@/lib/render/wally/terrain";

/**
 * Route preview playback (docs/superpowers/specs/2026-10-09-wallymap-m3-design.md §6): the camera follows a route
 * at Follow pitch, heading-up, while the traversed part fills in purple→coral. Everything here is pure except the
 * small preview bus at the bottom, which lets the map, the inspect card and the preview control talk without
 * threading `dispatch` through components/App.tsx.
 */

/** 1× plays 10 km per minute of wall time (Wally: 60 s per 10 km). */
export const BASE_KM_PER_MIN = 10;
/** The speed multipliers the control offers. */
export const SPEEDS = [0.5, 1, 2, 4] as const;
export const FOLLOW_PITCH = pitchFor("follow");
export const FOLLOW_MIN_ZOOM = 15;
export const FOLLOW_MAX_ZOOM = 17;
/** Camera eases at the start and end of a preview (Wally: 300–500 ms). */
export const PREVIEW_EASE_MS = 400;
export const DEFAULT_LOOKAHEAD_M = 40;
/** Frame spacing for `playbackFrames`. */
export const FPS = 60;

export type PlaybackFrame = { fraction: number; lngLat: [number, number]; bearing: number };

type Metrics = { coords: Position[]; cum: number[]; total: number };
const metricsCache = new WeakMap<LineString, Metrics>();

/** Cumulative distances for `line`, cached per line object (a preview asks for them every frame). */
function metrics(line: LineString): Metrics {
  let m = metricsCache.get(line);
  if (!m) {
    const cum = cumulativeMeters(line.coordinates);
    m = { coords: line.coordinates, cum, total: cum[cum.length - 1] ?? 0 };
    metricsCache.set(line, m);
  }
  return m;
}

export function lengthMeters(line: LineString): number {
  return metrics(line).total;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The point `meters` along the line, clamped to its ends (binary search over the cumulative distances). */
export function positionAtMeters(line: LineString, meters: number): [number, number] {
  const { coords, cum, total } = metrics(line);
  if (coords.length === 0) return [0, 0];
  if (coords.length === 1 || total === 0) return [coords[0][0], coords[0][1]];
  const d = clamp(meters, 0, total);
  let lo = 1;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < d) lo = mid + 1;
    else hi = mid;
  }
  const span = cum[lo] - cum[lo - 1];
  const t = span > 0 ? (d - cum[lo - 1]) / span : 0;
  const [x0, y0] = coords[lo - 1];
  const [x1, y1] = coords[lo];
  return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
}

/** The point at `fraction` (0 = start, 1 = end) of the line's length. */
export function positionAt(line: LineString, fraction: number): [number, number] {
  return positionAtMeters(line, clamp(fraction, 0, 1) * lengthMeters(line));
}

/**
 * The heading at `fraction`: from the current point to the point `lookAheadM` further on. In the last
 * `lookAheadM` of the line it uses the stretch just behind the end instead, so the heading never collapses.
 */
export function bearingAt(line: LineString, fraction: number, lookAheadM = DEFAULT_LOOKAHEAD_M): number {
  const total = lengthMeters(line);
  if (total === 0) return 0;
  const here = clamp(fraction, 0, 1) * total;
  const from = here + lookAheadM > total ? Math.max(0, total - lookAheadM) : here;
  const to = Math.min(total, from + lookAheadM);
  return bearingDeg(positionAtMeters(line, from), positionAtMeters(line, to));
}

/** How far the fraction moves in `dtMs` at `speedKmPerMin`. */
export function fractionStep(line: LineString, speedKmPerMin: number, dtMs: number): number {
  const total = lengthMeters(line);
  if (total === 0) return 1;
  return (speedKmPerMin * 1000 * (dtMs / 60_000)) / total;
}

/** The ground speed for a multiplier of the 1× speed. */
export function speedKmPerMin(multiplier: number): number {
  return BASE_KM_PER_MIN * multiplier;
}

/** Follow zoom: 16 at 1×, one level closer per halving of speed, held within 15–17. */
export function followZoom(kmPerMin: number): number {
  if (!(kmPerMin > 0)) return FOLLOW_MAX_ZOOM;
  return clamp(16 - Math.log2(kmPerMin / BASE_KM_PER_MIN), FOLLOW_MIN_ZOOM, FOLLOW_MAX_ZOOM);
}

/**
 * Camera keyframes at 60 fps spacing for a ride along `line` at `kmPerMin`, ending exactly on the last point.
 * A generator, so a long route is not materialized up front.
 */
export function* playbackFrames(
  line: LineString,
  kmPerMin: number,
  lookAheadM = DEFAULT_LOOKAHEAD_M,
): Generator<PlaybackFrame> {
  const step = fractionStep(line, kmPerMin, 1000 / FPS);
  let fraction = 0;
  for (;;) {
    yield { fraction, lngLat: positionAt(line, fraction), bearing: bearingAt(line, fraction, lookAheadM) };
    if (fraction >= 1) return;
    fraction = Math.min(1, fraction + step);
  }
}

/** Smallest signed turn from bearing `a` to bearing `b`, in (-180, 180]. */
export function turnBetween(a: number, b: number): number {
  const d = (((b - a) % 360) + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The route gradient's color at `t` (0 purple to 1 coral), as `rgb()`. */
export function gradientColorAt(t: number): string {
  const colors = gradientColors().map(hexToRgb);
  const x = clamp(t, 0, 1) * (GRADIENT_STOPS - 1);
  const i = Math.min(GRADIENT_STOPS - 2, Math.floor(x));
  const f = x - i;
  const [a, b] = [colors[i], colors[i + 1]];
  const mix = (k: number) => Math.round(a[k] + (b[k] - a[k]) * f);
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
}

const CLEAR = "rgba(0, 0, 0, 0)";
const EDGE = 1e-4;

/**
 * `line-gradient` for a preview at `fraction`: the part already traversed keeps its purple→coral color by
 * position, and everything ahead is transparent, so only the white casing shows there.
 */
export function progressGradient(fraction: number): ExpressionSpecification {
  const f = clamp(Number.isFinite(fraction) ? fraction : 0, 0, 1);
  if (f <= 0) return ["interpolate", ["linear"], ["line-progress"], 0, CLEAR, 1, CLEAR];
  const stops: (number | string)[] = [];
  gradientColors().forEach((color, i) => {
    const at = i / (GRADIENT_STOPS - 1);
    if (at < f) stops.push(at, color);
  });
  if (f >= 1) stops.push(1, gradientColors()[GRADIENT_STOPS - 1]);
  else {
    stops.push(f, gradientColorAt(f));
    if (f + EDGE < 1) stops.push(f + EDGE, CLEAR, 1, CLEAR);
    else stops.push(1, CLEAR);
  }
  return ["interpolate", ["linear"], ["line-progress"], ...stops] as ExpressionSpecification;
}

/**
 * A route built from a clicked line feature. A MultiLineString uses its longest part, since its parts are often
 * unordered and joining them would jump between pieces.
 */
export function routeFromFeature(feature: Feature, layerId: string, name?: string): RouteState | null {
  const g = feature.geometry;
  let coords: Position[] | undefined;
  if (g?.type === "LineString") coords = g.coordinates;
  else if (g?.type === "MultiLineString") {
    let best = -1;
    for (const part of g.coordinates) {
      const len = part.length > 1 ? lengthMeters({ type: "LineString", coordinates: part }) : 0;
      if (len > best) {
        best = len;
        coords = part;
      }
    }
  }
  if (!coords || coords.length < 2) return null;
  const line: LineString = { type: "LineString", coordinates: coords };
  const first = coords[0];
  const last = coords[coords.length - 1];
  const key = feature.id ?? `${first[0].toFixed(5)},${first[1].toFixed(5)}`;
  return {
    id: `feature-${layerId}-${key}`,
    name,
    line,
    source: "feature",
    distanceKm: lengthMeters(line) / 1000,
    waypoints: [
      { lngLat: [first[0], first[1]], type: "start" },
      { lngLat: [last[0], last[1]], type: "end" },
    ],
  };
}

// ---- Preview bus ----
// components/App.tsx owns the reducer and does not pass `dispatch` or the full state to the chat rail, so the
// preview pieces meet here, like lib/agent/chatBus.ts: PreviewControl (mounted in the chat rail) registers a
// dispatcher, MapCanvas publishes the map state and the per-frame position, and the inspect card starts previews.

type Listener = () => void;

/** A minimal external store for `useSyncExternalStore`. */
export function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return;
      value = next;
      for (const l of listeners) l();
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

type Dispatch = (action: MapAction) => void;
const dispatchers = new Set<Dispatch>();

/** Registers the app's dispatcher; returns the unsubscribe function (use it as an effect cleanup). */
export function onPreviewDispatch(dispatch: Dispatch): () => void {
  dispatchers.add(dispatch);
  return () => {
    dispatchers.delete(dispatch);
  };
}

/** Dispatches through the registered dispatcher; false when none is mounted. */
export function dispatchPreview(...actions: MapAction[]): boolean {
  const [first] = dispatchers;
  if (!first) return false;
  for (const action of actions) first(action);
  return true;
}

/** Starts a preview of a clicked line feature; false when the feature is not a line or nothing can dispatch. */
export function previewFeature(feature: Feature, layerId: string, name?: string): boolean {
  if (dispatchers.size === 0) return false;
  const route = routeFromFeature(feature, layerId, name);
  if (!route) return false;
  return dispatchPreview({ type: "route_loaded", route }, { type: "preview_start", routeId: route.id });
}

/** The map state as MapCanvas last rendered it. */
export const mapStateStore = createStore<MapState | null>(null);
/** The playing position, updated every animation frame (the reducer only hears about it a few times a second). */
export const liveFractionStore = createStore<{ routeId: string; fraction: number } | null>(null);
/** Terrain heights (meters) at the profile's sample points, filled in as terrain tiles load. */
export const elevationStore = createStore<{ routeId: string; values: (number | null)[] } | null>(null);
