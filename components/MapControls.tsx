import type { ReactNode } from "react";

type MapControlsProps = {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onGlobe: () => void;
  /** 3D (terrain and a tilted camera) is on; the button reads pressed. */
  threeD: boolean;
  onToggle3D: () => void;
};

const BUTTON_BASE = "flex size-9 items-center justify-center transition-colors duration-150 hover:bg-mist/70 active:bg-mist";
const BUTTON = `${BUTTON_BASE} text-ink`;

/** A plain ink glyph on a 16px grid: 1.5px strokes, no fill. */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      {children}
    </svg>
  );
}

/**
 * Zoom, whole-globe and 3D in the bottom-right corner: the map pills' off-white surface with ink glyphs (+, −, ⊕ and
 * the text "3D"), no icon set. Positioned by `.map-controls` in globals.css.
 */
export function MapControls({ onZoomIn, onZoomOut, onGlobe, threeD, onToggle3D }: MapControlsProps) {
  return (
    <div className="map-controls rise-in absolute right-[max(12px,var(--safe-right))] z-10 flex flex-col items-center gap-2 md:right-[max(16px,var(--safe-right))]" style={{ animationDelay: "180ms" }}>
      <div className="map-pill flex flex-col overflow-hidden rounded-[10px]">
        <button type="button" onClick={onZoomIn} aria-label="Zoom in" title="Zoom in" className={BUTTON}>
          <Glyph>
            <path d="M8 3v10M3 8h10" />
          </Glyph>
        </button>
        <span aria-hidden className="mx-2 h-px bg-line" />
        <button type="button" onClick={onZoomOut} aria-label="Zoom out" title="Zoom out" className={BUTTON}>
          <Glyph>
            <path d="M3 8h10" />
          </Glyph>
        </button>
      </div>
      <button
        type="button"
        onClick={onGlobe}
        aria-label="Show the whole globe"
        title="Whole globe"
        className={`map-pill overflow-hidden rounded-[10px] ${BUTTON}`}
      >
        <Glyph>
          <circle cx={8} cy={8} r={5.75} />
          <path d="M8 2.25v11.5M2.25 8h11.5" />
        </Glyph>
      </button>
      <button
        type="button"
        onClick={onToggle3D}
        aria-pressed={threeD}
        aria-label="3D terrain"
        title={threeD ? "Flatten the map" : "Show 3D terrain"}
        // Pressed: the selected chip (deep sage outline on white; globals.css makes it beat the pill surface for pressed
        // map controls). Off: the off-white pill.
        className={`map-pill overflow-hidden rounded-[10px] text-[12px] font-medium tracking-tight tabular-nums ${
          threeD ? `${BUTTON_BASE} control-on` : BUTTON
        }`}
      >
        3D
      </button>
    </div>
  );
}
