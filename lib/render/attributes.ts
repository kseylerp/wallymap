import type { Feature, FeatureCollection } from "geojson";
import type { Attribute, Layer, MeasurePreset } from "@/layers/types";
import type { LayerFilters } from "@/lib/render/filters";
import { rampColor, rgbToHex } from "@/lib/render/ramp";
import { lineRampFor } from "@/lib/render/palette";

/**
 * Typed attributes (spec §12c), the pure half: what the layer row's controls show and how they write the layer's
 * filters, the colors the map draws an ordinal in, and the measure a ranked or sized view reads. Attributes are declared
 * on the layer (`attributes`, layers/types.ts) in the layer's own words; every control writes through the filters engine
 * (lib/render/filters.ts), so the counts, the legend, the export and the share link follow them, and the agent's
 * `render.filters` lands on the same chips.
 */

type WithAttributes = { attributes?: Attribute[] } | undefined;

/** One chip: the values it stands for (several values may share a label), how many features carry them. */
export type AttributeGroup = { label: string; values: string[]; count: number; color?: string; help?: string };

/** A value as the filters engine compares it (a string; numbers by their decimal text). */
export function valueKey(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
}

/** The value keys of one property: each item of a list, else the value itself. */
export function valueKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(valueKey).filter((v): v is string => v !== undefined);
  const key = valueKey(value);
  return key === undefined ? [] : [key];
}

/** The layer's attributes, or none. */
export function attributesOf(layer: WithAttributes): Attribute[] {
  return layer?.attributes ?? [];
}

const CHIPS = new Set<Attribute["type"]>(["category", "ordinal"]);

/** True for an attribute shown as chips (category or ordinal). */
export function isChipAttribute(a: Attribute): boolean {
  return CHIPS.has(a.type);
}

/** The chip set the row shows by default: the attribute marked primary, else the first category or ordinal. */
export function chipAttribute(layer: WithAttributes): Attribute | undefined {
  const attrs = attributesOf(layer);
  return attrs.find((a) => a.primary && isChipAttribute(a)) ?? attrs.find(isChipAttribute);
}

/** The attribute whose classes color the lines (`encode: "color"`), easy to hard on the ramp. */
export function encodedAttribute(layer: WithAttributes): Attribute | undefined {
  return attributesOf(layer).find((a) => a.encode === "color" && isChipAttribute(a));
}

/** The layer's measures, in declared order. */
export function measuresOf(layer: WithAttributes): Attribute[] {
  return attributesOf(layer).filter((a) => a.type === "measure");
}

/** The measure a ranked view, symbol size and a hex cell's sum read: the one that sizes features, else the first. */
export function primaryMeasure(layer: WithAttributes): Attribute | undefined {
  const measures = measuresOf(layer);
  return measures.find((a) => a.encode === "size") ?? measures[0];
}

/** The property a ranked or sized view reads: the primary measure's key, else `v`. */
export function measureKeyOf(layer: WithAttributes): string {
  return primaryMeasure(layer)?.key ?? "v";
}

/** The attribute on `key`, when the layer declares one. */
export function attributeFor(layer: WithAttributes, key: string): Attribute | undefined {
  return attributesOf(layer).find((a) => a.key === key);
}

/** The declared groups of a category or ordinal in order, values that share a label merged into one group. */
export function declaredGroups(attr: Attribute): { label: string; values: string[]; help?: string }[] {
  const groups: { label: string; values: string[]; help?: string }[] = [];
  for (const level of attr.levels ?? []) {
    const key = String(level.value);
    const group = groups.find((g) => g.label === level.label);
    if (group) group.values.push(key);
    else groups.push({ label: level.label, values: [key], ...(level.help && { help: level.help }) });
  }
  return groups;
}

/**
 * The colors of an ordinal's groups on the score and facet line ramp (sage → pink → purple), easy (first) to hard
 * (last), sampled in OKLCH as the legend draws them. One group is sage.
 */
export function groupColors(count: number): string[] {
  if (count <= 0) return [];
  if (count === 1) return [rgbToHex(rampColor(lineRampFor(""), 0))];
  return Array.from({ length: count }, (_, i) => rgbToHex(rampColor(lineRampFor(""), i / (count - 1))));
}

/** Each declared value of an encoded attribute with its group's ramp color, for a Mapbox `match`. */
export function colorStops(attr: Attribute): [string, string][] {
  const groups = declaredGroups(attr);
  const colors = groupColors(groups.length);
  return groups.flatMap((g, i) => g.values.map((v): [string, string] => [v, colors[i]]));
}

/** How many chips a category without declared levels shows (the most common values first). */
export const DATA_CHIPS = 12;

/** Features per value key of `key` (a list counts once per item). */
function valueCounts(data: FeatureCollection, key: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of data.features) {
    for (const v of new Set(valueKeys(f.properties?.[key]))) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}

/** A raw value as a chip label: "mountain_hiking" reads "mountain hiking", "sport" reads "Sport". */
function plainLabel(value: string): string {
  const text = value.replace(/_/g, " ");
  return /^[a-z]/.test(text) ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/**
 * The chips a category or ordinal shows for this data: its declared groups that occur (or are picked), in declared
 * order, each with its feature count (an ordinal's with its ramp color), then any value the data holds that the
 * declaration does not name (as the raw value, so nothing filterable is hidden). A category without levels shows the
 * data's most common values.
 */
export function attributeGroups(attr: Attribute, data: FeatureCollection, filters?: LayerFilters): AttributeGroup[] {
  const counts = valueCounts(data, attr.key);
  const include = filters?.[attr.key]?.include ?? [];
  const declared = declaredGroups(attr);
  const colors = attr.type === "ordinal" || attr.encode === "color" ? groupColors(declared.length) : [];
  const known = new Set(declared.flatMap((g) => g.values));
  const groups: AttributeGroup[] = [];
  declared.forEach((g, i) => {
    // A list counts a feature once per chip, however many of the chip's values it holds.
    const count = attr.multi ? countAny(data, attr.key, g.values) : g.values.reduce((sum, v) => sum + (counts.get(v) ?? 0), 0);
    if (count > 0 || g.values.some((v) => include.includes(v))) groups.push({ ...g, count, ...(colors[i] && { color: colors[i] }) });
  });
  const extra = [...counts].filter(([value]) => !known.has(value)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const limit = declared.length === 0 ? DATA_CHIPS : Infinity;
  extra.forEach(([value, count], i) => {
    if (i < limit || include.includes(value)) groups.push({ label: plainLabel(value), values: [value], count });
  });
  return groups;
}

function countAny(data: FeatureCollection, key: string, values: string[]): number {
  let n = 0;
  for (const f of data.features) if (valueKeys(f.properties?.[key]).some((v) => values.includes(v))) n += 1;
  return n;
}

/** The values a chip attribute's filter keeps: its include list, or, for a range written by hand (Singletrack 3 to 6), the numeric values inside it. */
function pickedValues(filters: LayerFilters | undefined, attr: Attribute, all: Pick<AttributeGroup, "values">[] = []): string[] {
  const entry = filters?.[attr.key];
  if (entry?.include?.length) return entry.include;
  const range = entry?.range;
  if (!range) return [];
  const known = [...new Set([...(attr.levels ?? []).map((v) => String(v.value)), ...all.flatMap((g) => g.values)])];
  return known.filter((v) => Number.isFinite(Number(v)) && Number(v) >= range[0] && Number(v) <= range[1]);
}

/** True when every value of `group` is kept by the attribute's filter (the chip reads pressed). */
export function isGroupPicked(filters: LayerFilters | undefined, attr: Attribute, group: Pick<AttributeGroup, "values">): boolean {
  const picked = pickedValues(filters, attr, [group]);
  return picked.length > 0 && group.values.every((v) => picked.includes(v));
}

/**
 * The filters after pressing a chip: its values join (or leave) the attribute's include list; other fields stay.
 * Picking every chip there is is the same as none, so the include is dropped (no restriction); a range on the same key
 * is kept until a chip turns it into an include list.
 */
export function toggleGroup(filters: LayerFilters, attr: Attribute, group: Pick<AttributeGroup, "values">, all: Pick<AttributeGroup, "values">[]): LayerFilters {
  const current = pickedValues(filters, attr, all);
  const picked = isGroupPicked(filters, attr, group);
  const next = picked ? current.filter((v) => !group.values.includes(v)) : [...new Set([...current, ...group.values])];
  const everything = all.length > 0 && all.every((g) => g.values.every((v) => next.includes(v)));
  const { [attr.key]: entry, ...rest } = filters;
  // A hand-written range on a class becomes the chips' include list once a chip is pressed.
  const range = entry?.range && entry.include?.length ? { range: entry.range } : {};
  if (next.length === 0 || everything) return entry?.range ? { ...rest, [attr.key]: range } : rest;
  return { ...rest, [attr.key]: { ...range, include: next } };
}

/** The filters with an attribute cleared ("all"): no restriction on its property. */
export function clearAttribute(filters: LayerFilters, attr: Pick<Attribute, "key">): LayerFilters {
  const { [attr.key]: _cleared, ...rest } = filters;
  void _cleared;
  return rest;
}

/** A flag's filter: on keeps only features where the property is true (or "yes"). */
export function isFlagOn(filters: LayerFilters | undefined, attr: Pick<Attribute, "key">): boolean {
  return filters?.[attr.key]?.include?.includes("true") ?? false;
}

export function toggleFlag(filters: LayerFilters, attr: Pick<Attribute, "key">): LayerFilters {
  return isFlagOn(filters, attr) ? clearAttribute(filters, attr) : { ...filters, [attr.key]: { include: ["true", "yes"] } };
}

/** How many features carry the flag. */
export function flagCount(data: FeatureCollection, key: string): number {
  return data.features.filter((f) => f.properties?.[key] === true || f.properties?.[key] === "yes").length;
}

/** The name search text, or "". */
export function nameQuery(filters: LayerFilters | undefined, attr: Pick<Attribute, "key">): string {
  return filters?.[attr.key]?.match ?? "";
}

export function withNameQuery(filters: LayerFilters, attr: Pick<Attribute, "key">, text: string): LayerFilters {
  const rest = clearAttribute(filters, attr);
  return text.trim() ? { ...rest, [attr.key]: { match: text } } : rest;
}

// ---- Measures: ranking, presets, the mini histogram ----

function numberOf(f: Feature, key: string): number | undefined {
  const n = f.properties?.[key];
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** True when a layer ranks this measure smallest first (`lowFirst`: a distance, nearest first). */
export function isLowFirst(layer: WithAttributes, key: string | undefined): boolean {
  return key !== undefined && layer?.attributes?.some((a) => a.key === key && a.lowFirst === true) === true;
}

/** The features with the `n` largest numbers under `key`, largest first (smallest first when `lowFirst`; ties keep data order). */
export function topFeatures(data: FeatureCollection, key: string, n: number, lowFirst = false): Feature[] {
  const sign = lowFirst ? -1 : 1;
  return data.features
    .map((f, i) => ({ f, i, v: numberOf(f, key) }))
    .filter((x): x is { f: Feature; i: number; v: number } => x.v !== undefined)
    .sort((a, b) => sign * (b.v - a.v) || a.i - b.i)
    .slice(0, n)
    .map((x) => x.f);
}

/** A name as two rows compare it: lower case, accents and punctuation dropped; empty for none. */
function placeName(f: Feature): string {
  const n = f.properties?.name;
  return typeof n === "string" ? n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() : "";
}

/** The feature's bounding box, or null without coordinates. */
function boxOf(f: Feature): [number, number, number, number] | null {
  const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      box[0] = Math.min(box[0], c[0]);
      box[1] = Math.min(box[1], c[1]);
      box[2] = Math.max(box[2], c[0]);
      box[3] = Math.max(box[3], c[1]);
      return;
    }
    for (const x of c) visit(x);
  };
  const g = f.geometry;
  if (g && "coordinates" in g) visit(g.coordinates);
  return Number.isFinite(box[0]) ? box : null;
}

/** Two places closer than this (the gap between their boxes) under one name are one place. */
const SAME_PLACE_KM = 1;

/** True when two features' boxes touch or lie within SAME_PLACE_KM of each other. */
function nearby(a: Feature, b: Feature): boolean {
  const ba = boxOf(a);
  const bb = boxOf(b);
  if (!ba || !bb) return false;
  const lat = ((ba[1] + ba[3]) / 2) * (Math.PI / 180);
  const dx = Math.max(0, ba[0] - bb[2], bb[0] - ba[2]) * 111.32 * Math.cos(lat);
  const dy = Math.max(0, ba[1] - bb[3], bb[1] - ba[3]) * 110.57;
  return Math.hypot(dx, dy) <= SAME_PLACE_KM;
}

/** True when two features belong to one named project (the turbines of one wind farm, kilometres apart). */
function sameProject(a: Feature, b: Feature): boolean {
  const pa = a.properties?.project;
  return typeof pa === "string" && pa !== "" && pa === b.properties?.project;
}

/** A feature's date (`t`) in milliseconds, or undefined when it has none. */
function timeOf(f: Feature): number | undefined {
  const t = f.properties?.t;
  const ms = typeof t === "string" ? Date.parse(t) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * The feature a place's card shows among the features of that one place: the newest dated one at the head's spot (the map
 * draws it on top, so a click opens it: a glacier's latest outline, a fire's latest perimeter), else the head. The
 * turbines of one project keep the head: they are parts of the place, not its states over time.
 */
function newestOf(head: Feature, place: Feature[]): Feature {
  if (typeof head.properties?.project === "string" && head.properties.project !== "") return head;
  let best = head;
  let bestT = timeOf(head);
  for (const f of place) {
    const t = timeOf(f);
    if (t === undefined || (bestT !== undefined && t <= bestT) || (f !== head && !nearby(head, f))) continue;
    best = f;
    bestT = t;
  }
  return best;
}

/** The features of `data` that are one place: named alike, and at the same spot or of one project. */
function placesOf(data: FeatureCollection, key: string, lowFirst = false): Feature[][] {
  const groups: Feature[][] = [];
  const byName = new Map<string, Feature[][]>();
  for (const f of topFeatures(data, key, data.features.length, lowFirst)) {
    const name = placeName(f);
    const same = name === "" ? undefined : byName.get(name)?.find((g) => nearby(g[0], f) || sameProject(g[0], f));
    if (same) {
      same.push(f);
      continue;
    }
    const group = [f];
    groups.push(group);
    if (name !== "") byName.set(name, [...(byName.get(name) ?? []), group]);
  }
  return groups;
}

/**
 * The `n` largest places under `key`, largest first, one row per named place: features that share a name at the same
 * spot (the segments of one trail, an OSM node and a cliff line of one crag, a glacier's outlines of several years, one
 * fire from two agencies, the turbines of one wind project) are one place. Each place is listed by the feature its card
 * shows: the newest dated one (a glacier's latest outline, so the row and the card give one area), else the largest.
 * Unnamed features are each their own.
 */
export function topPlaces(data: FeatureCollection, key: string, n: number, lowFirst = false): Feature[] {
  const sign = lowFirst ? -1 : 1;
  return placesOf(data, key, lowFirst)
    .map((g, i) => ({ f: newestOf(g[0], g), i }))
    .map((x) => ({ ...x, v: numberOf(x.f, key) ?? (lowFirst ? Infinity : -Infinity) }))
    .sort((a, b) => sign * (b.v - a.v) || a.i - b.i)
    .slice(0, n)
    .map((x) => x.f);
}

/**
 * The feature whose card opens for a ranked row's place: the newest dated feature named alike at the same spot in
 * `data` (what the map draws on top there), else the row's own feature.
 */
export function cardFeatureOf(row: Feature, data: FeatureCollection): Feature {
  const name = placeName(row);
  if (name === "") return row;
  return newestOf(row, data.features.filter((f) => f !== row && placeName(f) === name));
}

/** True when an attribute's property holds numbers in this data (a year as a number, not an ISO date). */
export function holdsNumbers(data: FeatureCollection, key: string): boolean {
  return data.features.some((f) => typeof f.properties?.[key] === "number");
}

/**
 * The measures a layer row offers under "Rank by": the declared measures that hold numbers in the loaded data, plus the
 * time attribute the row is ranked by when that is the pick (a dam list sorted by "Year completed"), so the select says
 * what the list is sorted by instead of "None".
 */
export function rankableMeasures(layer: WithAttributes, data: FeatureCollection, pick?: string): Attribute[] {
  const measures = measuresOf(layer).filter((m) => holdsNumbers(data, m.key));
  if (pick === undefined || pick === "" || measures.some((m) => m.key === pick)) return measures;
  const time = attributesOf(layer).find((a) => a.type === "time" && a.key === pick && holdsNumbers(data, a.key));
  if (time) return [...measures, time];
  // A layer that declares no measure ranks by its `v` (a ranked view's fallback): the select names it too.
  if (pick === "v" && !attributesOf(layer).some((a) => a.key === "v") && holdsNumbers(data, "v")) return [...measures, { key: "v", type: "measure", label: "Value" }];
  return measures;
}

/**
 * What the row ranks by: the op's pick ("" is None), else the layer's primary measure when the data holds it. A pick the
 * select does not offer (a measure this data lacks) is None, so the list never shows under "None".
 */
export function effectiveRankBy(op: { rankBy?: string }, layer: WithAttributes, measures: Attribute[]): string | undefined {
  if (op.rankBy !== undefined) return op.rankBy !== "" && measures.some((m) => m.key === op.rankBy) ? op.rankBy : undefined;
  const primary = primaryMeasure(layer);
  return measures.find((m) => m.key === primary?.key)?.key ?? measures[0]?.key;
}

/** The name a top-10 row shows for a feature: its name, title, species, place or project, else "Unnamed". */
export function rowName(f: Feature): string {
  const p = f.properties ?? {};
  for (const key of ["name", "title", "species", "place", "project"]) {
    const v = p[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  // An unnamed trail with a climb (terrain on trail layers): told apart by where it goes up to (Chamonix's top climbs).
  if (typeof p.highM === "number" && Number.isFinite(p.highM)) {
    const kind = typeof p.kind === "string" && /^[a-z_ ]+$/.test(p.kind) ? p.kind.replace(/_/g, " ") : "trail";
    return `Unnamed ${kind} to ${Math.round(p.highM).toLocaleString("en-US")} m`;
  }
  return "Unnamed";
}

/**
 * The layer row's "Rank by" list (spec §12c): the measure it ranks by (unset: the primary measure; "" None) and the
 * `n` largest drawn places by it, one row per named place (topPlaces). `data` is every loaded feature (which measures
 * are offered), `shown` the drawn ones.
 */
export function rankedTop(
  layer: WithAttributes,
  op: { rankBy?: string },
  data: FeatureCollection,
  shown: FeatureCollection,
  n: number,
): { key: string | undefined; measures: Attribute[]; top: Feature[] } {
  const measures = rankableMeasures(layer, data, op.rankBy);
  const key = effectiveRankBy(op, layer, measures);
  return { key, measures, top: key ? topPlaces(shown, key, n, isLowFirst(layer, key)) : [] };
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

/** A preset's bounds over the data's extent (an open end takes the data's own). */
export function presetRange(preset: MeasurePreset, extent: [number, number]): [number, number] {
  return [preset.min ?? extent[0], preset.max ?? extent[1]];
}

/** How many features a preset keeps. */
export function presetCount(data: FeatureCollection, key: string, preset: MeasurePreset): number {
  return data.features.filter((f) => {
    const n = numberOf(f, key);
    return n !== undefined && (preset.min === undefined || n >= preset.min) && (preset.max === undefined || n <= preset.max);
  }).length;
}

/** True when the measure's filter is exactly this preset. */
export function isPresetPicked(filters: LayerFilters | undefined, attr: Pick<Attribute, "key">, preset: MeasurePreset, extent: [number, number] | null): boolean {
  const range = filters?.[attr.key]?.range;
  if (!range || !extent) return false;
  const [lo, hi] = presetRange(preset, extent);
  return Math.abs(range[0] - lo) < 1e-9 && Math.abs(range[1] - hi) < 1e-9;
}

/** The filters after pressing a preset: its range on the measure, or none when it was already on. */
export function togglePreset(filters: LayerFilters, attr: Pick<Attribute, "key">, preset: MeasurePreset, extent: [number, number] | null): LayerFilters {
  if (!extent) return filters;
  if (isPresetPicked(filters, attr, preset, extent)) return clearAttribute(filters, attr);
  return { ...clearAttribute(filters, attr), [attr.key]: { range: presetRange(preset, extent) } };
}

/** One bar of the mini histogram: its bounds and how many features fall in it. */
export type Bin = { lo: number; hi: number; count: number };

/** Bars in the mini histogram. */
export const HISTOGRAM_BINS = 12;

/**
 * The mini histogram of a measure (spec §12c, the only free range control): HISTOGRAM_BINS bars over the data's
 * extent, on a log scale when most values sit in the bottom tenth (fire acres, plant megawatts), so the low end is not
 * one tall bar. Null with fewer than two different numbers.
 */
export function histogram(data: FeatureCollection, key: string, bins = HISTOGRAM_BINS): { bins: Bin[]; log: boolean } | null {
  const values = data.features.map((f) => numberOf(f, key)).filter((n): n is number => n !== undefined);
  if (values.length < 2) return null;
  values.sort((a, b) => a - b);
  const lo = values[0];
  const hi = values[values.length - 1];
  if (!(hi > lo)) return null;
  const median = values[Math.floor(values.length / 2)];
  const log = lo >= 0 && median - lo < (hi - lo) / 10;
  const shift = lo <= 0 ? 1 - lo : 0;
  const to = (v: number) => (log ? Math.log(v + shift) : v);
  const from = (t: number) => (log ? Math.exp(t) - shift : t);
  const a = to(lo);
  const b = to(hi);
  const edges = Array.from({ length: bins + 1 }, (_, i) => (i === 0 ? lo : i === bins ? hi : from(a + ((b - a) * i) / bins)));
  const out: Bin[] = edges.slice(0, -1).map((e, i) => ({ lo: e, hi: edges[i + 1], count: 0 }));
  for (const v of values) {
    const i = Math.min(bins - 1, Math.floor(((to(v) - a) / (b - a)) * bins));
    out[i].count += 1;
  }
  return { bins: out, log };
}

/** The bars a measure's range covers (indices), or none without a range. */
export function pickedBins(filters: LayerFilters | undefined, key: string, bins: Bin[]): number[] {
  const range = filters?.[key]?.range;
  if (!range) return [];
  const eps = 1e-9 * Math.max(1, Math.abs(range[1]));
  return bins.flatMap((bin, i) => (bin.lo >= range[0] - eps && bin.hi <= range[1] + eps ? [i] : []));
}

/**
 * The filters after clicking bar `i`: with nothing picked, that bar; outside the picked span, the span grows to reach
 * it; on an end of the span, that end bar leaves it; the only picked bar clears it. Inside the span, the span shrinks to
 * that one bar. The range is written in the measure's own numbers (the bars' bounds).
 */
export function toggleBin(filters: LayerFilters, key: string, bins: Bin[], i: number): LayerFilters {
  const picked = pickedBins(filters, key, bins);
  const rest = clearAttribute(filters, { key });
  const write = (from: number, to: number) => ({ ...rest, [key]: { range: [bins[from].lo, bins[to].hi] as [number, number] } });
  if (picked.length === 0) return write(i, i);
  const first = picked[0];
  const last = picked[picked.length - 1];
  if (i < first) return write(i, last);
  if (i > last) return write(first, i);
  if (first === last) return rest;
  if (i === first) return write(first + 1, last);
  if (i === last) return write(first, last - 1);
  return write(i, i);
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

// ---- Versions (the change view) ----

/** The versions attribute (monument boundaries 2021 and current), when the layer declares one. */
export function versionsAttribute(layer: WithAttributes): Attribute | undefined {
  return attributesOf(layer).find((a) => a.type === "category" && a.versions === true);
}

/**
 * The two versions a change view compares: the first declared group present in the data (A, the earlier) and the last
 * (B, the newer); null when fewer than two are present.
 */
export function versionSides(attr: Attribute, data: FeatureCollection): { a: AttributeGroup; b: AttributeGroup } | null {
  const declared = declaredGroups(attr);
  const present = attributeGroups(attr, data).filter((g) => g.count > 0 && declared.some((d) => d.label === g.label));
  if (present.length < 2) return null;
  return { a: present[0], b: present[present.length - 1] };
}

// ---- Words ----

function n(x: number): string {
  return x.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * The attributes' part of the row's "Filtered:" line, in the attributes' words: "Difficulty: Hard, Expert · Burned area
 * 1,000–380,000 acres · Name has "Muir"". Keys that are not attributes are left to the free-form summary.
 */
export function attributeFilterSummary(attributes: Attribute[], filters: LayerFilters): string {
  const parts: string[] = [];
  for (const attr of attributes) {
    const entry = filters[attr.key];
    if (!entry) continue;
    if (entry.include?.length) {
      if (attr.type === "flag") parts.push(attr.label);
      else {
        const labels = declaredGroups(attr)
          .filter((g) => g.values.some((v) => entry.include?.includes(v)))
          .map((g) => g.label);
        const unnamed = entry.include.filter((v) => !(attr.levels ?? []).some((d) => String(d.value) === v)).map(plainLabel);
        parts.push(`${attr.label}: ${[...labels, ...unnamed].join(", ")}`);
      }
    }
    if (entry.range) {
      const unit = attr.unit && attr.unit !== "score" ? ` ${attr.unit}` : "";
      const [lo, hi] = entry.range;
      const preset = attr.presets?.find((p) => (p.min === undefined || p.min === lo) && (p.max === undefined || p.max === hi));
      parts.push(preset ? preset.label : `${attr.label} ${n(lo)}–${n(hi)}${unit}`);
    }
    if (entry.match) parts.push(`${attr.label} has "${entry.match}"`);
  }
  return parts.join(" · ");
}

/** The attributes as one line each for the layer table and the model: "Discipline (category) · Grade (ordinal: YDS…)". */
export function attributeText(layer: Pick<Layer, "attributes">): string {
  return attributesOf(layer)
    .map((a) => {
      const scale = a.type === "ordinal" && a.scale ? `, ${a.scale}` : "";
      const levels = isChipAttribute(a) && a.levels?.length ? `: ${[...new Set(a.levels.map((l) => l.label))].join(" · ")}` : "";
      const unit = a.unit && a.type === "measure" ? ` in ${a.unit}` : "";
      return `${a.label} (${a.type}${scale}${unit})${levels}`;
    })
    .join("; ");
}
