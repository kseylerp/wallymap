import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { ExpressionSpecification, FilterSpecification, LineLayerSpecification } from "mapbox-gl";
import type { StyleHints } from "@/layers/types";
import { compareBId, compareSideShown, effectiveMode, isHexCollection } from "@/lib/render/compareView";
import {
  COMPARE_COLORS,
  DELTA_LINE_COLORS,
  DARK_GREY,
  isPaletteColor,
  LINE,
  LINE_CLASSES,
  lineClassFor,
  lineColorFor,
  lineRampFor,
  SAGE,
  SIBLING_FADE,
  TRAIL_LINE,
  WHITE,
  type LineClass,
  type LineRecipe,
} from "@/lib/render/palette";
import { rampColor, rgbToHex } from "@/lib/render/ramp";
import { colorStops, declaredGroups, encodedAttribute, valueKey } from "@/lib/render/attributes";
import { colorT, encodeColor, ENCODED_LINE, resolveEncoding, sizeT, type Channel } from "@/lib/render/encode";
import type { MapState, RenderOp, Selection } from "@/lib/render/state";
import { chainParts, gradientExpression } from "@/lib/render/wally/routeLine";

/**
 * Data lines as native Mapbox line layers (owner, 2026-10-14: "why isn't it crisp/clean like in the Wally app?"). Deck
 * drew lines into per-tile terrain textures, which came out soft and jagged on 3D terrain; Mapbox draws a line layer
 * anti-aliased at a constant pixel width and drapes it on its own terrain, as the Wally app does. Each drawn line layer
 * (an op's layer, or a compare side) is one GeoJSON source `lines-<id>` with `lineMetrics` (for the route gradient)
 * and four line layers, bottom first:
 *
 *   `lines-<id>:casing`    white, the core's width + 2, at 0.9 (spec §11a: white for casings only)
 *   `lines-<id>:core`      the line class (sage, dashed or dotted), the score ramp, a compare color or the delta class
 *   `lines-<id>:dash`      T1 trails: dark grey 8px butt-capped dashes over the sage core, so the two alternate
 *   `lines-<id>:route`     named routes: Wally's purple → pink `line-gradient`, 3px
 *   `lines-<id>:selected`  the selected feature, purple 3.5px
 *
 * Every width is in pixels at every zoom. Pure helpers only; the Mapbox sync is `syncLineLayers` in
 * components/mapTiles.ts. Deck still draws points, areas, hex tiles, columns and a swiped compare's sides.
 */

export const LINES_PREFIX = "lines-";
export const lineSourceId = (id: string) => `${LINES_PREFIX}${id}`;

export const LINE_PARTS = ["casing", "core", "dash", "route", "selected"] as const;
export type LinePart = (typeof LINE_PARTS)[number];
/** The parts a click can land on: the casing is not inspectable. */
export const PICKABLE_PARTS: readonly LinePart[] = ["core", "dash", "route", "selected"];

export const lineLayerId = (id: string, part: LinePart) => `${lineSourceId(id)}:${part}`;

/** The selected line: purple 3.5px over a white casing 2px wider. */
export const SELECTED_LINE = { color: TRAIL_LINE.selected.color, width: TRAIL_LINE.selected.width, casing: TRAIL_LINE.selected.width + 2 } as const;

/** How a drawn line layer is colored. */
export type LineLook =
  /** The layer's line classes (sage, forest roads dashed, use trails dotted), named routes in the gradient. */
  | { kind: "classes" }
  /** Score lines: sage → pink → purple by the feature's `v` (0 to 100). */
  | { kind: "ramp" }
  /** One palette color asked for: a compare side (A purple, B pink) or the layer panel. */
  | { kind: "solid"; color: string }
  /** A compare delta (the change view): A only pink, B only purple, unchanged sage. */
  | { kind: "delta" }
  /**
   * The encoded ordinal (spec §12c, an attribute with `encode: "color"`): each class of `key` on the sage → pink →
   * purple ramp, easy to hard, in the declared order (`stops`: raw value to color); a value it does not name draws sage.
   */
  | { kind: "facet"; key: string; stops: [string, string][] }
  /**
   * Two measures on one line (spec §13): width from the size channel (the square root of its share of the largest),
   * color from the color channel on the sage → pink → purple ramp. A series layer (river pulse) moves both every frame
   * through feature state (`sz`, `ct`), over the values the source was uploaded with.
   */
  | { kind: "encoded"; size?: Pick<Channel, "key" | "extent">; color?: Pick<Channel, "key" | "extent" | "levels"> };

/** One drawn line layer: what the sync uploads and styles, and what a pick maps back into. */
export type LineEntry = {
  /** The drawn id: the layer's id, or side B's `<layerId>~b`. */
  id: string;
  /** The app layer behind it. */
  layerId: string;
  side?: "b";
  /** The visible features (filters, time window, compare side or delta); a pick's `i` indexes into these. */
  data: FeatureCollection;
  look: LineLook;
  opacity: number;
  /** False for the side a toggle compare is not showing (kept on the map, hidden, so a flip does not re-upload). */
  shown: boolean;
  /** Index in `data.features` of the selected feature, or -1. */
  selected: number;
  /** True on a basemap with satellite imagery: encoded lines take a wider minimum and the trails' casing there. */
  imagery?: boolean;
  /**
   * An attribute with `encode: "dash"` (pipelines by kind): each of its values, in declared order, takes a dash pattern
   * (LINE_DASHES), so kinds tell apart by dash where color carries something else.
   */
  dashBy?: { key: string; values: string[][] };
};

/** Dash patterns (pixels, [on, off]) for the values of a dash attribute, in declared order: solid, dashed, dotted, long. */
export const LINE_DASHES: readonly [number, number][] = [[0, 0], [8, 5], [2.5, 5], [16, 5]];

/** A facet level that stands for no rating ("Not rated", "Unrated"): drawn as a thin grey dash, never as the easiest. */
export const UNRATED_LABEL = /not rated|unrated|no grade|ungraded|unknown/i;

/** How an unrated line draws: a thin dark grey dash on its casing, so it never reads as the easiest level. */
export const UNRATED_LINE = { color: DARK_GREY, width: 1.25, dash: [2, 3] as [number, number], opacity: 0.75 } as const;

/** True when an op on a layer with these hints draws as lines (lines mode; line layers have no column form). */
export function drawsNativeLines(op: Pick<RenderOp, "mode">, style: Pick<StyleHints, "geometry">): boolean {
  return op.mode === "lines" || (op.mode === "columns" && style.geometry === "line");
}

export function isLineGeometry(g: Geometry | null | undefined): boolean {
  return g?.type === "LineString" || g?.type === "MultiLineString";
}

/** Geometry a line layer strokes: lines, and polygon rings (a polygon layer drawn as lines). Points have no stroke. */
function isStrokable(g: Geometry | null | undefined): boolean {
  return isLineGeometry(g) || g?.type === "Polygon" || g?.type === "MultiPolygon";
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(x) ? x : 1));
}

function indexOf(data: FeatureCollection, feature: Feature | undefined): number {
  return feature ? data.features.indexOf(feature) : -1;
}

/**
 * The line layers `view` (the visible state, lib/render/view.ts: filters, time window and compare applied) draws
 * natively, bottom first in render-op order. A swiped compare's sides are not here: Mapbox cannot clip a layer to one
 * side of the handle, so deck draws them in the clipped side overlays (lib/render/deck.ts).
 */
export function lineEntries(view: MapState): LineEntry[] {
  const entries: LineEntry[] = [];
  const compare = view.compare;
  const mode = effectiveMode(view);
  const imagery = view.basemap === "satellite" || view.basemap === "outdoors-satellite";
  for (const op of view.renderOps) {
    if (!op.visible) continue;
    const loaded = view.layers[op.layerId];
    if (loaded?.result.kind !== "geojson") continue;
    const opacity = clamp01(op.opacity ?? 1);
    const picked = view.selected?.layerId === op.layerId ? view.selected : undefined;
    const compared = compare?.layerId === op.layerId && mode !== undefined;
    const data = loaded.result.data;
    if (compared && mode === "delta") {
      // Every op mode strokes a delta's lines; H3 cells extrude in deck instead.
      if (isHexCollection(data) || !data.features.some((f) => isLineGeometry(f.geometry))) continue;
      const selected = picked && picked.side !== "b" ? indexOf(data, picked.feature) : -1;
      entries.push({ id: op.layerId, layerId: op.layerId, data, look: { kind: "delta" }, opacity, shown: true, selected });
      continue;
    }
    if (!drawsNativeLines(op, loaded.style)) continue;
    if (compared && mode === "swipe") continue;
    if (compared) {
      // Toggle: both sides stay on the map; the one not showing is hidden.
      const bId = compareBId(op.layerId);
      const loadedB = view.layers[bId];
      const sides: { id: string; side?: "b"; color: string; data?: FeatureCollection }[] = [
        { id: op.layerId, color: COMPARE_COLORS.a, data },
        { id: bId, side: "b", color: COMPARE_COLORS.b, data: loadedB?.result.kind === "geojson" ? loadedB.result.data : undefined },
      ];
      for (const s of sides) {
        if (!s.data) continue;
        const mine = picked && (picked.side === "b") === (s.side === "b") ? picked.feature : undefined;
        entries.push({
          id: s.id,
          layerId: op.layerId,
          ...(s.side && { side: s.side }),
          data: s.data,
          look: { kind: "solid", color: s.color },
          opacity,
          shown: compareSideShown(view, s.id),
          selected: indexOf(s.data, mine),
        });
      }
      continue;
    }
    const requested = isPaletteColor(op.color) ? lineColorFor(op.color) : undefined;
    const encoded = encodedAttribute(loaded);
    const pair = requested ? null : resolveEncoding(loaded, op, data);
    const look: LineLook = requested
      ? { kind: "solid", color: requested }
      : pair
        ? { kind: "encoded", ...(pair.size && { size: { key: pair.size.key, extent: pair.size.extent } }), ...(pair.color && { color: pair.color }) }
        : encoded
          ? { kind: "facet", key: encoded.key, stops: colorStops(encoded).filter(([v]) => !UNRATED_LABEL.test(encoded.levels?.find((l) => String(l.value) === v)?.label ?? "")) }
          : loaded.style.unit === "score"
            ? { kind: "ramp" }
            : { kind: "classes" };
    const dashAttr = loaded.attributes?.find((a) => a.encode === "dash" && (a.levels?.length ?? 0) > 1);
    const dashBy = dashAttr ? { key: dashAttr.key, values: declaredGroups(dashAttr).map((g) => g.values) } : undefined;
    entries.push({
      id: op.layerId,
      layerId: op.layerId,
      data,
      look,
      opacity,
      shown: true,
      selected: indexOf(data, picked?.feature),
      ...(imagery && { imagery }),
      ...(dashBy && { dashBy }),
    });
  }
  return entries;
}

/** Source feature properties: the index back into the entry's data, the line class, and what the paint reads. */
export type LineProps = { i: number; cls: LineClass | "delta"; v: number | null; delta?: string; fv?: string; sz?: number; ct?: number; dk?: number };

const sourceMemo = new WeakMap<FeatureCollection, Map<string, FeatureCollection>>();

/**
 * The GeoJSON a line entry uploads, made once per data object and look (so a pan, a selection or an opacity change
 * never re-uploads, and a filter or time step uploads its own narrowed collection). Features keep only what the paint
 * reads (`i`, `cls`, `v`, `delta`): a click maps `i` back to the original feature, so the inspect card shows every
 * property as before. Points are dropped; a delta keeps only its lines (deck draws its areas and points); a route's
 * ways are chained so the gradient runs along it (chainParts).
 */
export function lineSourceData(entry: Pick<LineEntry, "data" | "layerId" | "look" | "dashBy">): FeatureCollection {
  const look = entry.look;
  const key = `${entry.layerId}|${entry.dashBy?.key ?? ""}|${look.kind}${look.kind === "facet" ? `|${look.key}` : ""}${
    look.kind === "encoded" ? `|${look.size?.key ?? ""}:${look.size?.extent?.join(",") ?? ""}|${look.color?.key ?? ""}:${look.color?.extent?.join(",") ?? ""}` : ""
  }`;
  let byKey = sourceMemo.get(entry.data);
  if (!byKey) {
    byKey = new Map();
    sourceMemo.set(entry.data, byKey);
  }
  const hit = byKey.get(key);
  if (hit) return hit;
  const { kind } = entry.look;
  const features: Feature[] = [];
  entry.data.features.forEach((f, i) => {
    const g = f.geometry;
    if (kind === "delta" ? !isLineGeometry(g) : !isStrokable(g)) return;
    // A facet keeps the line's class too, so its sage lines (the easy level, no value) can keep the T1 dashes.
    const cls: LineProps["cls"] = kind === "classes" || kind === "facet" ? lineClassFor(entry.layerId, f.properties) : kind === "delta" ? "delta" : "solid";
    const n = Number(f.properties?.v);
    const properties: LineProps = { i, cls, v: Number.isFinite(n) ? n : null };
    if (kind === "delta") properties.delta = String(f.properties?.delta ?? "both");
    if (entry.look.kind === "facet") properties.fv = valueKey(f.properties?.[entry.look.key]) ?? "";
    if (entry.dashBy) {
      const v = valueKey(f.properties?.[entry.dashBy.key]);
      const k = v === undefined ? -1 : entry.dashBy.values.findIndex((vals) => vals.includes(v));
      properties.dk = k < 0 ? 0 : k % LINE_DASHES.length;
    }
    if (look.kind === "encoded") {
      if (look.size) properties.sz = round3(sizeT(f.properties?.[look.size.key], look.size.extent));
      if (look.color) properties.ct = round3(colorT(f.properties?.[look.color.key], look.color) ?? -1);
    }
    const geometry = cls === "route" && (g.type === "LineString" || g.type === "MultiLineString") ? chainParts(g) : g;
    // The index doubles as the feature id, so a series layer can move each line by feature state.
    features.push({ type: "Feature", id: i, geometry, properties });
  });
  const out: FeatureCollection = { type: "FeatureCollection", features };
  byKey.set(key, out);
  return out;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * A dash in pixels ([on, off], as the legend draws it) as Mapbox's `line-dasharray`, which counts in line widths and,
 * with round caps, adds half a width of cap to each end of every dash. So the dash is shortened by one width and the
 * gap lengthened by one, and a dash as long as the line is wide (use trails) becomes a round dot. [0, 0] is solid.
 */
export function dashInWidths(dash: readonly [number, number], width: number = LINE.width): [number, number] {
  const [on, off] = dash;
  if (on <= 0 || off <= 0) return [1, 0];
  return [Math.max(0, on - width) / width, (off + width) / width];
}

/** The `line-color` of a ramped line: the layer's line ramp (OKLCH, as the legend) sampled at nine stops over `v` 0 to 100. */
export function rampLineColor(layerId: string): ExpressionSpecification {
  const ramp = lineRampFor(layerId);
  const stops = Array.from({ length: 9 }, (_, k) => [k * 12.5, rgbToHex(rampColor(ramp, k / 8))]).flat();
  return ["interpolate", ["linear"], ["to-number", ["get", "v"], 0], ...stops] as ExpressionSpecification;
}

/** The `line-color` of a facet line: a `match` on the facet value (`fv`), unnamed values sage. */
export function facetLineColor(stops: [string, string][]): string | ExpressionSpecification {
  if (stops.length === 0) return SAGE;
  // A value the scale does not rate draws as UNRATED_LINE, never as the easiest level's sage.
  return ["match", ["get", "fv"], ...stops.flat(), UNRATED_LINE.color] as ExpressionSpecification;
}

/** True (an expression) for a facet line whose value is one of the rated levels. */
function ratedExpr(stops: [string, string][]): ExpressionSpecification {
  return ["in", ["get", "fv"], ["literal", stops.map(([v]) => v)]] as ExpressionSpecification;
}

/** The dash per value of a dash attribute (`dk`), as `line-dasharray`. */
function dashByExpr(): ExpressionSpecification {
  return [
    "match",
    ["get", "dk"],
    ...LINE_DASHES.flatMap((d, k) => (k === 0 ? [] : [k, ["literal", dashInWidths(d)]])),
    ["literal", [1, 0]],
  ] as ExpressionSpecification;
}

/** Classes drawn in the core layer (not routes), with their colors and dashes. */
const CORE_CLASSES = (Object.keys(LINE_CLASSES) as LineClass[]).filter((c) => !("gradient" in LINE_CLASSES[c]));
/** Classes whose core is a solid `under` color with dashes of `color` drawn over it (T1 trails). */
const TWO_TONE = CORE_CLASSES.filter((c) => "under" in LINE_CLASSES[c]);
const coreOf = (c: LineClass): string => {
  const cls: { color: string; under?: string } = LINE_CLASSES[c];
  return cls.under ?? cls.color;
};

/** A two-tone dash in pixels as `line-dasharray` with butt caps: exact widths, so dark grey and sage alternate evenly. */
export function buttDashInWidths([on, off]: readonly [number, number], width: number = LINE.width): [number, number] {
  return [on / width, off / width];
}

function coreColor(entry: Pick<LineEntry, "look" | "layerId">): string | ExpressionSpecification {
  switch (entry.look.kind) {
    case "solid":
      return entry.look.color;
    case "ramp":
      return rampLineColor(entry.layerId);
    case "delta":
      return ["match", ["get", "delta"], "a-only", DELTA_LINE_COLORS["a-only"], "b-only", DELTA_LINE_COLORS["b-only"], DELTA_LINE_COLORS.both];
    case "classes":
      return ["match", ["get", "cls"], ...CORE_CLASSES.flatMap((c) => [c, coreOf(c)]), SAGE] as ExpressionSpecification;
    case "facet":
      return facetLineColor(entry.look.stops);
    case "encoded":
      return entry.look.color ? encodedLineColor() : SAGE;
  }
}

/** A share (0..1) from feature state when a series has set one, else from the uploaded property. */
function shareOf(prop: "sz" | "ct"): ExpressionSpecification {
  return ["to-number", ["coalesce", ["feature-state", prop], ["get", prop]], -1];
}

/**
 * The `line-width` of an encoded line: the size share (the square root of the flow's share of the largest) from 1.25 px
 * to 12 px; its casing a pixel wider at the thin end and two at the wide end, so a creek is not all white halo. On
 * imagery the thinnest is 1.75 px and the casing two pixels wider throughout, as the trails' (a thin river read as
 * nothing on the photo).
 */
export function encodedLineWidth(extra = 0, casing = false, imagery = false): ExpressionSpecification {
  const min = imagery ? ENCODED_LINE.imageryMinPx : ENCODED_LINE.minPx;
  const lo = min + extra + (casing ? (imagery ? ENCODED_LINE.imageryCasingPx : ENCODED_LINE.casingMinPx) : 0);
  const hi = ENCODED_LINE.maxPx + extra + (casing ? (imagery ? ENCODED_LINE.imageryCasingPx : ENCODED_LINE.casingMaxPx) : 0);
  return ["interpolate", ["linear"], ["max", 0, shareOf("sz")], 0, lo, 1, hi];
}

/** The `line-color` of an encoded line: its color share on the ramp at nine stops; no value draws sage. */
export function encodedLineColor(): ExpressionSpecification {
  const stops = Array.from({ length: 9 }, (_, k) => [k / 8, rgbToHex(encodeColor(k / 8))]).flat();
  return ["case", ["<", shareOf("ct"), 0], SAGE, ["interpolate", ["linear"], shareOf("ct"), ...stops]] as ExpressionSpecification;
}

function classWidth(c: LineClass): number {
  const cls: LineRecipe = LINE_CLASSES[c];
  return cls.width ?? LINE.width;
}

function coreDash(): ExpressionSpecification {
  const dashed = CORE_CLASSES.filter((c) => LINE_CLASSES[c].dash[0] > 0 && !TWO_TONE.includes(c));
  return ["match", ["get", "cls"], ...dashed.flatMap((c) => [c, ["literal", dashInWidths(LINE_CLASSES[c].dash, classWidth(c))]]), ["literal", [1, 0]]] as ExpressionSpecification;
}

/** The core's width per class: a class's own width (forest roads 1.75px), else the data line width. */
function coreWidth(): number | ExpressionSpecification {
  const own = CORE_CLASSES.filter((c) => classWidth(c) !== LINE.width);
  if (own.length === 0) return LINE.width;
  return ["match", ["get", "cls"], ...own.flatMap((c) => [c, classWidth(c)]), LINE.width] as ExpressionSpecification;
}

/**
 * While a feature of an encoded network (river pulse) is selected, the rest of its layer fades only to this share: the
 * network is the picture, and at SIBLING_FADE it vanished on satellite behind one selected reach (coordinator, 2026-10-17).
 */
export const ENCODED_SIBLING_FADE = 0.75;

/** `opacity`, with the siblings of a selected feature faded (by `fade`) and the selected one at `selectedOpacity`. */
function faded(entry: Pick<LineEntry, "opacity" | "selected">, base: number, selectedOpacity: number, fade = SIBLING_FADE): number | ExpressionSpecification {
  const value = entry.opacity * base;
  if (entry.selected < 0) return value;
  return ["case", ["==", ["get", "i"], entry.selected], entry.opacity * selectedOpacity, value * fade];
}

const isRoute: FilterSpecification = ["==", ["get", "cls"], "route"];
const notRoute: FilterSpecification = ["!=", ["get", "cls"], "route"];

/** The four line layers of an entry, bottom first. */
export function lineLayerSpecs(entry: LineEntry): LineLayerSpecification[] {
  const source = lineSourceId(entry.id);
  const classes = entry.look.kind === "classes";
  // A facet colors segments by their value; named routes keep the Wally gradient (and its casing) under it too.
  const routed = classes || entry.look.kind === "facet";
  const layout = { "line-cap": "round", "line-join": "round", visibility: entry.shown ? "visible" : "none" } as const;
  const sel: ExpressionSpecification = ["==", ["get", "i"], entry.selected];
  const routeCasing = LINE_CLASSES.route.casing;
  const encoded = entry.look.kind === "encoded" && entry.look.size !== undefined;
  const facet = entry.look.kind === "facet" ? entry.look : undefined;
  const imagery = entry.imagery === true;
  // A network colored by a category (trail difficulty) is the picture too: at SIBLING_FADE Sedona's trails vanished on Topo.
  const fade = encoded || entry.look.kind === "facet" ? ENCODED_SIBLING_FADE : SIBLING_FADE;
  const baseCasing: number | ExpressionSpecification = encoded
    ? encodedLineWidth(0, true, imagery)
    : routed
      ? ["match", ["get", "cls"], "route", routeCasing, LINE.casing]
      : LINE.casing;
  const casingWidth: number | ExpressionSpecification = entry.selected < 0 || encoded ? baseCasing : ["case", sel, SELECTED_LINE.casing, baseCasing];
  const core: LineLayerSpecification = {
    id: lineLayerId(entry.id, "core"),
    type: "line",
    source,
    // Encoded lines: the widest draw last, so a big river is never cut by a small tributary's casing.
    layout: encoded ? { ...layout, "line-sort-key": ["to-number", ["get", "sz"], 0] } : layout,
    paint: {
      "line-color": coreColor(entry),
      // Classes with their own width (thin forest roads); an encoded size its share; an unrated facet line thin; the
      // rest at the data line width.
      "line-width": classes
        ? coreWidth()
        : encoded
          ? encodedLineWidth(0, false, imagery)
          : facet && facet.stops.length > 0
            ? (["case", ratedExpr(facet.stops), LINE.width, UNRATED_LINE.width] as ExpressionSpecification)
            : LINE.width,
      // The selected feature draws in the highlight layer above.
      "line-opacity": faded(entry, 1, 0, fade),
      ...(entry.dashBy
        ? { "line-dasharray": dashByExpr() }
        : classes
          ? { "line-dasharray": coreDash() }
          : facet && facet.stops.length > 0
            ? { "line-dasharray": ["case", ratedExpr(facet.stops), ["literal", [1, 0]], ["literal", dashInWidths(UNRATED_LINE.dash, UNRATED_LINE.width)]] as ExpressionSpecification }
            : {}),
    },
    ...(routed && { filter: notRoute }),
  };
  // T1: the over color's dashes on the solid core (nothing to draw unless the layer keeps its classes). Under a facet the
  // lines it draws sage (the easy level, or no value) keep them too: plain sage vanishes on green Topo (owner, 2026-10-14).
  const [twoTone] = TWO_TONE;
  const colored = entry.look.kind === "facet" ? entry.look.stops.filter(([, color]) => color.toUpperCase() !== SAGE.toUpperCase()).map(([v]) => v) : [];
  const dashFilter: FilterSpecification =
    classes && twoTone
      ? ["==", ["get", "cls"], twoTone]
      : entry.look.kind === "facet" && twoTone
        ? ["all", ["==", ["get", "cls"], twoTone], ["!", ["in", ["get", "fv"], ["literal", colored]]], ["in", ["get", "fv"], ["literal", entry.look.stops.map(([v]) => v)]]]
        : ["==", ["get", "cls"], "none"];
  const dash: LineLayerSpecification = {
    id: lineLayerId(entry.id, "dash"),
    type: "line",
    source,
    filter: dashFilter,
    layout: { ...layout, "line-cap": "butt" },
    paint: {
      "line-color": twoTone ? LINE_CLASSES[twoTone].color : SAGE,
      "line-width": LINE.width,
      "line-opacity": faded(entry, 1, 0, fade),
      ...(twoTone && { "line-dasharray": buttDashInWidths(LINE_CLASSES[twoTone].dash) }),
    },
  };
  return [
    {
      id: lineLayerId(entry.id, "casing"),
      type: "line",
      source,
      layout,
      paint: { "line-color": WHITE, "line-width": casingWidth, "line-opacity": faded(entry, LINE.casingOpacity, 1, fade) },
    },
    core,
    dash,
    {
      id: lineLayerId(entry.id, "route"),
      type: "line",
      source,
      // A requested color, a score ramp or a delta replaces the class look, routes included: nothing to draw here.
      filter: routed ? isRoute : ["==", ["get", "cls"], "none"],
      layout,
      paint: { "line-gradient": gradientExpression(), "line-width": LINE_CLASSES.route.width, "line-opacity": faded(entry, 1, 0, fade) },
    },
    {
      id: lineLayerId(entry.id, "selected"),
      type: "line",
      source,
      filter: sel,
      layout,
      paint: { "line-color": SELECTED_LINE.color, "line-width": encoded ? encodedLineWidth(1, false, imagery) : SELECTED_LINE.width, "line-opacity": entry.opacity },
    },
  ];
}

/** The drawn id and part behind a native line layer id (`lines-<id>:<part>`), or null for any other layer. */
export function parseLineLayerId(layerId: string): { id: string; part: LinePart } | null {
  if (!layerId.startsWith(LINES_PREFIX)) return null;
  const cut = layerId.lastIndexOf(":");
  if (cut <= LINES_PREFIX.length) return null;
  const part = layerId.slice(cut + 1) as LinePart;
  if (!LINE_PARTS.includes(part)) return null;
  return { id: layerId.slice(LINES_PREFIX.length, cut), part };
}

/** What `map.queryRenderedFeatures` returns for a native line (the fields read). */
export type LineHit = { layer?: { id: string } | null; properties?: Record<string, unknown> | null };

/**
 * A click on a native line as a selection: the hit's layer names the entry (and so the app layer and compare side), its
 * `i` the original feature in the entry's data, so the card, the highlight and every property are exactly what the
 * deck pick gave. The casing, a hidden toggle side, an unknown layer or a stale index give null.
 */
export function linePickToSelection(
  hit: LineHit | null | undefined,
  entries: ReadonlyMap<string, LineEntry>,
  known: Record<string, unknown>,
  lngLat: [number, number],
  screen?: { x: number; y: number },
): Selection | null {
  const parsed = hit?.layer ? parseLineLayerId(hit.layer.id) : null;
  if (!parsed || !PICKABLE_PARTS.includes(parsed.part)) return null;
  const entry = entries.get(parsed.id);
  if (!entry || !entry.shown || !(entry.layerId in known)) return null;
  const i = Number(hit?.properties?.i);
  const feature = Number.isInteger(i) ? entry.data.features[i] : undefined;
  if (!feature) return null;
  return { layerId: entry.layerId, feature, lngLat, ...(screen && { screen }), ...(entry.side && { side: entry.side }) };
}
