"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ChatRail } from "@/components/ChatRail";
import { CompareControl } from "@/components/CompareControl";
import { InspectCard } from "@/components/InspectCard";
import { drawnColor, LayerStack } from "@/components/LayerStack";
import { MapCanvas, type MapHandle } from "@/components/MapCanvas";
import { MapControls } from "@/components/MapControls";
import { MapPills } from "@/components/MapPills";
import type { LayerCatalog } from "@/lib/agent/applyToolResult";
import { sendChat } from "@/lib/agent/chatBus";
import { bboxToViewport } from "@/lib/render/deck";
import { askAboutText, featureBBox } from "@/lib/render/inspect";
import { usePermalink } from "@/lib/render/usePermalink";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type Basemap, type MapAction, type Selection, type Viewport } from "@/lib/render/state";
import { isSelectionVisible, visibleState } from "@/lib/render/view";
import { visibleMapPadding } from "@/lib/render/viewportPadding";
import { pitchFor } from "@/lib/render/wally/terrain";

const DEFAULT_CANVAS = { width: 1000, height: 800 };
const FLATTENED_KEY = "wallymap:flattened";

/** Session storage can throw (private mode, blocked storage); the 3D choice then lasts only for the page. */
function readSessionFlag(key: string): boolean {
  try {
    return window.sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeSessionFlag(key: string, value: boolean): void {
  try {
    if (value) window.sessionStorage.setItem(key, "1");
    else window.sessionStorage.removeItem(key);
  } catch {
    // Unavailable storage only costs the remembered choice.
  }
}

type CatalogEntry = { id: string; title: string; style: LayerCatalog[string]["style"]; license?: string };

async function fetchCatalog(): Promise<LayerCatalog> {
  try {
    const res = await fetch("/api/layers");
    if (!res.ok) return {};
    const entries = (await res.json()) as CatalogEntry[];
    return Object.fromEntries(entries.map((e) => [e.id, { title: e.title, style: e.style, license: e.license }]));
  } catch {
    // Without a catalog, layers still draw with the fallback title and style.
    return {};
  }
}

export function App() {
  const [state, dispatch] = useReducer(reduce, initialMapState);
  const permalink = usePermalink(state, dispatch);
  const [catalog, setCatalog] = useState<LayerCatalog | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  // Phones start with the layer panel folded into its pill so it does not cover the map.
  const [layersOpen, setLayersOpen] = useState(() => typeof window === "undefined" || window.innerWidth >= 768);
  const mapBoxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapHandle>(null);
  const canvasSizeRef = useRef(DEFAULT_CANVAS);

  useEffect(() => {
    let cancelled = false;
    void fetchCatalog().then((c) => {
      if (!cancelled) setCatalog(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const el = mapBoxRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) return;
      const prev = canvasSizeRef.current;
      canvasSizeRef.current = { width, height };
      // Mapbox only tracks window resizes, so collapsing the rail would leave a stale canvas size.
      if (prev.width !== width || prev.height !== height) window.dispatchEvent(new Event("resize"));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The 3D button's choice lasts for the browser session: restore a flattened map on load, save every change.
  const flattenedLoadedRef = useRef(false);
  useEffect(() => {
    if (!flattenedLoadedRef.current) {
      flattenedLoadedRef.current = true;
      if (readSessionFlag(FLATTENED_KEY)) dispatch({ type: "set_flattened", flattened: true });
      return;
    }
    writeSessionFlag(FLATTENED_KEY, state.flattened);
  }, [state.flattened]);
  const threeD = state.terrain && !state.flattened;
  // Pressing 3D while it is off also brings back terrain the agent turned off.
  const toggle3D = useCallback(() => dispatch({ type: "set_flattened", flattened: threeD }), [threeD]);

  const getCanvasSize = useCallback(() => canvasSizeRef.current, []);
  const onActions = useCallback((actions: MapAction[]) => actions.forEach(dispatch), []);
  const onViewportChange = useCallback((viewport: Viewport) => dispatch({ type: "set_view", viewport }), []);
  const toggle = useCallback(() => setCollapsed((c) => !c), []);
  const setBasemap = useCallback((basemap: Basemap) => dispatch({ type: "set_basemap", basemap }), []);
  const onPick = useCallback(
    (selection: Selection | null) => dispatch(selection ? { type: "select", selection } : { type: "deselect" }),
    [],
  );
  const deselect = useCallback(() => dispatch({ type: "deselect" }), []);
  const project = useCallback((lngLat: [number, number]) => mapRef.current?.project(lngLat) ?? null, []);
  const onCameraChange = useCallback(
    (listener: () => void) => mapRef.current?.onCameraChange(listener) ?? (() => {}),
    [],
  );

  const hasLayers = Object.keys(state.layers).length > 0;
  const layerPanelOpen = layersOpen && hasLayers;
  // What the map draws: the time window and the layer filters applied (lib/render/view.ts).
  const view = visibleState(state);
  // The inspect card follows the time window and filters: a feature they hide is not inspected.
  const selected = state.selected && isSelectionVisible(state, state.selected) ? state.selected : undefined;
  const selectedLayer = selected ? state.layers[selected.layerId] : undefined;

  const askAbout = useCallback(() => {
    if (!selected || !selectedLayer) return false;
    const sent = sendChat(askAboutText(selectedLayer.title, selected, selectedLayer.style.unit));
    if (sent) setCollapsed(false);
    return sent;
  }, [selected, selectedLayer]);

  // Stub until route playback lands (Milestone 3): frame the whole line in the part of the map left visible.
  const previewRoute = useCallback(() => {
    const bbox = selected ? featureBBox(selected.feature) : null;
    if (!bbox) return;
    const size = canvasSizeRef.current;
    const padding = visibleMapPadding({ ...size, panelOpen: !collapsed, isMobile: size.width < 768, layerPanelOpen });
    const { longitude, latitude, zoom } = bboxToViewport(bbox, size.width, size.height, padding);
    // A route preview frames the line at Detail pitch (unless the map is flattened); `fit` backs the zoom off for it.
    const pitch = state.flattened ? {} : { pitch: pitchFor("detail") };
    dispatch({ type: "set_view", viewport: { longitude, latitude, zoom, bearing: 0, ...pitch }, fit: true });
  }, [selected, collapsed, layerPanelOpen, state.flattened]);

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-cream">
      {/* The map fills the window; every control floats over it. */}
      <main ref={mapBoxRef} className="absolute inset-0">
        <MapCanvas ref={mapRef} state={state} onViewportChange={onViewportChange} onPick={onPick} />
      </main>

      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 p-3 md:p-4">
        <div className="pointer-events-auto">
          <MapPills
            basemap={state.basemap}
            onBasemapChange={setBasemap}
            layerCount={Object.keys(state.layers).length}
            layersOpen={layersOpen}
            onLayersOpenChange={setLayersOpen}
            mapState={state}
            catalog={catalog}
            restoreStatus={permalink.status}
          />
        </div>
      </header>

      {/* Compare over time: the Compare pill or strip under the map pills, and the swipe handle across the map. */}
      <CompareControl state={state} dispatch={dispatch} />

      <div className="pointer-events-none absolute top-3 right-3 z-20 flex flex-col items-end md:top-4 md:right-4">
        <LayerStack
          layers={state.layers}
          renderOps={state.renderOps}
          catalog={catalog}
          dispatch={dispatch}
          open={layersOpen}
          onOpenChange={setLayersOpen}
          selectedLayerId={state.selected?.layerId}
          time={state.time}
          shownLayers={view.layers}
        />
      </div>

      {selected && selectedLayer && (
        <InspectCard
          // A new selection starts fresh (copy and busy states reset).
          key={`${selected.layerId}:${selected.lngLat.join(",")}`}
          selection={selected}
          layer={selectedLayer}
          color={drawnColor(selectedLayer, state.renderOps.find((op) => op.layerId === selected.layerId))}
          project={project}
          onCameraChange={onCameraChange}
          onClose={deselect}
          onAsk={askAbout}
          onPreviewRoute={previewRoute}
        />
      )}

      <MapControls
        onZoomIn={() => mapRef.current?.zoomIn()}
        onZoomOut={() => mapRef.current?.zoomOut()}
        onGlobe={() => mapRef.current?.resetToGlobe()}
        threeD={threeD}
        onToggle3D={toggle3D}
      />

      <ChatRail
        catalog={catalog}
        renderOps={state.renderOps}
        getCanvasSize={getCanvasSize}
        onActions={onActions}
        collapsed={collapsed}
        onToggle={toggle}
        layerPanelOpen={layerPanelOpen}
      />
    </div>
  );
}
