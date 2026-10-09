import type { BBox, LayerResult, StyleHints } from "@/layers/types";
import { bboxToViewport, type Padding } from "@/lib/render/deck";
import type { Basemap, MapAction, RenderMode, RenderOp, Viewport } from "@/lib/render/state";

/** Layer titles and styles by id, fetched by the browser from `GET /api/layers`. */
export type LayerCatalog = Record<string, { title: string; style: StyleHints; license?: string }>;

/** The map canvas size, and the screen area a fitted bbox must stay clear of (floating panels). */
type Canvas = { width: number; height: number; padding?: Padding };

const QUERY_PREFIX = "query_";
const FALLBACK_STYLE: StyleHints = { geometry: "line", color: "#2F3A44" };
const BASEMAPS: readonly Basemap[] = ["outdoors-satellite", "outdoors", "satellite", "natural-earth-2"];
const RENDER_MODES: readonly RenderMode[] = ["points", "lines", "polygons", "heat", "columns", "hexbin"];
const DEFAULT_MODE: Record<StyleHints["geometry"], RenderMode> = {
  point: "points",
  line: "lines",
  polygon: "polygons",
};

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBBox(value: unknown): value is BBox {
  return Array.isArray(value) && value.length === 4 && value.every(isNumber);
}

function isLngLat(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(isNumber);
}

function isLayerResult(value: Obj): value is Obj & LayerResult {
  return (value.kind === "geojson" || value.kind === "tiles") && isObject(value.data);
}

function setViewActions(output: Obj, canvas: Canvas): MapAction[] {
  const actions: MapAction[] = [];
  // Terrain first, so the camera move that follows lands on the relief the agent asked for.
  if (typeof output.terrain === "boolean") actions.push({ type: "set_terrain", terrain: output.terrain });
  const viewport: Partial<Viewport> = {};
  // A bbox is fitted at pitch 0; the reducer then applies the pitch (the agent's, or the arrival pitch) and
  // backs the zoom off so the tilted view keeps the whole bbox.
  const fit = isBBox(output.bbox);
  if (isBBox(output.bbox)) {
    const { longitude, latitude, zoom } = bboxToViewport(output.bbox, canvas.width, canvas.height, canvas.padding);
    Object.assign(viewport, { longitude, latitude, zoom, bearing: 0 });
  } else {
    if (isLngLat(output.center)) {
      viewport.longitude = output.center[0];
      viewport.latitude = output.center[1];
    }
    if (isNumber(output.zoom)) viewport.zoom = output.zoom;
  }
  if (isNumber(output.pitch)) viewport.pitch = output.pitch;
  if (isNumber(output.bearing)) viewport.bearing = output.bearing;
  if (Object.keys(viewport).length > 0) actions.push(fit ? { type: "set_view", viewport, fit } : { type: "set_view", viewport });
  return actions;
}

function renderActions(output: Obj): MapAction[] {
  const { layerId, mode, color } = output;
  if (typeof layerId !== "string" || !RENDER_MODES.includes(mode as RenderMode)) return [];
  const op: RenderOp = { layerId, mode: mode as RenderMode, visible: true };
  if (typeof color === "string") op.color = color;
  return [{ type: "render", op }];
}

function queryActions(layerId: string, output: Obj, catalog: LayerCatalog, existingOps: RenderOp[]): MapAction[] {
  if (typeof output.error === "string") {
    return [{ type: "layer_error", layerId, message: output.error }];
  }
  if (!isLayerResult(output)) return [];
  const entry = catalog[layerId];
  const style = entry?.style ?? FALLBACK_STYLE;
  const actions: MapAction[] = [
    {
      type: "layer_loaded",
      layer: {
        id: layerId,
        title: entry?.title ?? layerId,
        style,
        result: output,
        receivedAt: new Date().toISOString(),
      },
    },
  ];
  if (!existingOps.some((op) => op.layerId === layerId)) {
    actions.push({ type: "render", op: { layerId, mode: DEFAULT_MODE[style.geometry], visible: true } });
  }
  return actions;
}

/**
 * Pure mapping from one finished tool call to the map actions it implies.
 * Malformed or unknown outputs map to no actions, so a bad model reply cannot break the map.
 */
export function toolResultToActions(
  toolName: string,
  input: unknown,
  output: unknown,
  canvas: Canvas,
  catalog: LayerCatalog,
  existingOps: RenderOp[] = [],
): MapAction[] {
  // `input` is accepted for symmetry with the tool part; every mapped tool echoes what it needs in `output`.
  void input;
  if (!isObject(output)) return [];
  if (toolName.startsWith(QUERY_PREFIX)) {
    return queryActions(toolName.slice(QUERY_PREFIX.length), output, catalog, existingOps);
  }
  switch (toolName) {
    case "set_view":
      return setViewActions(output, canvas);
    case "set_basemap":
      return BASEMAPS.includes(output.style as Basemap) ? [{ type: "set_basemap", basemap: output.style as Basemap }] : [];
    case "render":
      return renderActions(output);
    default:
      return [];
  }
}
