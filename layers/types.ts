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
  /** The newest period is not reliably processed for this many days; the scrubber stays that far behind today. */
  daysBack?: number;
};

export type LayerResult =
  | {
      kind: "geojson";
      data: FeatureCollection;
      citation: Citation;
      coverageNote?: string;
    }
  | {
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
      };
      citation: Citation;
      coverageNote?: string;
    };

export type LayerError = {
  error: string;
  hint?: "zoom_in" | "unavailable" | "upstream";
};

export type QueryContext = {
  bbox: BBox;
  zoom: number;
  route?: LineString;
  env: Record<string, string | undefined>;
  fetch: CachedFetch;
  /** Stable key for this request (layer id, bbox rounded to 3 decimals, sorted input); pass it as `cacheKey` to ctx.fetch. */
  cacheKey?: string;
};

export type StyleHints = {
  geometry: "point" | "line" | "polygon";
  color: string;
  unit?: string;
  /** Polygons only: fill alpha from 0 (outline only) to 1; the renderer's default when unset. */
  fillOpacity?: number;
  /** Points only: draw columns whose height is the feature's `v` (value) or 1 per feature (`count`) when the map is in 3D. */
  extrude?: "v" | "count";
  /** True when a heatmap view of the points is meaningful (dense events, observations). */
  heat?: boolean;
  /** True for dense point layers that read better clustered at low zoom. */
  cluster?: boolean;
  /** Feature property holding the ISO date the time scrubber filters on; defaults to `t`. */
  timeField?: string;
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
  maxAreaKm2: number;
  input: I;
  // Method syntax keeps parameter checking bivariant so Layer<specific> is
  // assignable to the default Layer in the registry.
  query(ctx: QueryContext, input: z.infer<I>): Promise<LayerResult | LayerError>;
  style: StyleHints;
};

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
