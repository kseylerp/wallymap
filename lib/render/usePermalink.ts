"use client";

import { useEffect, useRef, useState, type Dispatch } from "react";
import type { LayerCatalog } from "@/lib/agent/applyToolResult";
import type { LayerError, LayerResult } from "@/layers/types";
import { decodeState, encodeState, restoreFromPermalink, type FetchLayer, type PermalinkTime } from "@/lib/render/permalink";
import { initialMapState, type MapAction, type MapState } from "@/lib/render/state";

const WRITE_DELAY_MS = 500;
const FAILURE_NOTICE_MS = 6000;

/** Asks `/api/layer/<id>` for the layer's default input over the box; a failed request comes back as a layer error. */
const fetchLayer: FetchLayer = async (id, bbox, zoom) => {
  const res = await fetch(`/api/layer/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bbox, zoom }),
  });
  return (await res.json()) as LayerResult | LayerError;
};

async function fetchCatalog(): Promise<LayerCatalog> {
  try {
    const res = await fetch("/api/layers");
    if (!res.ok) return {};
    const entries = (await res.json()) as { id: string; title: string; style: LayerCatalog[string]["style"]; license?: string }[];
    return Object.fromEntries(entries.map((e) => [e.id, { title: e.title, style: e.style, license: e.license }]));
  } catch {
    return {};
  }
}

function isInitialView(state: MapState): boolean {
  const a = state.viewport;
  const b = initialMapState.viewport;
  return (
    Object.keys(state.layers).length === 0 &&
    state.basemap === initialMapState.basemap &&
    a.longitude === b.longitude &&
    a.latitude === b.latitude &&
    a.zoom === b.zoom &&
    a.pitch === b.pitch &&
    a.bearing === b.bearing
  );
}

/**
 * Keeps the URL hash and the map in step. On mount, a hash that names a view or layers is replayed into the map
 * (layers are fetched again, so a link carries ids, not data). After that, the camera, basemap, layer ids and time
 * window are written back to the hash 500 ms after they stop changing. `status` is a short line to show while layers
 * are coming back ("Restoring 3 layers…") or when some could not be; null otherwise.
 */
export function usePermalink(state: MapState, dispatch: Dispatch<MapAction>): { status: string | null } {
  const [status, setStatus] = useState<string | null>(null);
  // Writing waits until the hash has been read (and any layers restored), or the first write would erase it.
  const [ready, setReady] = useState(() => typeof window === "undefined" || decodeState(window.location.hash) === null);
  // The layer ids `/api/layer/<id>` can serve; a link names only those (route results and drawn layers cannot be replayed).
  const [catalog, setCatalog] = useState<LayerCatalog | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    // Strict mode runs effects twice in development; the restore must run once.
    if (startedRef.current) return;
    startedRef.current = true;
    const hash = window.location.hash;
    const wantsRestore = decodeState(hash) !== null;
    void (async () => {
      const catalog = await fetchCatalog();
      setCatalog(catalog);
      if (!wantsRestore) return;
      const outcome = await restoreFromPermalink(hash, dispatch, fetchLayer, {
        catalog,
        canvas: { width: window.innerWidth, height: window.innerHeight },
        onStart: (count) => {
          if (count > 0) setStatus(`Restoring ${count} ${count === 1 ? "layer" : "layers"}…`);
        },
      });
      setReady(true);
      if (outcome && outcome.failed.length > 0) {
        setStatus(`Could not restore ${outcome.failed.length} of ${outcome.failed.length + outcome.restored.length} layers`);
        window.setTimeout(() => setStatus(null), FAILURE_NOTICE_MS);
      } else {
        setStatus(null);
      }
    })();
  }, [dispatch]);

  const time = (state as MapState & { time?: PermalinkTime }).time;
  const { viewport, basemap, layers, renderOps } = state;
  const untouched = isInitialView(state);
  useEffect(() => {
    if (!ready || !catalog) return;
    // An empty catalog means the request failed; then ids are not filtered rather than all dropped.
    const servable = Object.keys(catalog).length > 0 ? catalog : undefined;
    const timer = window.setTimeout(() => {
      try {
        // A fresh page with nothing to share keeps a clean URL.
        if (untouched && window.location.hash === "") return;
        const hash = untouched ? "" : encodeState({ viewport, basemap, layers, renderOps, time }, servable);
        const url = window.location.pathname + window.location.search + hash;
        window.history.replaceState(window.history.state, "", url);
      } catch {
        // A browser that refuses history updates only loses the shareable URL.
      }
    }, WRITE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [ready, catalog, untouched, viewport, basemap, layers, renderOps, time]);

  return { status };
}
