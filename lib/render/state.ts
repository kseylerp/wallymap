import type { Feature, LineString } from "geojson";
import type { LayerResult, StyleHints } from "@/layers/types";
import type { CompareSpec } from "@/lib/render/compare";
import type { LayerFilters } from "@/lib/render/filters";
import type { TimeIndex, TimeWindow } from "@/lib/time";

export type Viewport = {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch: number;
  bearing: number;
};

/** `outdoors-satellite` is the Outdoors style with satellite imagery laid beneath its vector detail. */
export type Basemap = "outdoors-satellite" | "outdoors" | "satellite" | "natural-earth-2";

/** `columns` and `hexbin` are not implemented yet (Milestone 3); the renderer throws for them. */
export type RenderMode = "points" | "lines" | "polygons" | "heat" | "columns" | "hexbin";

export type RenderOp = {
  layerId: string;
  mode: RenderMode;
  color?: string;
  visible: boolean;
  /** 0 to 1, multiplied into every color's alpha; 1 when unset. */
  opacity?: number;
  /** Attribute filters from the layer panel or the agent (lib/render/filters.ts); unset shows every feature. */
  filters?: LayerFilters;
};

/** The feature the user clicked: what the inspect card shows and the map highlights. */
export type Selection = {
  layerId: string;
  feature: Feature;
  /** Where the click landed; the card points here. */
  lngLat: [number, number];
  /** The click's screen point, so the card can open before the map reports a projection. */
  screen?: { x: number; y: number };
  /** "b" when the feature was picked on a compare's side B (drawn under the view-only id `<layerId>~b`). */
  side?: "b";
};

export type LoadedLayer = {
  id: string;
  title: string;
  style: StyleHints;
  result: LayerResult;
  receivedAt: string;
};

/** A route drawn Wally-style (gradient line, darts, mile markers, waypoint pins): a `route` result, a GPX, a trail. */
export type RouteState = {
  id: string;
  name?: string;
  line: LineString;
  source: "tool" | "gpx" | "feature";
  distanceKm: number;
  durationMin?: number;
  waypoints: { lngLat: [number, number]; type: "start" | "end" | "via" }[];
};

export type MapState = {
  viewport: Viewport;
  basemap: Basemap;
  layers: Record<string, LoadedLayer>;
  /** Routes by id, drawn above the basemap's roads and under its labels (components/routeLayers.ts). */
  routes: Record<string, RouteState>;
  renderOps: RenderOp[];
  errors: { layerId: string; message: string }[];
  selected?: Selection;
  /** 3D terrain wanted (on by default); drawn only while the map is not flattened. */
  terrain: boolean;
  /** The user pressed 3D off: pitch 0 and no terrain until they press it again (remembered for the session). */
  flattened: boolean;
  /** A route preview in progress (lib/render/wally/playback.ts): the camera follows `routeId` while it exists. */
  playback?: Playback;
  /**
   * The time scrubber (components/TimeScrubber.tsx): present while any loaded GeoJSON layer has features with `t`.
   * Features outside `window` are hidden (lib/render/view.ts); features without `t` always show.
   */
  time?: TimeState;
  /** A time window (and mode, play) asked for before any time-aware layer arrived; the next such layer applies it. */
  pendingTime?: { window?: TimeWindow; playing?: boolean; mode?: TimeMode };
  /**
   * Compare over time (components/CompareControl.tsx, lib/render/compareView.ts): one layer seen at two windows, A
   * and B. While it exists the compared layer ignores the scrubber's window; other layers keep it.
   */
  compare?: CompareState;
};

/**
 * A compare: the spec, optional labels for the two sides, and (toggle mode) the side on screen, A by default, and
 * whether the 1 Hz flip is paused. The permalink does not record it (lib/render/permalink.ts).
 */
export type CompareState = CompareSpec & { aLabel?: string; bLabel?: string; side?: "a" | "b"; paused?: boolean };

/** "slide" moves the whole window each step; "cumulative" keeps the start at the first date and grows the end. */
export type TimeMode = "slide" | "cumulative";

export type TimeState = { window: TimeWindow; playing: boolean; mode: TimeMode; index: TimeIndex };

/** Route preview: how far along (0 to 1), whether it is moving, and the speed as a multiple of 10 km per minute. */
export type Playback = { routeId: string; fraction: number; playing: boolean; speed: number };

export const initialMapState: MapState = {
  viewport: { longitude: 0, latitude: 20, zoom: 1.5, pitch: 0, bearing: 0 },
  basemap: "outdoors-satellite",
  layers: {},
  routes: {},
  renderOps: [],
  errors: [],
  terrain: true,
  flattened: false,
};

export type MapAction =
  /**
   * Move the camera. Without a `pitch`, the camera takes the arrival pitch (45 at zoom 10 and above unless
   * flattened, else 0). `fit` marks a center and zoom fitted to a bbox at pitch 0: the zoom then backs off for the
   * pitch so the target stays in view. The map's own camera reports always carry a pitch, so they pass unchanged.
   */
  | { type: "set_view"; viewport: Partial<Viewport>; fit?: boolean }
  | { type: "set_terrain"; terrain: boolean }
  | { type: "set_flattened"; flattened: boolean }
  | { type: "set_basemap"; basemap: Basemap }
  | { type: "layer_loaded"; layer: LoadedLayer }
  | { type: "layer_error"; layerId: string; message: string }
  | { type: "render"; op: RenderOp }
  | { type: "toggle_layer"; layerId: string }
  | { type: "select"; selection: Selection }
  | { type: "deselect" }
  | { type: "set_opacity"; layerId: string; opacity: number }
  | { type: "set_style"; layerId: string; color?: string; mode?: RenderMode }
  /** Replaces a layer's attribute filters; an empty object (or only empty entries) clears them. */
  | { type: "set_filters"; layerId: string; filters: LayerFilters }
  /** Moves a layer's render op to `toIndex` in `renderOps` (later ops draw on top). */
  | { type: "reorder"; layerId: string; toIndex: number }
  | { type: "remove_layer"; layerId: string }
  /** Clears every layer and every route. */
  | { type: "clear_layers" }
  /** Adds a route, or replaces the route with the same id. */
  | { type: "route_loaded"; route: RouteState }
  | { type: "route_removed"; routeId: string }
  | { type: "routes_cleared" }
  /** Starts previewing a route from its start (closes the inspect card; the camera follows the route). */
  | { type: "preview_start"; routeId: string; speed?: number }
  /** Moves the preview to `fraction`; reaching the end pauses it there. */
  | { type: "preview_tick"; fraction: number }
  /** Play or pause; playing from the end starts over. */
  | { type: "preview_toggle" }
  | { type: "preview_speed"; speed: number }
  | { type: "preview_stop" }
  /** Sets the time window (clamped to the data); before any time-aware layer exists it waits in `pendingTime`. */
  | { type: "set_time_window"; window: TimeWindow }
  /** Play or pause; playing from the end (or with the whole span selected) starts over from the first bucket. */
  | { type: "set_time_playing"; playing: boolean }
  | { type: "set_time_mode"; mode: TimeMode }
  /** One play step: the window moves one bucket; at the end, play stops. */
  | { type: "time_tick" }
  /** Hides the scrubber and shows every feature again. */
  | { type: "clear_time" }
  /** Starts (or replaces) a compare; windows are put in order, play on the scrubber pauses, toggle shows A first. */
  | { type: "set_compare"; compare: CompareState }
  | { type: "set_compare_mode"; mode: CompareSpec["mode"] }
  /** Toggle mode's 1 Hz flip between A and B. */
  | { type: "compare_flip" }
  /** Pauses or resumes toggle mode's flip (space, or Pause in the console). */
  | { type: "set_compare_paused"; paused: boolean }
  | { type: "clear_compare" };
