import type { ComponentType, SVGProps } from "react";
import { HybridIcon, PeaksIcon, SatelliteIcon } from "@/components/icons";
import type { Basemap } from "@/lib/render/state";

const OPTIONS: { value: Basemap; label: string; Icon: ComponentType<SVGProps<SVGSVGElement>> }[] = [
  { value: "outdoors-satellite", label: "Outdoors+Sat", Icon: HybridIcon },
  { value: "outdoors", label: "Outdoors", Icon: PeaksIcon },
  { value: "satellite", label: "Satellite", Icon: SatelliteIcon },
];

type BasemapSwitchProps = { value: Basemap; onChange: (basemap: Basemap) => void };

/** Glass segmented control for the basemap; labels collapse to icons on phones. */
export function BasemapSwitch({ value, onChange }: BasemapSwitchProps) {
  return (
    <div role="radiogroup" aria-label="Basemap" className="glass flex h-10 items-center gap-0.5 rounded-pill p-1">
      {OPTIONS.map(({ value: option, label, Icon }) => {
        const active = option === value;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => onChange(option)}
            className={[
              "flex h-8 items-center gap-1.5 rounded-pill px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors duration-200",
              active ? "bg-paper text-ink shadow-[0_1px_3px_rgba(31,30,27,0.14)]" : "text-ink-muted hover:text-ink",
            ].join(" ")}
          >
            <Icon width={16} height={16} className={active ? "text-accent" : undefined} />
            <span className="hidden md:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
