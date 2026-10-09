import type { CompareState, LoadedLayer, MapAction, MapState, RenderOp, TimeState, Viewport } from "@/lib/render/state";
import type { LayerFilters } from "@/lib/render/filters";
import { stepWindow, timeIndex, type TimeIndex, type TimeWindow } from "@/lib/time";
import { arrivalPitch, fitZoomOffset } from "@/lib/render/wally/terrain";

/** The `layer_error` id a failed `route` tool call reports under. */
export const ROUTE_ERROR_ID = "route";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/** A playback speed multiplier, or undefined when it is not a positive number. */
function validSpeed(speed: number | undefined): number | undefined {
  return speed !== undefined && Number.isFinite(speed) && speed > 0 ? speed : undefined;
}

/** Applies `change` to the op for `layerId`; returns `state` untouched when there is no such op. */
function updateOp(state: MapState, layerId: string, change: (op: RenderOp) => RenderOp): MapState {
  if (!state.renderOps.some((op) => op.layerId === layerId)) return state;
  return { ...state, renderOps: state.renderOps.map((op) => (op.layerId === layerId ? change(op) : op)) };
}

/** Drops the selection when it belongs to `layerId` (the layer was removed, hidden or reloaded). */
function dropSelectionOf(state: MapState, layerId: string): MapState["selected"] {
  return state.selected?.layerId === layerId ? undefined : state.selected;
}

/** Returns `state` itself when the pitch is unchanged, so the map does not see a new viewport. */
function withPitch(state: MapState, pitch: number): MapState {
  return state.viewport.pitch === pitch ? state : { ...state, viewport: { ...state.viewport, pitch } };
}

/**
 * A camera move. The map reports its own camera with a pitch, which passes unchanged; an agent move or a fit
 * without one takes the arrival pitch (45 at zoom 10 and above unless flattened, else 0), and a fit backs its
 * zoom off for that pitch so the tilted view still shows the whole target.
 */
function setView(state: MapState, requested: Partial<Viewport>, fit: boolean): MapState {
  const viewport = { ...state.viewport, ...requested };
  if (requested.pitch === undefined) viewport.pitch = arrivalPitch(viewport.zoom, state.flattened);
  if (fit) viewport.zoom = Math.max(0, viewport.zoom - fitZoomOffset(viewport.pitch));
  return { ...state, viewport };
}

/** The filters that restrict something (a non-empty include, or a range); undefined when none do. */
export function activeFilters(filters: LayerFilters | undefined): LayerFilters | undefined {
  if (!filters) return undefined;
  const kept = Object.entries(filters).filter(([, f]) => (f.include !== undefined && f.include.length > 0) || f.range !== undefined);
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

// ---- Time scrubber ----

/** The whole span of the index: the first bucket's start to the last bucket's end. */
export function fullWindow(index: TimeIndex): TimeWindow {
  return [index.buckets[0].start, index.buckets[index.buckets.length - 1].end];
}

/** The bucket a date falls in (the last bucket starting at or before it), clamped to the ends. */
export function bucketAt(index: TimeIndex, iso: string): number {
  const ms = Date.parse(iso);
  let at = 0;
  for (let i = 0; i < index.buckets.length; i++) if (Date.parse(index.buckets[i].start) <= ms) at = i;
  return at;
}

/** Keeps a window inside the data's span, ends in order; an unreadable or disjoint window becomes the whole span. */
function clampWindow(index: TimeIndex, window: TimeWindow): TimeWindow {
  const [lo, hi] = fullWindow(index);
  let a = Date.parse(window[0]);
  let b = Date.parse(window[1]);
  if (Number.isNaN(a) || Number.isNaN(b)) return [lo, hi];
  if (a > b) [a, b] = [b, a];
  const start = Math.max(a, Date.parse(lo));
  const end = Math.min(b, Date.parse(hi));
  if (start > end) return [lo, hi];
  return [start === Date.parse(lo) ? lo : new Date(start).toISOString(), end === Date.parse(hi) ? hi : new Date(end).toISOString()];
}

/** Starts play. From the end (or with the whole span selected) it starts over at the first bucket, keeping the width. */
function startPlaying(time: TimeState): TimeState {
  const { index, window, mode } = time;
  const last = index.buckets.length - 1;
  const i = bucketAt(index, window[0]);
  const j = bucketAt(index, window[1]);
  if (j < last) return { ...time, playing: true };
  if (mode === "cumulative") return { ...time, playing: true, window: [index.min, index.buckets[0].end] };
  const width = j - i >= last ? 0 : j - i;
  return { ...time, playing: true, window: [index.buckets[0].start, index.buckets[width].end] };
}

/** True when the layer's op hides it (a layer with no op yet counts as shown: its op follows the load). */
function isHidden(state: MapState, layerId: string): boolean {
  return state.renderOps.some((op) => op.layerId === layerId && !op.visible);
}

/** True when the layer has at least one feature with a valid `t`. */
function isDated(layer: LoadedLayer | undefined): boolean {
  return layer !== undefined && timeIndex({ [layer.id]: layer }) !== null;
}

/** The time index over the shown layers only: a hidden layer's dates neither open the scrubber nor widen it (spec §5). */
function shownTimeIndex(state: MapState): TimeIndex | null {
  const shown = Object.fromEntries(Object.entries(state.layers).filter(([id]) => !isHidden(state, id)));
  return timeIndex(shown);
}

/** True when the window covers every date in the index (the opening state, or the user widened it all the way). */
function coversSpan(index: TimeIndex, window: TimeWindow): boolean {
  return Date.parse(window[0]) <= Date.parse(index.min) && Date.parse(window[1]) >= Date.parse(index.max);
}

/**
 * The window after the index changed. A window that covered the old span follows the data to the whole new span (a
 * re-query with earlier dates shows them); a window the user or agent narrowed stays where it was, clamped to the data.
 */
function rewindow(time: TimeState, index: TimeIndex): TimeWindow {
  const window = coversSpan(time.index, time.window) ? fullWindow(index) : clampWindow(index, time.window);
  return time.mode === "cumulative" ? [index.min, window[1]] : window;
}

/**
 * Rebuilds the time index after the layers (or which of them are shown) changed. No shown time-aware layer left clears
 * the scrubber. Only a newly loaded or newly shown layer may open the scrubber (`allowCreate`), so removing or hiding a
 * layer never brings back a scrubber the user closed. A window the agent asked for early (`pendingTime`) applies here.
 */
function withTimeIndex(state: MapState, allowCreate: boolean): MapState {
  const index = shownTimeIndex(state);
  if (!index) return state.time ? { ...state, time: undefined } : state;
  if (state.time) return { ...state, time: { ...state.time, index, window: rewindow(state.time, index) } };
  if (!allowCreate) return state;
  const pending = state.pendingTime;
  const mode = pending?.mode ?? "slide";
  const window = pending?.window ? clampWindow(index, pending.window) : fullWindow(index);
  let time: TimeState = { index, mode, playing: false, window: mode === "cumulative" ? [index.min, window[1]] : window };
  if (pending?.playing) time = startPlaying(time);
  return { ...state, time, pendingTime: undefined };
}

/** Rebuilds the time index when `layerId` (a dated layer) was hidden or shown; showing it may open the scrubber. */
function withShownChange(prev: MapState, next: MapState, layerId: string): MapState {
  const hidden = isHidden(next, layerId);
  if (hidden === isHidden(prev, layerId) || !isDated(next.layers[layerId])) return next;
  return withTimeIndex(next, !hidden);
}

// ---- Compare over time ----

/** A window with its ends in order (an unreadable end is left as given). */
function ordered(w: [string, string]): [string, string] {
  const a = Date.parse(w[0]);
  const b = Date.parse(w[1]);
  return !Number.isNaN(a) && !Number.isNaN(b) && a > b ? [w[1], w[0]] : [w[0], w[1]];
}

/** Starts a compare: windows in order, toggle on A, the scrubber paused, and no selection left on the compared layer. */
function startCompare(state: MapState, compare: CompareState): MapState {
  const next: CompareState = { ...compare, a: ordered(compare.a), b: ordered(compare.b), side: "a" };
  const time = state.time?.playing ? { ...state.time, playing: false } : state.time;
  return { ...state, compare: next, time, selected: dropSelectionOf(state, compare.layerId) };
}

/** Drops the compare when it is on `layerId` (the layer was removed). */
function dropCompareOf(state: MapState, layerId: string): MapState["compare"] {
  return state.compare?.layerId === layerId ? undefined : state.compare;
}

function sameWindow(a: TimeWindow, b: TimeWindow): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * Pure reducer: always returns new objects and never mutates `state`. Selecting or deselecting a feature never
 * moves the camera; only `set_view` and the 3D button do.
 */
export function reduce(state: MapState, action: MapAction): MapState {
  return reduceAction(state, action);
}

function reduceAction(state: MapState, action: MapAction): MapState {
  switch (action.type) {
    case "set_view":
      return setView(state, action.viewport, action.fit === true);
    case "set_terrain":
      return state.terrain === action.terrain ? state : { ...state, terrain: action.terrain };
    case "set_flattened": {
      if (action.flattened) return withPitch({ ...state, flattened: true }, 0);
      // Turning 3D back on brings the terrain back, and tilts the camera when it is at trail zooms.
      const next = { ...state, flattened: false, terrain: true };
      return withPitch(next, arrivalPitch(state.viewport.zoom, false) || state.viewport.pitch);
    }
    case "set_basemap":
      if (state.basemap === action.basemap) return state;
      // A style swap drops the route layers the preview draws on, so the preview ends with it.
      return { ...state, basemap: action.basemap, playback: undefined };
    case "layer_loaded":
      return withTimeIndex(
        {
          ...state,
          layers: { ...state.layers, [action.layer.id]: action.layer },
          errors: state.errors.filter((e) => e.layerId !== action.layer.id),
          // A reload replaces the features, so the old selection no longer points at anything drawn.
          selected: dropSelectionOf(state, action.layer.id),
        },
        true,
      );
    case "layer_error":
      return {
        ...state,
        errors: [...state.errors, { layerId: action.layerId, message: action.message }],
      };
    case "render": {
      const index = state.renderOps.findIndex((op) => op.layerId === action.op.layerId);
      const renderOps =
        index === -1
          ? [...state.renderOps, action.op]
          : state.renderOps.map((op, i) =>
              // The agent restyling a layer keeps the opacity and filters the user picked in the layer panel.
              i === index
                ? {
                    ...action.op,
                    opacity: action.op.opacity ?? op.opacity,
                    filters: action.op.filters !== undefined ? activeFilters(action.op.filters) : op.filters,
                  }
                : op,
            );
      // Heat is not clickable, so a selection on a layer that turns into heat would point at nothing drawn.
      const selected = action.op.mode === "heat" ? dropSelectionOf(state, action.op.layerId) : state.selected;
      const next = { ...state, renderOps, selected };
      return withShownChange(state, next, action.op.layerId);
    }
    case "toggle_layer": {
      const next = updateOp(state, action.layerId, (op) => ({ ...op, visible: !op.visible }));
      if (next === state) return state;
      const op = next.renderOps.find((o) => o.layerId === action.layerId);
      const shown = op?.visible ? next : { ...next, selected: dropSelectionOf(next, action.layerId) };
      return withShownChange(state, shown, action.layerId);
    }
    case "select":
      return { ...state, selected: action.selection };
    case "deselect":
      return state.selected === undefined ? state : { ...state, selected: undefined };
    case "set_opacity":
      return updateOp(state, action.layerId, (op) => ({ ...op, opacity: clamp01(action.opacity) }));
    case "set_style": {
      const next = updateOp(state, action.layerId, (op) => ({
        ...op,
        ...(action.color !== undefined && { color: action.color }),
        ...(action.mode !== undefined && { mode: action.mode }),
      }));
      return next !== state && action.mode === "heat" ? { ...next, selected: dropSelectionOf(next, action.layerId) } : next;
    }
    case "set_filters":
      return updateOp(state, action.layerId, (op) => {
        const { filters: _old, ...rest } = op;
        void _old;
        const filters = activeFilters(action.filters);
        return filters ? { ...rest, filters } : rest;
      });
    case "reorder": {
      const from = state.renderOps.findIndex((op) => op.layerId === action.layerId);
      if (from === -1) return state;
      const to = Math.min(state.renderOps.length - 1, Math.max(0, Math.trunc(action.toIndex)));
      if (to === from) return state;
      const renderOps = [...state.renderOps];
      const [moved] = renderOps.splice(from, 1);
      renderOps.splice(to, 0, moved);
      return { ...state, renderOps };
    }
    case "remove_layer": {
      if (!state.layers[action.layerId] && !state.renderOps.some((op) => op.layerId === action.layerId)) return state;
      const layers = { ...state.layers };
      delete layers[action.layerId];
      return withTimeIndex(
        {
          ...state,
          layers,
          renderOps: state.renderOps.filter((op) => op.layerId !== action.layerId),
          errors: state.errors.filter((e) => e.layerId !== action.layerId),
          selected: dropSelectionOf(state, action.layerId),
          compare: dropCompareOf(state, action.layerId),
        },
        false,
      );
    }
    case "clear_layers":
      return {
        ...state,
        layers: {},
        routes: {},
        renderOps: [],
        errors: [],
        selected: undefined,
        playback: undefined,
        time: undefined,
        pendingTime: undefined,
        compare: undefined,
      };
    case "route_loaded":
      return {
        ...state,
        routes: { ...state.routes, [action.route.id]: action.route },
        // A route that arrived supersedes an earlier failed route request.
        errors: state.errors.filter((e) => e.layerId !== ROUTE_ERROR_ID),
      };
    case "route_removed": {
      if (!state.routes[action.routeId]) return state;
      const routes = { ...state.routes };
      delete routes[action.routeId];
      // Previewing a route that is gone would follow nothing.
      const playback = state.playback?.routeId === action.routeId ? undefined : state.playback;
      return { ...state, routes, playback };
    }
    case "routes_cleared":
      return Object.keys(state.routes).length === 0 && !state.playback ? state : { ...state, routes: {}, playback: undefined };
    case "preview_start":
      if (!state.routes[action.routeId]) return state;
      return {
        ...state,
        selected: undefined,
        playback: { routeId: action.routeId, fraction: 0, playing: true, speed: validSpeed(action.speed) ?? 1 },
      };
    case "preview_tick": {
      if (!state.playback || !Number.isFinite(action.fraction)) return state;
      const fraction = Math.min(1, Math.max(0, action.fraction));
      const playing = state.playback.playing && fraction < 1;
      if (fraction === state.playback.fraction && playing === state.playback.playing) return state;
      return { ...state, playback: { ...state.playback, fraction, playing } };
    }
    case "preview_toggle": {
      if (!state.playback) return state;
      const { playing, fraction } = state.playback;
      return {
        ...state,
        playback: { ...state.playback, playing: !playing, fraction: !playing && fraction >= 1 ? 0 : fraction },
      };
    }
    case "preview_speed": {
      const speed = validSpeed(action.speed);
      if (!state.playback || speed === undefined || speed === state.playback.speed) return state;
      return { ...state, playback: { ...state.playback, speed } };
    }
    case "preview_stop":
      return state.playback ? { ...state, playback: undefined } : state;
    case "set_time_window": {
      if (!state.time) {
        // No time-aware layer yet (the agent set the time before its query landed): apply it when one arrives.
        const index = shownTimeIndex(state);
        const pendingTime = { ...state.pendingTime, window: action.window };
        return index ? withTimeIndex({ ...state, pendingTime }, true) : { ...state, pendingTime };
      }
      const clamped = clampWindow(state.time.index, action.window);
      const window: TimeWindow = state.time.mode === "cumulative" ? [state.time.index.min, clamped[1]] : clamped;
      return sameWindow(window, state.time.window) ? state : { ...state, time: { ...state.time, window } };
    }
    case "set_time_playing": {
      if (!state.time) return state.pendingTime ? { ...state, pendingTime: { ...state.pendingTime, playing: action.playing } } : state;
      if (state.time.playing === action.playing) return state;
      return { ...state, time: action.playing ? startPlaying(state.time) : { ...state.time, playing: false } };
    }
    case "set_time_mode": {
      // Before any dated layer, the mode waits with (or ahead of) the window the agent asks for next.
      if (!state.time) return { ...state, pendingTime: { ...state.pendingTime, mode: action.mode } };
      if (state.time.mode === action.mode) return state;
      const window: TimeWindow = action.mode === "cumulative" ? [state.time.index.min, state.time.window[1]] : state.time.window;
      return { ...state, time: { ...state.time, mode: action.mode, window } };
    }
    case "time_tick": {
      const time = state.time;
      if (!time?.playing) return state;
      const window = stepWindow(time.index, time.window, 1, time.mode);
      // Nothing left to step to: play ends on the last frame.
      if (sameWindow(window, time.window)) return { ...state, time: { ...time, playing: false } };
      return { ...state, time: { ...time, window } };
    }
    case "clear_time":
      return state.time || state.pendingTime ? { ...state, time: undefined, pendingTime: undefined } : state;
    case "set_compare":
      return startCompare(state, action.compare);
    case "set_compare_mode":
      if (!state.compare || state.compare.mode === action.mode) return state;
      return { ...state, compare: { ...state.compare, mode: action.mode, side: "a" } };
    case "compare_flip":
      if (!state.compare) return state;
      return { ...state, compare: { ...state.compare, side: state.compare.side === "b" ? "a" : "b" } };
    case "clear_compare":
      return state.compare ? { ...state, compare: undefined } : state;
  }
}
