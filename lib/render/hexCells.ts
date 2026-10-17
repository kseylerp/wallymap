import type { Feature, FeatureCollection } from "geojson";
import { cellArea, cellToBoundary, cellToLatLng, getHexagonAreaAvg, getResolution, latLngToCell } from "h3-js";
import type { Attribute, BBox } from "@/layers/types";
import { attributeGroups, chipAttribute, declaredGroups, primaryMeasure, valueKeys } from "@/lib/render/attributes";
import type { LayerFilters } from "@/lib/render/filters";
import { featureCenter, isYearOnly } from "@/lib/render/inspect";
import type { HexBasis } from "@/lib/render/state";

/**
 * Hex cells carry information (spec §12d), the pure half: features binned into H3 cells once per data object and
 * resolution, each cell keeping its members, so a cell's color can mean a count, a sum of the layer's measure, the
 * share of one category or how recent its newest feature is, and its card can summarise what is inside it (area,
 * density, rank, the category shares, the measure's total and median, the time span and the top named features).
 */

/** One H3 cell and the features that fell in it (data order). */
export type HexCell = { h3: string; position: [number, number]; members: Feature[] };

const cellCache = new WeakMap<FeatureCollection, Map<number, HexCell[]>>();

/** Where a feature sits for binning: a Point's coordinates, else the center of its extent; null when unusable. */
export function anchorOf(f: Feature): [number, number] | null {
  const p = f.geometry?.type === "Point" ? (f.geometry.coordinates as [number, number]) : featureCenter(f);
  if (!p) return null;
  const [lng, lat] = p;
  return Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90 ? [lng, lat] : null;
}

/** The data binned into H3 cells at `resolution` (cached per data object and resolution); bad coordinates are skipped. */
export function hexCells(data: FeatureCollection, resolution: number): HexCell[] {
  let byRes = cellCache.get(data);
  if (!byRes) {
    byRes = new Map();
    cellCache.set(data, byRes);
  }
  const hit = byRes.get(resolution);
  if (hit) return hit;
  const byH3 = new Map<string, HexCell>();
  for (const f of data.features) {
    const p = anchorOf(f);
    if (!p) continue;
    const h3 = latLngToCell(p[1], p[0], resolution);
    let cell = byH3.get(h3);
    if (!cell) {
      const [lat, lng] = cellToLatLng(h3);
      cell = { h3, position: [lng, lat], members: [] };
      byH3.set(h3, cell);
    }
    cell.members.push(f);
  }
  const cells = [...byH3.values()];
  byRes.set(resolution, cells);
  return cells;
}

/** What a layer's cells read: its measure (sum), its main category (shares) and the date field (recency). */
export type CellContext = {
  measure?: Pick<Attribute, "key" | "label" | "unit">;
  category?: Attribute;
  timeKey: string;
  /** The layer's features in words ("power plants"), for the legend. */
  noun: string;
};

/** A layer title as a plural noun for the legend: "Power plants" → "power plants" (a parenthesis dropped). */
export function nounOf(title: string): string {
  const plain = title.replace(/\s*\(.*?\)\s*/g, " ").trim();
  return plain.charAt(0).toLowerCase() + plain.slice(1);
}

export function cellContext(layer: { title: string; attributes?: Attribute[]; style: { timeField?: string } }): CellContext {
  const measure = primaryMeasure(layer);
  const category = chipAttribute(layer);
  return {
    ...(measure && { measure }),
    ...(category && { category }),
    timeKey: layer.style.timeField ?? "t",
    noun: nounOf(layer.title),
  };
}

function numberAt(f: Feature, key: string): number | undefined {
  const n = f.properties?.[key];
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function timeAt(f: Feature, key: string): number | undefined {
  const t = f.properties?.[key];
  const ms = typeof t === "string" ? Date.parse(t) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

/** The category value a share basis counts ("wind" in `share:wind`), or undefined for other bases. */
export function shareValue(basis: HexBasis | undefined): string | undefined {
  return basis?.startsWith("share:") ? basis.slice("share:".length) : undefined;
}

/**
 * One cell's value on a basis: count of features; sum of the measure (or null without one); share of members whose
 * main category includes the value (0 to 1); recency, the newest date in it (ms, or null when none is dated).
 */
export function cellValue(cell: HexCell, basis: HexBasis | undefined, ctx: CellContext): number | null {
  const share = shareValue(basis);
  if (share !== undefined) {
    if (!ctx.category) return null;
    const hits = cell.members.filter((f) => valueKeys(f.properties?.[ctx.category!.key]).includes(share)).length;
    return cell.members.length > 0 ? hits / cell.members.length : 0;
  }
  if (basis === "sum") {
    if (!ctx.measure) return null;
    return cell.members.reduce((sum, f) => sum + Math.max(0, numberAt(f, ctx.measure!.key) ?? 0), 0);
  }
  if (basis === "recency") {
    let newest: number | null = null;
    for (const f of cell.members) {
      const t = timeAt(f, ctx.timeKey);
      if (t !== undefined && (newest === null || t > newest)) newest = t;
    }
    return newest;
  }
  return cell.members.length;
}

/** A basis the layer can draw: sum needs a measure, share a category, recency dates; otherwise the count. */
export function usableBasis(basis: HexBasis | undefined, ctx: CellContext, cells: HexCell[]): HexBasis {
  if (!basis || basis === "count") return "count";
  if (basis === "sum") return ctx.measure ? "sum" : "count";
  if (shareValue(basis) !== undefined) return ctx.category ? basis : "count";
  return cells.some((c) => c.members.some((f) => timeAt(f, ctx.timeKey) !== undefined)) ? "recency" : "count";
}

/** Every cell's basis value with the extent, for the color ramp. */
export type BasisScale = { values: Map<HexCell, number>; lo: number; hi: number; basis: HexBasis };

export function basisScale(cells: HexCell[], basis: HexBasis, ctx: CellContext): BasisScale {
  const values = new Map<HexCell, number>();
  let lo = Infinity;
  let hi = -Infinity;
  for (const cell of cells) {
    const v = cellValue(cell, basis, ctx);
    if (v === null) continue;
    values.set(cell, v);
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return { values, lo: Number.isFinite(lo) ? lo : 0, hi: Number.isFinite(hi) ? hi : 0, basis };
}

/**
 * A value's place on the tile ramp, 0 (lightest) to 1 (darkest): counts on a log scale and sums on a square root
 * against the largest, a share as itself, recency from the oldest newest-date to the newest.
 */
export function basisT(value: number | undefined, scale: Pick<BasisScale, "lo" | "hi" | "basis">): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  if (shareValue(scale.basis) !== undefined) return Math.min(1, Math.max(0, value));
  if (scale.basis === "recency") return scale.hi > scale.lo ? (value - scale.lo) / (scale.hi - scale.lo) : 1;
  if (scale.hi <= 0) return 0;
  // Counts already run on a log ramp (lib/render/deck.ts); a sum (megawatts, acres) on its square root, so a few huge
  // cells stand out without every other cell washing to the dark end.
  if (scale.basis === "count") return Math.min(1, Math.max(0, Math.log1p(value) / Math.log1p(scale.hi)));
  return Math.min(1, Math.max(0, Math.sqrt(Math.max(0, value) / scale.hi)));
}

/** A compact number for a tile label: 1,234 reads 1.2k, 12,345 reads 12k. */
export function compactNumber(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "")}k`;
  if (n >= 10 || Number.isInteger(n)) return String(Math.round(n));
  return n.toFixed(1);
}

/** A cell's tile label on its basis: the count, the sum, the share in percent; recency has none. */
export function basisLabel(value: number | undefined, basis: HexBasis): string {
  if (value === undefined || basis === "recency") return "";
  if (shareValue(basis) !== undefined) return `${Math.round(value * 100)}%`;
  return compactNumber(value);
}

/** Two significant figures, separators kept: 36.13 → "36", 252.9 → "250", 1,770 → "1,800", 5.16 → "5.2". */
export function roughly(n: number): string {
  if (!(n > 0)) return "0";
  const digits = Math.floor(Math.log10(n)) + 1;
  const step = 10 ** (digits - 2);
  const rounded = Math.round(n / step) * step;
  return rounded.toLocaleString("en-US", { maximumFractionDigits: Math.max(0, 2 - digits) });
}

/** The chip label of a category value ("wind" → "Wind"), from the declared levels, else the raw value. */
export function levelLabel(attr: Attribute | undefined, value: string): string {
  const group = attr ? declaredGroups(attr).find((g) => g.values.includes(value)) : undefined;
  return group?.label ?? value.replace(/_/g, " ");
}

/** The one chip picked on the main category, as a word for the legend ("wind"), when exactly one is. */
function pickedWord(ctx: CellContext, filters: LayerFilters | undefined): string | undefined {
  const include = ctx.category ? filters?.[ctx.category.key]?.include : undefined;
  if (!ctx.category || !include?.length) return undefined;
  const labels = [...new Set(include.map((v) => levelLabel(ctx.category, v)))];
  return labels.length === 1 ? labels[0].toLowerCase() : undefined;
}

/**
 * The legend sentence for hex cells (spec §12d): the cell size and what darker means, in words. "Each cell ≈ 36 km²;
 * darker = more wind capacity".
 */
export function hexLegendSentence(resolution: number, basis: HexBasis, ctx: CellContext, filters?: LayerFilters): string {
  const size = `Each cell ≈ ${roughly(getHexagonAreaAvg(resolution, "km2"))} km²`;
  const picked = pickedWord(ctx, filters);
  const share = shareValue(basis);
  let darker: string;
  if (basis === "sum" && ctx.measure) darker = `more ${picked ? `${picked} ` : ""}${ctx.measure.label.toLowerCase()}`;
  else if (share !== undefined) darker = `a larger share of ${levelLabel(ctx.category, share).toLowerCase()}`;
  else if (basis === "recency") darker = `newer ${picked ? `${picked} ` : ""}${ctx.noun}`;
  else darker = `more ${picked ? `${picked} ` : ""}${ctx.noun}`;
  // A sum's tile labels are in the measure's unit; say which.
  const unit = basis === "sum" && ctx.measure?.unit && ctx.measure.unit !== "score" ? ` (labels in ${ctx.measure.unit})` : "";
  return `${size}; darker = ${darker}${unit}`;
}

// ---- The cell card ----

export type CellShare = { label: string; count: number; share: number };
export type CellNamed = { name: string; feature: Feature; value?: string };

/** What a hex cell's card shows (spec §12d). */
export type HexCellSummary = {
  h3: string;
  resolution: number;
  areaKm2: number;
  count: number;
  densityPerKm2: number;
  /** The cell's place among the layer's cells on the color basis, 1 for the top, and how many cells there are. */
  rank: number;
  of: number;
  basis: HexBasis;
  /** The main category's shares in this cell, largest first (four, then "Other"). */
  shares?: { label: string; parts: CellShare[] };
  measure?: { label: string; unit?: string; sum: number; median: number; counted: number };
  span?: { first: string; latest: string; yearOnly?: boolean };
  /** The top five named features, by the measure when there is one. */
  named: CellNamed[];
  bbox: BBox;
};

/** Shares this many parts, the rest folded into "Other". */
const SHARE_PARTS = 4;
/** Named features a cell card lists. */
export const CELL_NAMED = 5;

function nameOf(f: Feature): string | null {
  const p = f.properties ?? {};
  for (const key of ["name", "common_name", "species", "title", "project"]) {
    const v = p[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function cellBBox(h3: string): BBox {
  const ring = cellToBoundary(h3, true);
  const lngs = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
}

/** The ordinal suffix: 1st, 2nd, 3rd, 11th, 22nd. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** The summary of `cell` among `cells` (its layer's cells at the same resolution) for its card. */
export function summarizeCell(cell: HexCell, cells: HexCell[], basis: HexBasis, ctx: CellContext): HexCellSummary {
  const resolution = getResolution(cell.h3);
  const areaKm2 = cellArea(cell.h3, "km2");
  const count = cell.members.length;
  const own = cellValue(cell, basis, ctx) ?? 0;
  const above = cells.filter((c) => (cellValue(c, basis, ctx) ?? -Infinity) > own).length;
  const summary: HexCellSummary = {
    h3: cell.h3,
    resolution,
    areaKm2,
    count,
    densityPerKm2: count / areaKm2,
    rank: above + 1,
    of: cells.length,
    basis,
    named: [],
    bbox: cellBBox(cell.h3),
  };
  const data: FeatureCollection = { type: "FeatureCollection", features: cell.members };
  if (ctx.category) {
    const groups = attributeGroups(ctx.category, data).filter((g) => g.count > 0);
    groups.sort((a, b) => b.count - a.count);
    const total = ctx.category.multi ? Math.max(count, 1) : Math.max(1, groups.reduce((s, g) => s + g.count, 0));
    const parts: CellShare[] = groups.slice(0, SHARE_PARTS).map((g) => ({ label: g.label, count: g.count, share: g.count / total }));
    const rest = groups.slice(SHARE_PARTS).reduce((s, g) => s + g.count, 0);
    if (rest > 0) parts.push({ label: "Other", count: rest, share: rest / total });
    if (parts.length > 0) summary.shares = { label: ctx.category.label, parts };
  }
  if (ctx.measure) {
    const values = cell.members.map((f) => numberAt(f, ctx.measure!.key)).filter((n): n is number => n !== undefined);
    if (values.length > 0) {
      summary.measure = {
        label: ctx.measure.label,
        ...(ctx.measure.unit && { unit: ctx.measure.unit }),
        sum: values.reduce((s, v) => s + v, 0),
        median: median(values),
        counted: values.length,
      };
    }
  }
  const times = cell.members.map((f) => f.properties?.[ctx.timeKey]).filter((t): t is string => typeof t === "string" && !Number.isNaN(Date.parse(t)));
  if (times.length > 0) {
    times.sort((a, b) => Date.parse(a) - Date.parse(b));
    // Dates known only to the year (a dam's completion) read as years, not "Jan 1".
    const yearOnly = cell.members.every((f) => {
      const t = f.properties?.[ctx.timeKey];
      return typeof t !== "string" || isYearOnly(t, f.properties);
    });
    summary.span = { first: times[0], latest: times[times.length - 1], ...(yearOnly && { yearOnly: true }) };
  }
  // Members of one name are one row with their count and summed measure: a wind farm's 58 turbines are "Mesquite Star
  // (58)", not "Mesquite Star" five times.
  const groups = new Map<string, { f: Feature; name: string; v: number | undefined; n: number }>();
  for (const f of cell.members) {
    const name = nameOf(f);
    if (name === null) continue;
    const v = ctx.measure ? numberAt(f, ctx.measure.key) : undefined;
    const g = groups.get(name);
    if (!g) groups.set(name, { f, name, v, n: 1 });
    else {
      g.n += 1;
      if (v !== undefined) g.v = (g.v ?? 0) + v;
    }
  }
  const named = [...groups.values()];
  named.sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity) || a.name.localeCompare(b.name));
  summary.named = named.slice(0, CELL_NAMED).map((x) => ({
    name: x.n > 1 ? `${x.name} (${x.n})` : x.name,
    feature: x.f,
    ...(x.v !== undefined && ctx.measure && { value: `${x.v.toLocaleString("en-US", { maximumFractionDigits: 1 })}${ctx.measure.unit && ctx.measure.unit !== "score" ? ` ${ctx.measure.unit}` : ""}` }),
  }));
  return summary;
}

/** The words a rank takes on each basis: "3rd busiest of 120", "2nd by capacity of 40". */
export function rankWords(summary: Pick<HexCellSummary, "rank" | "of" | "basis">, ctx: CellContext): string {
  const share = shareValue(summary.basis);
  const by =
    summary.basis === "sum" && ctx.measure
      ? `by ${ctx.measure.label.toLowerCase()}`
      : share !== undefined
        ? `by share of ${levelLabel(ctx.category, share).toLowerCase()}`
        : summary.basis === "recency"
          ? "most recent"
          : "busiest";
  const of = `of ${summary.of.toLocaleString("en-US")} ${summary.of === 1 ? "cell" : "cells"} on screen`;
  if (summary.rank === 1 && by === "busiest") return `The busiest ${of}`;
  return by === "busiest" || by === "most recent" ? `${ordinal(summary.rank)} ${by} ${of}` : `${ordinal(summary.rank)} ${by}, ${of}`;
}

/**
 * The chat text "Ask about this cell" prefills (spec §12d): the layer, the cell's bbox and what is in it, so the
 * user can finish the question.
 */
export function askAboutCellText(layerTitle: string, layerId: string, summary: HexCellSummary): string {
  const [w, s, e, n] = summary.bbox.map((x) => Number(x.toFixed(4)));
  const what = summary.shares?.parts.slice(0, 2).map((p) => `${p.label} ${Math.round(p.share * 100)}%`).join(", ");
  return `In ${layerTitle} (${layerId}) inside the hex cell bbox [${w}, ${s}, ${e}, ${n}] (${summary.count.toLocaleString("en-US")} features${what ? `; ${what}` : ""}): `;
}

/** The cell a hex tile or column stands for, registered by the renderer for the card. */
export type CellOrigin = { cell: HexCell; cells: HexCell[]; basis: HexBasis; ctx: CellContext };

const origins = new WeakMap<Feature, CellOrigin>();

/** Remembers which cell a drawn hex feature stands for (lib/render/deck.ts), so its card can summarise it. */
export function registerCell(feature: Feature, origin: CellOrigin): void {
  origins.set(feature, origin);
}

/** The cell behind a picked hex tile or column, or undefined for any other feature. */
export function cellOf(feature: Feature): CellOrigin | undefined {
  return origins.get(feature);
}
