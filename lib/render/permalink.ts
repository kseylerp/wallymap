import { bboxAreaKm2, type BBox, type LayerError, type LayerResult, type StyleHints } from "@/layers/types";
import { catalogFields, type LayerCatalog } from "@/lib/agent/applyToolResult";
import type { LayerFilters } from "@/lib/render/filters";
import { DARK_GREY } from "@/lib/render/palette";
import type { CompareMode } from "@/lib/render/compare";
import {
  isHexBasis,
  RENDER_MODES,
  VIEW_KINDS,
  type Basemap,
  type CompareState,
  type HexBasis,
  type LayerFailure,
  type MapAction,
  type MapState,
  type RenderMode,
  type RenderOp,
  type TimeMode,
  type TimeState,
  type ViewKind,
  type Viewport,
} from "@/lib/render/state";

/** A time window as ISO dates (the scrubber's window, `t=`), and its mode when it is cumulative (`t=<start>,<end>,c`). */
export type PermalinkTime = { start: string; end: string; mode?: TimeMode };

/**
 * One layer of a link. `view` is the standard view the sender's op had, null for none; it is missing only in a link
 * from before views were recorded, which then lets the restore pick the view as a fresh query would. `input` is the
 * layer's own query input (surf `forecast: true`).
 */
export type PermalinkLayer = {
  id: string;
  mode?: RenderMode;
  visible: boolean;
  filters?: LayerFilters;
  rankBy?: string;
  hexBasis?: HexBasis;
  view?: ViewKind | null;
  opacity?: number;
  color?: string;
  /** Two measures on one mark (`<size>|<color>`, "" for a channel switched off). */
  encode?: { size?: string; color?: string };
  input?: Record<string, unknown>;
  /** The box the layer was asked over (`q=`), asked again on restore instead of the opener's screen. */
  queryBox?: BBox;
};

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
  /** The compare that was on (`c=`); its side and pause only when the flip was paused. */
  compare?: CompareState;
  /** 3D pressed off (`3d=0`): pitch 0 and no terrain. */
  flattened?: boolean;
  /** Terrain relief turned off by the agent (`relief=0`). */
  terrain?: boolean;
};

/**
 * The slice of map state a permalink records: the camera, the basemap, which layers are loaded with every setting of
 * their render ops and their query input, the time window and mode, the scenario amount, the compare and the 3D choice.
 */
export type PermalinkSource = Pick<MapState, "viewport" | "basemap" | "layers" | "renderOps"> &
  Partial<Pick<MapState, "compare" | "terrain" | "flattened">> & {
    /** The scrubber's state (its window and mode are written) or a window as start and end. */
    time?: PermalinkTime | (Pick<TimeState, "window"> & { mode?: TimeMode });
    /** The scenario scrubber's amount (`MapState.scenario`); written only for a layer the link loads. */
    scenario?: PermalinkScenario;
    /**
     * Layers that failed to load (MapState.errors): written as layers too, so opening the link asks again and, when the
     * source still fails, shows why instead of a blank map.
     */
    failed?: Pick<LayerFailure, "layerId" | "input">[];
  };

function timeOf(time: PermalinkSource["time"]): PermalinkTime | undefined {
  if (!time) return undefined;
  return "window" in time ? { start: time.window[0], end: time.window[1], ...(time.mode && { mode: time.mode }) } : time;
}

const BASEMAPS: readonly Basemap[] = ["outdoors-satellite", "outdoors", "satellite", "natural-earth-2", "data-only"];
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
      if (f.within && f.within.bbox.every(Number.isFinite)) entries.push(`${head}@=${[...f.within.bbox.map(num), encodeURIComponent(f.within.name)].join("~")}`);
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
    if (eq > 1 && rest[eq - 1] === "@" && (colon === -1 || eq < colon)) {
      // A place the filter is held to: `<layer>:<key>@=<w>~<s>~<e>~<n>~<name>`.
      const key = safeDecode(rest.slice(0, eq - 1));
      const parts = rest.slice(eq + 1).split("~");
      const bbox = parts.slice(0, 4).map(Number);
      const name = safeDecode(parts.slice(4).join("~"));
      if (!key || bbox.length !== 4 || !bbox.every(Number.isFinite) || !name) continue;
      const filters = (out[layerId] ??= {});
      filters[key] = { ...filters[key], within: { bbox: bbox as [number, number, number, number], name } };
    } else if (eq > 1 && rest[eq - 1] === "*" && (colon === -1 || eq < colon)) {
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

/** An input value as text: a string as it is when it does not read as JSON, anything else (and "true", "10") as JSON. */
function inputText(value: unknown): string {
  if (typeof value === "string") {
    try {
      JSON.parse(value);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value);
}

function inputValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Each layer's query input as `i=` entries, comma separated: `<layer>:<key>:<value>`, all URI-encoded; the value is
 * plain text for a string and JSON otherwise (`surf:forecast:true`, `fire-weather:date:2026-10-15`).
 */
export function encodeInputs(layers: { id: string; input?: Record<string, unknown> }[]): string {
  const entries: string[] = [];
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer.input ?? {})) {
      if (value === undefined) continue;
      entries.push([layer.id, key, inputText(value)].map(encodeURIComponent).join(":"));
    }
  }
  return entries.join(",");
}

/** Reads `i=` back into an input per layer id; malformed entries are skipped. */
export function decodeInputs(value: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const entry of value.split(",")) {
    const parts = entry.split(":");
    if (parts.length !== 3) continue;
    const [layerId, key, text] = parts.map(safeDecode);
    if (!layerId || !key || text === null) continue;
    (out[layerId] ??= {})[key] = inputValue(text);
  }
  return out;
}

const COMPARE_MODES: readonly CompareMode[] = ["swipe", "toggle", "delta"];

/** The compare as `c=`: short-keyed JSON, URI-encoded. The side on screen is written only while the flip is paused. */
export function encodeCompare(compare: CompareState): string {
  const short = {
    l: compare.layerId,
    m: compare.mode,
    a: compare.a,
    b: compare.b,
    ...(compare.by && { by: compare.by }),
    ...(compare.aLabel !== undefined && { al: compare.aLabel }),
    ...(compare.bLabel !== undefined && { bl: compare.bLabel }),
    ...(compare.scenario && { s: [compare.scenario.a, compare.scenario.b] }),
    ...(compare.paused && { p: compare.side ?? "a" }),
  };
  return encodeURIComponent(JSON.stringify(short));
}

const isText = (v: unknown): v is string => typeof v === "string";
const isPair = (v: unknown): v is [string, string] => Array.isArray(v) && v.length === 2 && v.every(isText);
const isTexts = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText);

/** Reads `c=` back; null when it is not a well-formed compare. */
export function decodeCompare(value: string): CompareState | null {
  const text = safeDecode(value);
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { l, m, a, b, by, al, bl, s, p } = raw as Record<string, unknown>;
  if (!isText(l) || l === "" || !COMPARE_MODES.includes(m as CompareMode) || !isPair(a) || !isPair(b)) return null;
  const compare: CompareState = { layerId: l, mode: m as CompareMode, a, b };
  if (typeof by === "object" && by !== null) {
    const { key, a: byA, b: byB } = by as Record<string, unknown>;
    if (isText(key) && isTexts(byA) && isTexts(byB)) compare.by = { key, a: byA, b: byB };
  }
  if (isText(al)) compare.aLabel = al;
  if (isText(bl)) compare.bLabel = bl;
  if (Array.isArray(s) && s.length === 2 && s.every((n) => typeof n === "number" && Number.isFinite(n))) {
    compare.scenario = { a: s[0], b: s[1] };
  }
  if (p === "a" || p === "b") Object.assign(compare, { side: p, paused: true });
  return compare;
}

function round(value: number, digits: number): string {
  return String(Number(value.toFixed(digits)));
}

/**
 * One `l=` entry: `<id>:<mode>:<visible>:<rank>:<basis>:<view>:<opacity>:<color>:<encode>`, the last five URI-encoded
 * where needed and trailing empty fields left off. `encode` is `<size>|<color>` (spec §13), each part present only when
 * the op set it. Rank by None ("") is "-", so it is not read back as "rank by default"; no
 * view is "-" too, so the restore does not pick one the sender did not have.
 */
function layerEntry(op: RenderOp): string {
  const rank = op.rankBy === "" ? "-" : encodeURIComponent(op.rankBy ?? "");
  const basis = op.hexBasis ? encodeURIComponent(op.hexBasis) : "";
  const view = op.view ?? "-";
  const opacity = op.opacity !== undefined && Number.isFinite(op.opacity) && op.opacity !== 1 ? round(op.opacity, 3) : "";
  const color = op.color ? encodeURIComponent(op.color) : "";
  const enc = op.encode ? encodeURIComponent(`${op.encode.size ?? "~"}|${op.encode.color ?? "~"}`) : "";
  const fields = [encodeURIComponent(op.layerId), op.mode, op.visible ? "1" : "0", rank, basis, view, opacity, color, enc];
  while (fields[fields.length - 1] === "") fields.pop();
  return fields.join(":");
}

/**
 * Servable layers only (ids in `servable`, when given; route results and drawn layers are not replayable).
 * `#v=<lng>,<lat>,<zoom>,<pitch>,<bearing>&b=<basemap>&l=<entries>&f=<filters>&i=<inputs>&t=<start>,<end>[,c]`: layers
 * by id with their whole render op (`layerEntry`), filters as `encodeFilters` (with `fx=<n>` when n entries did not
 * fit), each layer's query input as `encodeInputs`, the time window (`,c` when cumulative), `s=<layer>:<value>` for the
 * scenario scrubber's amount (sea level rise feet), `c=` the compare (`encodeCompare`), and `3d=0` / `relief=0` when 3D
 * or the terrain is off. Links written before any of these still read.
 */
export function encodeState(state: PermalinkSource, servable?: Record<string, unknown>): string {
  const { longitude, latitude, zoom, pitch, bearing } = state.viewport;
  const parts = [
    `v=${round(longitude, 5)},${round(latitude, 5)},${round(zoom, 2)},${round(pitch, 1)},${round(bearing, 1)}`,
    `b=${state.basemap}`,
  ];
  const shared = state.renderOps.filter((op) => state.layers[op.layerId] && (!servable || op.layerId in servable));
  const failed = (state.failed ?? []).filter((f) => !state.layers[f.layerId] && (!servable || f.layerId in servable));
  const entries = [...shared.map(layerEntry), ...failed.map((f) => `${encodeURIComponent(f.layerId)}::1`)];
  if (entries.length > 0) parts.push(`l=${entries.join(",")}`);
  const { value: filters, dropped } = encodeFilters(shared);
  if (filters) parts.push(`f=${filters}`);
  if (dropped > 0) parts.push(`fx=${dropped}`);
  const inputs = encodeInputs([
    ...shared.map((op) => state.layers[op.layerId]),
    ...failed.flatMap((f) => (f.input ? [{ id: f.layerId, input: f.input }] : [])),
  ]);
  if (inputs) parts.push(`i=${inputs}`);
  // Each layer's query box (`q=<layer>:w,s,e,n`), so the link asks what the sender asked, not the opener's screen.
  const boxes = shared.flatMap((op) => {
    const box = state.layers[op.layerId]?.queryBox;
    return box ? [`${encodeURIComponent(op.layerId)}:${box.map((n) => round(n, 4)).join(",")}`] : [];
  });
  if (boxes.length > 0) parts.push(`q=${boxes.join(";")}`);
  const time = timeOf(state.time);
  if (time) parts.push(`t=${encodeURIComponent(time.start)},${encodeURIComponent(time.end)}${time.mode === "cumulative" ? ",c" : ""}`);
  const scenario = state.scenario;
  if (scenario && Number.isFinite(scenario.value) && shared.some((op) => op.layerId === scenario.layerId)) {
    parts.push(`s=${encodeURIComponent(scenario.layerId)}:${num(scenario.value)}`);
  }
  const compare = state.compare;
  if (compare && shared.some((op) => op.layerId === compare.layerId)) parts.push(`c=${encodeCompare(compare)}`);
  if (state.flattened) parts.push("3d=0");
  if (state.terrain === false) parts.push("relief=0");
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
    const [rawId, mode, visible, rawRank, rawBasis, rawView, rawOpacity, rawColor, rawEncode] = entry.split(":");
    const id = rawId ? safeDecode(rawId) : null;
    if (!id) continue;
    const rankBy = rawRank === "-" ? "" : rawRank ? safeDecode(rawRank) : null;
    const hexBasis = rawBasis ? safeDecode(rawBasis) : null;
    // A view field names the sender's view, "-" (or one this build does not know) none; a link from before views has
    // no field, and the view stays undefined so the restore picks one as a fresh query would.
    const view = rawView === undefined ? undefined : VIEW_KINDS.includes(rawView as ViewKind) ? (rawView as ViewKind) : null;
    const opacity = rawOpacity ? Number(rawOpacity) : NaN;
    const color = rawColor ? safeDecode(rawColor) : null;
    const encode = rawEncode ? parseEncode(safeDecode(rawEncode)) : null;
    layers.push({
      id,
      mode: RENDER_MODES.includes(mode as RenderMode) ? (mode as RenderMode) : undefined,
      visible: visible !== "0",
      ...(rankBy !== null && { rankBy }),
      ...(isHexBasis(hexBasis) && { hexBasis }),
      ...(view !== undefined && { view }),
      ...(Number.isFinite(opacity) && { opacity: Math.min(1, Math.max(0, opacity)) }),
      ...(color && color.length <= 64 && { color }),
      ...(encode && { encode }),
    });
  }
  return layers;
}

/** `<size>|<color>` back to an encoding: "~" is a channel the op left to the layer, "" one it switched off. */
function parseEncode(value: string | null): { size?: string; color?: string } | null {
  if (!value || !value.includes("|")) return null;
  const [size, color] = value.split("|");
  const out: { size?: string; color?: string } = {};
  if (size !== "~" && size.length <= 64) out.size = size;
  if (color !== "~" && color.length <= 64) out.color = color;
  return Object.keys(out).length > 0 ? out : null;
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
  const [rawStart, rawEnd, rawMode] = value.split(",");
  const start = rawStart ? safeDecode(rawStart) : null;
  const end = rawEnd ? safeDecode(rawEnd) : null;
  return start && end ? { start, end, ...(rawMode === "c" && { mode: "cumulative" as const }) } : null;
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
  let inputsByLayer: Record<string, Record<string, unknown>> = {};
  const boxesByLayer: Record<string, BBox> = {};
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
    } else if (key === "i") {
      inputsByLayer = decodeInputs(value);
    } else if (key === "q") {
      for (const entry of value.split(";")) {
        const at = entry.lastIndexOf(":");
        const box = entry.slice(at + 1).split(",").map(Number);
        if (at > 0 && box.length === 4 && box.every(Number.isFinite) && box[0] < box[2] && box[1] < box[3]) boxesByLayer[decodeURIComponent(entry.slice(0, at))] = box as BBox;
      }
    } else if (key === "s") {
      const scenario = parseScenario(value);
      if (scenario) out.scenario = scenario;
    } else if (key === "c") {
      const compare = decodeCompare(value);
      if (compare) out.compare = compare;
    } else if (key === "3d" && value === "0") {
      out.flattened = true;
    } else if (key === "relief" && value === "0") {
      out.terrain = false;
    } else if (key === "t") {
      const time = parseTime(value);
      if (time) {
        out.time = time;
        found = true;
      }
    }
  }
  // Filters and inputs ride on the layers they belong to; those for a layer the link does not load are ignored.
  out.layers = out.layers.map((layer) => ({
    ...layer,
    ...(filtersByLayer[layer.id] && { filters: filtersByLayer[layer.id] }),
    ...(inputsByLayer[layer.id] && { input: inputsByLayer[layer.id] }),
    ...(boxesByLayer[layer.id] && { queryBox: boxesByLayer[layer.id] }),
  }));
  if (out.compare && !out.layers.some((layer) => layer.id === out.compare?.layerId)) delete out.compare;
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

/** Fetches a layer over a box; `input` is the layer's own query input from the link (unset: the default input). */
export type FetchLayer = (id: string, bbox: BBox, zoom: number, input?: Record<string, unknown>) => Promise<LayerResult | LayerError>;

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

/**
 * The box shrunk about its center to `maxKm2` (a little under, for rounding) when it is larger, so a link opened on a
 * wider screen than it was shared from asks a layer for an area it answers instead of being refused (HTTP 422, an
 * error in the console) and retried on a quarter.
 */
export function capBox(bbox: BBox, maxKm2: number | undefined): BBox {
  if (maxKm2 === undefined) return bbox;
  const area = bboxAreaKm2(bbox);
  if (area <= maxKm2) return bbox;
  const k = Math.sqrt((maxKm2 * 0.97) / area);
  const [w, s, e, n] = bbox;
  const cx = (w + e) / 2;
  const cy = (s + n) / 2;
  return [cx - ((e - w) / 2) * k, cy - ((n - s) / 2) * k, cx + ((e - w) / 2) * k, cy + ((n - s) / 2) * k];
}

async function fetchWithRetry(fetchLayer: FetchLayer, id: string, bbox: BBox, zoom: number, input?: Record<string, unknown>) {
  const first = await fetchLayer(id, bbox, zoom, input);
  if (isError(first) && first.hint === "zoom_in") return fetchLayer(id, centralQuarter(bbox), zoom + 1, input);
  return first;
}

/**
 * Replays a hash into the map: 3D, basemap and camera first, then each layer fetched with the link's query input (the
 * default input when it has none) for the viewport's box and dispatched (`layer_loaded`, then `render` with the
 * sender's whole op) in the hash's order, then the time, scenario and compare. Every setting lands after its layer's
 * data, so nothing the data brings (a default op or view) overwrites it. Returns null for a hash that does not decode.
 * A layer that fails is reported as a layer error and listed in `failed`.
 */
export async function restoreFromPermalink(
  hash: string,
  dispatch: (action: MapAction) => void,
  fetchLayer: FetchLayer,
  options: RestoreOptions,
): Promise<RestoreOutcome | null> {
  const decoded = decodeState(hash);
  if (!decoded) return null;
  if (decoded.flattened) dispatch({ type: "set_flattened", flattened: true });
  if (decoded.terrain === false) dispatch({ type: "set_terrain", terrain: false });
  if (decoded.basemap) dispatch({ type: "set_basemap", basemap: decoded.basemap });
  if (decoded.viewport) dispatch({ type: "set_view", viewport: decoded.viewport });
  options.onStart?.(decoded.layers.length);

  const { viewport } = decoded;
  const view = viewport ?? { longitude: 0, latitude: 20, zoom: 1.5, pitch: 0, bearing: 0 };
  const bbox = viewportBBox(view, options.canvas.width, options.canvas.height);
  const results = await Promise.all(
    decoded.layers.map((layer) =>
      fetchWithRetry(fetchLayer, layer.id, layer.queryBox ?? capBox(bbox, options.catalog[layer.id]?.maxAreaKm2), view.zoom, layer.input).catch(
        (err): LayerError => ({ error: String(err), hint: "upstream" }),
      ),
    ),
  );

  const outcome: RestoreOutcome = { restored: [], failed: [], ...(decoded.filtersDropped && { filtersDropped: decoded.filtersDropped }) };
  decoded.layers.forEach((layer, i) => {
    const result = results[i];
    if (isError(result)) {
      dispatch({
        type: "layer_error",
        layerId: layer.id,
        message: result.error,
        ...(result.sourceStatus && !result.sourceStatus.ok && { sourceStatus: result.sourceStatus }),
        ...(layer.input && { input: layer.input }),
      });
      outcome.failed.push(layer.id);
      return;
    }
    const entry = options.catalog[layer.id];
    const style = entry?.style ?? FALLBACK_STYLE;
    dispatch({
      type: "layer_loaded",
      layer: {
        id: layer.id,
        title: (result.kind === "geojson" && result.title) || (entry?.title ?? layer.id),
        style,
        result,
        receivedAt: new Date().toISOString(),
        ...catalogFields(entry),
        ...(layer.input && { input: layer.input }),
        ...(layer.queryBox && { queryBox: layer.queryBox }),
      },
    });
    // A link without a mode takes the layer's default from its hints, as a fresh query would. A link that records the
    // view (or none) sets the op exactly; an older one lets the reducer pick the view from the data.
    dispatch({
      type: "render",
      op: {
        layerId: layer.id,
        mode: layer.mode ?? DEFAULT_MODE[style.geometry],
        visible: layer.visible,
        ...(layer.filters && { filters: layer.filters }),
        ...(layer.rankBy !== undefined && { rankBy: layer.rankBy }),
        ...(layer.hexBasis && { hexBasis: layer.hexBasis }),
        ...(layer.view && { view: layer.view }),
        ...(layer.opacity !== undefined && { opacity: layer.opacity }),
        ...(layer.color && { color: layer.color }),
        ...(layer.encode && { encode: layer.encode }),
      },
      ...(layer.mode === undefined && { defaultMode: true }),
      ...(layer.view !== undefined && { exact: true }),
      // The link's basemap stands (a choropleth answer is never moved off it on restore).
      restored: true,
    });
    outcome.restored.push(layer.id);
  });
  // After the layers, so the mode and window land on the time index they build (or wait for one).
  if (decoded.time?.mode) dispatch({ type: "set_time_mode", mode: decoded.time.mode });
  if (decoded.time) dispatch({ type: "set_time_window", window: [decoded.time.start, decoded.time.end] });
  // After the layers too: the reducer snaps the amount to the layer's scenario and ignores it for a layer that failed.
  if (decoded.scenario) dispatch({ type: "set_scenario", layerId: decoded.scenario.layerId, value: decoded.scenario.value });
  // The compare last, on a layer that came back: it starts on side A and running, so a paused side is set after it.
  const compare = decoded.compare;
  if (compare && outcome.restored.includes(compare.layerId)) {
    const { side, paused, ...spec } = compare;
    dispatch({ type: "set_compare", compare: spec });
    if (paused) dispatch({ type: "set_compare_paused", paused: true });
    if (paused && side === "b") dispatch({ type: "compare_flip" });
  }
  return outcome;
}
