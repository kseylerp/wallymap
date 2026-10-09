"use client";

import { Download, Layers } from "lucide-react";
import { WallyMark } from "@/components/Brand";
import type { Basemap } from "@/lib/render/state";

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
 * The map pills in the top-left corner: the WallyMap wordmark, the basemap switch, the
 * layers toggle and the export placeholder. (Zoom, globe and 3D live in MapControls, bottom right.) Labels
 * shorten on phones. `natural-earth-2` (agent-only) has no button, so while it shows nothing is pressed.
 */
export function MapPills({ basemap, onBasemapChange, layerCount = 0, layersOpen = false, onLayersOpenChange }: MapPillsProps) {
  return (
    <div data-testid="map-pills" className="flex flex-wrap items-center gap-1.5">
      <div className={`${PILL} rise-in gap-1.5 pr-3 pl-2 max-md:pr-2`}>
        <WallyMark size={20} />
        <h1 className="sr-only font-serif text-[15px] leading-none font-medium text-ink md:not-sr-only">WallyMap</h1>
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
        {/* aria-disabled rather than disabled, so the "Milestone 3" tooltip still shows on hover. */}
        <button
          type="button"
          aria-disabled
          aria-label="Export view"
          title="Milestone 3"
          className={`${SEG} w-7 cursor-not-allowed justify-center text-ink-muted/50`}
        >
          <Download size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>
    </div>
  );
}
