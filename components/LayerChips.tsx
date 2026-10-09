import { EyeIcon, EyeOffIcon } from "@/components/icons";
import { SLATE } from "@/lib/render/deck";
import type { LoadedLayer, MapState, RenderOp } from "@/lib/render/state";

type LayerChipsProps = {
  layers: MapState["layers"];
  renderOps: RenderOp[];
  onToggle: (layerId: string) => void;
};

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function featureCount(layer: LoadedLayer): number | null {
  return layer.result.kind === "geojson" ? layer.result.data.features.length : null;
}

/** The stroke the map actually draws: a valid render-op color, else slate for points, else the style color. */
function drawnColor(layer: LoadedLayer, op: RenderOp | undefined): string {
  if (op?.color && HEX.test(op.color.trim())) return op.color;
  return op?.mode === "points" ? SLATE : layer.style.color;
}

/** One glass pill per loaded layer: color dot, title, feature count and a show/hide toggle. */
export function LayerChips({ layers, renderOps, onToggle }: LayerChipsProps) {
  const loaded = Object.values(layers);
  if (loaded.length === 0) return null;
  return (
    <ul aria-label="Map layers" className="pointer-events-auto flex flex-col items-end gap-2">
      {loaded.map((layer, i) => {
        const op = renderOps.find((o) => o.layerId === layer.id);
        const visible = op?.visible ?? false;
        const count = featureCount(layer);
        const countText = count === null ? "" : `, ${count.toLocaleString()} ${count === 1 ? "feature" : "features"}`;
        return (
          <li
            key={layer.id}
            className={`glass-strong rise-in flex h-10 items-center gap-2 rounded-pill py-1 pr-1 pl-3 transition-opacity ${visible ? "" : "opacity-70"}`}
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-full ring-2 ring-paper"
              style={{ backgroundColor: drawnColor(layer, op) }}
            />
            <span aria-hidden className="hidden max-w-[220px] truncate text-[13px] font-medium text-ink sm:inline">
              {layer.title}
            </span>
            {count !== null && (
              // Text is --ink on the amber badge: 6.5:1 (white on amber is only 2.7:1).
              <span
                aria-hidden
                className="rounded-pill bg-accent px-2 py-0.5 text-[11px] leading-4 font-semibold text-ink tabular-nums"
              >
                {count.toLocaleString()}
              </span>
            )}
            {/* The constant name carries the title and count; aria-pressed says whether the layer is shown. */}
            <button
              type="button"
              onClick={() => onToggle(layer.id)}
              disabled={!op}
              aria-pressed={visible}
              aria-label={`Show ${layer.title}${countText}`}
              title={visible ? "Hide layer" : "Show layer"}
              className="flex size-8 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-mist hover:text-ink disabled:opacity-40"
            >
              {visible ? <EyeIcon width={16} height={16} /> : <EyeOffIcon width={16} height={16} />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
