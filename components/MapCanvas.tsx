"use client";

import type { Layer } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import mapboxgl from "mapbox-gl";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { MapSetupNotice } from "@/components/MapSetupNotice";
import { syncHeatLayers, syncSatelliteHybrid, syncTileLayers } from "@/components/mapTiles";
import { ensureRouteImages, syncRouteLayers } from "@/components/routeLayers";
import { basemapStyleUrl } from "@/lib/render/basemaps";
import { buildDeckLayers } from "@/lib/render/deck";
import { featureBBox, featureCenter, pickToSelection, type DeckPick } from "@/lib/render/inspect";
import { initialMapState, type Basemap, type MapState, type Selection, type Viewport } from "@/lib/render/state";
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
/** Camera ease onto a selected feature (spec: 350 ms). */
const SELECT_EASE_MS = 350;

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

/** True when `state` wants terrain drawn: on by default, off while the user has flattened the map. */
function wantsTerrain(state: MapState): boolean {
  return state.terrain && !state.flattened;
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

  // A new selection eases the camera onto the feature: its center when the whole feature is in view, else
  // the clicked point (centering a national forest would fly away from where the user clicked).
  const selected = state.selected;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selected) return;
    const bbox = featureBBox(selected.feature);
    const bounds = map.getBounds();
    const fits =
      bbox !== null &&
      bounds !== null &&
      bounds.contains([bbox[0], bbox[1]]) &&
      bounds.contains([bbox[2], bbox[3]]);
    const center = (fits ? featureCenter(selected.feature) : null) ?? selected.lngLat;
    // The reducer may have tilted to Detail pitch with this selection. One ease carries both moves (a second
    // easeTo would cancel this one), and marking the pitch as ours stops the viewport effect from easing again.
    const { pitch } = stateRef.current.viewport;
    lastCameraRef.current = stateRef.current.viewport;
    // Pin the zoom: left out, Mapbox recomputes it against the terrain under the new center (13 became 15.7).
    map.easeTo({ center, zoom: map.getZoom(), pitch, duration: SELECT_EASE_MS, easing: (t) => t * (2 - t) });
  }, [selected]);

  // Ease to a new viewport when it differs from both the actual camera and our own last report.
  useEffect(() => {
    const map = mapRef.current;
    const target = state.viewport;
    if (!map) return;
    if (sameViewport(target, cameraOf(map))) {
      lastCameraRef.current = target;
      return;
    }
    // The prop is the echo of a camera we already reported (e.g. an ease that was interrupted
    // mid-flight); easing back to it would fight the newer move.
    if (sameViewport(target, lastCameraRef.current)) return;
    const pitchOnly = sameViewport({ ...target, pitch: lastCameraRef.current.pitch }, lastCameraRef.current);
    lastCameraRef.current = target;
    // A pitch-only change (select, deselect, the 3D button) tilts in place with Wally's short ease.
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

  return <div ref={containerRef} data-testid="map-canvas" className={className ?? "h-full w-full"} />;
}
