/**
 * Is there snow in the view on a given day? Reads the GIBS MODIS NDSI tiles over the view and counts the snow pixels.
 *
 * GIBS draws MODIS_Terra_NDSI_Snow_Cover as an 8-bit palette PNG whose palette index is the NDSI snow cover value
 * (colormap https://gibs.earthdata.nasa.gov/colormaps/v1.3/MODIS_NDSI_Snow_Cover.xml, read 2026-10-18): index 0 is
 * no snow (transparent), 1 to 100 the NDSI x 100 drawn pale yellow (1-20), light orange (21-40), orange (41-60), salmon
 * (61-80), pink (81-99) and red (100), and 101 and up are the transparent flags (105 ocean, 106 cloud, 103 night, 104
 * inland water, 101 missing). Counted as "snow in view" (snowPixels, a heuristic): pixels in a patch away from cloud.
 * Mount Hood [-122,45,-121,46] at zoom 8: 2026-03-10 6,800; 2026-10-10 405; 2026-10-16 100; 2026-10-17 0 (cloud). Florida
 * [-82,27,-80,29], under cloud: 0 to 31 (cloud-edge commission errors), so a view needs MIN_SNOW_PIXELS.
 *
 * The tiles are binary, and the layer fetch wrapper (lib/fetch) reads every body as text, which corrupts a PNG, so the
 * probe uses the platform fetch with its own timeout and a small in-process memo (a past day's tile never changes).
 * A tile that fails or is not a palette PNG is unknown, never "no snow".
 */
import { inflateSync } from "node:zlib";
import type { BBox } from "./types";
import { DAY_MS, isoDay } from "./_shared/dated-tiles";
import { gibsTileUrl } from "./_shared/gibs";

/** Lowest palette index counted as snow: NDSI 0.10, the MODIS Collection 6 snow threshold. */
export const SNOW_MIN_INDEX = 10;
export const SNOW_MAX_INDEX = 100;
/** Snow pixels a view needs, at the probe zoom, before it counts as "snow in view" (above Florida's cloud-edge 31). */
export const MIN_SNOW_PIXELS = 40;
const PROBE_TIMEOUT_MS = 8_000;
const MEMO_MAX = 2_000;
const RECENT_MS = 3 * DAY_MS;
const RECENT_MEMO_MS = 3_600_000;

export type PaletteImage = { width: number; height: number; index: Uint8Array };

/** The palette indices of an 8-bit palette PNG (colour type 3, not interlaced); null for any other PNG or a broken one. */
export function decodePalettePng(bytes: Uint8Array): PaletteImage | null {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || sig.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= bytes.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      const [depth, colorType, , , interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (depth !== 8 || colorType !== 3 || interlace !== 0) return null;
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (width === 0 || height === 0 || idat.length === 0) return null;
  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  if (raw.length < (width + 1) * height) return null;
  const index = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (width + 1)];
    const line = raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1));
    for (let x = 0; x < width; x++) {
      const a = x > 0 ? index[y * width + x - 1] : 0;
      const b = y > 0 ? index[(y - 1) * width + x] : 0;
      const c = x > 0 && y > 0 ? index[(y - 1) * width + x - 1] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) return null;
      index[y * width + x] = (line[x] + pred) & 0xff;
    }
  }
  return { width, height, index };
}

/** Web Mercator tile x, y (fractional) of a point at zoom z. */
function tileXY(lng: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const rad = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return [((lng + 180) / 360) * n, ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n];
}

export type ProbeTile = { z: number; x: number; y: number; px: [x0: number, y0: number, x1: number, y1: number] };

/**
 * The tiles to read for a view: the zoom (up to the product's 8) at which the view spans about one tile, and the up to
 * four tiles it touches, each with the pixel window the view covers.
 */
export function probeTiles(bbox: BBox, maxZoom = 8): ProbeTile[] {
  const [w, s, e, n] = bbox;
  const span = Math.max(e - w, 1e-6);
  const z = Math.max(0, Math.min(maxZoom, Math.floor(Math.log2(360 / span))));
  const [fx0, fy0] = tileXY(w, n, z);
  const [fx1, fy1] = tileXY(e, s, z);
  const tiles: ProbeTile[] = [];
  const max = 2 ** z - 1;
  for (let y = Math.floor(fy0); y <= Math.min(max, Math.floor(fy1)); y++) {
    for (let x = Math.floor(fx0); x <= Math.min(max, Math.floor(fx1)); x++) {
      const clip = (v: number, t: number) => Math.round(Math.max(0, Math.min(256, (v - t) * 256)));
      tiles.push({ z, x, y, px: [clip(fx0, x), clip(fy0, y), clip(fx1, x), clip(fy1, y)] });
    }
  }
  // A view across more than 2 x 2 tiles at this zoom reads the four nearest its centre.
  if (tiles.length <= 4) return tiles;
  const [cx, cy] = [(fx0 + fx1) / 2, (fy0 + fy1) / 2];
  return tiles.sort((a, b) => Math.hypot(a.x + 0.5 - cx, a.y + 0.5 - cy) - Math.hypot(b.x + 0.5 - cx, b.y + 0.5 - cy)).slice(0, 4);
}

/** The colormap's cloud class (source value 250). */
export const CLOUD_INDEX = 106;

/**
 * Snow pixels (NDSI 0.10 to 1) inside a tile's pixel window that sit inside a patch (three or more of their four
 * neighbours are snow too) and touch no cloud (of their eight neighbours). MODIS calls some cloud edges snow: over
 * Florida under cloud on 2026-10-10 the tiles held 95 snow pixels in small patches; 31 pass this rule.
 */
export function snowPixels(img: PaletteImage, [x0, y0, x1, y1]: ProbeTile["px"]): number {
  const { width, height, index } = img;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? -1 : index[y * width + x]);
  const isSnow = (v: number) => v >= SNOW_MIN_INDEX && v <= SNOW_MAX_INDEX;
  let n = 0;
  for (let y = y0; y < Math.min(y1, height); y++) {
    for (let x = x0; x < Math.min(x1, width); x++) {
      if (!isSnow(at(x, y))) continue;
      const around = [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)];
      const corners = [at(x - 1, y - 1), at(x + 1, y - 1), at(x - 1, y + 1), at(x + 1, y + 1)];
      if (around.filter(isSnow).length >= 3 && !around.includes(CLOUD_INDEX) && !corners.includes(CLOUD_INDEX)) n++;
    }
  }
  return n;
}

/** What a tile's pixel window shows of the ground: snow, snow-free land, cloud, and pixels not seen (night, missing). */
export type Cover = { snow: number; ground: number; cloud: number; unseen: number };

/** Palette indices the satellite did not see the land at: missing data (101), night (103). Ocean (105) and inland water (104) are not land. */
const UNSEEN = new Set([101, 102, 103, 107, 108]);

/** Counts a tile's window: snow (as `snowPixels` counts it), snow-free land (index 0), cloud (CLOUD_INDEX) and unseen land. */
export function coverOf(img: PaletteImage, px: ProbeTile["px"]): Cover {
  const [x0, y0, x1, y1] = px;
  let ground = 0;
  let cloud = 0;
  let unseen = 0;
  for (let y = y0; y < Math.min(y1, img.height); y++) {
    for (let x = x0; x < Math.min(x1, img.width); x++) {
      const v = img.index[y * img.width + x];
      if (v === 0) ground++;
      else if (v === CLOUD_INDEX) cloud++;
      else if (UNSEEN.has(v)) unseen++;
    }
  }
  return { snow: snowPixels(img, px), ground, cloud, unseen };
}

/**
 * The share of the view's land the satellite could not see that day (cloud, night or missing), 0 to 1; null without
 * land in view. Snow under a mostly cloudy sky is not trusted: MODIS calls some cloud snow (Portland's lowlands
 * "snow-covered" in mid-October, 2026-10-14, owner 2026-10-18).
 */
export function hiddenShare(c: Cover): number | null {
  const land = c.snow + c.ground + c.cloud + c.unseen;
  return land === 0 ? null : (c.cloud + c.unseen) / land;
}

/** A day counts as a clear view of the ground when at most this share of the view's land is under cloud or unseen. */
export const MAX_HIDDEN_SHARE = 0.25;

const memo = new Map<string, { n: number | null; until: number }>();
const coverMemo = new Map<string, { c: Cover | null; until: number }>();

/** What the view's tiles show on `day` (summed over the tiles), or null when any tile could not be read. */
export async function coverInView(gibsId: string, level: number, bbox: BBox, day: string, now: number, fetchImpl: typeof fetch = fetch): Promise<Cover | null> {
  const tiles = probeTiles(bbox, level);
  const covers = await Promise.all(
    tiles.map(async (t) => {
      const url = gibsTileUrl(gibsId, day, level).replace("{z}", String(t.z)).replace("{y}", String(t.y)).replace("{x}", String(t.x));
      const key = `${url}|${t.px.join(",")}`;
      const hit = coverMemo.get(key);
      if (hit && hit.until > now) return hit.c;
      let c: Cover | null = null;
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (res.ok) {
          const img = decodePalettePng(new Uint8Array(await res.arrayBuffer()));
          c = img === null ? null : coverOf(img, t.px);
        }
      } catch {
        c = null;
      }
      if (c !== null) {
        if (coverMemo.size >= MEMO_MAX) coverMemo.delete(coverMemo.keys().next().value as string);
        const recent = Date.parse(`${day}T00:00:00Z`) > now - RECENT_MS;
        coverMemo.set(key, { c, until: recent ? now + RECENT_MEMO_MS : Number.POSITIVE_INFINITY });
      }
      return c;
    }),
  );
  if (covers.some((c) => c === null)) return null;
  return covers.reduce<Cover>((a, c) => ({ snow: a.snow + c!.snow, ground: a.ground + c!.ground, cloud: a.cloud + c!.cloud, unseen: a.unseen + c!.unseen }), { snow: 0, ground: 0, cloud: 0, unseen: 0 });
}

/** Days to look for a clear view: every day for two weeks, then every other day to a month. */
export function clearLookbackDays(newest: string, from: string): string[] {
  const base = Date.parse(`${newest}T00:00:00Z`);
  const offsets: number[] = [];
  for (let d = 0; d <= 13; d++) offsets.push(d);
  for (let d = 15; d <= 29; d += 2) offsets.push(d);
  return offsets.map((d) => isoDay(base - d * DAY_MS)).filter((d) => d >= from);
}

export type ClearSearch =
  | { found: string; cover: Cover; checked: number }
  | { found: null; checked: number; oldest: string | null; unknown: boolean };

/**
 * The newest day in `days` (newest first) when the satellite saw the view's ground (at most MAX_HIDDEN_SHARE of its land
 * under cloud or unseen), with what it saw; `unknown` when a day could not be read.
 */
export async function latestClearDay(gibsId: string, level: number, bbox: BBox, days: string[], now: number, fetchImpl: typeof fetch = fetch, wave = 6): Promise<ClearSearch> {
  let checked = 0;
  let unknown = false;
  for (let i = 0; i < days.length; i += wave) {
    const batch = days.slice(i, i + wave);
    const covers = await Promise.all(batch.map((d) => coverInView(gibsId, level, bbox, d, now, fetchImpl)));
    checked += batch.length;
    for (let k = 0; k < batch.length; k++) {
      const c = covers[k];
      if (c === null) {
        unknown = true;
        continue;
      }
      const hidden = hiddenShare(c);
      if (hidden !== null && hidden <= MAX_HIDDEN_SHARE) return { found: batch[k], cover: c, checked };
    }
    if (i === 0 && covers.every((c) => c === null)) break;
  }
  return { found: null, checked, oldest: days.length > 0 ? days[Math.min(days.length, checked) - 1] : null, unknown };
}

/** Clears the memo (tests). */
export function clearSnowProbeMemo(): void {
  memo.clear();
  coverMemo.clear();
}

/** Snow pixels in the view's tiles on `day`, or null when any tile could not be read. */
export async function snowInView(gibsId: string, level: number, bbox: BBox, day: string, now: number, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  const tiles = probeTiles(bbox, level);
  const counts = await Promise.all(
    tiles.map(async (t) => {
      const url = gibsTileUrl(gibsId, day, level).replace("{z}", String(t.z)).replace("{y}", String(t.y)).replace("{x}", String(t.x));
      const key = `${url}|${t.px.join(",")}`;
      const hit = memo.get(key);
      if (hit && hit.until > now) return hit.n;
      let n: number | null = null;
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (res.ok) {
          const img = decodePalettePng(new Uint8Array(await res.arrayBuffer()));
          n = img === null ? null : snowPixels(img, t.px);
        }
      } catch {
        n = null;
      }
      if (n !== null) {
        if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value as string);
        const recent = Date.parse(`${day}T00:00:00Z`) > now - RECENT_MS;
        memo.set(key, { n, until: recent ? now + RECENT_MEMO_MS : Number.POSITIVE_INFINITY });
      }
      return n;
    }),
  );
  if (counts.some((c) => c === null)) return null;
  return counts.reduce<number>((a, c) => a + (c ?? 0), 0);
}
