import type { Feature, FeatureCollection } from "geojson";
import type { Attribute, Encoding } from "@/layers/types";
import { attributeFor, declaredGroups, groupColors, valueKey } from "@/lib/render/attributes";
import { rampColor, rgbToHex, type Rgb } from "@/lib/render/ramp";
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

/** Line width from the size channel, in pixels: the thinnest reach to the largest river. */
export const ENCODED_LINE = { minPx: 1.25, maxPx: 9, casingPx: 2 } as const;
/** Symbol radius from the size channel, in pixels. */
export const ENCODED_POINT = { minPx: 3.5, maxPx: 17, strokePx: 1.25, haloPx: 1.5, fillAlpha: 0.88 } as const;

/** One channel resolved against the data: the attribute it reads, its words, and the range the data spans. */
export type Channel = {
  key: string;
  label: string;
  unit?: string;
  /** The smallest and largest value in the data (every frame of a series); null without two different numbers. */
  extent: [number, number] | null;
  /** Color only: a category or ordinal's levels in order, each with its ramp color. */
  levels?: { values: string[]; label: string; color: string }[];
};

export type ResolvedEncoding = { size?: Channel; color?: Channel };

type EncodableLayer = Pick<LoadedLayer, "attributes" | "style">;

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

/** The smallest and largest number under `key` over every feature and every frame; null without two different numbers. */
export function channelExtent(data: FeatureCollection, key: string): [number, number] | null {
  let byKey = extentMemo.get(data);
  if (!byKey) {
    byKey = new Map();
    extentMemo.set(data, byKey);
  }
  if (byKey.has(key)) return byKey.get(key) ?? null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of data.features) {
    for (const v of valuesOf(f, key)) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  const extent: [number, number] | null = hi > lo ? [lo, hi] : null;
  byKey.set(key, extent);
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
    const colors = groupColors(groups.length);
    return { key, label, extent: null, levels: groups.map((g, i) => ({ values: g.values, label: g.label, color: colors[i] })) };
  }
  return { key, label, ...(attr?.unit && { unit: attr.unit }), extent: channelExtent(data, key) };
}

/**
 * The layer's two channels against `data`, or null when neither applies: a channel needs its key to be one of the
 * layer's attributes (size a measure; color a measure, ordinal or category) and the data to hold values for it.
 */
export function resolveEncoding(layer: EncodableLayer, op: Pick<RenderOp, "encode"> | undefined, data: FeatureCollection): ResolvedEncoding | null {
  const asked = askedEncoding(layer, op);
  const size = asked.size ? channelOf(attributeFor(layer, asked.size), asked.size, data, "size") : undefined;
  const color = asked.color ? channelOf(attributeFor(layer, asked.color), asked.color, data, "color") : undefined;
  if (!size && !color) return null;
  return { ...(size && { size }), ...(color && { color }) };
}

/** A size channel's 0..1 share for a value: the square root of its share of the largest (from zero), else of the range. */
export function sizeT(value: unknown, extent: [number, number] | null): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !extent) return extent ? 0 : 0.5;
  const [lo, hi] = extent;
  if (lo >= 0) return hi > 0 ? Math.sqrt(Math.min(1, Math.max(0, value / hi))) : 0;
  return Math.sqrt(Math.min(1, Math.max(0, (value - lo) / (hi - lo))));
}

/** A color channel's 0..1 place on the ramp for a value (linear over the range); null when the value is missing. */
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
