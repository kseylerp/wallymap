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

export type LayerResult =
  | {
      kind: "geojson";
      data: FeatureCollection;
      citation: Citation;
      coverageNote?: string;
    }
  | {
      kind: "tiles";
      data: { url: string; minzoom: number; maxzoom: number };
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
