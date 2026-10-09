import type { Layer } from "@deck.gl/core";
import { GeoJsonLayer } from "@deck.gl/layers";
import { WebMercatorViewport } from "@math.gl/web-mercator";
import type { BBox } from "@/layers/types";
import type { MapState, RenderOp, Viewport } from "@/lib/render/state";

type Rgba = [number, number, number, number];

/** `--slate`: the default stroke for data drawn over imagery. */
export const SLATE = "#2F3A44";
const WHITE: Rgba = [255, 255, 255, 255];
/** Point markers: a white disc ringed in slate (or the requested color), like a map pin seen from above. */
const POINT_RADIUS_PX = 7;
const POINT_STROKE_PX = 2;
/** Lines get a white casing underneath so a dark stroke reads on both bright and dark imagery. */
const LINE_WIDTH_PX = 2.5;
const LINE_CASING_WIDTH_PX = 4.5;
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

export type Padding = { top: number; right: number; bottom: number; left: number };

/**
 * Fits a bbox into a width x height pixel viewport. `padding` is the screen area the bbox must stay clear of
 * (floating panels, the header), 40px on each side by default.
 */
export function bboxToViewport(bbox: BBox, width: number, height: number, padding: Padding | number = 40): Viewport {
  const [west, south, east, north] = bbox;
  const { longitude, latitude, zoom } = new WebMercatorViewport({ width, height }).fitBounds(
    [
      [west, south],
      [east, north],
    ],
    { padding },
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

/** The deck layers for one render op, bottom first (lines add a white casing beneath the stroke). */
function geoJsonLayersFor(op: RenderOp, data: GeoJSON.FeatureCollection, defaultColor: string): GeoJsonLayer[] {
  const requested = usableColor(op.color);
  const color = requested ?? defaultColor;
  const id = `${op.layerId}:${op.mode}`;
  const base = { id, data, pickable: true };
  switch (op.mode) {
    case "points":
      return [
        new GeoJsonLayer({
          ...base,
          pointType: "circle",
          getPointRadius: POINT_RADIUS_PX,
          pointRadiusUnits: "pixels",
          getFillColor: WHITE,
          stroked: true,
          getLineColor: hexToRgba(requested ?? SLATE),
          getLineWidth: POINT_STROKE_PX,
          lineWidthUnits: "pixels",
        }),
      ];
    case "lines":
      return [
        new GeoJsonLayer({
          id: `${id}:casing`,
          data,
          pickable: false,
          filled: false,
          getLineColor: WHITE,
          getLineWidth: LINE_CASING_WIDTH_PX,
          lineWidthUnits: "pixels",
        }),
        new GeoJsonLayer({
          ...base,
          filled: false,
          getLineColor: hexToRgba(color),
          getLineWidth: LINE_WIDTH_PX,
          lineWidthUnits: "pixels",
        }),
      ];
    case "polygons":
      return [
        new GeoJsonLayer({
          ...base,
          getFillColor: hexToRgba(color, POLYGON_FILL_ALPHA),
          getLineColor: hexToRgba(color, 255),
          getLineWidth: 1,
          lineWidthUnits: "pixels",
        }),
      ];
    default:
      throw new Error(`NotImplemented: ${op.mode}`);
  }
}

/** Turns map state into deck.gl layer instances for each visible geojson render op (lines bring a casing). */
export function buildDeckLayers(state: MapState): Layer[] {
  const layers: Layer[] = [];
  for (const op of state.renderOps) {
    if (!op.visible) continue;
    const loaded = state.layers[op.layerId];
    if (!loaded) continue;
    if (loaded.result.kind === "tiles") continue;
    layers.push(...geoJsonLayersFor(op, loaded.result.data, loaded.style.color));
  }
  return layers;
}
