import type { Layer } from "@deck.gl/core";
import { PathStyleExtension } from "@deck.gl/extensions";
import { GeoJsonLayer, IconLayer } from "@deck.gl/layers";
import { WebMercatorViewport } from "@math.gl/web-mercator";
import type { Feature } from "geojson";
import type { BBox, StyleHints } from "@/layers/types";
import { OUTDOORS_TRAIL, SCORE_RAMP } from "@/lib/render/palette";
import { pinIconFor, pinThreshold, type PinIcon } from "@/lib/render/wally/pins";
import type { MapState, RenderOp, Viewport } from "@/lib/render/state";

type Rgba = [number, number, number, number];

/** `--slate`: the default stroke for data drawn over imagery. */
export const SLATE = "#2F3A44";
const WHITE: Rgba = [255, 255, 255, 255];
/** Point markers: a disc in the layer color with a white casing ring, so it reads on any imagery. */
const POINT_RADIUS_PX = 7;
const POINT_CASING_PX = 1.5;
/** Lines get a white casing underneath so a dark stroke reads on both bright and dark imagery. */
const LINE_WIDTH_PX = 2.5;
const LINE_CASING_WIDTH_PX = 4.5;
/** Polygons: a translucent fill (the layer's `fillOpacity`, else this) under a white outline. */
const POLYGON_FILL_OPACITY = 0.25;
const POLYGON_OUTLINE_PX = 1.5;
/** While a feature is selected, the rest of its layer fades to this share of its alpha. */
export const SIBLING_FADE = 0.35;

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

type ColorAccessor = Rgba | ((f: Feature) => Rgba);

/** Scales a color's alpha by the op opacity. */
function withOpacity([r, g, b, a]: Rgba, opacity: number): Rgba {
  return [r, g, b, Math.round(a * opacity)];
}

/** A stable key per selected feature object, so `updateTriggers` re-run the color accessors on a new selection. */
const selectionKeys = new WeakMap<Feature, number>();
let nextSelectionKey = 1;
function selectionKey(feature: Feature | undefined): number {
  if (!feature) return 0;
  let key = selectionKeys.get(feature);
  if (key === undefined) {
    key = nextSelectionKey++;
    selectionKeys.set(feature, key);
  }
  return key;
}

/**
 * A constant color, or (while one of this layer's features is selected) an accessor that keeps the selected
 * feature at full strength and fades its siblings. `selected` is matched by reference: deck hands accessors the
 * same feature objects the pick returned.
 */
function colorFor(color: Rgba, opacity: number, selected: Feature | undefined): ColorAccessor {
  const base = withOpacity(color, opacity);
  if (!selected) return base;
  const faded = withOpacity(base, SIBLING_FADE);
  return (f: Feature) => (f === selected ? base : faded);
}

/** Linear interpolation of `stops` (x ascending) at `x`, clamped at both ends. */
function interpolate(x: number, xs: readonly number[], ys: readonly number[]): number {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]) {
      const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
      return ys[i - 1] + (ys[i] - ys[i - 1]) * t;
    }
  }
  return ys[ys.length - 1];
}

/**
 * The score ramp for a 0 to 100 `v`: white at 25% alpha up to `to` (amber by default) at 70%. Missing or
 * non-numeric `v` reads as 0.
 */
export function scoreRampColor(v: unknown, to: string = SCORE_RAMP.to): Rgba {
  const n = typeof v === "number" ? v : Number(v);
  const t = Number.isFinite(n) ? Math.min(1, Math.max(0, n / 100)) : 0;
  const from = hexToRgba(SCORE_RAMP.from);
  const end = hexToRgba(to);
  const alpha = SCORE_RAMP.fromAlpha + (SCORE_RAMP.toAlpha - SCORE_RAMP.fromAlpha) * t;
  return [
    Math.round(from[0] + (end[0] - from[0]) * t),
    Math.round(from[1] + (end[1] - from[1]) * t),
    Math.round(from[2] + (end[2] - from[2]) * t),
    Math.round(255 * alpha),
  ];
}

/** A per-feature color (the score ramp) with op opacity and the selection fade applied. */
function rampFor(ramp: (f: Feature) => Rgba, opacity: number, selected: Feature | undefined): ColorAccessor {
  return (f: Feature) => {
    const color = withOpacity(ramp(f), opacity);
    return selected && f !== selected ? withOpacity(color, SIBLING_FADE) : color;
  };
}

/** Widths (px) of Wally's basemap-trail look at a zoom: casing and dashed core. */
export function outdoorsTrailWidths(zoom: number): { casing: number; core: number } {
  const { zooms, casing, core } = OUTDOORS_TRAIL;
  return { casing: interpolate(zoom, zooms, casing), core: interpolate(zoom, zooms, core) };
}

/** Dashes for the Outdoors trail core. Mapbox measures dashes in line widths, deck in half widths. */
const OUTDOORS_TRAIL_DASH: [number, number] = [OUTDOORS_TRAIL.dash[0] * 2, OUTDOORS_TRAIL.dash[1] * 2];
const dashExtension = new PathStyleExtension({ dash: true });
const SOLID: [number, number] = [0, 0];

/** Pins draw this tall on screen (the sprite is 34×44). */
const PIN_SIZE_PX = 44;
/** Sprites are rasterized into the icon atlas at 2x so they stay sharp on high-density screens. */
const PIN_ATLAS_SCALE = 2;
type AtlasIcon = { id: string; url: string; width: number; height: number; anchorY: number };
/** One atlas definition per pin sprite, made once, so `getIcon` returns the same object every frame. */
const atlasIcons = new Map<PinIcon, AtlasIcon>();
function atlasIcon(icon: PinIcon): AtlasIcon {
  let entry = atlasIcons.get(icon);
  if (!entry) {
    entry = {
      id: icon.id,
      url: icon.url,
      width: icon.width * PIN_ATLAS_SCALE,
      height: icon.height * PIN_ATLAS_SCALE,
      anchorY: icon.anchorY * PIN_ATLAS_SCALE,
    };
    atlasIcons.set(icon, entry);
  }
  return entry;
}

/** True when a points op should draw Wally pins: every feature a Point, and no more than `pinThreshold`. */
export function drawsPins(data: GeoJSON.FeatureCollection): boolean {
  return data.features.length <= pinThreshold && data.features.every((f) => f.geometry?.type === "Point");
}

/** What one op's layers need to know beyond the op itself. */
type OpContext = {
  data: GeoJSON.FeatureCollection;
  style: StyleHints;
  selected: Feature | undefined;
  basemap: MapState["basemap"];
  zoom: number;
};

/** The deck layers for one render op, bottom first (lines add a white casing beneath the stroke). */
function geoJsonLayersFor(op: RenderOp, { data, style, selected, basemap, zoom }: OpContext): Layer[] {
  const requested = usableColor(op.color);
  const color = requested ?? style.color;
  const opacity = Math.min(1, Math.max(0, op.opacity ?? 1));
  const id = `${op.layerId}:${op.mode}`;
  // Color accessors become functions while a feature is selected, and deck only re-runs a function accessor
  // when its trigger changes, so the trigger carries everything the colors depend on.
  const trigger = [selectionKey(selected), opacity, color];
  const updateTriggers = { getLineColor: trigger, getFillColor: trigger };
  const base = { id, data, pickable: true, updateTriggers };
  switch (op.mode) {
    case "points":
      if (drawsPins(data)) {
        // Wally teardrops: the icon's alpha carries the op opacity and the selection fade.
        return [
          new IconLayer<Feature>({
            id,
            data: data.features,
            pickable: true,
            getIcon: (f) => atlasIcon(pinIconFor(op.layerId, f)),
            getPosition: (f) => (f.geometry as GeoJSON.Point).coordinates as [number, number],
            getSize: PIN_SIZE_PX,
            sizeUnits: "pixels",
            getColor: colorFor(WHITE, opacity, selected),
            updateTriggers: { getColor: trigger, getIcon: op.layerId },
            // The overlay draws in deck's GlobeView, which flips the icon quads' winding; with back-face culling
            // on, deck 9.4 draws (and picks) no icons at all there.
            parameters: { cullMode: "none" },
          }),
        ];
      }
      return [
        new GeoJsonLayer({
          ...base,
          pointType: "circle",
          getPointRadius: POINT_RADIUS_PX,
          pointRadiusUnits: "pixels",
          getFillColor: colorFor(hexToRgba(color), opacity, selected),
          stroked: true,
          getLineColor: colorFor(WHITE, opacity, selected),
          getLineWidth: POINT_CASING_PX,
          lineWidthUnits: "pixels",
        }),
      ];
    case "lines": {
      // On plain Outdoors the trails read as Wally's basemap trails: green dashes over a white casing.
      const wallyTrail = basemap === "outdoors" && op.layerId === "osm-trails" && !requested;
      const widths = wallyTrail ? outdoorsTrailWidths(zoom) : { casing: LINE_CASING_WIDTH_PX, core: LINE_WIDTH_PX };
      return [
        new GeoJsonLayer({
          id: `${id}:casing`,
          data,
          pickable: false,
          filled: false,
          getLineColor: colorFor(WHITE, opacity, selected),
          getLineWidth: widths.casing,
          lineWidthUnits: "pixels",
          updateTriggers,
        }),
        new GeoJsonLayer({
          ...base,
          filled: false,
          getLineColor: colorFor(hexToRgba(wallyTrail ? OUTDOORS_TRAIL.color : color), opacity, selected),
          getLineWidth: widths.core,
          lineWidthUnits: "pixels",
          // The dash extension stays on every core line: adding or removing an extension on a live layer (as a
          // basemap switch would) leaves deck with a dangling dash attribute and it throws. [0, 0] draws solid.
          extensions: [dashExtension],
          getDashArray: wallyTrail ? OUTDOORS_TRAIL_DASH : SOLID,
        }),
      ];
    }
    case "polygons": {
      const fillAlpha = Math.round(255 * (style.fillOpacity ?? POLYGON_FILL_OPACITY));
      // Scores (popularity, remoteness) shade each area by `v` from white to amber, or to a picked color.
      const getFillColor =
        style.unit === "score"
          ? rampFor((f) => scoreRampColor(f.properties?.v, requested ?? SCORE_RAMP.to), opacity, selected)
          : colorFor(hexToRgba(color, fillAlpha), opacity, selected);
      return [
        new GeoJsonLayer({
          ...base,
          getFillColor,
          getLineColor: colorFor(WHITE, opacity, selected),
          getLineWidth: POLYGON_OUTLINE_PX,
          lineWidthUnits: "pixels",
        }),
      ];
    }
    case "heat":
      // Drawn by Mapbox's native heatmap (components/mapTiles.ts): deck's HeatmapLayer renders nothing in
      // GlobeView, which is what the overlay uses while the map is in globe projection.
      return [];
    default:
      throw new Error(`NotImplemented: ${op.mode}`);
  }
}

/**
 * Turns map state into deck.gl layer instances for each visible geojson render op (lines bring a casing).
 * Heat ops yield none here; Mapbox draws them.
 */
export function buildDeckLayers(state: MapState): Layer[] {
  const layers: Layer[] = [];
  for (const op of state.renderOps) {
    if (!op.visible) continue;
    const loaded = state.layers[op.layerId];
    if (!loaded) continue;
    if (loaded.result.kind === "tiles") continue;
    const selected = state.selected?.layerId === op.layerId ? state.selected.feature : undefined;
    layers.push(
      ...geoJsonLayersFor(op, {
        data: loaded.result.data,
        style: loaded.style,
        selected,
        basemap: state.basemap,
        zoom: state.viewport.zoom,
      }),
    );
  }
  return layers;
}
