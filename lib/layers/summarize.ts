import type { Geometry, GeoJsonProperties, Position } from "geojson";
import type { Attribute, BBox, Citation, FieldHelp, LayerError, LayerResult, SourceStatus, StyleHints, TileTime, TimeSpec } from "@/layers/types";
import { shortTitle, timeShapeOf } from "@/layers/contract";
import { changeStatement, epochLabel, epochWindow, identityKey, snapshotEpochs } from "@/lib/render/change";
import { failureLine } from "@/lib/render/contract";
import { attributeGroups, declaredGroups, isChipAttribute } from "@/lib/render/attributes";
import { formatValue } from "@/lib/format";
import { seriesStory, type SeriesStory } from "./story";

/** The key the few sample features go under, so the model reads them as examples and never quotes them as the range. */
export const SAMPLES_KEY = "samples (not representative)";

/** One of the largest features by v. */
export type TopValue = { name: string; v: number; date?: string };

/** Statistics of the numeric value v over every feature (not a sample), in the layer's unit. */
export type ValueStats = {
  unit?: string;
  count: number;
  min: number;
  max: number;
  mean: number;
  sum: number;
  /** Largest first, at most STATS_TOP_SIZE. */
  top: TopValue[];
  /**
   * Set when one thing is mapped once per date (a glacier outline per survey): the stats then cover the newest dated
   * feature of each, so the sum is not counted twice, and this says so.
   */
  basis?: string;
};

/** The dates of the features (the time field the scrubber reads), so the note can say what range the scrubber spans. */
export type DateSpan = {
  from: string;
  to: string;
  /** Distinct years, when there are at most DATE_YEARS_MAX of them. */
  years?: string[];
  yearCount: number;
  /** How many features carry a date. */
  dated: number;
  /** The time scrubber opens over these dates on its own, which the note says rather than offering it. */
  scrubber: string;
};

/** The named features highest by the primary measure, highest first. */
export type Highest = { by: string; unit?: string; top: { name: string; value: number }[] };

/** Most features listed in `highest`. */
export const HIGHEST_SIZE = 3;

/** What the model sees for a geojson result; the full data goes to the map only. */
export type GeojsonSummary = {
  kind: "geojson";
  featureCount: number;
  geometryTypes: Record<string, number>;
  bbox: BBox | null;
  /**
   * The three named features highest by the layer's primary measure (its sized measure, else v), so the note can name
   * the top one when the question asks which ranks highest.
   */
  highest?: Highest;
  /** Over every feature with a numeric v. */
  stats?: ValueStats;
  /** Lines only: the length of every line together, in km. */
  totalLengthKm?: number;
  /** Polygons whose v is an area: the stats' sum, named as the total area. */
  totalArea?: { value: number; unit: string };
  /** Present when features carry dates: the time scrubber is open over this span. */
  dates?: DateSpan;
  [SAMPLES_KEY]: GeoJsonProperties[];
  /** For layers whose features are candidates to name (routes, parks): the largest few as short text, largest first. */
  top?: string[];
  citation: Citation;
  coverageNote?: string;
  /** Snapshot layers (survey dates): the change between the first and last epoch, from every feature. */
  change?: SnapshotChange;
  /** A source that failed: its status, and the line the note must say. */
  sourceStatus?: SourceStatus;
  failure?: string;
  /** Wide results that left features out: always true when present. */
  truncated?: true;
  /** With truncated: what was ranked out and how the kept features were chosen; the note says so in one clause. */
  rankedOut?: string;
  /**
   * The layer's attributes (spec §12c): the property render.filters takes, its type, and for chips each label's raw
   * values with its count here, so "only sport crags" becomes { disciplines: { include: ["sport"] } }.
   */
  attributes?: AttributeSummary[];
  /** What the layer's numbers and codes mean (spec §12b), by property: the note explains a score in these words. */
  help?: Record<string, string>;
  /**
   * Two measures on one mark (spec §13): what size (or width) and color mean on the map, in words, so the note can end
   * by saying so.
   */
  encoding?: string;
  /**
   * A series result (one value per feature per day or hour): the low, the peak, their ratio and dates, whether it
   * repeats, the drivers and the linked curve's swing, for the caption (spec §13).
   */
  story?: SeriesStory;
};

/** An attribute as the model sees it: `values` maps each chip label to the raw values render.filters includes. */
export type AttributeSummary = {
  key: string;
  label: string;
  type: Attribute["type"];
  values?: { label: string; include: string[]; count: number }[];
  unit?: string;
  /** Ordinal: the source scale the chips normalise from. */
  scale?: string;
  /** Measure: the presets as render.filters ranges. */
  presets?: { label: string; range: [number | null, number | null] }[];
};

export type TilesSummary = {
  kind: "tiles";
  url: string;
  minzoom: number;
  maxzoom: number;
  format: "raster" | "vector";
  sourceLayer?: string;
  geometry?: "point" | "line" | "polygon";
  /** Present when the time scrubber can move this layer: how often it updates and the range it covers. */
  time?: Pick<TileTime, "cadence" | "from" | "to" | "daysBack">;
  /** The years the drawn tiles cover, read from the tile URL; `time` is only the range the scrubber can reach. */
  drawnYears?: string;
  /** What the drawn tiles mean at any scale (a state on one day, or a change), when the layer is easy to misread. */
  shows?: string;
  citation: Citation;
  coverageNote?: string;
  truncated?: true;
  rankedOut?: string;
  sourceStatus?: SourceStatus;
  failure?: string;
};

export type LayerResultSummary = GeojsonSummary | TilesSummary;

const SAMPLE_SIZE = 3;
/** Longest string value kept in a sample property; longer ones end in an ellipsis. */
export const SAMPLE_VALUE_MAX_CHARS = 120;
/** Most properties kept per sample feature. */
const SAMPLE_MAX_KEYS = 20;
/** Upper bound on the whole sample as JSON; samples are dropped from the end until it fits (one always stays). */
export const SAMPLE_MAX_CHARS = 2_000;

function clip(text: string): string {
  return text.length > SAMPLE_VALUE_MAX_CHARS ? `${text.slice(0, SAMPLE_VALUE_MAX_CHARS - 1)}…` : text;
}

/** A series of { t, v } points as its first and last points, its low and high, and how many points: null otherwise. */
export function seriesSpan(value: unknown): { first: { t: string; v: number }; last: { t: string; v: number }; low: { t: string; v: number }; high: { t: string; v: number }; points: number } | null {
  if (!Array.isArray(value)) return null;
  const points = value.flatMap((p): { t: string; v: number }[] =>
    p && typeof p === "object" && typeof (p as { v?: unknown }).v === "number" && Number.isFinite((p as { v: number }).v) ? [{ t: String((p as { t?: unknown }).t ?? ""), v: (p as { v: number }).v }] : [],
  );
  if (points.length === 0) return null;
  const low = points.reduce((a, b) => (b.v < a.v ? b : a));
  const high = points.reduce((a, b) => (b.v > a.v ? b : a));
  return { first: points[0], last: points[points.length - 1], low, high, points: points.length };
}

/**
 * A sample feature's properties with every string clipped and nested values flattened to clipped JSON.
 * Properties come from upstream users (OSM names, Commons titles), so this bounds both token cost and
 * how much injected text can reach the model.
 */
function sampleProperties(properties: GeoJsonProperties): GeoJsonProperties {
  if (properties === null) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties).slice(0, SAMPLE_MAX_KEYS)) {
    // A feature's series (one value per frame) goes in as its span: first and last points, low and high. Lake Powell's
    // yearly levels ran from 1999, but the note said the series "only goes back about a decade": it never saw it.
    if (key === "series") {
      const span = seriesSpan(value);
      if (span) out.seriesSpan = span;
      continue;
    }
    const name = clip(key);
    if (typeof value === "string") out[name] = clip(value);
    else if (value === null || typeof value === "number" || typeof value === "boolean") out[name] = value;
    else if (value !== undefined) out[name] = clip(JSON.stringify(value) ?? "");
  }
  return out;
}

/** The first SAMPLE_SIZE features' clipped properties, trimmed from the end to SAMPLE_MAX_CHARS. */
export function sampleOf(features: { properties: GeoJsonProperties }[]): GeoJsonProperties[] {
  const sample = features.slice(0, SAMPLE_SIZE).map((f) => sampleProperties(f.properties));
  while (sample.length > 1 && JSON.stringify(sample).length > SAMPLE_MAX_CHARS) sample.pop();
  return sample;
}

function eachPosition(geometry: Geometry | null, visit: (p: Position) => void): void {
  if (!geometry) return;
  switch (geometry.type) {
    case "Point":
      visit(geometry.coordinates);
      return;
    case "MultiPoint":
    case "LineString":
      geometry.coordinates.forEach(visit);
      return;
    case "MultiLineString":
    case "Polygon":
      geometry.coordinates.forEach((ring) => ring.forEach(visit));
      return;
    case "MultiPolygon":
      geometry.coordinates.forEach((poly) => poly.forEach((ring) => ring.forEach(visit)));
      return;
    case "GeometryCollection":
      geometry.geometries.forEach((g) => eachPosition(g, visit));
      return;
  }
}

/** The scrubbable range without the URL template (the model has no use for it). */
function timeSummary(t: TileTime): NonNullable<TilesSummary["time"]> {
  return {
    cadence: t.cadence,
    from: t.from,
    ...(t.to !== undefined && { to: t.to }),
    ...(t.daysBack !== undefined && { daysBack: t.daysBack }),
  };
}

/**
 * What a tile layer's picture means, for layers whose picture is easy to misread at a wide view. Keyed by layer id;
 * `years` is the drawn range when the tile URL carries one. These are facts about the data, so the note can only say
 * what the tiles show.
 */
const TILE_MEANING: Record<string, (years: string | undefined) => string> = {
  "flood-extent": () =>
    "Flood water only (Copernicus Global Flood Monitoring), observed over the last 12 days: permanent lakes, rivers and the sea are not drawn. " +
    "For long-term rise or shrink of a lake use surface-water with product change.",
  "surface-water": () =>
    "A 1984-2021 history, not a recent date. Only product change (lost red, gained green) or transitions shows change; occurrence, seasonality and recurrence show where water usually is.",
  "forest-loss": (years) =>
    `Tree cover lost in ${years ?? "the years drawn"} only, from any cause (logging, fire, storms, plantation harvest); quote these years, not the archive range in time.`,
  "land-cover": () => "One snapshot of what covers the ground, not change.",
  greenness: () => "Vegetation greenness for one period, a state, not change; compare two dates for change.",
  "snow-cover": () => "Snow on the ground on one day, a state, not change; compare two dates for change.",
  "sea-ice": () => "Sea ice on one day, a state, not change; compare two dates for change.",
  "night-lights": () => "Night brightness for one period, a state, not change; compare two dates for change.",
  "protected-areas-world": () =>
    "Where protected areas (parks, reserves) are, as a picture: not trails, and not countable or nameable from the tiles. Under 500,000 km² the layer returns named parks instead.",
  "gbif-occurrences": () => "How many records were reported per place, which follows where people look, not how many animals live there.",
};

/** Most features listed in `top`. */
export const TOP_SIZE = 8;

type Props = Record<string, unknown>;

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/**
 * How to name one feature in `top`, per layer: "Piste de Bélizon, 207.1 km (regional route)" or
 * "Nouragues, National Nature Reserve, 1,066 km² (GUF)". Null leaves the feature out (a trail that is not a route).
 */
const TOP_FEATURE: Record<string, (p: Props) => string | null> = {
  "osm-trails": (p) => {
    const name = text(p.name);
    const km = num(p.lengthKm);
    if (p.kind !== "route" || name === undefined || km === undefined) return null;
    const network = text(p.network);
    return `${name}, ${formatValue("lengthKm", km, "km", 1)} km${network ? ` (${network} route)` : ""}`;
  },
  "protected-areas-world": (p) => {
    const name = text(p.name);
    if (name === undefined) return null;
    const area = num(p.areaKm2);
    const parts = [name, text(p.designation), area === undefined ? undefined : `${formatValue("areaKm2", area, "km²", 1)} km²`];
    const country = text(p.country);
    return `${parts.filter(Boolean).join(", ")}${country ? ` (${country})` : ""}`;
  },
};

/** The largest TOP_SIZE features by v, named by the layer's TOP_FEATURE, or undefined for other layers or none. */
function topOf(layerId: string | undefined, features: { properties: GeoJsonProperties }[]): string[] | undefined {
  const describe = layerId === undefined ? undefined : TOP_FEATURE[layerId];
  if (describe === undefined) return undefined;
  const v = (p: GeoJsonProperties) => num(p?.v) ?? -Infinity;
  const top = [...features]
    .sort((a, b) => v(b.properties) - v(a.properties))
    .map((f) => (f.properties ? describe(f.properties) : null))
    .filter((line): line is string => line !== null)
    .slice(0, TOP_SIZE)
    .map(clip);
  return top.length > 0 ? top : undefined;
}

/** Most features listed in `stats.top`. */
export const STATS_TOP_SIZE = 5;
/** Most distinct years listed in `dates.years`; more only gives the count. */
export const DATE_YEARS_MAX = 12;
/** Longest name kept in `stats.top`. */
const TOP_NAME_MAX_CHARS = 80;

/** Units of v that are areas, so the sum of a polygon layer's v is its total area. */
const AREA_UNITS = new Set(["km²", "km2", "m²", "m2", "ha", "acres", "mi²", "mi2"]);

/**
 * Layers that map one thing once per date under a shared id (glaciers: one outline per survey). Their stats use the
 * newest dated feature of each id, so a glacier outlined in 1966 and 2015 counts once.
 */
const SERIES_ID: Record<string, { field: string; label: string }> = {
  glaciers: { field: "glacierId", label: "glacier" },
};

/** A number rounded to what a note can quote: whole above 100, 2 decimals above 1, else 3. */
function round(n: number): number {
  const places = Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 1 ? 2 : 3;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** A feature's readable name, or undefined. */
function nameOf(p: Props): string | undefined {
  return text(p.name) ?? text(p.title);
}

function dateOf(p: Props, field: string): number | undefined {
  const raw = p[field];
  const ms = typeof raw === "string" ? Date.parse(raw) : typeof raw === "number" ? raw : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** v over every feature: count, min, max, mean, sum and the largest few by name, or undefined when no feature has a numeric v. */
function statsOf(
  features: { properties: GeoJsonProperties }[],
  unit: string | undefined,
  timeField: string,
  series: { field: string; label: string } | undefined,
): ValueStats | undefined {
  let rows = features.flatMap((f) => {
    const p = (f.properties ?? {}) as Props;
    const v = num(p.v);
    return v === undefined ? [] : [{ p, v, t: dateOf(p, timeField) }];
  });
  if (rows.length === 0) return undefined;

  let basis: string | undefined;
  if (series !== undefined && rows.some((r) => text(r.p[series.field]) !== undefined)) {
    const newest = new Map<string, (typeof rows)[number]>();
    rows.forEach((r, i) => {
      const id = text(r.p[series.field]) ?? `#${i}`;
      const held = newest.get(id);
      if (held === undefined || (r.t ?? -Infinity) > (held.t ?? -Infinity)) newest.set(id, r);
    });
    if (newest.size < rows.length) {
      basis = `newest dated feature of each of ${newest.size} ${series.label}s (${rows.length} features in all, some ${series.label}s mapped on several dates)`;
    }
    rows = [...newest.values()];
  }

  const values = rows.map((r) => r.v);
  const sum = values.reduce((a, b) => a + b, 0);
  const top = [...rows]
    .sort((a, b) => b.v - a.v)
    .slice(0, STATS_TOP_SIZE)
    .map((r): TopValue => {
      const name = nameOf(r.p) ?? "Unnamed";
      const date = r.t === undefined ? undefined : isoDay(r.t);
      return {
        name: name.length > TOP_NAME_MAX_CHARS ? `${name.slice(0, TOP_NAME_MAX_CHARS - 1)}…` : name,
        v: round(r.v),
        ...(date !== undefined && { date }),
      };
    });
  return {
    ...(unit !== undefined && { unit }),
    count: rows.length,
    min: round(values.reduce((a, b) => Math.min(a, b))),
    max: round(values.reduce((a, b) => Math.max(a, b))),
    mean: round(sum / rows.length),
    sum: round(sum),
    top,
    ...(basis !== undefined && { basis }),
  };
}

/**
 * The HIGHEST_SIZE named features highest by the primary measure (the measure attribute that sizes features, else the
 * first measure, else v), one per name by its newest dated feature, or undefined when no named feature carries a number
 * for it.
 */
export function highestOf(features: { properties: GeoJsonProperties }[], style: SummaryStyle): Highest | undefined {
  const measures = (style.attributes ?? []).filter((a) => a.type === "measure");
  const measure = measures.find((a) => a.encode === "size") ?? measures[0];
  const key = measure?.key ?? "v";
  const unit = measure?.unit ?? style.unit;
  const rows = features.flatMap((f) => {
    const p = (f.properties ?? {}) as Props;
    const value = num(p[key]);
    const name = nameOf(p);
    const t = typeof p.t === "string" ? Date.parse(p.t) : Number.NaN;
    return value === undefined || name === undefined || /^unnamed\b/i.test(name) ? [] : [{ name, value, t: Number.isFinite(t) ? t : -Infinity }];
  });
  if (rows.length === 0) return undefined;
  // One row per name, by its newest dated feature (a glacier's latest outline, as the Rank by list and the card give it),
  // else its largest.
  const byName = new Map<string, { name: string; value: number; t: number }>();
  for (const r of rows) {
    const had = byName.get(r.name);
    if (!had || r.t > had.t || (r.t === had.t && r.value > had.value)) byName.set(r.name, r);
  }
  const top = [...byName.values()]
    .sort((a, b) => b.value - a.value)
    .slice(0, HIGHEST_SIZE)
    .map((r) => ({ name: r.name.length > TOP_NAME_MAX_CHARS ? `${r.name.slice(0, TOP_NAME_MAX_CHARS - 1)}…` : r.name, value: round(r.value) }));
  return { by: measure?.label ?? "value", ...(unit !== undefined && { unit }), top };
}

/** The span of the features' dates, or undefined when none carries one. */
function datesOf(features: { properties: GeoJsonProperties }[], timeField: string, shape: TimeSpec["shape"] = "continuous"): DateSpan | undefined {
  const times = features.flatMap((f) => {
    const t = f.properties ? dateOf(f.properties as Props, timeField) : undefined;
    return t === undefined ? [] : [t];
  });
  if (times.length === 0) return undefined;
  const years = [...new Set(times.map((t) => isoDay(t).slice(0, 4)))].sort();
  const span = years.length === 1 ? years[0] : `${years[0]} to ${years[years.length - 1]}`;
  return {
    from: isoDay(times.reduce((a, b) => Math.min(a, b))),
    to: isoDay(times.reduce((a, b) => Math.max(a, b))),
    ...(years.length <= DATE_YEARS_MAX && { years }),
    yearCount: years.length,
    dated: times.length,
    scrubber:
      shape === "snapshots"
        ? `Mapped on ${years.length} survey dates (${span}); the map draws the newest of each thing, with a stepper between the dates and a compare of the first and last; state the change (the summary's change), never a total that adds different dates.`
        : shape === "continuous"
          ? `A time panel over ${span} is one tap away in the layer panel; mention it only when the question is about time, and do not offer it as a follow-up.`
          : `Dated ${span}; no time panel (time is not the question for this layer).`,
  };
}

/** Great-circle distance in km between two [lon, lat] positions. */
function haversineKm(a: Position, b: Position): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 12_742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The length of a line geometry in km (0 for other geometries). */
function lineLengthKm(geometry: Geometry | null): number {
  const along = (line: Position[]) => line.reduce((km, p, i) => (i === 0 ? 0 : km + haversineKm(line[i - 1], p)), 0);
  if (geometry?.type === "LineString") return along(geometry.coordinates);
  if (geometry?.type === "MultiLineString") return geometry.coordinates.reduce((km, line) => km + along(line), 0);
  return 0;
}

/** "2015-2025" from a tile URL's start_year and end_year parameters, or undefined when it has none. */
export function drawnYearsOf(url: string): string | undefined {
  const start = /[?&]start_year=(\d{4})(?:&|$)/.exec(url)?.[1];
  const end = /[?&]end_year=(\d{4})(?:&|$)/.exec(url)?.[1];
  if (start === undefined || end === undefined) return undefined;
  return start === end ? start : `${start}-${end}`;
}

/** What the summary reads from a layer's style (v's unit, the date field, the geometry) and its attributes. */
export type SummaryStyle = Partial<Pick<StyleHints, "unit" | "timeField" | "geometry" | "encode">> & {
  attributes?: Attribute[];
  /** The layer's declared time shape (docs/layer-contract.md); inferred from the data when absent. */
  time?: TimeSpec;
  /** The layer's title, for the change statement's noun ("glaciers"). */
  title?: string;
};

/** "Width is Flow (m³/s); color is Water temperature (°C), sage low to purple high": the layer's pair in words. */
export function encodingSentence(style: SummaryStyle, flow = false): string | undefined {
  const named = (key: string | undefined) => {
    const attr = key ? style.attributes?.find((a) => a.key === key) : undefined;
    return attr ? `${attr.label}${attr.unit ? ` (${attr.unit})` : ""}` : undefined;
  };
  const size = named(style.encode?.size);
  const color = named(style.encode?.color);
  if (!size && !color) return undefined;
  const word = flow ? "particle brightness (and streak length)" : style.geometry === "line" ? "line width" : "symbol size";
  const parts = [size && `${word} is ${size}`, color && `color is ${color}, sage low to purple high`].filter(Boolean);
  const text = `${flow ? "Particles drift with the flow; " : ""}${parts.join("; ")}`;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/**
 * The attributes of a result: chip labels with the raw values they stand for and their counts (every declared label,
 * even one with no features here: the model must know Hard is 3 when only easy trails came back), measures with their
 * presets, and the other types by key and label.
 */
function attributeSummaries(style: SummaryStyle, features: { properties: GeoJsonProperties }[]): AttributeSummary[] | undefined {
  const attributes = style.attributes ?? [];
  if (attributes.length === 0) return undefined;
  const data = { type: "FeatureCollection" as const, features: features as GeoJSON.Feature[] };
  return attributes.map((a): AttributeSummary => {
    const base: AttributeSummary = { key: a.key, label: a.label, type: a.type, ...(a.unit && { unit: a.unit }), ...(a.scale && { scale: a.scale }) };
    if (a.type === "measure" && a.presets?.length) return { ...base, presets: a.presets.map((p) => ({ label: p.label, range: [p.min ?? null, p.max ?? null] })) };
    if (a.type === "flag") return { ...base, values: [{ label: a.label, include: ["true"], count: features.filter((f) => f.properties?.[a.key] === true).length }] };
    if (!isChipAttribute(a)) return base;
    const counted = attributeGroups(a, data);
    const declared = declaredGroups(a);
    const values = declared.length
      ? declared.map((g) => ({ label: g.label, include: g.values, count: counted.find((c) => c.label === g.label)?.count ?? 0 }))
      : counted.map((g) => ({ label: g.label, include: g.values, count: g.count }));
    return { ...base, values };
  });
}

/** Help for `v` and the attribute keys, as one line each: the sentence, then its scale and source. */
function helpLines(help: Record<string, FieldHelp> | undefined, style: SummaryStyle): Record<string, string> | undefined {
  const keys = new Set(["v", ...(style.attributes ?? []).map((a) => a.key)]);
  const out: Record<string, string> = {};
  for (const key of keys) {
    const h = style.attributes?.find((a) => a.key === key)?.help ?? help?.[key];
    if (!h) continue;
    out[key] = [h.text, h.scale && `Scale: ${h.scale}.`, h.source && `Source: ${h.source}.`].filter(Boolean).join(" ");
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A small, model-sized view of a layer response: counts, extent, statistics of v over every feature, the dates the
 * time scrubber spans, a few sample properties (labelled not representative) and the citation instead of every
 * feature. Errors pass through. `layerId` adds, for tile layers that are easy to misread, what the picture means
 * (`shows`), and for routes and parks the largest few by name (`top`). `style` gives v's unit and the date field.
 */
export function summarizeLayerResult(
  body: LayerResult | LayerError,
  layerId?: string,
  style: SummaryStyle = {},
  fieldHelp?: Record<string, FieldHelp>,
): LayerResultSummary | LayerError {
  if ("error" in body) return body;

  if (body.kind === "tiles") {
    const drawnYears = drawnYearsOf(body.data.url);
    const meaning = layerId === undefined ? undefined : TILE_MEANING[layerId];
    return {
      kind: "tiles",
      url: body.data.url,
      minzoom: body.data.minzoom,
      maxzoom: body.data.maxzoom,
      format: body.data.format,
      ...(body.data.sourceLayer !== undefined && { sourceLayer: body.data.sourceLayer }),
      ...(body.data.geometry !== undefined && { geometry: body.data.geometry }),
      ...(body.data.time !== undefined && { time: timeSummary(body.data.time) }),
      ...(drawnYears !== undefined && { drawnYears }),
      ...(meaning !== undefined && { shows: meaning(drawnYears) }),
      citation: body.citation,
      ...(body.coverageNote !== undefined && { coverageNote: body.coverageNote }),
      ...truncationOf(body),
      ...failureOf(body, null),
    };
  }

  const features = body.data.features;
  const geometryTypes: Record<string, number> = {};
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const feature of features) {
    const type = feature.geometry?.type ?? "null";
    geometryTypes[type] = (geometryTypes[type] ?? 0) + 1;
    eachPosition(feature.geometry, ([lon, lat]) => {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    });
  }

  const top = topOf(layerId, features);
  const timeField = style.timeField ?? "t";
  const shape = timeShapeOf({ time: style.time, style: { geometry: style.geometry ?? "point", color: "", timeField: style.timeField }, attributes: style.attributes }, body).shape;
  const stats = statsOf(features, style.unit, timeField, layerId === undefined ? undefined : SERIES_ID[layerId]);
  const dates = datesOf(features, timeField, shape);
  const change = shape === "snapshots" ? snapshotChange(features, timeField, style, layerId) : undefined;
  // The finding first: the model reads the dates line, so it carries the change itself.
  if (dates && change) dates.scrubber = `${dates.scrubber} The change to state in the note, as it is: "${change.statement}"`;
  const lines = (geometryTypes.LineString ?? 0) + (geometryTypes.MultiLineString ?? 0);
  const polygons = (geometryTypes.Polygon ?? 0) + (geometryTypes.MultiPolygon ?? 0);
  const totalLengthKm = lines > 0 ? round(features.reduce((km, f) => km + lineLengthKm(f.geometry), 0)) : undefined;
  const areaUnit = style.unit !== undefined && AREA_UNITS.has(style.unit) ? style.unit : undefined;
  const attributes = attributeSummaries(style, features);
  const help = helpLines(fieldHelp, style);
  const highest = highestOf(features, style);
  const encoding = encodingSentence(style, body.flow !== undefined);
  const told = body.series ? seriesStory(features, body.series, style.attributes, body.linked) : undefined;
  // The caption's last sentence says what size (or brightness) and color mean.
  const story = told && encoding ? { ...told, caption: `${told.caption} ${encoding}` } : told;
  return {
    kind: "geojson",
    featureCount: features.length,
    ...(highest !== undefined && { highest }),
    geometryTypes,
    bbox: west <= east ? [west, south, east, north] : null,
    ...(stats !== undefined && { stats }),
    ...(totalLengthKm !== undefined && { totalLengthKm }),
    ...(stats !== undefined && polygons > 0 && areaUnit !== undefined && { totalArea: { value: stats.sum, unit: areaUnit } }),
    ...(dates !== undefined && { dates }),
    [SAMPLES_KEY]: sampleOf(features),
    ...(top !== undefined && { top }),
    citation: body.citation,
    ...(body.coverageNote !== undefined && { coverageNote: body.coverageNote }),
    ...truncationOf(body),
    ...(attributes !== undefined && { attributes }),
    ...(help !== undefined && { help }),
    ...(encoding !== undefined && { encoding }),
    ...(story !== undefined && { story }),
    ...(change !== undefined && { change }),
    ...failureOf(body, features.length),
  };
}

/** A failed source's status and the one line the note says ("NOAA's weather service is returning errors…"). */
function failureOf(body: LayerResult, drawn: number | null): { sourceStatus?: SourceStatus; failure?: string } {
  const line = failureLine(body.sourceStatus, drawn);
  return line && body.sourceStatus ? { sourceStatus: body.sourceStatus, failure: `Say this in the note: ${line}` } : {};
}

/** The change between a snapshot layer's first and last survey epochs, computed from every feature (lib/render/change.ts). */
export type SnapshotChange = { statement: string; a: string; b: string; matched: number; before?: number; after?: number; share?: number };

function snapshotChange(features: GeoJSON.Feature[], timeField: string, style: SummaryStyle, layerId?: string): SnapshotChange | undefined {
  const days = new Set<string>();
  for (const f of features) {
    const t = f.properties?.[timeField];
    if (typeof t === "string" && !Number.isNaN(Date.parse(t))) days.add(t.slice(0, 10));
  }
  const epochs = snapshotEpochs([...days]);
  if (epochs.length < 2) return undefined;
  const [first, last] = [epochs[0], epochs[epochs.length - 1]];
  const inside = (w: [string, string]) => (f: GeoJSON.Feature) => {
    const t = Date.parse(String(f.properties?.[timeField] ?? ""));
    return t >= Date.parse(w[0]) && t <= Date.parse(w[1]);
  };
  const a = features.filter(inside(epochWindow(first)));
  const b = features.filter(inside(epochWindow(last)));
  const has = (k: string) => features.some((f) => typeof f.properties?.[k] === "number");
  const primary = style.attributes?.find((x) => x.type === "measure" && x.encode === "size") ?? style.attributes?.find((x) => x.type === "measure");
  const measure = has("areaKm2")
    ? { key: "areaKm2", label: "Area", unit: "km²" }
    : primary && has(primary.key)
      ? { key: primary.key, label: primary.label, ...(primary.unit && { unit: primary.unit }) }
      : undefined;
  const aLabel = epochLabel(first);
  const bLabel = epochLabel(last);
  const said = changeStatement(a, b, {
    noun: shortTitle({ id: layerId ?? "features", title: style.title ?? layerId ?? "features" }).toLowerCase(),
    aLabel,
    bLabel,
    idKey: identityKey(features, timeField),
    ...(measure && { measure }),
    timeField,
  });
  if (!said) return undefined;
  return {
    statement: said.text,
    a: aLabel,
    b: bLabel,
    matched: said.matched,
    ...(said.before !== undefined && { before: Math.round(said.before * 100) / 100 }),
    ...(said.after !== undefined && { after: Math.round(said.after * 100) / 100 }),
    ...(said.share !== undefined && { share: Math.round(said.share * 1000) / 1000 }),
  };
}

/** `truncated: true` and the rankedOut line of a wide result that left features out; nothing otherwise. */
function truncationOf(body: LayerResult): { truncated?: true; rankedOut?: string } {
  if (body.truncated !== true) return {};
  return { truncated: true, ...(body.rankedOut !== undefined && { rankedOut: body.rankedOut }) };
}

/** True for a full LayerResult (as opposed to an error or an already-summarized result). */
export function isFullLayerResult(value: unknown): value is LayerResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "data" in value &&
    (value.kind === "geojson" || value.kind === "tiles")
  );
}
