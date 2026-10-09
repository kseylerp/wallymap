"use client";

import { Download, Layers, Mountain, Satellite } from "lucide-react";
import type { ComponentType } from "react";
import { WallyMark } from "@/components/Brand";
import type { Basemap } from "@/lib/render/state";

/** The hybrid icon: a mountain over imagery. Lucide has no single glyph for it, so two are stacked. */
type IconProps = { size?: number; strokeWidth?: number; "aria-hidden"?: boolean };

function HybridIcon({ size = 16 }: IconProps) {
  return (
    <span aria-hidden className="relative inline-flex" style={{ width: size, height: size }}>
      <Satellite size={size} strokeWidth={1.75} className="opacity-45" />
      <Mountain size={size * 0.7} strokeWidth={2.25} className="absolute -right-0.5 -bottom-0.5" />
    </span>
  );
}

const BASEMAPS: { value: Basemap; label: string; Icon: ComponentType<IconProps> }[] = [
  { value: "outdoors-satellite", label: "Outdoors+Sat", Icon: HybridIcon },
  { value: "outdoors", label: "Outdoors", Icon: Mountain },
  { value: "satellite", label: "Satellite", Icon: Satellite },
];

type MapPillsProps = {
  basemap: Basemap;
  onBasemapChange: (basemap: Basemap) => void;
  /** Loaded layers; the layers pill shows only when there is at least one. */
  layerCount?: number;
  layersOpen?: boolean;
  onLayersOpenChange?: (open: boolean) => void;
};

/** Every map pill: 36px, Wally's black glass over imagery, white text. */
const PILL = "glass-dark flex h-9 items-center rounded-pill text-white";
/** A round or labelled button inside a pill. */
const SEG =
  "press relative flex h-7 items-center gap-1.5 rounded-pill text-[13px] font-medium whitespace-nowrap transition duration-150 ease-out";
const IDLE = "text-white/80 hover:bg-white/15 hover:text-white";
/** Pressed and active states are black with white text; the icon turns coral (Wally's active map pill). */
const ACTIVE = "bg-primary text-on-primary shadow-chip ring-1 ring-white/25 [&_svg]:text-coral";

/**
 * The map pills in the top-left corner: the WallyMap wordmark, the basemap switch, the
 * layers toggle and the export placeholder. (Zoom, globe and 3D live in MapControls, bottom right.) Labels
 * collapse to icons on phones. `natural-earth-2` (agent-only) has no button, so while it shows nothing is pressed.
 */
export function MapPills({ basemap, onBasemapChange, layerCount = 0, layersOpen = false, onLayersOpenChange }: MapPillsProps) {
  return (
    <div data-testid="map-pills" className="flex flex-wrap items-center gap-2">
      <div className={`${PILL} rise-in gap-1.5 pr-3 pl-2 max-md:pr-2`}>
        <WallyMark size={22} />
        <h1 className="sr-only font-serif text-[1.05rem] leading-none font-semibold tracking-[-0.01em] md:not-sr-only">WallyMap</h1>
      </div>

      <div role="group" aria-label="Basemap" className={`${PILL} rise-in gap-0.5 p-1`} style={{ animationDelay: "60ms" }}>
        {BASEMAPS.map(({ value, label, Icon }) => {
          const active = value === basemap;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={active}
              aria-label={label}
              title={label}
              onClick={() => onBasemapChange(value)}
              className={`${SEG} px-2 md:px-2.5 ${active ? ACTIVE : IDLE}`}
            >
              <Icon size={16} strokeWidth={2} aria-hidden />
              <span className="hidden md:inline">{label}</span>
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
            <Layers size={16} strokeWidth={2} aria-hidden />
            <span className="hidden md:inline">Layers</span>
            <span className="stat min-w-5 rounded-pill bg-white/20 px-1.5 text-center text-[11px] leading-5 font-semibold">
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
          className={`${SEG} w-7 cursor-not-allowed justify-center text-white/45`}
        >
          <Download size={16} strokeWidth={2} aria-hidden />
        </button>
      </div>
    </div>
  );
}
