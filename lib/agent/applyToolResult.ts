import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type { BBox, LayerResult, StyleHints } from "@/layers/types";
import { bboxToViewport, type Padding } from "@/lib/render/deck";
import type { LayerFilters } from "@/lib/render/filters";
import { ROUTE_ERROR_ID } from "@/lib/render/reducer";
import { RENDER_MODES, type Basemap, type CompareState, type MapAction, type RenderMode, type RenderOp, type RouteState, type TimeMode, type Viewport } from "@/lib/render/state";

/** Layer titles and styles by id, fetched by the browser from `GET /api/layers`. */
export type LayerCatalog = Record<string, { title: string; style: StyleHints; license?: string }>;

/** The map canvas size, and the screen area a fitted bbox must stay clear of (floating panels). */
type Canvas = { width: number; height: number; padding?: Padding };

const QUERY_PREFIX = "query_";
const FALLBACK_STYLE: StyleHints = { geometry: "line", color: "#2F3A44" };
const BASEMAPS: readonly Basemap[] = ["outdoors-satellite", "outdoors", "satellite", "natural-earth-2"];
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

/** The well-formed entries of a `render.filters` object (string includes, an ordered numeric range); null if not an object. */
function parseFilters(value: unknown): LayerFilters | null {
  if (!isObject(value)) return null;
  const filters: LayerFilters = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isObject(entry)) continue;
    const out: LayerFilters[string] = {};
    if (Array.isArray(entry.include)) {
      const include = entry.include.filter((v): v is string => typeof v === "string");
      if (include.length > 0) out.include = include;
    }
    if (Array.isArray(entry.range) && entry.range.length === 2 && entry.range.every(isNumber)) {
      const [a, b] = entry.range as [number, number];
      out.range = a <= b ? [a, b] : [b, a];
    }
    if (out.include || out.range) filters[key] = out;
  }
  return filters;
}

/** The render tool's `mode` as a RenderMode: `symbols` is the map's `points`; anything unknown is null. */
export function renderModeOf(mode: unknown): RenderMode | null {
  if (mode === "symbols") return "points";
  return RENDER_MODES.includes(mode as RenderMode) ? (mode as RenderMode) : null;
}

function renderActions(output: Obj, catalog: LayerCatalog): MapAction[] {
  const { layerId, mode, color } = output;
  if (typeof layerId !== "string" || layerId === "") return [];
  const asked = renderModeOf(mode);
  // A mode that is there but unreadable is a bad reply; no mode at all lets the reducer keep or pick one.
  if (mode !== undefined && !asked) return [];
  const geometry = catalog[layerId]?.style.geometry ?? "point";
  const op: RenderOp = { layerId, mode: asked ?? DEFAULT_MODE[geometry], visible: true };
  if (typeof color === "string") op.color = color;
  // Filters replace the layer's current ones ({} clears them); without them the panel's filters stay.
  const filters = parseFilters(output.filters);
  if (filters) op.filters = filters;
  const actions: MapAction[] = [asked ? { type: "render", op } : { type: "render", op, defaultMode: true }];
  // `scenario` moves a scenario layer's scrubber (sea level rise feet); the reducer snaps it and ignores other layers.
  if (isNumber(output.scenario)) actions.push({ type: "set_scenario", layerId, value: output.scenario });
  return actions;
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
    // The reducer picks the mode from the layer's hints (clusters for a dense point layer at a regional zoom).
    actions.push({ type: "render", op: { layerId, mode: DEFAULT_MODE[style.geometry], visible: true }, defaultMode: true });
  }
  return actions;
}

const WAYPOINT_TYPES: readonly RouteState["waypoints"][number]["type"][] = ["start", "end", "via"];

function isLine(value: unknown): value is RouteState["line"] {
  return (
    isObject(value) &&
    value.type === "LineString" &&
    Array.isArray(value.coordinates) &&
    value.coordinates.length >= 2 &&
    value.coordinates.every(isLngLat)
  );
}

function lineBBox(line: RouteState["line"]): BBox {
  const lngs = line.coordinates.map((c) => c[0]);
  const lats = line.coordinates.map((c) => c[1]);
  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
}

/** A `route` result: the route, then a fit to its line (inside the panels' padding); an error goes to the layer errors. */
function routeActions(output: Obj, canvas: Canvas): MapAction[] {
  if (typeof output.error === "string") return [{ type: "layer_error", layerId: ROUTE_ERROR_ID, message: output.error }];
  if (typeof output.id !== "string" || output.id === "" || !isLine(output.line)) return [];
  const waypoints = Array.isArray(output.waypoints)
    ? output.waypoints.flatMap((w): RouteState["waypoints"] =>
        isObject(w) && isLngLat(w.lngLat) && WAYPOINT_TYPES.includes(w.type as never)
          ? [{ lngLat: [w.lngLat[0], w.lngLat[1]], type: w.type as RouteState["waypoints"][number]["type"] }]
          : [],
      )
    : [];
  const route: RouteState = {
    id: output.id,
    line: output.line,
    source: "tool",
    distanceKm: isNumber(output.distanceKm) ? output.distanceKm : 0,
    // Without waypoints from Directions, the line's own ends still get a start and an end pin.
    waypoints:
      waypoints.length > 0
        ? waypoints
        : [
            { lngLat: output.line.coordinates[0] as [number, number], type: "start" },
            { lngLat: output.line.coordinates[output.line.coordinates.length - 1] as [number, number], type: "end" },
          ],
  };
  if (typeof output.name === "string") route.name = output.name;
  if (isNumber(output.durationMin)) route.durationMin = output.durationMin;
  const bbox = isBBox(output.bbox) ? output.bbox : lineBBox(output.line);
  return [{ type: "route_loaded", route }, ...setViewActions({ bbox }, canvas)];
}

const TIME_MODES: readonly TimeMode[] = ["slide", "cumulative"];

/**
 * A `set_time` bound as an ISO instant. A bare year or month is its first moment as a start and its last as an end
 * ("2016" to "2016" is the whole of 2016); a date as an end runs to the end of that day. Null when unreadable.
 */
export function timeBound(value: unknown, edge: "start" | "end"): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const year = /^(\d{4})$/.exec(text);
  const month = /^(\d{4})-(\d{2})$/.exec(text);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  let ms: number;
  if (year) ms = edge === "start" ? Date.UTC(+year[1], 0, 1) : Date.UTC(+year[1] + 1, 0, 1) - 1;
  else if (month) ms = edge === "start" ? Date.UTC(+month[1], +month[2] - 1, 1) : Date.UTC(+month[1], +month[2], 1) - 1;
  else if (day) ms = Date.UTC(+day[1], +day[2] - 1, +day[3]) + (edge === "end" ? 86_400_000 - 1 : 0);
  else ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * A `set_time` result: the mode, then the window, then play or pause. The mode goes first so the window lands in it:
 * a slide window sent while the scrubber is cumulative keeps the start the agent asked for. Before any dated layer has
 * loaded, all three wait together in `pendingTime`.
 */
function setTimeActions(output: Obj): MapAction[] {
  const start = timeBound(output.start, "start");
  const end = timeBound(output.end, "end");
  if (!start || !end) return [];
  const actions: MapAction[] = [];
  if (TIME_MODES.includes(output.mode as TimeMode)) actions.push({ type: "set_time_mode", mode: output.mode as TimeMode });
  actions.push({ type: "set_time_window", window: start <= end ? [start, end] : [end, start] });
  if (typeof output.play === "boolean") actions.push({ type: "set_time_playing", playing: output.play });
  return actions;
}

const COMPARE_MODES = ["swipe", "toggle", "delta"] as const;

function isWindow(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((v) => typeof v === "string" && !Number.isNaN(Date.parse(v)))
  );
}

function isAmounts(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(isNumber);
}

/** The windows a scenario compare carries: not used, so empty unless the model sent real ones. */
const NO_WINDOW: [string, string] = ["", ""];

/**
 * A `compare` result: the two windows and the mode, passed through as the compare state; malformed output maps to
 * nothing. With `scenario: [a, b]` (two amounts of a scenario layer, sea level rise feet) the windows may be left out,
 * and a scenario compare swipes unless toggle was asked for (delta has no features to diff on tiles).
 */
function compareActions(output: Obj): MapAction[] {
  const { layerId, a, b, mode, aLabel, bLabel, scenario } = output;
  if (typeof layerId !== "string" || layerId === "") return [];
  if (isAmounts(scenario)) {
    const compare: CompareState = {
      layerId,
      a: isWindow(a) ? a : NO_WINDOW,
      b: isWindow(b) ? b : NO_WINDOW,
      mode: mode === "toggle" ? "toggle" : "swipe",
      scenario: { a: scenario[0], b: scenario[1] },
    };
    if (typeof aLabel === "string") compare.aLabel = aLabel;
    if (typeof bLabel === "string") compare.bLabel = bLabel;
    return [{ type: "set_compare", compare }];
  }
  if (!isWindow(a) || !isWindow(b)) return [];
  if (!COMPARE_MODES.includes(mode as (typeof COMPARE_MODES)[number])) return [];
  const compare: CompareState = { layerId, a, b, mode: mode as CompareState["mode"] };
  if (typeof aLabel === "string") compare.aLabel = aLabel;
  if (typeof bLabel === "string") compare.bLabel = bLabel;
  return [{ type: "set_compare", compare }];
}

/**
 * A successful `geocode` result: the user named a place, so the camera fits its bbox. An error, or a result without a
 * bbox, moves nothing.
 */
function geocodeActions(output: Obj, canvas: Canvas): MapAction[] {
  if (typeof output.error === "string" || !isBBox(output.bbox)) return [];
  return setViewActions({ bbox: output.bbox }, canvas);
}

/**
 * True when a `set_view` call comes after the part at `index` in the same step (before the next step-start), so the
 * model's own framing wins over the geocode's automatic move.
 */
export function setViewFollowsInStep(parts: UIMessage["parts"], index: number): boolean {
  for (let i = index + 1; i < parts.length; i++) {
    const part = parts[i];
    if (part.type === "step-start") return false;
    if (isToolUIPart(part) && getToolName(part) === "set_view") return true;
  }
  return false;
}

/** Context for one tool result that its own output cannot carry. */
export type ToolResultContext = {
  /** A set_view call follows this one in the same step (see setViewFollowsInStep). */
  setViewFollows?: boolean;
};

/**
 * Pure mapping from one finished tool call to the map actions it implies.
 * Malformed or unknown outputs map to no actions, so a bad model reply cannot break the map.
 * A successful geocode moves the camera to the place's bbox, unless `context.setViewFollows` (the explicit set_view
 * in the same step frames it instead).
 */
export function toolResultToActions(
  toolName: string,
  input: unknown,
  output: unknown,
  canvas: Canvas,
  catalog: LayerCatalog,
  existingOps: RenderOp[] = [],
  context: ToolResultContext = {},
): MapAction[] {
  // `input` is accepted for symmetry with the tool part; every mapped tool echoes what it needs in `output`.
  void input;
  if (!isObject(output)) return [];
  if (toolName.startsWith(QUERY_PREFIX)) {
    return queryActions(toolName.slice(QUERY_PREFIX.length), output, catalog, existingOps);
  }
  switch (toolName) {
    case "geocode":
      return context.setViewFollows ? [] : geocodeActions(output, canvas);
    case "set_view":
      return setViewActions(output, canvas);
    case "set_basemap":
      return BASEMAPS.includes(output.style as Basemap) ? [{ type: "set_basemap", basemap: output.style as Basemap }] : [];
    case "render":
      return renderActions(output, catalog);
    case "route":
      return routeActions(output, canvas);
    case "set_time":
      return setTimeActions(output);
    case "compare":
      return compareActions(output);
    default:
      return [];
  }
}
