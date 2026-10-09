import type { MapAction, MapState, RenderOp, Viewport } from "@/lib/render/state";
import { arrivalPitch, fitZoomOffset } from "@/lib/render/wally/terrain";

/** The `layer_error` id a failed `route` tool call reports under. */
export const ROUTE_ERROR_ID = "route";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
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
      return { ...state, basemap: action.basemap };
    case "layer_loaded":
      return {
        ...state,
        layers: { ...state.layers, [action.layer.id]: action.layer },
        errors: state.errors.filter((e) => e.layerId !== action.layer.id),
        // A reload replaces the features, so the old selection no longer points at anything drawn.
        selected: dropSelectionOf(state, action.layer.id),
      };
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
              // The agent restyling a layer keeps the opacity the user picked in the layer panel.
              i === index ? { ...action.op, opacity: action.op.opacity ?? op.opacity } : op,
            );
      // Heat is not clickable, so a selection on a layer that turns into heat would point at nothing drawn.
      const selected = action.op.mode === "heat" ? dropSelectionOf(state, action.op.layerId) : state.selected;
      return { ...state, renderOps, selected };
    }
    case "toggle_layer": {
      const next = updateOp(state, action.layerId, (op) => ({ ...op, visible: !op.visible }));
      if (next === state) return state;
      const op = next.renderOps.find((o) => o.layerId === action.layerId);
      return op?.visible ? next : { ...next, selected: dropSelectionOf(next, action.layerId) };
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
      return {
        ...state,
        layers,
        renderOps: state.renderOps.filter((op) => op.layerId !== action.layerId),
        errors: state.errors.filter((e) => e.layerId !== action.layerId),
        selected: dropSelectionOf(state, action.layerId),
      };
    }
    case "clear_layers":
      return { ...state, layers: {}, routes: {}, renderOps: [], errors: [], selected: undefined };
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
      return { ...state, routes };
    }
    case "routes_cleared":
      return Object.keys(state.routes).length === 0 ? state : { ...state, routes: {} };
  }
}
