import type { Feature, FeatureCollection } from "geojson";
import type {
  Attribute,
  BBox,
  LabelSpec,
  Layer,
  LayerError,
  LayerResult,
  LegendItem,
  LegendSpec,
  LegendStop,
  SourceStatus,
  TileTime,
  TimeSpec,
} from "./types";

/**
 * The layer contract's inferred defaults (docs/layer-contract.md): what time means for a layer, its legend, its on-map
 * labels, its units and clock, its card title and whether its source answered. Each helper reads the layer's own
 * declaration first and infers the rest from what the layer already says (attributes, encode, card, coverage), so every
 * layer works without declaring anything new.
 */

/* ---------- Time ---------- */

/** Most distinct dates that still read as snapshots rather than a continuous record. */
export const MAX_SNAPSHOTS = 6;

type Step = NonNullable<TimeSpec["step"]>;

const CADENCE_STEP: Record<TileTime["cadence"], Step> = { daily: "day", "8day": "day", "16day": "day", monthly: "month", yearly: "year" };

/** A time value as an ISO date string (YYYY, YYYY-MM, YYYY-MM-DD or a full timestamp); null when it is not one. */
function isoOf(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (Number.isInteger(raw) && raw >= 1000 && raw <= 3000) return String(raw);
    if (raw > 1e11) return new Date(raw).toISOString();
    return null;
  }
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s))) return s;
  return null;
}

/** The finest resolution the values carry: year-only, month-only, timed within a few days (hour), else day. */
function stepOf(values: string[]): Step {
  if (values.every((v) => /^\d{4}$/.test(v))) return "year";
  if (values.every((v) => /^\d{4}-\d{2}$/.test(v))) return "month";
  const timed = values.filter((v) => v.length > 10);
  if (timed.length > 0) {
    const ms = timed.map((v) => Date.parse(v)).sort((a, b) => a - b);
    if (ms[ms.length - 1] - ms[0] <= 3 * 86_400_000) return "hour";
  }
  return "day";
}

function featuresOf(data: LayerResult | FeatureCollection | undefined): Feature[] | null {
  if (!data) return null;
  if ("type" in data && data.type === "FeatureCollection") return data.features;
  if ("kind" in data && data.kind === "geojson") return data.data.features;
  return null;
}

/**
 * What time means for this layer's answer (TimeSpec). A declared `layer.time` wins (its snapshot dates and span are
 * filled from the data when it leaves them out). Otherwise: a series is continuous by its step; a dated tile layer is
 * continuous by its cadence; features are read by `style.timeField` (default `t`): none dated is `none`, one date is
 * `single`, 2 to 6 dates holding two or more features each on average are `snapshots`, anything else `continuous`.
 * Without data, a layer with a series is continuous and a layer with a time field or attribute is continuous (the
 * panel opens as before); the rest are `none`. A layer whose features are sites with one latest reading each
 * (groundwater wells) should declare `time: { shape: "single" }`: the data alone cannot tell it from events.
 */
export function timeShapeOf(layer: Pick<Layer, "time" | "style" | "attributes">, data?: LayerResult | FeatureCollection): TimeSpec {
  const declared = layer.time;
  const fromData = inferFromData(layer, data);
  if (declared) {
    if (!fromData) return declared;
    const days = datedDays(layer, data);
    return {
      ...declared,
      ...(declared.dates === undefined && declared.shape === "snapshots" && days.length > 0 && { dates: days }),
      ...(declared.span === undefined && fromData.span && { span: fromData.span }),
      ...(declared.step === undefined && fromData.step && { step: fromData.step }),
    };
  }
  if (fromData) return fromData;
  if (layer.style.series) return { shape: "continuous", step: layer.style.series };
  if (layer.style.timeField !== undefined || (layer.attributes ?? []).some((a) => a.type === "time")) return { shape: "continuous" };
  return { shape: "none" };
}

/** The features' time values (by `style.timeField`, default `t`) as ISO strings, undated ones left out. */
function datedValues(layer: Pick<Layer, "style">, features: Feature[]): string[] {
  const field = layer.style.timeField ?? "t";
  const values: string[] = [];
  for (const f of features) {
    const iso = isoOf(f.properties?.[field]);
    if (iso !== null) values.push(iso);
  }
  return values;
}

/** True when some id-like property (`glacierId`, `osmId`) names one thing on two different dates: one thing surveyed twice. */
function seenAtTwoDates(layer: Pick<Layer, "style">, features: Feature[]): boolean {
  const field = layer.style.timeField ?? "t";
  const keys = new Set<string>();
  for (const f of features.slice(0, 50)) for (const k of Object.keys(f.properties ?? {})) if (/(^id$|Id$|_id$)/.test(k)) keys.add(k);
  for (const key of keys) {
    const first = new Map<string, string>();
    for (const f of features) {
      const id = f.properties?.[key];
      const t = isoOf(f.properties?.[field]);
      if ((typeof id !== "string" && typeof id !== "number") || t === null) continue;
      const had = first.get(String(id));
      if (had === undefined) first.set(String(id), t.slice(0, 10));
      else if (had !== t.slice(0, 10)) return true;
    }
  }
  return false;
}

/** Distinct dates by calendar day (or the coarser year or month the values carry), oldest first. */
const distinctDays = (values: string[]) => [...new Set(values.map((v) => v.slice(0, 10)))].sort();

const datedDays = (layer: Pick<Layer, "style">, data?: LayerResult | FeatureCollection) => distinctDays(datedValues(layer, featuresOf(data) ?? []));

function inferFromData(layer: Pick<Layer, "style">, data?: LayerResult | FeatureCollection): TimeSpec | null {
  if (data && "kind" in data) {
    if (data.kind === "tiles") {
      const t = data.data.time;
      if (!t) return null;
      return { shape: "continuous", step: CADENCE_STEP[t.cadence], ...(t.to !== undefined && { span: { start: t.from, end: t.to } }) };
    }
    if (data.series && data.series.times.length > 0) {
      const { times, step } = data.series;
      return { shape: "continuous", step, span: { start: times[0], end: times[times.length - 1] } };
    }
  }
  const features = featuresOf(data);
  if (!features || features.length === 0) return null;
  const values = datedValues(layer, features);
  if (values.length === 0) return { shape: "none" };
  const days = distinctDays(values);
  const span = { start: days[0], end: days[days.length - 1] };
  if (days.length === 1) return { shape: "single", dates: days, span };
  if (days.length <= MAX_SNAPSHOTS && (values.length >= 2 * days.length || seenAtTwoDates(layer, features))) {
    return { shape: "snapshots", dates: days, span, step: stepOf(days) };
  }
  return { shape: "continuous", span, step: stepOf(values) };
}

/* ---------- Legend ---------- */

const NAMED_AS = /,| \(| — | - |:/;

/** The layer's title up to its first comma, bracket or dash: "Whitewater rapids, put-ins…" → "Whitewater rapids". */
export function shortTitle(layer: Pick<Layer, "title" | "id">): string {
  const t = (layer.title ?? "").split(NAMED_AS)[0].trim();
  return t || layer.title?.trim() || layer.id;
}

function levelItems(a: Attribute): LegendItem[] {
  const seen = new Set<string>();
  const items: LegendItem[] = [];
  for (const level of a.levels ?? []) {
    if (seen.has(level.label)) continue;
    seen.add(level.label);
    items.push({ label: level.label, value: level.value, ...(level.help && { help: level.help }) });
  }
  return items;
}

/** The most common values of `key` in the data, as legend items (a category declared without levels). */
function dataItems(key: string, features: Feature[] | null, max = 8): LegendItem[] {
  if (!features) return [];
  const counts = new Map<string, number>();
  for (const f of features) {
    const raw = f.properties?.[key];
    for (const v of Array.isArray(raw) ? raw : [raw]) {
      if (typeof v !== "string" && typeof v !== "number") continue;
      const s = String(v).trim();
      if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([v]) => ({ label: humanise(v), value: v }));
}

/** Stops from a measure's presets (their lower bounds, low to high), else plain "Lower" and "Higher" ends. */
function measureStops(a: Attribute): LegendStop[] {
  const bounds = (a.presets ?? [])
    .map((p) => ({ label: p.label, value: p.min ?? p.max }))
    .filter((p): p is { label: string; value: number } => typeof p.value === "number")
    .sort((x, y) => x.value - y.value);
  if (bounds.length >= 2) return bounds;
  return [{ label: `Lower ${a.label.toLowerCase()}` }, { label: `Higher ${a.label.toLowerCase()}` }];
}

const categoryLegend = (a: Attribute, items: LegendItem[]): LegendSpec => ({ kind: "categories", title: a.label, field: a.key, ...(a.unit && { unit: a.unit }), items });

/**
 * The layer's legend (LegendSpec): its declared `legend`, else derived from what it draws. In order: the attribute that
 * `style.encode.color` reads (its levels as categories, or a measure as a ramp); a score layer's 0 to 100 ramp; the
 * primary (or first) category or ordinal with levels; the measure that sizes the symbols; a category's most common
 * values in `data`; and last one swatch for the whole layer in its color, with the description's first sentence as the
 * note for a tile layer. Never empty. Colors are left to the renderer where it picks them (ramp positions).
 */
export function legendOf(layer: Pick<Layer, "id" | "title" | "description" | "legend" | "attributes" | "style">, data?: LayerResult | FeatureCollection): LegendSpec {
  // An answer that carries its own key (the colors it drew) wins over the layer's declaration.
  if (data && "kind" in data && data.legend) return data.legend;
  if (layer.legend) return layer.legend;
  const attrs = layer.attributes ?? [];
  const byKey = (key: string | undefined) => (key === undefined ? undefined : attrs.find((a) => a.key === key));
  const features = featuresOf(data);

  const colorAttr = byKey(layer.style.encode?.color) ?? attrs.find((a) => a.encode === "color");
  if (colorAttr) {
    if ((colorAttr.type === "category" || colorAttr.type === "ordinal") && (colorAttr.levels?.length ?? 0) > 0) {
      return categoryLegend(colorAttr, levelItems(colorAttr));
    }
    if (colorAttr.type === "measure") {
      return { kind: "ramp", title: colorAttr.label, field: colorAttr.key, ...(colorAttr.unit && { unit: colorAttr.unit }), stops: measureStops(colorAttr) };
    }
  }
  if (layer.style.unit === "score") {
    return { kind: "ramp", title: "Score", field: "v", unit: "score", stops: [{ label: "0", value: 0 }, { label: "100", value: 100 }] };
  }
  const chips = attrs.filter((a) => (a.type === "category" || a.type === "ordinal") && (a.levels?.length ?? 0) > 0);
  const chipAttr = chips.find((a) => a.primary) ?? chips[0];
  if (chipAttr) return categoryLegend(chipAttr, levelItems(chipAttr));
  const sizeAttr = byKey(layer.style.encode?.size) ?? attrs.find((a) => a.type === "measure" && a.encode === "size");
  if (sizeAttr && sizeAttr.type === "measure") {
    return { kind: "size", title: sizeAttr.label, field: sizeAttr.key, ...(sizeAttr.unit && { unit: sizeAttr.unit }), stops: measureStops(sizeAttr) };
  }
  const openCategory = attrs.find((a) => a.type === "category");
  if (openCategory) {
    const items = dataItems(openCategory.key, features);
    if (items.length > 0) return categoryLegend(openCategory, items);
  }
  const tiles = data !== undefined && "kind" in data && data.kind === "tiles";
  const raster = layer.style.raster;
  const symbol: LegendItem["symbol"] = raster !== undefined || tiles ? "raster" : layer.style.geometry;
  const note = symbol === "raster" ? firstSentence(layer.description) : undefined;
  return {
    kind: "symbol",
    items: [{ label: shortTitle(layer), color: raster?.swatch ?? layer.style.color, symbol }],
    ...(layer.style.unit && layer.style.unit !== "score" && { unit: layer.style.unit }),
    ...(note && { note }),
  };
}

function firstSentence(text: string): string | undefined {
  const m = /^(.+?[.!?])(\s|$)/.exec(text.trim());
  const s = (m ? m[1] : text).trim();
  return s || undefined;
}

/* ---------- Labels ---------- */

/** How many top features get a label when the layer does not say. */
export const DEFAULT_LABEL_MAX = 5;

/**
 * The layer's on-map labels (LabelSpec): its declared `labels`, else the names of the top DEFAULT_LABEL_MAX features
 * ranked by the card's measure (`card.measure.key`) when it has one; undefined (no labels) otherwise.
 */
export function labelsOf(layer: Pick<Layer, "labels" | "card">): LabelSpec | undefined {
  if (layer.labels) return layer.labels;
  const measure = layer.card?.measure;
  if (!measure) return undefined;
  return { field: "name", max: DEFAULT_LABEL_MAX, rankBy: measure.key };
}

/* ---------- Display ---------- */

export type ResolvedDisplay = {
  units: "us" | "metric";
  /** The other system, shown second ("5,280 ft (1,609 m)"). */
  secondaryUnits: "us" | "metric";
  timeZone: "local" | "utc";
  /** Times print their zone abbreviation ("2:15 PM PDT"). */
  showZone: true;
};

/** The United States with Alaska, Hawaii and the territories, as a box. */
const US_BOX: BBox = [-180, 13, -64, 72];

function usCentred(coverage: Layer["coverage"]): boolean {
  if (coverage === "us") return true;
  if (coverage === "global") return false;
  const [w, s, e, n] = coverage.bbox;
  const [cx, cy] = [(w + e) / 2, (s + n) / 2];
  return cx >= US_BOX[0] && cx <= US_BOX[2] && cy >= US_BOX[1] && cy <= US_BOX[3];
}

/**
 * Units and clock for a layer (DisplaySpec with defaults): US units first with metric second for US-centred data
 * (coverage `us`, or a box centred in the US), metric first with US second elsewhere; local time with the zone
 * abbreviation unless the layer says `utc`.
 */
export function displayOf(layer: Pick<Layer, "display" | "coverage">): ResolvedDisplay {
  const units = layer.display?.units ?? (usCentred(layer.coverage) ? "us" : "metric");
  return { units, secondaryUnits: units === "us" ? "metric" : "us", timeZone: layer.display?.timeZone ?? "local", showZone: true };
}

/* ---------- Card title ---------- */

const NAME_KEYS = ["heading", "name", "title", "species"] as const;
const KIND_KEYS = ["kind", "type", "category"] as const;
const PLACE_KEYS = ["place", "nearest", "near", "town", "location", "county"] as const;

function humanise(s: string): string {
  const t = s.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

function textProp(props: Record<string, unknown>, keys: readonly string[]): { key: string; value: string } | null {
  for (const key of keys) {
    const v = props[key];
    if (typeof v === "string" && v.trim() && !/^feature$/i.test(v.trim())) return { key, value: v.trim() };
  }
  return null;
}

/**
 * The inspect card's title for a feature, never "Feature": its name (`heading`, `name`, `title` or `species`); else
 * its kind and nearest place ("Earthquake 10 km WSW of South Lake Tahoe, CA", "Rapid near Fayetteville"), the kind
 * read through the layer's levels for that key when it has them; else the kind or the layer's short title with its
 * rank ("Wolf packs #3"), `rank` from the argument or the feature's own `rank`.
 */
export function cardTitle(layer: Pick<Layer, "id" | "title" | "attributes">, feature: Pick<Feature, "properties">, rank?: number): string {
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  const name = textProp(props, NAME_KEYS);
  if (name) return name.value;
  const kindProp = textProp(props, KIND_KEYS);
  const level = kindProp ? layer.attributes?.find((a) => a.key === kindProp.key)?.levels?.find((l) => String(l.value) === kindProp.value) : undefined;
  const kind = level?.label ?? (kindProp ? humanise(kindProp.value) : null);
  const place = textProp(props, PLACE_KEYS)?.value;
  const noun = kind ?? shortTitle(layer);
  if (place) return /^\d.*\bof\b/i.test(place) ? `${noun} ${place}` : `${noun} near ${place}`;
  const r = rank ?? (typeof props.rank === "number" ? props.rank : undefined);
  const title = r !== undefined ? `${noun} #${r}` : noun;
  return /^feature$/i.test(title) ? layer.id : title;
}

/* ---------- Source status ---------- */

/** The answer's SourceStatus: what the layer or the fetch wrapper set, else `{ ok: true }`. */
export function sourceStatusOf(body: LayerResult | LayerError): SourceStatus {
  return body.sourceStatus ?? { ok: true };
}

/* ---------- Validation ---------- */

const SHAPES: readonly TimeSpec["shape"][] = ["none", "single", "snapshots", "continuous"];
const STEPS: readonly Step[] = ["hour", "day", "month", "year"];
const LEGEND_KINDS: readonly LegendSpec["kind"][] = ["categories", "ramp", "size", "symbol", "image"];
const isDate = (s: unknown) => typeof s === "string" && isoOf(s) !== null;

/** What is wrong with a legend, as sentences; empty when nothing is. */
export function legendProblems(legend: LegendSpec, where: string): string[] {
  const problems: string[] = [];
  if (!LEGEND_KINDS.includes(legend.kind)) problems.push(`${where} legend has an unknown kind`);
  const items = legend.items ?? [];
  const stops = legend.stops ?? [];
  for (const item of items) if (!item.label?.trim()) problems.push(`${where} legend item has no label`);
  for (const stop of stops) if (!stop.label?.trim()) problems.push(`${where} legend stop has no label`);
  if ((legend.kind === "categories" || legend.kind === "symbol") && items.length === 0) problems.push(`${where} ${legend.kind} legend has no items`);
  if ((legend.kind === "ramp" || legend.kind === "size") && stops.length < 2) problems.push(`${where} ${legend.kind} legend needs two or more stops`);
  const values = stops.map((s) => s.value).filter((v): v is number => v !== undefined);
  if (values.some((v, i) => i > 0 && v < values[i - 1])) problems.push(`${where} legend stops run backwards`);
  if (legend.kind === "image" && !(legend.imageUrl && /^(https:\/\/|\/)\S+$/.test(legend.imageUrl))) problems.push(`${where} image legend needs an https or site imageUrl`);
  return problems;
}

/**
 * What is wrong with a layer's time, legend, labels and display declarations, as sentences (checked at registry load
 * with attributeProblems). The legend is checked as resolved by legendOf, so every layer must resolve to a usable key.
 */
export function contractProblems(layer: Layer): string[] {
  const problems: string[] = [];
  const t = layer.time;
  if (t) {
    if (!SHAPES.includes(t.shape)) problems.push(`${layer.id} time has an unknown shape`);
    if (t.step !== undefined && !STEPS.includes(t.step)) problems.push(`${layer.id} time has an unknown step`);
    for (const d of t.dates ?? []) if (!isDate(d)) problems.push(`${layer.id} time date ${String(d)} is not an ISO date`);
    if (t.dates && [...t.dates].sort().join() !== t.dates.join()) problems.push(`${layer.id} time dates are not oldest first`);
    if (t.span) {
      if (!isDate(t.span.start) || !isDate(t.span.end)) problems.push(`${layer.id} time span is not two ISO dates`);
      else if (t.span.start > t.span.end) problems.push(`${layer.id} time span runs backwards`);
    }
    if (t.shape !== "snapshots" && t.dates !== undefined && t.shape !== "single") problems.push(`${layer.id} time lists dates but is ${t.shape}`);
  }
  problems.push(...legendProblems(legendOf(layer), layer.id));
  const l = layer.labels;
  if (l) {
    if (!l.field?.trim()) problems.push(`${layer.id} labels have no field`);
    if (!Number.isInteger(l.max) || l.max < 1) problems.push(`${layer.id} labels max must be a whole number of 1 or more`);
    if (l.minZoom !== undefined && !(l.minZoom >= 0 && l.minZoom <= 22)) problems.push(`${layer.id} labels minZoom must be 0 to 22`);
  }
  const d = layer.display;
  if (d?.units !== undefined && d.units !== "us" && d.units !== "metric") problems.push(`${layer.id} display units must be us or metric`);
  if (d?.timeZone !== undefined && d.timeZone !== "local" && d.timeZone !== "utc") problems.push(`${layer.id} display timeZone must be local or utc`);
  return problems;
}
