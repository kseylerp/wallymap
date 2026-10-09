"use client";

import type { Layer } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import mapboxgl from "mapbox-gl";
import { useEffect, useRef } from "react";
import { MapSetupNotice } from "@/components/MapSetupNotice";
import { syncSatelliteHybrid, syncTileLayers } from "@/components/mapTiles";
import { basemapStyleUrl } from "@/lib/render/basemaps";
import { buildDeckLayers } from "@/lib/render/deck";
import type { Basemap, MapState, Viewport } from "@/lib/render/state";

// Literal `process.env.NEXT_PUBLIC_*` access so Next inlines it into the client bundle.
const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN?.trim() ?? "";
const EPSILON = 1e-6;

type MapCanvasProps = {
  state: MapState;
  onViewportChange: (v: Viewport) => void;
  className?: string;
};

export function MapCanvas({ state, onViewportChange, className }: MapCanvasProps) {
  if (!MAPBOX_TOKEN) {
    return (
      <div data-testid="map-canvas" className={className ?? "h-full w-full"}>
        <MapSetupNotice />
      </div>
    );
  }
  return <GlobeMap state={state} onViewportChange={onViewportChange} className={className} />;
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

function GlobeMap({ state, onViewportChange, className }: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const stateRef = useRef(state);
  const onViewportChangeRef = useRef(onViewportChange);
  const appliedBasemapRef = useRef<Basemap>(state.basemap);
  // The camera the map last settled on (or is easing to). A prop equal to this is our own echo.
  const lastCameraRef = useRef<Viewport>(state.viewport);

  // Keep the latest props reachable from map event handlers without re-creating the map.
  useEffect(() => {
    stateRef.current = state;
    onViewportChangeRef.current = onViewportChange;
  });

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
      syncTileLayers(map, stateRef.current);
    });

    mapRef.current = map;
    overlayRef.current = overlay;
    appliedBasemapRef.current = initial.basemap;
    lastCameraRef.current = initial.viewport;

    return () => {
      map.removeControl(overlay);
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, []);

  // Deck layers and raster tile layers follow every state change.
  useEffect(() => {
    overlayRef.current?.setProps({ layers: safeDeckLayers(state) });
    if (mapRef.current) syncTileLayers(mapRef.current, state);
  }, [state]);

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
    lastCameraRef.current = target;
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

  return <div ref={containerRef} data-testid="map-canvas" className={className ?? "h-full w-full"} />;
}
