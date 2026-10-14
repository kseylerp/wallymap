import type { Feature, FeatureCollection } from "geojson";
import type { Facet, StyleHints } from "@/layers/types";
import type { FilterField, LayerFilters } from "@/lib/render/filters";
import { rampColor, rgbToHex } from "@/lib/render/ramp";
import { lineRampFor } from "@/lib/render/palette";

/**
 * Facets (spec §12a), the pure half: what the layer row's chips and sliders show, how they write the layer's filters,
 * and the colors the map draws the primary facet in. A facet is declared on the layer (`style.facets`, layers/types.ts)
 * in the layer's own words; the chips and sliders write through the filters engine (lib/render/filters.ts), so the
 * counts, the legend, the export and the share link follow them exactly as they follow the free-form filters.
 */

/** One chip: the facet values it stands for (several values may share a label), how many features carry them. */
export type FacetGroup = { label: string; values: string[]; count: number; color?: string };

/** A facet's declared value as the filters engine compares it (a string; numbers by their decimal text). */
export function facetValueKey(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
}

/** The layer's facets, or none. */
export function facetsOf(style: Pick<StyleHints, "facets"> | undefined): Facet[] {
  return style?.facets ?? [];
}

/** The facet that drives the map: the first one with an `encode`. */
export function primaryFacet(style: Pick<StyleHints, "facets"> | undefined): Facet | undefined {
  return facetsOf(style).find((f) => f.encode !== undefined);
}

/** The declared groups of a category facet in order, values that share a label merged into one group. */
export function declaredGroups(facet: Facet): { label: string; values: string[] }[] {
  const groups: { label: string; values: string[] }[] = [];
  for (const v of facet.values ?? []) {
    const key = String(v.value);
    const group = groups.find((g) => g.label === v.label);
    if (group) group.values.push(key);
    else groups.push({ label: v.label, values: [key] });
  }
  return groups;
}

/**
 * The colors of a category facet's groups on the score and facet line ramp (sage → pink → purple), easy (first) to
 * hard (last), sampled in OKLCH as the legend draws them. One group is sage.
 */
export function groupColors(count: number): string[] {
  if (count <= 0) return [];
  if (count === 1) return [rgbToHex(rampColor(lineRampFor(""), 0))];
  return Array.from({ length: count }, (_, i) => rgbToHex(rampColor(lineRampFor(""), i / (count - 1))));
}

/** Each declared value of an ordinal category facet with its group's ramp color, for a Mapbox `match`. */
export function facetColorStops(facet: Facet): [string, string][] {
  const groups = declaredGroups(facet);
  const colors = groupColors(groups.length);
  return groups.flatMap((g, i) => g.values.map((v): [string, string] => [v, colors[i]]));
}

/**
 * The chips a category facet shows for this data: its declared groups that occur (or are picked), in declared order,
 * each with its feature count and ramp color, then any value the data holds that the declaration does not name (shown
 * as the raw value, so nothing filterable is hidden).
 */
export function facetGroups(facet: Facet, data: FeatureCollection, filters?: LayerFilters): FacetGroup[] {
  const counts = new Map<string, number>();
  for (const f of data.features) {
    const key = facetValueKey(f.properties?.[facet.key]);
    if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const include = filters?.[facet.key]?.include ?? [];
  const declared = declaredGroups(facet);
  const colors = groupColors(declared.length);
  const known = new Set(declared.flatMap((g) => g.values));
  const groups: FacetGroup[] = [];
  declared.forEach((g, i) => {
    const count = g.values.reduce((sum, v) => sum + (counts.get(v) ?? 0), 0);
    if (count > 0 || g.values.some((v) => include.includes(v))) groups.push({ ...g, count, color: colors[i] });
  });
  for (const [value, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    if (!known.has(value)) groups.push({ label: value.replace(/_/g, " "), values: [value], count });
  }
  return groups;
}

/** True when every value of `group` is in the facet's include list (the chip reads pressed). */
export function isGroupPicked(filters: LayerFilters | undefined, facet: Facet, group: Pick<FacetGroup, "values">): boolean {
  const include = filters?.[facet.key]?.include ?? [];
  return include.length > 0 && group.values.every((v) => include.includes(v));
}

/**
 * The filters after pressing a chip: its values join (or leave) the facet's include list; other facets and fields
 * stay. Picking every chip there is is the same as none, so the include is dropped (no restriction); a range on the
 * same key is kept.
 */
export function toggleGroup(filters: LayerFilters, facet: Facet, group: Pick<FacetGroup, "values">, all: Pick<FacetGroup, "values">[]): LayerFilters {
  const current = filters[facet.key]?.include ?? [];
  const picked = isGroupPicked(filters, facet, group);
  const next = picked ? current.filter((v) => !group.values.includes(v)) : [...new Set([...current, ...group.values])];
  const everything = all.length > 0 && all.every((g) => g.values.every((v) => next.includes(v)));
  const { [facet.key]: entry, ...rest } = filters;
  const range = entry?.range ? { range: entry.range } : {};
  if (next.length === 0 || everything) return entry?.range ? { ...rest, [facet.key]: range } : rest;
  return { ...rest, [facet.key]: { ...range, include: next } };
}

/** The filters with a facet's include list cleared ("all"). */
export function clearFacet(filters: LayerFilters, facet: Facet): LayerFilters {
  const { [facet.key]: entry, ...rest } = filters;
  return entry?.range && facet.kind === "category" ? { ...rest, [facet.key]: { range: entry.range } } : rest;
}

/**
 * A range facet as the slider field (lib/render/filters.ts FilterField), over the numbers the data holds; null when
 * fewer than two distinct numbers leave nothing to slide.
 */
export function facetRangeField(facet: Facet, data: FeatureCollection): Extract<FilterField, { kind: "range" }> | null {
  let min = Infinity;
  let max = -Infinity;
  let integer = true;
  for (const f of data.features) {
    const n = f.properties?.[facet.key];
    if (typeof n !== "number" || !Number.isFinite(n)) continue;
    if (n < min) min = n;
    if (n > max) max = n;
    if (!Number.isInteger(n)) integer = false;
  }
  if (!(max > min)) return null;
  return { key: facet.key, label: facet.label, kind: "range", min, max, integer, ...(facet.unit && { unit: facet.unit }) };
}

/** The number a ranked or sized view reads: the primary range facet's key, else `v`. */
export function measureKeyOf(style: Pick<StyleHints, "facets"> | undefined): string {
  const range = facetsOf(style).find((f) => f.kind === "range" && f.encode === "size") ?? facetsOf(style).find((f) => f.kind === "range");
  return range?.key ?? "v";
}

function numberOf(f: Feature, key: string): number | undefined {
  const n = f.properties?.[key];
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** The features with the `n` largest numbers under `key`, largest first (ties keep data order). */
export function topFeatures(data: FeatureCollection, key: string, n: number): Feature[] {
  return data.features
    .map((f, i) => ({ f, i, v: numberOf(f, key) }))
    .filter((x): x is { f: Feature; i: number; v: number } => x.v !== undefined)
    .sort((a, b) => b.v - a.v || a.i - b.i)
    .slice(0, n)
    .map((x) => x.f);
}

/** The smallest and largest number under `key` across the features; null without two different numbers. */
export function extentOf(data: FeatureCollection, key: string): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of data.features) {
    const n = numberOf(f, key);
    if (n === undefined) continue;
    lo = Math.min(lo, n);
    hi = Math.max(hi, n);
  }
  return hi > lo ? [lo, hi] : null;
}

/** Symbol scale for a sized point: 0.7 (smallest) to 1.8 (largest) times the symbol, by the square root of its share. */
export const SIZE_SCALE = { min: 0.7, max: 1.8 } as const;

export function sizeScale(value: unknown, extent: [number, number] | null): number {
  if (!extent || typeof value !== "number" || !Number.isFinite(value)) return 1;
  const t = Math.min(1, Math.max(0, (value - extent[0]) / (extent[1] - extent[0])));
  return SIZE_SCALE.min + (SIZE_SCALE.max - SIZE_SCALE.min) * Math.sqrt(t);
}

/**
 * The hatch density step (0 sparse to 4 dense) of an area by its number under `key`: five even steps of the log of the
 * value across the data's extent, so a few huge areas do not leave every other one at the sparse end.
 */
export function hatchStepOf(value: unknown, extent: [number, number] | null): number {
  if (!extent || typeof value !== "number" || !Number.isFinite(value)) return 1;
  const shift = extent[0] <= 0 ? 1 - extent[0] : 0;
  const lo = Math.log(extent[0] + shift);
  const hi = Math.log(extent[1] + shift);
  const t = hi > lo ? (Math.log(value + shift) - lo) / (hi - lo) : 1;
  return Math.min(4, Math.max(0, Math.floor(Math.min(0.999, Math.max(0, t)) * 5)));
}

/** The versions facet (monument boundaries 2021 and current), when the layer declares one. */
export function versionsFacet(style: Pick<StyleHints, "facets"> | undefined): Facet | undefined {
  return facetsOf(style).find((f) => f.kind === "category" && f.versions === true);
}

/**
 * The two versions a change view compares for a versions facet: the first declared group present in the data (A, the
 * earlier) and the last (B, the newer); null when fewer than two are present.
 */
export function versionSides(facet: Facet, data: FeatureCollection): { a: FacetGroup; b: FacetGroup } | null {
  const present = facetGroups(facet, data).filter((g) => g.count > 0 && declaredGroups(facet).some((d) => d.label === g.label));
  if (present.length < 2) return null;
  return { a: present[0], b: present[present.length - 1] };
}
