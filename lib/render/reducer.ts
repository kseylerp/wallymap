import type { CompareSpec } from "@/lib/render/compare";
import {
  initialMapState,
  type CompareState,
  type LoadedLayer,
  type MapAction,
  type MapState,
  type RenderMode,
  type RenderOp,
  type TimeState,
  type ViewKind,
  type Viewport,
} from "@/lib/render/state";
import type { BBox } from "@/layers/types";
import { boundsOf, changeCompare, choroplethBasemap, defaultView, isChoropleth, padBBox, rankedMeasure, unionBBox, viewTarget } from "@/lib/render/views";
import { applyFilters, isActiveEntry, type LayerFilters } from "@/lib/render/filters";
import { stepWindow, timeIndex, type TimeIndex, type TimeWindow } from "@/lib/time";
import { arrivalPitch, fitZoomOffset } from "@/lib/render/wally/terrain";
import { WebMercatorViewport } from "@math.gl/web-mercator";
import { featureBBox, featureCenter } from "@/lib/render/inspect";
import { currentScenarioValue, scenarioOf, snapScenarioValue } from "@/lib/render/scenario";

/**
 * When a dense point layer starts clustered (style hint `cluster`): more than `minFeatures` features while the camera
 * is below `maxZoom` (regional views, where symbols would pile up).
 */
export const CLUSTER_DEFAULT = { minFeatures: 500, maxZoom: 12 } as const;

const GEOMETRY_MODE: Record<LoadedLayer["style"]["geometry"], RenderMode> = { point: "points", line: "lines", polygon: "polygons" };

/** The canvas a layer's extent is fitted into to judge the zoom it will be seen at (a typical desktop map). */
const EXTENT_CANVAS = { width: 1200, height: 800 } as const;

/**
 * The zoom a result's features fit at (their combined extent in a 1200 x 800 map), or null without a usable extent.
 * This, not the camera at load time, decides the default: the camera may still be on the globe when a query lands
 * and only fit to the place afterwards.
 */
export function extentZoom(data: GeoJSON.FeatureCollection): number | null {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of data.features) {
    const b = featureBBox(f);
    if (!b) continue;
    [w, s, e, n] = [Math.min(w, b[0]), Math.min(s, b[1]), Math.max(e, b[2]), Math.max(n, b[3])];
  }
  if (!Number.isFinite(w)) return null;
  // One point (or a stack of them) has no extent: treat it as a trailhead-scale view.
  if (e - w < 1e-6 && n - s < 1e-6) return CLUSTER_DEFAULT.maxZoom + 2;
  const clamp = (lat: number) => Math.max(-85, Math.min(85, lat));
  const { zoom } = new WebMercatorViewport(EXTENT_CANVAS).fitBounds(
    [
      [w, clamp(s)],
      [Math.max(e, w + 1e-6), clamp(Math.max(n, s + 1e-6))],
    ],
    { padding: 40 },
  );
  return zoom;
}

/**
 * The mode a layer draws in when nobody asked for one: its geometry's mode, except a point layer hinted `cluster` with
 * more than 500 features spread over a regional extent (it fits below z12), which starts as clusters. `zoom` is the
 * fallback when the features have no extent. Heat and columns are never a default: the agent picks them when the user
 * asks for density or 3D (lib/agent/prompt.ts).
 */
export function defaultRenderMode(layer: LoadedLayer, zoom: number): RenderMode {
  const { geometry, cluster } = layer.style;
  if (geometry !== "point") return GEOMETRY_MODE[geometry];
  if (layer.result.kind !== "geojson") return "points";
  const count = layer.result.data.features.length;
  if (!cluster || count <= CLUSTER_DEFAULT.minFeatures) return "points";
  return (extentZoom(layer.result.data) ?? zoom) < CLUSTER_DEFAULT.maxZoom ? "clusters" : "points";
}

/**
 * A mode the layer's geometry can draw: clusters and hex tiles are for points only, so a line or area layer asked for
 * them keeps its geometry's mode. Columns on an area layer extrude it by `v`; on a line layer they draw lines.
 */
export function modeForGeometry(mode: RenderMode, layer: LoadedLayer | undefined): RenderMode {
  const geometry = layer?.style.geometry;
  if (!geometry || geometry === "point") return mode;
  if (mode === "clusters" || mode === "hexbin") return GEOMETRY_MODE[geometry];
  if (mode === "columns" && geometry === "line") return "lines";
  return mode;
}

/** The `layer_error` id a failed `route` tool call reports under. */
export const ROUTE_ERROR_ID = "route";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/** A playback speed multiplier, or undefined when it is not a positive number. */
function validSpeed(speed: number | undefined): number | undefined {
  return speed !== undefined && Number.isFinite(speed) && speed > 0 ? speed : undefined;
}

/** The ops with `layerId`'s filters dropped; the same array when it had none. */
function withoutFilters(renderOps: RenderOp[], layerId: string): RenderOp[] {
  if (!renderOps.some((op) => op.layerId === layerId && op.filters !== undefined)) return renderOps;
  return renderOps.map((op) => {
    if (op.layerId !== layerId) return op;
    const { filters: _old, ...rest } = op;
    void _old;
    return rest;
  });
}

/** Applies `change` to the op for `layerId`; returns `state` untouched when there is no such op. */
function updateOp(state: MapState, layerId: string, change: (op: RenderOp) => RenderOp): MapState {
  if (!state.renderOps.some((op) => op.layerId === layerId)) return state;
  return { ...state, renderOps: state.renderOps.map((op) => (op.layerId === layerId ? change(op) : op)) };
}

/** Drops the selection when it belongs to `layerId` (the layer was removed, hidden or reloaded). */
function dropSelectionOf(state: MapState, layerId: string): MapState["selected"] {
  return state.selected?.layerId === layerId ? undefined : state.selected;
}

/** Returns `state` itself when the pitch is unchanged, so the map does not see a new viewport. */
function withPitch(state: MapState, pitch: number): MapState {
  return state.viewport.pitch === pitch ? state : { ...state, viewport: { ...state.viewport, pitch } };
}

/**
 * A camera move. The map reports its own camera with a pitch, which passes unchanged; an agent move or a fit
 * without one takes the arrival pitch (45 at zoom 10 and above unless flattened, else 0), and a fit backs its
 * zoom off for that pitch so the tilted view still shows the whole target.
 */
function setView(state: MapState, requested: Partial<Viewport>, fit: boolean): MapState {
  const viewport = { ...state.viewport, ...requested };
  if (requested.pitch === undefined) viewport.pitch = arrivalPitch(viewport.zoom, state.flattened);
  if (fit) viewport.zoom = Math.max(0, viewport.zoom - fitZoomOffset(viewport.pitch));
  return { ...state, viewport };
}

/** The filters that restrict something (a non-empty include, or a range); undefined when none do. */
export function activeFilters(filters: LayerFilters | undefined): LayerFilters | undefined {
  if (!filters) return undefined;
  const kept = Object.entries(filters).filter(([, f]) => isActiveEntry(f));
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

// ---- Time scrubber ----

/** The whole span of the index: the first bucket's start to the last bucket's end. */
export function fullWindow(index: TimeIndex): TimeWindow {
  return [index.buckets[0].start, index.buckets[index.buckets.length - 1].end];
}

/** The bucket a date falls in (the last bucket starting at or before it), clamped to the ends. */
export function bucketAt(index: TimeIndex, iso: string): number {
  const ms = Date.parse(iso);
  let at = 0;
  for (let i = 0; i < index.buckets.length; i++) if (Date.parse(index.buckets[i].start) <= ms) at = i;
  return at;
}

/** Keeps a window inside the data's span, ends in order; an unreadable or disjoint window becomes the whole span. */
function clampWindow(index: TimeIndex, window: TimeWindow): TimeWindow {
  const [lo, hi] = fullWindow(index);
  let a = Date.parse(window[0]);
  let b = Date.parse(window[1]);
  if (Number.isNaN(a) || Number.isNaN(b)) return [lo, hi];
  if (a > b) [a, b] = [b, a];
  const start = Math.max(a, Date.parse(lo));
  const end = Math.min(b, Date.parse(hi));
  if (start > end) return [lo, hi];
  return [start === Date.parse(lo) ? lo : new Date(start).toISOString(), end === Date.parse(hi) ? hi : new Date(end).toISOString()];
}

/**
 * Starts play. A window that ends on the last bucket but starts later than the first and spans several (an agent's or
 * the user's "2018 to 2024" over fires since 1984) plays from its own start, one bucket at a time: it restarted at 1984
 * and hid every Camp Fire outline. From the end of a one-bucket window, or with the whole span selected, play starts
 * over at the first bucket, keeping the width.
 */
function startPlaying(time: TimeState): TimeState {
  const { index, window, mode } = time;
  const last = index.buckets.length - 1;
  const i = bucketAt(index, window[0]);
  const j = bucketAt(index, window[1]);
  if (j < last) return { ...time, playing: true };
  if (mode !== "cumulative" && i > 0 && j > i) return { ...time, playing: true, window: [index.buckets[i].start, index.buckets[i].end] };
  if (mode === "cumulative") return { ...time, playing: true, window: [index.min, index.buckets[0].end] };
  const width = j - i >= last ? 0 : j - i;
  return { ...time, playing: true, window: [index.buckets[0].start, index.buckets[width].end] };
}

/** True when the layer's op hides it (a layer with no op yet counts as shown: its op follows the load). */
function isHidden(state: MapState, layerId: string): boolean {
  return state.renderOps.some((op) => op.layerId === layerId && !op.visible);
}

/** True when the layer has at least one feature with a valid `t`. */
function isDated(layer: LoadedLayer | undefined): boolean {
  return layer !== undefined && timeIndex({ [layer.id]: layer }) !== null;
}

/**
 * The time index over the shown layers only: a hidden layer's dates neither open the scrubber nor widen it (spec §5).
 * Null when the dates fill fewer than two buckets (one fire perimeter, one date): a one-step scrubber has nothing to
 * scrub or play.
 */
function shownTimeIndex(state: MapState): TimeIndex | null {
  const shown = Object.fromEntries(Object.entries(state.layers).filter(([id]) => !isHidden(state, id)));
  const index = timeIndex(shown);
  return index && index.buckets.length >= 2 ? index : null;
}

/** True when the window covers every date in the index (the opening state, or the user widened it all the way). */
function coversSpan(index: TimeIndex, window: TimeWindow): boolean {
  return Date.parse(window[0]) <= Date.parse(index.min) && Date.parse(window[1]) >= Date.parse(index.max);
}

/**
 * The window after the index changed. A window that covered the old span follows the data to the whole new span (a
 * re-query with earlier dates shows them); a window the user or agent narrowed stays where it was, clamped to the data.
 */
function rewindow(time: TimeState, index: TimeIndex): TimeWindow {
  const window = coversSpan(time.index, time.window) ? fullWindow(index) : clampWindow(index, time.window);
  return time.mode === "cumulative" ? [index.min, window[1]] : window;
}

/**
 * Rebuilds the time index after the layers (or which of them are shown) changed. No shown time-aware layer left clears
 * the scrubber. Only a newly loaded or newly shown layer may open the scrubber (`allowCreate`), so removing or hiding a
 * layer never brings back a scrubber the user closed. A window the agent asked for early (`pendingTime`) applies here.
 */
function withTimeIndex(state: MapState, allowCreate: boolean): MapState {
  const index = shownTimeIndex(state);
  if (!index) return state.time ? { ...state, time: undefined } : state;
  if (state.time) {
    // A series arriving on a scrubber of dated features turns it into frames, on the newest one.
    if (index.series && !state.time.index.series) return { ...state, time: { ...state.time, index, mode: "slide", window: seriesFrame(index) } };
    return { ...state, time: { ...state.time, index, window: rewindow(state.time, index) } };
  }
  if (!allowCreate) return state;
  const pending = state.pendingTime;
  const mode = pending?.mode ?? "slide";
  // The panel opens by itself only for a time question (the agent set a window or play) or current continuous data.
  const open = pending !== undefined || timeCritical(index);
  // A series opens one frame wide on its newest reading (spec §13: the date is the frame shown).
  const window = pending?.window ? clampWindow(index, pending.window) : index.series ? seriesFrame(index) : fullWindow(index);
  let time: TimeState = { index, mode, playing: false, window: mode === "cumulative" ? [index.min, window[1]] : window, open };
  if (pending?.playing) time = startPlaying(time);
  return { ...state, time, pendingTime: undefined };
}

/** Newest date at most this old makes continuous data current (time-critical): fires, alerts, river flow. */
export const CURRENT_DATA_DAYS = 10;

/**
 * True when the index is continuous data about now, whose time panel opens by itself: a series (river flow, currents),
 * or dated features stepped by day or hour whose newest date is within CURRENT_DATA_DAYS (fire detections, quakes,
 * weather alerts). Snapshots, archives and tile layers alone open folded.
 */
export function timeCritical(index: TimeIndex, now: number = Date.now()): boolean {
  if (index.series) return true;
  if (index.snapshots || index.cadence) return false;
  if (index.bucket !== "day" && index.bucket !== "hour") return false;
  return Date.parse(index.max) >= now - CURRENT_DATA_DAYS * 86_400_000;
}

/** One frame of a series index: the bucket at `at` (default its newest reading). */
export function seriesFrame(index: TimeIndex, at: number = index.series?.now ?? index.buckets.length - 1): TimeWindow {
  const bucket = index.buckets[Math.min(index.buckets.length - 1, Math.max(0, at))];
  return [bucket.start, bucket.end];
}

/** Rebuilds the time index when `layerId` (a dated layer) was hidden or shown; showing it may open the scrubber. */
function withShownChange(prev: MapState, next: MapState, layerId: string): MapState {
  const hidden = isHidden(next, layerId);
  if (hidden === isHidden(prev, layerId) || !isDated(next.layers[layerId])) return next;
  return withTimeIndex(next, !hidden);
}

// ---- Compare over time ----

/** A window with its ends in order (an unreadable end is left as given). */
function ordered(w: [string, string]): [string, string] {
  const a = Date.parse(w[0]);
  const b = Date.parse(w[1]);
  return !Number.isNaN(a) && !Number.isNaN(b) && a > b ? [w[1], w[0]] : [w[0], w[1]];
}

/**
 * Starts a compare: windows in order, toggle on A, the scrubber paused, and no selection left on the compared layer.
 * Changing only the windows of the compare that is on (same layer and mode, e.g. a date edited in the console) keeps
 * the side on screen and the pause.
 */
function startCompare(state: MapState, input: CompareState): MapState {
  const compare = withSnappedScenario(state, input);
  const current = state.compare;
  const sameCompare = current?.layerId === compare.layerId && current.mode === compare.mode;
  const next: CompareState = {
    ...compare,
    a: ordered(compare.a),
    b: ordered(compare.b),
    side: sameCompare ? (current.side ?? "a") : "a",
    paused: sameCompare ? current.paused : undefined,
  };
  const time = state.time?.playing ? { ...state.time, playing: false } : state.time;
  const scenario = state.scenario?.playing ? { ...state.scenario, playing: false } : state.scenario;
  return { ...state, compare: next, time, scenario, selected: dropSelectionOf(state, compare.layerId) };
}

/**
 * A scenario compare's two amounts snapped to the layer's listed values; the scenario is dropped when the layer has no
 * scenario (the compare then falls back to its windows) or an amount is not a number.
 */
function withSnappedScenario(state: MapState, compare: CompareState): CompareState {
  if (!compare.scenario) return compare;
  const contract = scenarioOf(state.layers[compare.layerId]);
  const a = contract && snapScenarioValue(contract, compare.scenario.a);
  const b = contract && snapScenarioValue(contract, compare.scenario.b);
  if (a === undefined || b === undefined) {
    const { scenario: _dropped, ...rest } = compare;
    void _dropped;
    return rest;
  }
  return { ...compare, scenario: { a, b } };
}

// ---- Scenario scrubber ----

/** Drops the scenario state when it is on `layerId` (the layer was removed or re-queried). */
function dropScenarioOf(state: MapState, layerId: string): MapState["scenario"] {
  return state.scenario?.layerId === layerId ? undefined : state.scenario;
}

/** Plays or pauses a scenario layer's scrubber; play from the last amount starts over at the first. */
function setScenarioPlaying(state: MapState, layerId: string, playing: boolean): MapState {
  const contract = scenarioOf(state.layers[layerId]);
  if (!contract || contract.values.length === 0) return state;
  if (!playing) {
    return state.scenario?.layerId === layerId && state.scenario.playing ? { ...state, scenario: { ...state.scenario, playing: false } } : state;
  }
  const value = currentScenarioValue(state, layerId) ?? contract.values[0];
  const atEnd = contract.values.indexOf(value) >= contract.values.length - 1;
  return { ...state, scenario: { layerId, value: atEnd ? contract.values[0] : value, playing: true } };
}

/**
 * Drops the selection on the compared layer when the features drawn for it change identity: the delta draws copies of
 * the features (tagged a-only, b-only, both), swipe and toggle draw the originals, and a side B pick needs side B drawn.
 */
function dropComparedSelection(state: MapState, from: CompareSpec["mode"] | undefined, to: CompareSpec["mode"] | undefined): MapState["selected"] {
  const compare = state.compare;
  const selected = state.selected;
  if (!compare || selected?.layerId !== compare.layerId) return selected;
  const sideBGone = selected.side === "b" && (to === undefined || to === "delta");
  return sideBGone || from === "delta" || to === "delta" ? undefined : selected;
}

/** Drops the compare when it is on `layerId` (the layer was removed). */
function dropCompareOf(state: MapState, layerId: string): MapState["compare"] {
  return state.compare?.layerId === layerId ? undefined : state.compare;
}

function sameWindow(a: TimeWindow, b: TimeWindow): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** True when `reset_map` would change nothing: no layers, routes, filters, time, compare, preview or selection, and the camera at the world view. */
export function isMapReset(state: MapState): boolean {
  const a = state.viewport;
  const b = initialMapState.viewport;
  return (
    Object.keys(state.layers).length === 0 &&
    Object.keys(state.routes).length === 0 &&
    state.renderOps.length === 0 &&
    state.errors.length === 0 &&
    state.selected === undefined &&
    state.playback === undefined &&
    state.time === undefined &&
    state.pendingTime === undefined &&
    state.compare === undefined &&
    state.scenario === undefined &&
    a.longitude === b.longitude &&
    a.latitude === b.latitude &&
    a.zoom === b.zoom &&
    a.pitch === b.pitch &&
    a.bearing === b.bearing
  );
}

// ---- Camera and standard views (spec §12) ----

function sameBBox(a: BBox | undefined, b: BBox): boolean {
  return a !== undefined && a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
}

/**
 * Asks the app to fit the camera to `bbox` (padded to a minimum span), only while a named place is this turn's
 * (spec §12: "here" questions never move the camera). The same box asked for twice in a row is not asked again.
 */
function fitCamera(state: MapState, bbox: BBox | null, lowerThird = false): MapState {
  if (!state.place || !bbox) return state;
  // One point inside the place asked about (the rock at Zion Canyon's centre) frames the place, not a 1 km box at zoom 15.
  const p = state.place.bbox;
  if (bbox[0] === bbox[2] && bbox[1] === bbox[3] && bbox[0] >= p[0] && bbox[0] <= p[2] && bbox[1] >= p[1] && bbox[1] <= p[3]) bbox = p;
  const target = padBBox(bbox);
  const place = state.place.moved ? state.place : { ...state.place, moved: true };
  if (sameBBox(state.camera?.bbox, target) && Boolean(state.camera?.lowerThird) === lowerThird) return { ...state, place };
  const camera = { bbox: target, seq: (state.camera?.seq ?? 0) + 1, ...(lowerThird && { lowerThird: true }) };
  return { ...state, place, camera };
}

/** The union of every feature loaded for this turn's place: what a named-place answer fits to. */
function placeBounds(state: MapState): BBox | null {
  let out: BBox | null = null;
  for (const id of state.place?.layers ?? []) {
    const layer = state.layers[id];
    if (layer?.result.kind !== "geojson") continue;
    const op = state.renderOps.find((o) => o.layerId === id);
    const data = op?.filters ? applyFilters(layer.result.data, op.filters) : layer.result.data;
    out = unionBBox(out, boundsOf(data.features));
  }
  return out;
}

/**
 * A standard view's preset on a drawn layer (spec §12): change opens the compare (delta) on the layer's two versions or
 * dates; ranked puts the facet slider at the top N; density draws a point layer as clusters (heat stays heat); detail
 * selects the one feature. Then, for a named place, the camera fits what the view shows (the union of both sides for
 * change, the top N for ranked, the feature in the lower third for detail). The op remembers the view for the legend.
 */
export function applyView(state: MapState, layerId: string, view: ViewKind, named = true): MapState {
  const layer = state.layers[layerId];
  const index = state.renderOps.findIndex((op) => op.layerId === layerId);
  if (!layer || index === -1) return state;
  let op: RenderOp = { ...state.renderOps[index], view };
  let next: MapState = state;
  // A timeline the agent named is a question about time: the time panel opens on it.
  if (view === "timeline" && named && next.time && !next.time.open) next = { ...next, time: { ...next.time, open: true } };
  if (view === "ranked") {
    // A measure is ranked, not filtered (spec §12c): every feature stays, sized by the measure, the top 10 listed.
    const rankBy = op.rankBy ?? rankedMeasure(layer);
    if (rankBy) op = { ...op, rankBy };
    // Sized symbols, unless 3D columns were asked for: columns as tall as the measure rank it too ("as 3D columns by
    // megawatts" came out as flat symbols).
    if (layer.style.geometry === "point" && op.mode !== "points" && op.mode !== "columns") op = { ...op, mode: "points" };
  }
  if (view === "density" && layer.style.geometry === "point") {
    // A colour basis asked for (spec §12d: "where is most of the capacity") draws hex cells; else clusters, or heat.
    if (op.hexBasis && op.mode !== "hexbin" && op.mode !== "columns") op = { ...op, mode: "hexbin" };
    else if (!op.hexBasis && op.mode !== "heat" && op.mode !== "clusters" && op.mode !== "hexbin") op = { ...op, mode: "clusters" };
  }
  next = { ...next, renderOps: next.renderOps.map((o, i) => (i === index ? op : o)) };
  if (view === "change" && next.compare?.layerId !== layerId) {
    const compare = changeCompare(layer);
    if (compare) next = startCompare(next, compare);
  }
  let lowerThird = false;
  if (view === "detail" && layer.result.kind === "geojson") {
    const data = op.filters ? applyFilters(layer.result.data, op.filters) : layer.result.data;
    const feature = data.features.length === 1 ? data.features[0] : undefined;
    const at = feature && featureCenter(feature);
    if (feature && at) next = { ...next, selected: { layerId, feature, lngLat: at } };
    lowerThird = true;
  }
  // Points that sample the view (the forecast) never frame it while another layer answers there: the answer keeps it.
  if (layer.style.samplesView && answersBeside(next, layerId)) return next;
  return fitCamera(next, viewTarget(view, layer, op.filters, op.rankBy) ?? (next.place && !next.place.moved ? next.place.bbox : null), lowerThird);
}

/** True when a visible layer other than `layerId` draws features of its own (not a sampling of the view). */
function answersBeside(state: MapState, layerId: string): boolean {
  return state.renderOps.some((o) => o.layerId !== layerId && o.visible && state.layers[o.layerId]?.result.kind === "geojson" && !state.layers[o.layerId]?.style.samplesView);
}

/**
 * Pure reducer: always returns new objects and never mutates `state`. Selecting or deselecting a feature never
 * moves the camera; only `set_view` and the 3D button do.
 */
export function reduce(state: MapState, action: MapAction): MapState {
  return reduceAction(state, action);
}

function reduceAction(state: MapState, action: MapAction): MapState {
  switch (action.type) {
    case "set_view":
      return setView(state, action.viewport, action.fit === true);
    case "set_terrain":
      return state.terrain === action.terrain ? state : { ...state, terrain: action.terrain };
    case "set_flattened": {
      if (action.flattened) return withPitch({ ...state, flattened: true }, 0);
      // Turning 3D back on brings the terrain back, and tilts the camera when it is at trail zooms.
      const next = { ...state, flattened: false, terrain: true };
      return withPitch(next, arrivalPitch(state.viewport.zoom, false) || state.viewport.pitch);
    }
    case "set_basemap":
      if (state.basemap === action.basemap) return state;
      // The agent never puts a choropleth answer on imagery (isChoropleth); the person's own pick always stands.
      if (action.agent && (action.basemap === "satellite" || action.basemap === "outdoors-satellite")) {
        const choropleth = state.renderOps.some((o) => o.visible && state.layers[o.layerId] && isChoropleth(state.layers[o.layerId]));
        if (choropleth) return state;
      }
      // A style swap drops the route layers the preview draws on, so the preview ends with it.
      return { ...state, basemap: action.basemap, playback: undefined };
    case "layer_loaded": {
      const loaded = withTimeIndex(
        {
          ...state,
          layers: { ...state.layers, [action.layer.id]: action.layer },
          // A re-query (new place, new data) starts unfiltered: a value picked for the old features may match none of
          // the new ones. The render op that follows the load brings its own filters when the agent sends some.
          renderOps: state.layers[action.layer.id] ? withoutFilters(state.renderOps, action.layer.id) : state.renderOps,
          errors: state.errors.filter((e) => e.layerId !== action.layer.id),
          // A reload replaces the features, so the old selection no longer points at anything drawn.
          selected: dropSelectionOf(state, action.layer.id),
          // A re-query of a scenario layer shows the amount it asked for, not the scrubber's.
          scenario: dropScenarioOf(state, action.layer.id),
        },
        true,
      );
      // A named place's answer: the camera fits every feature returned for it so far (or the place, for tiles or none).
      if (!loaded.place) return loaded;
      const layers = loaded.place.layers.includes(action.layer.id) ? loaded.place.layers : [...loaded.place.layers, action.layer.id];
      const placed = { ...loaded, place: { ...loaded.place, layers } };
      return fitCamera(placed, placeBounds(placed) ?? (placed.place.moved ? null : placed.place.bbox));
    }
    case "layer_error":
      // One line per layer: a retry that fails again replaces the last reason.
      return {
        ...state,
        errors: [
          ...state.errors.filter((e) => e.layerId !== action.layerId),
          {
            layerId: action.layerId,
            message: action.message,
            ...(action.sourceStatus && { sourceStatus: action.sourceStatus }),
            ...(action.input && { input: action.input }),
          },
        ],
      };
    case "render": {
      const index = state.renderOps.findIndex((op) => op.layerId === action.op.layerId);
      const loaded = state.layers[action.op.layerId];
      // No mode asked for: keep the one the layer has (the user may have picked it in the panel), or take the default.
      const asked = action.defaultMode
        ? (state.renderOps[index]?.mode ?? (loaded ? defaultRenderMode(loaded, state.viewport.zoom) : action.op.mode))
        : action.op.mode;
      const op: RenderOp = { ...action.op, mode: modeForGeometry(asked, loaded) };
      // A colored map of areas (temperature anomaly by county, drought) the agent adds beside other answers goes under
      // them: drawn last over the Boundary Waters, the counties' pink hid the fires and mines it was asked beside.
      const under = index === -1 && !action.exact && !action.restored && loaded !== undefined && loaded.result.kind === "geojson" && isChoropleth(loaded) && state.renderOps.length > 0;
      const renderOps =
        index === -1
          ? under
            ? [op, ...state.renderOps]
            : [...state.renderOps, op]
          : action.exact
            ? state.renderOps.map((old, i) => (i === index ? op : old))
            : state.renderOps.map((old, i) =>
              // The agent restyling a layer keeps the opacity and filters the user picked in the layer panel.
              i === index
                ? {
                    ...op,
                    opacity: op.opacity ?? old.opacity,
                    filters: op.filters !== undefined ? activeFilters(op.filters) : old.filters,
                    ...((op.rankBy ?? old.rankBy) !== undefined && { rankBy: op.rankBy ?? old.rankBy }),
                    ...((op.hexBasis ?? old.hexBasis) && { hexBasis: op.hexBasis ?? old.hexBasis }),
                    ...((op.encode ?? old.encode) && { encode: { ...old.encode, ...op.encode } }),
                  }
                : old,
            );
      // Heat draws no features of its own, so a selection on a layer that turns into heat would point at nothing drawn.
      const selected = op.mode === "heat" ? dropSelectionOf(state, op.layerId) : state.selected;
      // A choropleth answer's first draw leaves satellite imagery for Topographical (or the layer's own basemap); a share
      // link (exact) keeps the basemap it carries.
      const basemap = index === -1 && loaded && !action.exact && !action.restored ? (choroplethBasemap(loaded, state.basemap) ?? state.basemap) : state.basemap;
      const next = withShownChange(state, { ...state, renderOps, selected, ...(basemap !== state.basemap && { basemap, playback: undefined }) }, action.op.layerId);
      // A share link's op is the sender's as drawn: its view (or none) stays, and the view's preset is not run again,
      // so it cannot move the mode, rank or compare the link carries.
      if (action.exact) return next;
      // The view: the one the agent named, else (on the layer's first op) the one its data asks for; a restyle without
      // a view keeps the layer's.
      const view = action.op.view ?? (index === -1 && loaded ? defaultView(loaded, op.filters) : undefined);
      if (!view) {
        if (index === -1 || !state.renderOps[index].view) return next;
        return { ...next, renderOps: next.renderOps.map((o) => (o.layerId === op.layerId ? { ...o, view: state.renderOps[index].view } : o)) };
      }
      return applyView(next, action.op.layerId, view, action.op.view !== undefined);
    }
    case "toggle_layer": {
      const next = updateOp(state, action.layerId, (op) => ({ ...op, visible: !op.visible }));
      if (next === state) return state;
      const op = next.renderOps.find((o) => o.layerId === action.layerId);
      const shown = op?.visible ? next : { ...next, selected: dropSelectionOf(next, action.layerId) };
      return withShownChange(state, shown, action.layerId);
    }
    case "select":
      return { ...state, selected: action.selection };
    case "deselect":
      return state.selected === undefined ? state : { ...state, selected: undefined };
    case "set_opacity":
      return updateOp(state, action.layerId, (op) => ({ ...op, opacity: clamp01(action.opacity) }));
    case "set_style": {
      const next = updateOp(state, action.layerId, (op) => ({
        ...op,
        ...(action.color !== undefined && { color: action.color }),
        ...(action.mode !== undefined && { mode: modeForGeometry(action.mode, state.layers[action.layerId]) }),
      }));
      return next !== state && action.mode === "heat" ? { ...next, selected: dropSelectionOf(next, action.layerId) } : next;
    }
    case "set_rank_by":
      return updateOp(state, action.layerId, (op) => {
        const { rankBy: _old, ...rest } = op;
        void _old;
        // undefined goes back to the default (the primary measure); "" is None, picked in the row.
        return action.key !== undefined ? { ...rest, rankBy: action.key } : rest;
      });
    case "set_hex_basis":
      return updateOp(state, action.layerId, (op) => ({ ...op, hexBasis: action.basis }));
    case "set_hover":
      if (state.hover?.feature === action.hover?.feature && state.hover?.layerId === action.hover?.layerId) return state;
      return action.hover ? { ...state, hover: action.hover } : { ...state, hover: undefined };
    case "fly_to": {
      // An explicit click (the row's top 10, "Zoom to this cell"): the one camera move a click makes besides arrival.
      const camera = { bbox: padBBox(action.bbox), seq: (state.camera?.seq ?? 0) + 1 };
      return { ...state, camera, ...(action.select && { selected: action.select }) };
    }
    case "set_filters":
      return updateOp(state, action.layerId, (op) => {
        const { filters: _old, ...rest } = op;
        void _old;
        const filters = activeFilters(action.filters);
        return filters ? { ...rest, filters } : rest;
      });
    case "reorder": {
      const from = state.renderOps.findIndex((op) => op.layerId === action.layerId);
      if (from === -1) return state;
      const to = Math.min(state.renderOps.length - 1, Math.max(0, Math.trunc(action.toIndex)));
      if (to === from) return state;
      const renderOps = [...state.renderOps];
      const [moved] = renderOps.splice(from, 1);
      renderOps.splice(to, 0, moved);
      return { ...state, renderOps };
    }
    case "remove_layer": {
      if (!state.layers[action.layerId] && !state.renderOps.some((op) => op.layerId === action.layerId)) {
        // A layer that only failed: its row goes.
        return state.errors.some((e) => e.layerId === action.layerId) ? { ...state, errors: state.errors.filter((e) => e.layerId !== action.layerId) } : state;
      }
      const layers = { ...state.layers };
      delete layers[action.layerId];
      return withTimeIndex(
        {
          ...state,
          layers,
          renderOps: state.renderOps.filter((op) => op.layerId !== action.layerId),
          errors: state.errors.filter((e) => e.layerId !== action.layerId),
          selected: dropSelectionOf(state, action.layerId),
          hover: state.hover?.layerId === action.layerId ? undefined : state.hover,
          compare: dropCompareOf(state, action.layerId),
          scenario: dropScenarioOf(state, action.layerId),
          // The last layer gone ends the conversation's map: a time window still waiting for a dated layer is dropped
          // too, so it never lands on a layer opened much later.
          ...(Object.keys(layers).length === 0 && { pendingTime: undefined }),
        },
        false,
      );
    }
    case "clear_layers":
      return {
        ...state,
        layers: {},
        routes: {},
        renderOps: [],
        errors: [],
        selected: undefined,
        hover: undefined,
        playback: undefined,
        time: undefined,
        pendingTime: undefined,
        compare: undefined,
        scenario: undefined,
        place: undefined,
      };
    case "reset_map":
      // Compose the layer panel's "Clear all" with the starting camera; basemap and 3D stay as they are.
      return { ...reduceAction(state, { type: "clear_layers" }), viewport: initialMapState.viewport };
    case "route_loaded":
      return {
        ...state,
        routes: { ...state.routes, [action.route.id]: action.route },
        // A route that arrived supersedes an earlier failed route request.
        errors: state.errors.filter((e) => e.layerId !== ROUTE_ERROR_ID),
      };
    case "route_removed": {
      if (!state.routes[action.routeId]) return state;
      const routes = { ...state.routes };
      delete routes[action.routeId];
      // Previewing a route that is gone would follow nothing.
      const playback = state.playback?.routeId === action.routeId ? undefined : state.playback;
      return { ...state, routes, playback };
    }
    case "routes_cleared":
      return Object.keys(state.routes).length === 0 && !state.playback ? state : { ...state, routes: {}, playback: undefined };
    case "preview_start":
      if (!state.routes[action.routeId]) return state;
      return {
        ...state,
        selected: undefined,
        playback: { routeId: action.routeId, fraction: 0, playing: true, speed: validSpeed(action.speed) ?? 1 },
      };
    case "preview_tick": {
      if (!state.playback || !Number.isFinite(action.fraction)) return state;
      const fraction = Math.min(1, Math.max(0, action.fraction));
      const playing = state.playback.playing && fraction < 1;
      if (fraction === state.playback.fraction && playing === state.playback.playing) return state;
      return { ...state, playback: { ...state.playback, fraction, playing } };
    }
    case "preview_toggle": {
      if (!state.playback) return state;
      const { playing, fraction } = state.playback;
      return {
        ...state,
        playback: { ...state.playback, playing: !playing, fraction: !playing && fraction >= 1 ? 0 : fraction },
      };
    }
    case "preview_speed": {
      const speed = validSpeed(action.speed);
      if (!state.playback || speed === undefined || speed === state.playback.speed) return state;
      return { ...state, playback: { ...state.playback, speed } };
    }
    case "preview_stop":
      return state.playback ? { ...state, playback: undefined } : state;
    case "set_time_window": {
      if (!state.time) {
        // No time-aware layer yet (the agent set the time before its query landed): apply it when one arrives.
        const index = shownTimeIndex(state);
        const pendingTime = { ...state.pendingTime, window: action.window };
        return index ? withTimeIndex({ ...state, pendingTime }, true) : { ...state, pendingTime };
      }
      const clamped = clampWindow(state.time.index, action.window);
      const window: TimeWindow = state.time.mode === "cumulative" ? [state.time.index.min, clamped[1]] : clamped;
      // Setting a window is a time question: the panel opens to show it.
      if (sameWindow(window, state.time.window)) return state.time.open ? state : { ...state, time: { ...state.time, open: true } };
      return { ...state, time: { ...state.time, window, open: true } };
    }
    case "set_time_open":
      if (!state.time || (state.time.open ?? false) === action.open) return state;
      return { ...state, time: { ...state.time, open: action.open } };
    case "set_time_playing": {
      if (!state.time) return state.pendingTime ? { ...state, pendingTime: { ...state.pendingTime, playing: action.playing } } : state;
      if (state.time.playing === action.playing) return state;
      return { ...state, time: action.playing ? { ...startPlaying(state.time), open: true } : { ...state.time, playing: false } };
    }
    case "set_time_mode": {
      // Before any dated layer, the mode waits with (or ahead of) the window the agent asks for next.
      if (!state.time) return { ...state, pendingTime: { ...state.pendingTime, mode: action.mode } };
      if (state.time.mode === action.mode) return state;
      const window: TimeWindow = action.mode === "cumulative" ? [state.time.index.min, state.time.window[1]] : state.time.window;
      return { ...state, time: { ...state.time, mode: action.mode, window } };
    }
    case "time_tick": {
      const time = state.time;
      if (!time?.playing) return state;
      const window = stepWindow(time.index, time.window, 1, time.mode);
      // Nothing left to step to: play ends on the last frame.
      if (sameWindow(window, time.window)) return { ...state, time: { ...time, playing: false } };
      return { ...state, time: { ...time, window } };
    }
    case "clear_time":
      return state.time || state.pendingTime ? { ...state, time: undefined, pendingTime: undefined } : state;
    case "set_compare":
      return startCompare(state, action.compare);
    case "set_compare_mode":
      if (!state.compare || state.compare.mode === action.mode) return state;
      return {
        ...state,
        compare: { ...state.compare, mode: action.mode, side: "a" },
        selected: dropComparedSelection(state, state.compare.mode, action.mode),
      };
    case "compare_flip":
      if (!state.compare) return state;
      return { ...state, compare: { ...state.compare, side: state.compare.side === "b" ? "a" : "b" } };
    case "set_compare_paused":
      if (!state.compare || Boolean(state.compare.paused) === action.paused) return state;
      return { ...state, compare: { ...state.compare, paused: action.paused } };
    case "clear_compare":
      // Starting a compare paused the scrubber; ending it does not resume play (the user presses Play again).
      return state.compare
        ? { ...state, compare: undefined, selected: dropComparedSelection(state, state.compare.mode, undefined) }
        : state;
    case "set_scenario": {
      const contract = scenarioOf(state.layers[action.layerId]);
      const value = contract && snapScenarioValue(contract, action.value);
      if (value === undefined) return state;
      const current = state.scenario;
      if (current?.layerId === action.layerId && current.value === value) return state;
      // Moving the scrubber by hand (or the agent setting an amount) keeps play going only on the same layer.
      return { ...state, scenario: { layerId: action.layerId, value, playing: current?.layerId === action.layerId && current.playing } };
    }
    case "set_scenario_playing":
      return setScenarioPlaying(state, action.layerId, action.playing);
    case "scenario_tick": {
      const scenario = state.scenario;
      if (!scenario?.playing) return state;
      const values = scenarioOf(state.layers[scenario.layerId])?.values;
      if (!values) return { ...state, scenario: undefined };
      const at = values.indexOf(scenario.value);
      // Nothing left to step to: play ends on the last amount.
      if (at < 0 || at >= values.length - 1) return { ...state, scenario: { ...scenario, playing: false } };
      return { ...state, scenario: { ...scenario, value: values[at + 1] } };
    }
    case "clear_scenario":
      return state.scenario ? { ...state, scenario: undefined } : state;
    case "place_named":
      if (action.implicit && state.place) return state;
      return { ...state, place: { bbox: action.bbox, layers: [], moved: false } };
    case "place_framed":
    case "turn_start":
      return state.place ? { ...state, place: undefined } : state;
    case "place_settle":
      return state.place && !state.place.moved ? fitCamera(state, state.place.bbox) : state;
    case "set_view_kind":
      return applyView(state, action.layerId, action.view);
  }
}
