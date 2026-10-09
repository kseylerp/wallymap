import type { Layer } from "@deck.gl/core";
import { PathStyleExtension, _TerrainExtension as TerrainExtension } from "@deck.gl/extensions";
import { H3HexagonLayer, TerrainLayer } from "@deck.gl/geo-layers";
import { GeoJsonLayer, IconLayer, TextLayer } from "@deck.gl/layers";
import { WebMercatorViewport } from "@math.gl/web-mercator";
import type { Feature } from "geojson";
import { cellToLatLng, latLngToCell } from "h3-js";
import type { BBox, StyleHints } from "@/layers/types";
import {
  INK as INK_HEX,
  LAYER_LINE_DASH,
  LINE_DASHES,
  POLYGON_INK_FILL,
  SCORE_RAMP,
} from "@/lib/render/palette";
import { DECK_TERRAIN_ID, demDecoder, demTileUrl } from "@/lib/render/wally/deckTerrain";
import { featureCenter } from "@/lib/render/inspect";
import { pinIconFor } from "@/lib/render/wally/pins";
import type { MapState, RenderOp, Viewport } from "@/lib/render/state";

type Rgba = [number, number, number, number];

/** `--slate`: the default stroke for data drawn over imagery. */
export const SLATE = "#2F3A44";
const WHITE: Rgba = [255, 255, 255, 255];
/**
 * Lines: a white stroke (dashed per layer) over a thin ink casing, so it reads on bright and dark imagery and stays
 * clear of the route's purple to coral gradient. 2.5px white over 1px of ink a side; selected, 3.5px over 1.5px.
 */
export const LINE = { width: 2.5, casing: 1, selectedWidth: 3.5, selectedCasing: 1.5 } as const;
/** Polygon outlines: 1px white over 0.5px of ink a side (selected: 2.5px over 1px), above a light ink wash. */
export const POLYGON_OUTLINE = { width: 1, casing: 0.5, selectedWidth: 2.5, selectedCasing: 1 } as const;
const POLYGON_FILL_DEFAULT = 0.1;
/** Selected tiles take a 2.5px ink outline. */
export const SELECTED_LINE_PX = 2.5;
/** Score areas outline in faint ink so a dense grid reads as a surface, not a mesh. */
const SCORE_OUTLINE_PX = 0.5;
const SCORE_OUTLINE_ALPHA = 0.2;
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
type WidthAccessor = number | ((f: Feature) => number);

/** The data ink as RGBA. */
const INK = hexToRgba(INK_HEX);

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


const dashExtension = new PathStyleExtension({ dash: true });
const terrainExtension = new TerrainExtension();

/** Patterns for line layers with no assigned dash, so two unknown line layers still differ. */
const FALLBACK_DASHES = ["dashed", "dotted", "long"] as const;

/** The dash pattern that marks a line layer: trails solid, forest roads dashed, others by a stable hash. */
export function lineDashFor(layerId: string): [number, number] {
  const named = LAYER_LINE_DASH[layerId];
  if (named) return [...LINE_DASHES[named]];
  let hash = 0;
  for (const ch of layerId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return [...LINE_DASHES[FALLBACK_DASHES[hash % FALLBACK_DASHES.length]]];
}

/**
 * Terrain props for a data layer while 3D terrain is on: symbols stand on the surface by their anchor (`offset`),
 * lines and polygons are draped over it (`drape`). Off, the layer keeps only its own extensions.
 */
function terrainProps(terrain: boolean, mode: "offset" | "drape", extensions: LayerExtensionLike[] = []) {
  return terrain ? { extensions: [...extensions, terrainExtension], terrainDrawMode: mode } : { extensions };
}
type LayerExtensionLike = PathStyleExtension | TerrainExtension;

/** A constant width, or (while one of this layer's features is selected) `selectedWidth` for that feature. */
function widthFor(width: number, selectedWidth: number, selected: Feature | undefined): WidthAccessor {
  if (!selected) return width;
  return (f: Feature) => (f === selected ? selectedWidth : width);
}

/** Like `colorFor`, but the selected feature takes `selectedColor` (a faint outline turns to full ink). */
function strokeFor(color: Rgba, selectedColor: Rgba, opacity: number, selected: Feature | undefined): ColorAccessor {
  if (!selected) return withOpacity(color, opacity);
  const strong = withOpacity(selectedColor, opacity);
  const faded = withOpacity(withOpacity(color, opacity), SIBLING_FADE);
  return (f: Feature) => (f === selected ? strong : faded);
}

/** Symbols draw this size on screen: a 24px sprite around a 12px symbol, leaving room for the halo. */
const SYMBOL_SIZE_PX = 24;
/** Sprites are rasterized into the icon atlas at 2x so they stay sharp on high-density screens. */
const ATLAS_SCALE = 2;
type AtlasIcon = { id: string; url: string; width: number; height: number; anchorY: number };
/** One atlas definition per sprite, made once, so `getIcon` returns the same object every frame. */
const atlasIcons = new Map<AtlasIcon, AtlasIcon>();
function atlasIcon(icon: AtlasIcon): AtlasIcon {
  let entry = atlasIcons.get(icon);
  if (!entry) {
    entry = {
      id: icon.id,
      url: icon.url,
      width: icon.width * ATLAS_SCALE,
      height: icon.height * ATLAS_SCALE,
      anchorY: icon.anchorY * ATLAS_SCALE,
    };
    atlasIcons.set(icon, entry);
  }
  return entry;
}

/** A point layer with more features than this draws H3 tiles instead of symbols. */
export const hexbinThreshold = 2000;

/** The H3 resolution for tiles at a zoom: 3 up to z6, then one finer every two zooms, 7 from z13. */
export function hexResolution(zoom: number): number {
  const z = Math.floor(zoom);
  if (z <= 6) return 3;
  if (z <= 8) return 4;
  if (z <= 10) return 5;
  if (z <= 12) return 6;
  return 7;
}

/** Where a feature sits as a symbol: a Point's coordinates, else the center of its extent. */
function markerPosition(f: Feature): [number, number] {
  if (f.geometry?.type === "Point") return f.geometry.coordinates as [number, number];
  return featureCenter(f) ?? [0, 0];
}

/**
 * One tile: a Point feature at the hex center whose properties carry the cell and how many features fell in it, so
 * a pick reads as a feature the inspect card can show ("N features").
 */
export type HexFeature = Feature<GeoJSON.Point, { count: number; h3: string }>;

/** One result binned at one resolution: the tiles, the labelled subset, and the busiest tile's count. */
type Binned = { hexes: HexFeature[]; labelled: HexFeature[]; max: number };

/** Binned tiles per result and resolution, so panning and selection reuse the same tile objects. */
const hexCache = new WeakMap<GeoJSON.FeatureCollection, Map<number, Binned>>();

/** True for a usable lng/lat: finite, longitude within ±180 and latitude within ±90 (H3 throws otherwise). */
function validLngLat([lng, lat]: [number, number]): boolean {
  return Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90;
}

function binned(data: GeoJSON.FeatureCollection, resolution: number): Binned {
  let byResolution = hexCache.get(data);
  if (!byResolution) {
    byResolution = new Map();
    hexCache.set(data, byResolution);
  }
  const cached = byResolution.get(resolution);
  if (cached) return cached;
  const counts = new Map<string, number>();
  for (const f of data.features) {
    const position = markerPosition(f);
    // One bad coordinate must not throw, or the overlay drops every layer on the map.
    if (!validLngLat(position)) continue;
    const cell = latLngToCell(position[1], position[0], resolution);
    counts.set(cell, (counts.get(cell) ?? 0) + 1);
  }
  const hexes: HexFeature[] = [...counts].map(([h3, count]) => {
    const [lat, lng] = cellToLatLng(h3);
    return { type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: { count, h3 } };
  });
  const entry = {
    hexes,
    labelled: hexes.filter((h) => h.properties.count >= HEX_TILE.labelMin),
    max: hexes.reduce((m, h) => Math.max(m, h.properties.count), 1),
  };
  byResolution.set(resolution, entry);
  return entry;
}

/** Bins a result's features into H3 cells at `resolution`, skipping invalid coordinates (cached per result). */
export function hexbin(data: GeoJSON.FeatureCollection, resolution: number): HexFeature[] {
  return binned(data, resolution).hexes;
}

/**
 * Tiles: light gray that holds up on dark imagery, from white at 55% alpha (fewest features) to `#9A9A96` at 80%
 * (busiest tile), with a light edge and ink counts on a white halo.
 */
export const HEX_TILE = {
  from: [255, 255, 255] as const,
  to: hexToRgba("#9A9A96"),
  alpha: [0.55, 0.8] as const,
  edge: [255, 255, 255, 204] as Rgba,
  /** Tiles shrink to this share of their cell, so they read as separate cells. */
  coverage: 0.94,
  /** Tiles holding at least this many features show their count. */
  labelMin: 2,
  labelSize: 11,
} as const;

/** A tile's fill: white toward light gray, and more opaque, as its count nears `max` (log scaled). */
export function hexTileColor(count: number, max: number): Rgba {
  const t = max > 1 ? Math.min(1, Math.max(0, Math.log(count) / Math.log(max))) : 1;
  const { from, to, alpha } = HEX_TILE;
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
    Math.round(255 * interpolate(t, [0, 1], alpha)),
  ];
}

/** Counts as tile labels: 1,234 reads as 1.2k. */
function countLabel(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "")}k` : String(n);
}

/** What one op's layers need to know beyond the op itself. */
type OpContext = {
  data: GeoJSON.FeatureCollection;
  style: StyleHints;
  selected: Feature | undefined;
  zoom: number;
  /** Deck's terrain layer is in the stack: drape and offset this op's layers on it. */
  terrain: boolean;
};

/** Selection, opacity and color: what every color accessor of an op depends on (see `updateTriggers`). */
function colorTrigger(selected: Feature | undefined, opacity: number, color: string): unknown[] {
  return [selectionKey(selected), opacity, color];
}

/** The deck layers for one render op, bottom first (lines add a white casing beneath the stroke). */
function geoJsonLayersFor(op: RenderOp, ctx: OpContext): Layer[] {
  const { data, style, selected, terrain } = ctx;
  // Lines and outlines draw white over ink, washes in ink. A color the user or the agent asked for replaces the
  // white stroke and the wash.
  const requested = usableColor(op.color);
  const stroke = requested ? hexToRgba(requested) : WHITE;
  const fill = requested ? hexToRgba(requested) : INK;
  const opacity = Math.min(1, Math.max(0, op.opacity ?? 1));
  const id = `${op.layerId}:${op.mode}`;
  // Color and width accessors become functions while a feature is selected, and deck only re-runs a function
  // accessor when its trigger changes, so the trigger carries everything they depend on.
  const trigger = colorTrigger(selected, opacity, requested ?? INK_HEX);
  const updateTriggers = { getLineColor: trigger, getFillColor: trigger, getLineWidth: trigger };
  const base = { id, data, pickable: true, updateTriggers };
  switch (op.mode) {
    case "points":
      if (data.features.length > hexbinThreshold) return hexTileLayers(op, ctx, opacity);
      return symbolLayers(op, ctx, opacity);
    case "lines": {
      const casingWidth = LINE.width + 2 * LINE.casing;
      const selectedCasingWidth = LINE.selectedWidth + 2 * LINE.selectedCasing;
      return [
        new GeoJsonLayer({
          id: `${id}:casing`,
          data,
          pickable: false,
          filled: false,
          getLineColor: colorFor(INK, opacity, selected),
          getLineWidth: widthFor(casingWidth, selectedCasingWidth, selected),
          lineWidthUnits: "pixels",
          updateTriggers,
          ...terrainProps(terrain, "drape"),
        }),
        new GeoJsonLayer({
          ...base,
          filled: false,
          getLineColor: colorFor(stroke, opacity, selected),
          getLineWidth: widthFor(LINE.width, LINE.selectedWidth, selected),
          lineWidthUnits: "pixels",
          // The dash extension stays on every core line: adding or removing an extension on a live layer (as a
          // basemap switch would) leaves deck with a dangling dash attribute and it throws. [0, 0] draws solid.
          getDashArray: lineDashFor(op.layerId),
          ...terrainProps(terrain, "drape", [dashExtension]),
        }),
      ];
    }
    case "polygons": {
      // Scores (popularity, remoteness) shade each area by `v` on a white to ink ramp under a faint ink outline, so a
      // dense grid reads as a surface; other polygons take the white-over-ink outline over a light ink wash.
      const score = style.unit === "score";
      const o = POLYGON_OUTLINE;
      const casing = new GeoJsonLayer({
        id: `${id}:casing`,
        data,
        pickable: false,
        filled: false,
        getLineColor: colorFor(INK, opacity, selected),
        getLineWidth: widthFor(score ? 0 : o.width + 2 * o.casing, o.selectedWidth + 2 * o.selectedCasing, selected),
        lineWidthUnits: "pixels",
        updateTriggers,
        ...terrainProps(terrain, "drape"),
      });
      if (score) {
        return [
          casing,
          new GeoJsonLayer({
            ...base,
            getFillColor: rampFor((f) => scoreRampColor(f.properties?.v, requested ?? SCORE_RAMP.to), opacity, selected),
            getLineColor: strokeFor(withOpacity(INK, SCORE_OUTLINE_ALPHA), WHITE, opacity, selected),
            getLineWidth: widthFor(SCORE_OUTLINE_PX, o.selectedWidth, selected),
            lineWidthUnits: "pixels",
            ...terrainProps(terrain, "drape"),
          }),
        ];
      }
      const fillShare = POLYGON_INK_FILL[op.layerId] ?? POLYGON_FILL_DEFAULT;
      return [
        casing,
        new GeoJsonLayer({
          ...base,
          filled: fillShare > 0,
          getFillColor: colorFor(withOpacity(fill, fillShare), opacity, selected),
          getLineColor: colorFor(stroke, opacity, selected),
          getLineWidth: widthFor(o.width, o.selectedWidth, selected),
          lineWidthUnits: "pixels",
          ...terrainProps(terrain, "drape"),
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
 * Point symbols: one monochrome sprite per layer family (pins.ts), centered on the point and filled solid ink
 * while selected. The sprite's alpha carries the op opacity and the selection fade.
 */
function symbolLayers(op: RenderOp, { data, selected, terrain }: OpContext, opacity: number): Layer[] {
  return [
    new IconLayer<Feature>({
      id: `${op.layerId}:points`,
      data: data.features,
      pickable: true,
      getPosition: markerPosition,
      getIcon: (f) => atlasIcon(pinIconFor(op.layerId, f, f === selected)),
      getSize: SYMBOL_SIZE_PX,
      sizeUnits: "pixels",
      getColor: colorFor(WHITE, opacity, selected),
      updateTriggers: { getColor: [selectionKey(selected), opacity], getIcon: [op.layerId, selectionKey(selected)] },
      // The overlay draws in deck's GlobeView, which flips the icon quads' winding; with back-face culling on,
      // deck 9.4 draws (and picks) no icons at all there.
      parameters: { cullMode: "none" },
      ...terrainProps(terrain, "offset"),
    }),
  ];
}

/**
 * Dense point layers as flat light-gray H3 tiles at a zoom-dependent resolution, with an ink count on grouped
 * tiles. A picked tile is a `HexFeature`, so the inspect card shows its count.
 */
function hexTileLayers(op: RenderOp, { data, selected: picked, zoom, terrain }: OpContext, opacity: number): Layer[] {
  const id = `${op.layerId}:points`;
  const resolution = hexResolution(zoom);
  const { hexes, labelled, max } = binned(data, resolution);
  // A tile picked at another resolution is not among these tiles: ignore it rather than fade every tile.
  const selected = picked && hexes.includes(picked as HexFeature) ? picked : undefined;
  const trigger = [selectionKey(selected), opacity, resolution];
  const fade = (f: HexFeature, c: Rgba) => {
    const base = withOpacity(c, opacity);
    return selected && f !== selected ? withOpacity(base, SIBLING_FADE) : base;
  };
  return [
    new H3HexagonLayer<HexFeature>({
      id,
      data: hexes,
      pickable: true,
      getHexagon: (f) => f.properties.h3,
      extruded: false,
      // Polygons, not instanced columns: exact cell outlines in the globe view and at any latitude.
      highPrecision: true,
      coverage: HEX_TILE.coverage,
      getFillColor: (f) => fade(f, hexTileColor(f.properties.count, max)),
      stroked: true,
      getLineColor: (f) => (f === selected ? withOpacity(INK, opacity) : fade(f, HEX_TILE.edge)),
      getLineWidth: (f) => (f === selected ? SELECTED_LINE_PX : 1),
      lineWidthUnits: "pixels",
      updateTriggers: { getFillColor: trigger, getLineColor: trigger, getLineWidth: trigger },
      ...terrainProps(terrain, "drape"),
    }),
    new TextLayer<HexFeature>({
      id: `${id}:labels`,
      data: labelled,
      pickable: false,
      getPosition: (f) => f.geometry.coordinates as [number, number],
      getText: (f) => countLabel(f.properties.count),
      getSize: HEX_TILE.labelSize,
      sizeUnits: "pixels",
      getColor: (f) => fade(f, INK),
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontWeight: 500,
      characterSet: "0123456789.k",
      fontSettings: { sdf: true },
      outlineWidth: 0.35,
      outlineColor: [255, 255, 255, 230],
      billboard: true,
      parameters: { cullMode: "none" },
      updateTriggers: { getColor: trigger },
      ...terrainProps(terrain, "offset"),
    }),
  ];
}

/**
 * Deck's invisible copy of the map's terrain: a TerrainLayer over the same DEM, drawn fully transparent so only
 * the draped data layers show, and read by the TerrainExtension to stand pins on the slopes.
 */
function terrainSourceLayer(token: string): Layer {
  return new TerrainLayer({
    id: DECK_TERRAIN_ID,
    elevationData: demTileUrl(token),
    elevationDecoder: demDecoder(),
    tileSize: 512,
    maxZoom: 14,
    // Transparent mesh: the draped layers' cover is all that reaches the screen.
    color: [0, 0, 0, 0],
    material: false,
    operation: "terrain+draw",
    pickable: false,
    // Same GlobeView winding flip as the pins: with back-face culling on, deck draws no terrain mesh at all.
    parameters: { cullMode: "none" },
  });
}

/** Literal `process.env.NEXT_PUBLIC_*` access so Next inlines it into the client bundle. */
const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN?.trim() ?? "";

/**
 * Turns map state into deck.gl layer instances for each visible geojson render op (lines bring a casing).
 * Heat ops yield none here; Mapbox draws them.
 */
export function buildDeckLayers(state: MapState, { mapboxToken = MAPBOX_TOKEN }: { mapboxToken?: string } = {}): Layer[] {
  const layers: Layer[] = [];
  // 3D terrain on the map means deck needs its own copy of the surface to drape on (see deckTerrain.ts).
  const terrain = state.terrain && !state.flattened && mapboxToken !== "";
  if (terrain) layers.push(terrainSourceLayer(mapboxToken));
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
        zoom: state.viewport.zoom,
        terrain,
      }),
    );
  }
  return layers;
}
