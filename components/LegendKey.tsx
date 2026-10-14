"use client";

import { useId } from "react";
import type { LegendSymbol } from "@/lib/render/wally/legend";

/**
 * A legend key: a small inline SVG drawn the way the map draws the layer or feature (lib/render/wally/legend.ts), from
 * the same palette recipes: the point sprite, the line's casing, core and dash, the area's tint, 45° hatch at the map's
 * spacing and outline, a ramp's five steps, or raster tiles' dark grey hatch. Used by the layer panel and the inspect card.
 */
export function LegendKey({ symbol, size = 24 }: { symbol: LegendSymbol; size?: number }) {
  const hatchId = `hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const gradientId = `${hatchId}-gradient`;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden className="legend-key block shrink-0" data-kind={symbol.kind}>
      {symbol.kind === "symbol" && <image href={symbol.spriteUrl} x={0} y={0} width={24} height={24} />}
      {symbol.kind === "line" && (
        <>
          <line x1={1} y1={12} x2={23} y2={12} stroke={symbol.casing} strokeWidth={symbol.casingWidth} />
          {symbol.under && <line x1={1} y1={12} x2={23} y2={12} stroke={symbol.under} strokeWidth={symbol.width} />}
          <line
            x1={1}
            y1={12}
            x2={23}
            y2={12}
            stroke={symbol.color}
            strokeWidth={symbol.width}
            strokeDasharray={symbol.dash[0] > 0 ? `${symbol.dash[0]} ${symbol.dash[1]}` : undefined}
          />
        </>
      )}
      {symbol.kind === "gradient" && (
        <>
          <defs>
            <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={1} y1={0} x2={23} y2={0}>
              {symbol.colors.map((color, i) => (
                <stop key={i} offset={i / (symbol.colors.length - 1)} stopColor={color} />
              ))}
            </linearGradient>
          </defs>
          <line x1={1} y1={12} x2={23} y2={12} stroke={symbol.casing} strokeWidth={symbol.casingWidth} />
          <line x1={1} y1={12} x2={23} y2={12} stroke={`url(#${gradientId})`} strokeWidth={symbol.width} />
        </>
      )}
      {symbol.kind === "area" && (
        <>
          {symbol.spacing > 0 && (
            <defs>
              {/* Map hatches repeat every `spacing` px along each axis: at 45° that is spacing / √2 apart. */}
              <pattern
                id={hatchId}
                width={symbol.spacing / Math.SQRT2}
                height={symbol.spacing / Math.SQRT2}
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <line x1={0} y1={0} x2={0} y2={symbol.spacing} stroke={symbol.hatch} strokeOpacity={symbol.hatchAlpha} strokeWidth={1} />
              </pattern>
            </defs>
          )}
          <rect x={4.5} y={4.5} width={15} height={15} fill={symbol.tint} fillOpacity={symbol.tintAlpha} />
          {symbol.spacing > 0 && <rect x={4.5} y={4.5} width={15} height={15} fill={`url(#${hatchId})`} />}
          <rect x={4.5} y={4.5} width={15} height={15} fill="none" stroke={symbol.casing} strokeWidth={2.5} />
          <rect x={4.5} y={4.5} width={15} height={15} fill="none" stroke={symbol.outline} strokeWidth={1} />
        </>
      )}
      {symbol.kind === "ramp" && (
        <>
          {symbol.colors.map((color, i) => (
            <rect key={i} x={2 + i * 4} y={8} width={4} height={8} fill={color} />
          ))}
          <rect x={2.25} y={8.25} width={19.5} height={7.5} fill="none" stroke="currentColor" strokeOpacity={0.35} strokeWidth={0.5} />
        </>
      )}
      {symbol.kind === "tiles" && (
        <>
          <defs>
            <pattern id={hatchId} width={3} height={3} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1={0} y1={0} x2={0} y2={3} stroke={symbol.color} strokeWidth={0.75} />
            </pattern>
          </defs>
          <rect x={4.5} y={4.5} width={15} height={15} fill={`url(#${hatchId})`} stroke={symbol.color} strokeWidth={1} />
        </>
      )}
    </svg>
  );
}
