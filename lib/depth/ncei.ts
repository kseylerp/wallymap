import type { BBox } from "@/layers/types";

/**
 * Water depth from NOAA NCEI's DEM mosaic (ArcGIS ImageServer `DEM_mosaics/DEM_all`, keyless, public domain): one
 * mosaic of every elevation model NCEI holds, the finest first. Checked 2026-10-23:
 *   - coasts of the US: CUDEM topobathy at 1/9 arc-second (about 3 m; `ncei19_*`) or 1/3 arc-second (about 10 m;
 *     `ncei13_*`). Elliott Bay mid-bay -81 m, Puget Sound off Alki -193 m, its main basin -213 m; Lake Washington's
 *     bed -52 m (below sea level, the lake's surface is about 5 m above it);
 *   - the Great Lakes: NOAA's Great Lakes bathymetry (`greatlakes_lakedatum`, 3 arc-seconds), depth below each lake's
 *     chart datum: Lake Superior -320 m at 47.5, -87.0, Lake Michigan -90 m at 43.5, -87.0;
 *   - everywhere else: ETOPO 2022 at 15 arc-seconds (about 450 m; GEBCO in the open ocean): -5,317 m at 20, -140.
 *   - not covered: lakes above sea level without a NOAA survey. Lake Tahoe and Crater Lake read as their flat water
 *     surface (1,897 m and 1,883 m), so they have no depth here; the `lakes` layer has their maximum depth.
 * `exportImage` with `format=bsq` and `pixelType=F32` answers raw little-endian floats row by row from the north-west,
 * then one validity bit per pixel (row-major, most significant bit first): a 200 by 150 grid of Elliott Bay was 123,750
 * bytes in 0.3 s. Values are elevations in metres; water is below 0.
 */

export const NCEI_DEM_SERVICE = "https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_all/ImageServer";
export const NCEI_CITATION_SOURCE = "NOAA NCEI DEM mosaic: CUDEM coastal topobathy, Great Lakes bathymetry, ETOPO 2022 (with GEBCO) elsewhere";
export const NCEI_CITATION_URL = "https://www.ncei.noaa.gov/products/coastal-elevation-models";
export const NCEI_TIMEOUT_MS = 12_000;

/**
 * The mosaic's own order (finest first, by ZOrder), stated in full: a rule with only a `where` clause changed which
 * model won (checked 2026-10-23), so the surveys-only rule repeats the method.
 */
const MOSAIC_ORDER = { mosaicMethod: "esriMosaicAttribute", sortField: "ZOrder", sortValue: "0", ascending: true, mosaicOperation: "MT_FIRST" };
/** Every model except ETOPO: the water NOAA has surveyed (CUDEM, the Great Lakes, coastal relief models). */
export const SURVEYS_ONLY_RULE = { ...MOSAIC_ORDER, where: "Name NOT LIKE 'ETOPO%'" };

/**
 * Water is ground at least this far below 0: filled shores and wharves a few centimetres under the vertical datum
 * (Seattle's Harbor Island read as 1-pixel stripes of "water" a few inches deep, 2026-10-23) count as land.
 */
export const WATER_BELOW_M = -0.5;

/** True when an elevation is water with a depth (see WATER_BELOW_M). */
export const isWater = (elevationM: number): boolean => elevationM <= WATER_BELOW_M;

/** A grid of elevations in metres, row by row from the north-west corner; NaN where the mosaic has none. */
export type Grid = { width: number; height: number; values: Float32Array };

/** Spatial references the grids are asked in: plain longitude and latitude, or web mercator for map tiles. */
export type GridSR = 4326 | 3857;

/** Fetches raw bytes (global fetch by default; tests pass their own). */
export type BinaryFetch = (url: string) => Promise<Uint8Array | null>;

export const fetchBinary: BinaryFetch = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(NCEI_TIMEOUT_MS) });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
};

/** The exportImage URL for a grid: `width` must be a multiple of 8, so each row's validity bits fill whole bytes. */
export function exportUrl(bbox: BBox, sr: GridSR, width: number, height: number, surveysOnly = false): string {
  const q = new URLSearchParams({
    bbox: bbox.join(","),
    bboxSR: String(sr),
    imageSR: String(sr),
    size: `${width},${height}`,
    format: "bsq",
    pixelType: "F32",
    interpolation: "RSP_BilinearInterpolation",
    f: "image",
  });
  if (surveysOnly) q.set("mosaicRule", JSON.stringify(SURVEYS_ONLY_RULE));
  return `${NCEI_DEM_SERVICE}/exportImage?${q}`;
}

/** Decodes a `bsq` answer: floats, then validity bits. Null when the size does not match (an error page, a cut body). */
export function parseBsq(bytes: Uint8Array, width: number, height: number): Grid | null {
  const n = width * height;
  const maskBytes = Math.ceil(n / 8);
  if (bytes.length !== n * 4 + maskBytes) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const valid = (bytes[n * 4 + (i >> 3)] >> (7 - (i & 7))) & 1;
    const v = view.getFloat32(i * 4, true);
    values[i] = valid && Number.isFinite(v) ? v : NaN;
  }
  return { width, height, values };
}

/** One grid from the mosaic, or null when it did not answer. */
export async function fetchGrid(bbox: BBox, sr: GridSR, width: number, height: number, opts: { surveysOnly?: boolean; fetch?: BinaryFetch } = {}): Promise<Grid | null> {
  const bytes = await (opts.fetch ?? fetchBinary)(exportUrl(bbox, sr, width, height, opts.surveysOnly));
  return bytes ? parseBsq(bytes, width, height) : null;
}

/* ---------- the model behind a value, in plain words ---------- */

export type DepthSource = { name: string; spacingM: number; surveyed: boolean };

/** What an NCEI model name is, in words: "NOAA CUDEM coastal survey, about 3 m grid". */
export function sourceOf(demName: string, cellArcSeconds?: number): DepthSource {
  const n = demName.toLowerCase();
  const spacing = (arcSec: number) => Math.max(1, Math.round(arcSec * 30.87));
  if (n.startsWith("ncei19")) return { name: "NOAA CUDEM coastal survey", spacingM: 3, surveyed: true };
  if (n.startsWith("ncei13")) return { name: "NOAA CUDEM coastal survey", spacingM: 10, surveyed: true };
  if (n.startsWith("ncei1_") || n.startsWith("ncei1")) return { name: "NOAA CUDEM coastal survey", spacingM: 30, surveyed: true };
  if (n.startsWith("greatlakes")) return { name: "NOAA Great Lakes bathymetry (depth below the lake's chart datum)", spacingM: 90, surveyed: true };
  if (n.startsWith("crm") || n.includes("coastal_relief")) return { name: "NOAA Coastal Relief Model", spacingM: cellArcSeconds ? spacing(cellArcSeconds) : 90, surveyed: true };
  if (n.startsWith("etopo")) return { name: "ETOPO 2022 global relief (GEBCO in the open ocean)", spacingM: cellArcSeconds ? spacing(cellArcSeconds) : 450, surveyed: false };
  return { name: "a NOAA NCEI elevation model", spacingM: cellArcSeconds ? spacing(cellArcSeconds) : 30, surveyed: true };
}

/** The getSamples URL for one point: every model there with its value, the mosaic's winner first. */
export function samplesUrl(lon: number, lat: number): string {
  const q = new URLSearchParams({
    geometry: JSON.stringify({ points: [[lon, lat]], spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryMultipoint",
    returnFirstValueOnly: "false",
    outFields: "Name,CellsizeArcseconds",
    f: "json",
  });
  return `${NCEI_DEM_SERVICE}/getSamples?${q}`;
}

/** The winning sample of a getSamples answer: its elevation and model, or null. */
export function parseSamples(json: unknown): { elevationM: number; demName: string; cellArcSeconds?: number }[] {
  const samples = typeof json === "object" && json !== null ? (json as { samples?: unknown }).samples : undefined;
  if (!Array.isArray(samples)) return [];
  const out: { elevationM: number; demName: string; cellArcSeconds?: number }[] = [];
  for (const s of samples) {
    if (typeof s !== "object" || s === null) continue;
    const { value, attributes } = s as { value?: unknown; attributes?: Record<string, unknown> };
    const v = Number(value);
    const name = attributes?.Name;
    if (!Number.isFinite(v) || typeof name !== "string") continue;
    const cell = Number(attributes?.CellsizeArcseconds);
    out.push({ elevationM: v, demName: name, ...(Number.isFinite(cell) && cell > 0 && { cellArcSeconds: cell }) });
  }
  return out;
}
