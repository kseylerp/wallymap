import type { Feature, FeatureCollection } from "geojson";
import type { Attribute, Encoding, LegendSpec } from "@/layers/types";
import { attributeFor, declaredGroups, groupColors, valueKey } from "@/lib/render/attributes";
import { compareRampColor, hexToRgb, interpolateStops, rampColor, rgbToHex, type Rgb } from "@/lib/render/ramp";
import { CATEGORY_COLORS, OTHER_COLOR } from "@/lib/render/categories";
import type { LoadedLayer, RenderOp } from "@/lib/render/state";

/**
 * Two measures on one mark (spec §13, borrowed from mapped.earth's River Pulse: "height is that day's flow, color is
 * water temperature"), the pure half. A layer declares the pair it reads best as (`style.encode`); the render op can
 * swap either or switch it off (`op.encode`, "" for off). `size` sizes the mark (line width, symbol radius, column
 * height) by the square root of its share of the largest value, so a mark's area or width grows with the value and a
 * few huge rivers do not flatten the rest; `color` places it on the sage → pink → purple ramp (a measure linearly over
 * its range, an ordinal or category by its declared order). The legend names both with their units and range.
 */

/** The ramp a color channel draws on: sage (low) → pink → purple (high), the line and score ramp (palette §11). */
export const ENCODE_RAMP = "scoreLine" as const;

/**
 * Line width from the size channel, in pixels: the thinnest reach to the largest river (1.25 px: at 0.6 px most of a
 * river network did not show on Topo, screen check 2026-10-17). On satellite imagery a thin
 * reach vanished into the photo (coordinator, 2026-10-17), so there the thinnest is `imageryMinPx` and every line takes
 * the trails' casing, `imageryCasingPx` wider than its core (TRAIL_LINE: 2.5 px core, 4.5 px casing).
 */
export const ENCODED_LINE = { minPx: 1.25, maxPx: 12, casingMinPx: 1, casingMaxPx: 2, imageryMinPx: 1.75, imageryCasingPx: 2 } as const;
/** Symbol radius from the size channel, in pixels. */
export const ENCODED_POINT = { minPx: 3, maxPx: 13, strokePx: 1, haloPx: 1.25, fillAlpha: 0.9 } as const;

/** One channel resolved against the data: the attribute it reads, its words, and the range the data spans. */
export type Channel = {
  key: string;
  label: string;
  unit?: string;
  /** The smallest and largest value in the data (every frame of a series); null without two different numbers. */
  extent: [number, number] | null;
  /** Color only: a category or ordinal's levels in order, each with its color (the ramp's for an ordinal). */
  levels?: { values: string[]; label: string; color: string }[];
  /** A category (fuel, publisher): each level draws in its own palette color, not along a ramp. */
  categorical?: boolean;
  /**
   * A fixed scale the layer's legend declares (a ramp on this key whose stops all carry a value and a color): values
   * draw at their place between those stops and hold the end colors beyond, whatever range the data spans. Without it
   * a temperature anomaly where every county ran warm drew on the data's own range, hottest purple, against a key that
   * said purple is cooler (owner, 2026-10-18).
   */
  stops?: { value: number; color: string }[];
};

export type ResolvedEncoding = { size?: Channel; color?: Channel };

type EncodableLayer = Pick<LoadedLayer, "attributes" | "style"> & Partial<Pick<LoadedLayer, "allData" | "legend">> & { result?: { legend?: LegendSpec } };

/** The fixed stops a layer's legend declares for `key` (a ramp whose stops all have a value and a color, ascending). */
export function declaredStops(layer: Partial<Pick<LoadedLayer, "legend">> & { result?: { legend?: LegendSpec } }, key: string): { value: number; color: string }[] | undefined {
  const legend = layer.result?.legend ?? layer.legend;
  if (!legend || legend.kind !== "ramp" || legend.field !== key) return undefined;
  const stops = legend.stops ?? [];
  if (stops.length < 2 || !stops.every((s) => typeof s.value === "number" && Number.isFinite(s.value) && typeof s.color === "string")) return undefined;
  const out = stops.map((s) => ({ value: s.value as number, color: s.color as string }));
  return out.every((s, i) => i === 0 || s.value > out[i - 1].value) ? out : undefined;
}

/** A value's color on declared stops: interpolated between the two around it (in OKLCH), the end colors beyond. */
export function stopsColor(value: unknown, stops: { value: number; color: string }[]): Rgb | null {
  if (typeof value !== "number" || !Number.isFinite(value) || stops.length === 0) return null;
  if (value <= stops[0].value) return hexToRgb(stops[0].color);
  const last = stops[stops.length - 1];
  if (value >= last.value) return hexToRgb(last.color);
  const i = stops.findIndex((s) => s.value > value) - 1;
  const a = stops[i];
  const b = stops[i + 1];
  return interpolateStops([a.color, b.color], (value - a.value) / (b.value - a.value));
}

/** The pair a layer draws with: the op's choice over the layer's declared pair ("" switches a channel off). */
export function askedEncoding(layer: EncodableLayer, op: Pick<RenderOp, "encode"> | undefined): Encoding {
  const declared = layer.style.encode ?? {};
  const asked = op?.encode ?? {};
  const pick = (channel: keyof Encoding) => {
    const value = channel in asked ? asked[channel] : declared[channel];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };
  const size = pick("size");
  const color = pick("color");
  return { ...(size && { size }), ...(color && { color }) };
}

/** Every number a feature holds under `key`: its own value, and each frame of its series when it has one. */
export function valuesOf(f: Feature, key: string): number[] {
  const out: number[] = [];
  const own = f.properties?.[key];
  if (typeof own === "number" && Number.isFinite(own)) out.push(own);
  const series = (f.properties?.series as Record<string, unknown> | undefined)?.[key];
  if (Array.isArray(series)) for (const v of series) if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  return out;
}

const extentMemo = new WeakMap<FeatureCollection, Map<string, [number, number] | null>>();

/**
 * The smallest and largest number under `key` over every feature and every frame; null without two different numbers.
 * `robust` (the color channel) takes the 2nd and 98th percentiles instead, so one creek at 2,000% of its median does not
 * leave every other line at the low end of the ramp; values past them take the ramp's ends.
 */
export function channelExtent(data: FeatureCollection, key: string, robust = false): [number, number] | null {
  let byKey = extentMemo.get(data);
  if (!byKey) {
    byKey = new Map();
    extentMemo.set(data, byKey);
  }
  const memoKey = `${key}|${robust}`;
  if (byKey.has(memoKey)) return byKey.get(memoKey) ?? null;
  const all: number[] = [];
  for (const f of data.features) for (const v of valuesOf(f, key)) all.push(v);
  let extent: [number, number] | null = null;
  if (all.length > 0) {
    all.sort((a, b) => a - b);
    const at = (q: number) => all[Math.min(all.length - 1, Math.max(0, Math.round(q * (all.length - 1))))];
    const [lo, hi] = robust && all.length >= 50 ? [at(0.02), at(0.98)] : [all[0], all[all.length - 1]];
    extent = hi > lo ? [lo, hi] : null;
  }
  byKey.set(memoKey, extent);
  return extent;
}

/** True when some feature holds a number (or, for chips, any value) under `key`. */
function holds(data: FeatureCollection, key: string, chips: boolean): boolean {
  return data.features.some((f) => (chips ? valueKey(f.properties?.[key]) !== undefined : valuesOf(f, key).length > 0));
}

function channelOf(attr: Attribute | undefined, key: string, data: FeatureCollection, kind: keyof Encoding): Channel | undefined {
  const chips = attr !== undefined && (attr.type === "ordinal" || attr.type === "category");
  if (kind === "size" && chips) return undefined;
  if (attr && attr.type !== "measure" && !chips) return undefined;
  if (!holds(data, key, chips)) return undefined;
  const label = attr?.label ?? key;
  if (chips) {
    const groups = declaredGroups(attr);
    if (groups.length === 0) return undefined;
    // A category's kinds are not in order: each takes its own palette color (solar is not "half of" gas).
    const categorical = attr.type === "category";
    const colors = categorical ? groups.map((_, i) => CATEGORY_COLORS[i] ?? OTHER_COLOR) : groupColors(groups.length);
    return { key, label, extent: null, levels: groups.map((g, i) => ({ values: g.values, label: g.label, color: colors[i] })), ...(categorical && { categorical: true }) };
  }
  return { key, label, ...(attr?.unit && { unit: attr.unit }), extent: channelExtent(data, key, kind === "color") };
}

/**
 * The layer's two channels against `data`, or null when neither applies: a channel needs its key to be one of the
 * layer's attributes (size a measure; color a measure, ordinal or category) and the data to hold values for it.
 */
export function resolveEncoding(layer: EncodableLayer, op: Pick<RenderOp, "encode"> | undefined, shown: FeatureCollection): ResolvedEncoding | null {
  // The range comes from every loaded feature, so a frame or a filter never rescales the marks.
  const data = layer.allData ?? shown;
  const asked = askedEncoding(layer, op);
  const size = asked.size ? channelOf(attributeFor(layer, asked.size), asked.size, data, "size") : undefined;
  const colorBase = asked.color ? channelOf(attributeFor(layer, asked.color), asked.color, data, "color") : undefined;
  const fixed = colorBase && !colorBase.levels ? declaredStops(layer, colorBase.key) : undefined;
  const color = colorBase && fixed ? { ...colorBase, stops: fixed } : colorBase;
  if (!size && !color) return null;
  return { ...(size && { size }), ...(color && { color }) };
}

/**
 * A size channel's 0..1 share for a value: the square root of its share of the largest when the values start near zero
 * (flow, capacity, storage: a mark's area or width grows with the value), else the square root of its place in the
 * range (magnitude 2.5 to 5.7 would otherwise draw every quake nearly as large as the largest).
 */
export function sizeT(value: unknown, extent: [number, number] | null): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !extent) return extent ? 0 : 0.5;
  const [lo, hi] = extent;
  if (lo >= 0 && lo <= hi * 0.1) return hi > 0 ? Math.sqrt(Math.min(1, Math.max(0, value / hi))) : 0;
  return Math.sqrt(Math.min(1, Math.max(0, (value - lo) / (hi - lo))));
}

/** A color channel's 0..1 place on the ramp for a value (linear over the range); null when the value is missing. */
/** A categorical channel's color for a value (its level's own color), or null. */
export function levelColor(value: unknown, channel: Pick<Channel, "levels" | "categorical">): string | null {
  if (!channel.categorical || !channel.levels) return null;
  const key = valueKey(value);
  return key === undefined ? null : (channel.levels.find((l) => l.values.includes(key))?.color ?? null);
}

export function colorT(value: unknown, channel: Pick<Channel, "extent" | "levels">): number | null {
  if (channel.levels) {
    const key = valueKey(value);
    if (key === undefined) return null;
    const at = channel.levels.findIndex((l) => l.values.includes(key));
    if (at < 0) return null;
    return channel.levels.length > 1 ? at / (channel.levels.length - 1) : 0;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || !channel.extent) return null;
  const [lo, hi] = channel.extent;
  return Math.min(1, Math.max(0, (value - lo) / (hi - lo)));
}

/** True when a color channel's values run both sides of zero (an anomaly): it draws on the diverging ramp. */
export function isDiverging(channel: Pick<Channel, "extent" | "levels" | "stops">): boolean {
  return !channel.levels && !channel.stops && channel.extent !== null && channel.extent[0] < 0 && channel.extent[1] > 0;
}

/**
 * A diverging channel's color for a value: purple below zero (cooler, less), off-white at zero, pink above (warmer,
 * more), each side scaled to the larger of the two ends so equal departures read equally. Null without a value.
 */
export function divergingColor(value: unknown, channel: Pick<Channel, "extent">): Rgb | null {
  if (typeof value !== "number" || !Number.isFinite(value) || !channel.extent) return null;
  const m = Math.max(Math.abs(channel.extent[0]), Math.abs(channel.extent[1])) || 1;
  return compareRampColor(value / m);
}

/** The diverging ramp as CSS stops for a legend bar, purple (low) through off-white (zero) to pink (high). */
export function divergingCss(steps = 9): string {
  return Array.from({ length: steps }, (_, k) => `${rgbToHex(compareRampColor((k / (steps - 1)) * 2 - 1))} ${Math.round((k / (steps - 1)) * 100)}%`).join(", ");
}

/**
 * A color channel's color for a value, as the map draws it: the layer's declared stops when it has them, else the
 * diverging ramp across zero, else its place on the encode ramp; null without a value.
 */
export function channelColor(value: unknown, channel: Channel): Rgb | null {
  if (channel.stops) return stopsColor(value, channel.stops);
  if (isDiverging(channel)) return divergingColor(value, channel);
  const t = colorT(value, channel);
  return t === null ? null : encodeColor(t);
}

/** The ramp color at `t` (0..1). */
export function encodeColor(t: number): Rgb {
  return rampColor(ENCODE_RAMP, Math.min(1, Math.max(0, t)));
}

/** The ramp as CSS stops for the legend's bar (a hex color and its percent, nine of them), sampled like the map. */
export function rampCss(steps = 9): string {
  return Array.from({ length: steps }, (_, k) => `${rgbToHex(encodeColor(k / (steps - 1)))} ${Math.round((k / (steps - 1)) * 100)}%`).join(", ");
}

/** A line's width in pixels for a size share. */
export function lineWidthAt(t: number): number {
  return ENCODED_LINE.minPx + (ENCODED_LINE.maxPx - ENCODED_LINE.minPx) * Math.min(1, Math.max(0, t));
}

/** A symbol's radius in pixels for a size share. */
export function pointRadiusAt(t: number): number {
  return ENCODED_POINT.minPx + (ENCODED_POINT.maxPx - ENCODED_POINT.minPx) * Math.min(1, Math.max(0, t));
}

function amount(n: number): string {
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

/** "Flow 12–19,800 m³/s" or "Confidence: Low → High": a channel in the legend's words. */
export function channelText(channel: Channel): string {
  if (channel.levels && channel.categorical) return channel.label;
  if (channel.levels) return `${channel.label}: ${channel.levels[0].label} → ${channel.levels[channel.levels.length - 1].label}`;
  if (!channel.extent) return channel.label;
  const unit = channel.unit && channel.unit !== "score" ? ` ${channel.unit}` : "";
  return `${channel.label} ${amount(channel.extent[0])}–${amount(channel.extent[1])}${unit}`;
}

/** What width (lines), size (points) or height (columns) means for a geometry and mode. */
export function sizeWord(geometry: string, mode: string): string {
  if (mode === "columns") return "Height";
  return geometry === "line" ? "Width" : "Size";
}
