"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { BasemapSwitch } from "@/components/BasemapSwitch";
import { ChatRail } from "@/components/ChatRail";
import { LayerChips } from "@/components/LayerChips";
import { MapCanvas, type MapHandle } from "@/components/MapCanvas";
import { MapControls } from "@/components/MapControls";
import { Wordmark } from "@/components/Wordmark";
import type { LayerCatalog } from "@/lib/agent/applyToolResult";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type Basemap, type MapAction, type Viewport } from "@/lib/render/state";

const DEFAULT_CANVAS = { width: 1000, height: 800 };

type CatalogEntry = { id: string; title: string; style: LayerCatalog[string]["style"] };

async function fetchCatalog(): Promise<LayerCatalog> {
  try {
    const res = await fetch("/api/layers");
    if (!res.ok) return {};
    const entries = (await res.json()) as CatalogEntry[];
    return Object.fromEntries(entries.map((e) => [e.id, { title: e.title, style: e.style }]));
  } catch {
    // Without a catalog, layers still draw with the fallback title and style.
    return {};
  }
}

export function App() {
  const [state, dispatch] = useReducer(reduce, initialMapState);
  const [catalog, setCatalog] = useState<LayerCatalog | null>(null);
  const [collapsed, setCollapsed] = useState(false);
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

  const getCanvasSize = useCallback(() => canvasSizeRef.current, []);
  const onActions = useCallback((actions: MapAction[]) => actions.forEach(dispatch), []);
  const onViewportChange = useCallback((viewport: Viewport) => dispatch({ type: "set_view", viewport }), []);
  const toggle = useCallback(() => setCollapsed((c) => !c), []);
  const setBasemap = useCallback((basemap: Basemap) => dispatch({ type: "set_basemap", basemap }), []);
  const toggleLayer = useCallback((layerId: string) => dispatch({ type: "toggle_layer", layerId }), []);

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-cream">
      {/* The map fills the window; every control floats over it. */}
      <main ref={mapBoxRef} className="absolute inset-0">
        <MapCanvas ref={mapRef} state={state} onViewportChange={onViewportChange} />
      </main>

      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 p-3 md:p-4">
        <div className="pointer-events-auto flex items-center gap-2">
          <div className="rise-in">
            <Wordmark />
          </div>
          <div className="rise-in" style={{ animationDelay: "60ms" }}>
            <BasemapSwitch value={state.basemap} onChange={setBasemap} />
          </div>
        </div>
        <LayerChips layers={state.layers} renderOps={state.renderOps} onToggle={toggleLayer} />
      </header>

      <MapControls
        onZoomIn={() => mapRef.current?.zoomIn()}
        onZoomOut={() => mapRef.current?.zoomOut()}
        onGlobe={() => mapRef.current?.resetToGlobe()}
      />

      <ChatRail
        catalog={catalog}
        renderOps={state.renderOps}
        getCanvasSize={getCanvasSize}
        onActions={onActions}
        collapsed={collapsed}
        onToggle={toggle}
      />
    </div>
  );
}
