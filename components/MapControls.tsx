import { GlobeIcon, MinusIcon, PlusIcon } from "@/components/icons";

type MapControlsProps = {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onGlobe: () => void;
  /** 3D (terrain and a tilted camera) is on; the button reads pressed. */
  threeD: boolean;
  onToggle3D: () => void;
};

const BUTTON_BASE = "flex size-10 items-center justify-center transition-colors hover:bg-paper/80 active:bg-mist";
const BUTTON = `${BUTTON_BASE} text-ink`;

/** Glass zoom, reset and 3D buttons in the bottom-right corner. Positioned by `.map-controls` in globals.css. */
export function MapControls({ onZoomIn, onZoomOut, onGlobe, threeD, onToggle3D }: MapControlsProps) {
  return (
    <div className="map-controls rise-in absolute right-3 z-10 flex flex-col items-center gap-2 md:right-4" style={{ animationDelay: "180ms" }}>
      <div className="glass flex flex-col overflow-hidden rounded-pill">
        <button type="button" onClick={onZoomIn} aria-label="Zoom in" title="Zoom in" className={BUTTON}>
          <PlusIcon />
        </button>
        <span aria-hidden className="mx-2.5 h-px bg-line" />
        <button type="button" onClick={onZoomOut} aria-label="Zoom out" title="Zoom out" className={BUTTON}>
          <MinusIcon />
        </button>
      </div>
      <button
        type="button"
        onClick={onGlobe}
        aria-label="Show the whole globe"
        title="Whole globe"
        className={`glass rounded-full ${BUTTON}`}
      >
        <GlobeIcon />
      </button>
      <button
        type="button"
        onClick={onToggle3D}
        aria-pressed={threeD}
        aria-label="3D terrain"
        title={threeD ? "Flatten the map" : "Show 3D terrain"}
        // Pressed: the primary button look (black with white text in both themes; globals.css makes it beat `.glass`
        // for pressed map controls). Off: the normal glass.
        className={`glass rounded-full text-[13px] font-semibold tracking-tight ${
          threeD ? `${BUTTON_BASE} bg-primary text-on-primary` : BUTTON
        }`}
      >
        3D
      </button>
    </div>
  );
}
