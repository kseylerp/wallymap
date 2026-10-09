"use client";

import { Download, Layers } from "lucide-react";
import { useCallback, useState } from "react";
import { WallyMark } from "@/components/Brand";
import type { LayerCatalog } from "@/lib/agent/applyToolResult";
import { buildExportBundle, downloadBundle, formatBytes, MAX_LOOSE_FILES, type ExportBundle } from "@/lib/export/exportView";
import type { Basemap, MapState } from "@/lib/render/state";

/** Text-only basemap segments; phones (under 768px) get the short labels. The ids stay the Mapbox style names. */
const BASEMAPS: { value: Basemap; label: string; short: string }[] = [
  { value: "outdoors-satellite", label: "Topographical + Satellite", short: "Topo + Sat" },
  { value: "outdoors", label: "Topographical", short: "Topo" },
  { value: "satellite", label: "Satellite", short: "Sat" },
];

type MapPillsProps = {
  basemap: Basemap;
  onBasemapChange: (basemap: Basemap) => void;
  /** Loaded layers; the layers pill shows only when there is at least one. */
  layerCount?: number;
  layersOpen?: boolean;
  onLayersOpenChange?: (open: boolean) => void;
  /** The map state and layer catalog the Export pill packs; without the state, Export stays off. */
  mapState?: MapState;
  catalog?: LayerCatalog | null;
  /** Muted status next to Export while a shared link's layers are coming back, e.g. "Restoring 3 layers…". */
  restoreStatus?: string | null;
};

/** Every map pill: 36px, the off-white surface with ink text, a hairline rim and a barely-there shadow. */
const PILL = "map-pill flex h-9 items-center rounded-pill text-ink";
/** A labelled or round button inside a pill. Hover only shifts the background. */
const SEG =
  "relative flex h-7 items-center gap-1.5 rounded-pill text-[13px] whitespace-nowrap transition-colors duration-150 ease-out";
const IDLE = "text-ink hover:bg-mist/70";
/** Pressed segments are the black primary button. */
const ACTIVE = "bg-primary text-on-primary";

/**
 * The map pills in the top-left corner: the Wally logo, the basemap switch, the
 * layers toggle and Export (which asks to confirm before downloading). (Zoom, globe and 3D live in MapControls, bottom right.) Labels
 * shorten on phones. `natural-earth-2` (agent-only) has no button, so while it shows nothing is pressed.
 */
export function MapPills({
  basemap,
  onBasemapChange,
  layerCount = 0,
  layersOpen = false,
  onLayersOpenChange,
  mapState,
  catalog = null,
  restoreStatus = null,
}: MapPillsProps) {
  // Export is two steps: the pill opens a confirm that lists the files and their size; only its Export button downloads.
  const [pending, setPending] = useState<ExportBundle | null>(null);
  const [exporting, setExporting] = useState(false);
  const canExport = layerCount > 0 && mapState !== undefined && !exporting;
  const askExport = useCallback(() => {
    if (mapState) setPending(buildExportBundle(mapState, catalog));
  }, [mapState, catalog]);
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
  // Without layers there is nothing to export, so a confirm left open from before is closed.
  const exportOpen = pending !== null && layerCount > 0;

  return (
    <div data-testid="map-pills" className="flex flex-wrap items-center gap-1.5">
      <div role="img" aria-label="WallyMap" title="WallyMap" className={`${PILL} rise-in size-9 justify-center`}>
        <WallyMark size={20} />
      </div>

      <div role="group" aria-label="Basemap" className={`${PILL} rise-in gap-0.5 p-1`} style={{ animationDelay: "60ms" }}>
        {BASEMAPS.map(({ value, label, short }) => {
          const active = value === basemap;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={active}
              aria-label={label}
              title={label}
              onClick={() => onBasemapChange(value)}
              className={`${SEG} px-2.5 ${active ? `${ACTIVE} font-medium` : IDLE}`}
            >
              <span aria-hidden className="md:hidden">
                {short}
              </span>
              <span aria-hidden className="max-md:hidden">
                {label}
              </span>
            </button>
          );
        })}
      </div>

      {layerCount > 0 && onLayersOpenChange && (
        <div className={`${PILL} rise-in p-1`} style={{ animationDelay: "120ms" }}>
          <button
            type="button"
            onClick={() => onLayersOpenChange(!layersOpen)}
            aria-pressed={layersOpen}
            aria-label={`Layers, ${layerCount} loaded`}
            title={layersOpen ? "Hide layers" : "Show layers"}
            className={`${SEG} pr-1.5 pl-2 ${layersOpen ? ACTIVE : IDLE}`}
          >
            <Layers size={14} strokeWidth={2} aria-hidden />
            <span className="hidden md:inline">Layers</span>
            <span
              className={`stat min-w-5 rounded-pill px-1.5 text-center text-[11px] leading-5 font-semibold ${
                layersOpen ? "bg-white/20" : "bg-mist"
              }`}
            >
              {layerCount}
            </span>
          </button>
        </div>
      )}

      <div className={`${PILL} rise-in p-1`} style={{ animationDelay: "180ms" }}>
        {/* aria-disabled rather than disabled, so the tooltip still shows on hover while no layer is loaded. */}
        <button
          type="button"
          aria-disabled={!canExport}
          aria-label="Export view"
          title={layerCount > 0 ? "Export view: GeoJSON and citations" : "Load a layer to export the view"}
          aria-expanded={exportOpen}
          onClick={() => {
            if (!canExport) return;
            if (exportOpen) cancelExport();
            else askExport();
          }}
          className={`${SEG} w-7 justify-center ${canExport ? IDLE : "cursor-not-allowed text-ink-muted/50"}`}
        >
          <Download size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>

      {restoreStatus && (
        <div role="status" className={`${PILL} rise-in px-3 text-[13px] text-ink-muted`}>
          {restoreStatus}
        </div>
      )}

      {exportOpen && pending && (
        <div className="basis-full">
          <div
            role="dialog"
            aria-label="Confirm export"
            onKeyDown={(e) => e.key === "Escape" && cancelExport()}
            className="map-pill rise-in w-fit max-w-full rounded-card px-4 py-3 text-[13px] text-ink"
          >
            <p className="font-medium">
              {`Export ${pending.files.length} ${pending.files.length === 1 ? "file" : "files"} (${formatBytes(
                pending.files.reduce((sum, f) => sum + f.blob.size, 0),
              )})?`}
            </p>
            <ul className="mt-1 text-ink-muted">
              {pending.files.map((f) => (
                <li key={f.name}>
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
                className="press rounded-pill bg-primary px-3 py-1 font-medium text-on-primary"
              >
                Export
              </button>
              <button type="button" onClick={cancelExport} className={`${SEG} px-3 ${IDLE}`}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
