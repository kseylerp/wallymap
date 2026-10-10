export type FilterField =
  | { key: string; label: string; kind: "category"; values: { value: string; count: number }[] }
  | { key: string; label: string; kind: "range"; min: number; max: number; unit?: string; integer: boolean };

export type LayerFilters = Record<string, { include?: string[]; range?: [number, number] }>;

const DEFAULT_MAX_CATEGORIES = 12;
const MAX_FIELDS = 8;
const MIN_DISTINCT_NUMBERS = 5;
const MIN_FEATURES_FOR_SPAN = 20;
/** Uniqueness only says "free text" once there are enough values to judge. */
const MIN_VALUES_FOR_UNIQUENESS = 8;

/** Properties that are identifiers, names, links or internals rather than something to filter on. */
const SKIPPED_KEYS = new Set([
  "osmId", "id", "name", "title", "url", "t", "signals", "popularityNote", "h3", "wikidata", "wikipedia",
]);

function isSkippedKey(key: string): boolean {
  return SKIPPED_KEYS.has(key) || key.endsWith("Id") || key.endsWith("_id");
}

const LABELS: Record<string, string> = {
  sac_scale: "Difficulty (sac_scale)",
  trail_visibility: "Visibility",
  surface: "Surface",
  v: "Value",
  acres: "Acres",
  year: "Year",
  agency: "Agency",
  kind: "Type",
  confidence: "Confidence",
  species: "Species",
  scientificName: "Species",
};

/** Plain-language name for a property key, used as the filter heading. */
export function labelFor(key: string): string {
  const known = LABELS[key];
  if (known) return known;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type Scan = { strings: Map<string, number>; numbers: number[]; other: boolean; present: number };

function scanProperties(fc: GeoJSON.FeatureCollection): Map<string, Scan> {
  const scans = new Map<string, Scan>();
  for (const f of fc.features) {
    const props = f.properties;
    if (!props) continue;
    for (const [key, value] of Object.entries(props)) {
      if (isSkippedKey(key) || value === null || value === undefined) continue;
      let scan = scans.get(key);
      if (!scan) {
        scan = { strings: new Map(), numbers: [], other: false, present: 0 };
        scans.set(key, scan);
      }
      if (typeof value === "number") {
        if (Number.isFinite(value)) {
          scan.numbers.push(value);
          scan.present += 1;
        }
      } else if (typeof value === "string" || typeof value === "boolean") {
        const s = String(value);
        scan.strings.set(s, (scan.strings.get(s) ?? 0) + 1);
        scan.present += 1;
      } else {
        scan.other = true;
      }
    }
  }
  return scans;
}

export function deriveFilterFields(
  fc: GeoJSON.FeatureCollection,
  opts: { unitForV?: string; maxCategories?: number } = {},
): FilterField[] {
  const maxCategories = opts.maxCategories ?? DEFAULT_MAX_CATEGORIES;
  const categories: FilterField[] = [];
  const ranges: FilterField[] = [];

  for (const [key, scan] of scanProperties(fc)) {
    if (scan.other) continue;
    const hasNumbers = scan.numbers.length > 0;
    const hasStrings = scan.strings.size > 0;
    if (hasNumbers === hasStrings) continue; // empty, or mixed types

    if (hasStrings) {
      const distinct = scan.strings.size;
      if (distinct < 2 || distinct > maxCategories) continue;
      if (scan.present >= MIN_VALUES_FOR_UNIQUENESS && distinct / scan.present > 0.5) continue;
      const values = [...scan.strings].map(([value, count]) => ({ value, count }));
      values.sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
      categories.push({ key, label: key === "v" ? valueLabel(opts.unitForV) : labelFor(key), kind: "category", values });
      continue;
    }

    let min = Infinity;
    let max = -Infinity;
    let integer = true;
    for (const n of scan.numbers) {
      if (n < min) min = n;
      if (n > max) max = n;
      if (!Number.isInteger(n)) integer = false;
    }
    const distinct = new Set(scan.numbers).size;
    const enough = distinct >= MIN_DISTINCT_NUMBERS || (max > min && scan.numbers.length >= MIN_FEATURES_FOR_SPAN);
    if (!enough) continue;
    const field: FilterField = {
      key,
      label: key === "v" ? valueLabel(opts.unitForV) : labelFor(key),
      kind: "range",
      min,
      max,
      integer,
    };
    if (key === "v" && opts.unitForV) field.unit = opts.unitForV;
    ranges.push(field);
  }

  // `v` is the layer's value channel, often a copy of a named property (fire perimeters: v = acres). The named
  // field says more, so a `v` that matches another property on every feature is not offered twice.
  const kept = ranges.filter((field) => field.key !== "v" || !mirrorsAnotherProperty(fc, "v"));
  return [...categories, ...kept].slice(0, MAX_FIELDS);
}

/** True when some other numeric property equals `key`'s value on every feature that has one. */
function mirrorsAnotherProperty(fc: GeoJSON.FeatureCollection, key: string): boolean {
  let candidates: Set<string> | null = null;
  for (const f of fc.features) {
    const props = f.properties;
    const value = props?.[key];
    if (!props || typeof value !== "number") continue;
    const same = Object.keys(props).filter((k) => k !== key && props[k] === value);
    candidates = candidates === null ? new Set(same) : new Set(same.filter((k) => candidates!.has(k)));
    if (candidates.size === 0) return false;
  }
  return candidates !== null && candidates.size > 0;
}

function valueLabel(unitForV: string | undefined): string {
  return unitForV === "score" ? "Score (0–100)" : "Value";
}

function categoryOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  return undefined;
}

export function applyFilters(fc: GeoJSON.FeatureCollection, filters: LayerFilters | undefined): GeoJSON.FeatureCollection {
  if (!filters) return fc;
  // An empty include list means "no restriction", so it is as good as no filter.
  const active = Object.entries(filters).filter(
    ([, f]) => (f.include !== undefined && f.include.length > 0) || f.range !== undefined,
  );
  if (active.length === 0) return fc;

  const features = fc.features.filter((feature) => {
    const props = feature.properties ?? {};
    for (const [key, f] of active) {
      const value: unknown = props[key];
      if (f.include !== undefined && f.include.length > 0) {
        const c = categoryOf(value);
        if (c === undefined || !f.include.includes(c)) return false;
      }
      if (f.range !== undefined) {
        if (typeof value !== "number" || !Number.isFinite(value)) return false;
        if (value < f.range[0] || value > f.range[1]) return false;
      }
    }
    return true;
  });
  return { ...fc, features };
}

/** One-line description of the active filters, e.g. "sac_scale: hiking, mountain_hiking · acres ≥ 500". */
export function filterSummary(fields: FilterField[], filters: LayerFilters): string {
  const parts: string[] = [];
  for (const [key, f] of Object.entries(filters)) {
    if (f.include !== undefined && f.include.length > 0) {
      parts.push(`${key}: ${f.include.join(", ")}`);
    }
    if (f.range !== undefined) {
      const [lo, hi] = f.range;
      const field = fields.find((x) => x.key === key && x.kind === "range");
      const atMin = field?.kind === "range" && lo <= field.min;
      const atMax = field?.kind === "range" && hi >= field.max;
      if (atMin && atMax) continue;
      if (atMax) parts.push(`${key} ≥ ${lo}`);
      else if (atMin) parts.push(`${key} ≤ ${hi}`);
      else parts.push(`${key} ${lo}–${hi}`);
    }
  }
  return parts.join(" · ");
}

/**
 * The spread of a layer's primary measure `v`: its smallest and largest number, whether every value is whole, and
 * the slider curve (1 linear; 3 when most values sit in the bottom tenth, as fire acres do, so the low end has room).
 */
export type MeasureRange = { min: number; max: number; integer: boolean; curve: 1 | 3 };

/**
 * The range of numeric `v` across a layer's features (popularity score, fire acres, lake depth, wave height...), or
 * null when it has fewer than two distinct numbers: then there is nothing to threshold and the panel keeps opacity.
 */
export function measureRange(fc: GeoJSON.FeatureCollection): MeasureRange | null {
  const values: number[] = [];
  let integer = true;
  for (const f of fc.features) {
    const v: unknown = f.properties?.v;
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    values.push(v);
    if (!Number.isInteger(v)) integer = false;
  }
  if (values.length < 2) return null;
  values.sort((a, b) => a - b);
  const min = values[0];
  const max = values[values.length - 1];
  if (!(max > min)) return null;
  const median = values[Math.floor(values.length / 2)];
  return { min, max, integer, curve: median - min < (max - min) / 10 ? 3 : 1 };
}

/** Positions on the threshold slider (an integer track, so the curve can stretch the low end). */
export const MEASURE_STEPS = 1000;

/** A slider position (0 to MEASURE_STEPS) as a `v` minimum, rounded to whole numbers for whole-number measures. */
export function measureAt(position: number, range: MeasureRange): number {
  const t = Math.min(1, Math.max(0, position / MEASURE_STEPS)) ** range.curve;
  const value = range.min + (range.max - range.min) * t;
  return range.integer ? Math.round(value) : Math.round(value * 100) / 100;
}

/** The slider position for a `v` minimum (the inverse of `measureAt`). */
export function measurePosition(value: number, range: MeasureRange): number {
  const t = Math.min(1, Math.max(0, (value - range.min) / (range.max - range.min)));
  return Math.round(t ** (1 / range.curve) * MEASURE_STEPS);
}

/**
 * The layer panel's threshold slider as filters: a minimum on `v` through the filters engine, so the count, export
 * and permalink follow. At (or below) the data minimum the `v` filter is dropped (no filter); above it `v` keeps
 * features from `value` up to the upper bound already set in the filters panel, else the data maximum. Other
 * properties' filters are untouched. Back at the data minimum an upper bound below the data maximum is restored as
 * [min, upper] rather than dropped.
 */
export function withMeasureMinimum(filters: LayerFilters, value: number, range: MeasureRange): LayerFilters {
  const { v: current, ...rest } = filters;
  const include = current?.include?.length ? { include: current.include } : {};
  // An upper bound below the data maximum (the agent's "under 1,000 acres", the filters panel) is kept at any minimum.
  const upper = current?.range && current.range[1] < range.max ? current.range[1] : range.max;
  if (!Number.isFinite(value) || value <= range.min) {
    // Back at the data minimum: no minimum. A kept upper bound (or a category list on `v`) stays.
    if (upper < range.max) return { ...rest, v: { ...include, range: [range.min, upper] } };
    return current?.include?.length ? { ...rest, v: include } : rest;
  }
  const lo = Math.min(value, range.max);
  return { ...rest, v: { ...include, range: [lo, Math.max(lo, upper)] } };
}

/** The slider's position for the current filters: the `v` range's lower bound, else the data minimum. */
export function measureMinimum(filters: LayerFilters | undefined, range: MeasureRange): number {
  const lo = filters?.v?.range?.[0];
  return lo === undefined ? range.min : Math.min(range.max, Math.max(range.min, lo));
}
