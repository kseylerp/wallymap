import { GlobeIcon, MinusIcon, PlusIcon } from "@/components/icons";

type MapControlsProps = {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onGlobe: () => void;
};

const BUTTON =
  "flex size-10 items-center justify-center text-ink transition-colors hover:bg-paper/80 active:bg-accent-soft";

/** Glass zoom and reset buttons in the bottom-right corner. Positioned by `.map-controls` in globals.css. */
export function MapControls({ onZoomIn, onZoomOut, onGlobe }: MapControlsProps) {
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
    </div>
  );
}
