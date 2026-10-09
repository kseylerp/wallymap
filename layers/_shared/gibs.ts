/** NASA GIBS WMTS (Web Mercator) tile URL template; `{z}/{y}/{x}` are filled in by the map. */
export function gibsTileUrl(layerId: string, date: string, level: number): string {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layerId}/default/${date}/GoogleMapsCompatible_Level${level}/{z}/{y}/{x}.png`;
}
