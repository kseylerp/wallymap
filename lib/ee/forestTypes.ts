/**
 * Forest Typology (ForTy) on Earth Engine: the images the forest-types layer draws and reads (spec §14).
 *
 * Assets (Nature Trace publisher catalog, read 2026-10-23 with the project's credentials):
 *   - 2020 baseline v1.0: `projects/nature-trace/assets/forest_typology/forest_typology_2020_v1_0_collection`, an
 *     IMAGE_COLLECTION of tiles in UTM, 10 m, five uint8 bands: PrimaryForest, NaturallyRegeneratingForest,
 *     PlantedForest, PlantationForest, TreeCropsAndAgroforestry. Each is the class probability times 250 (0..250; the
 *     largest seen is 249 over Danum Valley and Para, and the five never sum past 250 by more than rounding). The sixth
 *     class, other land, is what is left: 250 minus the sum. A published label image sits beside it
 *     (`forest_typology_2020_v1_0_classification`, band `classification`, 1 primary .. 6 other land), but its
 *     pyramid averages the class codes, so zoomed out it would invent classes; the label here is always the most
 *     likely of the six probabilities, which matches it at 10 m (checked at nine sites).
 *   - Yearly series 2017 to 2025, beta: `projects/nature-trace/assets/forest_typology/v2_beta/<year>`, one
 *     IMAGE_COLLECTION per year (updated 2026-10-21), seven uint8 bands B0..B6 that sum to 250. Read against the 2020
 *     baseline at nine sites: B0 primary, B1 naturally regenerating, B2 planted, B3 plantation, B4 tree crops and
 *     agroforestry, B5 other land (water, towns, fields, clear-cuts); B6 stays at 4 to 8 everywhere sampled
 *     (undocumented) and is left out. An Oregon Coast Range clear-cut reads other land in 2017 and planted forest by
 *     2025; a Sabah block goes from other land in 2020 to tree crops in 2025.
 *   - Also in the folder, not used: `natural_forest_2020_v1_0_collection` (the earlier natural-forest probability map).
 * ForTy's tiles reach past the shore with every probability 0, which reads as "other land" (250 minus nothing): the sea
 * and lakes are masked out with ESA WorldCover 2021's permanent water class (`ESA/WorldCover/v200`, band Map, 80), so
 * the map draws no grey over the water and the shares of the view count land only.
 */
import {
  add,
  addBands,
  and,
  constantImage,
  divide,
  eq,
  gte,
  lte,
  loadCollection,
  max,
  neq,
  mosaic,
  multiply,
  pixelArea,
  point,
  rectangle,
  reduceBands,
  reduceRegion,
  rename,
  select,
  subtract,
  toFloat,
  unmask,
  updateMask,
  visualize,
  type EeNode,
} from "./expr";
import { DARK_GREY, PINK, PURPLE, SAGE } from "@/lib/render/palette";
import { oklchToRgb, rgbToHex, rgbToOklch, hexToRgb } from "@/lib/render/ramp";
import type { BBox } from "@/layers/types";
import { bboxAreaKm2 } from "@/layers/types";

const ROOT = "projects/nature-trace/assets/forest_typology";
export const BASELINE_COLLECTION = `${ROOT}/forest_typology_2020_v1_0_collection`;
export const YEAR_COLLECTION = (year: number) => `${ROOT}/v2_beta/${year}`;
export const BASELINE_BANDS = ["PrimaryForest", "NaturallyRegeneratingForest", "PlantedForest", "PlantationForest", "TreeCropsAndAgroforestry"];
export const YEAR_BANDS = ["B0", "B1", "B2", "B3", "B4", "B5"];
/** A probability of 1 is stored as 250. */
export const PROBABILITY_SCALE = 250;
export const FIRST_YEAR = 2017;
export const LAST_YEAR = 2025;
export const YEARS: number[] = Array.from({ length: LAST_YEAR - FIRST_YEAR + 1 }, (_, i) => FIRST_YEAR + i);
/** "Only confident pixels": the most likely class has at least this probability. */
export const CONFIDENT = 0.7;

/** Shift a palette color's OKLCH lightness (and scale its chroma), so derived classes stay in the palette's family. */
function shade(hex: string, dl: number, chroma = 1): string {
  const [l, c, h] = rgbToOklch(hexToRgb(hex));
  return rgbToHex(oklchToRgb([Math.min(0.97, Math.max(0.05, l + dl)), c * chroma, h]));
}

export type ForestClass = { code: number; key: string; label: string; color: string; natural: boolean; help: string };

/**
 * The six classes (FAO Forest Resources Assessment definitions, as ForTy uses them), each with its map color from the
 * palette (spec §11): natural forest in the sage family (primary deep, regenerating sage), planted forest in the purple
 * family (planted light, plantation purple), tree crops pink, other land dark grey drawn faint.
 */
export const CLASSES: ForestClass[] = [
  { code: 1, key: "primary", label: "Primary forest", color: shade(SAGE, -0.33, 1.25), natural: true, help: "Naturally regenerated forest of native trees with no clearly visible sign of human activity, where ecological processes are not significantly disturbed." },
  { code: 2, key: "naturallyRegenerating", label: "Naturally regenerating forest", color: SAGE, natural: true, help: "Forest grown back by itself (natural seeding or sprouting) where people have logged, cleared or otherwise left visible marks." },
  { code: 3, key: "planted", label: "Planted forest", color: shade(PURPLE, 0.17, 0.7), natural: false, help: "Forest grown mainly from planted or seeded trees that is not managed as an intensive plantation, such as replanted timber land and restoration." },
  { code: 4, key: "plantation", label: "Plantation forest", color: PURPLE, natural: false, help: "Intensively managed planted forest of one or two species, evenly aged and regularly spaced, grown for wood (acacia, eucalyptus, pine)." },
  { code: 5, key: "treeCrops", label: "Tree crops and agroforestry", color: PINK, natural: false, help: "Trees grown for food or other products than wood, such as oil palm, rubber, cocoa, coffee and fruit orchards, and trees mixed with crops." },
  { code: 6, key: "other", label: "Other land", color: DARK_GREY, natural: false, help: "Land that is not forest or tree crops: fields, grassland, towns, bare ground, water and recently cleared land." },
];
export const OTHER_CODE = 6;
/** How opaque other land is drawn (the forest classes are opaque), so the map still reads where there is no forest. */
export const OTHER_ALPHA = 0.3;

/** Where natural forest went, for the change view: lost area in the compare grammar's pink, one shade per target. */
export type ConversionTarget = { code: number; key: string; label: string; color: string; classes: number[] };
export const TARGETS: ConversionTarget[] = [
  { code: 1, key: "toPlantation", label: "Plantation or planted forest", color: shade(PINK, -0.22, 1.1), classes: [3, 4] },
  { code: 2, key: "toTreeCrops", label: "Tree crops and agroforestry", color: PINK, classes: [5] },
  { code: 3, key: "toOther", label: "Other land (cleared)", color: shade(PINK, 0.1, 0.8), classes: [6] },
];
/** Natural forest still standing at the end of a change view: the grammar's "unchanged", dark grey and faint. */
export const UNCHANGED_COLOR = DARK_GREY;
export const UNCHANGED_ALPHA = 0.25;

export type Source = { kind: "baseline" } | { kind: "year"; year: number };

export const sourceLabel = (s: Source) => (s.kind === "baseline" ? "2020 baseline (v1.0)" : `${s.year} (yearly beta)`);

export const WORLDCOVER = "ESA/WorldCover/v200";
/** Where WorldCover 2021 is not permanent water (1), masked where it has no data. */
export const notWater = (): EeNode => neq(select(mosaic(loadCollection(WORLDCOVER)), ["Map"]), 80);

/** The six class probabilities (0..250), bands primary .. other, for the baseline or a year. */
export function probabilities(source: Source): EeNode {
  const names = CLASSES.map((c) => c.key);
  if (source.kind === "year") return select(mosaic(loadCollection(YEAR_COLLECTION(source.year))), YEAR_BANDS, names);
  const five = select(mosaic(loadCollection(BASELINE_COLLECTION)), BASELINE_BANDS, names.slice(0, 5));
  const other = rename(max(subtract(PROBABILITY_SCALE, reduceBands(five, "sum")), 0), ["other"]);
  return addBands(five, other);
}

/** The most likely class (1..6) of a probability stack; a tie goes to the later class. */
export function mostLikely(p6: EeNode): EeNode {
  return rename(reduceBands(multiply(eq(p6, reduceBands(p6, "max")), constantImage(CLASSES.map((c) => c.code))), "max"), ["class"]);
}

/** The most likely class's probability, 0..250. */
export const topProbability = (p6: EeNode) => reduceBands(p6, "max");

/** The class image, masked to confident pixels when `minConfidence` > 0. */
export function classes(source: Source, minConfidence: number): EeNode {
  const p6 = probabilities(source);
  const cls = updateMask(mostLikely(p6), notWater());
  return minConfidence > 0 ? updateMask(cls, gte(topProbability(p6), minConfidence * PROBABILITY_SCALE)) : cls;
}

/** Per-pixel opacity: other land faint, the forest classes solid. */
function classAlpha(cls: EeNode): EeNode {
  return subtract(1, multiply(eq(cls, OTHER_CODE), 1 - OTHER_ALPHA));
}

/** The class map as an RGB picture with other land faint (the tile route draws this). */
export function classTiles(source: Source, minConfidence: number): EeNode {
  const cls = classes(source, minConfidence);
  return updateMask(visualize(cls, { min: 1, max: CLASSES.length, palette: CLASSES.map((c) => c.color) }), classAlpha(cls));
}

/**
 * Where natural forest (primary or naturally regenerating) in `since` is something else in `to`: 1 plantation or
 * planted, 2 tree crops, 3 other land; 0 natural forest still standing. Masked elsewhere, and with `minConfidence` > 0
 * where either year's class is less sure than that.
 */
export function conversion(since: number, to: number, minConfidence: number): EeNode {
  const pa = probabilities({ kind: "year", year: since });
  const pb = probabilities({ kind: "year", year: to });
  const a = mostLikely(pa);
  const b = mostLikely(pb);
  const naturalBefore = lte(a, 2);
  // 0 for natural forest (classes 1 and 2), 1 for classes 3 and 4, 2 for 5, 3 for 6.
  const code = rename(add(add(gte(b, 3), gte(b, 5)), gte(b, 6)), ["change"]);
  let mask = and(naturalBefore, notWater());
  if (minConfidence > 0) {
    const t = minConfidence * PROBABILITY_SCALE;
    mask = and(mask, and(gte(topProbability(pa), t), gte(topProbability(pb), t)));
  }
  return updateMask(code, mask);
}

/** The change picture: converted pixels in the three pinks, standing natural forest dark grey and faint. */
export function conversionTiles(since: number, to: number, minConfidence: number): EeNode {
  const code = conversion(since, to, minConfidence);
  const alpha = subtract(1, multiply(eq(code, 0), 1 - UNCHANGED_ALPHA));
  return updateMask(visualize(code, { min: 0, max: TARGETS.length, palette: [UNCHANGED_COLOR, ...TARGETS.map((t) => t.color)] }), alpha);
}

// ---- Numbers for the card, the legend and the note ----

/** The six probabilities (0..1) and the class at one point; null where ForTy has no data (sea). */
export type PointReading = { probabilities: Record<string, number>; classCode: number };

export function pointExpression(source: Source, lon: number, lat: number): EeNode {
  return reduceRegion(probabilities(source), point(lon, lat), "first", { scale: 10 });
}

/** Reads the `pointExpression` result: probabilities as shares of 1 and the most likely class. */
export function readPoint(result: Record<string, unknown> | null | undefined): PointReading | null {
  if (!result) return null;
  const probabilities: Record<string, number> = {};
  for (const c of CLASSES) {
    const v = result[c.key];
    if (typeof v !== "number") return null;
    probabilities[c.key] = Math.min(1, Math.max(0, v / PROBABILITY_SCALE));
  }
  let best = CLASSES[0];
  for (const c of CLASSES) if (probabilities[c.key] >= probabilities[best.key]) best = c;
  return { probabilities, classCode: best.code };
}

/** Metres across a box at its middle latitude (for picking a reduction scale). */
function widthMetres([w, s, e, n]: BBox): number {
  return (e - w) * 111_320 * Math.cos((((s + n) / 2) * Math.PI) / 180);
}

/** The scale (m) the view's class shares are counted at: about 300 samples across the view, never finer than 10 m. */
export function sharesScale(bbox: BBox): number {
  return Math.max(10, Math.round(widthMetres(bbox) / 300));
}

/**
 * How much of a box each class covers: a histogram of the class (0 where the pixel is below `minConfidence`) over the
 * box, sampled about 300 across. Sea and no-data are not counted.
 */
export function sharesExpression(source: Source, minConfidence: number, bbox: BBox): EeNode {
  const cls = unmask(classes(source, minConfidence), 0);
  // unmask also fills the sea with 0; mask it back to the land where ForTy has data.
  const land = updateMask(updateMask(cls, gte(topProbability(probabilities(source)), 0)), notWater());
  return reduceRegion(land, rectangle(bbox), "frequencyHistogram", { scale: sharesScale(bbox), maxPixels: 4e5, bestEffort: true });
}

/** Shares (0..1, summing to 1) by class code ("0" = below the confidence asked) from the histogram result. */
export function readShares(result: Record<string, unknown> | null | undefined): Record<string, number> {
  const hist = (result?.class ?? {}) as Record<string, unknown>;
  const total = Object.values(hist).reduce<number>((s, v) => s + (typeof v === "number" ? v : 0), 0);
  const out: Record<string, number> = {};
  if (total <= 0) return out;
  for (const [k, v] of Object.entries(hist)) if (typeof v === "number" && v > 0) out[String(Math.round(Number(k)))] = (out[String(Math.round(Number(k)))] ?? 0) + v / total;
  return out;
}

/** The scale (m) conversion areas are summed at: about four million cells over the box, never finer than 30 m. */
export function areaScale(bbox: BBox): number {
  return Math.max(30, Math.round(Math.sqrt((bboxAreaKm2(bbox) * 1e6) / 4e6) / 10) * 10);
}

/** Areas in km² over a box: natural forest still standing at the end, and how much went to each target. One request. */
export function conversionAreasExpression(since: number, to: number, minConfidence: number, bbox: BBox): EeNode {
  const code = conversion(since, to, minConfidence);
  const km2 = divide(toFloat(pixelArea()), 1e6);
  const bands = [constantImage(0), ...TARGETS.map((t) => constantImage(t.code))].map((v, i) => rename(multiply(km2, eq(code, v)), [i === 0 ? "standing" : TARGETS[i - 1].key]));
  let stack = bands[0];
  for (const b of bands.slice(1)) stack = addBands(stack, b);
  return reduceRegion(stack, rectangle(bbox), "sum", { scale: areaScale(bbox), maxPixels: 1e7, bestEffort: true, tileScale: 4 });
}

export type ConversionAreas = { standing: number; byTarget: Record<string, number>; converted: number; naturalBefore: number };

export function readConversionAreas(result: Record<string, unknown> | null | undefined): ConversionAreas | null {
  const a = result;
  if (!a) return null;
  const num = (k: string) => (typeof a[k] === "number" ? (a[k] as number) : 0);
  const byTarget: Record<string, number> = {};
  for (const t of TARGETS) byTarget[t.key] = num(t.key);
  const converted = Object.values(byTarget).reduce((s, v) => s + v, 0);
  const standing = num("standing");
  return { standing, byTarget, converted, naturalBefore: standing + converted };
}

/** The tile route's cache key and the map key for one picture. */
export type TileParams = { view: "classes"; source: Source; minConfidence: number } | { view: "change"; since: number; to: number; minConfidence: number };

export function tileImage(p: TileParams): EeNode {
  return p.view === "classes" ? classTiles(p.source, p.minConfidence) : conversionTiles(p.since, p.to, p.minConfidence);
}

export function tileKey(p: TileParams): string {
  return p.view === "classes"
    ? `forest-types:classes:${p.source.kind === "year" ? p.source.year : "2020v1"}:${p.minConfidence}`
    : `forest-types:change:${p.since}:${p.to}:${p.minConfidence}`;
}

/**
 * The tile route's query for a picture, and back. `src` is `2020v1` (the baseline) or a year; `conf` is `all` or
 * `confident`; the change view adds `since`. Anything else is refused, so the route can never be asked for an
 * arbitrary computation.
 */
export function tileQuery(p: TileParams): string {
  const conf = p.minConfidence > 0 ? "confident" : "all";
  return p.view === "classes"
    ? `view=classes&src=${p.source.kind === "year" ? p.source.year : "2020v1"}&conf=${conf}`
    : `view=change&since=${p.since}&to=${p.to}&conf=${conf}`;
}

export function parseTileQuery(q: URLSearchParams): TileParams | null {
  const conf = q.get("conf");
  if (conf !== "all" && conf !== "confident") return null;
  const minConfidence = conf === "confident" ? CONFIDENT : 0;
  const year = (s: string | null) => (s !== null && /^\d{4}$/.test(s) && YEARS.includes(Number(s)) ? Number(s) : null);
  if (q.get("view") === "classes") {
    const src = q.get("src");
    if (src === "2020v1") return { view: "classes", source: { kind: "baseline" }, minConfidence };
    const y = year(src);
    return y === null ? null : { view: "classes", source: { kind: "year", year: y }, minConfidence };
  }
  if (q.get("view") === "change") {
    const since = year(q.get("since"));
    const to = year(q.get("to"));
    if (since === null || to === null || since >= to) return null;
    return { view: "change", since, to, minConfidence };
  }
  return null;
}

/** The class with a code, or undefined. */
export const classByCode = (code: number) => CLASSES.find((c) => c.code === code);
