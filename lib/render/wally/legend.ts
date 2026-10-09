import type { Feature } from "geojson";
import { LAYER_LINE_DASH, LINE_DASHES } from "@/lib/render/palette";
import type { RenderMode } from "@/lib/render/state";
import { pinIconFor } from "@/lib/render/wally/pins";

/**
 * The layer panel's legend key for one layer (spec §10, "research look"): what the map draws for it, in the same
 * monochrome terms. Points show their symbol sprite (pins.ts), lines a sample with the layer's dash pattern (the
 * same table deck.ts draws with), polygons an outlined square with a light ink wash, score layers a gray ramp,
 * raster tiles a hatched square. The panel draws each key as an inline SVG in `currentColor`.
 */
export type LegendKind = "symbol" | "line" | "polygon" | "tiles" | "score";

export type LegendSymbol = {
  kind: LegendKind;
  /** Points: the layer's symbol sprite in `public/pins/`. */
  spriteUrl?: string;
  /** Lines: deck's [dash, gap] in line widths; [0, 0] is solid. */
  dash?: [number, number];
};

/** How a layer is drawn: a render mode, or `tiles` for raster imagery. */
export type LegendMode = RenderMode | "tiles";

/** Layers that shade areas by a 0 to 100 score, when the caller does not pass the layer's unit. */
const SCORE_LAYERS: ReadonlySet<string> = new Set(["remoteness", "popularity"]);

/** Line layers with no named dash take one of these by a stable hash of their id. Kept in step with deck.ts. */
const FALLBACK_DASHES = ["dashed", "dotted", "long"] as const;

/** The dash pattern that marks a line layer: trails solid, forest roads dashed, others by a stable hash. */
export function legendDash(layerId: string): [number, number] {
  const named = LAYER_LINE_DASH[layerId];
  if (named) return [...LINE_DASHES[named]];
  let hash = 0;
  for (const ch of layerId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return [...LINE_DASHES[FALLBACK_DASHES[hash % FALLBACK_DASHES.length]]];
}

/** A feature with no properties: campsite layers then read as camp sites (triangles), not parking. */
const BLANK: Feature = { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: {} };

/**
 * The legend key for a layer drawn in `mode`. `unit` is the layer's style unit; `"score"` polygons get the ramp.
 * Heat reads as a ramp too (density, not features); columns and hexbin are not drawn yet and fall back to symbols.
 */
export function legendSymbol(layerId: string, mode: LegendMode, unit?: string): LegendSymbol {
  switch (mode) {
    case "tiles":
      return { kind: "tiles" };
    case "lines":
      return { kind: "line", dash: legendDash(layerId) };
    case "polygons":
      return unit === "score" || (unit === undefined && SCORE_LAYERS.has(layerId)) ? { kind: "score" } : { kind: "polygon" };
    case "heat":
      return { kind: "score" };
    default:
      return { kind: "symbol", spriteUrl: pinIconFor(layerId, BLANK).url };
  }
}
