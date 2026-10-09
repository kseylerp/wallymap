"use client";

import type { Layer } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import mapboxgl from "mapbox-gl";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { MapSetupNotice } from "@/components/MapSetupNotice";
import { syncHeatLayers, syncSatelliteHybrid, syncTileLayers } from "@/components/mapTiles";
import { ensureRouteImages, setRouteProgress, syncRouteLayers } from "@/components/routeLayers";
import { basemapStyleUrl } from "@/lib/render/basemaps";
import { buildDeckLayers } from "@/lib/render/deck";
import { pickToSelection, type DeckPick } from "@/lib/render/inspect";
import { initialMapState, type Basemap, type MapState, type Selection, type Viewport } from "@/lib/render/state";
import {
  bearingAt,
  DEFAULT_LOOKAHEAD_M,
  dispatchPreview,
  elevationStore,
  FOLLOW_PITCH,
  followZoom,
  fractionStep,
  liveFractionStore,
  mapStateStore,
  positionAt,
  PREVIEW_EASE_MS,
  speedKmPerMin,
  turnBetween,
} from "@/lib/render/wally/playback";
import { samplePoints } from "@/lib/render/wally/sample";
import {
  arrivalPitch,
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

function sameViewport(a: Viewport, b: Viewport): boolean {
  return (
    Math.abs(a.longitude - b.longitude) <= EPSILON &&
    Math.abs(a.latitude - b.latitude) <= EPSILON &&
    Math.abs(a.zoom - b.zoom) <= EPSILON &&
    Math.abs(a.pitch - b.pitch) <= EPSILON &&
    Math.abs(a.bearing - b.bearing) <= EPSILON
  );
}

/** An unsupported render mode must not crash the canvas, so failures render no deck layers. */
function safeDeckLayers(state: MapState): Layer[] {
  try {
    return buildDeckLayers(state);
  } catch (error) {
    console.error("MapCanvas: could not build deck.gl layers", error);
    return [];
  }
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
  // The camera the map last settled on (or is easing to). A prop equal to this is our own echo.
  const lastCameraRef = useRef<Viewport>(state.viewport);
  // True while a route preview drives the camera: it neither reports every frame nor eases to viewport props.
  const followingRef = useRef(false);
  // The preview's position and settings as the animation loop sees them (see the playback effects below).
  const liveRef = useRef({ fraction: 0, playing: false, speed: 1, lastSent: -1, dirty: false });

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
    const overlay = new MapboxOverlay({ interleaved: false, layers: safeDeckLayers(initial) });
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
      syncTileLayers(map, stateRef.current);
      syncHeatLayers(map, stateRef.current);
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
      map.removeControl(overlay);
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, []);

  // Deck layers, tile layers and Mapbox heatmaps follow every state change.
  useEffect(() => {
    overlayRef.current?.setProps({ layers: safeDeckLayers(state) });
    if (mapRef.current) {
      syncTileLayers(mapRef.current, state);
      syncHeatLayers(mapRef.current, state);
      syncRouteLayers(mapRef.current, state);
    }
  }, [state]);

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
  // back to the camera from before the preview at Explore pitch.
  const playbackRouteId = playback?.routeId;
  useEffect(() => {
    const map = mapRef.current;
    const routeId = playbackRouteId;
    const route = routeId ? stateRef.current.routes[routeId] : undefined;
    if (!map || !routeId || !route) return;
    const line = route.line;
    const live = liveRef.current;
    const restore = cameraOf(map);
    followingRef.current = true;
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
    let last = 0;
    let lastSentAt = 0;
    let lastReadAt = 0;
    let shownFraction = -1;
    const frame = (now: number) => {
      if (cancelled) return;
      const dt = last ? Math.min(100, now - last) : 16;
      last = now;
      const kmPerMin = speedKmPerMin(live.speed);
      let moved = live.dirty;
      live.dirty = false;
      if (live.playing && live.fraction < 1) {
        live.fraction = Math.min(1, live.fraction + fractionStep(line, kmPerMin, dt));
        moved = true;
      }
      if (moved) {
        const target = bearingAt(line, live.fraction, lookAhead(kmPerMin));
        // Heading-up, turned smoothly so a switchback does not whip the camera; a scrub turns at once.
        bearing = live.playing ? bearing + turnBetween(bearing, target) * Math.min(1, dt / 400) : target;
        map.jumpTo({ center: positionAt(line, live.fraction), bearing, pitch: FOLLOW_PITCH, zoom: followZoom(kmPerMin) });
        liveFractionStore.set({ routeId, fraction: live.fraction });
        const shown = Math.round(live.fraction * 2000) / 2000;
        if (shown !== shownFraction) {
          shownFraction = shown;
          setRouteProgress(map, routeId, live.fraction);
        }
        // The reducer hears about the position four times a second, and always about the end.
        if ((now - lastSentAt > 250 || live.fraction >= 1) && live.lastSent !== live.fraction) {
          lastSentAt = now;
          live.lastSent = live.fraction;
          dispatchPreview({ type: "preview_tick", fraction: live.fraction });
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
      map.easeTo({
        center: positionAt(line, live.fraction),
        bearing,
        pitch: FOLLOW_PITCH,
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
    timers.push(window.setTimeout(startFollowing, 3000));
    map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: 80, bearing: 0, pitch: 0, maxZoom: 15, duration: PREVIEW_EASE_MS, easing: easeInOut },
    );

    // Grabbing the map pauses the ride so the user can look around.
    const onDragStart = () => {
      if (live.playing) {
        live.playing = false;
        dispatchPreview({ type: "preview_toggle" });
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
      if (mapRef.current !== map) return; // unmounted: the map is gone
      setRouteProgress(map, routeId, null);
      // Never leave the camera in follow pitch: back to where the preview began, at Explore pitch.
      map.easeTo({
        center: [restore.longitude, restore.latitude],
        zoom: restore.zoom,
        bearing: restore.bearing,
        pitch: arrivalPitch(restore.zoom, stateRef.current.flattened),
        duration: PREVIEW_EASE_MS,
        easing: easeInOut,
      });
    };
  }, [playbackRouteId]);

  return <div ref={containerRef} data-testid="map-canvas" className={className ?? "h-full w-full"} />;
}
