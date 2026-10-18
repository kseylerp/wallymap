"use client";

import { useEffect, useRef, useState, type Dispatch } from "react";
import type { LayerCatalog } from "@/lib/agent/applyToolResult";
import { fetchCatalog } from "@/lib/agent/catalog";
import type { LayerError, LayerResult } from "@/layers/types";
import { decodeState, encodeState, restoreFromPermalink, type FetchLayer } from "@/lib/render/permalink";
import { initialMapState, type MapAction, type MapState } from "@/lib/render/state";

const WRITE_DELAY_MS = 500;
const FAILURE_NOTICE_MS = 6000;

/**
 * Asks `/api/layer/<id>` for the layer over the box, with the link's query input (surf's forecast) or the default
 * input; a failed request comes back as a layer error.
 */
const fetchLayer: FetchLayer = async (id, bbox, zoom, input) => {
  const res = await fetch(`/api/layer/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bbox, zoom, ...(input && { input }) }),
  });
  return (await res.json()) as LayerResult | LayerError;
};

function isInitialView(state: MapState): boolean {
  const a = state.viewport;
  const b = initialMapState.viewport;
  return (
    Object.keys(state.layers).length === 0 &&
    state.errors.length === 0 &&
    state.basemap === initialMapState.basemap &&
    a.longitude === b.longitude &&
    a.latitude === b.latitude &&
    a.zoom === b.zoom &&
    a.pitch === b.pitch &&
    a.bearing === b.bearing
  );
}

/**
 * Keeps the URL hash and the map in step. On mount, and whenever a new link is pasted into the same tab, a hash that
 * names a view or layers is replayed into the map (layers are fetched again, so a link carries ids, not data). After
 * that, the camera, basemap, layers (each with its whole render op and query input), time window and mode, scenario
 * amount, compare and 3D choice are written back to the hash 500 ms after they stop changing. `status` is a short line to show while layers
 * are coming back ("Restoring 3 layers…") or when some could not be; null otherwise.
 */
export function usePermalink(state: MapState, dispatch: Dispatch<MapAction>): { status: string | null } {
  const [status, setStatus] = useState<string | null>(null);
  // Writing waits until the hash has been read (and any layers restored), or the first write would erase it.
  const [ready, setReady] = useState(() => typeof window === "undefined" || decodeState(window.location.hash) === null);
  // The layer ids `/api/layer/<id>` can serve; a link names only those (route results and drawn layers cannot be replayed).
  const [catalog, setCatalog] = useState<LayerCatalog | null>(null);
  const startedRef = useRef(false);
  // Replays a hash into the map; set by the first effect, called again by the hashchange listener.
  const restoreRef = useRef<((hash: string) => Promise<void>) | null>(null);

  useEffect(() => {
    // Strict mode runs effects twice in development; the restore must run once.
    if (startedRef.current) return;
    startedRef.current = true;
    const catalogReady = fetchCatalog().then((c) => {
      setCatalog(c);
      return c;
    });
    // Each restore gets a number; a newer one (another pasted link) makes an older one stale, so the older one's
    // dispatches and status messages are dropped rather than landing on top of the newer link's map.
    let latest = 0;
    restoreRef.current = async (hash: string) => {
      const run = ++latest;
      const current = () => run === latest;
      const guarded: typeof dispatch = (action) => {
        if (current()) dispatch(action);
      };
      const catalog = await catalogReady;
      if (!current()) return;
      const outcome = await restoreFromPermalink(hash, guarded, fetchLayer, {
        catalog,
        canvas: { width: window.innerWidth, height: window.innerHeight },
        onStart: (count) => {
          if (count > 0 && current()) setStatus(`Restoring ${count} ${count === 1 ? "layer" : "layers"}…`);
        },
      });
      if (!current()) return;
      setReady(true);
      if (outcome && outcome.failed.length > 0) {
        setStatus(`Could not restore ${outcome.failed.length} of ${outcome.failed.length + outcome.restored.length} layers`);
        window.setTimeout(() => setStatus(null), FAILURE_NOTICE_MS);
      } else if (outcome?.filtersDropped) {
        // The sharing map had more filters than a link can carry (permalink.ts MAX_FILTER_CHARS).
        const n = outcome.filtersDropped;
        setStatus(`${n} ${n === 1 ? "filter was" : "filters were"} too long for the link and left out`);
        window.setTimeout(() => setStatus(null), FAILURE_NOTICE_MS);
      } else {
        setStatus(null);
      }
    };
    if (decodeState(window.location.hash) !== null) void restoreRef.current(window.location.hash);
  }, [dispatch]);

  // A share link pasted into this tab changes only the hash, which reloads nothing: apply it in place, replacing the
  // map's layers and routes (`clear_layers`). The hash this hook writes goes through replaceState, which fires no
  // hashchange.
  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash;
      const restore = restoreRef.current;
      if (!restore || decodeState(hash) === null) return;
      setReady(false);
      dispatch({ type: "clear_layers" });
      void restore(hash);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [dispatch]);

  // The window's ends only, not the rest of the time state: each play step moves the window, so it rewrites the hash
  // (debounced below), while an index rebuild or a play/pause that leaves the window where it was does not.
  const start = state.time?.window[0];
  const end = state.time?.window[1];
  const timeMode = state.time?.mode;
  const { viewport, basemap, layers, renderOps, compare, terrain, flattened, errors } = state;
  // The scenario scrubber's layer and amount only, so a play/pause alone does not rewrite the hash.
  const scenarioLayer = state.scenario?.layerId;
  const scenarioValue = state.scenario?.value;
  const untouched = isInitialView(state);
  useEffect(() => {
    if (!ready || !catalog) return;
    // An empty catalog means the request failed; then ids are not filtered rather than all dropped.
    const servable = Object.keys(catalog).length > 0 ? catalog : undefined;
    const timer = window.setTimeout(() => {
      try {
        // A fresh page with nothing to share keeps a clean URL.
        if (untouched && window.location.hash === "") return;
        const time = start !== undefined && end !== undefined ? { start, end, mode: timeMode } : undefined;
        const scenario = scenarioLayer !== undefined && scenarioValue !== undefined ? { layerId: scenarioLayer, value: scenarioValue } : undefined;
        const hash = untouched
          ? ""
          : encodeState({ viewport, basemap, layers, renderOps, time, scenario, compare, terrain, flattened, failed: errors }, servable);
        const url = window.location.pathname + window.location.search + hash;
        window.history.replaceState(window.history.state, "", url);
      } catch {
        // A browser that refuses history updates only loses the shareable URL.
      }
    }, WRITE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [ready, catalog, untouched, viewport, basemap, layers, renderOps, start, end, timeMode, scenarioLayer, scenarioValue, compare, terrain, flattened, errors]);

  return { status };
}
