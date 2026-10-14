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

export type LayerResult =
  | ({
      kind: "geojson";
      data: FeatureCollection;
      citation: Citation;
      coverageNote?: string;
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

export type Layer<I extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> = {
  id: string;
  title: string;
  description: string;
  coverage: Coverage;
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
