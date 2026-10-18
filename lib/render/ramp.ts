import { COMPARE_COLORS, RAMPS, type RampName } from "@/lib/render/palette";

/**
 * Color ramps from the palette (spec §11): stops interpolated in OKLCH so steps look even and stay in hue, with
 * lightness falling monotonically from the off-white low end. Pure math, no hex of its own.
 */

export type Rgb = [number, number, number];
type Oklch = [number, number, number];

/** Parses `#rrggbb` (or `#rgb`) into 0..255 channels. */
export function hexToRgb(hex: string): Rgb {
  let digits = hex.trim().replace(/^#/, "");
  if (digits.length === 3) digits = [...digits].map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(digits)) throw new Error(`Invalid hex color: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as Rgb;
}

/** `#RRGGBB` for 0..255 channels. */
export function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/** sRGB to OKLCH (L 0..1, C, h in degrees), after Björn Ottosson's OKLab. */
export function rgbToOklch([r8, g8, b8]: Rgb): Oklch {
  const [r, g, b] = [toLinear(r8), toLinear(g8), toLinear(b8)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(A, B);
  const h = ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return [L, C, h];
}

/** OKLCH back to sRGB, clamped to the gamut. */
export function oklchToRgb([L, C, h]: Oklch): Rgb {
  const rad = (h * Math.PI) / 180;
  const A = C * Math.cos(rad);
  const B = C * Math.sin(rad);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707665093 * s;
  return [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, fromLinear(Math.min(1, Math.max(0, v))))))) as Rgb;
}

/** Below this chroma a color's hue means nothing (off-white, dark grey); it borrows its neighbor's. */
const ACHROMATIC = 0.02;

function mixOklch(a: Oklch, b: Oklch, t: number): Oklch {
  let ha = a[2];
  let hb = b[2];
  if (a[1] < ACHROMATIC) ha = hb;
  if (b[1] < ACHROMATIC) hb = ha;
  let dh = hb - ha;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (ha + dh * t + 360) % 360];
}

/** Each ramp's stops in OKLCH, converted once. */
const stopsCache = new Map<readonly string[], Oklch[]>();
function oklchStops(stops: readonly string[]): Oklch[] {
  let cached = stopsCache.get(stops);
  if (!cached) {
    cached = stops.map((hex) => rgbToOklch(hexToRgb(hex)));
    stopsCache.set(stops, cached);
  }
  return cached;
}

/** The color at `t` (0..1, clamped) along evenly spaced `stops`, interpolated in OKLCH. */
export function interpolateStops(stops: readonly string[], t: number): Rgb {
  const lch = oklchStops(stops);
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (lch.length - 1);
  const i = Math.min(lch.length - 2, Math.floor(x));
  const f = x - i;
  // The stops themselves come back exactly (no round trip through OKLCH).
  if (f === 0) return hexToRgb(stops[i]);
  if (f === 1) return hexToRgb(stops[i + 1]);
  return oklchToRgb(mixOklch(lch[i], lch[i + 1], f));
}

/** Memoized ramp samples: 256 per ramp, so per-feature accessors do no color math. */
const RESOLUTION = 255;
const samples = new Map<RampName, Rgb[]>();

/** A named palette ramp at `t` (0..1). */
export function rampColor(name: RampName, t: number): Rgb {
  let table = samples.get(name);
  if (!table) {
    table = Array.from({ length: RESOLUTION + 1 }, (_, i) => interpolateStops(RAMPS[name], i / RESOLUTION));
    samples.set(name, table);
  }
  const clamped = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  return table[Math.round(clamped * RESOLUTION)];
}

/** Diverging compare ramp at `t` in -1..1: side A purple at -1, off-white at 0, side B pink at 1. */
export function compareRampColor(t: number): Rgb {
  const clamped = Math.min(1, Math.max(-1, Number.isFinite(t) ? t : 0));
  return clamped < 0
    ? interpolateStops([COMPARE_COLORS.mid, COMPARE_COLORS.a], -clamped)
    : interpolateStops([COMPARE_COLORS.mid, COMPARE_COLORS.b], clamped);
}

/** OKLCH lightness of an sRGB color (0 black to 1 white). */
export function lightness(rgb: Rgb): number {
  return rgbToOklch(rgb)[0];
}

/** `rgba(r, g, b, a)` for Mapbox paint. */
export function rgbaString([r, g, b]: Rgb, alpha: number): string {
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 1000) / 1000})`;
}

/** sRGB to OKLab (L, a, b). */
function rgbToOklab(rgb: Rgb): [number, number, number] {
  const [L, C, h] = rgbToOklch(rgb);
  const rad = (h * Math.PI) / 180;
  return [L, C * Math.cos(rad), C * Math.sin(rad)];
}

/**
 * How different two colors look: the OKLab distance ×100 (about 2 is a just-noticeable step side by side; classes of a
 * map key should differ by several times that once drawn over the basemap).
 */
export function deltaE(p: Rgb, q: Rgb): number {
  const a = rgbToOklab(p);
  const b = rgbToOklab(q);
  return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** `color` drawn at `alpha` over `under` (sRGB blending, as the map's fills are). */
export function compositeOver(color: Rgb, alpha: number, under: Rgb): Rgb {
  return [0, 1, 2].map((k) => Math.round(color[k] * alpha + under[k] * (1 - alpha))) as Rgb;
}
