import type { ComponentType, SVGProps } from "react";
import { HybridIcon, PeaksIcon, SatelliteIcon } from "@/components/icons";
import type { Basemap } from "@/lib/render/state";

const OPTIONS: { value: Basemap; label: string; Icon: ComponentType<SVGProps<SVGSVGElement>> }[] = [
  { value: "outdoors-satellite", label: "Outdoors+Sat", Icon: HybridIcon },
  { value: "outdoors", label: "Outdoors", Icon: PeaksIcon },
  { value: "satellite", label: "Satellite", Icon: SatelliteIcon },
];

type BasemapSwitchProps = { value: Basemap; onChange: (basemap: Basemap) => void };

/**
 * Glass segmented control for the basemap: one toggle button per style (`aria-pressed`, one tab stop each),
 * with a small amber dot on the active one. Labels collapse to icons on phones. `natural-earth-2` (agent-only)
 * has no button, so while it is showing nothing is pressed.
 */
export function BasemapSwitch({ value, onChange }: BasemapSwitchProps) {
  return (
    <div role="group" aria-label="Basemap" className="glass-strong flex h-10 items-center gap-0.5 rounded-pill p-1">
      {OPTIONS.map(({ value: option, label, Icon }) => {
        const active = option === value;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={active}
            aria-label={label}
            title={label}
            onClick={() => onChange(option)}
            className={[
              "relative flex h-8 items-center gap-1.5 rounded-pill px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors duration-200",
              active ? "bg-paper text-ink shadow-chip" : "text-ink-muted hover:bg-mist/70 hover:text-ink",
            ].join(" ")}
          >
            <Icon width={16} height={16} />
            <span className="hidden md:inline">{label}</span>
            {active && <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-accent md:static" />}
          </button>
        );
      })}
    </div>
  );
}
