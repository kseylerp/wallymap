"use client";

import { channelText, rampCss, resolveEncoding, sizeWord } from "@/lib/render/encode";
import type { LoadedLayer, RenderOp } from "@/lib/render/state";

/**
 * The legend lines for two measures on one mark (spec §13): what width (or size, or height) means and what color means,
 * each with its unit and the range the data spans, in the layer row under its source line. A size line carries a small
 * wedge, thin to thick; a color line the ramp as a bar from its low to its high end (a category its first and last
 * level). Nothing renders for a layer without a pair.
 */
export function EncodingLegend({ layer, op, data }: { layer: LoadedLayer; op: RenderOp; data: GeoJSON.FeatureCollection }) {
  const encoding = resolveEncoding(layer, op, data);
  if (!encoding) return null;
  const drawn = op.mode === "lines" || op.mode === "points" || op.mode === "columns";
  if (!drawn) return null;
  const { size, color } = encoding;
  return (
    <div data-testid="encode-legend" className="mt-1.5 space-y-1 text-[11.5px] leading-4 text-ink">
      {size && (
        <p className="flex min-w-0 items-center gap-2" data-testid="encode-size">
          <svg aria-hidden width="28" height="10" viewBox="0 0 28 10" className="shrink-0 text-ink-muted">
            <path d="M1 5 L27 1.5 L27 8.5 Z" fill="currentColor" opacity="0.55" />
          </svg>
          <span className="min-w-0 truncate">
            <span className="small-caps mr-1 text-ink!">{sizeWord(layer.style.geometry, op.mode)}</span>
            {channelText(size)}
          </span>
        </p>
      )}
      {color && (
        <p className="flex min-w-0 items-center gap-2" data-testid="encode-color">
          <span aria-hidden className="h-2 w-7 shrink-0 rounded-[2px]" style={{ background: `linear-gradient(to right, ${rampCss()})` }} />
          <span className="min-w-0 truncate">
            <span className="small-caps mr-1 text-ink!">Color</span>
            {channelText(color)}
          </span>
        </p>
      )}
    </div>
  );
}
