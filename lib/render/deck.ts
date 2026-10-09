import type { Layer } from "@deck.gl/core";
import { GeoJsonLayer } from "@deck.gl/layers";
import { WebMercatorViewport } from "@math.gl/web-mercator";
import type { BBox } from "@/layers/types";
import type { MapState, RenderOp, Viewport } from "@/lib/render/state";

type Rgba = [number, number, number, number];

/** Point markers: a white disc ringed in the layer color, like a map pin seen from above. */
const POINT_FILL: Rgba = [255, 255, 255, 255];
const POINT_RADIUS_PX = 7;
const POINT_STROKE_PX = 2;
/** Polygon fills stay light so the imagery underneath still reads. */
const POLYGON_FILL_ALPHA = 64;

/** Parses `#rgb` or `#rrggbb` into an RGBA tuple for deck.gl. */
export function hexToRgba(hex: string, alpha = 255): Rgba {
  let digits = hex.trim().replace(/^#/, "");
  if (digits.length === 3) {
    digits = digits
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(digits)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  return [
    parseInt(digits.slice(0, 2), 16),
    parseInt(digits.slice(2, 4), 16),
    parseInt(digits.slice(4, 6), 16),
    alpha,
  ];
}

/** Fits a bbox into a width x height pixel viewport with 40px padding. */
export function bboxToViewport(bbox: BBox, width: number, height: number): Viewport {
  const [west, south, east, north] = bbox;
  const { longitude, latitude, zoom } = new WebMercatorViewport({ width, height }).fitBounds(
    [
      [west, south],
      [east, north],
    ],
    { padding: 40 },
  );
  return { longitude, latitude, zoom, pitch: 0, bearing: 0 };
}

/** Returns `color` if it parses as hex, else undefined (a bad model-supplied color must not crash the map). */
function usableColor(color: string | undefined): string | undefined {
  if (color === undefined) return undefined;
  try {
    hexToRgba(color);
    return color;
  } catch {
    return undefined;
  }
}

function geoJsonLayerFor(op: RenderOp, data: GeoJSON.FeatureCollection, defaultColor: string): GeoJsonLayer {
  const color = usableColor(op.color) ?? defaultColor;
  const base = { id: `${op.layerId}:${op.mode}`, data, pickable: true };
  switch (op.mode) {
    case "points":
      return new GeoJsonLayer({
        ...base,
        pointType: "circle",
        getPointRadius: POINT_RADIUS_PX,
        pointRadiusUnits: "pixels",
        getFillColor: POINT_FILL,
        stroked: true,
        getLineColor: hexToRgba(color),
        getLineWidth: POINT_STROKE_PX,
        lineWidthUnits: "pixels",
      });
    case "lines":
      return new GeoJsonLayer({
        ...base,
        filled: false,
        getLineColor: hexToRgba(color),
        getLineWidth: 3,
        lineWidthUnits: "pixels",
      });
    case "polygons":
      return new GeoJsonLayer({
        ...base,
        getFillColor: hexToRgba(color, POLYGON_FILL_ALPHA),
        getLineColor: hexToRgba(color, 255),
        getLineWidth: 1,
        lineWidthUnits: "pixels",
      });
    default:
      throw new Error(`NotImplemented: ${op.mode}`);
  }
}

/** Turns map state into deck.gl layer instances, one per visible geojson render op. */
export function buildDeckLayers(state: MapState): Layer[] {
  const layers: Layer[] = [];
  for (const op of state.renderOps) {
    if (!op.visible) continue;
    const loaded = state.layers[op.layerId];
    if (!loaded) continue;
    if (loaded.result.kind === "tiles") continue;
    layers.push(geoJsonLayerFor(op, loaded.result.data, loaded.style.color));
  }
  return layers;
}
