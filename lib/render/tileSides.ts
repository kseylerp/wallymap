import type { Layer } from "@deck.gl/core";
import { TileLayer } from "@deck.gl/geo-layers";
import { BitmapLayer } from "@deck.gl/layers";
import { compareBId, compareHidden, effectiveMode } from "@/lib/render/compareView";
import { rasterPaint } from "@/lib/render/rasterCalm";
import type { LoadedLayer, MapState } from "@/lib/render/state";

/**
 * A swiped scenario compare (sea level rise, A 1 ft against B 5 ft), the drawing half. Mapbox cannot clip a raster
 * layer to one side of the handle, so while a scenario tile layer swipes, its two sides draw as deck tile layers of
 * bitmaps in the two clipped side overlays (components/MapCanvas.tsx) and the Mapbox rasters for it are hidden
 * (components/mapTiles.ts). The bitmaps lie flat at sea level, which is where coastal flooding is; they take the
 * layer's raster calm (desaturation and opacity) and its panel opacity, and are not pickable.
 */

export const TILE_SIDE_PREFIX = "tile-side-";

/** True while a scenario tile layer is compared by swipe: its sides are deck bitmaps, not Mapbox rasters. */
export function isTileSwipe(state: MapState): boolean {
  const compare = state.compare;
  if (!compare?.scenario || effectiveMode(state) !== "swipe") return false;
  const layer = state.layers[compare.layerId];
  return layer?.result.kind === "tiles" && layer.result.data.scenario !== undefined;
}

function bitmapTiles(layer: LoadedLayer, opacity: number): Layer | null {
  if (layer.result.kind !== "tiles" || layer.result.data.format !== "raster") return null;
  const { url, minzoom, maxzoom, tileSize } = layer.result.data;
  const paint = rasterPaint(layer.style.raster, opacity);
  return new TileLayer({
    id: `${TILE_SIDE_PREFIX}${layer.id}`,
    data: url,
    minZoom: minzoom,
    maxZoom: maxzoom,
    tileSize: tileSize ?? 256,
    opacity: paint["raster-opacity"],
    pickable: false,
    // An empty coastal tile 404s; Mapbox draws nothing there, and so does this.
    onTileError: () => {},
    renderSubLayers: (props) => {
      const [[west, south], [east, north]] = props.tile.boundingBox;
      // deck's documented tile-to-bitmap pattern: the tile's props, its image as the bitmap, its box as the bounds.
      return new BitmapLayer(props as never, {
        data: undefined,
        image: props.data,
        bounds: [west, south, east, north],
        desaturate: Math.max(0, -paint["raster-saturation"]),
      });
    },
  }) as unknown as Layer;
}

/**
 * The deck layers for the two clipped side overlays while a scenario tile layer swipes (`view` is the visible state,
 * lib/render/view.ts, whose compare entries already point side A and side B at their amounts); empty otherwise, or
 * while the layer is hidden.
 */
export function tileSwipeLayers(view: MapState): { a: Layer[]; b: Layer[] } {
  const compare = view.compare;
  if (!compare || !isTileSwipe(view) || compareHidden(view)) return { a: [], b: [] };
  const opacity = Math.min(1, Math.max(0, view.renderOps.find((op) => op.layerId === compare.layerId)?.opacity ?? 1));
  const sideA = view.layers[compare.layerId];
  const sideB = view.layers[compareBId(compare.layerId)];
  const a = sideA && bitmapTiles(sideA, opacity);
  const b = sideB && bitmapTiles(sideB, opacity);
  return { a: a ? [a] : [], b: b ? [b] : [] };
}
