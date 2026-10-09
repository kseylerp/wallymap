import type { MapAction, MapState } from "@/lib/render/state";

/** Pure reducer: always returns new objects and never mutates `state`. */
export function reduce(state: MapState, action: MapAction): MapState {
  switch (action.type) {
    case "set_view":
      return { ...state, viewport: { ...state.viewport, ...action.viewport } };
    case "set_basemap":
      return { ...state, basemap: action.basemap };
    case "layer_loaded":
      return {
        ...state,
        layers: { ...state.layers, [action.layer.id]: action.layer },
        errors: state.errors.filter((e) => e.layerId !== action.layer.id),
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
          : state.renderOps.map((op, i) => (i === index ? action.op : op));
      return { ...state, renderOps };
    }
    case "toggle_layer":
      if (!state.renderOps.some((op) => op.layerId === action.layerId)) return state;
      return {
        ...state,
        renderOps: state.renderOps.map((op) =>
          op.layerId === action.layerId ? { ...op, visible: !op.visible } : op,
        ),
      };
  }
}
