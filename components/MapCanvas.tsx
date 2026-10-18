"use client";

import type { Layer } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import mapboxgl from "mapbox-gl";
import { useCallback, useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { MapSetupNotice } from "@/components/MapSetupNotice";
import { drawnLineEntries, syncHeatLayers, syncLineLayers, syncSatelliteHybrid, syncTileLayers, tileKeyOf } from "@/components/mapTiles";
import { setInView, type InView, type TileSample } from "@/lib/render/inView";
import { ensureRouteImages, setRouteProgress, syncRouteLayers } from "@/components/routeLayers";
import { basemapStyle, basemapStyleUrl } from "@/lib/render/basemaps";
import { swipeStore } from "@/lib/render/compareView";
import { buildDeckLayerSets, isClusterFeature, type Padding } from "@/lib/render/deck";
import { deckLayerFilter, pickPasses, pickToSelection, pickUnderHeat, type DeckPick } from "@/lib/render/inspect";
import { lineLayerId, linePickToSelection, PICKABLE_PARTS } from "@/lib/render/nativeLines";
import { viewFromCamera, type MapView } from "@/lib/agent/view";
import { initialMapState, type Basemap, type MapState, type Selection, type Viewport } from "@/lib/render/state";
import { missingTilesStore, noteTile, withTileFallback } from "@/lib/render/tileErrors";
import { tileSwipeLayers } from "@/lib/render/tileSides";
import { visibleState } from "@/lib/render/view";
import { identifyAt, identifyRequests } from "@/lib/render/identify";
import { animateSeriesLines, resetSeriesLines } from "@/lib/render/seriesLines";
import { fieldAt, flowFrame, flowLayersOf, ParticleSystem, type FieldSnapshot, type ParticleView } from "@/lib/render/particles";
import { metersPerPixel } from "@/lib/render/deck";
import { captureStore } from "@/lib/export/capture";
import { playheadStore } from "@/lib/render/playhead";
import {
  bearingAt,
  bearingLookAheadM,
  cameraDistanceMeters,
  chasePadding,
  chasePitch,
  chaseFit,
  chaseZoom,
  dispatchPreview,
  dockCompactStore,
  elevationStore,
  followPadding,
  fractionStep,
  lengthMeters,
  liveFractionStore,
  mapStateStore,
  offsetPoint,
  OUTRO_HOLD_MS,
  positionAt,
  PREVIEW_DIVE_MS,
  PREVIEW_OVERVIEW_MS,
  PREVIEW_RISE_MS,
  previewExitCamera,
  smoothBearing,
  speedKmPerMin,
} from "@/lib/render/wally/playback";
import { visibleMapPadding } from "@/lib/render/viewportPadding";
import { clearInsets } from "@/lib/render/labelPlacement";
import { safeAreaInsets } from "@/lib/render/safeArea";
import { samplePoints } from "@/lib/render/wally/sample";
import {
  BUILDINGS_LAYER_ID,
  buildingsSpec,
  easeInOut,
  firstSymbolLayerId,
  fitZoomOffset,
  fogSpec,
  PITCH_EASE_MS,
  pitchFor,
  SKY_LAYER_ID,
  skySpec,
  TERRAIN_SOURCE_ID,
  terrainSource,
  terrainSpec,
} from "@/lib/render/wally/terrain";

// Literal `process.env.NEXT_PUBLIC_*` access so Next inlines it into the client bundle.
const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN?.trim() ?? "";
const EPSILON = 1e-6;
/** Picking slop around the pointer, so a 2.5px trail is clickable. */
const PICK_RADIUS_PX = 4;
/** Under a heatmap, a click selects the nearest feature within this many pixels. */
const HEAT_PICK_RADIUS_PX = 10;
/** Clicking a cluster blob zooms in this many levels (capped at the map's max zoom). */
const CLUSTER_ZOOM_STEP = 1;
const CLUSTER_EASE_MS = 450;
/** A new viewport from the state (the agent's set_view, reset map, the globe button) eases in over this long. */
const VIEWPORT_EASE_MS = 800;

/** Imperative camera controls for the on-map buttons. */
export type MapHandle = {
  zoomIn: () => void;
  zoomOut: () => void;
  /** Back to the starting world view (pitch 0), through the same `set_view` path the agent uses. */
  resetToGlobe: () => void;
  /** Screen position of a map point (container pixels), or null before the map exists. */
  project: (lngLat: [number, number]) => { x: number; y: number } | null;
  /** Calls `listener` on every camera frame and resize; returns the unsubscribe function. */
  onCameraChange: (listener: () => void) => () => void;
  /** What the map shows right now inside `padding` (the screen the panels leave uncovered), for the chat request. */
  getView: (padding?: Padding) => MapView | null;
};

type MapCanvasProps = {
  state: MapState;
  onViewportChange: (v: Viewport) => void;
  /** A click on the map: the feature it hit, or null for empty map (which closes the inspect card). */
  onPick?: (selection: Selection | null) => void;
  className?: string;
  /** React 19 passes `ref` as a plain prop, so no `forwardRef` wrapper is needed. */
  ref?: Ref<MapHandle>;
};

export function MapCanvas({ state, onViewportChange, onPick, className, ref }: MapCanvasProps) {
  if (!MAPBOX_TOKEN) {
    return (
      <div data-testid="map-canvas" className={className ?? "h-full w-full"}>
        <MapSetupNotice />
      </div>
    );
  }
  return <GlobeMap state={state} onViewportChange={onViewportChange} onPick={onPick} className={className} ref={ref} />;
}

function cameraOf(map: mapboxgl.Map): Viewport {
  const { lng, lat } = map.getCenter();
  return {
    longitude: lng,
    latitude: lat,
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
  };
}

/** The live map's view inside `padding`: the map points under the uncovered rectangle's corners and edge midpoints. */
function viewOf(map: mapboxgl.Map, padding: Padding = { top: 0, right: 0, bottom: 0, left: 0 }): MapView {
  const { lng, lat } = map.getCenter();
  const canvas = map.getCanvas();
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const left = Math.min(padding.left, width - 1);
  const right = Math.max(left + 1, width - padding.right);
  const top = Math.min(padding.top, height - 1);
  const bottom = Math.max(top + 1, height - padding.bottom);
  const xs = [left, (left + right) / 2, right];
  const ys = [top, (top + bottom) / 2, bottom];
  const points: [number, number][] = [];
  for (const x of xs) {
    for (const y of ys) {
      if (x === xs[1] && y === ys[1]) continue;
      const p = map.unproject([x, y]);
      if (Number.isFinite(p.lng) && Number.isFinite(p.lat)) points.push([p.lng, p.lat]);
    }
  }
  const b = map.getBounds();
  const bounds: [number, number, number, number] | null = b ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] : null;
  return viewFromCamera({ center: [lng, lat], zoom: map.getZoom(), points, bounds });
}

function sameViewport(a: Viewport, b: Viewport): boolean {
  return (
    Math.abs(a.longitude - b.longitude) <= EPSILON &&
    Math.abs(a.latitude - b.latitude) <= EPSILON &&
    Math.abs(a.zoom - b.zoom) <= EPSILON &&
    Math.abs(a.pitch - b.pitch) <= EPSILON &&
    Math.abs(a.bearing - b.bearing) <= EPSILON
  );
}

/** Tile URLs re-request at most this often while the time window moves (spec §5). */
const TILE_TIME_DEBOUNCE_MS = 150;

/** The tile layers as drawn: the visible state, with a dated layer whose window has no image back on its loaded image. */
function tileView(state: MapState): MapState {
  return withTileFallback(visibleState(state), state, missingTilesStore.get());
}

/** Every tile layer's URL, so a time step that rewrites one can be told apart from other state changes. */
function tileUrlsKey(view: MapState): string {
  return Object.values(view.layers)
    .map((l) => (l.result.kind === "tiles" ? `${l.id}=${l.result.data.url}` : ""))
    .join("|");
}

type DeckLayerSets = { main: Layer[]; a: Layer[]; b: Layer[] };

/** The floating panels a ranked label must stay clear of (the inspect card comes and goes, so it is left out). */
const LABEL_OBSTACLES = ['[data-testid="top-bar"]', 'section[aria-label="Chat"]', '[data-testid="layer-stack"]'];

/**
 * How far the floating panels and the phone's safe area reach into the map canvas, so ranked labels stay in the
 * clear part (lib/render/labelPlacement.ts). Read from the page each time the labels are placed.
 */
function panelInsets(canvas: { width: number; height: number }): Padding {
  const box = document.querySelector('[data-testid="map-canvas"]')?.getBoundingClientRect();
  if (!box) return { top: 0, right: 0, bottom: 0, left: 0 };
  const panels = LABEL_OBSTACLES.flatMap((selector) => {
    const el = document.querySelector<HTMLElement>(selector);
    const r = el?.getBoundingClientRect();
    if (!el || !r || r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") return [];
    return [{ left: r.left - box.left, top: r.top - box.top, right: r.right - box.left, bottom: r.bottom - box.top }];
  });
  const covered = clearInsets(canvas, panels);
  const safe = safeAreaInsets();
  return {
    top: Math.max(covered.top, safe.top),
    right: Math.max(covered.right, safe.right),
    bottom: Math.max(covered.bottom, safe.bottom),
    left: Math.max(covered.left, safe.left),
  };
}

/** An unsupported render mode must not crash the canvas, so failures render no deck layers. */
function safeDeckLayers(state: MapState): DeckLayerSets {
  try {
    // The visible view: features outside the time window (and filtered out in the layer panel) are not drawn.
    const view = visibleState(state);
    const sets = buildDeckLayerSets(view, { labelInsets: panelInsets });
    // A swiped scenario tile layer (sea level rise) draws its two amounts in the side overlays too.
    const tiles = tileSwipeLayers(view);
    return tiles.a.length + tiles.b.length === 0 ? sets : { ...sets, a: [...sets.a, ...tiles.a], b: [...sets.b, ...tiles.b] };
  } catch (error) {
    console.error("MapCanvas: could not build deck.gl layers", error);
    return { main: [], a: [], b: [] };
  }
}

// ---- Compare swipe (lib/render/compareView.ts) ----
// Side A and side B of the compared layer draw in two extra overlays (their own canvases, each with its own terrain
// copy so draped features sit on the slopes), clipped with CSS either side of the swipe handle, so the split is
// exactly the handle's screen line at any pitch and bearing. They exist only while a swipe is on. Cost: two more
// WebGL contexts and a second fetch of deck's DEM tiles (served from the HTTP cache); the compared layer is not
// clickable while swiping. Tile layers (night lights, forest loss) compare by toggle instead: clipping a Mapbox
// raster to a screen half would need a second synced map.

type SideOverlays = { a: MapboxOverlay; b: MapboxOverlay };

/** Clips side A to the left of the handle and side B to its right (`at` is a share of the map width). */
function clipSides(sides: SideOverlays | null, at: number): void {
  if (!sides) return;
  const pct = Math.min(100, Math.max(0, at * 100));
  const a = sides.a.getCanvas()?.parentElement;
  const b = sides.b.getCanvas()?.parentElement;
  if (a) a.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
  if (b) b.style.clipPath = `inset(0 0 0 ${pct}%)`;
}

/** Adds, updates or removes the two side overlays to match the deck sets (they exist while `a` or `b` has layers). */
function syncSideOverlays(map: mapboxgl.Map, current: SideOverlays | null, sets: DeckLayerSets): SideOverlays | null {
  if (sets.a.length === 0 && sets.b.length === 0) {
    if (current) {
      map.removeControl(current.a);
      map.removeControl(current.b);
    }
    return null;
  }
  let sides = current;
  if (!sides) {
    // Deck creates its canvas asynchronously, so the first clip waits for each overlay's `onLoad`.
    const clipWhenLoaded = () => clipSides(sides, swipeStore.get());
    sides = {
      a: new MapboxOverlay({ interleaved: false, layers: sets.a, onLoad: clipWhenLoaded, layerFilter: deckLayerFilter(() => true) }),
      b: new MapboxOverlay({ interleaved: false, layers: sets.b, onLoad: clipWhenLoaded, layerFilter: deckLayerFilter(() => true) }),
    };
    map.addControl(sides.a);
    map.addControl(sides.b);
  } else {
    sides.a.setProps({ layers: sets.a });
    sides.b.setProps({ layers: sets.b });
  }
  clipSides(sides, swipeStore.get());
  return sides;
}

// ---- 3D: terrain, sky, fog and buildings (lib/render/wally/terrain.ts) ----

/** A streets source for buildings on styles without Mapbox's `composite` source. */
const STREETS_SOURCE_ID = "wally-streets";

/** The style's layers, or null while it is loading (getStyle throws before `style.load`). */
function styleLayers(map: mapboxgl.Map): { id: string; type: string }[] | null {
  try {
    return map.getStyle()?.layers ?? null;
  } catch {
    return null;
  }
}

/**
 * True when `state` wants terrain drawn: on by default, off while the user has flattened the map. A route preview
 * always has terrain, since its elevation profile reads heights from it; it goes back to the user's choice when
 * the preview ends.
 */
function wantsTerrain(state: MapState): boolean {
  return (state.terrain && !state.flattened) || state.playback !== undefined;
}

/**
 * Adds Wally's 3D dressing to the current style and switches terrain on or off. Safe to call repeatedly: a style
 * swap drops all of it, so `style.load` calls this again. Fog is only set when the style has none, so the
 * satellite hybrid's own fog (components/mapTiles.ts) wins there. Buildings go below the first label layer, which
 * keeps them above the hybrid's satellite imagery.
 */
function sync3D(map: mapboxgl.Map, terrain: boolean): void {
  // The data-only basemap (lib/render/basemaps.ts) has no buildings: the data alone draws the land.
  const buildings = !map.getLayer("data-only-land");
  if (!map.getSource(TERRAIN_SOURCE_ID) || !map.getLayer(SKY_LAYER_ID) || (buildings && !map.getLayer(BUILDINGS_LAYER_ID))) {
    // Reading the style serializes it, so only do it when something is missing.
    const layers = styleLayers(map);
    if (!layers) return;
    if (!map.getSource(TERRAIN_SOURCE_ID)) map.addSource(TERRAIN_SOURCE_ID, terrainSource());
    if (!map.getLayer(SKY_LAYER_ID)) map.addLayer(skySpec());
    if (!map.getFog()) map.setFog(fogSpec());
    if (buildings && !map.getLayer(BUILDINGS_LAYER_ID)) {
      let source = "composite";
      if (!map.getSource(source)) {
        source = STREETS_SOURCE_ID;
        if (!map.getSource(source)) map.addSource(source, { type: "vector", url: "mapbox://mapbox.mapbox-streets-v8" });
      }
      map.addLayer(buildingsSpec(source), firstSymbolLayerId(layers));
    }
  }
  if (Boolean(map.getTerrain()) !== terrain) map.setTerrain(terrain ? terrainSpec() : null);
}

/** The Mapbox layers a click can inspect: the main layer of each visible vector tile result. */
function inspectableTileLayers(map: mapboxgl.Map, state: MapState): string[] {
  const ids: string[] = [];
  for (const loaded of Object.values(state.layers)) {
    if (loaded.result.kind !== "tiles" || loaded.result.data.format !== "vector") continue;
    const id = `tiles-${loaded.id}`;
    if (map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== "none") ids.push(id);
  }
  return ids;
}

/**
 * The native data line under a screen point (lib/render/nativeLines.ts), within the pick slop, mapped back to its app
 * layer and the original feature, so the card and the selection are what a deck pick gave.
 */
function pickLine(map: mapboxgl.Map, state: MapState, point: mapboxgl.Point): Selection | null {
  const entries = drawnLineEntries(map);
  const layers = [...entries.values()]
    .filter((e) => e.shown)
    .flatMap((e) => PICKABLE_PARTS.map((part) => lineLayerId(e.id, part)))
    .filter((id) => map.getLayer(id));
  if (layers.length === 0) return null;
  const r = PICK_RADIUS_PX;
  const [top] = map.queryRenderedFeatures(
    [
      [point.x - r, point.y - r],
      [point.x + r, point.y + r],
    ],
    { layers },
  );
  if (!top) return null;
  const { lng, lat } = map.unproject(point);
  return linePickToSelection(top, entries, state.layers, [lng, lat], { x: point.x, y: point.y });
}

/**
 * What a click at a screen point selects: a deck symbol, hex tile or cluster (drawn on top), else a native data line,
 * else a deck area, else the nearest feature under a heatmap, else the top vector tile feature.
 */
function pickAt(map: mapboxgl.Map, overlay: MapboxOverlay, state: MapState, point: mapboxgl.Point, deckLayers: readonly Layer[]): Selection | null {
  let info: DeckPick | null = null;
  try {
    // Symbols and flat layers without the terrain mesh, then draped areas through it (lib/render/inspect.ts pickPasses).
    const { direct, draped } = pickPasses(deckLayers as unknown as Parameters<typeof pickPasses>[0]);
    if (direct.length > 0) info = overlay.pickObject({ x: point.x, y: point.y, radius: PICK_RADIUS_PX, layerIds: direct }) as DeckPick | null;
    if (!info && draped) info = overlay.pickObject({ x: point.x, y: point.y, radius: PICK_RADIUS_PX }) as DeckPick | null;
  } catch {
    // Deck is not initialized yet (no WebGL context); fall through to the tiles.
  }
  const fromDeck = pickToSelection(info, state.layers);
  const type = fromDeck?.feature.geometry?.type;
  if (fromDeck && (type === "Point" || type === "MultiPoint")) return fromDeck;
  // A line within the slop wins over the translucent area it crosses (deck draws areas over Mapbox's lines).
  const line = pickLine(map, state, point);
  if (line) return line;
  if (fromDeck) return fromDeck;
  // Heat is drawn by Mapbox and has no features to pick: take the nearest real feature under the cursor instead.
  const underHeat = pickUnderHeat(
    visibleState(state),
    (lngLat) => map.project(lngLat),
    { x: point.x, y: point.y },
    HEAT_PICK_RADIUS_PX,
  );
  if (underHeat) return underHeat;
  const layers = inspectableTileLayers(map, state);
  if (layers.length === 0) return null;
  const [top] = map.queryRenderedFeatures(point, { layers });
  if (!top) return null;
  const { lng, lat } = map.unproject(point);
  return pickToSelection(
    {
      feature: { id: top.id, source: top.source, layer: top.layer, geometry: top.geometry, properties: top.properties },
      lngLat: [lng, lat],
      point: { x: point.x, y: point.y },
    },
    state.layers,
  );
}

/** The screen particles move in: the map's bounds, its metres per pixel at the center, and the canvas size. */
function particleView(map: mapboxgl.Map): ParticleView | null {
  const b = map.getBounds();
  if (!b) return null;
  const canvas = map.getCanvas();
  return {
    bounds: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
    metersPerPixel: metersPerPixel(map.getZoom(), map.getCenter().lat),
    widthPx: canvas.clientWidth,
    heightPx: canvas.clientHeight,
  };
}

/** Grid points sampled over the canvas for each vector tile layer's in-view classes (lib/render/inView.ts). */
const IN_VIEW_GRID = { columns: 28, rows: 18 } as const;
let lastInViewKey = "";

/**
 * Reports what the map shows for the legends: the visible bounds, and for each drawn vector tile layer whose areas a
 * key field colors (hardiness zones, geology, public lands), that field's value at a grid of points over the canvas.
 */
function reportInView(map: mapboxgl.Map, state: MapState): void {
  const b = map.getBounds();
  const bounds: InView["bounds"] = b ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] : null;
  const tiles: Record<string, TileSample> = {};
  const canvas = map.getCanvas();
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  for (const op of state.renderOps) {
    const layer = state.layers[op.layerId];
    if (!op.visible || layer?.result.kind !== "tiles" || layer.result.data.format !== "vector") continue;
    const field = tileKeyOf(layer)?.field;
    const id = `tiles-${layer.id}`;
    if (!field || !map.getLayer(id)) continue;
    const values: string[] = [];
    for (let r = 0; r < IN_VIEW_GRID.rows; r++) {
      for (let c = 0; c < IN_VIEW_GRID.columns; c++) {
        const point: [number, number] = [((c + 0.5) * width) / IN_VIEW_GRID.columns, ((r + 0.5) * height) / IN_VIEW_GRID.rows];
        const hit = map.queryRenderedFeatures(point, { layers: [id] })[0];
        const v = hit?.properties?.[field];
        if (v !== undefined && v !== null) values.push(String(v));
      }
    }
    tiles[layer.id] = { field, values };
  }
  const key = JSON.stringify([bounds?.map((n) => n.toFixed(4)), tiles]);
  if (key === lastInViewKey) return;
  lastInViewKey = key;
  setInView({ bounds, tiles });
}

function GlobeMap({ state, onViewportChange, onPick, className, ref }: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  /** The deck layers last handed to the overlay, for the picking passes. */
  const deckLayersRef = useRef<readonly Layer[]>([]);
  /** The moving particles of flow layers (lib/render/particles.ts), drawn over the other deck layers. */
  const particleLayersRef = useRef<Layer[]>([]);
  const particlesRef = useRef(new Map<string, ParticleSystem>());
  /** Hands the overlay the data layers and the particles together. */
  const pushDeck = useCallback(() => overlayRef.current?.setProps({ layers: [...deckLayersRef.current, ...particleLayersRef.current] }), []);
  const stateRef = useRef(state);
  const onViewportChangeRef = useRef(onViewportChange);
  const onPickRef = useRef(onPick);
  const appliedBasemapRef = useRef<Basemap>(state.basemap);
  // A compare swipe's two side overlays, while one is on.
  const sidesRef = useRef<SideOverlays | null>(null);
  // The camera the map last settled on (or is easing to). A prop equal to this is our own echo.
  const lastCameraRef = useRef<Viewport>(state.viewport);
  // True while a route preview drives the camera: it neither reports every frame nor eases to viewport props.
  const followingRef = useRef(false);
  // The preview's position and settings as the animation loop sees them (see the playback effects below).
  const liveRef = useRef({ fraction: 0, playing: false, speed: 1, lastSent: -1, dirty: false });
  // The camera (and padding) from before the first of back-to-back previews, kept until a real stop eases back, and
  // the state's viewport then, so a stop can tell that something (reset map, the globe button) moved it meanwhile.
  const restoreRef = useRef<{ camera: Viewport; padding: mapboxgl.PaddingOptions; viewport: Viewport } | null>(null);
  // The route a preview is following right now (null between a cleanup and the next start).
  const activePreviewRef = useRef<string | null>(null);

  // Keep the latest props reachable from map event handlers without re-creating the map.
  useEffect(() => {
    stateRef.current = state;
    onViewportChangeRef.current = onViewportChange;
    onPickRef.current = onPick;
  });

  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => mapRef.current?.zoomIn(),
      zoomOut: () => mapRef.current?.zoomOut(),
      resetToGlobe: () => onViewportChangeRef.current(initialMapState.viewport),
      project: (lngLat) => {
        const point = mapRef.current?.project(lngLat);
        return point ? { x: point.x, y: point.y } : null;
      },
      onCameraChange: (listener) => {
        const map = mapRef.current;
        if (!map) return () => {};
        map.on("move", listener);
        map.on("resize", listener);
        return () => {
          map.off("move", listener);
          map.off("resize", listener);
        };
      },
      getView: (padding) => (mapRef.current ? viewOf(mapRef.current, padding) : null),
    }),
    [],
  );

  // Create the map and overlay once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const initial = stateRef.current;

    mapboxgl.accessToken = MAPBOX_TOKEN;
    const map = new mapboxgl.Map({
      container,
      projection: "globe",
      style: basemapStyle(initial.basemap),
      center: [initial.viewport.longitude, initial.viewport.latitude],
      zoom: initial.viewport.zoom,
      pitch: initial.viewport.pitch,
      bearing: initial.viewport.bearing,
    });
    const initialSets = safeDeckLayers(initial).main;
    deckLayersRef.current = initialSets;
    // The playback export copies deck's canvas right after each frame (lib/export/capture.ts).
    const deckRendered = new Set<() => void>();
    const overlay = new MapboxOverlay({
      interleaved: false,
      layers: initialSets,
      onAfterRender: () => deckRendered.forEach((listener) => listener()),
      layerFilter: deckLayerFilter(() => pickPasses(deckLayersRef.current as unknown as Parameters<typeof pickPasses>[0]).draped),
    });
    map.addControl(overlay);

    // The legends key what is in view: report it whenever the map comes to rest (moved, or new tiles drawn).
    map.on("idle", () => {
      if (followingRef.current) return;
      try {
        reportInView(map, stateRef.current);
      } catch {
        // A style mid-swap has no layers to query; the next idle reports.
      }
    });
    map.on("moveend", () => {
      if (followingRef.current) return;
      const camera = cameraOf(map);
      lastCameraRef.current = camera;
      onViewportChangeRef.current(camera);
    });
    // A style swap drops every source, so re-add the imagery and tile layers whenever a style finishes loading.
    map.on("style.load", () => {
      syncSatelliteHybrid(map, stateRef.current.basemap);
      // After the hybrid, so its fog is already set and its imagery sits below the buildings.
      sync3D(map, wantsTerrain(stateRef.current));
      syncTileLayers(map, tileView(stateRef.current));
      syncHeatLayers(map, visibleState(stateRef.current));
      syncLineLayers(map, visibleState(stateRef.current));
      // A style swap dropped the line sources and their feature state: a series sets its frame again.
      resetSeriesLines(map);
      animateSeriesLines(map, drawnLineEntries(map).values(), visibleState(stateRef.current), playheadStore.get());
      ensureRouteImages(map);
      syncRouteLayers(map, stateRef.current);
    });

    // Tile layers: count each template's loaded and failed tiles, so a dated layer with no image for the scrubber's
    // date says so (lib/render/tileErrors.ts). With this listener Mapbox no longer logs errors itself, so every
    // other error is logged here, and a tile 404 is not logged once per tile.
    const tileTemplate = (sourceId: unknown): string | undefined => {
      if (typeof sourceId !== "string" || !sourceId.startsWith("tiles-")) return undefined;
      return (map.getSource(sourceId) as { tiles?: string[] } | undefined)?.tiles?.[0];
    };
    map.on("error", (e: { error?: unknown; sourceId?: unknown; tile?: unknown }) => {
      const template = e.tile ? tileTemplate(e.sourceId) : undefined;
      if (template) noteTile(template, false);
      else console.error(e.error ?? e);
    });
    map.on("sourcedata", (e: { sourceId?: unknown; tile?: unknown }) => {
      if (!e.tile) return;
      const template = tileTemplate(e.sourceId);
      if (template) noteTile(template, true);
    });

    // Click to inspect: deck features first (they draw on top), then vector tiles; empty map deselects.
    let identifyAbort: AbortController | undefined;
    map.on("click", (e) => {
      const hit = pickAt(map, overlay, stateRef.current, e.point, deckLayersRef.current);
      // A cluster blob is a group, not a feature: zoom one level in toward it so it splits (the one camera move a
      // click makes, because the user clicked a group; clicking a feature never moves the camera).
      if (hit && isClusterFeature(hit.feature)) {
        // Not while a route preview drives the camera: its per-frame jumpTo would fight the ease.
        if (followingRef.current) return;
        map.easeTo({
          center: hit.feature.geometry.coordinates as [number, number],
          zoom: Math.min(map.getMaxZoom(), map.getZoom() + CLUSTER_ZOOM_STEP),
          duration: CLUSTER_EASE_MS,
        });
        return;
      }
      onPickRef.current?.(hit);
      // Nothing to pick: a raster layer that can identify asks its source what is drawn here (lib/render/identify.ts).
      identifyAbort?.abort();
      if (hit) return;
      const state = stateRef.current;
      const { lng, lat } = map.unproject(e.point);
      const requests = identifyRequests(state, visibleState(state).layers, [lng, lat], map.getZoom());
      if (requests.length === 0) return;
      const abort = new AbortController();
      identifyAbort = abort;
      void identifyAt(requests, { x: e.point.x, y: e.point.y }, abort.signal).then((found) => {
        if (found && !abort.signal.aborted && identifyAbort === abort) onPickRef.current?.(found);
      });
    });
    // A pointer cursor over anything inspectable, checked at most once per frame.
    let hoverFrame = 0;
    map.on("mousemove", (e) => {
      if (hoverFrame) return;
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0;
        const hit = pickAt(map, overlay, stateRef.current, e.point, deckLayersRef.current) !== null;
        map.getCanvas().style.cursor = hit ? "pointer" : "";
      });
    });

    mapRef.current = map;
    overlayRef.current = overlay;
    captureStore.set({
      mapCanvas: () => map.getCanvas(),
      deckCanvas: () => overlay.getCanvas?.() ?? null,
      onMapRender: (listener) => {
        map.on("render", listener);
        return () => map.off("render", listener);
      },
      onDeckRender: (listener) => {
        deckRendered.add(listener);
        return () => deckRendered.delete(listener);
      },
      // Deck draws only when something changed, so a capture asks it to draw too (`redraw` with a reason forces it).
      repaint: () => {
        map.triggerRepaint();
        (overlay as unknown as { _deck?: { redraw: (reason?: string) => void } })._deck?.redraw("capture");
      },
    });
    // Development only: the eval's screen checks (scripts/evalScreens.ts) project features and read the deck labels.
    if (process.env.NODE_ENV === "development") (window as unknown as { __wallyMap?: unknown }).__wallyMap = { map, overlay };
    appliedBasemapRef.current = initial.basemap;
    lastCameraRef.current = initial.viewport;

    return () => {
      captureStore.set(null);
      cancelAnimationFrame(hoverFrame);
      sidesRef.current = syncSideOverlays(map, sidesRef.current, { main: [], a: [], b: [] });
      map.removeControl(overlay);
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, []);

  // Deck layers, tile layers, Mapbox heatmaps and native data lines follow every state change, through the visible view (time window
  // and filters). Routes are not filtered. A tile URL the time window rewrote waits 150 ms, so playing or dragging
  // the scrubber does not re-request tiles for every step it passes.
  const tileTimerRef = useRef<number | null>(null);
  const appliedTilesKeyRef = useRef("");
  useEffect(() => {
    const view = visibleState(state);
    const sets = safeDeckLayers(state);
    deckLayersRef.current = sets.main;
    pushDeck();
    const map = mapRef.current;
    if (!map) return;
    sidesRef.current = syncSideOverlays(map, sidesRef.current, sets);
    const key = tileUrlsKey(view);
    if (key === appliedTilesKeyRef.current && tileTimerRef.current === null) {
      syncTileLayers(map, tileView(state));
    } else {
      if (tileTimerRef.current !== null) window.clearTimeout(tileTimerRef.current);
      tileTimerRef.current = window.setTimeout(() => {
        tileTimerRef.current = null;
        if (mapRef.current !== map) return;
        const latest = visibleState(stateRef.current);
        appliedTilesKeyRef.current = tileUrlsKey(latest);
        syncTileLayers(map, tileView(stateRef.current));
      }, TILE_TIME_DEBOUNCE_MS);
    }
    syncHeatLayers(map, view);
    syncLineLayers(map, view);
    animateSeriesLines(map, drawnLineEntries(map).values(), view, playheadStore.get());
    syncRouteLayers(map, state);
  }, [state, pushDeck]);

  // A dated tile layer's image turning up missing points it back at its loaded image (lib/render/tileErrors.ts).
  useEffect(
    () =>
      missingTilesStore.subscribe(() => {
        const map = mapRef.current;
        if (map) syncTileLayers(map, tileView(stateRef.current));
      }),
    [],
  );

  // Flow layers (ocean currents, wind) animate their particles every animation frame while one is shown, outside React;
  // a hidden tab pauses them (requestAnimationFrame does not run there, and a hidden page skips the work).
  const flowing = flowLayersOf(state).length > 0;
  useEffect(() => {
    if (!flowing) {
      particlesRef.current.clear();
      if (particleLayersRef.current.length > 0) {
        particleLayersRef.current = [];
        pushDeck();
      }
      return;
    }
    let raf = 0;
    let fieldKey = "";
    let fields = new Map<string, FieldSnapshot | null>();
    const frames: number[] = [];
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const map = mapRef.current;
      if (!map || document.hidden) return;
      const view = particleView(map);
      if (!view) return;
      const current = visibleState(stateRef.current);
      const flows = flowLayersOf(current);
      const at = playheadStore.get();
      // The field changes only when the playhead or the data does: rebuild it then, not every frame.
      const key = `${flows.map((f) => f.layer.id).join(",")}|${Math.round(at * 50) / 50}`;
      if (key !== fieldKey) {
        fieldKey = key;
        const next = new Map<string, FieldSnapshot | null>();
        for (const { layer } of flows) next.set(layer.id, fieldAt(layer, flowFrame(layer, current, at)));
        fields = next;
      }
      const layers: Layer[] = [];
      let stepMs = 0;
      let count = 0;
      for (const { layer, opacity } of flows) {
        const field = fields.get(layer.id);
        if (!field) continue;
        let system = particlesRef.current.get(layer.id);
        if (!system) {
          system = new ParticleSystem();
          particlesRef.current.set(layer.id, system);
        }
        count += system.step(field, view);
        stepMs += system.lastStepMs;
        layers.push(system.layer(`${layer.id}:particles`, opacity));
      }
      for (const id of particlesRef.current.keys()) if (!flows.some((f) => f.layer.id === id)) particlesRef.current.delete(id);
      particleLayersRef.current = layers;
      pushDeck();
      frames.push(now);
      while (frames.length > 0 && now - frames[0] > 2000) frames.shift();
      // Development only: the story checks read the particle count, step time and frame rate.
      if (process.env.NODE_ENV === "development") {
        const first = particlesRef.current.values().next().value;
        (window as unknown as { __wallyParticles?: unknown }).__wallyParticles = {
          count,
          stepMs: Math.round(stepMs * 100) / 100,
          fps: Math.round(((frames.length - 1) * 1000) / Math.max(1, now - frames[0])),
          sample: first ? Array.from(first.target.slice(0, 40)) : [],
        };
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [flowing, pushDeck]);

  // A series layer's lines glide with the playhead between frames (lib/render/seriesLines.ts), outside React.
  useEffect(
    () =>
      playheadStore.subscribe(() => {
        const map = mapRef.current;
        if (map) animateSeriesLines(map, drawnLineEntries(map).values(), visibleState(stateRef.current), playheadStore.get());
      }),
    [],
  );
  useEffect(
    () => () => {
      if (tileTimerRef.current !== null) window.clearTimeout(tileTimerRef.current);
    },
    [],
  );

  // The swipe handle moves the clip without a React render.
  useEffect(() => swipeStore.subscribe(() => clipSides(sidesRef.current, swipeStore.get())), []);

  // The preview control reads the map state from here (components/App.tsx does not pass it to the chat rail).
  useEffect(() => {
    mapStateStore.set(state);
  }, [state]);
  useEffect(() => () => mapStateStore.set(null), []);

  // Ease to a new viewport when it differs from both the actual camera and our own last report.
  useEffect(() => {
    const map = mapRef.current;
    const target = state.viewport;
    if (!map || followingRef.current) return;
    if (sameViewport(target, cameraOf(map))) {
      lastCameraRef.current = target;
      return;
    }
    // The prop is the echo of a camera we already reported (e.g. an ease that was interrupted
    // mid-flight); easing back to it would fight the newer move.
    if (sameViewport(target, lastCameraRef.current)) return;
    const pitchOnly = sameViewport({ ...target, pitch: lastCameraRef.current.pitch }, lastCameraRef.current);
    lastCameraRef.current = target;
    // A pitch-only change (the 3D button) tilts in place with Wally's short ease.
    if (pitchOnly) {
      map.easeTo({ zoom: map.getZoom(), pitch: target.pitch, duration: PITCH_EASE_MS, easing: easeInOut });
      return;
    }
    map.easeTo({
      center: [target.longitude, target.latitude],
      zoom: target.zoom,
      pitch: target.pitch,
      bearing: target.bearing,
      duration: VIEWPORT_EASE_MS,
    });
  }, [state.viewport]);

  // Swap the basemap style; tile layers come back via the `style.load` handler. `diff: false` forces a
  // full rebuild: the default diff path silently drops our raster sources and never fires `style.load`.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || appliedBasemapRef.current === state.basemap) return;
    const previous = appliedBasemapRef.current;
    appliedBasemapRef.current = state.basemap;
    // Outdoors and its satellite hybrid share one style, so toggle the imagery in place instead of reloading.
    if (basemapStyleUrl(previous) === basemapStyleUrl(state.basemap)) {
      syncSatelliteHybrid(map, state.basemap);
      return;
    }
    // The cast is a typing quirk: SetStyleOptions marks the font fields required, but mapbox fills them
    // from the map's own settings, and passing them explicitly as undefined would override those.
    map.setStyle(basemapStyle(state.basemap), { diff: false } as Parameters<mapboxgl.Map["setStyle"]>[1]);
  }, [state.basemap]);

  // Terrain follows the 3D button and the agent's `terrain`; a basemap change re-adds it once the new style loads.
  const terrain = wantsTerrain(state);
  useEffect(() => {
    if (mapRef.current) sync3D(mapRef.current, terrain);
  }, [terrain]);

  // ---- Route preview: the loop reads these refs, so play, pause, speed and scrub never restart it. ----
  const playback = state.playback;
  useEffect(() => {
    if (!playback) return;
    const live = liveRef.current;
    live.playing = playback.playing;
    live.speed = playback.speed;
    // A fraction the loop did not send itself is a scrub (or a restart from the end): jump there.
    if (Math.abs(playback.fraction - live.lastSent) > 1e-9) {
      live.fraction = playback.fraction;
      live.lastSent = playback.fraction;
      live.dirty = true;
    }
  }, [playback]);

  // Start and stop: ease out to the route overview (its terrain loads and the profile reads heights there), dive
  // into the chase camera, then follow every animation frame. At the finish the camera holds, then rises back to the
  // overview; playing or scrubbing from there dives in again. Stopping (exit, route removed, basemap swap, tab
  // hidden) rises back to the camera from before the preview, at its pitch.
  const playbackRouteId = playback?.routeId;
  useEffect(() => {
    const map = mapRef.current;
    const routeId = playbackRouteId;
    const route = routeId ? stateRef.current.routes[routeId] : undefined;
    if (!map || !routeId || !route) return;
    const line = route.line;
    const live = liveRef.current;
    // Switching straight to another preview keeps the camera from before the first one.
    restoreRef.current ??= { camera: cameraOf(map), padding: map.getPadding(), viewport: stateRef.current.viewport };
    activePreviewRef.current = routeId;
    followingRef.current = true;
    // Keep the followed point out from under the preview dock, the chat panel or sheet, and the data console while it
    // is open. On a phone where not even 80px fit above the dock, the dock drops its profile (a 56px strip) and the
    // padding is worked out again. (On a phone the app closes the console for the preview: components/App.tsx.)
    let repad = false;
    const paddingNow = () => {
      const box = map.getContainer().getBoundingClientRect();
      const chat = document.querySelector<HTMLElement>('section[aria-label="Chat"]');
      const dock = document.querySelector<HTMLElement>('[data-testid="preview-control"]');
      const dataConsole = document.querySelector<HTMLElement>('[data-testid="layer-stack"]');
      const base = visibleMapPadding({
        width: box.width,
        height: box.height,
        panelOpen: chat?.dataset.chatOpen === "true",
        isMobile: box.width < 768,
      });
      const rects = [chat, dock, dataConsole].flatMap((el) => {
        if (!el) return [];
        const r = el.getBoundingClientRect();
        return [{ left: r.left - box.left, top: r.top - box.top, right: r.right - box.left, bottom: r.bottom - box.top }];
      });
      const { padding: next, fits } = followPadding(base, box, rects);
      if (!fits && dock && box.width < 768 && !dockCompactStore.get()) {
        dockCompactStore.set(true);
        repad = true;
      }
      return next;
    };
    // The clear map (the overview frames the route in it), and the same with the followed point moved down into its
    // lower third for the chase camera (its bottom edge, against the dock, does not move).
    let padding = paddingNow();
    const heightPx = () => map.getCanvas().clientHeight;
    let chasePad = chasePadding(padding, heightPx());
    let cancelled = false;
    let raf = 0;
    const timers: number[] = [];

    const { points } = samplePoints(line);
    const heights: (number | null)[] = points.map(() => null);
    let complete = false;
    const readHeights = () => {
      let changed = false;
      for (let i = 0; i < points.length; i++) {
        if (heights[i] !== null) continue;
        const h = map.queryTerrainElevation(points[i], { exaggerated: false });
        if (typeof h === "number" && Number.isFinite(h)) {
          heights[i] = h;
          changed = true;
        }
      }
      if (changed) elevationStore.set({ routeId, values: [...heights] });
      complete = heights.every((h) => h !== null);
    };
    elevationStore.set({ routeId, values: [...heights] });
    liveFractionStore.set({ routeId, fraction: live.fraction });
    setRouteProgress(map, routeId, live.fraction);

    // Chase pitch (lower with 3D off) and the zoom that shows 300–600 m of trail ahead.
    const pitchNow = () => chasePitch(stateRef.current.flattened);
    const zoomAt = (kmPerMin: number, center: [number, number]) => chaseZoom(kmPerMin, pitchNow(), center[1], heightPx());
    let bearing = bearingAt(line, live.fraction, bearingLookAheadM(speedKmPerMin(live.speed)));
    let pitch = pitchNow();
    let zoom = zoomAt(speedKmPerMin(live.speed), positionAt(line, live.fraction));
    // Zoom levels the camera has moved in by on steep ground (see chaseFit), on top of `zoom`.
    let closer = 0;
    // The chase pitch, unless steep ground behind the point would hide it or put the eye within 40 m of the ground:
    // then a lower pitch (to 50°), then a closer camera (see chaseFit in lib/render/wally/playback.ts).
    const fitAt = (center: [number, number], heading: number, zoomNow: number) => {
      const maxPitch = pitchNow();
      const ground = map.queryTerrainElevation(center, { exaggerated: true });
      if (typeof ground !== "number") return { pitch: maxPitch, scale: 1 };
      const distance = cameraDistanceMeters(zoomNow, center[1], heightPx());
      return chaseFit(
        distance,
        (behindM) => {
          const h = map.queryTerrainElevation(offsetPoint(center, heading + 180, behindM), { exaggerated: true });
          return typeof h === "number" ? h - ground : null;
        },
        maxPitch,
      );
    };
    // The stricter of the fit here and 1 s of travel further on with the heading the camera is turning to, so it is
    // up before a wall arrives or swings in behind it.
    const totalM = lengthMeters(line);
    const fitAhead = (fraction: number, heading: number, turningTo: number, zoomNow: number, kmPerMin: number) => {
      const here = fitAt(positionAt(line, fraction), heading, zoomNow);
      const soon = totalM > 0 ? Math.min(1, fraction + (kmPerMin * 1000) / 60 / totalM) : fraction;
      const next = fitAt(positionAt(line, soon), turningTo, zoomNow);
      return { pitch: Math.min(here.pitch, next.pitch), scale: Math.min(here.scale, next.scale) };
    };
    // Terrain checks run ten times a second while playing (the pitch and distance ease in between).
    let fitted = { at: -Infinity, pitch, scale: 1 };

    // The whole route in the clear part of the map with up to 40px to spare, tilted like an arrival (flat with 3D
    // off); the same padding sets the zoom and the ease, so the route lands where the zoom was worked out for.
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const [x, y] of line.coordinates) {
      west = Math.min(west, x);
      south = Math.min(south, y);
      east = Math.max(east, x);
      north = Math.max(north, y);
    }
    const overviewCamera = () => {
      const box = map.getContainer().getBoundingClientRect();
      const spare = Math.max(
        0,
        Math.min(
          40,
          Math.floor((box.width - padding.left - padding.right - 40) / 2),
          Math.floor((box.height - padding.top - padding.bottom - 40) / 2),
        ),
      );
      const framed = {
        top: padding.top + spare,
        right: padding.right + spare,
        bottom: padding.bottom + spare,
        left: padding.left + spare,
      };
      const fit = map.cameraForBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding: framed, bearing: 0, pitch: 0, maxZoom: 15 },
      );
      if (fit?.zoom === undefined) return null;
      const tilt = stateRef.current.flattened ? 0 : pitchFor("explore");
      return {
        center: [(west + east) / 2, (south + north) / 2] as [number, number],
        zoom: fit.zoom - fitZoomOffset(tilt),
        bearing: 0,
        pitch: tilt,
        padding: framed,
      };
    };

    // intro (out to the overview) → dive → chase → (at the finish) outro (back up at the overview) → dive → ...
    let mode: "intro" | "dive" | "chase" | "outro" = "intro";
    let last = 0;
    let lastReadAt = 0;
    let lastPaddedAt = 0;
    let shownFraction = -1;
    // The position this loop last published; a different value in the store is a scrub from the dock.
    let published = live.fraction;

    // Down from wherever the camera is into the chase camera at the current position, over 1.2 s.
    const dive = () => {
      if (cancelled) return;
      mode = "dive";
      readHeights();
      const kmPerMin = speedKmPerMin(live.speed);
      const center = positionAt(line, live.fraction);
      bearing = bearingAt(line, live.fraction, bearingLookAheadM(kmPerMin));
      padding = paddingNow();
      chasePad = chasePadding(padding, heightPx());
      zoom = zoomAt(kmPerMin, center);
      const fit = fitAhead(live.fraction, bearing, bearing, zoom, kmPerMin);
      pitch = fit.pitch;
      closer = Math.log2(1 / fit.scale);
      map.easeTo({
        center,
        bearing,
        pitch,
        zoom: zoom + closer,
        padding: chasePad,
        duration: PREVIEW_DIVE_MS,
        easing: easeInOut,
      });
      timers.push(
        window.setTimeout(() => {
          if (cancelled || mode !== "dive") return;
          mode = "chase";
          last = 0;
          live.dirty = true;
        }, PREVIEW_DIVE_MS + 20),
      );
    };
    // Back up to the overview once the ride has finished (and is still sitting at the finish).
    const rise = () => {
      if (cancelled || mode !== "chase" || live.playing || live.fraction < 1) return;
      const overview = overviewCamera();
      if (!overview) return;
      mode = "outro";
      map.easeTo({ ...overview, duration: PREVIEW_RISE_MS, easing: easeInOut });
    };

    const frame = (now: number) => {
      if (cancelled) return;
      raf = requestAnimationFrame(frame);
      const dt = last ? Math.min(100, now - last) : 16;
      last = now;
      const kmPerMin = speedKmPerMin(live.speed);
      let moved = live.dirty;
      live.dirty = false;
      const outside = liveFractionStore.get();
      if (outside?.routeId === routeId && outside.fraction !== published) {
        live.fraction = outside.fraction;
        moved = true;
      }
      // Heights the overview missed (tiles that had not loaded) fill in as the camera passes.
      if (!complete && now - lastReadAt > 500) {
        lastReadAt = now;
        readHeights();
      }
      // The intro and the dive own the camera; a scrub meanwhile is picked up once the chase starts.
      if (mode === "intro" || mode === "dive") {
        if (moved) live.dirty = true;
        return;
      }
      // Up at the overview after the finish: playing again (from the start) or scrubbing dives back in.
      if (mode === "outro") {
        if (moved || (live.playing && live.fraction < 1)) dive();
        return;
      }
      if (repad || now - lastPaddedAt > 500) {
        repad = false;
        lastPaddedAt = now;
        padding = paddingNow();
        chasePad = chasePadding(padding, heightPx());
      }
      const wasPlaying = live.playing;
      if (live.playing && live.fraction < 1) {
        live.fraction = Math.min(1, live.fraction + fractionStep(line, kmPerMin, dt));
        moved = true;
      }
      if (moved) {
        const center = positionAt(line, live.fraction);
        // Heading-up from a ~3 s look-ahead, eased and held to 45°/s so switchbacks do not whip the camera; a
        // scrub turns at once.
        const target = bearingAt(line, live.fraction, bearingLookAheadM(kmPerMin));
        bearing = live.playing ? smoothBearing(bearing, target, dt) : target;
        // The zoom eases too, so a speed change or the 3D button does not jump the camera.
        const wantedZoom = zoomAt(kmPerMin, center);
        zoom = live.playing ? zoom + (wantedZoom - zoom) * Math.min(1, dt / 600) : wantedZoom;
        // On steep ground tilt up and move in fast, settle back slowly.
        // The terrain fit samples up to a few hundred heights, so it runs at most every 100 ms playing and 50 ms while
        // scrubbing; a scrub frame that skips it comes back next frame, so the camera always ends on a fresh fit.
        if (now - fitted.at > (live.playing ? 100 : 50)) fitted = { at: now, ...fitAhead(live.fraction, bearing, target, zoom, kmPerMin) };
        else if (!live.playing) live.dirty = true;
        const fit = fitted;
        const wantedCloser = Math.log2(1 / fit.scale);
        if (live.playing) {
          pitch += (fit.pitch - pitch) * Math.min(1, dt / (fit.pitch < pitch ? 150 : 600));
          closer += (wantedCloser - closer) * Math.min(1, dt / (wantedCloser > closer ? 150 : 800));
        } else {
          pitch = fit.pitch;
          closer = wantedCloser;
        }
        map.jumpTo({ center, bearing, pitch, zoom: zoom + closer, padding: chasePad });
        published = live.fraction;
        liveFractionStore.set({ routeId, fraction: live.fraction });
        const shown = Math.round(live.fraction * 2000) / 2000;
        if (shown !== shownFraction) {
          shownFraction = shown;
          setRouteProgress(map, routeId, live.fraction);
        }
        // The reducer only hears about the end (which pauses there); pause and scrub send their own position,
        // so playing does not re-render the app every frame. A ride that played to the finish then rises out.
        if (live.fraction >= 1 && live.lastSent !== 1) {
          live.lastSent = 1;
          dispatchPreview({ type: "preview_tick", fraction: 1 });
          if (wasPlaying) timers.push(window.setTimeout(rise, OUTRO_HOLD_MS));
        }
      }
    };

    // Overview first, held at least briefly and until its tiles load (at most 1.8 s), then the dive.
    const introStart = performance.now();
    let started = false;
    const startFollowing = () => {
      if (started || cancelled) return;
      const wait = PREVIEW_OVERVIEW_MS + 250 - (performance.now() - introStart);
      if (wait > 0) {
        timers.push(window.setTimeout(startFollowing, wait));
        return;
      }
      started = true;
      dive();
    };
    map.once("idle", startFollowing);
    timers.push(window.setTimeout(startFollowing, 1800));
    const overview = overviewCamera();
    if (overview) map.easeTo({ ...overview, duration: PREVIEW_OVERVIEW_MS, easing: easeInOut });
    else startFollowing();
    raf = requestAnimationFrame(frame);

    // Grabbing the map pauses the ride so the user can look around.
    const onDragStart = () => {
      if (live.playing) {
        live.playing = false;
        live.lastSent = live.fraction;
        dispatchPreview({ type: "preview_tick", fraction: live.fraction }, { type: "preview_toggle" });
      }
    };
    map.on("dragstart", onDragStart);
    const onVisibility = () => {
      if (document.hidden) dispatchPreview({ type: "preview_stop" });
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      timers.forEach((t) => window.clearTimeout(t));
      document.removeEventListener("visibilitychange", onVisibility);
      map.off("dragstart", onDragStart);
      map.off("idle", startFollowing);
      liveFractionStore.set(null);
      elevationStore.set(null);
      live.lastSent = -1;
      followingRef.current = false;
      activePreviewRef.current = null;
      if (mapRef.current !== map) return; // unmounted: the map is gone
      setRouteProgress(map, routeId, null);
      // After this commit's effects: a preview that started in the same commit is a switch, not a stop.
      queueMicrotask(() => {
        if (mapRef.current !== map) return;
        const next = activePreviewRef.current;
        // A route made from a clicked feature exists only for its preview.
        if (route.source === "feature" && next !== routeId) dispatchPreview({ type: "route_removed", routeId });
        if (next) return;
        const restore = restoreRef.current;
        restoreRef.current = null;
        dockCompactStore.set(false);
        if (!restore) return;
        // Never leave the camera in the chase: rise back to the camera the preview began from, tilt included (a map
        // flattened meanwhile comes back flat). A viewport set during the preview (reset map ends the preview and
        // moves the viewport in one commit) wins instead: this runs after the viewport effect's ease, so it eases
        // there itself, with the preview's padding undone.
        const exit = previewExitCamera(restore, stateRef.current.viewport, stateRef.current.flattened);
        if (exit.reset) lastCameraRef.current = exit.camera;
        // Interrupting the viewport effect's ease fires `moveend` at once; that half-way camera is not a report.
        followingRef.current = true;
        map.easeTo({
          center: [exit.camera.longitude, exit.camera.latitude],
          zoom: exit.camera.zoom,
          bearing: exit.camera.bearing,
          pitch: exit.camera.pitch,
          padding: restore.padding,
          duration: exit.reset ? VIEWPORT_EASE_MS : PREVIEW_RISE_MS,
          easing: easeInOut,
        });
        followingRef.current = false;
      });
    };
  }, [playbackRouteId]);

  return <div ref={containerRef} data-testid="map-canvas" className={className ?? "h-full w-full"} />;
}
