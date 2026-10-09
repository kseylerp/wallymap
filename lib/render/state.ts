import type { LayerResult, StyleHints } from "@/layers/types";

export type Viewport = {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch: number;
  bearing: number;
};

export type Basemap = "outdoors" | "satellite" | "natural-earth-2";

/** Only points, lines and polygons are implemented in milestone 1. */
export type RenderMode = "points" | "lines" | "polygons" | "heat" | "columns" | "hexbin";

export type RenderOp = {
  layerId: string;
  mode: RenderMode;
  color?: string;
  visible: boolean;
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
};

export const initialMapState: MapState = {
  viewport: { longitude: 0, latitude: 20, zoom: 1.5, pitch: 0, bearing: 0 },
  basemap: "outdoors",
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
  | { type: "toggle_layer"; layerId: string };
