"use client";

import { useCallback, useState } from "react";
import type { LayerCatalog } from "@/lib/agent/applyToolResult";
import { buildExportBundle, downloadBundle, formatBytes, MAX_LOOSE_FILES, type ExportBundle } from "@/lib/export/exportView";
import type { MapState } from "@/lib/render/state";

const SEG = "relative flex h-7 items-center gap-1.5 rounded-pill text-[13px] whitespace-nowrap transition-colors duration-150 ease-out";
const IDLE = "text-ink hover:bg-mist/70";
/** A quiet text action, as the console's Clear all and Close. */
const TEXT_BUTTON = "text-[12px] text-ink-muted transition-colors duration-150 hover:text-ink";

/** True while at least one loaded layer is shown: then there is something to export. */
export function hasLayerOn(state: MapState): boolean {
  return state.renderOps.some((op) => op.visible && state.layers[op.layerId] !== undefined);
}

/**
 * "Export map…" at the foot of the Layers console, shown only while a layer is on. It is two steps: the action opens a
 * confirm that lists the files and their size; only the confirm's Export button downloads (GeoJSON and citations).
 */
export function ExportControl({ mapState, catalog = null }: { mapState: MapState; catalog?: LayerCatalog | null }) {
  const [pending, setPending] = useState<ExportBundle | null>(null);
  const [exporting, setExporting] = useState(false);
  const on = hasLayerOn(mapState);
  const askExport = useCallback(() => setPending(buildExportBundle(mapState, catalog)), [mapState, catalog]);
  const cancelExport = useCallback(() => setPending(null), []);
  const confirmExport = useCallback(async () => {
    if (!pending) return;
    setExporting(true);
    try {
      await downloadBundle(pending);
    } finally {
      setExporting(false);
      setPending(null);
    }
  }, [pending]);
  // With no layer on there is nothing to export: a confirm left open is dropped, so it cannot reappear with the next one.
  if (!on && pending !== null) setPending(null);
  if (!on) return null;
  const exportOpen = pending !== null;

  return (
    <div data-testid="export-control">
      <button
        type="button"
        aria-label="Export map"
        title="Export map: GeoJSON and citations"
        aria-expanded={exportOpen}
        disabled={exporting}
        onClick={() => (exportOpen ? cancelExport() : askExport())}
        className={TEXT_BUTTON}
      >
        Export map…
      </button>
      {exportOpen && pending && (
        <div
          role="dialog"
          aria-label="Confirm export"
          onKeyDown={(e) => e.key === "Escape" && cancelExport()}
          className="map-pill rise-in mt-2 w-fit max-w-full rounded-card px-4 py-3 text-[13px] text-ink"
        >
          <p className="font-medium">
            {`Export ${pending.files.length} ${pending.files.length === 1 ? "file" : "files"} (${formatBytes(pending.files.reduce((sum, f) => sum + f.blob.size, 0))})?`}
          </p>
          <ul className="mt-1 text-ink-muted">
            {pending.files.map((f) => (
              <li key={f.name} className="break-all">
                {f.name} <span className="stat">{formatBytes(f.blob.size)}</span>
              </li>
            ))}
          </ul>
          {pending.files.length > MAX_LOOSE_FILES && <p className="mt-1 text-ink-muted">Saved as one zip.</p>}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              autoFocus
              disabled={exporting}
              onClick={() => void confirmExport()}
              className="press rounded-[12px] bg-primary px-3 py-1 font-semibold text-on-primary transition-colors duration-150 hover:bg-primary-hover"
            >
              Export
            </button>
            <button type="button" onClick={cancelExport} className={`${SEG} px-3 ${IDLE}`}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
