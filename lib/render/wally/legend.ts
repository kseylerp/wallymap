import type { Feature } from "geojson";
import { acresStep } from "@/lib/render/hatch";
import {
  areaRecipe,
  DARK_GREY,
  HATCH_SPACINGS,
  HEX_TILE,
  isPaletteColor,
  LINE,
  LINE_CLASSES,
  lineClassFor,
  lineRampFor,
  scoreRampFor,
  WHITE,
  type RampName,
} from "@/lib/render/palette";
import { rampColor, rgbToHex } from "@/lib/render/ramp";
import type { RenderMode } from "@/lib/render/state";
import { pinIconFor } from "@/lib/render/wally/pins";

/**
 * The legend key for one layer (the layer panel) or one feature (the inspect card's swatch): exactly what the map
 * draws, from the same palette recipes deck.gl and Mapbox draw with. Points show their sprite, lines their casing,
 * core and dash, areas their tint, hatch and outline, scores and heat their ramp, raster tiles a dark grey hatch.
 */
export type LegendSymbol =
  | { kind: "symbol"; spriteUrl: string }
  | { kind: "line"; color: string; under?: string; dash: [number, number]; casing: string; width: number; casingWidth: number }
  | {
      kind: "area";
      tint: string;
      tintAlpha: number;
      hatch: string;
      hatchAlpha: number;
      /** Hatch spacing in CSS pixels. */
      spacing: number;
      outline: string;
      casing: string;
    }
  | { kind: "ramp"; colors: string[] }
  | { kind: "tiles"; color: string };

export type LegendKind = LegendSymbol["kind"];

/**
 * How a layer is drawn: a render mode, `tiles` for raster imagery, or `vector-polygons` for vector tile areas
 * (public lands), which Mapbox draws with the same area recipe (components/mapTiles.ts).
 */
export type LegendMode = RenderMode | "tiles" | "vector-polygons";

/** Layers that shade areas by a 0 to 100 score, when the caller does not pass the layer's unit. */
const SCORE_LAYERS: ReadonlySet<string> = new Set(["remoteness", "popularity", "popularity-campsites"]);

/** A feature with no properties: campsite layers then read as camp sites (triangles), not parking. */
const BLANK: Feature = { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: {} };

/** Five samples of a ramp, low to high, as hex. */
export function rampSamples(name: RampName): string[] {
  return [0, 0.25, 0.5, 0.75, 1].map((t) => rgbToHex(rampColor(name, t)));
}

export type LegendOptions = {
  /** The layer's style unit; `"score"` shades by a ramp. */
  unit?: string;
  /** A palette color the layer panel or a compare side drew the layer in. */
  color?: string;
  /** The one feature the key stands for (the inspect card): its own hatch density and symbol. */
  feature?: Feature;
};

function isScore(layerId: string, unit?: string): boolean {
  return unit === "score" || (unit === undefined && SCORE_LAYERS.has(layerId));
}

/** The legend key for a layer drawn in `mode`. */
export function legendSymbol(layerId: string, mode: LegendMode, { unit, color, feature }: LegendOptions = {}): LegendSymbol {
  const requested = isPaletteColor(color) ? color.toUpperCase() : undefined;
  switch (mode) {
    case "tiles":
      return { kind: "tiles", color: DARK_GREY };
    case "vector-polygons":
    case "polygons": {
      if (mode === "polygons" && isScore(layerId, unit)) return { kind: "ramp", colors: rampSamples(scoreRampFor(layerId)) };
      const r = areaRecipe(layerId, requested);
      const step = layerId === "fire-perimeters" && feature ? acresStep(feature.properties?.acres ?? feature.properties?.v) : r.step;
      return {
        kind: "area",
        tint: r.color,
        tintAlpha: r.tint,
        hatch: r.color,
        hatchAlpha: r.hatchAlpha,
        spacing: HATCH_SPACINGS[step],
        outline: r.outline,
        casing: WHITE,
      };
    }
    case "lines": {
      const cls = LINE_CLASSES[lineClassFor(layerId, feature?.properties)];
      const scoreColor = isScore(layerId, unit) && feature ? rgbToHex(rampColor(lineRampFor(layerId), Number(feature.properties?.v) / 100)) : undefined;
      const base = {
        kind: "line" as const,
        casing: WHITE,
        width: LINE.width,
        casingWidth: LINE.casing,
        dash: [...cls.dash] as [number, number],
      };
      if (requested) return { ...base, color: requested, dash: [0, 0] };
      if (scoreColor) return { ...base, color: scoreColor, dash: [0, 0] };
      if (isScore(layerId, unit)) return { kind: "ramp", colors: rampSamples(lineRampFor(layerId)) };
      return "under" in cls ? { ...base, color: cls.color, under: cls.under } : { ...base, color: cls.color };
    }
    case "heat":
      return { kind: "ramp", colors: rampSamples("density") };
    default:
      return { kind: "symbol", spriteUrl: pinIconFor(layerId, feature ?? BLANK).url };
  }
}

/** The legend key for dense point layers drawn as hex tiles: the gray tile ramp. */
export function hexTileLegend(): LegendSymbol {
  return { kind: "ramp", colors: rampSamples(HEX_TILE.ramp) };
}
