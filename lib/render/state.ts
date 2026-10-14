import type { Feature, LineString } from "geojson";
import type { BBox, CardSpec, FieldHelp, LayerResult, StyleHints } from "@/layers/types";
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

/**
 * How a layer draws. Point layers: `points` (symbols; flat hex tiles past 2,000 features), `clusters` (supercluster
 * blobs with counts), `heat` (Mapbox heatmap on the density ramp), `columns` (H3 cells extruded by count or `v` in 3D,
 * flat hex tiles in 2D) and `hexbin` (flat hex tiles). Lines draw as `lines`, areas as `polygons`, or as `columns`
 * (extruded by `v` in 3D). Any mode a renderer does not know falls back to symbols (lib/render/deck.ts).
 */
export type RenderMode = "points" | "lines" | "polygons" | "heat" | "columns" | "hexbin" | "clusters";

/** Every render mode, for parsers (the render tool, the permalink, deck ids). */
export const RENDER_MODES: readonly RenderMode[] = ["points", "lines", "polygons", "heat", "columns", "hexbin", "clusters"];

/** The render modes the layer panel offers point layers, in order, with their labels. */
export const POINT_MODES: readonly { value: RenderMode; label: string }[] = [
  { value: "points", label: "Symbols" },
  { value: "clusters", label: "Clusters" },
  { value: "heat", label: "Heat" },
  { value: "columns", label: "Columns" },
];

/**
 * The standard views (spec §12): every answer is drawn as one of these, the same way every time. The agent names it on
 * the render op; the reducer picks one from the data when it does not (lib/render/views.ts `defaultView`).
 */
export const VIEW_KINDS = ["change", "timeline", "ranked", "density", "detail", "scenario", "route"] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

export type RenderOp = {
  layerId: string;
  mode: RenderMode;
  color?: string;
  visible: boolean;
  /** 0 to 1, multiplied into every color's alpha; 1 when unset. */
  opacity?: number;
  /** Attribute filters from the layer panel or the agent (lib/render/filters.ts); unset shows every feature. */
  filters?: LayerFilters;
  /** The standard view the layer is drawn in (spec §12): its encoding, legend wording and console controls. */
  view?: ViewKind;
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
  /** The layer's field help (spec §12b), from the catalog: the inspect card's "i" beside each field that has some. */
  fieldHelp?: Record<string, FieldHelp>;
  /** How the inspect card lays out this layer's features (layers/types.ts CardSpec), from the catalog. */
  card?: CardSpec;
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
  /**
   * The scenario scrubber (components/ScenarioScrubber.tsx): the amount a scenario tile layer (sea level rise, its
   * `data.scenario`) is drawn at, when the user or the agent moved it off the queried amount. lib/render/view.ts rewrites
   * the layer's tile URL from it. A re-query of the layer drops it (the new query's amount shows).
   */
  scenario?: ScenarioState;
  /**
   * A place the user named this turn (its geocoded bbox): while it is set, the camera fits what the queries return
   * (spec §12: the returned features, never the geocoded region), or the place itself when nothing drawable came back.
   * A new turn, or the agent framing the view itself with set_view, drops it; "here" questions never set it.
   */
  place?: PlaceState;
  /** The latest camera fit the reducer asked for; the app turns it into a viewport with the panels' padding. */
  camera?: CameraRequest;
};

/** The named place of this turn: its bbox, the layers loaded for it since, and whether the camera has fitted yet. */
export type PlaceState = { bbox: BBox; layers: string[]; moved: boolean };

/** A camera fit: the bbox, a sequence number (each request is new), and `lowerThird` to leave room above for the card. */
export type CameraRequest = { bbox: BBox; seq: number; lowerThird?: boolean };

/** The scenario scrubber's state: which layer, the amount shown (one of its `data.scenario.values`) and whether Play steps it. */
export type ScenarioState = { layerId: string; value: number; playing: boolean };

/**
 * A compare: the spec, optional labels for the two sides, and (toggle mode) the side on screen, A by default, and
 * whether the 1 Hz flip is paused. The permalink does not record it (lib/render/permalink.ts).
 */
export type CompareState = CompareSpec & {
  aLabel?: string;
  bLabel?: string;
  side?: "a" | "b";
  paused?: boolean;
  /**
   * A scenario compare (a tile layer with `data.scenario`): side A and B draw these two amounts, and the windows `a` and
   * `b` are not used (lib/render/compareView.ts).
   */
  scenario?: { a: number; b: number };
};

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
  /**
   * Draw a layer. `defaultMode`: the op's mode was not asked for, so the layer keeps the mode it has, or a new op takes
   * the default from the layer's hints (`defaultRenderMode` in lib/render/reducer.ts).
   */
  | { type: "render"; op: RenderOp; defaultMode?: boolean }
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
  /**
   * The logo: back to a fresh map. Everything `clear_layers` clears, plus the camera (the world view, pitch 0). The
   * basemap and the 3D choice stay, as the user set them.
   */
  | { type: "reset_map" }
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
  | { type: "clear_compare" }
  /** Shows a scenario layer at `value` (snapped to its nearest listed amount); ignored for a layer without a scenario. */
  | { type: "set_scenario"; layerId: string; value: number }
  /** Play or pause the scenario scrubber; playing from the last amount starts over at the first. */
  | { type: "set_scenario_playing"; layerId: string; playing: boolean }
  /** One play step: the next amount; at the last one, play stops. */
  | { type: "scenario_tick" }
  /** Back to the queried amount. */
  | { type: "clear_scenario" }
  /** The user named a place (a geocode result): the camera fits this turn's returned features, else this bbox. */
  | { type: "place_named"; bbox: BBox }
  /** The agent framed the view itself (set_view): this turn's results no longer move the camera. */
  | { type: "place_framed" }
  /** The answer is written (the note): a named place that nothing was fitted to yet gets the camera now. */
  | { type: "place_settle" }
  /** A new answer starts: the last turn's place is forgotten, so a "here" question never moves the camera. */
  | { type: "turn_start" }
  /** Applies a standard view's preset to a drawn layer (spec §12): encoding, console, selection and camera. */
  | { type: "set_view_kind"; layerId: string; view: ViewKind };
