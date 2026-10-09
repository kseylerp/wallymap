import type { Feature, LineString } from "geojson";
import type { LayerResult, StyleHints } from "@/layers/types";

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
};

/** The feature the user clicked: what the inspect card shows and the map highlights. */
export type Selection = {
  layerId: string;
  feature: Feature;
  /** Where the click landed; the card points here. */
  lngLat: [number, number];
  /** The click's screen point, so the card can open before the map reports a projection. */
  screen?: { x: number; y: number };
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
};

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
  /** Moves a layer's render op to `toIndex` in `renderOps` (later ops draw on top). */
  | { type: "reorder"; layerId: string; toIndex: number }
  | { type: "remove_layer"; layerId: string }
  /** Clears every layer and every route. */
  | { type: "clear_layers" }
  /** Adds a route, or replaces the route with the same id. */
  | { type: "route_loaded"; route: RouteState }
  | { type: "route_removed"; routeId: string }
  | { type: "routes_cleared" };
