import { LayerExtension, type Layer } from "@deck.gl/core";
import { FillStyleExtension, _TerrainExtension as TerrainExtension } from "@deck.gl/extensions";
import { H3HexagonLayer, TerrainLayer } from "@deck.gl/geo-layers";
import { GeoJsonLayer, IconLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { WebMercatorViewport } from "@math.gl/web-mercator";
import type { Feature } from "geojson";
import { cellToBoundary, cellToLatLng, getHexagonEdgeLengthAvg, latLngToCell, UNITS } from "h3-js";
import Supercluster from "supercluster";
import type { BBox, StyleHints } from "@/layers/types";
import {
  areaRecipe,
  CLUSTER_BLOB,
  COLUMN_WALL_ALPHAS,
  COMPARE_COLORS,
  DELTA_COLORS,
  HEX_COLUMN,
  HEX_TILE,
  isPaletteColor,
  LINE,
  lineColorFor,
  PINK,
  PURPLE,
  scoreRampFor,
  SELECTED_AREA,
  SIBLING_FADE,
  symbolSizePx,
  WHITE as WHITE_HEX,
  type AreaRecipe,
  type HatchColor,
  type RampName,
} from "@/lib/render/palette";
import { acresStep, HATCH_SCALE, hatchAtlas, hatchAtlasCanvas, hatchPatternId } from "@/lib/render/hatch";
import { hexToRgb, rampColor } from "@/lib/render/ramp";
import { compareBId, compareSideShown, DELTA_FILL_ALPHA, effectiveMode, isHexCollection } from "@/lib/render/compareView";
import { DECK_TERRAIN_ID, DECK_TERRAIN_TAG, demDecoder, demTileUrl } from "@/lib/render/wally/deckTerrain";
import { featureBBox, featureCenter, HEX_DELTA_TAG } from "@/lib/render/inspect";
import { pinIconFor } from "@/lib/render/wally/pins";
import { drawsNativeLines, isLineGeometry, SELECTED_LINE } from "@/lib/render/nativeLines";
import type { MapState, RenderMode, RenderOp, Viewport } from "@/lib/render/state";
import { extentOf, hatchStepOf, primaryFacet, sizeScale, topFeatures } from "@/lib/render/facets";
import { RANKED_LABELS } from "@/lib/render/views";

type Rgba = [number, number, number, number];

/** Parses `#rgb` or `#rrggbb` into an RGBA tuple for deck.gl. */
export function hexToRgba(hex: string, alpha = 255): Rgba {
  return [...hexToRgb(hex), alpha];
}

const WHITE = hexToRgba(WHITE_HEX);
const SELECT = hexToRgba(PURPLE);
/** Sprites draw their own colors; their tint only carries alpha (opacity and the selection fade). */
const SPRITE_TINT = WHITE;

/** Selected tiles take a 2.5px purple outline. */
export const SELECTED_LINE_PX = 2.5;
/** While a feature is selected, the rest of its layer fades to this share of its alpha (palette.ts). */
export { SIBLING_FADE };

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

type ColorAccessor = Rgba | ((f: Feature) => Rgba);
type WidthAccessor = number | ((f: Feature) => number);

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
 * feature at full strength (in `selectedColor` when given) and fades its siblings. `selected` is matched by
 * reference: deck hands accessors the same feature objects the pick returned.
 */
function colorFor(color: Rgba, opacity: number, selected: Feature | undefined, selectedColor?: Rgba): ColorAccessor {
  const base = withOpacity(color, opacity);
  if (!selected) return base;
  const strong = selectedColor ? withOpacity(selectedColor, opacity) : base;
  const faded = withOpacity(base, SIBLING_FADE);
  return (f: Feature) => (f === selected ? strong : faded);
}

/** A per-feature color with op opacity and the selection fade applied. */
function perFeature(color: (f: Feature) => Rgba, opacity: number, selected: Feature | undefined): (f: Feature) => Rgba {
  return (f: Feature) => {
    const c = withOpacity(color(f), opacity);
    return selected && f !== selected ? withOpacity(c, SIBLING_FADE) : c;
  };
}

/** A palette ramp at `t` (0..1) as RGBA. */
export function rampRgba(name: RampName, t: number, alpha = 255): Rgba {
  return [...rampColor(name, t), alpha];
}

/** A 0 to 100 score as 0..1; missing or non-numeric reads as 0. */
function scoreT(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n / 100)) : 0;
}

/**
 * Score areas (remoteness cells): the layer's ramp on `v`, more opaque as it rises (0.55 to 0.80, as the hex tiles),
 * so a dense grid reads as a surface.
 */
export function scoreRampColor(v: unknown, ramp: RampName = "density"): Rgba {
  const t = scoreT(v);
  const [a0, a1] = HEX_TILE.alpha;
  return rampRgba(ramp, t, Math.round(255 * (a0 + (a1 - a0) * t)));
}

const fillExtension = new FillStyleExtension({ pattern: true });
const terrainExtension = new TerrainExtension();
type LayerExtensionLike = FillStyleExtension | TerrainExtension | UnpremultiplySpriteExtension;

/**
 * Terrain props for a data layer while 3D terrain is on: symbols stand on the surface by their anchor (`offset`),
 * lines and polygons are draped over it (`drape`). Off, the layer keeps only its own extensions.
 */
function terrainProps(terrain: boolean, mode: "offset" | "drape", extensions: LayerExtensionLike[] = []) {
  return terrain ? { extensions: [...extensions, terrainExtension], terrainDrawMode: mode } : { extensions };
}

/** A constant width, or (while one of this layer's features is selected) `selectedWidth` for that feature. */
function widthFor(width: number, selectedWidth: number, selected: Feature | undefined): WidthAccessor {
  if (!selected) return width;
  return (f: Feature) => (f === selected ? selectedWidth : width);
}

/** Meters one CSS pixel spans on the ground at a Mapbox zoom (512px tiles) and latitude. */
export function metersPerPixel(zoom: number, latitude: number): number {
  return (40_075_016.686 * Math.cos((latitude * Math.PI) / 180)) / (512 * 2 ** zoom);
}

/**
 * How a deck stroke states its pixel widths (area outlines, and a swiped compare's line sides: every other line is a
 * native Mapbox line, lib/render/nativeLines.ts, which Mapbox drapes at true pixel widths). Flat, it just asks deck for
 * pixels. While the layer drapes on terrain deck
 * draws it into an offscreen cover texture per terrain tile, and a pixel width there is a width in that texture's
 * pixels: a tile's texture is capped at 2048px and holds a different number of pixels per screen pixel for each tile
 * zoom, and deck counts it in device pixels, so on a 2x screen at zoom 10.9 a 2.5px trail came out 8 to 14px wide
 * (and blocky, upscaled) beside the same trail at 4px in the next tile over. Meters are the same in every texture, so
 * a draped layer asks for the meters one pixel spans at the map's current zoom and center (the camera in state, which
 * updates when a move ends) and keeps the owner's pixel widths (2.5 core, 4.5 casing, 3.5 selected, 3 route).
 */
function pixelWidths(ctx: Pick<OpContext, "terrain" | "zoom" | "latitude">) {
  if (!ctx.terrain) return { units: "pixels", scale: 1 } as const;
  const scale = metersPerPixel(ctx.zoom, ctx.latitude);
  return { units: "meters", scale: Number.isFinite(scale) && scale > 0 ? scale : 1 } as const;
}

/**
 * Un-premultiplies the icon sprites. The atlas keeps each sprite premultiplied (its color already scaled by its alpha)
 * and the layer then blends by alpha once more, so every translucent part of a symbol drew as its color times its alpha
 * twice: the 0.85 off-white fill came out a grey 0.72 and the 0.9 white halo a dull 0.81, which on the green topographic
 * basemap made the symbols read as faint rings. Dividing the color by the sprite's own alpha at the end of the
 * fragment shader gives the drawn color back (the tint's opacity still scales only the alpha); picking is left alone.
 */
export class UnpremultiplySpriteExtension extends LayerExtension {
  static extensionName = "UnpremultiplySpriteExtension";
  getShaders() {
    return {
      inject: {
        "fs:#main-end": "if (texColor.a > 0.0 && !bool(picking.isActive)) fragColor.rgb = fragColor.rgb / texColor.a;",
      },
    };
  }
}
const unpremultiplySpriteExtension = new UnpremultiplySpriteExtension();

/** Symbols draw their 24px sprite 1:1 on screen: the 10 to 14px symbol (SYMBOL, palette.ts) sits in it with room for the halo. */
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
export type HexFeature = Feature<GeoJSON.Point, { count: number; h3: string; aggregate: true }>;

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
    return { type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: { count, h3, aggregate: true } };
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
 * A tile's fill (owner's board, hex tiles variant A): the gray ramp from off-white (fewest features) to dark grey
 * (the busiest tile), log scaled, at 0.55 to 0.80 opacity.
 */
export function hexTileColor(count: number, max: number): Rgba {
  const t = max > 1 ? Math.min(1, Math.max(0, Math.log(count) / Math.log(max))) : 1;
  const [a0, a1] = HEX_TILE.alpha;
  return rampRgba(HEX_TILE.ramp, t, Math.round(255 * (a0 + (a1 - a0) * t)));
}

const HEX_EDGE = hexToRgba(HEX_TILE.edge, Math.round(255 * HEX_TILE.edgeAlpha));
const HEX_LABEL = hexToRgba(HEX_TILE.label);
const HEX_LABEL_HALO = hexToRgba(HEX_TILE.labelHalo, 230);

/** Counts as tile labels: 1,234 reads as 1.2k. */
function countLabel(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "")}k` : String(n);
}

/**
 * The id a data layer's deck layers are named after: the app layer id, tagged while the layer drapes on terrain.
 * Deck sets a layer extension up once, at creation, and the terrain extension leaves its draw mode in the layer's
 * state for good. So a live layer that gains it is never drawn (no terrain effect was registered for it) and one
 * that loses it is skipped by the effect that is still registered. A new id on each 3D switch makes deck build a
 * fresh layer instead of updating the old one.
 */
export function deckLayerKey(layerId: string, terrain: boolean): string {
  return terrain ? `${layerId}${DECK_TERRAIN_TAG}` : layerId;
}

/** What one op's layers need to know beyond the op itself. */
type OpContext = {
  data: GeoJSON.FeatureCollection;
  style: StyleHints;
  selected: Feature | undefined;
  zoom: number;
  /** The map's center latitude, to turn a pixel width into meters while a layer drapes on terrain. */
  latitude: number;
  /** Deck's terrain layer is in the stack: drape and offset this op's layers on it. */
  terrain: boolean;
  /** The map is in 3D (terrain wanted and not flattened): columns extrude; in 2D they draw flat. */
  threeD: boolean;
  /** The id this op's deck layers are named after, when not the op's layer id (compare side B). */
  deckId?: string;
};

/** A palette color asked for by the layer panel or a compare side; anything else is ignored (palette only). */
function requestedColor(color: string | undefined): string | undefined {
  return isPaletteColor(color) ? color.trim().toUpperCase() : undefined;
}

/** The extent of a number across a collection, made once per collection and key. */
const extentMemo = new WeakMap<GeoJSON.FeatureCollection, Map<string, [number, number] | null>>();
function memoExtent(data: GeoJSON.FeatureCollection, key: string): [number, number] | null {
  let byKey = extentMemo.get(data);
  if (!byKey) {
    byKey = new Map();
    extentMemo.set(data, byKey);
  }
  if (!byKey.has(key)) byKey.set(key, extentOf(data, key));
  return byKey.get(key) ?? null;
}

/** The range facet that sizes features (`encode: "size"`, spec §12a): symbol size, hatch density. */
function sizeFacetKey(style: StyleHints): string | undefined {
  const facet = primaryFacet(style);
  return facet?.kind === "range" && facet.encode === "size" ? facet.key : undefined;
}

/**
 * The hatch density step for one area feature: fires by burned acres (fixed acre steps), another area layer with a
 * size facet (glacier area) by its share of the data's range, others the recipe's fixed step.
 */
function areaStep(layerId: string, recipe: AreaRecipe, f: Feature, sized?: { key: string; extent: [number, number] | null }): number {
  if (layerId === "fire-perimeters") return acresStep(f.properties?.acres ?? f.properties?.v);
  return sized ? hatchStepOf(f.properties?.[sized.key], sized.extent) : recipe.step;
}

/** Modes that already warned about falling back, so a bad mode warns once rather than on every frame. */
const warnedModes = new Set<string>();
function warnFallback(op: RenderOp, error?: unknown): void {
  const key = `${op.layerId}:${op.mode}`;
  if (warnedModes.has(key)) return;
  warnedModes.add(key);
  console.warn(`deck: cannot draw ${op.layerId} as "${op.mode}"; drawing symbols instead`, ...(error ? [error] : []));
}

/**
 * The deck layers for one render op, bottom first (lines and areas add a white casing beneath). Every mode has a
 * case; a mode this renderer does not know (an older permalink, a bad reply) draws symbols with a console warning.
 */
function geoJsonLayersFor(op: RenderOp, ctx: OpContext): Layer[] {
  const opacity = Math.min(1, Math.max(0, op.opacity ?? 1));
  const mode: RenderMode = op.mode;
  switch (mode) {
    case "points":
      // A ranked view keeps its symbols (sized, named) however many there are: the slider holds the top N.
      if (ctx.data.features.length > hexbinThreshold && op.view !== "ranked") return hexTileLayers(op, ctx, opacity);
      return [...symbolLayers(op, ctx, opacity), ...rankedLabelLayers(op, ctx, opacity)];
    case "hexbin":
      return hexTileLayers(op, ctx, opacity);
    case "clusters":
      return clusterLayers(op, ctx, opacity);
    case "columns":
      // Areas extrude by `v`; lines have no column form (Mapbox draws them: lib/render/nativeLines.ts). Points stack
      // into H3 columns. In 2D both draw flat.
      if (ctx.style.geometry === "line") return [];
      if (ctx.style.geometry === "polygon") {
        return ctx.threeD ? extrudedAreaLayers(op, ctx, opacity) : polygonLayers({ ...op, mode: "polygons" }, ctx, opacity);
      }
      return ctx.threeD ? columnLayers(op, ctx, opacity) : hexTileLayers(op, ctx, opacity);
    case "lines":
      // Native Mapbox line layers (lib/render/nativeLines.ts, synced by components/mapTiles.ts), crisp on 3D terrain.
      return [];
    case "polygons":
      return polygonLayers(op, ctx, opacity);
    case "heat":
      // Drawn by Mapbox's native heatmap (components/mapTiles.ts): deck's HeatmapLayer renders nothing in
      // GlobeView, which is what the overlay uses while the map is in globe projection. Deck draws only the feature
      // the user clicked (MapCanvas picks the nearest one under the heat), so the card points at a symbol.
      return heatSelectionLayers(op, ctx, opacity);
    default:
      warnFallback(op);
      return symbolLayers(op, ctx, opacity);
  }
}

function polygonLayers(op: RenderOp, ctx: OpContext, opacity: number): Layer[] {
  return ctx.style.unit === "score" ? scoreAreaLayers(op, ctx, opacity) : areaLayers(op, ctx, opacity);
}

/**
 * `geoJsonLayersFor` that never throws: one op that cannot build (bad data, a deck error) draws as symbols, or not at
 * all, instead of taking every other layer on the map down with it.
 */
function safeLayersFor(op: RenderOp, ctx: OpContext, build: (op: RenderOp, ctx: OpContext) => Layer[] = geoJsonLayersFor): Layer[] {
  try {
    return build(op, ctx);
  } catch (error) {
    warnFallback(op, error);
    try {
      return symbolLayers(op, ctx, Math.min(1, Math.max(0, op.opacity ?? 1)));
    } catch {
      return [];
    }
  }
}

/** The deck id prefix and the triggers every accessor of an op depends on (selection, opacity, color). */
function opIds(op: RenderOp, ctx: OpContext, opacity: number, color: string | undefined) {
  const id = `${deckLayerKey(ctx.deckId ?? op.layerId, ctx.terrain)}:${op.mode}`;
  // Color and width accessors become functions while a feature is selected, and deck only re-runs a function
  // accessor when its trigger changes, so the trigger carries everything they depend on.
  const trigger = [selectionKey(ctx.selected), opacity, color ?? ""];
  return { id, trigger };
}

/**
 * A swiped compare's line sides, for the two clipped side overlays only: Mapbox cannot clip a native line layer to one
 * side of the swipe handle, so these stay in deck (every other data line is native, lib/render/nativeLines.ts). Solid
 * in the side's color (A purple, B pink) at 2.5px over a white 4.5px casing at 0.9; the selected line purple 3.5px.
 */
function swipeLineLayers(op: RenderOp, ctx: OpContext): Layer[] {
  const { data, selected, terrain } = ctx;
  const opacity = Math.min(1, Math.max(0, op.opacity ?? 1));
  const requested = requestedColor(op.color);
  const { id, trigger } = opIds({ ...op, mode: "lines" }, ctx, opacity, requested);
  const updateTriggers = { getLineColor: trigger, getLineWidth: trigger };
  const widths = pixelWidths(ctx);
  const color = hexToRgba(requested ? lineColorFor(requested) : COMPARE_COLORS.a);
  return [
    new GeoJsonLayer({
      id: `${id}:casing`,
      data,
      pickable: false,
      filled: false,
      getLineColor: colorFor(hexToRgba(WHITE_HEX, Math.round(255 * LINE.casingOpacity)), opacity, selected, WHITE),
      getLineWidth: widthFor(LINE.casing, SELECTED_LINE.casing, selected),
      lineWidthUnits: widths.units,
      lineWidthScale: widths.scale,
      updateTriggers,
      ...terrainProps(terrain, "drape"),
    }),
    new GeoJsonLayer({
      id,
      data,
      pickable: true,
      filled: false,
      getLineColor: colorFor(color, opacity, selected, SELECT),
      getLineWidth: widthFor(LINE.width, SELECTED_LINE.width, selected),
      lineWidthUnits: widths.units,
      lineWidthScale: widths.scale,
      updateTriggers,
      ...terrainProps(terrain, "drape"),
    }),
  ];
}

/**
 * Areas (spec §11, §11a): a tint of the role color behind a 45° hatch in the same color, under an outline over a white
 * casing. Fire perimeters are pink and hatch denser for larger fires; protected land sage; other areas dark grey. The
 * selected area turns purple. Without a 2D canvas (tests) the hatch is off and the tint alone draws.
 */
function areaLayers(op: RenderOp, ctx: OpContext, opacity: number): Layer[] {
  const { data, selected, terrain } = ctx;
  const requested = requestedColor(op.color);
  const recipe = areaRecipe(op.layerId, requested);
  const { id, trigger } = opIds(op, ctx, opacity, requested);
  const widths = pixelWidths(ctx);
  const updateTriggers = {
    getLineColor: trigger,
    getFillColor: trigger,
    getLineWidth: trigger,
    getFillPattern: trigger,
    getFillPatternBackgroundColor: trigger,
  };
  const canvas = hatchAtlasCanvas();
  const colorOf = (f: Feature) => (f === selected ? SELECTED_AREA.color : recipe.color);
  const tint = perFeature((f) => hexToRgba(colorOf(f), Math.round(255 * recipe.tint)), opacity, selected);
  const hatch = perFeature((f) => hexToRgba(colorOf(f), Math.round(255 * recipe.hatchAlpha)), opacity, selected);
  const casingWidth = recipe.outlineWidth + 2 * recipe.casing;
  const sizeKey = sizeFacetKey(ctx.style);
  const sized = sizeKey ? { key: sizeKey, extent: memoExtent(data, sizeKey) } : undefined;
  return [
    new GeoJsonLayer({
      id: `${id}:casing`,
      data,
      pickable: false,
      filled: false,
      getLineColor: colorFor(WHITE, opacity, selected),
      getLineWidth: widthFor(casingWidth, SELECTED_AREA.outlineWidth + 2 * SELECTED_AREA.casing, selected),
      lineWidthUnits: widths.units,
      lineWidthScale: widths.scale,
      updateTriggers,
      ...terrainProps(terrain, "drape"),
    }),
    new GeoJsonLayer({
      id,
      data,
      pickable: true,
      filled: true,
      // With the hatch on, the fill color is the hatch line color and alpha, masked by the pattern, over the tint,
      // which deck draws as the pattern's background. Mask mode (not the atlas's own colors): a canvas uploads its
      // transparent pixels as black, and the mipmaps the drape onto 3D terrain samples then darken the hatch to maroon.
      getFillColor: canvas ? hatch : tint,
      getLineColor: colorFor(hexToRgba(recipe.outline), opacity, selected, SELECT),
      getLineWidth: widthFor(recipe.outlineWidth, SELECTED_AREA.outlineWidth, selected),
      lineWidthUnits: widths.units,
      lineWidthScale: widths.scale,
      fillPatternEnabled: Boolean(canvas),
      // Only with a canvas: deck turns the prop into a texture and throws on an explicit undefined.
      ...(canvas && { fillPatternAtlas: canvas }),
      fillPatternMapping: hatchAtlas().mapping,
      fillPatternMask: true,
      fillPatternSizeUnits: "pixels",
      getFillPattern: (f: Feature) => hatchPatternId(colorOf(f) as HatchColor, areaStep(op.layerId, recipe, f, sized)),
      getFillPatternScale: 1 / HATCH_SCALE,
      getFillPatternBackgroundColor: tint,
      updateTriggers,
      ...terrainProps(terrain, "drape", [fillExtension]),
    }),
  ];
}

/** Score areas (remoteness cells): the layer's ramp on `v` with white 1px edges at 0.8; the selected cell purple-edged. */
function scoreAreaLayers(op: RenderOp, ctx: OpContext, opacity: number): Layer[] {
  const { data, selected, terrain } = ctx;
  const requested = requestedColor(op.color);
  const { id, trigger } = opIds(op, ctx, opacity, requested);
  const widths = pixelWidths(ctx);
  const ramp = scoreRampFor(op.layerId);
  const fill = (f: Feature): Rgba => {
    const c = scoreRampColor(f.properties?.v, ramp);
    return requested ? hexToRgba(requested, c[3]) : c;
  };
  return [
    new GeoJsonLayer({
      id,
      data,
      pickable: true,
      filled: true,
      getFillColor: perFeature(fill, opacity, selected),
      getLineColor: colorFor(HEX_EDGE, opacity, selected, SELECT),
      getLineWidth: widthFor(1, SELECTED_LINE_PX, selected),
      lineWidthUnits: widths.units,
      lineWidthScale: widths.scale,
      updateTriggers: { getFillColor: trigger, getLineColor: trigger, getLineWidth: trigger },
      ...terrainProps(terrain, "drape"),
    }),
  ];
}

/**
 * Point symbols (pins.ts): a shape per layer family, centered on the point; the selected one fills purple. The
 * sprite's alpha carries the op opacity and the selection fade.
 */
function symbolLayers(op: RenderOp, { data, selected, zoom, terrain, deckId, style }: OpContext, opacity: number): Layer[] {
  const size = symbolSizePx(zoom);
  // A ranked view sizes the symbols by the layer's measure and names its top few (spec §12).
  const ranked = op.view === "ranked" ? rankedSizing(data, style) : undefined;
  return [
    new IconLayer<Feature>({
      id: `${deckLayerKey(deckId ?? op.layerId, terrain)}:points`,
      data: data.features,
      pickable: true,
      getPosition: markerPosition,
      getIcon: (f) => atlasIcon(pinIconFor(op.layerId, f, f === selected, size)),
      getSize: ranked ? (f: Feature) => SYMBOL_SIZE_PX * sizeScale(f.properties?.[ranked.key], ranked.extent) : SYMBOL_SIZE_PX,
      sizeUnits: "pixels",
      getColor: colorFor(SPRITE_TINT, opacity, selected),
      updateTriggers: {
        getColor: [selectionKey(selected), opacity],
        getIcon: [op.layerId, selectionKey(selected), size],
        getSize: [ranked?.key ?? "", ranked?.extent?.join(",") ?? ""],
      },
      // The overlay draws in deck's GlobeView, which flips the icon quads' winding; with back-face culling on,
      // deck 9.4 draws (and picks) no icons at all there. No depth test either: a symbol centered on a 3D slope had
      // its lower half buried in deck's terrain copy and read as an arch.
      parameters: { cullMode: "none", depthCompare: "always" },
      ...terrainProps(terrain, "offset", [unpremultiplySpriteExtension]),
    }),
  ];
}

/** A ranked point layer's sizing: the measure key (the size facet, else `v`), its extent, and the top features to name. */
function rankedSizing(data: GeoJSON.FeatureCollection, style: StyleHints): { key: string; extent: [number, number] | null; top: Feature[] } {
  const key = sizeFacetKey(style) ?? "v";
  return { key, extent: memoExtent(data, key), top: topFeatures(data, key, RANKED_LABELS) };
}

/** Name labels for a ranked view's top features: dark grey on a white halo, above the symbol. */
function rankedLabelLayers(op: RenderOp, { data, terrain, deckId, style }: OpContext, opacity: number): Layer[] {
  if (op.view !== "ranked" || style.geometry !== "point") return [];
  const { top, key, extent } = rankedSizing(data, style);
  const labelled = top.filter((f) => typeof f.properties?.name === "string" && f.properties.name !== "");
  if (labelled.length === 0) return [];
  return [
    new TextLayer<Feature>({
      id: `${deckLayerKey(deckId ?? op.layerId, terrain)}:points:labels`,
      data: labelled,
      pickable: false,
      getPosition: markerPosition,
      getText: (f) => String(f.properties?.name),
      getSize: 11,
      sizeUnits: "pixels",
      getPixelOffset: (f) => [0, -Math.round((SYMBOL_SIZE_PX * sizeScale(f.properties?.[key], extent)) / 2) - 8],
      getColor: hexToRgba(HEX_TILE.label, Math.round(255 * opacity)),
      characterSet: "auto",
      fontSettings: { sdf: true },
      outlineWidth: 0.3,
      outlineColor: hexToRgba(HEX_TILE.labelHalo, Math.round(230 * opacity)),
      billboard: true,
      parameters: { cullMode: "none", depthCompare: "always" },
      ...terrainProps(terrain, "offset"),
    }),
  ];
}

/**
 * Dense point layers as flat H3 tiles at a zoom-dependent resolution (owner's board, variant A): the gray ramp, white
 * 1px edges, a dark grey count on a white halo on grouped tiles. A picked tile is a `HexFeature`, so the inspect card
 * shows its count.
 */
function hexTileLayers(op: RenderOp, { data, selected: picked, zoom, terrain, deckId }: OpContext, opacity: number): Layer[] {
  // Its own id (not `:points`, the symbols' IconLayer): deck must never update one layer class in place of another.
  const id = `${deckLayerKey(deckId ?? op.layerId, terrain)}:hexbin`;
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
      getLineColor: (f) => (f === selected ? withOpacity(SELECT, opacity) : fade(f, HEX_EDGE)),
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
      getColor: (f) => fade(f, HEX_LABEL),
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontWeight: 500,
      characterSet: "0123456789.k",
      fontSettings: { sdf: true },
      outlineWidth: 0.35,
      outlineColor: HEX_LABEL_HALO,
      billboard: true,
      parameters: { cullMode: "none" },
      updateTriggers: { getColor: trigger },
      ...terrainProps(terrain, "offset"),
    }),
  ];
}

// ---- Point render modes: clusters, heat, columns (spec §11b) ----

/** Where a feature sits for clustering and binning: a Point's coordinates, else its center; null without a geometry. */
function anchorOf(f: Feature): [number, number] | null {
  if (!f.geometry) return null;
  const p = markerPosition(f);
  return validLngLat(p) ? p : null;
}

/** Supercluster settings: blobs gather points within 40 px (at Mapbox's 512 px tiles) up to z16; past it all split. */
export const CLUSTER_INDEX = { radiusPx: 40, maxZoom: 16 } as const;

type ClusterProps = { cluster: true; cluster_id: number; point_count: number };
/** One blob: supercluster's cluster feature (its center, id and how many features it holds). */
export type ClusterFeature = Feature<GeoJSON.Point, ClusterProps>;

/** One result clustered at one zoom: the blobs, the features standing alone (the originals), and the largest count. */
export type Clustered = { blobs: ClusterFeature[]; singles: GeoJSON.FeatureCollection; max: number };

type ClusterEntry = { index: Supercluster<{ i: number }, Record<string, unknown>>; byZoom: Map<number, Clustered> };
const clusterCache = new WeakMap<GeoJSON.FeatureCollection, ClusterEntry>();

function clusterEntry(data: GeoJSON.FeatureCollection): ClusterEntry {
  let entry = clusterCache.get(data);
  if (entry) return entry;
  // Supercluster gets a point per feature carrying the feature's index, so a lone point maps back to the original
  // feature object (selection is matched by reference) whatever its geometry.
  const points: Supercluster.PointFeature<{ i: number }>[] = [];
  data.features.forEach((f, i) => {
    const p = anchorOf(f);
    if (p) points.push({ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: { i } });
  });
  const index = new Supercluster<{ i: number }, Record<string, unknown>>({ radius: CLUSTER_INDEX.radiusPx, maxZoom: CLUSTER_INDEX.maxZoom });
  index.load(points);
  entry = { index, byZoom: new Map() };
  clusterCache.set(data, entry);
  return entry;
}

/**
 * Clusters a result's features at a map zoom (supercluster, whole world, cached per result and integer zoom so panning
 * and selection reuse the same objects). Features without a usable position are left out.
 */
export function clusterPoints(data: GeoJSON.FeatureCollection, zoom: number): Clustered {
  const entry = clusterEntry(data);
  const z = Math.max(0, Math.min(CLUSTER_INDEX.maxZoom + 1, Math.floor(Number.isFinite(zoom) ? zoom : 0)));
  const cached = entry.byZoom.get(z);
  if (cached) return cached;
  const blobs: ClusterFeature[] = [];
  const singles: Feature[] = [];
  for (const item of entry.index.getClusters([-180, -85, 180, 85], z)) {
    const props = item.properties as Partial<ClusterProps> & { i?: number };
    if (props.cluster === true) blobs.push(item as unknown as ClusterFeature);
    else if (typeof props.i === "number" && data.features[props.i]) singles.push(data.features[props.i]);
  }
  const max = blobs.reduce((m, b) => Math.max(m, b.properties.point_count), 2);
  const clustered = { blobs, singles: { type: "FeatureCollection", features: singles } as GeoJSON.FeatureCollection, max };
  entry.byZoom.set(z, clustered);
  return clustered;
}

/** True for a cluster blob (a click on one zooms in instead of opening the inspect card). */
export function isClusterFeature(f: unknown): f is ClusterFeature {
  const props = (f as Feature | null)?.properties;
  return props?.cluster === true && typeof props.point_count === "number";
}

/** A blob's radius in pixels: 11 px for two features, growing with the log of the count, at most 30 px. */
export function clusterRadius(count: number): number {
  return Math.min(CLUSTER_BLOB.maxPx, CLUSTER_BLOB.minPx + 4 * Math.log2(Math.max(2, count)) - 4);
}

/**
 * A blob's fill: the gray ramp from off-white (two features) toward dark grey (the largest blob), log scaled, stopping
 * at CLUSTER_BLOB.rampMax so the dark grey count on its white halo still reads on the busiest blob.
 */
export function clusterColor(count: number, max: number): Rgba {
  const t = max > 2 ? Math.min(1, Math.max(0, Math.log(count / 2) / Math.log(max / 2))) : 0;
  return rampRgba(CLUSTER_BLOB.ramp, t * CLUSTER_BLOB.rampMax, Math.round(255 * CLUSTER_BLOB.alpha));
}

const COUNT_FONT = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  characterSet: "0123456789.k",
  fontSettings: { sdf: true },
  outlineWidth: 0.35,
  billboard: true,
} as const;

/**
 * Clusters (owner's board, "blobs with counts"): circles sized by count on the gray ramp with a dark grey outline and a
 * dark grey count on a white halo; features standing alone draw as the layer's symbol (same IconLayer id as symbols
 * mode, so switching modes keeps it). Blobs are pickable: MapCanvas zooms one level in on a click.
 */
function clusterLayers(op: RenderOp, ctx: OpContext, opacity: number): Layer[] {
  const { data, selected, zoom, terrain, deckId } = ctx;
  const id = `${deckLayerKey(deckId ?? op.layerId, terrain)}:clusters`;
  const { blobs, singles, max } = clusterPoints(data, zoom);
  const fade = (c: Rgba) => withOpacity(withOpacity(c, opacity), selected ? SIBLING_FADE : 1);
  // A requested palette color (a compare side: A purple, B pink) tints the blobs and their outline, so the sides differ.
  const requested = requestedColor(op.color);
  const trigger = [selectionKey(selected), opacity, max, requested ?? ""];
  const outline = hexToRgba(requested ?? CLUSTER_BLOB.outline);
  const fill = (count: number): Rgba => {
    if (!requested) return clusterColor(count, max);
    const t = max > 2 ? Math.min(1, Math.max(0, Math.log(count / 2) / Math.log(max / 2))) : 0;
    return hexToRgba(requested, Math.round(255 * CLUSTER_BLOB.alpha * (0.45 + 0.55 * t)));
  };
  return [
    new ScatterplotLayer<ClusterFeature>({
      id,
      data: blobs,
      pickable: true,
      getPosition: (f) => f.geometry.coordinates as [number, number],
      getRadius: (f) => clusterRadius(f.properties.point_count),
      radiusUnits: "pixels",
      filled: true,
      stroked: true,
      getFillColor: (f) => fade(fill(f.properties.point_count)),
      getLineColor: fade(outline),
      getLineWidth: CLUSTER_BLOB.outlinePx,
      lineWidthUnits: "pixels",
      billboard: true,
      // Billboards over the terrain copy: never let the slope behind a blob cut it in half.
      parameters: { cullMode: "none", depthCompare: "always" },
      updateTriggers: { getFillColor: trigger, getLineColor: trigger },
      ...terrainProps(terrain, "offset"),
    }),
    new TextLayer<ClusterFeature>({
      id: `${id}:labels`,
      data: blobs,
      pickable: false,
      getPosition: (f) => f.geometry.coordinates as [number, number],
      getText: (f) => countLabel(f.properties.point_count),
      getSize: CLUSTER_BLOB.labelSize,
      sizeUnits: "pixels",
      getColor: fade(hexToRgba(CLUSTER_BLOB.label)),
      fontWeight: 600,
      ...COUNT_FONT,
      // A wider white halo than the hex counts: the busiest blobs are dark grey under a dark grey count.
      outlineWidth: 0.7,
      fontSettings: { sdf: true, buffer: 6 },
      outlineColor: hexToRgba(CLUSTER_BLOB.labelHalo, 240),
      parameters: { cullMode: "none", depthCompare: "always" },
      updateTriggers: { getColor: trigger },
      ...terrainProps(terrain, "offset"),
    }),
    ...symbolLayers(op, { ...ctx, data: singles }, opacity),
  ];
}

/** Heat mode: only the clicked feature, as its symbol, so the inspect card has something on the map to point at. */
function heatSelectionLayers(op: RenderOp, ctx: OpContext, opacity: number): Layer[] {
  const { selected, terrain, deckId } = ctx;
  if (!selected || !ctx.data.features.includes(selected)) return [];
  const size = symbolSizePx(ctx.zoom);
  return [
    new IconLayer<Feature>({
      id: `${deckLayerKey(deckId ?? op.layerId, terrain)}:heat`,
      data: [selected],
      pickable: true,
      getPosition: markerPosition,
      getIcon: (f) => atlasIcon(pinIconFor(op.layerId, f, true, size)),
      getSize: SYMBOL_SIZE_PX,
      sizeUnits: "pixels",
      getColor: withOpacity(SPRITE_TINT, opacity),
      parameters: { cullMode: "none", depthCompare: "always" },
      ...terrainProps(terrain, "offset", [unpremultiplySpriteExtension]),
    }),
  ];
}

/** The tallest column stands this many H3 edge lengths high at its resolution (so it scales with zoom). */
export const COLUMN_HEIGHT_EDGES = 3;
/**
 * Columns bin one H3 resolution finer than the flat tiles: a tiled cell reads at a glance, but the same cell stood up
 * in 3D filled a pitched view.
 */
export function columnResolution(zoom: number): number {
  return Math.min(15, hexResolution(zoom) + 1);
}
/** How many named features a column's inspect card lists. */
const COLUMN_TOP = 3;

type ColumnProps = { name: string; count: number; h3: string; top?: string; v?: number; tallest: boolean; aggregate: true };
/** One extruded H3 cell: its outline, how many features (and how much `v`) fell in it, and the most common names. */
export type ColumnFeature = Feature<GeoJSON.Polygon, ColumnProps>;

/** One result stacked at one resolution: the cells, their caps, the tallest cell's value and its label. */
export type Columned = {
  cells: GeoJSON.FeatureCollection<GeoJSON.Polygon, ColumnProps>;
  caps: GeoJSON.FeatureCollection;
  max: number;
  heightM: number;
  label: { position: [number, number, number]; text: string }[];
};

const columnCache = new WeakMap<GeoJSON.FeatureCollection, Map<string, Columned>>();

/** A feature's display name for a column's top list. */
function nameOf(f: Feature): string | null {
  const p = f.properties ?? {};
  for (const key of ["name", "common_name", "species", "title"]) {
    const v = p[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** A cell's value: its feature count, or the sum of positive numeric `v` when columns stand by value. */
function columnValue(cell: { count: number; sum: number }, by: "v" | "count"): number {
  return by === "v" ? cell.sum : cell.count;
}

/** A ring lifted to height `z` (meters), a hair above the column top so the cap never z-fights with it. */
function liftRing(ring: GeoJSON.Position[], z: number): GeoJSON.Position[] {
  return ring.map(([lng, lat]) => [lng, lat, z * 1.002 + 2]);
}

/**
 * Bins a result's features into H3 cells at `resolution` and stacks them (cached per result, resolution and `by`):
 * height is the count (or the sum of `v`) over the tallest cell's, times COLUMN_HEIGHT_EDGES edge lengths.
 */
export function hexColumns(data: GeoJSON.FeatureCollection, resolution: number, by: "v" | "count"): Columned {
  let byKey = columnCache.get(data);
  if (!byKey) {
    byKey = new Map();
    columnCache.set(data, byKey);
  }
  const key = `${resolution}:${by}`;
  const cached = byKey.get(key);
  if (cached) return cached;
  const cells = new Map<string, { count: number; sum: number; names: Map<string, number> }>();
  for (const f of data.features) {
    const p = anchorOf(f);
    if (!p) continue;
    const h3 = latLngToCell(p[1], p[0], resolution);
    let cell = cells.get(h3);
    if (!cell) {
      cell = { count: 0, sum: 0, names: new Map() };
      cells.set(h3, cell);
    }
    cell.count++;
    const v = Number(f.properties?.v);
    if (Number.isFinite(v) && v > 0) cell.sum += v;
    const name = nameOf(f);
    if (name) cell.names.set(name, (cell.names.get(name) ?? 0) + 1);
  }
  let max = 0;
  for (const cell of cells.values()) max = Math.max(max, columnValue(cell, by));
  const heightM = getHexagonEdgeLengthAvg(resolution, UNITS.m) * COLUMN_HEIGHT_EDGES;
  const features: ColumnFeature[] = [];
  const caps: Feature[] = [];
  const label: Columned["label"] = [];
  for (const [h3, cell] of cells) {
    const value = columnValue(cell, by);
    const ring = cellToBoundary(h3, true);
    const top = [...cell.names]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, COLUMN_TOP)
      .map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
      .join(", ");
    // Every cell tied for the top takes purple (and its value), not just the first one found.
    const isTallest = max > 0 && value === max;
    const properties: ColumnProps = {
      name: `${cell.count.toLocaleString("en-US")} ${cell.count === 1 ? "feature" : "features"} in this cell`,
      count: cell.count,
      h3,
      tallest: isTallest,
      aggregate: true,
      ...(top && { top }),
      ...(by === "v" && { v: Math.round(cell.sum * 100) / 100 }),
    };
    features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties });
    const z = (value / (max || 1)) * heightM;
    caps.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [liftRing(ring, z)] }, properties: { tallest: isTallest } });
    if (isTallest) {
      const [lat, lng] = cellToLatLng(h3);
      label.push({ position: [lng, lat, z + heightM * 0.04 + 40], text: countLabel(Math.round(value)) });
    }
  }
  const entry: Columned = {
    cells: { type: "FeatureCollection", features },
    caps: { type: "FeatureCollection", features: caps },
    max,
    heightM,
    label,
  };
  byKey.set(key, entry);
  return entry;
}

/** A column's wall: purple for the tallest, else translucent white by height third (COLUMN_WALL_ALPHAS). */
export function columnWallColor(value: number, max: number, tallest: boolean): Rgba {
  if (tallest) return hexToRgba(HEX_COLUMN.top, Math.round(255 * HEX_COLUMN.topWallAlpha));
  const t = max > 0 ? value / max : 0;
  const [high, mid, low] = COLUMN_WALL_ALPHAS;
  return hexToRgba(HEX_COLUMN.wall, Math.round(255 * (t > 2 / 3 ? high : t > 1 / 3 ? mid : low)));
}

const COLUMN_EDGE = hexToRgba(HEX_COLUMN.edge, Math.round(255 * HEX_COLUMN.edgeAlpha));

/**
 * The three layers of a column set (owner's board, 3D C): translucent walls with dark grey edges, white caps outlined
 * in dark grey (the tallest purple), and the tallest column's value. All stand on deck's terrain copy by their own
 * vertices (offset mode) while 3D terrain is on, so walls and caps stay together on slopes.
 */
function columnSet(
  id: string,
  cells: GeoJSON.FeatureCollection,
  caps: GeoJSON.FeatureCollection,
  label: Columned["label"],
  height: (f: Feature) => number,
  wall: (f: Feature) => Rgba,
  { selected, terrain }: OpContext,
  opacity: number,
  wireframe = true,
): Layer[] {
  const c = HEX_COLUMN;
  const alpha = (a: number) => Math.round(255 * a);
  const fade = (f: Feature, color: Rgba) => {
    const base = withOpacity(color, opacity);
    return selected && f !== selected ? withOpacity(base, SIBLING_FADE) : base;
  };
  const trigger = [selectionKey(selected), opacity];
  const isTop = (f: Feature) => f.properties?.tallest === true;
  return [
    new GeoJsonLayer({
      id,
      data: cells,
      pickable: true,
      extruded: true,
      // Hex columns show their six edges; a detailed area (a fire perimeter) would draw a dark line at every vertex.
      wireframe,
      getElevation: height,
      getFillColor: (f: Feature) => (f === selected ? withOpacity(hexToRgba(c.top, alpha(c.topWallAlpha)), opacity) : fade(f, wall(f))),
      getLineColor: (f: Feature) => fade(f, COLUMN_EDGE),
      getLineWidth: 1,
      lineWidthUnits: "pixels",
      // Unlit: the walls keep the palette's white at their alpha, with no shading.
      material: false,
      updateTriggers: { getFillColor: trigger, getLineColor: trigger },
      ...terrainProps(terrain, "offset"),
    }),
    new GeoJsonLayer({
      id: `${id}:caps`,
      data: caps,
      pickable: false,
      filled: true,
      stroked: true,
      getFillColor: (f: Feature) => withOpacity(isTop(f) ? hexToRgba(c.top, alpha(c.topCapAlpha)) : hexToRgba(c.cap, alpha(c.capAlpha)), opacity * (selected ? SIBLING_FADE : 1)),
      getLineColor: (f: Feature) => withOpacity(isTop(f) ? hexToRgba(c.top) : hexToRgba(c.capOutline), opacity),
      getLineWidth: c.capOutlinePx,
      lineWidthUnits: "pixels",
      updateTriggers: { getFillColor: trigger, getLineColor: trigger },
      ...terrainProps(terrain, "offset"),
    }),
    new TextLayer<{ position: [number, number, number]; text: string }>({
      id: `${id}:label`,
      data: label,
      pickable: false,
      getPosition: (d) => d.position,
      getText: (d) => d.text,
      getSize: HEX_TILE.labelSize + 1,
      sizeUnits: "pixels",
      getColor: withOpacity(hexToRgba(c.label), opacity),
      fontWeight: 600,
      ...COUNT_FONT,
      outlineColor: hexToRgba(c.labelHalo, 230),
      parameters: { cullMode: "none", depthCompare: "always" },
      ...terrainProps(terrain, "offset"),
    }),
  ];
}

/**
 * Point columns (3D only): the layer's features stacked into H3 cells at the zoom's resolution, as tall as the count
 * (style `extrude: "count"`, the default) or the sum of `v` (`extrude: "v"`). A picked column is a ColumnFeature: the
 * inspect card shows its count and most common names.
 */
function columnLayers(op: RenderOp, ctx: OpContext, opacity: number): Layer[] {
  const by = ctx.style.extrude === "v" ? "v" : "count";
  const { cells, caps, max, heightM, label } = hexColumns(ctx.data, columnResolution(ctx.zoom), by);
  const valueOf = (f: Feature) => (by === "v" ? Number(f.properties?.v) || 0 : Number(f.properties?.count) || 0);
  const selected = ctx.selected && cells.features.includes(ctx.selected as ColumnFeature) ? ctx.selected : undefined;
  return columnSet(
    `${deckLayerKey(ctx.deckId ?? op.layerId, ctx.terrain)}:columns`,
    cells,
    caps,
    label,
    (f) => (valueOf(f) / (max || 1)) * heightM,
    (f) => columnWallColor(valueOf(f), max, f.properties?.tallest === true),
    { ...ctx, selected },
    opacity,
  );
}

/** Extruded areas: the tallest stands this share of the data's diagonal, within these bounds in meters. */
export const AREA_EXTRUDE = { share: 0.12, minM: 1500, maxM: 30000 } as const;

type ExtrudedAreas = { caps: GeoJSON.FeatureCollection; max: number; heightM: number; tops: Set<Feature>; label: Columned["label"] };
const extrudeCache = new WeakMap<GeoJSON.FeatureCollection, ExtrudedAreas>();

const positiveV = (f: Feature) => {
  const v = Number(f.properties?.v);
  return Number.isFinite(v) && v > 0 ? v : 0;
};

function extrudedAreas(data: GeoJSON.FeatureCollection): ExtrudedAreas {
  const cached = extrudeCache.get(data);
  if (cached) return cached;
  let max = 0;
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of data.features) {
    max = Math.max(max, positiveV(f));
    const b = featureBBox(f);
    if (b) [w, s, e, n] = [Math.min(w, b[0]), Math.min(s, b[1]), Math.max(e, b[2]), Math.max(n, b[3])];
  }
  const lat = Number.isFinite(s) ? (((s + n) / 2) * Math.PI) / 180 : 0;
  const diag = Number.isFinite(w) ? Math.hypot((e - w) * 111_320 * Math.cos(lat), (n - s) * 110_540) : 0;
  const heightM = Math.min(AREA_EXTRUDE.maxM, Math.max(AREA_EXTRUDE.minM, diag * AREA_EXTRUDE.share));
  const z = (f: Feature) => (positiveV(f) / (max || 1)) * heightM;
  // Every area tied for the largest value takes purple and its number.
  const tops = new Set(max > 0 ? data.features.filter((f) => positiveV(f) === max) : []);
  const caps = data.features.flatMap((f): Feature[] => {
    const g = f.geometry;
    const tallest = tops.has(f);
    if (g?.type === "Polygon") return [{ type: "Feature", geometry: { type: "Polygon", coordinates: g.coordinates.map((r) => liftRing(r, z(f))) }, properties: { tallest } }];
    if (g?.type === "MultiPolygon") {
      const coordinates = g.coordinates.map((poly) => poly.map((r) => liftRing(r, z(f))));
      return [{ type: "Feature", geometry: { type: "MultiPolygon", coordinates }, properties: { tallest } }];
    }
    return [];
  });
  const label: Columned["label"] = [...tops].flatMap((top) => {
    const center = featureCenter(top);
    return center ? [{ position: [center[0], center[1], z(top) + heightM * 0.04 + 40] as [number, number, number], text: countLabel(Math.round(max)) }] : [];
  });
  const entry = { caps: { type: "FeatureCollection", features: caps } as GeoJSON.FeatureCollection, max, heightM, tops, label };
  extrudeCache.set(data, entry);
  return entry;
}

/**
 * Areas extruded by `v` (glaciers, fire perimeters by acres when asked; 3D only): the same translucent treatment as
 * the point columns, the largest value purple with its number. Picks return the real feature for the inspect card.
 */
function extrudedAreaLayers(op: RenderOp, ctx: OpContext, opacity: number): Layer[] {
  const { caps, max, heightM, tops, label } = extrudedAreas(ctx.data);
  return columnSet(
    `${deckLayerKey(ctx.deckId ?? op.layerId, ctx.terrain)}:columns`,
    ctx.data,
    caps,
    label,
    (f) => (positiveV(f) / (max || 1)) * heightM,
    (f) => columnWallColor(positiveV(f), max, tops.has(f)),
    ctx,
    opacity,
    false,
  );
}

// ---- Compare delta (spec §7, palette §11) ----

const DELTA_RGB = {
  "a-only": hexToRgba(DELTA_COLORS["a-only"]),
  "b-only": hexToRgba(DELTA_COLORS["b-only"]),
  both: hexToRgba(DELTA_COLORS.both),
} as const;

/** Delta strokes: 1.5px outlines and 2.5px lines in the class color over a 1px white casing a side; points 5px discs. */
export const DELTA_STROKE = { polygon: 1.5, line: 2.5, casing: 1, pointRadius: 5 } as const;
/** Hex delta columns: the largest |B − A| stands this many meters tall. */
export const HEX_DELTA = { maxHeightM: 4000 } as const;

/** The class color for a delta feature (a-only pink, b-only purple, both dark grey); unknown reads as both. */
export function deltaColor(f: Feature): Rgba {
  const cls: unknown = f.properties?.delta;
  return cls === "a-only" || cls === "b-only" ? DELTA_RGB[cls] : DELTA_RGB.both;
}

function isArea(f: Feature): boolean {
  const t = f.geometry?.type;
  return t === "Polygon" || t === "MultiPolygon";
}

/** The hatch density of a change view's lost areas (index into HATCH_SPACINGS: 6 px). */
export const DELTA_HATCH_STEP = 2;

const lostMemo = new WeakMap<GeoJSON.FeatureCollection, GeoJSON.FeatureCollection>();
/** A delta's A-only areas (what was lost), made once per collection. */
export function lostAreas(data: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
  let out = lostMemo.get(data);
  if (!out) {
    out = { type: "FeatureCollection", features: data.features.filter((f) => f.properties?.delta === "a-only" && isArea(f)) };
    lostMemo.set(data, out);
  }
  return out;
}

/** Per hex delta collection: the largest |v|, the tallest cell, and each cell's cap lifted to its column height. */
type Columns = { max: number; top: Feature | undefined; caps: Feature[] };
const columnsCache = new WeakMap<GeoJSON.FeatureCollection, Columns>();

const absV = (f: Feature) => Math.abs(Number(f.properties?.v) || 0);

function columnsOf(data: GeoJSON.FeatureCollection): Columns {
  let entry = columnsCache.get(data);
  if (entry) return entry;
  let max = 0;
  let top: Feature | undefined;
  for (const f of data.features) {
    if (absV(f) > max) {
      max = absV(f);
      top = f;
    }
  }
  const height = (f: Feature) => (absV(f) / (max || 1)) * HEX_DELTA.maxHeightM;
  // Caps sit a hair above the column tops so they never z-fight with them.
  const caps = data.features.flatMap((f): Feature[] => {
    if (f.geometry?.type !== "Polygon") return [];
    const z = height(f) * 1.002 + 2;
    const rings = f.geometry.coordinates.map((ring) => ring.map(([lng, lat]) => [lng, lat, z]));
    return [{ type: "Feature", geometry: { type: "Polygon", coordinates: rings }, properties: { ...f.properties, top: f === top } }];
  });
  entry = { max, top, caps };
  columnsCache.set(data, entry);
  return entry;
}

/**
 * The compared layer in delta mode: each feature stroked in its class color (A only purple, B only pink, both dark
 * grey) over a white casing, areas filled at 12% of it, points as solid discs. H3 cells extrude instead (owner's
 * board, columns variant C): height is |B − A| (tallest = 4,000 m), translucent white walls with dark grey edges and
 * white caps outlined in dark grey; only the tallest column takes purple, with its value.
 */
/** A delta collection without its lines (Mapbox strokes those: lib/render/nativeLines.ts), made once per collection. */
const withoutLinesMemo = new WeakMap<GeoJSON.FeatureCollection, GeoJSON.FeatureCollection>();
function withoutLines(data: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
  let out = withoutLinesMemo.get(data);
  if (!out) {
    const kept = data.features.filter((f) => !isLineGeometry(f.geometry));
    out = kept.length === data.features.length ? data : { ...data, features: kept };
    withoutLinesMemo.set(data, out);
  }
  return out;
}

function deltaLayers(op: RenderOp, { data: all, selected, terrain }: OpContext): Layer[] {
  const opacity = Math.min(1, Math.max(0, op.opacity ?? 1));
  const id = `${deckLayerKey(op.layerId, terrain)}:${op.mode}`;
  const fade = (f: Feature, c: Rgba): Rgba => {
    const base = withOpacity(c, opacity);
    return selected && f !== selected ? withOpacity(base, SIBLING_FADE) : base;
  };
  const trigger = [selectionKey(selected), opacity];
  if (isHexCollection(all)) {
    const data = all;
    const { max, top, caps } = columnsOf(data);
    const c = HEX_COLUMN;
    const alpha = (a: number) => Math.round(255 * a);
    const isTop = (f: Feature) => f === top || f.properties?.top === true;
    // No terrain extension on these columns, so no 3D tag on the id either. Their own tag keeps them off the flat
    // H3HexagonLayer's id (`<id>:points` while 3D is off): deck must not update one layer class in place of another.
    const columnsId = `${op.layerId}${HEX_DELTA_TAG}:${op.mode}`;
    const label = top
      ? [{ position: [...(featureCenter(top) ?? [0, 0]), (absV(top) / (max || 1)) * HEX_DELTA.maxHeightM + 60], text: countLabel(Math.round(absV(top))) }]
      : [];
    return [
      new GeoJsonLayer({
        id: columnsId,
        data,
        pickable: true,
        extruded: true,
        wireframe: true,
        getElevation: (f: Feature) => (absV(f) / (max || 1)) * HEX_DELTA.maxHeightM,
        getFillColor: (f: Feature) => fade(f, isTop(f) ? hexToRgba(c.top, alpha(c.topWallAlpha)) : hexToRgba(c.wall, alpha(c.wallAlpha))),
        getLineColor: (f: Feature) => fade(f, hexToRgba(c.edge, alpha(c.edgeAlpha))),
        lineWidthUnits: "pixels",
        getLineWidth: 1,
        material: false,
        updateTriggers: { getFillColor: trigger, getLineColor: trigger },
      }),
      new GeoJsonLayer({
        id: `${columnsId}:caps`,
        data: { type: "FeatureCollection", features: caps } as GeoJSON.FeatureCollection,
        pickable: false,
        filled: true,
        stroked: true,
        getFillColor: (f: Feature) => withOpacity(isTop(f) ? hexToRgba(c.top, alpha(c.topCapAlpha)) : hexToRgba(c.cap, alpha(c.capAlpha)), opacity),
        getLineColor: (f: Feature) => withOpacity(isTop(f) ? hexToRgba(c.top) : hexToRgba(c.capOutline), opacity),
        getLineWidth: c.capOutlinePx,
        lineWidthUnits: "pixels",
        updateTriggers: { getFillColor: trigger, getLineColor: trigger },
      }),
      new TextLayer<{ position: number[]; text: string }>({
        id: `${columnsId}:label`,
        data: label,
        pickable: false,
        getPosition: (d) => d.position as [number, number, number],
        getText: (d) => d.text,
        getSize: HEX_TILE.labelSize + 1,
        sizeUnits: "pixels",
        getColor: hexToRgba(c.label),
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontWeight: 600,
        characterSet: "0123456789.k",
        fontSettings: { sdf: true },
        outlineWidth: 0.35,
        outlineColor: hexToRgba(c.labelHalo, 230),
        billboard: true,
        parameters: { cullMode: "none", depthCompare: "always" },
      }),
    ];
  }
  // Delta lines are native Mapbox lines (lib/render/nativeLines.ts); deck keeps the areas and points.
  const data = withoutLines(all);
  if (data.features.length === 0) return [];
  const updateTriggers = { getFillColor: trigger, getLineColor: trigger, getLineWidth: trigger };
  const strokeWidth = (f: Feature) => (isArea(f) ? DELTA_STROKE.polygon : DELTA_STROKE.line);
  // What only A had (lost) carries a pink hatch over its tint (spec §12), so it reads as gone on any basemap.
  const canvas = hatchAtlasCanvas();
  const lost = lostAreas(data);
  const hatch: Layer[] =
    canvas && lost.features.length > 0
      ? [
          new GeoJsonLayer({
            id: `${id}:lost`,
            data: lost,
            pickable: false,
            filled: true,
            stroked: false,
            getFillColor: (f: Feature) => fade(f, hexToRgba(PINK, 230)),
            fillPatternEnabled: true,
            fillPatternAtlas: canvas,
            fillPatternMapping: hatchAtlas().mapping,
            fillPatternMask: true,
            fillPatternSizeUnits: "pixels",
            getFillPattern: () => hatchPatternId(PINK as HatchColor, DELTA_HATCH_STEP),
            getFillPatternScale: 1 / HATCH_SCALE,
            getFillPatternBackgroundColor: [0, 0, 0, 0],
            updateTriggers: { getFillColor: trigger },
            ...terrainProps(terrain, "drape", [fillExtension]),
          }),
        ]
      : [];
  return [
    ...hatch,
    new GeoJsonLayer({
      id: `${id}:casing`,
      data,
      pickable: false,
      filled: false,
      pointType: "circle",
      getLineColor: (f: Feature) => fade(f, WHITE),
      getLineWidth: (f: Feature) => strokeWidth(f) + 2 * DELTA_STROKE.casing,
      lineWidthUnits: "pixels",
      getPointRadius: DELTA_STROKE.pointRadius + DELTA_STROKE.casing,
      pointRadiusUnits: "pixels",
      updateTriggers,
      ...terrainProps(terrain, "drape"),
    }),
    new GeoJsonLayer({
      id,
      data,
      pickable: true,
      pointType: "circle",
      getFillColor: (f: Feature) => fade(f, isArea(f) ? withOpacity(deltaColor(f), DELTA_FILL_ALPHA) : deltaColor(f)),
      getLineColor: (f: Feature) => fade(f, deltaColor(f)),
      getLineWidth: (f: Feature) => (f === selected ? strokeWidth(f) + 1 : strokeWidth(f)),
      lineWidthUnits: "pixels",
      getPointRadius: DELTA_STROKE.pointRadius,
      pointRadiusUnits: "pixels",
      updateTriggers,
      ...terrainProps(terrain, "drape"),
    }),
  ];
}

/** A material that leaves colors as they are: full ambient, no diffuse or specular light. */
export const UNLIT = { ambient: 1, diffuse: 0, shininess: 1, specularColor: [0, 0, 0] as [number, number, number] };

/**
 * Un-premultiplies the terrain mesh's output. The mesh shows the draped cover, which deck stores premultiplied, and
 * then blends it by its alpha once more, so every translucent draped color came out multiplied by its alpha twice: a
 * 15% pink tint drew as a 15% darkening and fire read maroon on 3D terrain. Dividing by alpha at the end of the mesh's
 * fragment shader restores the color; picking colors are left alone.
 */
export class UnpremultiplyExtension extends LayerExtension {
  static extensionName = "UnpremultiplyExtension";
  getShaders() {
    return {
      inject: {
        "fs:#main-end": "if (fragColor.a > 0.0 && !bool(picking.isActive)) fragColor.rgb /= fragColor.a;",
      },
    };
  }
}
const unpremultiplyExtension = new UnpremultiplyExtension();

/**
 * Deck's invisible copy of the map's terrain: a TerrainLayer over the same DEM, drawn fully transparent so only
 * the draped data layers show, and read by the TerrainExtension to stand pins on the slopes.
 */
/** Deck's terrain tiles that fail (sea tiles the DEM does not have) are skipped quietly. */
export function ignoreTileError(): void {}

function terrainSourceLayer(token: string): Layer {
  return new TerrainLayer({
    id: DECK_TERRAIN_ID,
    elevationData: demTileUrl(token),
    elevationDecoder: demDecoder(),
    tileSize: 512,
    maxZoom: 14,
    // Transparent mesh: the draped layers' cover is all that reaches the screen.
    color: [0, 0, 0, 0],
    // Unlit: deck lights the mesh even with `material: false`, which shades the draped cover by slope and turned the
    // fire tint maroon. Full ambient and nothing else passes the cover's colors through unchanged.
    material: UNLIT,
    operation: "terrain+draw",
    pickable: false,
    // The DEM has no tiles over open ocean, so every sea tile 404s. Mapbox's terrain reads a missing tile as sea level;
    // here it just leaves that tile flat-less, and deck's default handler would log a FetchError for each one.
    onTileError: ignoreTileError,
    // Same GlobeView winding flip as the pins: with back-face culling on, deck draws no terrain mesh at all.
    parameters: { cullMode: "none" },
    extensions: [unpremultiplyExtension],
  });
}

/** Literal `process.env.NEXT_PUBLIC_*` access so Next inlines it into the client bundle. */
const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN?.trim() ?? "";

/**
 * Deck layers in three sets. `main` is everything the map overlay draws, bottom first (the terrain copy, then each
 * visible GeoJSON render op; Mapbox draws the heatmap of a heat op, deck only its clicked feature's symbol). While a compare swipes, the compared layer's two
 * sides go to `a` and `b` instead (each with its own terrain copy), for the two clipped side overlays MapCanvas lays
 * over the map; otherwise both are empty. In toggle mode both sides stay in `main` and the side not showing is hidden
 * (not removed, so its buffers stay on the GPU for the next flip). Delta draws the delta collection by class.
 */
export function buildDeckLayerSets(
  state: MapState,
  { mapboxToken = MAPBOX_TOKEN }: { mapboxToken?: string } = {},
): { main: Layer[]; a: Layer[]; b: Layer[] } {
  const main: Layer[] = [];
  const a: Layer[] = [];
  const b: Layer[] = [];
  // 3D terrain on the map means deck needs its own copy of the surface to drape on (see deckTerrain.ts).
  const terrain = state.terrain && !state.flattened && mapboxToken !== "";
  if (terrain) main.push(terrainSourceLayer(mapboxToken));
  const compare = state.compare;
  const mode = effectiveMode(state);
  for (const op of state.renderOps) {
    if (!op.visible) continue;
    const loaded = state.layers[op.layerId];
    if (!loaded) continue;
    if (loaded.result.kind === "tiles") continue;
    const picked = state.selected?.layerId === op.layerId ? state.selected : undefined;
    // A feature picked on a compare's side B highlights there; side A (and every other mode) gets the rest.
    const selected = picked && picked.side !== "b" ? picked.feature : undefined;
    const selectedB = picked?.side === "b" ? picked.feature : undefined;
    const ctx: OpContext = {
      data: loaded.result.data,
      style: loaded.style,
      selected,
      zoom: state.viewport.zoom,
      latitude: state.viewport.latitude,
      terrain,
      threeD: state.terrain && !state.flattened,
    };
    if (compare?.layerId !== op.layerId || !mode) {
      main.push(...safeLayersFor(op, ctx));
      continue;
    }
    if (mode === "delta") {
      main.push(...safeLayersFor(op, ctx, deltaLayers));
      continue;
    }
    // Each side draws in its compare color (A purple, B pink: palette §11), in place of the layer's own stroke. Heat
    // is Mapbox's and cannot be clipped to one side of the handle, so a swiped heat layer draws its sides as points
    // (a toggle keeps the heat: components/mapTiles.ts gives each side its own heatmap).
    const sideMode = mode === "swipe" && op.mode === "heat" ? "points" : op.mode;
    // Toggled lines are native Mapbox layers (lib/render/nativeLines.ts); swiped lines stay in deck, which can clip.
    const nativeLines = drawsNativeLines(op, loaded.style);
    if (nativeLines && mode !== "swipe") continue;
    const build = nativeLines ? swipeLineLayers : geoJsonLayersFor;
    const sideA = safeLayersFor({ ...op, mode: sideMode, color: COMPARE_COLORS.a }, ctx, build);
    const bId = compareBId(op.layerId);
    const loadedB = state.layers[bId];
    const sideB =
      loadedB?.result.kind === "geojson"
        ? safeLayersFor(
            { ...op, mode: sideMode, color: COMPARE_COLORS.b },
            { ...ctx, data: loadedB.result.data, selected: selectedB, deckId: bId },
            build,
          )
        : [];
    if (mode === "swipe") {
      a.push(...sideA);
      b.push(...sideB);
      continue;
    }
    // Toggle: both sides stay built; the one not showing is hidden.
    const shownA = compareSideShown(state, op.layerId);
    const shownB = compareSideShown(state, bId);
    main.push(...sideA.map((l) => (shownA ? l : l.clone({ visible: false }))));
    main.push(...sideB.map((l) => (shownB ? l : l.clone({ visible: false }))));
  }
  if (terrain && a.length > 0) a.unshift(terrainSourceLayer(mapboxToken));
  if (terrain && b.length > 0) b.unshift(terrainSourceLayer(mapboxToken));
  return { main, a, b };
}

/**
 * Turns map state into deck.gl layer instances for each visible geojson render op (lines bring a casing), as one
 * list: `buildDeckLayerSets`' main set plus any swipe sides (without their own terrain copies). Heat ops yield only
 * their clicked feature's symbol here; Mapbox draws the heatmap.
 */
export function buildDeckLayers(state: MapState, options: { mapboxToken?: string } = {}): Layer[] {
  const { main, a, b } = buildDeckLayerSets(state, options);
  const sides = [...a, ...b].filter((l) => l.id !== DECK_TERRAIN_ID);
  return sides.length > 0 ? [...main, ...sides] : main;
}
