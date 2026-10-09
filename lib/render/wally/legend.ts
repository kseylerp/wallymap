import type { Feature } from "geojson";
import { lineDashFor, POLYGON_INK_FILL } from "@/lib/render/palette";
import type { RenderMode } from "@/lib/render/state";
import { pinIconFor } from "@/lib/render/wally/pins";

/**
 * The layer panel's legend key for one layer (spec §10, "research look"): what the map draws for it, in the same
 * monochrome terms. Points show their symbol sprite (pins.ts), lines a sample with the layer's dash pattern (the
 * same `lineDashFor` deck draws with), polygons an outlined square with the layer's ink wash (none for boundary
 * layers), score layers a gray ramp, raster tiles a hatched square. The panel draws each key as an inline SVG in `currentColor`.
 */
export type LegendKind = "symbol" | "line" | "polygon" | "tiles" | "score";

export type LegendSymbol = {
  kind: LegendKind;
  /** Points: the layer's symbol sprite in `public/pins/`. */
  spriteUrl?: string;
  /** Lines: deck's [dash, gap] in line widths; [0, 0] is solid. */
  dash?: [number, number];
  /** Polygons: the ink wash as a share of ink, 0 for an outline only. */
  fill?: number;
};

/**
 * How a layer is drawn: a render mode, `tiles` for raster imagery, or `vector-polygons` for vector tile areas
 * (public lands), which Mapbox draws as a gray tint (components/mapTiles.ts).
 */
export type LegendMode = RenderMode | "tiles" | "vector-polygons";

/** Deck's wash for polygon layers not listed in POLYGON_INK_FILL. */
const POLYGON_FILL_DEFAULT = 0.1;
/** Vector tile areas: the regional stop of the public-lands tint (landFillOpacity in components/mapTiles.ts). */
const VECTOR_TILE_FILL = 0.1;

/** Layers that shade areas by a 0 to 100 score, when the caller does not pass the layer's unit. */
const SCORE_LAYERS: ReadonlySet<string> = new Set(["remoteness", "popularity"]);

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
    case "vector-polygons":
      return { kind: "polygon", fill: VECTOR_TILE_FILL };
    case "lines":
      return { kind: "line", dash: lineDashFor(layerId) };
    case "polygons":
      if (unit === "score" || (unit === undefined && SCORE_LAYERS.has(layerId))) return { kind: "score" };
      return { kind: "polygon", fill: POLYGON_INK_FILL[layerId] ?? POLYGON_FILL_DEFAULT };
    case "heat":
      return { kind: "score" };
    default:
      return { kind: "symbol", spriteUrl: pinIconFor(layerId, BLANK).url };
  }
}
