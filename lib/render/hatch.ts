import { FIRE_ACRE_STEPS, HATCH_COLORS, HATCH_LINE_PX, HATCH_SPACINGS, type HatchColor } from "@/lib/render/palette";
import { hexToRgb } from "@/lib/render/ramp";

/**
 * 45° hatch patterns (spec §11, "sparse to dense diagonals"): one pattern per palette hatch color and density, drawn
 * once into pixel buffers. deck.gl's FillStyleExtension samples them from one atlas (`hatchAtlas`), Mapbox's
 * `fill-pattern` gets each as an image (`hatchImage`), and the layer panel draws the same spacing as SVG.
 *
 * Patterns are drawn at 2x (`HATCH_SCALE`) so lines stay 1 CSS pixel sharp on high-density screens. Every frame is
 * one 36 CSS px tile (the least common multiple of the spacings, so each pattern repeats seamlessly), surrounded by a
 * gutter that continues the pattern, so mipmap sampling at a frame's edge never reads a neighbor.
 */

/** Atlas pixels per CSS pixel. */
export const HATCH_SCALE = 2;
/** One tile in CSS pixels: every spacing divides it. */
export const HATCH_TILE_PX = 36;
/** Frame size in atlas pixels. */
export const HATCH_FRAME = HATCH_TILE_PX * HATCH_SCALE;
/** Gutter around each frame in atlas pixels (the pattern continues into it). */
export const HATCH_GUTTER = 4;
const CELL = HATCH_FRAME + 2 * HATCH_GUTTER;

export const HATCH_STEPS = HATCH_SPACINGS.length;

/** The pattern id for a color and density step, e.g. `hatch-F57272-4`. */
export function hatchPatternId(color: HatchColor, step: number): string {
  return `hatch-${color.slice(1).toUpperCase()}-${clampStep(step)}`;
}

function clampStep(step: number): number {
  return Math.min(HATCH_STEPS - 1, Math.max(0, Math.round(Number.isFinite(step) ? step : 0)));
}

/**
 * Coverage (0..1) of a 45° line pattern at atlas pixel (x, y): lines run bottom-left to top-right ("/"), one every
 * `period` pixels along each axis, `width` pixels wide, anti-aliased by distance.
 */
function coverage(x: number, y: number, period: number, width: number): number {
  const u = (((x + 0.5 + (y + 0.5)) % period) + period) % period;
  const d = Math.min(u, period - u) / Math.SQRT2;
  return Math.min(1, Math.max(0, width / 2 + 0.5 - d));
}

/** Writes one pattern (colored lines on transparent) into `data` at (ox, oy), `w` x `h` pixels, phase from (px, py). */
function draw(
  data: Uint8ClampedArray,
  stride: number,
  [r, g, b]: [number, number, number],
  step: number,
  ox: number,
  oy: number,
  w: number,
  h: number,
  px: number,
  py: number,
) {
  const period = HATCH_SPACINGS[clampStep(step)] * HATCH_SCALE;
  const width = HATCH_LINE_PX * HATCH_SCALE;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((oy + y) * stride + (ox + x)) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = Math.round(255 * coverage(px + x, py + y, period, width));
    }
  }
}

export type HatchImage = { width: number; height: number; data: Uint8ClampedArray };

const images = new Map<string, HatchImage>();

/** One tile of a pattern (HATCH_FRAME square, RGBA), for Mapbox `addImage` at pixelRatio HATCH_SCALE. Memoized. */
export function hatchImage(color: HatchColor, step: number): HatchImage {
  const id = hatchPatternId(color, step);
  let image = images.get(id);
  if (!image) {
    const data = new Uint8ClampedArray(HATCH_FRAME * HATCH_FRAME * 4);
    draw(data, HATCH_FRAME, hexToRgb(color), step, 0, 0, HATCH_FRAME, HATCH_FRAME, 0, 0);
    image = { width: HATCH_FRAME, height: HATCH_FRAME, data };
    images.set(id, image);
  }
  return image;
}

export type HatchFrame = { x: number; y: number; width: number; height: number };
export type HatchAtlas = HatchImage & { mapping: Record<string, HatchFrame> };

let atlas: HatchAtlas | undefined;

/**
 * Every pattern in one RGBA buffer: a row per color (HATCH_COLORS order), a column per density step, each frame in
 * its gutter. `mapping` is deck's `fillPatternMapping`. Built once.
 */
export function hatchAtlas(): HatchAtlas {
  if (atlas) return atlas;
  const width = CELL * HATCH_STEPS;
  const height = CELL * HATCH_COLORS.length;
  const data = new Uint8ClampedArray(width * height * 4);
  const mapping: Record<string, HatchFrame> = {};
  HATCH_COLORS.forEach((color, row) => {
    const rgb = hexToRgb(color);
    for (let step = 0; step < HATCH_STEPS; step++) {
      // The gutter is drawn with the frame's own phase, so it continues the tile on every side.
      draw(data, width, rgb, step, step * CELL, row * CELL, CELL, CELL, -HATCH_GUTTER, -HATCH_GUTTER);
      mapping[hatchPatternId(color, step)] = {
        x: step * CELL + HATCH_GUTTER,
        y: row * CELL + HATCH_GUTTER,
        width: HATCH_FRAME,
        height: HATCH_FRAME,
      };
    }
  });
  atlas = { width, height, data, mapping };
  return atlas;
}

let atlasCanvas: HTMLCanvasElement | null | undefined;

/**
 * The atlas as a canvas for deck's `fillPatternAtlas`, made once; undefined where there is no 2D canvas (tests,
 * the server), and deck then draws the tint without the hatch.
 */
export function hatchAtlasCanvas(): HTMLCanvasElement | undefined {
  if (atlasCanvas !== undefined) return atlasCanvas ?? undefined;
  atlasCanvas = null;
  // OffscreenCanvas marks a real browser (jsdom has none and logs an error on getContext).
  if (typeof document === "undefined" || typeof OffscreenCanvas === "undefined") return undefined;
  const { width, height, data } = hatchAtlas();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  context.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  atlasCanvas = canvas;
  return canvas;
}

/** Density step for a value against ascending `bounds` (bounds.length + 1 steps), clamped to the hatch steps. */
export function stepFor(value: unknown, bounds: readonly number[]): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  let step = 0;
  while (step < bounds.length && n >= bounds[step]) step++;
  return Math.min(HATCH_STEPS - 1, step);
}

/** Fire perimeters: larger fires hatch denser (under 100 acres sparsest, 100k and up densest). */
export function acresStep(acres: unknown): number {
  return stepFor(acres, FIRE_ACRE_STEPS);
}

/** Stipple dot spacing in CSS pixels (divides HATCH_TILE_PX, so the tile repeats seamlessly) and dot radius. */
export const STIPPLE_SPACING_PX = 9;
export const STIPPLE_RADIUS_PX = 0.9;

const stipples = new Map<string, HatchImage>();

/**
 * A stipple tile (loose sediments on the geologic map, lib/render/rockFamily.ts): round dots of `color` every
 * STIPPLE_SPACING_PX, alternate rows offset by half a step, anti-aliased by distance; one HATCH_FRAME square for Mapbox
 * `addImage` at pixelRatio HATCH_SCALE. Memoized by color.
 */
export function stippleImage(color: HatchColor): HatchImage {
  const key = color.toUpperCase();
  let image = stipples.get(key);
  if (!image) {
    const [r, g, b] = hexToRgb(color);
    const data = new Uint8ClampedArray(HATCH_FRAME * HATCH_FRAME * 4);
    const step = STIPPLE_SPACING_PX * HATCH_SCALE;
    const radius = STIPPLE_RADIUS_PX * HATCH_SCALE;
    for (let y = 0; y < HATCH_FRAME; y++) {
      for (let x = 0; x < HATCH_FRAME; x++) {
        const row = Math.floor((y + 0.5) / step);
        const shift = row % 2 === 0 ? 0 : step / 2;
        const cx = Math.round((x + 0.5 - shift - step / 2) / step) * step + shift + step / 2;
        const cy = row * step + step / 2;
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const i = (y * HATCH_FRAME + x) * 4;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = Math.round(255 * Math.min(1, Math.max(0, radius + 0.5 - d)));
      }
    }
    image = { width: HATCH_FRAME, height: HATCH_FRAME, data };
    stipples.set(key, image);
  }
  return image;
}
