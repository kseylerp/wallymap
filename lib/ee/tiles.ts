/**
 * The Earth Engine pictures the tile route (app/api/ee/tiles/[layer]/[z]/[x]/[y]) may draw, by layer id. Each entry
 * turns the tile URL's query into one fixed, whitelisted picture (anything else is refused), so the route never
 * computes what a caller makes up, and names the picture's map-id cache key.
 */
import type { EeNode } from "./expr";
import { parseTileQuery, tileImage, tileKey } from "./forestTypes";
import { GREENUP_TILE_KEY, greenupTiles, parseGreenupQuery } from "./greenup";

export type EeTileLayer = {
  /** The picture for a tile URL's query, or null when the query is not one the layer publishes. */
  picture(query: URLSearchParams): { key: string; image: EeNode } | null;
  minzoom: number;
  maxzoom: number;
};

export const EE_TILE_LAYERS: Record<string, EeTileLayer> = {
  "forest-types": {
    picture(query) {
      const params = parseTileQuery(query);
      return params ? { key: tileKey(params), image: tileImage(params) } : null;
    },
    minzoom: 3,
    maxzoom: 14,
  },
  // The usual spring green-up day (MODIS MCD12Q2, 500 m), the phenology layer's greenup view.
  phenology: {
    picture(query) {
      return parseGreenupQuery(query) ? { key: GREENUP_TILE_KEY, image: greenupTiles() } : null;
    },
    minzoom: 3,
    maxzoom: 12,
  },
};

/** Our own tile URL template for a layer's picture: the map fills {z}/{x}/{y}; the site's origin is added in the browser. */
export function eeTileTemplate(layerId: string, query: string): string {
  return `/api/ee/tiles/${layerId}/{z}/{x}/{y}?${query}`;
}

/**
 * How long browsers and the CDN keep a tile. The pictures change only when Google republishes the data (the beta series
 * was last updated 2026-10-21), so a CDN day-to-month is safe; a deploy that changes a picture changes its query.
 */
export const TILE_CACHE_CONTROL = "public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800";
