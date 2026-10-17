import { z } from "zod";
import type { FeatureCollection, LineString } from "geojson";
import type { CachedFetch } from "@/lib/fetch";

export type BBox = [west: number, south: number, east: number, north: number];

export const BBoxSchema: z.ZodType<BBox> = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .refine(([w, s, e, n]) => w <= e && s <= n, {
    message: "bbox must satisfy west <= east and south <= north",
  })
  .refine(
    ([w, s, e, n]) => w >= -180 && e <= 180 && s >= -90 && n <= 90,
    { message: "bbox longitudes must be within ±180 and latitudes within ±90" },
  );

export type Coverage = "global" | "us" | { bbox: BBox };

export type Citation = { source: string; url: string; retrieved: string };

/**
 * How a tile layer's URL follows the time scrubber. `template` is the tile URL with `{date}` (YYYY-MM-DD) or
 * `{year}` (YYYY) where the time goes; the result's `url` is the same template filled with the default period.
 * The scrubber fills the placeholder from the window end, clamped to `from`/`to`/`daysBack` and snapped to `cadence`.
 */
export type TileTime = {
  template: string;
  cadence: "daily" | "8day" | "16day" | "monthly" | "yearly";
  /** First period published (YYYY-MM-DD or YYYY). */
  from: string;
  /** Last period published (YYYY-MM-DD or YYYY); omit when the archive runs to the present. */
  to?: string;
  /** The newest period is not reliably processed for this many days; the scrubber stays that far behind today. Negative: forecast days the scrubber may run ahead of today. */
  daysBack?: number;
};

/**
 * Set by lib/layers/run.ts on a result fetched with the layer's WIDE strategy (a box over maxAreaKm2) that left features
 * out: what was kept and what was ranked out, so the model never reads a top-N as the whole box.
 */
export type Truncation = {
  truncated: true;
  /** One clause on what was left out and how the kept features were chosen. */
  rankedOut: string;
};

/**
 * The frames of a result whose features carry one value per time step (spec §13, "the whole network, every day";
 * §13a, "hourly frames over days"): each feature holds its values under `properties.series[key]`, one per entry of
 * `times`, and its plain `properties[key]` is the value at `now` (what the card, the ranking and the model read).
 * The time scrubber steps these frames one at a time and the map draws each feature at the frame shown.
 */
export type SeriesAxis = {
  /** ISO timestamps of the frames, oldest first, one step apart. */
  times: string[];
  step: "day" | "hour";
  /** The frame at the time of the query (the newest reading); later frames are forecast. */
  now: number;
  /** The frame from which values are forecast rather than observed or modelled for the past, when the source says. */
  forecastFrom?: number;
};

/**
 * A small time series to plot under the scrubber, synced with the playhead (spec §13a "a linked curve"): the tide at
 * the nearest station for currents. `times` and `values` line up; `place` names where it was read.
 */
export type LinkedSeries = { label: string; unit: string; place: string; times: string[]; values: (number | null)[]; source?: Citation };

/**
 * A vector field drawn as moving particles (spec §13a): the features are nodes of a regular grid (`nx` across and `ny`
 * up, `bbox` their outer nodes), each with its index in the grid under `node` (row by row from the south-west corner;
 * nodes without data, such as land for currents, may be left out) and `u` (east) and `v` (north) in m/s and an
 * optional `color` measure, all as series.
 */
export type FlowField = {
  nx: number;
  ny: number;
  bbox: BBox;
  u: string;
  v: string;
  color?: string;
  /**
   * Where water is, finer than the grid (currents only): `nx` by `ny` cells over `bbox`, row by row from the south-west,
   * one bit per cell (1 water), base64. Particles die on land the coarse grid would let them drift over.
   */
  water?: { nx: number; ny: number; bits: string };
};

export type LayerResult =
  | ({
      kind: "geojson";
      data: FeatureCollection;
      citation: Citation;
      coverageNote?: string;
      /** Present when every feature carries a value per frame: the scrubber steps the frames (see SeriesAxis). */
      series?: SeriesAxis;
      /** A curve to plot under the scrubber, synced with the playhead (the tide for currents). */
      linked?: LinkedSeries;
      /** Present when the features are the nodes of a vector field drawn as particles (ocean currents, wind). */
      flow?: FlowField;
      /** A title that says what this answer holds ("River flow, daily (142 rivers)"), over the layer's own. */
      title?: string;
      /**
       * Wide results only: how many features the source holds in the box (a count pre-check), when the result keeps
       * fewer. lib/layers/run.ts states it in the coverage note ("the 2,000 largest of 4,512").
       */
      total?: number;
    } & Partial<Truncation>)
  | ({
      kind: "tiles";
      data: {
        url: string;
        minzoom: number;
        maxzoom: number;
        format: "raster" | "vector";
        /** Raster tiles only: pixel size of each tile image (default 256; GFW serves 512). */
        tileSize?: number;
        /** Vector tiles only: the layer name inside each tile. */
        sourceLayer?: string;
        /** Vector tiles only: how to draw the features. */
        geometry?: "point" | "line" | "polygon";
        /** Present when the URL can be pointed at a time window; makes the layer scrubbable. */
        time?: TileTime;
        /** Present when the URL can be pointed at other amounts (sea level rise feet); shows the scenario scrubber. */
        scenario?: TileScenario;
      };
      citation: Citation;
      coverageNote?: string;
    } & Partial<Truncation>);

export type LayerError = {
  error: string;
  hint?: "zoom_in" | "unavailable" | "upstream";
  /**
   * With hint zoom_in, when the query came from the user's current map view: the whole-number zoom at which that view
   * fits under the layer's area cap. The chat's error card offers it as "Zoom in to N".
   */
  suggestedZoom?: number;
};

/**
 * How a layer answers a box wider than its maxAreaKm2 (up to its hard cap) instead of erroring: a bounded, ranked fetch.
 * `ranked` (the default) keeps the `limit` largest by `orderBy`; `named` keeps only named features (OSM `[name]`, the
 * most-linked articles), up to `limit`; `tiles` draws a density picture instead of single features.
 */
export type WideStrategy = {
  /** What the kept features are ranked by, in the words the note quotes: "capacity (MW)", "storage (acre-feet)". */
  orderBy?: string;
  /** Most features a wide result carries. */
  limit: number;
  mode?: "ranked" | "named" | "tiles";
  /** The word for the kept features in the note when ranked: "largest" (default), "strongest", "newest", "most recent". */
  rank?: string;
};

export type QueryContext = {
  bbox: BBox;
  zoom: number;
  route?: LineString;
  env: Record<string, string | undefined>;
  fetch: CachedFetch;
  /** Stable key for this request (layer id, bbox rounded to 3 decimals, sorted input); pass it as `cacheKey` to ctx.fetch. */
  cacheKey?: string;
  /**
   * True when the box is over the layer's maxAreaKm2 (and under its hard cap): fetch with `wideStrategy` (bounded and
   * ranked) and set `total` on the result when the source can count. lib/layers/run.ts writes the coverage note.
   */
  wide?: boolean;
  /** The layer's `wide`, passed along when `wide` is true. */
  wideStrategy?: WideStrategy;
};

export type StyleHints = {
  geometry: "point" | "line" | "polygon";
  color: string;
  unit?: string;
  /** Polygons only: fill alpha from 0 (outline only) to 1; the renderer's default when unset. */
  fillOpacity?: number;
  /** Points (columns) and polygons (extruded by `v`): height is the feature's `v` (value) or, for points, 1 per feature (`count`), when the map is in 3D. */
  extrude?: "v" | "count";
  /** True when a heatmap view of the points is meaningful (dense events, observations). */
  heat?: boolean;
  /** True for dense point layers that read better clustered at low zoom. */
  cluster?: boolean;
  /** Feature property holding the ISO date the time scrubber filters on; defaults to `t`. */
  timeField?: string;
  /**
   * Raster tiles only: how Mapbox calms a third-party image so it sits in the palette (raster paint cannot recolor
   * pixels, only desaturate, rotate hue, flatten contrast and fade). Unset takes the renderer's default for third-party
   * rasters (saturation -0.55, opacity 0.72); `null` draws the tiles as served (imagery, the satellite look).
   * `swatch` is the tiles' raw color, so the layer panel's key can show it through the same filter.
   */
  raster?: RasterHint | null;
  /**
   * Two measures on one mark (spec §13): `size` (line width, symbol radius, column height) and `color` (the sage → pink
   * → purple ramp), each the key of one of the layer's attributes (size a measure; color a measure, ordinal or
   * category). The map draws them by default; the render op can swap or switch either off (RenderOp.encode), and the
   * legend names both with their units and range.
   */
  encode?: Encoding;
  /**
   * The layer answers with a value per frame (SeriesAxis): `day` or `hour` steps. Its answer is always the timeline
   * view (lib/agent/renderInput.ts), played frame by frame.
   */
  series?: "day" | "hour";
  /**
   * The basemap the layer reads best on, which its row offers: `data-only` when the data draws the land (river networks,
   * currents), `outdoors` (Topographical, with relief and place names) when the ground matters (wind over mountains).
   */
  basemap?: "data-only" | "outdoors";
};

/** Which attribute sizes a mark and which colors it (spec §13: "height is that day's flow, color is water temperature"). */
export type Encoding = { size?: string; color?: string };

/**
 * What kind of field an attribute is (spec §12c); the type picks the control. `category`: chips with counts (a legend
 * key toggles the same chip). `ordinal`: ordered chips on one shared band set (difficulty, grade, class, severity),
 * drawn on the sage → pink → purple ramp. `measure`: ranked, not filtered ("Rank by", the top 10, symbol size or 3D
 * height); presets from the source's own classes and a clickable mini histogram under More. `time`: the scrubber with
 * presets (a numeric year gets the one two-handle slider, under More). `flag`: a toggle chip. `name`: search within the
 * layer. `place`: "within", usually from chat.
 */
export type AttributeType = "category" | "ordinal" | "measure" | "time" | "flag" | "name" | "place";

/**
 * One field a person can slice the layer by (spec §12c), in the layer's own words. `key` is the feature property it
 * reads. Category and ordinal attributes list their `levels` in order (ordinal: easy to hard, the ramp's order);
 * several values may share a label, and then one chip stands for all of them (Singletrack Scale 0 and 1 are both
 * "Easy"). A category without levels takes its chips from the data (species, the most common first). `multi` marks a
 * property holding a list (a crag's disciplines): a feature matches a chip when any of its items does. `encode` is how
 * the map shows it: `color` (lines on the ordinal ramp), `dash`, `width`, or `size` (a measure: symbol size, column
 * height, hatch density). `versions` marks a category whose values are versions of the same features (monument
 * boundaries 2021 and current): the change view compares the first value present against the last. `primary` picks the
 * one chip set the row shows by default (else the first category or ordinal). Checked at registry load
 * (layers/attributes.ts).
 */
export type Attribute = {
  key: string;
  type: AttributeType;
  label: string;
  unit?: string;
  /** Plain help for the field (spec §12b); defaults to the layer's fieldHelp for `key`. */
  help?: FieldHelp;
  levels?: AttributeLevel[];
  /** Ordinal: the source scale the levels normalise from ("sac_scale", "YDS, UIAA, French and V-scale"). */
  scale?: string;
  /** Measure: presets from the source's own classes ("Class G: 5,000 acres and up"). */
  presets?: MeasurePreset[];
  multi?: boolean;
  encode?: "color" | "dash" | "width" | "size";
  versions?: boolean;
  primary?: boolean;
  /**
   * Measure: how the timeline's live aggregate totals it per frame (spec §13, "a live aggregate per frame"): `sum`
   * (capacity, acres, flow to the sea), `max` (the largest reach's flow) or `mean` (a temperature). A layer with no
   * aggregate measure counts its features per frame instead.
   */
  aggregate?: "sum" | "max" | "mean";
  /** Only features where this property is true are totalled (river pulse: the outlets, so no water is counted twice). */
  aggregateOver?: string;
  /** The total's name in the scrubber and the caption ("Total flow to the sea, all outlets combined"). */
  aggregateLabel?: string;
};

/** One chip of a category or ordinal attribute: the raw value the data holds and its plain label (and what it means). */
export type AttributeLevel = { value: string | number; label: string; help?: string };

/** A measure preset: its label in the source's words and the bounds it keeps (either may be open). */
export type MeasurePreset = { label: string; min?: number; max?: number };

/**
 * Plain help for one property the inspect card shows (spec §12b): one sentence on what it means, its unit and scale,
 * who computed it and the source link, in the source's own words where it documents the field.
 */
export type FieldHelp = { text: string; unit?: string; scale?: string; source?: string; url?: string };

/**
 * How the inspect card presents a feature of this layer (spec §12b, owner 2026-10-14): the measure line ("Routes 5 ⓘ",
 * never "VALUE 5"), the facts in plain labels and units, and links by name ("Open on OpenBeta"). Properties the schema
 * does not name go under a collapsed Details with humanised labels.
 */
export type CardSpec = {
  /** The headline number: usually `v` under its own name. */
  measure?: { key: string; label: string; unit?: string; help?: FieldHelp };
  facts?: CardFact[];
  /** Properties holding URLs, shown as named links. */
  links?: { key: string; label: string }[];
  /** Properties the card never lists: internal codes and repeats of a row it already shows (kind repeating the event). */
  hidden?: string[];
};

/**
 * One fact row. `format`: int (whole number), 1dp (one decimal), km and m (distance in that unit), date (a calendar
 * date), list (comma or array items joined with " · "), link (a URL as a named link), pct (a 0 to 1 share as "22%"). `values` spells out codes
 * ("osm+openbeta" → "OpenStreetMap + OpenBeta"). `parts` folds several numeric properties into one line ("trad 1 ·
 * sport 4"), each under its own word; the row shows when any part has a value. Help defaults to the layer's fieldHelp.
 */
export type CardFact = {
  key: string;
  label: string;
  unit?: string;
  format?: "int" | "1dp" | "km" | "m" | "date" | "list" | "link" | "pct";
  help?: FieldHelp;
  values?: Record<string, string>;
  parts?: { key: string; label: string }[];
};

/** Mapbox raster paint, in Mapbox's units: saturation and contrast -1..1, hueRotate degrees, brightness 0..1, opacity 0..1. */
export type RasterHint = {
  saturation?: number;
  hueRotate?: number;
  contrast?: number;
  brightnessMin?: number;
  brightnessMax?: number;
  opacity?: number;
  swatch?: string;
};

/**
 * Where a layer's features belong (the eval's map checks, lib/checks/mapChecks.ts): `land` (a crag, a trail), `water`
 * (open sea: a buoy, sea ice), `coast` (at the shoreline: a surf break, a tide gauge), or `any` (whales, offshore wind,
 * marine protected areas). The checks read it against a 1:10m land mask with a 2 km coast tolerance, so a land layer
 * drawn out at sea, or a sea layer drawn inland, fails.
 */
export type Surface = "land" | "water" | "coast" | "any";

/** A surface per feature, read from one property (surf: buoys are at sea, forecast spots at the coast). */
export type SurfaceByKey = { key: string; by: Record<string, Surface>; default: Surface };

export type Layer<I extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> = {
  id: string;
  title: string;
  description: string;
  coverage: Coverage;
  /**
   * The one named region every feature lies in, as the geocoder resolves it ("Sierra Nevada" for sequoia groves): a
   * question that names no place and has no map view is about this place (lib/agent/stepGuard.ts looks it up).
   */
  place?: string;
  /** Where the features belong on the globe (land, open water, the coast, or anywhere); see Surface. */
  surface: Surface | SurfaceByKey;
  license: string;
  requiredEnv: string[];
  /** Env vars the layer reads when set but works without; only these and requiredEnv reach ctx.env. */
  optionalEnv?: string[];
  /**
   * Above this area the layer switches to its `wide` strategy (a bounded, ranked fetch) instead of erroring; a layer
   * without `wide` errors above it as before.
   */
  maxAreaKm2: number;
  /**
   * The only hard area limit: above it the query returns a zoom_in error. Defaults to 4 x maxAreaKm2 for a layer with
   * `wide` (see hardMaxAreaKm2), or to the coverage extent for national sources.
   */
  hardMaxAreaKm2?: number;
  /** How to fetch between maxAreaKm2 and the hard cap. */
  wide?: WideStrategy;
  input: I;
  // Method syntax keeps parameter checking bivariant so Layer<specific> is
  // assignable to the default Layer in the registry.
  query(ctx: QueryContext, input: z.infer<I>): Promise<LayerResult | LayerError>;
  style: StyleHints;
  /** Help for the properties the inspect card shows, by property key (`v` included): the card's serif "i" (spec §12b). */
  fieldHelp?: Record<string, FieldHelp>;
  /** How the inspect card lays out a feature (measure, facts, links); without it the card lists every property. */
  card?: CardSpec;
  /** The fields a person can slice the layer by (spec §12c): each one's type picks its control in the layer row. */
  attributes?: Attribute[];
  /**
   * A documented outage of the layer's only source: since when and why, in plain words. The layer still asks the
   * source (so it works again the day the source returns), its tool and list_layers row say it is unavailable, its
   * error says why, and the eval counts a question that needs it as skipped, not passed. Remove it once the source is back.
   */
  outage?: { since: string; reason: string };
};

/** How many times maxAreaKm2 a layer with a `wide` strategy answers by default before the hard zoom_in error. */
export const DEFAULT_WIDE_FACTOR = 4;

/**
 * The area above which a layer returns a zoom_in error: its hardMaxAreaKm2, else 4 x maxAreaKm2 when it has a `wide`
 * strategy, else maxAreaKm2 (no wide strategy, so nothing to fall back on).
 */
export function hardMaxAreaKm2(layer: Pick<Layer, "maxAreaKm2" | "hardMaxAreaKm2" | "wide">): number {
  if (layer.hardMaxAreaKm2 !== undefined) return Math.max(layer.hardMaxAreaKm2, layer.maxAreaKm2);
  return layer.wide === undefined ? layer.maxAreaKm2 : layer.maxAreaKm2 * DEFAULT_WIDE_FACTOR;
}

/** Identity helper so each layer file gets its input type inferred. */
export function defineLayer<I extends z.ZodObject<z.ZodRawShape>>(layer: Layer<I>): Layer<I> {
  return layer;
}

const KM_PER_DEG_LON_EQUATOR = 111.32;
const KM_PER_DEG_LAT = 110.57;

/** Equirectangular approximation of a bbox's area in square kilometres. */
export function bboxAreaKm2(bbox: BBox): number {
  const [west, south, east, north] = bbox;
  const meanLatRad = (((south + north) / 2) * Math.PI) / 180;
  const widthKm = (east - west) * KM_PER_DEG_LON_EQUATOR * Math.cos(meanLatRad);
  const heightKm = (north - south) * KM_PER_DEG_LAT;
  return widthKm * heightKm;
}

/**
 * How a tile layer's URL follows the scenario scrubber (components/ScenarioScrubber.tsx): one tile service per amount,
 * e.g. sea level rise in feet. `template` is the tile URL with `{value}` where the amount goes; the result's `url` is
 * the template filled with the queried amount. `param` is the layer input the amount came from (`feet`), `label` the
 * scrubber's title ("Sea level rise"), `values` the amounts offered in order. `tokens`, when the service names do not
 * spell the number plainly, lists what fills `{value}` for each entry of `values` ("0_5" for 0.5).
 */
export type TileScenario = {
  param: string;
  label: string;
  unit: "ft" | "m" | "in" | (string & {});
  values: number[];
  template: string;
  tokens?: string[];
};
