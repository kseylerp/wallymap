import type { BBox } from "@/layers/types";
import { decodePng } from "./png";

/**
 * Elevation from AWS Terrain Tiles (the Mapzen "Terrarium" PNG tiles, open data on S3, no key): 256-pixel web-mercator
 * tiles to zoom 15, each pixel `R*256 + G + B/256 - 32768` metres. Sources by place: USGS 3DEP (1/3 arc-second, about
 * 10 m) across the US, SRTM (about 30 m) elsewhere between 60°N and 56°S, GMTED2010 and ETOPO1 beyond. Decoded tiles
 * are kept in memory (a small LRU), so a crag list, a trail list and the slope tiles for one place share them.
 */

export const TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
export const TERRAIN_CITATION_SOURCE = "AWS Terrain Tiles (Mapzen Terrarium: USGS 3DEP, SRTM, GMTED2010, ETOPO1)";
export const TERRAIN_CITATION_URL = "https://registry.opendata.aws/terrain-tiles/";
export const MAX_DEM_ZOOM = 15;
export const TILE_SIZE = 256;

export type DemTile = { z: number; x: number; y: number; elev: Float32Array };

/** Where tiles come from: the network by default, a function in tests. Null when there is no tile (or it failed). */
export type TileSource = (z: number, x: number, y: number) => Promise<DemTile | null>;

export function terrariumElevation(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Decodes a Terrarium PNG to elevations, row by row from the tile's north-west corner. */
export function decodeTerrarium(png: Uint8Array, z: number, x: number, y: number): DemTile {
  const { width, height, data } = decodePng(png);
  if (width !== TILE_SIZE || height !== TILE_SIZE) throw new Error(`Terrain tile is ${width}x${height}`);
  const elev = new Float32Array(width * height);
  for (let i = 0; i < elev.length; i++) elev[i] = terrariumElevation(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  return { z, x, y, elev };
}

/* ---------- tile math (web mercator) ---------- */

export function lonToX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

export function latToY(lat: number, z: number): number {
  const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

export function xToLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

export function yToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

/** Ground metres per pixel of a 256-pixel tile at this latitude and zoom. */
export function metresPerPixel(lat: number, z: number): number {
  return (156_543.033_92 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

/** The tiles at zoom z covering a box: [x0, y0, x1, y1] inclusive. */
export function tileRange(bbox: BBox, z: number): [number, number, number, number] {
  const n = 2 ** z - 1;
  const clamp = (v: number) => Math.max(0, Math.min(n, Math.floor(v)));
  return [clamp(lonToX(bbox[0], z)), clamp(latToY(bbox[3], z)), clamp(lonToX(bbox[2], z)), clamp(latToY(bbox[1], z))];
}

export function tileCount(bbox: BBox, z: number): number {
  const [x0, y0, x1, y1] = tileRange(bbox, z);
  return (x1 - x0 + 1) * (y1 - y0 + 1);
}

/** The highest zoom up to `maxZoom` at which the box needs at most `maxTiles` tiles (never under 1). */
export function zoomFor(bbox: BBox, maxTiles: number, maxZoom = 13): number {
  for (let z = maxZoom; z > 1; z--) if (tileCount(bbox, z) <= maxTiles) return z;
  return 1;
}

/* ---------- fetching, with a small LRU of decoded tiles ---------- */

const MAX_CACHED = 160;
const cache = new Map<string, Promise<DemTile | null>>();

/** Terrarium tiles from S3, decoded and cached; null on a miss or a failure (logged once per tile). */
export const networkTiles: TileSource = (z, x, y) => {
  const key = `${z}/${x}/${y}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const url = TERRARIUM_URL.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
  const p = fetch(url, { signal: AbortSignal.timeout(8_000) })
    .then(async (res) => (res.ok ? decodeTerrarium(new Uint8Array(await res.arrayBuffer()), z, x, y) : null))
    .catch(() => null);
  cache.set(key, p);
  // A failed tile is forgotten so the next request tries again.
  void p.then((t) => {
    if (t === null) cache.delete(key);
  });
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
  return p;
};

/** Tests only. */
export function clearTileCache(): void {
  cache.clear();
}

let defaultSource: TileSource = networkTiles;

/** Where tiles come from when a caller names no source: the network, or a fixture in tests (undefined resets). */
export function useTileSource(source?: TileSource): void {
  defaultSource = source ?? networkTiles;
}

/* ---------- a loaded patch of elevation ---------- */

/**
 * Elevation over a set of loaded tiles at one zoom, sampled bilinearly in global pixel space, so a point near a tile
 * edge reads its neighbour. `missing` counts samples that fell on a tile that did not load.
 */
export class Dem {
  readonly z: number;
  private readonly tiles: Map<string, Float32Array>;
  missing = 0;

  constructor(z: number, tiles: DemTile[]) {
    this.z = z;
    this.tiles = new Map(tiles.map((t) => [`${t.x}/${t.y}`, t.elev]));
  }

  get tileCount(): number {
    return this.tiles.size;
  }

  /** The elevation of one global pixel, or NaN when its tile is not loaded. */
  pixel(px: number, py: number): number {
    const tx = Math.floor(px / TILE_SIZE);
    const ty = Math.floor(py / TILE_SIZE);
    const elev = this.tiles.get(`${tx}/${ty}`);
    if (!elev) return NaN;
    return elev[(py - ty * TILE_SIZE) * TILE_SIZE + (px - tx * TILE_SIZE)];
  }

  /** Bilinear elevation at fractional global pixel coordinates (pixel centres at +0.5). */
  atPixel(fx: number, fy: number): number {
    const x = fx - 0.5;
    const y = fy - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = x - x0;
    const ty = y - y0;
    const a = this.pixel(x0, y0);
    const b = this.pixel(x0 + 1, y0);
    const c = this.pixel(x0, y0 + 1);
    const d = this.pixel(x0 + 1, y0 + 1);
    const v = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    if (Number.isNaN(v)) this.missing += 1;
    return v;
  }

  /** Elevation in metres at [lon, lat], or NaN off the loaded tiles. */
  at(lon: number, lat: number): number {
    return this.atPixel(lonToX(lon, this.z) * TILE_SIZE, latToY(lat, this.z) * TILE_SIZE);
  }
}

/**
 * Loads the tiles covering a box at zoom z (z is lowered until the box needs at most `maxTiles`), with a few pixels of
 * margin so slopes at the box edge have neighbours.
 */
export async function loadDem(bbox: BBox, opts: { zoom?: number; maxTiles?: number; source?: TileSource } = {}): Promise<Dem> {
  const maxTiles = opts.maxTiles ?? 36;
  let z = Math.min(MAX_DEM_ZOOM, opts.zoom ?? 12);
  while (z > 1 && tileCount(bbox, z) > maxTiles) z--;
  // Three pixels of margin, so a slope at the box's edge reads its neighbours.
  const pad = (3 * 360) / (TILE_SIZE * 2 ** z);
  const padded: BBox = [bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad];
  const [x0, y0, x1, y1] = tileRange(padded, z);
  const source = opts.source ?? defaultSource;
  const jobs: Promise<DemTile | null>[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push(source(z, x, y));
  const tiles = (await Promise.all(jobs)).filter((t): t is DemTile => t !== null);
  return new Dem(z, tiles);
}

/** The tile at zoom z holding [lon, lat], as "x/y". */
export function tileKeyOf(lon: number, lat: number, z: number): string {
  const n = 2 ** z - 1;
  return `${Math.max(0, Math.min(n, Math.floor(lonToX(lon, z))))}/${Math.max(0, Math.min(n, Math.floor(latToY(lat, z))))}`;
}

/** Loads named tiles ("x/y") at zoom z: for points and lines scattered over a wide box, only the tiles they touch. */
export async function loadDemTiles(z: number, keys: Iterable<string>, source: TileSource = defaultSource): Promise<Dem> {
  const jobs = [...new Set(keys)].map((k) => {
    const [x, y] = k.split("/").map(Number);
    return source(z, x, y);
  });
  const tiles = (await Promise.all(jobs)).filter((t): t is DemTile => t !== null);
  return new Dem(z, tiles);
}
