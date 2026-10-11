"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ChatRail } from "@/components/ChatRail";
import { CompareControl, CompareSwipe, openCompareAction, useCompareTicker } from "@/components/CompareControl";
import { InspectCard } from "@/components/InspectCard";
import { LayerStack, selectionSwatch } from "@/components/LayerStack";
import { MapCanvas, type MapHandle } from "@/components/MapCanvas";
import { MapControls } from "@/components/MapControls";
import { MapPills } from "@/components/MapPills";
import { useSuggestionsCard } from "@/components/useSuggestionsCard";
import type { LayerCatalog } from "@/lib/agent/applyToolResult";
import { sendChat } from "@/lib/agent/chatBus";
import { bboxToViewport, type Padding } from "@/lib/render/deck";
import { askAboutText, featureBBox } from "@/lib/render/inspect";
import { usePermalink } from "@/lib/render/usePermalink";
import { isComparable } from "@/lib/render/compareView";
import { useTimePlay } from "@/lib/render/useTimePlay";
import { isMapReset, reduce } from "@/lib/render/reducer";
import { initialMapState, type Basemap, type MapAction, type Selection, type Viewport } from "@/lib/render/state";
import { isSelectionVisible, visibleState } from "@/lib/render/view";
import { visibleMapPadding } from "@/lib/render/viewportPadding";
import { pitchFor } from "@/lib/render/wally/terrain";

const DEFAULT_CANVAS = { width: 1000, height: 800 };
/** Below this width the app lays out for a phone (Tailwind's `md` breakpoint). */
const PHONE_MAX_WIDTH = 768;
/** The gap between the map pills' last row and the data console on a phone. */
const CONSOLE_GAP = 8;
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
  // The scrubber's play steps here, so it keeps going while the layer panel is closed.
  useTimePlay(state.time?.playing ?? false, dispatch);
  // Compare's 1 Hz toggle flip and its space key, here so they keep going while the data console is closed.
  useCompareTicker(state, dispatch);
  const [catalog, setCatalog] = useState<LayerCatalog | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  // Phones start with the layer panel folded into its pill so it does not cover the map.
  const [layersOpen, setLayersOpen] = useState(() => typeof window === "undefined" || window.innerWidth >= 768);
  const mapBoxRef = useRef<HTMLDivElement>(null);
  const pillsRef = useRef<HTMLDivElement>(null);
  // Where the data console starts on a phone: under the map pills, which wrap to a second row at 375px.
  const [pillsBottom, setPillsBottom] = useState<number | null>(null);
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

  useEffect(() => {
    const el = pillsRef.current;
    if (!el) return;
    // Measured from the app's own top edge, not the viewport's: when iOS Safari pans the page (the keyboard opens, or
    // it zoomed in on a field), viewport coordinates shift and would push the console up under the pills.
    const measure = () => {
      const top = mapBoxRef.current?.getBoundingClientRect().top ?? 0;
      setPillsBottom(Math.round(el.getBoundingClientRect().bottom - top));
    };
    measure();
    const observer = new ResizeObserver(measure);
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
  // The logo: clear layers, filters, time, compare, preview and selection, then fly home. The permalink hook sees the
  // emptied state and rewrites the hash; the chat, basemap, 3D and the layer panel's open state are left alone.
  const resetMap = useCallback(() => {
    if (isMapReset(state)) return;
    dispatch({ type: "reset_map" });
    mapRef.current?.resetToGlobe();
  }, [state]);
  const deselect = useCallback(() => dispatch({ type: "deselect" }), []);
  const project = useCallback((lngLat: [number, number]) => mapRef.current?.project(lngLat) ?? null, []);
  const getView = useCallback((padding: Padding) => mapRef.current?.getView(padding) ?? null, []);
  const onCameraChange = useCallback(
    (listener: () => void) => mapRef.current?.onCameraChange(listener) ?? (() => {}),
    [],
  );

  // On a phone the preview dock, the data console and the chat sheet would cover the whole map, so starting a route
  // preview closes the console and ending it opens it again (when the preview closed it). Adjusted during render, the
  // React way to follow a prop change, so the console never paints over the preview first.
  const previewing = state.playback !== undefined;
  const [wasPreviewing, setWasPreviewing] = useState(previewing);
  const [reopenAfterPreview, setReopenAfterPreview] = useState(false);
  if (previewing !== wasPreviewing) {
    setWasPreviewing(previewing);
    if (previewing && layersOpen && window.innerWidth < PHONE_MAX_WIDTH) {
      setLayersOpen(false);
      setReopenAfterPreview(true);
    } else if (!previewing && reopenAfterPreview) {
      setLayersOpen(true);
      setReopenAfterPreview(false);
    }
  }

  const suggestions = useSuggestionsCard();
  const hasLayers = Object.keys(state.layers).length > 0;
  const layerPanelOpen = layersOpen && hasLayers;
  const canCompare = useMemo(() => Object.values(state.layers).some(isComparable), [state.layers]);
  // The Compare pill (shown while the console is closed) opens the console, starting a compare if none is on.
  const openCompare = useCallback(() => {
    setLayersOpen(true);
    const action = state.compare ? null : openCompareAction(state);
    if (action) dispatch(action);
  }, [state]);
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

  // The fallback for "Preview route" when no preview control is mounted to run one (components/InspectCard.tsx):
  // frame the whole line in the part of the map left visible.
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
    <div
      className="fixed inset-0 overflow-hidden bg-cream"
      style={pillsBottom === null ? undefined : { ["--console-top" as string]: `${pillsBottom + CONSOLE_GAP}px` }}
    >
      {/* The map fills the window; every control floats over it. */}
      <main ref={mapBoxRef} className="absolute inset-0">
        <MapCanvas ref={mapRef} state={state} onViewportChange={onViewportChange} onPick={onPick} />
      </main>

      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 pt-[calc(var(--safe-top)+0.75rem)] pr-[calc(var(--safe-right)+0.75rem)] pb-3 pl-[calc(var(--safe-left)+0.75rem)] md:pt-[calc(var(--safe-top)+1rem)] md:pr-[calc(var(--safe-right)+1rem)] md:pb-4 md:pl-[calc(var(--safe-left)+1rem)]">
        <div ref={pillsRef} className="pointer-events-auto">
          <MapPills
            basemap={state.basemap}
            onBasemapChange={setBasemap}
            layerCount={Object.keys(state.layers).length}
            layersOpen={layersOpen}
            onLayersOpenChange={setLayersOpen}
            mapState={state}
            catalog={catalog}
            restoreStatus={permalink.status}
            onCompare={!layerPanelOpen && (canCompare || state.compare) ? openCompare : undefined}
            comparing={state.compare !== undefined}
            onResetMap={resetMap}
            suggestionsOpen={suggestions.open}
            onToggleSuggestions={suggestions.toggle}
          />
        </div>
      </header>

      {/* Compare's swipe handle across the map (the control itself is in the data console). */}
      <CompareSwipe state={state} />

      {/* Phones: the console opens under the map pills (however many rows they wrap to, the top inset included, since
          it is measured) and leaves a gutter on the right for the zoom, globe and 3D buttons. */}
      <div className="pointer-events-none absolute z-20 flex flex-col items-end max-md:top-(--console-top,60px) max-md:right-[calc(max(12px,var(--safe-right))+44px)] md:top-[calc(var(--safe-top)+1rem)] md:right-[calc(var(--safe-right)+1rem)]">
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
          compareSlot={<CompareControl state={state} dispatch={dispatch} />}
        />
      </div>

      {selected && selectedLayer && (
        <InspectCard
          // A new selection starts fresh (copy and busy states reset).
          key={`${selected.layerId}:${selected.side ?? "a"}:${selected.lngLat.join(",")}`}
          selection={selected}
          layer={selectedLayer}
          swatch={selectionSwatch(state, selected, selectedLayer)}
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
        getView={getView}
        onActions={onActions}
        collapsed={collapsed}
        onToggle={toggle}
        layerPanelOpen={layerPanelOpen}
        suggestionsOpen={suggestions.open}
        suggestionQuestions={suggestions.questions}
        onSuggestionsMore={suggestions.more}
        onSuggestionsClose={suggestions.close}
        onSuggestionsSeen={suggestions.markSeen}
      />
    </div>
  );
}
