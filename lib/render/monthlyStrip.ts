/**
 * The monthly strip under the map (spec T10 "Monthly climate strip"), the pure half: which answer's months to draw and
 * how. Twelve columns January to December; a temperature band (high and low), bars (precipitation, river flow) and a
 * row of shaded cells (snow on the ground, years greening up), the current month marked by the pink playhead, the
 * highest value labelled, and one line of words for the month in focus. components/MonthlyStrip.tsx draws it.
 */
import type { LayerResult, MonthlyRow, MonthlyStrip } from "@/layers/types";
import type { MapState } from "@/lib/render/state";

export const MONTH_INITIALS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
export const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The strip to draw: the months of the top shown layer that has them, with that layer's id and title. */
export type StripSource = { layerId: string; title: string; strip: MonthlyStrip };

export function monthsOf(result: LayerResult): MonthlyStrip | undefined {
  const strip = result.months;
  return strip && strip.rows.length > 0 ? strip : undefined;
}

/** The top visible layer (the last drawn op) whose answer carries monthly values, or null. */
export function stripSource(state: Pick<MapState, "layers" | "renderOps">): StripSource | null {
  for (const op of [...state.renderOps].reverse()) {
    if (!op.visible) continue;
    const layer = state.layers[op.layerId];
    const strip = layer ? monthsOf(layer.result) : undefined;
    if (layer && strip) return { layerId: layer.id, title: layer.title, strip };
  }
  return null;
}

/** Geometry for a strip `width` wide: each row's top and height, in SVG units. */
export const ROW_HEIGHT = { band: 40, bars: 30, cells: 12 } as const;
export const COMPACT_ROW_HEIGHT = { band: 26, bars: 20, cells: 9 } as const;
export const ROW_GAP = 6;
/** Room above a band or bars row for its top value's label. */
export const LABEL_ROOM = 10;

export type Column = { month: number; x: number; width: number; center: number };
export type ShapedRow =
  | { kind: "band"; row: MonthlyRow & { kind: "band" }; top: number; height: number; path: string; high: string; low: string; peak?: Label; trough?: Label }
  | { kind: "bars"; row: MonthlyRow & { kind: "bars" }; top: number; height: number; bars: { month: number; x: number; y: number; width: number; height: number }[]; peak?: Label }
  | { kind: "cells"; row: MonthlyRow & { kind: "cells" }; top: number; height: number; cells: { month: number; x: number; width: number; alpha: number }[] };
export type Label = { month: number; x: number; y: number; text: string };
export type ShapedStrip = { width: number; height: number; columns: Column[]; rows: ShapedRow[]; current: number; playheadX: number; mark?: { x: number; label: string } };

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** A value with its unit as the strip prints it: "78°", "6.2 in", "2,280 cfs", "41%". */
export function valueText(value: number, unit: string): string {
  if (unit === "°F" || unit === "°C") return `${Math.round(value)}°`;
  if (unit === "share of days") return `${Math.round(value * 100)}%`;
  const digits = Math.abs(value) >= 10 ? 0 : 1;
  const n = value.toLocaleString("en-US", { maximumFractionDigits: digits });
  return unit === "years" ? `${n} yr` : `${n} ${unit}`;
}

/** Twelve equal columns across `width` with a small inset. */
export function columns(width: number): Column[] {
  const w = width / 12;
  return Array.from({ length: 12 }, (_, month) => ({ month, x: month * w, width: w, center: month * w + w / 2 }));
}

function shapeBand(row: MonthlyRow & { kind: "band" }, cols: Column[], top: number, height: number): ShapedRow {
  const all = [...row.high, ...row.low].filter(finite);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = hi - lo || 1;
  const inner = height - LABEL_ROOM - 2;
  const y = (v: number) => top + LABEL_ROOM + inner * (1 - (v - lo) / span);
  const pts = (vals: (number | null)[]) => cols.filter((c) => finite(vals[c.month])).map((c) => [c.center, y(vals[c.month] as number)] as const);
  const highs = pts(row.high);
  const lows = pts(row.low);
  const line = (p: readonly (readonly [number, number])[]) => p.map(([x, yy], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${yy.toFixed(1)}`).join("");
  const path = highs.length && lows.length ? `${line(highs)}${[...lows].reverse().map(([x, yy]) => `L${x.toFixed(1)},${yy.toFixed(1)}`).join("")}Z` : "";
  const peakMonth = argBest(row.high, (a, b) => a > b);
  const troughMonth = argBest(row.low, (a, b) => a < b);
  return {
    kind: "band",
    row,
    top,
    height,
    path,
    high: line(highs),
    low: line(lows),
    ...(peakMonth !== undefined && { peak: { month: peakMonth, x: cols[peakMonth].center, y: y(row.high[peakMonth] as number) - 3, text: valueText(row.high[peakMonth] as number, row.unit) } }),
    ...(troughMonth !== undefined && { trough: { month: troughMonth, x: cols[troughMonth].center, y: Math.min(top + height, y(row.low[troughMonth] as number) + 9), text: valueText(row.low[troughMonth] as number, row.unit) } }),
  };
}

function argBest(values: (number | null)[], better: (a: number, b: number) => boolean): number | undefined {
  let best: number | undefined;
  values.forEach((v, i) => {
    if (finite(v) && (best === undefined || better(v, values[best] as number))) best = i;
  });
  return best;
}

function shapeBars(row: MonthlyRow & { kind: "bars" }, cols: Column[], top: number, height: number): ShapedRow {
  const max = Math.max(0, ...row.values.filter(finite));
  const inner = height - LABEL_ROOM;
  const bars = cols
    .filter((c) => finite(row.values[c.month]))
    .map((c) => {
      const h = max > 0 ? Math.max(0.5, (inner * (row.values[c.month] as number)) / max) : 0;
      const w = c.width * 0.62;
      return { month: c.month, x: c.center - w / 2, y: top + height - h, width: w, height: h };
    });
  const peakMonth = argBest(row.values, (a, b) => a > b);
  return {
    kind: "bars",
    row,
    top,
    height,
    bars,
    ...(peakMonth !== undefined && max > 0 && { peak: { month: peakMonth, x: cols[peakMonth].center, y: top + height - (inner * (row.values[peakMonth] as number)) / max - 3, text: valueText(row.values[peakMonth] as number, row.unit) } }),
  };
}

function shapeCells(row: MonthlyRow & { kind: "cells" }, cols: Column[], top: number, height: number): ShapedRow {
  const max = row.max ?? Math.max(0, ...row.values.filter(finite));
  return {
    kind: "cells",
    row,
    top,
    height,
    cells: cols.map((c) => {
      const v = row.values[c.month];
      return { month: c.month, x: c.x + 1, width: c.width - 2, alpha: finite(v) && max > 0 ? Math.min(1, Math.max(0, v / max)) : 0 };
    }),
  };
}

/** Lays the strip out `width` wide; `now` picks the current month (the playhead). */
export function shapeStrip(strip: MonthlyStrip, width: number, now: Date, compact = false): ShapedStrip {
  const cols = columns(width);
  const heights = compact ? COMPACT_ROW_HEIGHT : ROW_HEIGHT;
  let top = 0;
  const rows: ShapedRow[] = [];
  for (const row of strip.rows) {
    const height = heights[row.kind];
    if (row.kind === "band") rows.push(shapeBand(row, cols, top, height));
    else if (row.kind === "bars") rows.push(shapeBars(row, cols, top, height));
    else rows.push(shapeCells(row, cols, top, height));
    top += height + ROW_GAP;
  }
  const current = now.getMonth();
  const mark = strip.mark ? { x: cols[strip.mark.month].x + cols[strip.mark.month].width * Math.min(1, Math.max(0, strip.mark.fraction)), label: strip.mark.label } : undefined;
  return { width, height: Math.max(0, top - ROW_GAP), columns: cols, rows, current, playheadX: cols[current].center, ...(mark && { mark }) };
}

/** One line of words for a month: "Jul: 78° / 46° · 0.2 in · snow on the ground 0%". */
export function monthLine(strip: MonthlyStrip, month: number): string {
  const parts = strip.rows.flatMap((row) => {
    if (row.kind === "band") {
      const hi = row.high[month];
      const lo = row.low[month];
      return finite(hi) && finite(lo) ? [`high ${Math.round(hi)} ${row.unit}, low ${Math.round(lo)} ${row.unit}`] : [];
    }
    const v = row.values[month];
    if (!finite(v)) return [];
    const label = row.label.toLowerCase();
    return [`${label} ${valueText(v, row.unit)}`];
  });
  return `${MONTH_ABBR[month]}: ${parts.join(" · ") || "no data"}`;
}

/** The legends, one per row, in words. */
export function legendLines(strip: MonthlyStrip): string[] {
  return [...strip.rows.map((r) => r.legend), ...(strip.mark ? [`Line: ${strip.mark.label.charAt(0).toLowerCase()}${strip.mark.label.slice(1)}`] : [])];
}
