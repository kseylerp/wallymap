import type { Feature, LineString, Position } from "geojson";
import type { ExpressionSpecification } from "mapbox-gl";
import type { MapAction, MapState, RouteState } from "@/lib/render/state";
import { bearingDeg, cumulativeMeters, gradientColors, GRADIENT_STOPS } from "@/lib/render/wally/routeLine";
import { pitchFor } from "@/lib/render/wally/terrain";

/**
 * Route preview playback (docs/superpowers/specs/2026-10-09-wallymap-m3-design.md §6): a chase camera follows a
 * route at Follow pitch, heading-up, with the followed point in the lower third of the clear map so the way ahead
 * fills the screen, while the traversed part fills in purple→coral. Everything here is pure except the
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
/** The ease from the camera before the preview up to the route overview. */
export const PREVIEW_OVERVIEW_MS = 800;
/** The dive from the overview down into the chase camera at the start (and again after the outro). */
export const PREVIEW_DIVE_MS = 1200;
/** The rise back to the overview at the end of the ride, and back to the earlier camera on exit. */
export const PREVIEW_RISE_MS = 1200;
/** How long the camera holds on the finish before rising to the overview. */
export const OUTRO_HOLD_MS = 700;
export const DEFAULT_LOOKAHEAD_M = 40;
/** Chase pitch with 3D off: lower, so the flat map still reads as a map. */
export const CHASE_FLAT_PITCH = pitchFor("explore");
/** Where the followed point sits in the clear band, from its top (0) to its bottom (1): the lower third. */
export const CHASE_POINT_AT = 0.7;
/** The heading eases toward its target with this time constant... */
export const BEARING_SMOOTH_MS = 900;
/** ...and never turns faster than this. */
export const MAX_TURN_DEG_PER_S = 45;
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
 * How far ahead the chase heading looks: about 3 s of travel, 250 m to 1.2 km. Long enough that a run of
 * switchbacks averages out to the way the trail is really going.
 */
export function bearingLookAheadM(kmPerMin: number): number {
  const perSecond = Number.isFinite(kmPerMin) && kmPerMin > 0 ? (kmPerMin * 1000) / 60 : 0;
  return clamp(3 * perSecond, 250, 1200);
}

/**
 * The next heading from `current` toward `target` after `dtMs`: an exponential ease (time constant `tauMs`) that
 * turns the short way and never faster than `maxDegPerSec`. Returns a bearing in (-180, 180].
 */
export function smoothBearing(
  current: number,
  target: number,
  dtMs: number,
  tauMs = BEARING_SMOOTH_MS,
  maxDegPerSec = MAX_TURN_DEG_PER_S,
): number {
  const dt = Math.max(0, dtMs);
  const turn = turnBetween(current, target);
  const eased = turn * (1 - Math.exp(-dt / Math.max(1, tauMs)));
  const limit = (maxDegPerSec * dt) / 1000;
  return turnBetween(0, current + clamp(eased, -limit, limit));
}

/** The chase pitch: Follow with 3D on, lower with the map flattened. */
export function chasePitch(flattened: boolean): number {
  return flattened ? CHASE_FLAT_PITCH : FOLLOW_PITCH;
}

/**
 * Padding that puts the followed point `at` of the way down the clear band `padding` leaves (Mapbox draws the
 * camera center in the middle of the padded area, so only the top inset grows). The bottom inset, and so the
 * edge against the dock, is unchanged: the point stays inside the band.
 */
export function chasePadding(padding: Insets, canvasHeight: number, at = CHASE_POINT_AT): Insets {
  const band = canvasHeight - padding.top - padding.bottom;
  if (!(band > 0)) return padding;
  return { ...padding, top: padding.top + (2 * clamp(at, 0.5, 1) - 1) * band };
}

/** How high above the followed point (as a share of the canvas height) the "trail ahead" is measured to. */
export const AHEAD_SCREEN_FRACTION = 0.2;

/**
 * Ground meters between the followed point and the screen line `AHEAD_SCREEN_FRACTION` of the canvas above it, for
 * a camera at `zoom` and `pitch` (degrees) over flat ground. The camera sits `cameraDistanceMeters` from the point,
 * at height D·cos p and D·sin p behind it; the ray through that screen line leaves at p + α from straight down,
 * with tan α = fraction / 1.5 (the 36.87° field of view), and lands D·cos p·tan(p + α) − D·sin p past the point.
 */
export function aheadMeters(zoom: number, pitch: number, lat: number, heightPx: number): number {
  const d = cameraDistanceMeters(zoom, lat, heightPx);
  const p = (clamp(pitch, 0, 85) * Math.PI) / 180;
  const ray = p + Math.atan(AHEAD_SCREEN_FRACTION / 1.5);
  if (ray >= Math.PI / 2 - 1e-6) return Infinity;
  return d * (Math.cos(p) * Math.tan(ray) - Math.sin(p));
}

/** Trail the chase camera shows ahead: 450 m at 1×, 300 m at 0.5×, 600 m from 2× up. */
export function aheadTargetMeters(kmPerMin: number): number {
  if (!(kmPerMin > 0)) return 300;
  return clamp(450 * Math.sqrt(kmPerMin / BASE_KM_PER_MIN), 300, 600);
}

export const CHASE_MIN_ZOOM = 14.5;
export const CHASE_MAX_ZOOM = 17.5;

/**
 * The chase zoom that shows `aheadTargetMeters` of trail ahead (see `aheadMeters`) at `pitch` on a canvas
 * `heightPx` tall, within 14.5–17.5. Falls back to `followZoom` before the canvas has a size.
 */
export function chaseZoom(kmPerMin: number, pitch: number, lat: number, heightPx: number): number {
  if (!(heightPx > 0)) return followZoom(kmPerMin);
  const atZoom0 = aheadMeters(0, pitch, lat, heightPx);
  return clamp(Math.log2(atZoom0 / aheadTargetMeters(kmPerMin)), CHASE_MIN_ZOOM, CHASE_MAX_ZOOM);
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

/** Ground meters per CSS pixel at `zoom` and latitude `lat` (Mapbox's 512 px world tiles). */
export function metersPerPixel(zoom: number, lat: number): number {
  return (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
}

/** Camera-to-target distance in meters for a canvas `heightPx` tall (Mapbox's default 36.87° vertical field of view). */
export function cameraDistanceMeters(zoom: number, lat: number, heightPx: number): number {
  return 1.5 * heightPx * metersPerPixel(zoom, lat);
}

/** The point `meters` from `from` on `bearing` (flat approximation, fine over a few kilometers). */
export function offsetPoint(from: [number, number], bearing: number, meters: number): [number, number] {
  const b = (bearing * Math.PI) / 180;
  const dLat = (meters * Math.cos(b)) / 110_574;
  const dLng = (meters * Math.sin(b)) / (111_320 * Math.cos((from[1] * Math.PI) / 180));
  return [from[0] + dLng, from[1] + dLat];
}

export type Insets = { top: number; right: number; bottom: number; left: number };
export type Rect = { left: number; top: number; right: number; bottom: number };

/** The clear band the followed point gets (px, each axis): this much when the soft insets can give way... */
const WANTED_CLEAR_PX = 120;
/** ...and never less than this; below it the padding does not fit (a phone then collapses the preview dock). */
export const MIN_CLEAR_PX = 80;
const OBSTACLE_MARGIN = 24;

export type FollowPadding = { padding: Insets; fits: boolean };

/**
 * Camera padding that puts the followed point in the middle of the map nobody covers: `base` (from
 * `visibleMapPadding`: header, margins) grown past each obstacle (the preview dock, the chat sheet or panel). Each
 * obstacle pushes in from whichever side leaves the larger clear area, so a left-hand panel pads the left and a
 * phone's bottom sheet pads the bottom. Obstacle edges are hard: the clear band never reaches under one. When an
 * axis is short of room, the soft parts (base insets and the 24px margin) shrink first to keep 120px clear. `fits`
 * is false when the hard edges leave less than 80px on an axis; the padding then keeps the band as clear of the
 * obstacles as the canvas allows (at least 1px).
 */
export function followPadding(base: Insets, canvas: { width: number; height: number }, obstacles: Rect[]): FollowPadding {
  // The clear area some insets leave; when every choice leaves none, the least overlapped one wins.
  const area = (p: Insets) => {
    const w = canvas.width - p.left - p.right;
    const h = canvas.height - p.top - p.bottom;
    return w > 0 && h > 0 ? w * h : Math.min(w, h) - 1e9;
  };
  const boxes = obstacles
    .map((r) => ({
      left: Math.max(0, r.left),
      top: Math.max(0, r.top),
      right: Math.min(canvas.width, r.right),
      bottom: Math.min(canvas.height, r.bottom),
    }))
    .filter((r) => r.right > r.left && r.bottom > r.top)
    .slice(0, 4);
  // Every way of clearing each obstacle from one side (at most 4^4), judged by the hard edges alone: the soft
  // insets give way later anyway.
  const sidesOf = (r: Rect): [keyof Insets, number][] => [
    ["left", r.right],
    ["right", canvas.width - r.left],
    ["top", r.bottom],
    ["bottom", canvas.height - r.top],
  ];
  let best: Insets | null = null;
  const search = (i: number, current: Insets) => {
    if (i === boxes.length) {
      if (!best || area(current) > area(best)) best = current;
      return;
    }
    for (const [side, edge] of sidesOf(boxes[i])) search(i + 1, { ...current, [side]: Math.max(current[side], edge) });
  };
  search(0, { top: 0, right: 0, bottom: 0, left: 0 });
  const hard: Insets = best ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const pad: Insets = { ...base };
  for (const side of ["top", "right", "bottom", "left"] as const) {
    if (hard[side] > 0) pad[side] = Math.max(pad[side], hard[side] + OBSTACLE_MARGIN);
  }
  let fits = true;
  // Shrinks the soft parts of one axis toward the hard edges until `WANTED_CLEAR_PX` is clear.
  const fit = (size: number, a: number, b: number, hardA: number, hardB: number): [number, number] => {
    const excess = a + b - Math.max(0, size - WANTED_CLEAR_PX);
    if (excess > 0) {
      const slackA = a - hardA;
      const slackB = b - hardB;
      const slack = slackA + slackB;
      const cut = Math.min(excess, slack);
      if (slack > 0) {
        a -= Math.ceil((cut * slackA) / slack);
        b -= Math.ceil((cut * slackB) / slack);
      }
      a = Math.max(a, hardA);
      b = Math.max(b, hardB);
    }
    if (size - a - b < MIN_CLEAR_PX) fits = false;
    // Mapbox needs some canvas left; when even the hard edges overlap, keep the band against the far edge.
    if (size - a - b < 1) {
      b = Math.max(0, Math.min(b, size - 1));
      a = Math.max(0, size - 1 - b);
    }
    return [a, b];
  };
  [pad.top, pad.bottom] = fit(canvas.height, pad.top, pad.bottom, hard.top, hard.bottom);
  [pad.left, pad.right] = fit(canvas.width, pad.left, pad.right, hard.left, hard.right);
  return { padding: pad, fits };
}

/** The lowest pitch the follow camera drops to when a ridge would hide the route. */
export const MIN_CLEAR_PITCH = 35;
/** Sight line margin over the terrain, meters. */
const CLEARANCE_M = 20;

/**
 * The steepest pitch from `maxPitch` down to `MIN_CLEAR_PITCH` (in 5° steps) at which the camera, `distanceM` from
 * the target, sees it over the terrain behind it. `rises` are terrain heights relative to the target at ground
 * distances behind it (null where unknown). The sight line at ground distance d behind the target, for a camera
 * at ground distance D and height H, is H·d/D above the target.
 */
export function clearPitch(
  distanceM: number,
  rises: { behindM: number; rise: number | null }[],
  maxPitch = FOLLOW_PITCH,
): number {
  for (let pitch = maxPitch; pitch > MIN_CLEAR_PITCH; pitch -= 5) {
    const p = (pitch * Math.PI) / 180;
    const ground = distanceM * Math.sin(p);
    const height = distanceM * Math.cos(p);
    const blocked = rises.some(
      ({ behindM, rise }) => rise !== null && behindM <= ground && rise > (height * behindM) / ground - CLEARANCE_M,
    );
    if (!blocked) return pitch;
  }
  return MIN_CLEAR_PITCH;
}

/** The chase camera's eye stays at least this far above the ground under it (meters, exaggerated terrain). */
export const EYE_CLEARANCE_M = 40;
/** On steep ground the chase pitch drops no lower than this before the camera moves in instead... */
export const CHASE_MIN_PITCH = 50;
/** ...to no closer than this share of its distance, and only then tilts further, down to `CHASE_LAST_PITCH`. */
export const CHASE_MIN_SCALE = 0.5;
/** The last resort under a cliff: nearly top-down beats an eye inside the rock. */
export const CHASE_LAST_PITCH = 20;

/** Terrain height relative to the followed point at `behindM` meters behind it along the heading (null: unknown). */
export type RiseAt = (behindM: number) => number | null;

/**
 * True when a camera `distanceM` from the point at `pitch` sees it over the terrain behind it, with its eye at least
 * `EYE_CLEARANCE_M` above the ground straight below. Samples the ground every twelfth of the way back to the eye;
 * the sight line, H·d/G above the point at ground distance d (eye height H, eye ground distance G), must clear each
 * sample by 20 m (the nearest one, where the line is barely off the ground, is left out).
 */
export function chaseSees(distanceM: number, pitch: number, riseAt: RiseAt): boolean {
  const p = (pitch * Math.PI) / 180;
  const ground = distanceM * Math.sin(p);
  const height = distanceM * Math.cos(p);
  if (!(ground > 0)) return true;
  for (let k = 2; k <= 12; k++) {
    const d = (ground * k) / 12;
    const rise = riseAt(d);
    if (rise === null) continue;
    const allowed = k === 12 ? height - EYE_CLEARANCE_M : (height * d) / ground - CLEARANCE_M;
    if (rise > allowed) return false;
  }
  return true;
}

export type ChaseFit = { pitch: number; scale: number; clear: boolean };

/**
 * The chase camera for steep ground: the steepest pitch from `maxPitch` down to `CHASE_MIN_PITCH` (5° steps) that
 * sees the point (`chaseSees`); failing that, the camera moves in at that pitch (×0.8 steps, to `CHASE_MIN_SCALE`
 * of `distanceM`) so it sits in front of the wall behind; failing that, it tilts on down to `CHASE_LAST_PITCH` at
 * the closest distance. `scale` multiplies the camera distance (zoom + log2(1/scale)); `clear` is false when even
 * the last resort is blocked.
 */
export function chaseFit(distanceM: number, riseAt: RiseAt, maxPitch = FOLLOW_PITCH): ChaseFit {
  const floor = Math.min(maxPitch, CHASE_MIN_PITCH);
  for (let pitch = maxPitch; pitch >= floor; pitch -= 5) {
    if (chaseSees(distanceM, pitch, riseAt)) return { pitch, scale: 1, clear: true };
  }
  let scale = 1;
  while (scale * 0.8 >= CHASE_MIN_SCALE - 1e-9) {
    scale *= 0.8;
    if (chaseSees(distanceM * scale, floor, riseAt)) return { pitch: floor, scale, clear: true };
  }
  scale = CHASE_MIN_SCALE;
  for (let pitch = floor - 5; pitch >= CHASE_LAST_PITCH; pitch -= 5) {
    if (chaseSees(distanceM * scale, pitch, riseAt)) return { pitch, scale, clear: true };
  }
  return { pitch: CHASE_LAST_PITCH, scale, clear: false };
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
/** True when the preview dock should drop its profile so the followed point has room above it (phones only). */
export const dockCompactStore = createStore(false);
