/**
 * WMS GetMap as a raster tile URL. Mapbox GL fills `{bbox-epsg-3857}` per tile, so any WMS that serves EPSG:3857
 * works as a tile layer with no server code. Other `{...}` placeholders (`{date}`, `{year}`) are left in the string
 * for the time scrubber (lib/time `tileUrlForTime`) to fill.
 */
export type WmsTileOptions = {
  /** WMS version; 1.3.0 uses `crs`, 1.1.1 uses `srs`. Default 1.3.0. */
  version?: "1.1.1" | "1.3.0";
  /** Value of the `time` parameter, e.g. `2026-10-08` or the placeholder `{date}`. */
  time?: string;
  /** Pixel size of each tile (default 256). */
  size?: number;
};

export function wmsTileUrl(endpoint: string, layers: string, opts: WmsTileOptions = {}): string {
  const version = opts.version ?? "1.3.0";
  const size = opts.size ?? 256;
  const parts = [
    "service=WMS",
    `version=${version}`,
    "request=GetMap",
    `layers=${layers}`,
    "styles=",
    "format=image/png",
    "transparent=true",
    `${version === "1.3.0" ? "crs" : "srs"}=EPSG:3857`,
    `width=${size}`,
    `height=${size}`,
    "bbox={bbox-epsg-3857}",
  ];
  if (opts.time !== undefined) parts.push(`time=${opts.time}`);
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}${parts.join("&")}`;
}
