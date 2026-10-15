import type { BBox, LayerError, LayerResult, StyleHints } from "@/layers/types";
import type { LayerCatalog } from "@/lib/agent/applyToolResult";
import type { LayerFilters } from "@/lib/render/filters";
import { DARK_GREY } from "@/lib/render/palette";
import { isHexBasis, RENDER_MODES, type Basemap, type HexBasis, type MapAction, type MapState, type RenderMode, type TimeState, type Viewport } from "@/lib/render/state";

/** A time window as ISO dates (the scrubber's window, `t=`). */
export type PermalinkTime = { start: string; end: string };

export type PermalinkLayer = { id: string; mode?: RenderMode; visible: boolean; filters?: LayerFilters; rankBy?: string; hexBasis?: HexBasis };

/** A scenario layer's amount on the scenario scrubber (`s=<layer>:<value>`). */
export type PermalinkScenario = { layerId: string; value: number };

/** What a hash can say; every field is optional because a shared link may be partial. */
export type PermalinkState = {
  viewport?: Viewport;
  basemap?: Basemap;
  layers: PermalinkLayer[];
  time?: PermalinkTime;
  /** How many filter entries the link that wrote this hash had to leave out to stay short (`fx=`). */
  filtersDropped?: number;
  scenario?: PermalinkScenario;
};

/**
 * The slice of map state a permalink records: the camera, the basemap, which layers are loaded, and the time window.
 * A compare (`MapState.compare`) is not recorded: a shared link opens the plain map.
 */
export type PermalinkSource = Pick<MapState, "viewport" | "basemap" | "layers" | "renderOps"> & {
  /** The scrubber's state (its window is written) or a window as start and end. */
  time?: PermalinkTime | Pick<TimeState, "window">;
  /** The scenario scrubber's amount (`MapState.scenario`); written only for a layer the link loads. */
  scenario?: PermalinkScenario;
};

function timeOf(time: PermalinkSource["time"]): PermalinkTime | undefined {
  if (!time) return undefined;
  return "window" in time ? { start: time.window[0], end: time.window[1] } : time;
}

const BASEMAPS: readonly Basemap[] = ["outdoors-satellite", "outdoors", "satellite", "natural-earth-2"];
const FALLBACK_STYLE: StyleHints = { geometry: "line", color: DARK_GREY };
const DEFAULT_MODE: Record<StyleHints["geometry"], RenderMode> = { point: "points", line: "lines", polygon: "polygons" };

/** The `f=` value stays under this many characters; entries past it are left out and counted in `fx=`. */
export const MAX_FILTER_CHARS = 1500;

/** A finite number as short text: 1234.5, 0.25, -3. */
function num(n: number): string {
  return String(Number(n.toPrecision(12)));
}

/**
 * Each layer's filters as `f=` entries, comma separated: `<layer>:<key>:<min>~<max>` for a range and
 * `<layer>:<key>=<a>+<b>` for a category list. Layer ids, keys and values are URI-encoded, so `:`, `,`, `=` and `+`
 * inside them never collide with the separators. Returns the entries that fit in MAX_FILTER_CHARS and how many did not.
 */
export function encodeFilters(ops: { layerId: string; filters?: LayerFilters }[]): { value: string; dropped: number } {
  const entries: string[] = [];
  for (const op of ops) {
    for (const [key, f] of Object.entries(op.filters ?? {})) {
      const head = `${encodeURIComponent(op.layerId)}:${encodeURIComponent(key)}`;
      if (f.range && f.range.every(Number.isFinite)) entries.push(`${head}:${num(f.range[0])}~${num(f.range[1])}`);
      if (f.include && f.include.length > 0) entries.push(`${head}=${f.include.map(encodeURIComponent).join("+")}`);
      if (f.match && f.match.trim() !== "") entries.push(`${head}*=${encodeURIComponent(f.match.trim())}`);
    }
  }
  const kept: string[] = [];
  let length = 0;
  for (const entry of entries) {
    if (length + entry.length + 1 > MAX_FILTER_CHARS) break;
    kept.push(entry);
    length += entry.length + 1;
  }
  return { value: kept.join(","), dropped: entries.length - kept.length };
}

/** Reads `f=` back into filters per layer id; malformed entries are skipped. */
export function decodeFilters(value: string): Record<string, LayerFilters> {
  const out: Record<string, LayerFilters> = {};
  for (const entry of value.split(",")) {
    const cut = entry.indexOf(":");
    if (cut <= 0) continue;
    const layerId = safeDecode(entry.slice(0, cut));
    const rest = entry.slice(cut + 1);
    if (!layerId) continue;
    const eq = rest.indexOf("=");
    const colon = rest.indexOf(":");
    if (eq > 1 && rest[eq - 1] === "*" && (colon === -1 || eq < colon)) {
      // A name search: `<layer>:<key>*=<text>`.
      const key = safeDecode(rest.slice(0, eq - 1));
      const match = safeDecode(rest.slice(eq + 1));
      if (!key || !match) continue;
      const filters = (out[layerId] ??= {});
      filters[key] = { ...filters[key], match };
    } else if (eq > 0 && (colon === -1 || eq < colon)) {
      const key = safeDecode(rest.slice(0, eq));
      const include = rest
        .slice(eq + 1)
        .split("+")
        .map(safeDecode)
        .filter((v): v is string => v !== null && v !== "");
      if (!key || include.length === 0) continue;
      const filters = (out[layerId] ??= {});
      filters[key] = { ...filters[key], include };
    } else if (colon > 0) {
      const key = safeDecode(rest.slice(0, colon));
      const [lo, hi] = rest.slice(colon + 1).split("~").map((part) => (part.trim() === "" ? NaN : Number(part)));
      if (!key || !Number.isFinite(lo) || !Number.isFinite(hi)) continue;
      const filters = (out[layerId] ??= {});
      filters[key] = { ...filters[key], range: lo <= hi ? [lo, hi] : [hi, lo] };
    }
  }
  return out;
}

function round(value: number, digits: number): string {
  return String(Number(value.toFixed(digits)));
}

/**
 * Servable layers only (ids in `servable`, when given; route results and drawn layers are not replayable).
 * `#v=<lng>,<lat>,<zoom>,<pitch>,<bearing>&b=<basemap>&l=<id:mode:visible,...>&f=<filters>&t=<start>,<end>` (layers by
 * id; filters as `encodeFilters`, with `fx=<n>` when n entries did not fit), and `s=<layer>:<value>` for the scenario
 * scrubber's amount (sea level rise feet). Links without `f=` or `s=` still read.
 */
export function encodeState(state: PermalinkSource, servable?: Record<string, unknown>): string {
  const { longitude, latitude, zoom, pitch, bearing } = state.viewport;
  const parts = [
    `v=${round(longitude, 5)},${round(latitude, 5)},${round(zoom, 2)},${round(pitch, 1)},${round(bearing, 1)}`,
    `b=${state.basemap}`,
  ];
  const layers = state.renderOps
    .filter((op) => state.layers[op.layerId] && (!servable || op.layerId in servable))
    .map((op) => {
      // Rank by and the hex basis ride after the visibility, URI-encoded (a share basis holds a colon).
      const extra = op.rankBy || op.hexBasis ? `:${encodeURIComponent(op.rankBy ?? "")}${op.hexBasis ? `:${encodeURIComponent(op.hexBasis)}` : ""}` : "";
      return `${encodeURIComponent(op.layerId)}:${op.mode}:${op.visible ? 1 : 0}${extra}`;
    });
  if (layers.length > 0) parts.push(`l=${layers.join(",")}`);
  const shared = state.renderOps.filter((op) => state.layers[op.layerId] && (!servable || op.layerId in servable));
  const { value: filters, dropped } = encodeFilters(shared);
  if (filters) parts.push(`f=${filters}`);
  if (dropped > 0) parts.push(`fx=${dropped}`);
  const time = timeOf(state.time);
  if (time) parts.push(`t=${encodeURIComponent(time.start)},${encodeURIComponent(time.end)}`);
  const scenario = state.scenario;
  if (scenario && Number.isFinite(scenario.value) && shared.some((op) => op.layerId === scenario.layerId)) {
    parts.push(`s=${encodeURIComponent(scenario.layerId)}:${num(scenario.value)}`);
  }
  return `#${parts.join("&")}`;
}

function parseViewport(value: string): Viewport | null {
  const nums = value.split(",").map((part) => (part.trim() === "" ? NaN : Number(part)));
  if (nums.length < 3 || nums.length > 5 || !nums.every(Number.isFinite)) return null;
  const [longitude, latitude, zoom, pitch = 0, bearing = 0] = nums;
  if (Math.abs(longitude) > 180 || Math.abs(latitude) > 90 || zoom < 0 || zoom > 24) return null;
  if (pitch < 0 || pitch > 85) return null;
  return { longitude, latitude, zoom, pitch, bearing };
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parseLayers(value: string): PermalinkLayer[] {
  const layers: PermalinkLayer[] = [];
  for (const entry of value.split(",")) {
    const [rawId, mode, visible, rawRank, rawBasis] = entry.split(":");
    const id = rawId ? safeDecode(rawId) : null;
    if (!id) continue;
    const rankBy = rawRank ? safeDecode(rawRank) : null;
    const hexBasis = rawBasis ? safeDecode(rawBasis) : null;
    layers.push({
      id,
      mode: RENDER_MODES.includes(mode as RenderMode) ? (mode as RenderMode) : undefined,
      visible: visible !== "0",
      ...(rankBy && { rankBy }),
      ...(isHexBasis(hexBasis) && { hexBasis }),
    });
  }
  return layers;
}

function parseScenario(value: string): PermalinkScenario | null {
  const cut = value.lastIndexOf(":");
  if (cut <= 0) return null;
  const layerId = safeDecode(value.slice(0, cut));
  const raw = value.slice(cut + 1);
  const n = raw.trim() === "" ? NaN : Number(raw);
  return layerId && Number.isFinite(n) ? { layerId, value: n } : null;
}

function parseTime(value: string): PermalinkTime | null {
  const [rawStart, rawEnd] = value.split(",");
  const start = rawStart ? safeDecode(rawStart) : null;
  const end = rawEnd ? safeDecode(rawEnd) : null;
  return start && end ? { start, end } : null;
}

/**
 * Reads a hash back. Missing fields stay missing; a hash that names no usable field, or whose `v=` is not a real
 * camera, is malformed and returns null.
 */
export function decodeState(hash: string): PermalinkState | null {
  const body = hash.startsWith("#") ? hash.slice(1) : hash;
  if (body === "") return null;
  const out: PermalinkState = { layers: [] };
  let found = false;
  let filtersByLayer: Record<string, LayerFilters> = {};
  for (const pair of body.split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (key === "v") {
      const viewport = parseViewport(value);
      if (!viewport) return null;
      out.viewport = viewport;
      found = true;
    } else if (key === "b" && BASEMAPS.includes(value as Basemap)) {
      out.basemap = value as Basemap;
      found = true;
    } else if (key === "l") {
      out.layers = parseLayers(value);
      found = found || out.layers.length > 0;
    } else if (key === "f") {
      filtersByLayer = decodeFilters(value);
    } else if (key === "fx") {
      const n = Number(value);
      if (Number.isInteger(n) && n > 0) out.filtersDropped = n;
    } else if (key === "s") {
      const scenario = parseScenario(value);
      if (scenario) out.scenario = scenario;
    } else if (key === "t") {
      const time = parseTime(value);
      if (time) {
        out.time = time;
        found = true;
      }
    }
  }
  // Filters ride on the layers they belong to; filters for a layer the link does not load are ignored.
  out.layers = out.layers.map((layer) => (filtersByLayer[layer.id] ? { ...layer, filters: filtersByLayer[layer.id] } : layer));
  return found ? out : null;
}

/** The lng/lat box a flat map of this size shows (Web Mercator, 512px world tiles like Mapbox); pitch is ignored. */
export function viewportBBox(viewport: Viewport, width: number, height: number): BBox {
  const world = 512 * 2 ** viewport.zoom;
  const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const latAt = (y: number) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
  const halfLng = (width / world) * 180;
  const halfY = (height / world) * Math.PI;
  const cy = mercY(Math.max(-85, Math.min(85, viewport.latitude)));
  return [
    Math.max(-180, viewport.longitude - halfLng),
    Math.max(-85, latAt(cy - halfY)),
    Math.min(180, viewport.longitude + halfLng),
    Math.min(85, latAt(cy + halfY)),
  ];
}

export type FetchLayer = (id: string, bbox: BBox, zoom: number) => Promise<LayerResult | LayerError>;

export type RestoreOptions = {
  catalog: LayerCatalog;
  canvas: { width: number; height: number };
  /** Called once the hash is known to name layers, with how many will be fetched. */
  onStart?: (layerCount: number) => void;
};

/** `filtersDropped`: filter entries the sharing map left out of the link to keep it short (present when any were). */
export type RestoreOutcome = { restored: string[]; failed: string[]; filtersDropped?: number };

function isError(result: LayerResult | LayerError): result is LayerError {
  return "error" in result;
}

/** The middle quarter of a box by area, the same retry the agent makes after a `zoom_in` error. */
function centralQuarter([w, s, e, n]: BBox): BBox {
  const dx = (e - w) / 4;
  const dy = (n - s) / 4;
  return [w + dx, s + dy, e - dx, n - dy];
}

async function fetchWithRetry(fetchLayer: FetchLayer, id: string, bbox: BBox, zoom: number) {
  const first = await fetchLayer(id, bbox, zoom);
  if (isError(first) && first.hint === "zoom_in") return fetchLayer(id, centralQuarter(bbox), zoom + 1);
  return first;
}

/**
 * Replays a hash into the map: camera and basemap first, then each layer fetched with its default input for the
 * viewport's box and dispatched (`layer_loaded`, then `render`) in the hash's order. Returns null for a hash that
 * does not decode. A layer that fails is reported as a layer error and listed in `failed`.
 */
export async function restoreFromPermalink(
  hash: string,
  dispatch: (action: MapAction) => void,
  fetchLayer: FetchLayer,
  options: RestoreOptions,
): Promise<RestoreOutcome | null> {
  const decoded = decodeState(hash);
  if (!decoded) return null;
  if (decoded.basemap) dispatch({ type: "set_basemap", basemap: decoded.basemap });
  if (decoded.viewport) dispatch({ type: "set_view", viewport: decoded.viewport });
  options.onStart?.(decoded.layers.length);

  const { viewport } = decoded;
  const view = viewport ?? { longitude: 0, latitude: 20, zoom: 1.5, pitch: 0, bearing: 0 };
  const bbox = viewportBBox(view, options.canvas.width, options.canvas.height);
  const results = await Promise.all(
    decoded.layers.map((layer) =>
      fetchWithRetry(fetchLayer, layer.id, bbox, view.zoom).catch(
        (err): LayerError => ({ error: String(err), hint: "upstream" }),
      ),
    ),
  );

  const outcome: RestoreOutcome = { restored: [], failed: [], ...(decoded.filtersDropped && { filtersDropped: decoded.filtersDropped }) };
  decoded.layers.forEach((layer, i) => {
    const result = results[i];
    if (isError(result)) {
      dispatch({ type: "layer_error", layerId: layer.id, message: result.error });
      outcome.failed.push(layer.id);
      return;
    }
    const entry = options.catalog[layer.id];
    const style = entry?.style ?? FALLBACK_STYLE;
    dispatch({
      type: "layer_loaded",
      layer: {
        id: layer.id,
        title: entry?.title ?? layer.id,
        style,
        result,
        receivedAt: new Date().toISOString(),
        ...(entry?.fieldHelp && { fieldHelp: entry.fieldHelp }),
        ...(entry?.card && { card: entry.card }),
        ...(entry?.attributes && { attributes: entry.attributes }),
      },
    });
    // A link without a mode takes the layer's default from its hints, as a fresh query would.
    dispatch({
      type: "render",
      op: {
        layerId: layer.id,
        mode: layer.mode ?? DEFAULT_MODE[style.geometry],
        visible: layer.visible,
        ...(layer.filters && { filters: layer.filters }),
        ...(layer.rankBy && { rankBy: layer.rankBy }),
        ...(layer.hexBasis && { hexBasis: layer.hexBasis }),
      },
      ...(layer.mode === undefined && { defaultMode: true }),
    });
    outcome.restored.push(layer.id);
  });
  // After the layers, so the window lands on the time index they build (or waits for one).
  if (decoded.time) dispatch({ type: "set_time_window", window: [decoded.time.start, decoded.time.end] });
  // After the layers too: the reducer snaps the amount to the layer's scenario and ignores it for a layer that failed.
  if (decoded.scenario) dispatch({ type: "set_scenario", layerId: decoded.scenario.layerId, value: decoded.scenario.value });
  return outcome;
}
