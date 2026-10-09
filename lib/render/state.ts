import type { Feature } from "geojson";
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

export type MapState = {
  viewport: Viewport;
  basemap: Basemap;
  layers: Record<string, LoadedLayer>;
  renderOps: RenderOp[];
  errors: { layerId: string; message: string }[];
  selected?: Selection;
};

export const initialMapState: MapState = {
  viewport: { longitude: 0, latitude: 20, zoom: 1.5, pitch: 0, bearing: 0 },
  basemap: "outdoors-satellite",
  layers: {},
  renderOps: [],
  errors: [],
};

export type MapAction =
  | { type: "set_view"; viewport: Partial<Viewport> }
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
  | { type: "clear_layers" };
