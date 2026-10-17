"use client";

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
  /**
   * Compare over time while the data console is closed: the pill shows when this is set (a layer can be compared) and
   * reads pressed while a compare is on. The control itself lives in the console (components/CompareControl.tsx).
   */
  onCompare?: () => void;
  comparing?: boolean;
  /** The logo was pressed: reset the map and its filters (the app decides what that means). */
  onResetMap?: () => void;
  /** The suggestions card shows; the "i" pill reads pressed while it does. The pill shows when the toggle is set. */
  suggestionsOpen?: boolean;
  onToggleSuggestions?: () => void;
};

/** Every map pill: 36px, the off-white surface with ink text, a hairline rim and a barely-there shadow. */
const PILL = "map-pill flex h-9 items-center rounded-pill text-ink";
/** A labelled or round button inside a pill. Hover only shifts the background. */
const SEG =
  "relative flex h-7 items-center gap-1.5 rounded-pill text-[13px] whitespace-nowrap transition-colors duration-150 ease-out";
const IDLE = "text-ink hover:bg-mist/70";
/** Pressed segments are the selected chip: a deep sage outline and text on white, as on wally.guide. */
const ACTIVE = "control-on";

/**
 * The map pills in the top-left corner: the Wally logo (a button that resets the map), the basemap switch, the
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
  onCompare,
  comparing = false,
  onResetMap,
  suggestionsOpen = false,
  onToggleSuggestions,
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
  // Without layers there is nothing to export: a confirm left open is dropped, so it cannot reappear with the next layer.
  if (layerCount === 0 && pending !== null) setPending(null);
  const exportOpen = pending !== null && layerCount > 0;

  return (
    <div data-testid="map-pills" className="flex flex-wrap items-center gap-1.5">
      <h1 className="sr-only">WallyMap</h1>
      <button
        type="button"
        aria-label="Reset map"
        title="Reset map"
        onClick={onResetMap}
        className={`${PILL} rise-in size-9 justify-center`}
      >
        <WallyMark size={20} />
      </button>

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
            className={`${SEG} px-2.5 ${layersOpen ? ACTIVE : IDLE}`}
          >
            Layers<span aria-hidden className="opacity-50">·</span>
            <span className="tabular-nums">{layerCount}</span>
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
          className={`${SEG} px-2.5 ${canExport ? IDLE : "cursor-not-allowed text-ink-muted/50"}`}
        >
          Export
        </button>
      </div>

      {onToggleSuggestions && (
        // A single serif "i" (text, not an icon font), the size of the logo pill; it opens or closes the suggestions card.
        <button
          type="button"
          aria-label="Suggestions"
          title="Suggestions"
          aria-pressed={suggestionsOpen}
          onClick={onToggleSuggestions}
          className={`${PILL} rise-in size-9 justify-center font-serif text-[18px] leading-none transition-colors duration-150 ease-out hover:bg-mist/70`}
          style={{ animationDelay: "240ms" }}
        >
          i
        </button>
      )}

      {onCompare && (
        <div className={`${PILL} rise-in p-1`}>
          <button
            type="button"
            onClick={onCompare}
            aria-pressed={comparing}
            data-testid="compare-pill"
            title={comparing ? "Show the compare in the data console" : "Compare one layer at two times"}
            className={`${SEG} px-2.5 ${comparing ? ACTIVE : IDLE}`}
          >
            Compare
          </button>
        </div>
      )}

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
                className="press rounded-[12px] bg-primary px-3 py-1 font-semibold text-on-primary transition-colors duration-150 hover:bg-primary-hover"
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
