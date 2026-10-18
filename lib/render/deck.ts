import { LayerExtension, type Layer } from "@deck.gl/core";
import { FillStyleExtension, _TerrainExtension as TerrainExtension } from "@deck.gl/extensions";
import { H3HexagonLayer, TerrainLayer } from "@deck.gl/geo-layers";
import { GeoJsonLayer, IconLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { WebMercatorViewport } from "@math.gl/web-mercator";
import type { Feature } from "geojson";
import { cellToBoundary, cellToLatLng, getHexagonEdgeLengthAvg, UNITS } from "h3-js";
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
  DARK_GREY as DARK_GREY_HEX,
  OFF_WHITE,
  PINK,
  PURPLE,
  scoreRampFor,
  SELECTED_AREA,
  SIBLING_FADE,
  AREA_OUTLINE_SIBLING_FADE,
  symbolSizePx,
  WHITE as WHITE_HEX,
  HATCH_COLORS,
  type AreaRecipe,
  type HatchColor,
  type RampName,
} from "@/lib/render/palette";
import { acresStep, HATCH_SCALE, hatchAtlas, hatchAtlasCanvas, hatchPatternId } from "@/lib/render/hatch";
import { hexToRgb, rampColor } from "@/lib/render/ramp";
import { compareBId, compareSideShown, DELTA_FILL_ALPHA, effectiveMode, isHexCollection } from "@/lib/render/compareView";
import { DECK_TERRAIN_ID, DECK_TERRAIN_TAG, demDecoder, demTileUrl } from "@/lib/render/wally/deckTerrain";
import { DELTA_TAG, featureBBox, featureCenter, HEX_DELTA_TAG } from "@/lib/render/inspect";
import { kindGlyph, pinIconFor, type PinEncoding } from "@/lib/render/wally/pins";
import { categoryColor, categoryKey, groupOf, type CategoryKey } from "@/lib/render/categories";
import { layerLabels } from "@/lib/render/contract";
import { drawsNativeLines, isLineGeometry, SELECTED_LINE } from "@/lib/render/nativeLines";
import type { HexBasis, LoadedLayer, MapState, RenderMode, RenderOp, Viewport } from "@/lib/render/state";
import { extentOf, hatchStepOf, primaryMeasure, sizeScale, topPlaces } from "@/lib/render/attributes";
import { basisLabel, basisScale, basisT, cellContext, hexCells, registerCell, usableBasis, type CellContext, type HexCell } from "@/lib/render/hexCells";
import { RANKED_LABELS } from "@/lib/render/views";
import { PlacedLabelLayer } from "@/lib/render/placedLabels";
import { colorT, divergingColor, encodeColor, ENCODED_POINT, isDiverging, pointRadiusAt, resolveEncoding, sizeT, valuesOf, type ResolvedEncoding } from "@/lib/render/encode";

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
function colorFor(color: Rgba, opacity: number, selected: Feature | undefined, selectedColor?: Rgba, fade: number = SIBLING_FADE): ColorAccessor {
  const base = withOpacity(color, opacity);
  if (!selected) return base;
  const strong = selectedColor ? withOpacity(selectedColor, opacity) : base;
  const faded = withOpacity(base, fade);
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

/**
 * The H3 resolution for tiles at a zoom: one finer every zoom, so a cell stays about the same size on screen and reads
 * as density, not a slab (points fixer, 2026-10-18): about 1 km across (res 8, 0.7 km²) at z11, 2.4 km (res 7) at z10,
 * about 45 km (res 4) at z7, never coarser than res 3 nor finer than res 9.
 */
export function hexResolution(zoom: number): number {
  return Math.min(9, Math.max(3, Math.floor(zoom) - 3));
}

/** Where a feature sits as a symbol: a Point's coordinates, else the center of its extent. */
function markerPosition(f: Feature): [number, number] {
  if (f.geometry?.type === "Point") return f.geometry.coordinates as [number, number];
  return featureCenter(f) ?? [0, 0];
}

/**
 * One tile: a Point feature at the hex center whose properties carry the cell, how many features fell in it and its
 * value on the layer's color basis (spec §12d); the renderer registers the cell behind it (lib/render/hexCells.ts) so
 * a pick opens the cell's card.
 */
export type HexFeature = Feature<GeoJSON.Point, { count: number; h3: string; aggregate: true; value?: number }>;

/** One result binned at one resolution on one basis: the tiles, the labelled subset, and the ramp's scale. */
type Binned = { hexes: HexFeature[]; labelled: HexFeature[]; max: number; lo: number; basis: HexBasis; label: (f: HexFeature) => string };

/** Binned tiles per result, resolution and basis, so panning and selection reuse the same tile objects. */
const hexCache = new WeakMap<GeoJSON.FeatureCollection, Map<string, Binned>>();

/** True for a usable lng/lat: finite, longitude within ±180 and latitude within ±90 (H3 throws otherwise). */
function validLngLat([lng, lat]: [number, number]): boolean {
  return Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90;
}

const COUNT_CONTEXT: CellContext = { timeKey: "t", noun: "features" };

function binned(data: GeoJSON.FeatureCollection, resolution: number, asked: HexBasis = "count", ctx: CellContext = COUNT_CONTEXT): Binned {
  let byKey = hexCache.get(data);
  if (!byKey) {
    byKey = new Map();
    hexCache.set(data, byKey);
  }
  const cells = hexCells(data, resolution);
  const basis = usableBasis(asked, ctx, cells);
  const key = `${resolution}|${basis}|${ctx.measure?.key ?? ""}|${ctx.category?.key ?? ""}|${ctx.timeKey}`;
  const cached = byKey.get(key);
  if (cached) return cached;
  const scale = basisScale(cells, basis, ctx);
  const hexes: HexFeature[] = cells.map((cell) => {
    const value = scale.values.get(cell);
    const feature: HexFeature = {
      type: "Feature",
      geometry: { type: "Point", coordinates: cell.position },
      properties: { count: cell.members.length, h3: cell.h3, aggregate: true, ...(value !== undefined && basis !== "count" && { value }) },
    };
    registerCell(feature, { cell, cells, basis, ctx });
    return feature;
  });
  const label = (f: HexFeature) => (basis === "count" ? countLabel(f.properties.count) : basisLabel(f.properties.value, basis));
  const entry: Binned = {
    hexes,
    // Counts label cells holding two or more; other bases label every cell that has a value.
    labelled: hexes.filter((h) => (basis === "count" ? h.properties.count >= HEX_TILE.labelMin : label(h) !== "")),
    max: basis === "count" ? hexes.reduce((m, h) => Math.max(m, h.properties.count), 1) : scale.hi,
    lo: scale.lo,
    basis,
    label,
  };
  byKey.set(key, entry);
  return entry;
}

/** Bins a result's features into H3 cells at `resolution`, skipping invalid coordinates (cached per result). */
export function hexbin(data: GeoJSON.FeatureCollection, resolution: number): HexFeature[] {
  return binned(data, resolution).hexes;
}

/** The layer's cell context (measure, main category, date field), or the plain count context without a layer. */
function cellCtx(ctx: Pick<OpContext, "layer">): CellContext {
  return ctx.layer ? cellContext(ctx.layer) : COUNT_CONTEXT;
}

/**
 * A tile's fill (owner's board, hex tiles variant A): the gray ramp from off-white (fewest features) to dark grey
 * (the busiest tile), log scaled, at 0.55 to 0.80 opacity.
 */
export function hexTileColor(count: number, max: number): Rgba {
  const t = countT(count, max);
  const [a0, a1] = HEX_TILE.alpha;
  return rampRgba(HEX_TILE.ramp, t, Math.round(255 * (a0 + (a1 - a0) * t)));
}

/** A tile's fill on its basis: the same gray ramp, at `t` from basisT (log counts and sums, shares, recency). */
export function hexTileColorAt(t: number): Rgba {
  const [a0, a1] = HEX_TILE.alpha;
  const u = Math.min(1, Math.max(0, t));
  return rampRgba(HEX_TILE.ramp, u, Math.round(255 * (a0 + (a1 - a0) * u)));
}

/** Tiles over imagery keep this share of their alpha. */
export const HEX_IMAGERY_ALPHA = 0.7;

/** A count's place on the tile ramp: log scaled against the busiest tile. */
function countT(count: number, max: number): number {
  return max > 1 ? Math.min(1, Math.max(0, Math.log(count) / Math.log(max))) : 1;
}

/** Past this share of the ramp a tile is dark enough that its label turns off-white. */
const HEX_LABEL_FLIP = 0.6;
const HEX_LABEL_LIGHT = hexToRgba(OFF_WHITE);

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
  /** The layer's title and attributes (spec §12c, §12d): what ranks, sizes and colors its cells, and its contract (labels). */
  layer?: Pick<LoadedLayer, "title" | "attributes" | "style"> & Partial<Pick<LoadedLayer, "id" | "legend" | "labels" | "card" | "allData" | "result">>;
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
  /** The floating panels' insets over the map canvas, so ranked labels stay in the clear part (placedLabels.ts). */
  labelInsets?: LabelInsets;
  /** The basemap on screen: hex tiles lighten over imagery. */
  basemap?: MapState["basemap"];
};

/** The floating panels' insets over a canvas of this size (MapCanvas reads them from the page). */
export type LabelInsets = (canvas: { width: number; height: number }) => Padding;

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

/** The category key the op's features are colored by (lib/render/categories.ts), read on every loaded feature. */
function categoryKeyOf(op: RenderOp, ctx: Pick<OpContext, "layer" | "data">): CategoryKey | undefined {
  if (!ctx.layer || requestedColor(op.color)) return undefined;
  const all = ctx.layer.allData ?? (ctx.layer.result?.kind === "geojson" ? ctx.layer.result.data : ctx.data);
  return categoryKey({ id: op.layerId, attributes: ctx.layer.attributes, style: ctx.layer.style, legend: ctx.layer.result?.legend ?? ctx.layer.legend }, all);
}

const NO_ENCODING: PinEncoding = {};

/**
 * One point's symbol encoding (encode by default): its category's fill, and for a `kind` category its kind's own glyph
 * (huts, springs, viewpoints), so kinds differ by shape as well as color. Nothing for a layer with no category.
 */
function pinEncoder(key: CategoryKey | undefined): (f: Feature) => PinEncoding {
  if (!key) return () => NO_ENCODING;
  const kinds = /kind|type|category|class/i.test(key.attr.key) && !key.ordinal;
  const memo = new Map<string, PinEncoding>();
  return (f) => {
    const g = groupOf(key, f);
    const id = g?.label ?? "";
    let enc = memo.get(id);
    if (!enc) {
      const glyph = kinds && g ? kindGlyph(g.values[0], g.label) : null;
      enc = { fill: categoryColor(key, f), ...(glyph && { glyph }) };
      memo.set(id, enc);
    }
    return enc;
  };
}

/** The measure that sizes features (`encode: "size"`, spec §12c): symbol size, hatch density. */
function sizeMeasureKey(ctx: Pick<OpContext, "layer">): string | undefined {
  const measure = primaryMeasure(ctx.layer);
  return measure?.encode === "size" ? measure.key : undefined;
}

/**
 * Encode by default: the measure a point layer's symbols are sized by when nothing else sizes them, its primary measure
 * (when the data holds numbers for it). "Rank by: None" in the row ("") switches it off.
 */
function defaultSizeKey(op: RenderOp, ctx: Pick<OpContext, "layer" | "data">): string | undefined {
  if (op.rankBy === "") return undefined;
  const key = primaryMeasure(ctx.layer)?.key;
  if (!key) return undefined;
  return memoExtent(ctx.data, key) ? key : undefined;
}

/** The measure a point layer is ranked by: "Rank by" in its row, else in a ranked view its primary measure (else `v`). */
function rankKeyOf(op: RenderOp, ctx: Pick<OpContext, "layer">): string | undefined {
  if (op.rankBy !== undefined) return op.rankBy === "" ? undefined : op.rankBy;
  return op.view === "ranked" ? (primaryMeasure(ctx.layer)?.key ?? "v") : undefined;
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
    case "points": {
      // A ranked layer keeps its symbols (sized, named) however many there are: the row lists the top N.
      if (ctx.data.features.length > hexbinThreshold && !rankKeyOf(op, ctx)) return hexTileLayers(op, ctx, opacity);
      // Two measures on one mark (spec §13): proportional discs sized by one measure and colored by the other.
      // Without a color value the layer keeps its shaped symbols, sized by the size measure.
      const encoding = encodingOf(op, ctx);
      if (encoding?.color) return [...encodedPointLayers(op, ctx, opacity, encoding), ...labelLayers(op, ctx, opacity)];
      return [...symbolLayers(op, ctx, opacity), ...labelLayers(op, ctx, opacity)];
    }
    case "hexbin":
      return hexTileLayers(op, ctx, opacity);
    case "clusters":
      return clusterLayers(op, ctx, opacity);
    case "columns":
      // Areas extrude by `v`; lines have no column form (Mapbox draws them: lib/render/nativeLines.ts). Points stack
      // into H3 columns. In 2D both draw flat.
      if (ctx.style.geometry === "line") return [];
      if (ctx.style.geometry === "polygon") {
        return ctx.threeD ? [...extrudedAreaLayers(op, ctx, opacity), ...labelLayers(op, ctx, opacity)] : polygonLayers({ ...op, mode: "polygons" }, ctx, opacity);
      }
      return ctx.threeD ? columnLayers(op, ctx, opacity) : hexTileLayers(op, ctx, opacity);
    case "lines": {
      // Native Mapbox line layers (lib/render/nativeLines.ts, synced by components/mapTiles.ts), crisp on 3D terrain.
      // A line layer's own points (a paddling run's rapids and put-ins) draw here as symbols.
      const points = pointsOf(ctx.data);
      return points.features.length > 0 ? [...symbolLayers({ ...op, mode: "points" }, { ...ctx, data: points }, opacity), ...labelLayers(op, { ...ctx, data: points }, opacity)] : [];
    }
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

const pointsMemo = new WeakMap<GeoJSON.FeatureCollection, GeoJSON.FeatureCollection>();
/** The point features of a collection (made once per collection). */
function pointsOf(data: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
  let out = pointsMemo.get(data);
  if (!out) {
    const kept = data.features.filter((f) => f.geometry?.type === "Point" || f.geometry?.type === "MultiPoint");
    out = kept.length === data.features.length ? data : { ...data, features: kept };
    pointsMemo.set(data, out);
  }
  return out;
}

const areasMemo = new WeakMap<GeoJSON.FeatureCollection, GeoJSON.FeatureCollection>();
/** The non-point features of a collection (made once per collection). */
function areasOf(data: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
  let out = areasMemo.get(data);
  if (!out) {
    out = { ...data, features: data.features.filter((f) => f.geometry?.type !== "Point" && f.geometry?.type !== "MultiPoint") };
    areasMemo.set(data, out);
  }
  return out;
}

function polygonLayers(op: RenderOp, ctx: OpContext, opacity: number): Layer[] {
  // An area layer's own points (disaster alerts given as a point) draw as real symbols, not as bare circles.
  const points = pointsOf(ctx.data);
  if (points.features.length > 0 && points !== ctx.data) {
    const areasOnly = areasOf(ctx.data);
    return [...polygonLayers(op, { ...ctx, data: areasOnly }, opacity), ...symbolLayers({ ...op, mode: "points" }, { ...ctx, data: points }, opacity)];
  }
  if (points === ctx.data && points.features.length > 0) return [...symbolLayers({ ...op, mode: "points" }, ctx, opacity), ...labelLayers(op, ctx, opacity)];
  // A color channel on areas (temperature anomaly by county): a choropleth, on the diverging ramp across zero.
  const color = encodingOf(op, ctx)?.color;
  if (color && !requestedColor(op.color)) return [...choroplethLayers(op, ctx, opacity, color), ...labelLayers(op, ctx, opacity)];
  const areas = ctx.style.unit === "score" ? scoreAreaLayers(op, ctx, opacity) : areaLayers(op, ctx, opacity);
  // A ranked view labels its top areas on the map, as it labels its top symbols (lib/render/views.ts).
  return [...areas, ...labelLayers(op, ctx, opacity)];
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
  // Encode by default: a category colors each area (tint, hatch and outline) in its own palette color, at a tint that
  // reads on green Topo; kinds past the fourth keep the layer's own color.
  const key = categoryKeyOf(op, ctx);
  const kindColor = (f: Feature): string => {
    if (!key) return recipe.color;
    const c = categoryColor(key, f);
    return (HATCH_COLORS as readonly string[]).includes(c) ? c : recipe.color;
  };
  const colorOf = (f: Feature) => (f === selected ? SELECTED_AREA.color : kindColor(f));
  const tintAlpha = key ? Math.max(recipe.tint, CATEGORY_AREA_TINT) : recipe.tint;
  // A group the legend draws as a line is an outline only (no tint, no hatch), unless selected.
  const filled = (f: Feature) => f === selected || !key || !groupOf(key, f)?.outline;
  const tint = perFeature((f) => hexToRgba(colorOf(f), filled(f) ? Math.round(255 * tintAlpha) : 0), opacity, selected);
  const hatch = perFeature((f) => hexToRgba(colorOf(f), filled(f) ? Math.round(255 * recipe.hatchAlpha) : 0), opacity, selected);
  const outlineOf = (f: Feature): Rgba => hexToRgba(key ? kindColor(f) : recipe.outline);
  // The white casing is wide enough that an outline never reads as one of the basemap's own lines (contours, borders).
  const casingWidth = recipe.outlineWidth + 2 * Math.max(recipe.casing, AREA_CASING_MIN);
  const sizeKey = sizeMeasureKey(ctx);
  const sized = sizeKey ? { key: sizeKey, extent: memoExtent(data, sizeKey) } : undefined;
  return [
    new GeoJsonLayer({
      id: `${id}:casing`,
      data,
      pickable: false,
      filled: false,
      getLineColor: colorFor(WHITE, opacity, selected, undefined, AREA_OUTLINE_SIBLING_FADE),
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
      getLineColor: key
        ? (f: Feature) => {
            if (f === selected) return withOpacity(SELECT, opacity);
            const c = withOpacity(outlineOf(f), opacity);
            return selected ? withOpacity(c, AREA_OUTLINE_SIBLING_FADE) : c;
          }
        : colorFor(hexToRgba(recipe.outline), opacity, selected, SELECT, AREA_OUTLINE_SIBLING_FADE),
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

/** An area's tint when a category colors it (readable on green Topo and under satellite), and its least white casing. */
export const CATEGORY_AREA_TINT = 0.22;
export const AREA_CASING_MIN = 1.25;

/** A choropleth's fill alpha: solid enough to read the value, the ground still showing. */
export const CHOROPLETH_ALPHA = 0.62;

/**
 * Areas colored by a measure or class (style.encode.color): a solid fill on the encode ramp (sage → pink → purple),
 * or the diverging ramp when the values run both sides of zero (purple cooler or less, pink warmer or more), with thin
 * white edges; no value draws a faint grey. The selected area is outlined purple.
 */
function choroplethLayers(op: RenderOp, ctx: OpContext, opacity: number, channel: NonNullable<ResolvedEncoding["color"]>): Layer[] {
  const { data, selected, terrain } = ctx;
  const { id, trigger } = opIds(op, ctx, opacity, undefined);
  const widths = pixelWidths(ctx);
  const diverging = isDiverging(channel);
  const fill = (f: Feature): Rgba => {
    const v = f.properties?.[channel.key];
    const rgb = diverging ? divergingColor(v, channel) : (() => { const t = colorT(v, channel); return t === null ? null : encodeColor(t); })();
    return rgb ? [rgb[0], rgb[1], rgb[2], Math.round(255 * CHOROPLETH_ALPHA)] : hexToRgba(DARK_GREY_HEX, 26);
  };
  return [
    new GeoJsonLayer({
      id,
      data,
      pickable: true,
      filled: true,
      getFillColor: perFeature(fill, opacity, selected),
      getLineColor: colorFor(hexToRgba(WHITE_HEX, 200), opacity, selected, SELECT, AREA_OUTLINE_SIBLING_FADE),
      getLineWidth: widthFor(0.75, SELECTED_AREA.outlineWidth, selected),
      lineWidthUnits: widths.units,
      lineWidthScale: widths.scale,
      updateTriggers: { getFillColor: [...trigger, channel.key, channel.extent?.join(",") ?? ""], getLineColor: trigger, getLineWidth: trigger },
      ...terrainProps(terrain, "drape"),
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
function symbolLayers(op: RenderOp, ctx: OpContext, opacity: number): Layer[] {
  const { data, selected, zoom, terrain, deckId } = ctx;
  const size = symbolSizePx(zoom);
  // Ranked (a ranked view, or "Rank by" in the row) sizes the symbols by the measure and names its top few (spec §12c);
  // otherwise the layer's size measure (spec §13) sizes them.
  const rankKey = rankKeyOf(op, ctx) ?? encodingOf(op, ctx)?.size?.key ?? defaultSizeKey(op, ctx);
  const ranked = rankKey ? rankedSizing(data, rankKey) : undefined;
  const encode = pinEncoder(categoryKeyOf(op, ctx));
  return [
    new IconLayer<Feature>({
      id: `${deckLayerKey(deckId ?? op.layerId, terrain)}:points`,
      data: ranked ? largestFirst(data, ranked.key) : data.features,
      pickable: true,
      getPosition: markerPosition,
      getIcon: (f) => atlasIcon(pinIconFor(op.layerId, f, f === selected, size, encode(f))),
      // A symbol with a compass direction (a buoy's swell, a surf break's facing) turns to it: deck turns
      // counter-clockwise from up, a bearing clockwise from north.
      getAngle: (f: Feature) => {
        const d = f.properties?.directionDeg;
        return typeof d === "number" && Number.isFinite(d) ? -d : 0;
      },
      // A symbol with no value for the measure draws smallest, never at the middle size it would otherwise claim.
      getSize: ranked
        ? (f: Feature) => {
            const v = f.properties?.[ranked.key];
            return SYMBOL_SIZE_PX * (typeof v === "number" && Number.isFinite(v) ? sizeScale(v, ranked.extent) : sizeScale(ranked.extent?.[0] ?? 0, ranked.extent));
          }
        : SYMBOL_SIZE_PX,
      sizeUnits: "pixels",
      getColor: colorFor(SPRITE_TINT, opacity, selected),
      updateTriggers: {
        getColor: [selectionKey(selected), opacity],
        getIcon: [op.layerId, selectionKey(selected), size, op.color ?? ""],
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

/** The op's two channels on its data (spec §13), or null when the layer has none to draw. */
function encodingOf(op: RenderOp, ctx: Pick<OpContext, "layer" | "data">): ResolvedEncoding | null {
  return ctx.layer ? resolveEncoding(ctx.layer, op, ctx.data) : null;
}

/** Features largest first, so small discs draw over large ones and stay clickable (made once per collection and key). */
const bySizeMemo = new WeakMap<GeoJSON.FeatureCollection, Map<string, Feature[]>>();
function largestFirst(data: GeoJSON.FeatureCollection, key: string | undefined): Feature[] {
  if (!key) return data.features;
  let byKey = bySizeMemo.get(data);
  if (!byKey) {
    byKey = new Map();
    bySizeMemo.set(data, byKey);
  }
  const hit = byKey.get(key);
  if (hit) return hit;
  const num = (f: Feature) => {
    const v = f.properties?.[key];
    return typeof v === "number" && Number.isFinite(v) ? v : -Infinity;
  };
  const sorted = [...data.features].sort((a, b) => num(b) - num(a));
  byKey.set(key, sorted);
  return sorted;
}

const ENCODED_STROKE = hexToRgba(DARK_GREY_HEX);
const ENCODED_EMPTY = hexToRgba(OFF_WHITE, Math.round(255 * ENCODED_POINT.fillAlpha));

/**
 * Points with two measures on one mark (spec §13): a disc whose area grows with the size measure (radius by the square
 * root of its share of the largest) and whose fill sits on the sage → pink → purple ramp by the color measure, a dark
 * grey 1.25px stroke over a white halo, largest drawn first. A feature without a color value is off-white; the
 * selected one purple.
 */
function encodedPointLayers(op: RenderOp, ctx: OpContext, opacity: number, encoding: ResolvedEncoding): Layer[] {
  const { data, selected, terrain, deckId } = ctx;
  const id = `${deckLayerKey(deckId ?? op.layerId, terrain)}:encoded`;
  const { size, color } = encoding;
  const radius = (f: Feature) => (size ? pointRadiusAt(sizeT(f.properties?.[size.key], size.extent)) : symbolSizePx(ctx.zoom) / 2 + 1);
  const fill = (f: Feature): Rgba => {
    if (f === selected) return withOpacity(SELECT, opacity);
    const t = color ? colorT(f.properties?.[color.key], color) : null;
    const base: Rgba = t === null ? ENCODED_EMPTY : [...encodeColor(t), Math.round(255 * ENCODED_POINT.fillAlpha)];
    const c = withOpacity(base, opacity);
    return selected ? withOpacity(c, SIBLING_FADE) : c;
  };
  const stroke = (f: Feature): Rgba => {
    const c = withOpacity(ENCODED_STROKE, opacity);
    return selected && f !== selected ? withOpacity(c, SIBLING_FADE) : c;
  };
  const trigger = [selectionKey(selected), opacity, size?.key ?? "", size?.extent?.join(",") ?? "", color?.key ?? "", color?.extent?.join(",") ?? ""];
  const features = largestFirst(data, size?.key);
  return [
    new ScatterplotLayer<Feature>({
      id: `${id}:halo`,
      data: features,
      pickable: false,
      getPosition: markerPosition,
      getRadius: (f) => radius(f) + ENCODED_POINT.strokePx / 2 + ENCODED_POINT.haloPx,
      radiusUnits: "pixels",
      filled: true,
      stroked: false,
      getFillColor: withOpacity(hexToRgba(WHITE_HEX, 230), opacity * (selected ? SIBLING_FADE : 1)),
      updateTriggers: { getRadius: trigger, getFillColor: trigger },
      billboard: true,
      parameters: { cullMode: "none", depthCompare: "always" },
      ...terrainProps(terrain, "offset"),
    }),
    new ScatterplotLayer<Feature>({
      id,
      data: features,
      pickable: true,
      getPosition: markerPosition,
      getRadius: radius,
      radiusUnits: "pixels",
      filled: true,
      stroked: true,
      getFillColor: fill,
      getLineColor: stroke,
      getLineWidth: ENCODED_POINT.strokePx,
      lineWidthUnits: "pixels",
      updateTriggers: { getRadius: trigger, getFillColor: trigger, getLineColor: trigger },
      billboard: true,
      parameters: { cullMode: "none", depthCompare: "always" },
      ...terrainProps(terrain, "offset"),
    }),
  ];
}

/** A cell's mean of the color channel's values (each frame of a series counts), as its 0..1 place on the ramp. */
export function cellColorT(members: readonly Feature[], channel: NonNullable<ResolvedEncoding["color"]>): number | null {
  if (channel.levels) {
    const ts = members.map((f) => colorT(f.properties?.[channel.key], channel)).filter((t): t is number => t !== null);
    return ts.length > 0 ? ts.reduce((a, b) => a + b, 0) / ts.length : null;
  }
  const values = members.flatMap((f) => {
    const v = f.properties?.[channel.key];
    return typeof v === "number" && Number.isFinite(v) ? [v] : valuesOf(f, channel.key).slice(0, 1);
  });
  if (values.length === 0) return null;
  return colorT(values.reduce((a, b) => a + b, 0) / values.length, channel);
}

/** A ranked point layer's sizing: the measure key, its extent, and the top features to name. */
function rankedSizing(data: GeoJSON.FeatureCollection, key: string): { key: string; extent: [number, number] | null; top: Feature[] } {
  return { key, extent: memoExtent(data, key), top: topPlaces(data, key, RANKED_LABELS) };
}

/** A ranked label's box on screen, for declutter: about this wide per character and this tall, in CSS pixels. */
const LABEL_BOX = { charPx: 6.5, heightPx: 16 } as const;

/**
 * The top features' names that fit without overlapping a higher-ranked one at this zoom (an equirectangular guess at
 * screen distance, enough for a handful of labels): two crags 300 m apart at zoom 11 keep only the bigger one's name.
 */
export function declutterLabels(features: Feature[], zoom: number, latitude: number): Feature[] {
  const mpp = metersPerPixel(zoom, latitude);
  const kept: { x: number; y: number; w: number }[] = [];
  const out: Feature[] = [];
  for (const f of features) {
    const [lng, lat] = markerPosition(f);
    const x = (lng * 111_320 * Math.cos((latitude * Math.PI) / 180)) / mpp;
    const y = (lat * 110_574) / mpp;
    const w = String(f.properties?.name ?? "").length * LABEL_BOX.charPx;
    if (kept.some((k) => Math.abs(k.x - x) < (k.w + w) / 2 + 4 && Math.abs(k.y - y) < LABEL_BOX.heightPx)) continue;
    kept.push({ x, y, w });
    out.push(f);
  }
  return out;
}

/** A label's text: a placeholder name ("Unnamed glacier") says nothing on the map. */
function labelText(f: Feature, field: string): string | null {
  const raw = f.properties?.[field];
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  return text && !/^unnamed\b/i.test(text) ? text : null;
}

/** The labelled features: the top `max` by `rankBy` (source order without it), each with text, made once per data. */
const labelMemo = new WeakMap<GeoJSON.FeatureCollection, Map<string, Feature[]>>();
function labelled(data: GeoJSON.FeatureCollection, field: string, max: number, rankBy?: string): Feature[] {
  let byKey = labelMemo.get(data);
  if (!byKey) {
    byKey = new Map();
    labelMemo.set(data, byKey);
  }
  const key = `${field}|${max}|${rankBy ?? ""}`;
  const hit = byKey.get(key);
  if (hit) return hit;
  const named = data.features.filter((f) => labelText(f, field) !== null);
  const top = rankBy && memoExtent(data, rankBy) ? topPlaces({ type: "FeatureCollection", features: named }, rankBy, max) : named.slice(0, max);
  // The text under `name` (what declutter and the label read), the feature otherwise as it is.
  const out = field === "name" ? top : top.map((f) => ({ ...f, properties: { ...f.properties, name: labelText(f, field) } }));
  byKey.set(key, out);
  return out;
}

/**
 * Names on the map (docs/layer-contract.md `labels`): a ranked view's top features, else the top features the layer's
 * LabelSpec names (`labelsOf`: its declared field, count and rank, or the names of the top five by the card's measure),
 * from its minZoom up. Dark grey on a white halo, beside a symbol or at an area's center, decluttered so no two
 * overlap, and placed inside the clear map (labelPlacement.ts).
 */
function labelLayers(op: RenderOp, ctx: OpContext, opacity: number): Layer[] {
  const { data, terrain, deckId, style } = ctx;
  const geometry = data.features.find((f) => f.geometry)?.geometry?.type;
  const area = geometry === "Polygon" || geometry === "MultiPolygon";
  const point = geometry === "Point" || geometry === "MultiPoint";
  if (!area && !point) return [];
  const rankKey = rankKeyOf(op, ctx);
  const spec = rankKey ? { field: "name", max: RANKED_LABELS, rankBy: rankKey } : ctx.layer ? layerLabels({ labels: ctx.layer.labels, card: ctx.layer.card }) : undefined;
  if (!spec || (spec.minZoom !== undefined && ctx.zoom < spec.minZoom)) return [];
  const sizeKey = point ? (rankKey ?? encodingOf(op, ctx)?.size?.key ?? defaultSizeKey(op, ctx)) : undefined;
  const extent = sizeKey ? memoExtent(data, sizeKey) : null;
  const top = labelled(data, spec.field, spec.max, spec.rankBy);
  const shown = declutterLabels(top, ctx.zoom, ctx.latitude);
  if (shown.length === 0) return [];
  void style;
  const labelKey = deckLayerKey(deckId ?? op.layerId, terrain);
  const kind = area ? "polygons" : "points";
  return [
    new PlacedLabelLayer<Feature>({
      id: `${labelKey}:${kind}:placed`,
      textId: `${labelKey}:${kind}:labels`,
      data: shown,
      getPosition: markerPosition,
      getText: (f) => String(f.properties?.name),
      size: 11,
      getGap: (f) => (area ? 4 : Math.round((SYMBOL_SIZE_PX * (sizeKey ? sizeScale(f.properties?.[sizeKey], extent) : 1)) / 2) + 8),
      getInsets: ctx.labelInsets,
      textProps: {
        pickable: false,
        getColor: hexToRgba(HEX_TILE.label, Math.round(255 * opacity)),
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
        fontWeight: 600,
        characterSet: "auto",
        fontSettings: { sdf: true, buffer: 6 },
        outlineWidth: 0.6,
        outlineColor: hexToRgba(HEX_TILE.labelHalo, Math.round(240 * opacity)),
        billboard: true,
        parameters: { cullMode: "none", depthCompare: "always" },
        ...terrainProps(terrain, "offset"),
      },
    }),
  ];
}

/**
 * Dense point layers as flat H3 tiles at a zoom-dependent resolution (owner's board, variant A): the gray ramp, white
 * 1px edges, a dark grey count on a white halo on grouped tiles. A picked tile is a `HexFeature`, so the inspect card
 * shows its count.
 */
/** Label sizes a tile tries, largest first, in CSS pixels; a label that fits none is dropped. */
const HEX_LABEL_SIZES = [HEX_TILE.labelSize, 9] as const;
/** About how wide one character of the tile font is, as a share of its size. */
const HEX_LABEL_CHAR_EM = 0.62;

/** The size a tile label fits at inside a cell `cellPx` across (its inner width), or 0 when it fits none. */
export function hexLabelSize(text: string, cellPx: number): number {
  for (const size of HEX_LABEL_SIZES) if (text.length * size * HEX_LABEL_CHAR_EM + 4 <= cellPx) return size;
  return 0;
}

/** The labels that fit, per label list and cell width in whole pixels, so an unchanged map reuses the same list. */
const fittedLabels = new WeakMap<HexFeature[], Map<number, { data: HexFeature[]; size: Map<HexFeature, number> }>>();

function fitLabels(labelled: HexFeature[], label: (f: HexFeature) => string, cellPx: number) {
  let byWidth = fittedLabels.get(labelled);
  if (!byWidth) {
    byWidth = new Map();
    fittedLabels.set(labelled, byWidth);
  }
  const key = Math.round(cellPx);
  const hit = byWidth.get(key);
  if (hit) return hit;
  const size = new Map<HexFeature, number>();
  for (const f of labelled) {
    const s = hexLabelSize(label(f), key);
    if (s > 0) size.set(f, s);
  }
  const entry = { data: labelled.filter((f) => size.has(f)), size };
  byWidth.set(key, entry);
  return entry;
}

function hexTileLayers(op: RenderOp, ctx: OpContext, opacity: number): Layer[] {
  const { data, selected: picked, zoom, terrain, deckId } = ctx;
  // Its own id (not `:points`, the symbols' IconLayer): deck must never update one layer class in place of another.
  const id = `${deckLayerKey(deckId ?? op.layerId, terrain)}:hexbin`;
  const resolution = hexResolution(zoom);
  const { hexes, labelled: all, max, lo, basis, label } = binned(data, resolution, op.hexBasis, cellCtx(ctx));
  // A label stays inside its cell at every zoom: smaller type in a small cell, none where even that does not fit.
  const cellPx = (1.4 * getHexagonEdgeLengthAvg(resolution, UNITS.m)) / metersPerPixel(zoom, ctx.latitude);
  const { data: labelled, size: labelSize } = fitLabels(all, label, cellPx);
  // A tile picked at another resolution is not among these tiles: ignore it rather than fade every tile.
  const selected = picked && hexes.includes(picked as HexFeature) ? picked : undefined;
  const trigger = [selectionKey(selected), opacity, resolution, basis, ctx.basemap ?? ""];
  const tOf = (f: HexFeature) => (basis === "count" ? countT(f.properties.count, max) : basisT(f.properties.value, { lo, hi: max, basis }));
  const base = (f: HexFeature): Rgba => (basis === "count" ? hexTileColor(f.properties.count, max) : hexTileColorAt(tOf(f)));
  // Over imagery the tiles lighten (the photo shows through) and their edges turn fully white, so cells read on dark
  // ground without hiding it.
  const imagery = ctx.basemap === "satellite" || ctx.basemap === "outdoors-satellite";
  const fill = imagery ? (f: HexFeature): Rgba => { const c = base(f); return [c[0], c[1], c[2], Math.round(c[3] * HEX_IMAGERY_ALPHA)]; } : base;
  const edge = imagery ? hexToRgba(HEX_TILE.edge, 255) : HEX_EDGE;
  // A label reads on its tile: dark grey on the light end of the ramp, off-white on the dark end, each with the other's halo.
  const onDark = (f: HexFeature) => tOf(f) > HEX_LABEL_FLIP;
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
      getFillColor: (f) => fade(f, fill(f)),
      stroked: true,
      getLineColor: (f) => (f === selected ? withOpacity(SELECT, opacity) : fade(f, edge)),
      getLineWidth: (f) => (f === selected ? SELECTED_LINE_PX : imagery ? 1.25 : 1),
      lineWidthUnits: "pixels",
      updateTriggers: { getFillColor: trigger, getLineColor: trigger, getLineWidth: trigger },
      ...terrainProps(terrain, "drape"),
    }),
    new TextLayer<HexFeature>({
      id: `${id}:labels`,
      data: labelled,
      pickable: false,
      getPosition: (f) => f.geometry.coordinates as [number, number],
      getText: label,
      getSize: (f) => labelSize.get(f) ?? HEX_TILE.labelSize,
      sizeUnits: "pixels",
      getColor: (f) => fade(f, onDark(f) ? HEX_LABEL_LIGHT : HEX_LABEL),
      fontFamily: COUNT_FONT_FAMILY,
      fontWeight: 600,
      characterSet: "0123456789.k%",
      fontSettings: { sdf: true, buffer: 4 },
      outlineWidth: 0.35,
      outlineColor: HEX_LABEL_HALO,
      billboard: true,
      // Never tested against depth: on 3D terrain a hill in front of the billboard cut the label mid-number (232 read as "23").
      parameters: { cullMode: "none", depthCompare: "always" },
      updateTriggers: { getColor: trigger, getText: trigger },
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

/**
 * The system sans for counts and cell values: deck lays glyphs out by their own widths, and a monospace "." took a full
 * digit's width, so "1.5k" read "1. 5k". The system UI faces have tabular digits, so counts still line up.
 */
const COUNT_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

const COUNT_FONT = {
  fontFamily: COUNT_FONT_FAMILY,
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

type ColumnProps = { name: string; count: number; h3: string; top?: string; v?: number; tallest: boolean; aggregate: true; stack: number };
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

/** A ring lifted to height `z` (meters), a hair above the column top so the cap never z-fights with it. */
function liftRing(ring: GeoJSON.Position[], z: number): GeoJSON.Position[] {
  return ring.map(([lng, lat]) => [lng, lat, z * 1.002 + 2]);
}

/** Columns stand by `count`, by `v` (the sum of positive `v`, the layer's own measure before attributes) or on a basis. */
export type ColumnBy = "v" | HexBasis;

/**
 * Bins a result's features into H3 cells at `resolution` (lib/render/hexCells.ts, the same cells the flat tiles and the
 * cell card read) and stacks them (cached per result, resolution and basis): height is the cell's value on the basis
 * (count, sum of the measure, share, recency) over the tallest cell's, times COLUMN_HEIGHT_EDGES edge lengths. Each
 * column is registered with its cell, so a pick opens the cell's card.
 */
export function hexColumns(data: GeoJSON.FeatureCollection, resolution: number, by: ColumnBy, ctx: CellContext = COUNT_CONTEXT): Columned {
  let byKey = columnCache.get(data);
  if (!byKey) {
    byKey = new Map();
    columnCache.set(data, byKey);
  }
  // "v" is the sum of v: the measure the layer had before it declared attributes.
  const cellsCtx: CellContext = by === "v" ? { ...ctx, measure: { key: "v", label: "Value" } } : ctx;
  const cells = hexCells(data, resolution);
  const basis = usableBasis(by === "v" ? "sum" : by, cellsCtx, cells);
  const key = `${resolution}:${by}:${basis}:${cellsCtx.measure?.key ?? ""}:${cellsCtx.category?.key ?? ""}`;
  const cached = byKey.get(key);
  if (cached) return cached;
  const scale = basisScale(cells, basis, cellsCtx);
  // Recency stands from the oldest cell's newest date; the others from zero.
  const valueOf = (cell: HexCell) => {
    const v = scale.values.get(cell) ?? 0;
    return basis === "recency" ? v - scale.lo : v;
  };
  let max = 0;
  for (const cell of cells) max = Math.max(max, valueOf(cell));
  const heightM = getHexagonEdgeLengthAvg(resolution, UNITS.m) * COLUMN_HEIGHT_EDGES;
  const features: ColumnFeature[] = [];
  const caps: Feature[] = [];
  const label: Columned["label"] = [];
  for (const cell of cells) {
    const value = valueOf(cell);
    const ring = cellToBoundary(cell.h3, true);
    const names = new Map<string, number>();
    for (const f of cell.members) {
      const name = nameOf(f);
      if (name) names.set(name, (names.get(name) ?? 0) + 1);
    }
    const top = [...names]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, COLUMN_TOP)
      .map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
      .join(", ");
    // Every cell tied for the top takes purple (and its value), not just the first one found.
    const isTallest = max > 0 && value === max;
    const count = cell.members.length;
    const sum = basis === "sum" ? scale.values.get(cell) : undefined;
    const properties: ColumnProps = {
      name: `${count.toLocaleString("en-US")} ${count === 1 ? "feature" : "features"} in this cell`,
      count,
      h3: cell.h3,
      tallest: isTallest,
      aggregate: true,
      stack: value,
      ...(top && { top }),
      ...(sum !== undefined && { v: Math.round(sum * 100) / 100 }),
    };
    const feature: ColumnFeature = { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties };
    registerCell(feature, { cell, cells, basis, ctx: cellsCtx });
    features.push(feature);
    const z = (value / (max || 1)) * heightM;
    caps.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [liftRing(ring, z)] }, properties: { tallest: isTallest } });
    if (isTallest) {
      const [lat, lng] = cellToLatLng(cell.h3);
      const text = basis === "count" ? countLabel(count) : basisLabel(scale.values.get(cell), basis);
      if (text) label.push({ position: [lng, lat, z + heightM * 0.04 + 40], text });
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
  const encoding = encodingOf(op, ctx);
  const base = cellCtx(ctx);
  // Two measures on one column (spec §13): height is the size measure's sum per cell, the walls take the color
  // measure's mean on the ramp.
  const sizeAttr = encoding?.size ? (ctx.layer?.attributes ?? []).find((a) => a.key === encoding.size?.key) : undefined;
  const cellsCtx: CellContext = sizeAttr ? { ...base, measure: sizeAttr } : base;
  // The op's basis; else a layer that extrudes by value stands by its measure's sum (or v's, without one).
  const by: ColumnBy = op.hexBasis ?? (sizeAttr ? "sum" : ctx.style.extrude === "v" ? (cellsCtx.measure ? "sum" : "v") : "count");
  const resolution = columnResolution(ctx.zoom);
  const { cells, caps, max, heightM, label } = hexColumns(ctx.data, resolution, by, cellsCtx);
  const valueOf = (f: Feature) => Number(f.properties?.stack) || 0;
  const selected = ctx.selected && cells.features.includes(ctx.selected as ColumnFeature) ? ctx.selected : undefined;
  const color = encoding?.color;
  const members = color ? new Map(hexCells(ctx.data, resolution).map((c) => [c.h3, c.members])) : undefined;
  const wall = (f: Feature): Rgba => {
    if (!color || !members) return columnWallColor(valueOf(f), max, f.properties?.tallest === true);
    const t = cellColorT(members.get(String(f.properties?.h3)) ?? [], color);
    return t === null ? columnWallColor(valueOf(f), max, false) : [...encodeColor(t), Math.round(255 * HEX_COLUMN.topWallAlpha)];
  };
  return columnSet(
    `${deckLayerKey(ctx.deckId ?? op.layerId, ctx.terrain)}:columns${color ? ":encoded" : ""}`,
    cells,
    caps,
    color ? [] : label,
    (f) => (valueOf(f) / (max || 1)) * heightM,
    wall,
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
    out = { type: "FeatureCollection", features: data.features.filter((f) => f.properties?.delta === "a-only" && f.properties?.deltaEdge !== true && isArea(f)) };
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

const edgesMemo = new WeakMap<GeoJSON.FeatureCollection, { kept: GeoJSON.FeatureCollection; edges: GeoJSON.FeatureCollection }>();
/** A delta split into its drawn features and the earlier edges of changed areas, made once per collection. */
function splitEdges(data: GeoJSON.FeatureCollection): { kept: GeoJSON.FeatureCollection; edges: GeoJSON.FeatureCollection } {
  let out = edgesMemo.get(data);
  if (!out) {
    const edges = data.features.filter((f) => f.properties?.deltaEdge === true);
    out =
      edges.length === 0
        ? { kept: data, edges: { type: "FeatureCollection", features: [] } }
        : { kept: { ...data, features: data.features.filter((f) => f.properties?.deltaEdge !== true) }, edges: { type: "FeatureCollection", features: edges } };
    edgesMemo.set(data, out);
  }
  return out;
}

function deltaLayers(op: RenderOp, { data: all, selected, terrain }: OpContext): Layer[] {
  const opacity = Math.min(1, Math.max(0, op.opacity ?? 1));
  const id = `${deckLayerKey(`${op.layerId}${DELTA_TAG}`, terrain)}:${op.mode}`;
  const fade = (f: Feature, c: Rgba, siblingFade: number = SIBLING_FADE): Rgba => {
    const base = withOpacity(c, opacity);
    return selected && f !== selected ? withOpacity(base, siblingFade) : base;
  };
  // An area's outline and casing stay readable beside a selected one (AREA_OUTLINE_SIBLING_FADE); its fill fades.
  const strokeFade = (f: Feature) => (isArea(f) ? AREA_OUTLINE_SIBLING_FADE : SIBLING_FADE);
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
        fontFamily: COUNT_FONT_FAMILY,
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
  // Delta lines are native Mapbox lines (lib/render/nativeLines.ts); deck keeps the areas and points. The earlier edges
  // of changed areas (a glacier's 1966 outline under its 2015 one) draw apart, as a pink line under the later outline.
  const { kept: data, edges } = splitEdges(withoutLines(all));
  if (data.features.length === 0 && edges.features.length === 0) return [];
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
  const edgeLayers: Layer[] =
    edges.features.length > 0
      ? [
          new GeoJsonLayer({
            id: `${id}:edges`,
            data: edges,
            pickable: false,
            filled: false,
            getLineColor: (f: Feature) => fade(f, hexToRgba(WHITE_HEX, 230)),
            getLineWidth: DELTA_STROKE.polygon + 2 * DELTA_STROKE.casing,
            lineWidthUnits: "pixels",
            updateTriggers,
            ...terrainProps(terrain, "drape"),
          }),
          new GeoJsonLayer({
            id: `${id}:edges:line`,
            data: edges,
            pickable: false,
            filled: false,
            getLineColor: (f: Feature) => fade(f, DELTA_RGB["a-only"]),
            getLineWidth: DELTA_STROKE.polygon,
            lineWidthUnits: "pixels",
            updateTriggers,
            ...terrainProps(terrain, "drape"),
          }),
        ]
      : [];
  return [
    ...hatch,
    ...edgeLayers,
    new GeoJsonLayer({
      id: `${id}:casing`,
      data,
      pickable: false,
      filled: false,
      pointType: "circle",
      getLineColor: (f: Feature) => fade(f, WHITE, strokeFade(f)),
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
      getLineColor: (f: Feature) => fade(f, deltaColor(f), strokeFade(f)),
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

type TerrainTile = Parameters<TerrainLayer["getTiledTerrainData"]>[0];
type TerrainLoad = Parameters<TerrainLayer["loadTerrain"]>[0];

/**
 * The terrain copy with each tile's mesh cut exactly at the tile's edges. Deck's TerrainLayer grows every tile mesh by
 * one DEM pixel on each side so opaque tiles hide the cracks between them, which makes neighbours overlap in a band two
 * DEM pixels wide (about 5 km at zoom 5). Our mesh is transparent and shows the draped hex tiles and areas, so in that
 * band the translucent cover was blended twice: a dashed dark seam along every terrain tile edge across the hex cells
 * in 3D, plainest around zoom 5 where one cell spans a tile boundary. Exact edges still meet (adjacent tiles share the
 * same edge coordinates), and the skirts deck hangs below each tile still fill any crack from the edges' heights.
 */
export class SeamlessTerrainLayer extends TerrainLayer {
  static layerName = "SeamlessTerrainLayer";
  /** The exact bounds of the tile being loaded, set for the one synchronous loadTerrain call it makes. */
  private tileBounds: TerrainLoad["bounds"] | null = null;

  getTiledTerrainData(tile: TerrainTile) {
    const { viewport } = this.context;
    if (viewport.isGeospatial && "west" in tile.bbox) {
      const { west, south, east, north } = tile.bbox;
      const [x0, y0] = viewport.projectFlat([west, south]);
      const [x1, y1] = viewport.projectFlat([east, north]);
      this.tileBounds = [x0, y0, x1, y1];
    }
    try {
      return super.getTiledTerrainData(tile);
    } finally {
      this.tileBounds = null;
    }
  }

  loadTerrain(props: TerrainLoad) {
    return super.loadTerrain(this.tileBounds ? { ...props, bounds: this.tileBounds } : props);
  }
}

function terrainSourceLayer(token: string): Layer {
  return new SeamlessTerrainLayer({
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
  { mapboxToken = MAPBOX_TOKEN, labelInsets }: { mapboxToken?: string; labelInsets?: LabelInsets } = {},
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
    // A flow field draws as moving particles (lib/render/particles.ts, animated by the map), not as its grid nodes.
    if (loaded.result.flow) continue;
    const picked = state.selected?.layerId === op.layerId ? state.selected : undefined;
    // A feature picked on a compare's side B highlights there; side A (and every other mode) gets the rest.
    const selected = picked && picked.side !== "b" ? picked.feature : undefined;
    const selectedB = picked?.side === "b" ? picked.feature : undefined;
    const ctx: OpContext = {
      data: loaded.result.data,
      style: loaded.style,
      layer: loaded,
      selected,
      zoom: state.viewport.zoom,
      latitude: state.viewport.latitude,
      terrain,
      threeD: state.terrain && !state.flattened,
      labelInsets,
      basemap: state.basemap,
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
  main.push(...hoverLayers(state, terrain));
  if (terrain && a.length > 0) a.unshift(terrainSourceLayer(mapboxToken));
  if (terrain && b.length > 0) b.unshift(terrainSourceLayer(mapboxToken));
  return { main, a, b };
}

/** The ring around a feature the pointer is over in a layer row's top 10 (spec §12c: the list is synced with the map). */
export const HOVER_RING = { radiusPx: 15, widthPx: 2.5 } as const;

function hoverLayers(state: MapState, terrain: boolean): Layer[] {
  const hover = state.hover;
  if (!hover) return [];
  const op = state.renderOps.find((o) => o.layerId === hover.layerId);
  const at = featureCenter(hover.feature);
  if (!op?.visible || !at) return [];
  return [
    new ScatterplotLayer<{ position: [number, number] }>({
      id: `${hover.layerId}:hover`,
      data: [{ position: at }],
      pickable: false,
      stroked: true,
      filled: false,
      getPosition: (d) => d.position,
      getRadius: HOVER_RING.radiusPx,
      radiusUnits: "pixels",
      getLineColor: SELECT,
      getLineWidth: HOVER_RING.widthPx,
      lineWidthUnits: "pixels",
      parameters: { cullMode: "none", depthCompare: "always" },
      ...terrainProps(terrain, "offset"),
    }),
  ];
}

/**
 * Turns map state into deck.gl layer instances for each visible geojson render op (lines bring a casing), as one
 * list: `buildDeckLayerSets`' main set plus any swipe sides (without their own terrain copies). Heat ops yield only
 * their clicked feature's symbol here; Mapbox draws the heatmap.
 */
export function buildDeckLayers(state: MapState, options: { mapboxToken?: string; labelInsets?: LabelInsets } = {}): Layer[] {
  const { main, a, b } = buildDeckLayerSets(state, options);
  const sides = [...a, ...b].filter((l) => l.id !== DECK_TERRAIN_ID);
  return sides.length > 0 ? [...main, ...sides] : main;
}
