import type { StyleHints } from "@/layers/types";
import { RASTER_AS_SERVED_OPACITY, RASTER_CALM } from "@/lib/render/palette";

/** The Mapbox raster paint for a layer's hint. Every property is set, so a re-sync always lands on the hint's values. */
export type RasterPaint = {
  "raster-opacity": number;
  "raster-saturation": number;
  "raster-hue-rotate": number;
  "raster-contrast": number;
  "raster-brightness-min": number;
  "raster-brightness-max": number;
};

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * The paint that calms a raster tile layer: the hint (or RASTER_CALM's defaults when unset) with `opacityScale`, the
 * layer panel's opacity, applied on top. `raster: null` leaves the tiles as served.
 */
export function rasterPaint(hint: StyleHints["raster"], opacityScale = 1): RasterPaint {
  if (hint === null) {
    return {
      "raster-opacity": RASTER_AS_SERVED_OPACITY * opacityScale,
      "raster-saturation": 0,
      "raster-hue-rotate": 0,
      "raster-contrast": 0,
      "raster-brightness-min": 0,
      "raster-brightness-max": 1,
    };
  }
  return {
    "raster-opacity": clamp(hint?.opacity ?? RASTER_CALM.opacity, 0, 1) * opacityScale,
    "raster-saturation": clamp(hint?.saturation ?? RASTER_CALM.saturation, -1, 1),
    "raster-hue-rotate": hint?.hueRotate ?? 0,
    "raster-contrast": clamp(hint?.contrast ?? 0, -1, 1),
    "raster-brightness-min": clamp(hint?.brightnessMin ?? 0, 0, 1),
    "raster-brightness-max": clamp(hint?.brightnessMax ?? 1, 0, 1),
  };
}

/** The CSS filter that approximates `rasterPaint` for a legend key, so the key and the map match. Empty when nothing is calmed. */
export function rasterKeyFilter(hint: StyleHints["raster"], withOpacity = false): string {
  if (hint === null) return "";
  const paint = rasterPaint(hint);
  const parts = [`saturate(${(1 + paint["raster-saturation"]).toFixed(2)})`];
  if (paint["raster-hue-rotate"] !== 0) parts.push(`hue-rotate(${paint["raster-hue-rotate"]}deg)`);
  if (paint["raster-brightness-max"] < 1) parts.push(`brightness(${paint["raster-brightness-max"]})`);
  // A legend swatch also takes the tiles' opacity, so its color is the one the map shows (rasters fixer, 2026-10-18).
  if (withOpacity && paint["raster-opacity"] < 1) parts.push(`opacity(${paint["raster-opacity"]})`);
  return parts.join(" ");
}
