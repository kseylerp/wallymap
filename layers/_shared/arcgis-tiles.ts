/**
 * Raster tile URL templates for ArcGIS MapServer `export` and ImageServer `exportImage` services.
 * Mapbox replaces `{bbox-epsg-3857}` in a raster source URL with the tile's Web Mercator bounds, so one template
 * serves every tile; the service draws just that extent as a `tileSize` pixel PNG with transparent empty areas.
 * Nothing here calls the service; the layer returns the template and the map fetches tiles itself.
 */

const BBOX_TOKEN = "{bbox-epsg-3857}";

/** Query parameters shared by both export endpoints: 3857 in and out, one tile-sized transparent PNG. */
function common(tileSize: number): string[] {
  return [`bbox=${BBOX_TOKEN}`, "bboxSR=3857", "imageSR=3857", `size=${tileSize},${tileSize}`, "format=png32", "f=image"];
}

export type ExportTileOptions = {
  /** MapServer only: layer visibility, as ArcGIS spells it, e.g. "show:28" or "show:0,1". */
  layers?: string;
  /** Pixel size of each tile image; default 256. */
  tileSize?: number;
};

/** `{serviceUrl}/export?...` template for a MapServer; `serviceUrl` is the service root without `/export`. */
export function mapServerExportTileUrl(serviceUrl: string, options: ExportTileOptions = {}): string {
  const params = [...common(options.tileSize ?? 256), "transparent=true"];
  if (options.layers !== undefined) params.push(`layers=${options.layers}`);
  return `${serviceUrl}/export?${params.join("&")}`;
}

export type ImageExportTileOptions = {
  tileSize?: number;
  /** Pixel value to treat as "no data" (drawn transparent), e.g. 0 for classified rasters. */
  noData?: number;
};

/** `{serviceUrl}/exportImage?...` template for an ImageServer; classified rasters stay crisp with nearest neighbour. */
export function imageServerExportTileUrl(serviceUrl: string, options: ImageExportTileOptions = {}): string {
  const params = [...common(options.tileSize ?? 256), "interpolation=RSP_NearestNeighbor"];
  if (options.noData !== undefined) {
    params.push(`noData=${options.noData}`, "noDataInterpretation=esriNoDataMatchAny");
  }
  return `${serviceUrl}/exportImage?${params.join("&")}`;
}
