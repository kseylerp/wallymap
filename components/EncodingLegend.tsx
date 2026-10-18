"use client";

import { chipAttribute } from "@/lib/render/attributes";
import { channelText, rampCss, resolveEncoding, sizeWord } from "@/lib/render/encode";
import { frameSpread } from "@/lib/render/seriesLines";
import { frameIndex, layerFrames } from "@/lib/render/series";
import type { LoadedLayer, RenderOp, TimeState } from "@/lib/render/state";

function amount(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) >= 100 ? 0 : 1 });
}

/**
 * The legend lines for two measures on one mark (spec §13): what width (or size, or height) means and what color means,
 * each with its unit and the range the data spans, in the layer row under its source line. A size line carries a small
 * wedge, thin to thick; a color line the ramp as a bar from its low to its high end (a category its first and last
 * level). Nothing renders for a layer without a pair.
 */
export function EncodingLegend({ layer, op, data, time }: { layer: LoadedLayer; op: RenderOp; data: GeoJSON.FeatureCollection; time?: TimeState }) {
  const encoding = resolveEncoding(layer, op, data);
  if (!encoding) return null;
  // A flow field's particles: brighter is faster, the color the second variable.
  const flow = layer.result.kind === "geojson" && layer.result.flow !== undefined;
  const drawn = flow || op.mode === "lines" || op.mode === "points" || op.mode === "columns";
  if (!drawn) return null;
  const { size, color } = encoding;
  // A series line colors across the frame's own spread (lib/render/seriesLines.ts): the legend gives that day's range.
  const series = layer.result.kind === "geojson" ? layer.result.series : undefined;
  let colorText = color ? channelText(color) : "";
  // Particles colored by their own speed (wind, lib/render/particles.ts `flow.color`): the color line says speed, not the
  // declared second variable.
  const flowColor = layer.result.kind === "geojson" ? layer.result.flow?.color : undefined;
  if (flow && color && size && flowColor && flowColor !== color.key && flowColor === size.key) colorText = channelText(size);
  if (color && !color.levels && series && time?.index.series && layer.style.geometry === "line") {
    const k = layerFrames(layer, time.index.buckets)[frameIndex(time)] ?? series.now;
    const spread = frameSpread(data.features, color.key, Math.max(0, k));
    if (spread) colorText = `${color.label} ${amount(spread[0])}–${amount(spread[1])}${color.unit ? ` ${color.unit}` : ""} this ${series.step}`;
  }
  return (
    <div data-testid="encode-legend" className="mt-1.5 space-y-1 text-[11.5px] leading-4 text-ink">
      {size && (
        <p className="flex min-w-0 items-center gap-2" data-testid="encode-size">
          <svg aria-hidden width="28" height="10" viewBox="0 0 28 10" className="shrink-0 text-ink-muted">
            <path d="M1 5 L27 1.5 L27 8.5 Z" fill="currentColor" opacity="0.55" />
          </svg>
          <span className="min-w-0 truncate">
            <span className="small-caps mr-1 text-ink!">{flow ? "Brightness" : sizeWord(layer.style.geometry, op.mode)}</span>
            {channelText(size)}
          </span>
        </p>
      )}
      {color?.categorical && color.levels && color.key !== chipAttribute(layer)?.key && (
        // A category's kinds each in their own color: swatches, not a ramp. Left out when the row's chips are that same
        // category: they are the key, in the colors the map draws (two keys disagreed on pipelines, 2026-10-18).
        <ul className="flex flex-wrap gap-x-3 gap-y-0.5" data-testid="encode-color">
          {color.levels.map((l, i) => (
            <li key={`${l.label}-${i}`} className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full border border-white" style={{ background: l.color }} />
              <span className="min-w-0">{l.label}</span>
            </li>
          ))}
        </ul>
      )}
      {color && !color.categorical && (
        <p className="flex min-w-0 items-center gap-2" data-testid="encode-color">
          <span aria-hidden className="h-2 w-7 shrink-0 rounded-[2px]" style={{ background: `linear-gradient(to right, ${rampCss()})` }} />
          <span className="min-w-0 truncate">
            <span className="small-caps mr-1 text-ink!">Color</span>
            {colorText}
          </span>
        </p>
      )}
    </div>
  );
}
