import { LayerExtension, type Layer } from "@deck.gl/core";
import { FillStyleExtension, PathStyleExtension, _TerrainExtension as TerrainExtension } from "@deck.gl/extensions";
import { H3HexagonLayer, TerrainLayer } from "@deck.gl/geo-layers";
import { GeoJsonLayer, IconLayer, TextLayer } from "@deck.gl/layers";
import { WebMercatorViewport } from "@math.gl/web-mercator";
import type { Feature } from "geojson";
import { cellToLatLng, latLngToCell } from "h3-js";
import type { BBox, StyleHints } from "@/layers/types";
import {
  areaRecipe,
  COMPARE_COLORS,
  DARK_GREY,
  HEX_COLUMN,
  HEX_TILE,
  isPaletteColor,
  LINE,
  LINE_CLASSES,
  lineClassFor,
  PURPLE,
  scoreRampFor,
  SELECTED_AREA,
  TRAIL_LINE,
  WHITE as WHITE_HEX,
  type AreaRecipe,
  type HatchColor,
  type RampName,
} from "@/lib/render/palette";
import { acresStep, HATCH_SCALE, hatchAtlas, hatchAtlasCanvas, hatchPatternId } from "@/lib/render/hatch";
import { hexToRgb, rampColor } from "@/lib/render/ramp";
import { compareBId, compareSideShown, DELTA_FILL_ALPHA, effectiveMode, isHexCollection } from "@/lib/render/compareView";
import { DECK_TERRAIN_ID, DECK_TERRAIN_TAG, demDecoder, demTileUrl } from "@/lib/render/wally/deckTerrain";
import { featureCenter, HEX_DELTA_TAG } from "@/lib/render/inspect";
import { pinIconFor } from "@/lib/render/wally/pins";
import type { MapState, RenderOp, Viewport } from "@/lib/render/state";

type Rgba = [number, number, number, number];

/** Parses `#rgb` or `#rrggbb` into an RGBA tuple for deck.gl. */
export function hexToRgba(hex: string, alpha = 255): Rgba {
  return [...hexToRgb(hex), alpha];
}

const WHITE = hexToRgba(WHITE_HEX);
const GREY = hexToRgba(DARK_GREY);
const SELECT = hexToRgba(PURPLE);
/** Sprites draw their own colors; their tint only carries alpha (opacity and the selection fade). */
const SPRITE_TINT = WHITE;

/** Selected lines: TRAIL_LINE.selected (purple, 3.5px) over a white casing 1px a side wider than the line's. */
export const SELECTED_LINE = { width: TRAIL_LINE.selected.width, casing: TRAIL_LINE.selected.width + 2 } as const;
/** Selected tiles take a 2.5px purple outline. */
export const SELECTED_LINE_PX = 2.5;
/** While a feature is selected, the rest of its layer fades to this share of its alpha. */
export const SIBLING_FADE = 0.35;

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

const dashExtension = new PathStyleExtension({ dash: true });
const fillExtension = new FillStyleExtension({ pattern: true });
const terrainExtension = new TerrainExtension();
type LayerExtensionLike = PathStyleExtension | FillStyleExtension | TerrainExtension;

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
  /** Deck's terrain layer is in the stack: drape and offset this op's layers on it. */
  terrain: boolean;
  /** The id this op's deck layers are named after, when not the op's layer id (compare side B). */
  deckId?: string;
};

/** A palette color asked for by the layer panel or a compare side; anything else is ignored (palette only). */
function requestedColor(color: string | undefined): string | undefined {
  return isPaletteColor(color) ? color.trim().toUpperCase() : undefined;
}

/** The hatch density step for one area feature: fires by burned acres, others the recipe's fixed step. */
function areaStep(layerId: string, recipe: AreaRecipe, f: Feature): number {
  return layerId === "fire-perimeters" ? acresStep(f.properties?.acres ?? f.properties?.v) : recipe.step;
}

/** The deck layers for one render op, bottom first (lines and areas add a white casing beneath). */
function geoJsonLayersFor(op: RenderOp, ctx: OpContext): Layer[] {
  const opacity = Math.min(1, Math.max(0, op.opacity ?? 1));
  switch (op.mode) {
    case "points":
      if (ctx.data.features.length > hexbinThreshold) return hexTileLayers(op, ctx, opacity);
      return symbolLayers(op, ctx, opacity);
    case "lines":
      return lineLayers(op, ctx, opacity);
    case "polygons":
      return ctx.style.unit === "score" ? scoreAreaLayers(op, ctx, opacity) : areaLayers(op, ctx, opacity);
    case "heat":
      // Drawn by Mapbox's native heatmap (components/mapTiles.ts): deck's HeatmapLayer renders nothing in
      // GlobeView, which is what the overlay uses while the map is in globe projection.
      return [];
    default:
      throw new Error(`NotImplemented: ${op.mode}`);
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
 * Lines over a white casing (spec §11a: white for casings only). Trails follow TRAIL_LINE (dark grey dashes over a
 * sage core), forest roads dark grey dashes, use trails dark grey dots, other lines solid dark grey; the selected
 * line is solid purple. Score lines (popularity) take their ramp on a dark grey casing, so the off-white low end
 * still reads. A requested palette color (a compare side) draws solid in that color.
 */
function lineLayers(op: RenderOp, ctx: OpContext, opacity: number): Layer[] {
  const { data, selected, terrain, style } = ctx;
  const requested = requestedColor(op.color);
  const { id, trigger } = opIds(op, ctx, opacity, requested);
  const updateTriggers = { getLineColor: trigger, getLineWidth: trigger, getDashArray: trigger };
  const score = style.unit === "score" && !requested;
  const ramp = scoreRampFor(op.layerId);
  const classOf = (f: Feature) => LINE_CLASSES[lineClassFor(op.layerId, f.properties)];
  const casingColor = score ? GREY : hexToRgba(WHITE_HEX, Math.round(255 * LINE.casingOpacity));
  const casingWidth = score ? LINE.width + 2 : LINE.casing;
  const core = (f: Feature): Rgba => {
    if (requested) return hexToRgba(requested);
    if (score) return rampRgba(ramp, scoreT(f.properties?.v));
    return hexToRgba(classOf(f).color);
  };
  const under = (f: Feature): Rgba => {
    const cls = classOf(f);
    return !requested && !score && "under" in cls ? hexToRgba(cls.under) : [0, 0, 0, 0];
  };
  const select = (color: (f: Feature) => Rgba) =>
    perFeature((f) => (f === selected ? SELECT : color(f)), opacity, selected);
  // Deck's dash is in line widths; the recipes are in pixels. The selected line draws solid.
  const dash = (f: Feature): [number, number] => {
    if (f === selected || requested || score) return [0, 0];
    const [on, off] = classOf(f).dash;
    return [on / LINE.width, off / LINE.width];
  };
  return [
    new GeoJsonLayer({
      id: `${id}:casing`,
      data,
      pickable: false,
      filled: false,
      getLineColor: colorFor(casingColor, opacity, selected, WHITE),
      getLineWidth: widthFor(casingWidth, SELECTED_LINE.casing, selected),
      lineWidthUnits: "pixels",
      updateTriggers,
      ...terrainProps(terrain, "drape"),
    }),
    new GeoJsonLayer({
      id: `${id}:under`,
      data,
      pickable: false,
      filled: false,
      getLineColor: perFeature((f) => (f === selected ? [0, 0, 0, 0] : under(f)), opacity, selected),
      getLineWidth: LINE.width,
      lineWidthUnits: "pixels",
      updateTriggers,
      ...terrainProps(terrain, "drape"),
    }),
    new GeoJsonLayer({
      id,
      data,
      pickable: true,
      filled: false,
      getLineColor: select(core),
      getLineWidth: widthFor(LINE.width, SELECTED_LINE.width, selected),
      lineWidthUnits: "pixels",
      // The dash extension stays on every core line: adding or removing an extension on a live layer (as a
      // basemap switch would) leaves deck with a dangling dash attribute and it throws. [0, 0] draws solid.
      getDashArray: dash,
      updateTriggers,
      ...terrainProps(terrain, "drape", [dashExtension]),
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
  return [
    new GeoJsonLayer({
      id: `${id}:casing`,
      data,
      pickable: false,
      filled: false,
      getLineColor: colorFor(WHITE, opacity, selected),
      getLineWidth: widthFor(casingWidth, SELECTED_AREA.outlineWidth + 2 * SELECTED_AREA.casing, selected),
      lineWidthUnits: "pixels",
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
      lineWidthUnits: "pixels",
      fillPatternEnabled: Boolean(canvas),
      // Only with a canvas: deck turns the prop into a texture and throws on an explicit undefined.
      ...(canvas && { fillPatternAtlas: canvas }),
      fillPatternMapping: hatchAtlas().mapping,
      fillPatternMask: true,
      fillPatternSizeUnits: "pixels",
      getFillPattern: (f: Feature) => hatchPatternId(colorOf(f) as HatchColor, areaStep(op.layerId, recipe, f)),
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
      lineWidthUnits: "pixels",
      updateTriggers: { getFillColor: trigger, getLineColor: trigger, getLineWidth: trigger },
      ...terrainProps(terrain, "drape"),
    }),
  ];
}

/**
 * Point symbols (pins.ts): a shape per layer family, centered on the point; the selected one fills purple. The
 * sprite's alpha carries the op opacity and the selection fade.
 */
function symbolLayers(op: RenderOp, { data, selected, terrain, deckId }: OpContext, opacity: number): Layer[] {
  return [
    new IconLayer<Feature>({
      id: `${deckLayerKey(deckId ?? op.layerId, terrain)}:points`,
      data: data.features,
      pickable: true,
      getPosition: markerPosition,
      getIcon: (f) => atlasIcon(pinIconFor(op.layerId, f, f === selected)),
      getSize: SYMBOL_SIZE_PX,
      sizeUnits: "pixels",
      getColor: colorFor(SPRITE_TINT, opacity, selected),
      updateTriggers: { getColor: [selectionKey(selected), opacity], getIcon: [op.layerId, selectionKey(selected)] },
      // The overlay draws in deck's GlobeView, which flips the icon quads' winding; with back-face culling on,
      // deck 9.4 draws (and picks) no icons at all there.
      parameters: { cullMode: "none" },
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
  const id = `${deckLayerKey(deckId ?? op.layerId, terrain)}:points`;
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

// ---- Compare delta (spec §7, palette §11) ----

const DELTA_RGB = {
  "a-only": hexToRgba(COMPARE_COLORS.a),
  "b-only": hexToRgba(COMPARE_COLORS.b),
  both: hexToRgba(COMPARE_COLORS.both),
} as const;

/** Delta strokes: 1.5px outlines and 2.5px lines in the class color over a 1px white casing a side; points 5px discs. */
export const DELTA_STROKE = { polygon: 1.5, line: 2.5, casing: 1, pointRadius: 5 } as const;
/** Hex delta columns: the largest |B − A| stands this many meters tall. */
export const HEX_DELTA = { maxHeightM: 4000 } as const;

/** The class color for a delta feature (a-only purple, b-only pink, both dark grey); unknown reads as both. */
export function deltaColor(f: Feature): Rgba {
  const cls: unknown = f.properties?.delta;
  return cls === "a-only" || cls === "b-only" ? DELTA_RGB[cls] : DELTA_RGB.both;
}

function isArea(f: Feature): boolean {
  const t = f.geometry?.type;
  return t === "Polygon" || t === "MultiPolygon";
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
function deltaLayers(op: RenderOp, { data, selected, terrain }: OpContext): Layer[] {
  const opacity = Math.min(1, Math.max(0, op.opacity ?? 1));
  const id = `${deckLayerKey(op.layerId, terrain)}:${op.mode}`;
  const fade = (f: Feature, c: Rgba): Rgba => {
    const base = withOpacity(c, opacity);
    return selected && f !== selected ? withOpacity(base, SIBLING_FADE) : base;
  };
  const trigger = [selectionKey(selected), opacity];
  if (isHexCollection(data)) {
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
  const updateTriggers = { getFillColor: trigger, getLineColor: trigger, getLineWidth: trigger };
  const strokeWidth = (f: Feature) => (isArea(f) ? DELTA_STROKE.polygon : DELTA_STROKE.line);
  return [
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
    // Same GlobeView winding flip as the pins: with back-face culling on, deck draws no terrain mesh at all.
    parameters: { cullMode: "none" },
    extensions: [unpremultiplyExtension],
  });
}

/** Literal `process.env.NEXT_PUBLIC_*` access so Next inlines it into the client bundle. */
const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN?.trim() ?? "";

/**
 * Deck layers in three sets. `main` is everything the map overlay draws, bottom first (the terrain copy, then each
 * visible GeoJSON render op; heat ops yield none, Mapbox draws them). While a compare swipes, the compared layer's two
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
    const ctx: OpContext = { data: loaded.result.data, style: loaded.style, selected, zoom: state.viewport.zoom, terrain };
    if (compare?.layerId !== op.layerId || !mode) {
      main.push(...geoJsonLayersFor(op, ctx));
      continue;
    }
    if (mode === "delta") {
      main.push(...deltaLayers(op, ctx));
      continue;
    }
    // Each side draws in its compare color (A purple, B pink: palette §11), in place of the layer's own stroke.
    const sideA = geoJsonLayersFor({ ...op, color: COMPARE_COLORS.a }, ctx);
    const bId = compareBId(op.layerId);
    const loadedB = state.layers[bId];
    const sideB =
      loadedB?.result.kind === "geojson"
        ? geoJsonLayersFor({ ...op, color: COMPARE_COLORS.b }, { ...ctx, data: loadedB.result.data, selected: selectedB, deckId: bId })
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
 * list: `buildDeckLayerSets`' main set plus any swipe sides (without their own terrain copies).
 * Heat ops yield none here; Mapbox draws them.
 */
export function buildDeckLayers(state: MapState, options: { mapboxToken?: string } = {}): Layer[] {
  const { main, a, b } = buildDeckLayerSets(state, options);
  const sides = [...a, ...b].filter((l) => l.id !== DECK_TERRAIN_ID);
  return sides.length > 0 ? [...main, ...sides] : main;
}
