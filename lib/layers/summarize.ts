import type { Geometry, GeoJsonProperties, Position } from "geojson";
import type { BBox, Citation, LayerError, LayerResult, StyleHints, TileTime } from "@/layers/types";
import { formatValue } from "@/lib/format";

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

/** What the model sees for a geojson result; the full data goes to the map only. */
export type GeojsonSummary = {
  kind: "geojson";
  featureCount: number;
  geometryTypes: Record<string, number>;
  bbox: BBox | null;
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
  /** Wide results that left features out: always true when present. */
  truncated?: true;
  /** With truncated: what was ranked out and how the kept features were chosen; the note says so in one clause. */
  rankedOut?: string;
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

/**
 * A sample feature's properties with every string clipped and nested values flattened to clipped JSON.
 * Properties come from upstream users (OSM names, Commons titles), so this bounds both token cost and
 * how much injected text can reach the model.
 */
function sampleProperties(properties: GeoJsonProperties): GeoJsonProperties {
  if (properties === null) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties).slice(0, SAMPLE_MAX_KEYS)) {
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
    "All open water detected on that one day: every lake, fjord, river and coastal inlet in view shows as water, not only floods. " +
    "It is a state, not a change, so it cannot show water rising or falling by itself. " +
    "For rise or shrink use surface-water with product change, or compare two flood-extent dates.",
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

/** The span of the features' dates, or undefined when none carries one. */
function datesOf(features: { properties: GeoJsonProperties }[], timeField: string): DateSpan | undefined {
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
    scrubber: `Already open in the layer panel over ${span}; say so in the note and do not offer it as a follow-up.`,
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

/** What the summary reads from a layer's style: v's unit, the date field and the geometry. */
export type SummaryStyle = Partial<Pick<StyleHints, "unit" | "timeField" | "geometry">>;

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
  const stats = statsOf(features, style.unit, timeField, layerId === undefined ? undefined : SERIES_ID[layerId]);
  const dates = datesOf(features, timeField);
  const lines = (geometryTypes.LineString ?? 0) + (geometryTypes.MultiLineString ?? 0);
  const polygons = (geometryTypes.Polygon ?? 0) + (geometryTypes.MultiPolygon ?? 0);
  const totalLengthKm = lines > 0 ? round(features.reduce((km, f) => km + lineLengthKm(f.geometry), 0)) : undefined;
  const areaUnit = style.unit !== undefined && AREA_UNITS.has(style.unit) ? style.unit : undefined;
  return {
    kind: "geojson",
    featureCount: features.length,
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
