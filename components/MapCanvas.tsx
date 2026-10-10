"use client";

import type { Layer } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import mapboxgl from "mapbox-gl";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { MapSetupNotice } from "@/components/MapSetupNotice";
import { syncHeatLayers, syncSatelliteHybrid, syncTileLayers } from "@/components/mapTiles";
import { ensureRouteImages, setRouteProgress, syncRouteLayers } from "@/components/routeLayers";
import { basemapStyleUrl } from "@/lib/render/basemaps";
import { swipeStore } from "@/lib/render/compareView";
import { buildDeckLayerSets, type Padding } from "@/lib/render/deck";
import { pickToSelection, type DeckPick } from "@/lib/render/inspect";
import { viewFromCamera, type MapView } from "@/lib/agent/view";
import { initialMapState, type Basemap, type MapState, type Selection, type Viewport } from "@/lib/render/state";
import { visibleState } from "@/lib/render/view";
import {
  bearingAt,
  cameraDistanceMeters,
  clearPitch,
  DEFAULT_LOOKAHEAD_M,
  dispatchPreview,
  dockCompactStore,
  elevationStore,
  FOLLOW_PITCH,
  followZoom,
  followPadding,
  fractionStep,
  liveFractionStore,
  mapStateStore,
  offsetPoint,
  positionAt,
  PREVIEW_EASE_MS,
  speedKmPerMin,
  turnBetween,
} from "@/lib/render/wally/playback";
import { visibleMapPadding } from "@/lib/render/viewportPadding";
import { samplePoints } from "@/lib/render/wally/sample";
import {
  BUILDINGS_LAYER_ID,
  buildingsSpec,
  easeInOut,
  firstSymbolLayerId,
  fogSpec,
  PITCH_EASE_MS,
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

/** Every tile layer's URL, so a time step that rewrites one can be told apart from other state changes. */
function tileUrlsKey(view: MapState): string {
  return Object.values(view.layers)
    .map((l) => (l.result.kind === "tiles" ? `${l.id}=${l.result.data.url}` : ""))
    .join("|");
}

type DeckLayerSets = { main: Layer[]; a: Layer[]; b: Layer[] };

/** An unsupported render mode must not crash the canvas, so failures render no deck layers. */
function safeDeckLayers(state: MapState): DeckLayerSets {
  try {
    // The visible view: features outside the time window (and filtered out in the layer panel) are not drawn.
    return buildDeckLayerSets(visibleState(state));
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
      a: new MapboxOverlay({ interleaved: false, layers: sets.a, onLoad: clipWhenLoaded }),
      b: new MapboxOverlay({ interleaved: false, layers: sets.b, onLoad: clipWhenLoaded }),
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
  if (!map.getSource(TERRAIN_SOURCE_ID) || !map.getLayer(SKY_LAYER_ID) || !map.getLayer(BUILDINGS_LAYER_ID)) {
    // Reading the style serializes it, so only do it when something is missing.
    const layers = styleLayers(map);
    if (!layers) return;
    if (!map.getSource(TERRAIN_SOURCE_ID)) map.addSource(TERRAIN_SOURCE_ID, terrainSource());
    if (!map.getLayer(SKY_LAYER_ID)) map.addLayer(skySpec());
    if (!map.getFog()) map.setFog(fogSpec());
    if (!map.getLayer(BUILDINGS_LAYER_ID)) {
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

/** The deck feature under a screen point, then the top vector tile feature, as a selection. */
function pickAt(map: mapboxgl.Map, overlay: MapboxOverlay, state: MapState, point: mapboxgl.Point): Selection | null {
  let info: DeckPick | null = null;
  try {
    info = overlay.pickObject({ x: point.x, y: point.y, radius: PICK_RADIUS_PX }) as DeckPick | null;
  } catch {
    // Deck is not initialized yet (no WebGL context); fall through to the tiles.
  }
  const fromDeck = pickToSelection(info, state.layers);
  if (fromDeck) return fromDeck;
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

function GlobeMap({ state, onViewportChange, onPick, className, ref }: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
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
  // The camera (and padding) from before the first of back-to-back previews, kept until a real stop eases back.
  const restoreRef = useRef<{ camera: Viewport; padding: mapboxgl.PaddingOptions } | null>(null);
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
      style: basemapStyleUrl(initial.basemap),
      center: [initial.viewport.longitude, initial.viewport.latitude],
      zoom: initial.viewport.zoom,
      pitch: initial.viewport.pitch,
      bearing: initial.viewport.bearing,
    });
    const overlay = new MapboxOverlay({ interleaved: false, layers: safeDeckLayers(initial).main });
    map.addControl(overlay);

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
      syncTileLayers(map, visibleState(stateRef.current));
      syncHeatLayers(map, visibleState(stateRef.current));
      ensureRouteImages(map);
      syncRouteLayers(map, stateRef.current);
    });

    // Click to inspect: deck features first (they draw on top), then vector tiles; empty map deselects.
    map.on("click", (e) => {
      onPickRef.current?.(pickAt(map, overlay, stateRef.current, e.point));
    });
    // A pointer cursor over anything inspectable, checked at most once per frame.
    let hoverFrame = 0;
    map.on("mousemove", (e) => {
      if (hoverFrame) return;
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0;
        const hit = pickAt(map, overlay, stateRef.current, e.point) !== null;
        map.getCanvas().style.cursor = hit ? "pointer" : "";
      });
    });

    mapRef.current = map;
    overlayRef.current = overlay;
    appliedBasemapRef.current = initial.basemap;
    lastCameraRef.current = initial.viewport;

    return () => {
      cancelAnimationFrame(hoverFrame);
      sidesRef.current = syncSideOverlays(map, sidesRef.current, { main: [], a: [], b: [] });
      map.removeControl(overlay);
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, []);

  // Deck layers, tile layers and Mapbox heatmaps follow every state change, through the visible view (time window
  // and filters). Routes are not filtered. A tile URL the time window rewrote waits 150 ms, so playing or dragging
  // the scrubber does not re-request tiles for every step it passes.
  const tileTimerRef = useRef<number | null>(null);
  const appliedTilesKeyRef = useRef("");
  useEffect(() => {
    const view = visibleState(state);
    const sets = safeDeckLayers(state);
    overlayRef.current?.setProps({ layers: sets.main });
    const map = mapRef.current;
    if (!map) return;
    sidesRef.current = syncSideOverlays(map, sidesRef.current, sets);
    const key = tileUrlsKey(view);
    if (key === appliedTilesKeyRef.current && tileTimerRef.current === null) {
      syncTileLayers(map, view);
    } else {
      if (tileTimerRef.current !== null) window.clearTimeout(tileTimerRef.current);
      tileTimerRef.current = window.setTimeout(() => {
        tileTimerRef.current = null;
        if (mapRef.current !== map) return;
        const latest = visibleState(stateRef.current);
        appliedTilesKeyRef.current = tileUrlsKey(latest);
        syncTileLayers(map, latest);
      }, TILE_TIME_DEBOUNCE_MS);
    }
    syncHeatLayers(map, view);
    syncRouteLayers(map, state);
  }, [state]);
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
      duration: 800,
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
    map.setStyle(basemapStyleUrl(state.basemap), { diff: false } as Parameters<mapboxgl.Map["setStyle"]>[1]);
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

  // Start and stop: frame the route so its terrain loads, read the profile heights, ease down into the follow
  // camera, then follow every animation frame. Stopping (exit, route removed, basemap swap, tab hidden) eases
  // back to the camera from before the preview, at its pitch.
  const playbackRouteId = playback?.routeId;
  useEffect(() => {
    const map = mapRef.current;
    const routeId = playbackRouteId;
    const route = routeId ? stateRef.current.routes[routeId] : undefined;
    if (!map || !routeId || !route) return;
    const line = route.line;
    const live = liveRef.current;
    // Switching straight to another preview keeps the camera from before the first one.
    restoreRef.current ??= { camera: cameraOf(map), padding: map.getPadding() };
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
    let padding = paddingNow();
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

    const lookAhead = (kmPerMin: number) => Math.max(DEFAULT_LOOKAHEAD_M, (kmPerMin * 1000) / 60);
    let bearing = bearingAt(line, live.fraction, lookAhead(speedKmPerMin(live.speed)));
    let pitch: number = FOLLOW_PITCH;
    // Follow pitch unless a ridge behind the position would hide it from the camera: then tilt up just enough.
    const clearPitchAt = (center: [number, number], heading: number, zoom: number) => {
      const ground = map.queryTerrainElevation(center, { exaggerated: true });
      if (typeof ground !== "number") return FOLLOW_PITCH;
      const distance = cameraDistanceMeters(zoom, center[1], map.getCanvas().clientHeight);
      const rises = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => {
        const behindM = (distance * k) / 8;
        const h = map.queryTerrainElevation(offsetPoint(center, heading + 180, behindM), { exaggerated: true });
        return { behindM, rise: typeof h === "number" ? h - ground : null };
      });
      return clearPitch(distance, rises);
    };
    let last = 0;
    let lastReadAt = 0;
    let lastPaddedAt = 0;
    let shownFraction = -1;
    // The position this loop last published; a different value in the store is a scrub from the dock.
    let published = live.fraction;
    const frame = (now: number) => {
      if (cancelled) return;
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
      if (repad || now - lastPaddedAt > 500) {
        repad = false;
        lastPaddedAt = now;
        padding = paddingNow();
      }
      if (live.playing && live.fraction < 1) {
        live.fraction = Math.min(1, live.fraction + fractionStep(line, kmPerMin, dt));
        moved = true;
      }
      if (moved) {
        const target = bearingAt(line, live.fraction, lookAhead(kmPerMin));
        // Heading-up, turned smoothly so a switchback does not whip the camera; a scrub turns at once.
        bearing = live.playing ? bearing + turnBetween(bearing, target) * Math.min(1, dt / 400) : target;
        const center = positionAt(line, live.fraction);
        const zoom = followZoom(kmPerMin);
        // Tilt up fast when a ridge is in the way, settle back down slowly.
        const wanted = clearPitchAt(center, bearing, zoom);
        pitch = live.playing ? pitch + (wanted - pitch) * Math.min(1, dt / (wanted < pitch ? 150 : 600)) : wanted;
        map.jumpTo({ center, bearing, pitch, zoom, padding });
        published = live.fraction;
        liveFractionStore.set({ routeId, fraction: live.fraction });
        const shown = Math.round(live.fraction * 2000) / 2000;
        if (shown !== shownFraction) {
          shownFraction = shown;
          setRouteProgress(map, routeId, live.fraction);
        }
        // The reducer only hears about the end (which pauses there); pause and scrub send their own position,
        // so playing does not re-render the app every frame.
        if (live.fraction >= 1 && live.lastSent !== 1) {
          live.lastSent = 1;
          dispatchPreview({ type: "preview_tick", fraction: 1 });
        }
      }
      // Heights the overview missed (tiles that had not loaded) fill in as the camera passes.
      if (!complete && now - lastReadAt > 500) {
        lastReadAt = now;
        readHeights();
      }
      raf = requestAnimationFrame(frame);
    };

    const follow = () => {
      if (cancelled) return;
      readHeights();
      const kmPerMin = speedKmPerMin(live.speed);
      const center = positionAt(line, live.fraction);
      pitch = clearPitchAt(center, bearing, followZoom(kmPerMin));
      padding = paddingNow();
      map.easeTo({
        center,
        bearing,
        pitch,
        padding,
        zoom: followZoom(kmPerMin),
        duration: PREVIEW_EASE_MS,
        easing: easeInOut,
      });
      timers.push(window.setTimeout(() => (raf = requestAnimationFrame(frame)), PREVIEW_EASE_MS + 20));
    };

    // Overview first: the whole route in view loads the terrain tiles the profile needs.
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
    let started = false;
    const startFollowing = () => {
      if (started) return;
      started = true;
      follow();
    };
    map.once("idle", startFollowing);
    timers.push(window.setTimeout(startFollowing, 1800));
    // The route framed in the clear part of the map with up to 40px to spare; the same padding sets the zoom and
    // the ease, so the route lands where the zoom was worked out for.
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
    const overview = map.cameraForBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: framed, bearing: 0, pitch: 0, maxZoom: 15 },
    );
    if (overview?.zoom !== undefined) {
      map.easeTo({
        center: [(west + east) / 2, (south + north) / 2],
        zoom: overview.zoom,
        bearing: 0,
        pitch: 0,
        padding: framed,
        duration: PREVIEW_EASE_MS,
        easing: easeInOut,
      });
    } else startFollowing();

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
        // Never leave the camera in follow pitch: back to the camera the preview began from, tilt included (a map
        // flattened meanwhile comes back flat).
        map.easeTo({
          center: [restore.camera.longitude, restore.camera.latitude],
          zoom: restore.camera.zoom,
          bearing: restore.camera.bearing,
          pitch: stateRef.current.flattened ? 0 : restore.camera.pitch,
          padding: restore.padding,
          duration: PREVIEW_EASE_MS,
          easing: easeInOut,
        });
      });
    };
  }, [playbackRouteId]);

  return <div ref={containerRef} data-testid="map-canvas" className={className ?? "h-full w-full"} />;
}
