"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ChatRail } from "@/components/ChatRail";
import { MapCanvas } from "@/components/MapCanvas";
import type { LayerCatalog } from "@/lib/agent/applyToolResult";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type MapAction, type Viewport } from "@/lib/render/state";

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

  return (
    <div className="relative flex h-dvh w-full overflow-hidden bg-neutral-100">
      <aside
        className={[
          // Phones: a bottom sheet over the full-screen map.
          "fixed inset-x-0 bottom-0 z-10 overflow-hidden rounded-t-xl border-t border-neutral-200 shadow-lg",
          collapsed ? "h-12" : "h-[45vh]",
          // md and up: a left rail beside the map.
          "md:static md:z-auto md:h-full md:shrink-0 md:rounded-none md:border-t-0 md:border-r md:shadow-none",
          collapsed ? "md:w-12" : "md:w-1/3 md:min-w-[320px]",
        ].join(" ")}
      >
        <ChatRail
          catalog={catalog}
          renderOps={state.renderOps}
          getCanvasSize={getCanvasSize}
          onActions={onActions}
          collapsed={collapsed}
          onToggle={toggle}
        />
      </aside>
      <main ref={mapBoxRef} className="h-full min-w-0 flex-1">
        <MapCanvas state={state} onViewportChange={onViewportChange} />
      </main>
    </div>
  );
}
