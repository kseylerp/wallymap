/**
 * LANDFIRE existing vegetation type (EVT) on Earth Engine: the pictures and numbers the vegetation-types layer draws
 * and reads (docs/top-10-use-cases.md T09).
 *
 * Asset (read 2026-10-23 with the project's credentials): `LANDFIRE/Vegetation/EVT/v1_4_0`, an IMAGE_COLLECTION of three
 * images (CONUS, AK, HI) whose class tables differ, so the collection is not homogeneous: the lower 48 image is loaded by
 * id, `LANDFIRE/Vegetation/EVT/v1_4_0/CONUS`, band `EVT`, 30 m, LANDFIRE 1.4.0 (vegetation as of about 2014). Its
 * properties `EVT_class_values` and `EVT_class_names` hold 849 classes (3001 "Inter-Mountain Basins Sparsely Vegetated
 * Systems" to 3999), mostly NatureServe ecological systems ("Southern Appalachian Oak Forest"), plus water, snow and
 * ice, barren, developed and agricultural classes. Its pyramid keeps real class codes when zoomed out (checked: no code
 * outside the table in six boxes from the Smokies to the Colorado Rockies); 0 is no data (outside the lower 48).
 *
 * The 849 classes are grouped for the map into eight colors (layers/_data/landfire-evt.json, one row per class:
 * value, name, group, physiognomy, LANDFIRE group name or null). The physiognomy and LANDFIRE group name come from
 * LANDFIRE's own attribute table where the class name matches (LF 2016 Remap, LF16_EVT_200.csv, landfire.gov, 464 of
 * 849 names); the rest are read from the class name (pine, fir, spruce: conifer; oak, aspen, maple: hardwood; marsh,
 * swamp, riparian, floodplain: wetland; and so on). The shares and the card always keep LANDFIRE's own class names.
 */
import { call, eq, gte, multiply, point, rectangle, reduceRegion, select, subtract, updateMask, visualize, type EeNode } from "./expr";
import { DARK_GREY, OFF_WHITE, PINK, PURPLE, SAGE, SURFACE } from "@/lib/render/palette";
import { hexToRgb, interpolateStops, oklchToRgb, rgbToHex, rgbToOklch } from "@/lib/render/ramp";
import type { BBox } from "@/layers/types";
import table from "@/layers/_data/landfire-evt.json";

export const EVT_IMAGE = "LANDFIRE/Vegetation/EVT/v1_4_0/CONUS";
export const EVT_BAND = "EVT";
/** The year LANDFIRE 1.4.0 maps (its disturbance updates run through 2014). */
export const EVT_YEAR = 2014;
/** The lower 48's extent, where the CONUS image has data. */
export const CONUS_BBOX: BBox = [-124.8, 24.4, -66.9, 49.4];

export type GroupKey = "conifer" | "hardwood" | "shrub" | "grass" | "wet" | "water" | "developed" | "sparse";

export type VegetationGroup = { code: number; key: GroupKey; label: string; color: string; alpha: number; help: string };

const mix = (a: string, b: string, t: number) => rgbToHex(interpolateStops([a, b], t));
/** A palette color made darker (OKLCH lightness) and a little richer, as forest types draws primary forest. */
function deepen(hex: string, dl: number, chroma: number): string {
  const [l, c, h] = rgbToOklch(hexToRgb(hex));
  return rgbToHex(oklchToRgb([Math.max(0.05, l + dl), c * chroma, h]));
}

/**
 * The eight map groups in the palette (spec T09 Visualization): conifer forest darkest sage, hardwood and mixed forest
 * sage, shrubland light sage, grassland off-white with a sage cast, wetland and riparian a purple tint, water purple,
 * farmland and developed land dark grey drawn faint, sparse and bare ground off-white grey.
 */
export const GROUPS: VegetationGroup[] = [
  { code: 1, key: "conifer", label: "Conifer forest and woodland", color: deepen(SAGE, -0.33, 1.25), alpha: 1, help: "Forest and woodland of pines, firs, spruces, hemlocks, cedars, junipers and other conifers." },
  { code: 2, key: "hardwood", label: "Hardwood and mixed forest", color: SAGE, alpha: 1, help: "Forest and woodland of broadleaf trees (oaks, maples, aspen, hickories) or broadleaf trees mixed with conifers." },
  { code: 3, key: "shrub", label: "Shrubland", color: mix(SAGE, OFF_WHITE, 0.5), alpha: 1, help: "Land dominated by shrubs: sagebrush, chaparral, desert scrub, heath and young regrowth after logging or fire." },
  { code: 4, key: "grass", label: "Grassland and meadow", color: mix(SAGE, OFF_WHITE, 0.82), alpha: 1, help: "Prairie, steppe, meadows, alpine turf, glades and other land dominated by grasses and herbs." },
  { code: 5, key: "wet", label: "Wetland and riparian", color: mix(PURPLE, OFF_WHITE, 0.6), alpha: 1, help: "Swamps, marshes, bogs, floodplain and streamside forest and shrubland." },
  { code: 6, key: "water", label: "Open water", color: PURPLE, alpha: 1, help: "Lakes, reservoirs, rivers and the sea." },
  { code: 7, key: "developed", label: "Farmland and developed land", color: DARK_GREY, alpha: 0.35, help: "Towns, roads, quarries, crops, pasture and hay. Drawn faint so the vegetation reads." },
  { code: 8, key: "sparse", label: "Sparse, barren, snow and ice", color: SURFACE, alpha: 1, help: "Rock, scree, sand, lava, alpine fell-fields, snow and ice: little or no vegetation." },
];

export const groupByKey = (key: string) => GROUPS.find((g) => g.key === key);
export const groupByCode = (code: number) => GROUPS.find((g) => g.code === code);

export type EvtClass = { value: number; name: string; group: GroupKey; physiognomy: string; lfGroup: string | null };

/** Every class of the CONUS image, by value. */
export const EVT_CLASSES: Map<number, EvtClass> = new Map(
  (table as [number, string, GroupKey, string, string | null][]).map(([value, name, group, physiognomy, lfGroup]) => [value, { value, name, group, physiognomy, lfGroup }]),
);

/** The EVT band of the lower 48 image. */
export const evt = (): EeNode => select(call("Image.load", { id: EVT_IMAGE }), [EVT_BAND]);

/** The group code (1..8) of every pixel, masked where LANDFIRE has no class. */
export function groups(): EeNode {
  const values = [...EVT_CLASSES.keys()];
  const codes = values.map((v) => groupByKey(EVT_CLASSES.get(v)!.group)!.code);
  return call("Image.remap", { image: evt(), from: values, to: codes, bandName: EVT_BAND });
}

/** The group map as an RGB picture: farmland and developed land faint (the tile route draws this). */
export function groupTiles(): EeNode {
  const g = groups();
  const faint = GROUPS.find((x) => x.alpha < 1)!;
  const alpha = subtract(1, multiply(eq(g, faint.code), 1 - faint.alpha));
  return updateMask(visualize(g, { min: 1, max: GROUPS.length, palette: GROUPS.map((x) => x.color) }), updateMask(alpha, gte(g, 1)));
}

/** Metres across a box at its middle latitude. */
function widthMetres([w, s, e, n]: BBox): number {
  return (e - w) * 111_320 * Math.cos((((s + n) / 2) * Math.PI) / 180);
}

/** The scale (m) shares are counted at: about 300 samples across the box, never finer than the data's 30 m. */
export function sharesScale(bbox: BBox): number {
  return Math.max(30, Math.round(widthMetres(bbox) / 300));
}

/** A histogram of EVT classes over a box (one request, fast even over a whole range). */
export function sharesExpression(bbox: BBox): EeNode {
  return reduceRegion(evt(), rectangle(bbox), "frequencyHistogram", { scale: sharesScale(bbox), maxPixels: 4e5, bestEffort: true });
}

export type ClassShare = { cls: EvtClass; share: number };
export type EvtShares = { classes: ClassShare[]; groups: Record<GroupKey, number> };

/** Class and group shares (0..1 of the mapped land in the box) from the histogram; null when nothing is mapped there. */
export function readShares(result: Record<string, unknown> | null | undefined): EvtShares | null {
  const hist = (result?.[EVT_BAND] ?? {}) as Record<string, unknown>;
  const counts = new Map<number, number>();
  for (const [k, v] of Object.entries(hist)) {
    const value = Math.round(Number(k));
    if (typeof v !== "number" || v <= 0 || !EVT_CLASSES.has(value)) continue;
    counts.set(value, (counts.get(value) ?? 0) + v);
  }
  const total = [...counts.values()].reduce((s, v) => s + v, 0);
  if (total <= 0) return null;
  const classes = [...counts.entries()].map(([v, n]) => ({ cls: EVT_CLASSES.get(v)!, share: n / total })).sort((a, b) => b.share - a.share);
  const groupShares = Object.fromEntries(GROUPS.map((g) => [g.key, 0])) as Record<GroupKey, number>;
  for (const c of classes) groupShares[c.cls.group] += c.share;
  return { classes, groups: groupShares };
}

/** The class at one point (30 m), or null outside the lower 48. */
export function pointExpression(lon: number, lat: number): EeNode {
  return reduceRegion(evt(), point(lon, lat), "first", { scale: 30 });
}

export function readPoint(result: Record<string, unknown> | null | undefined): EvtClass | null {
  const v = result?.[EVT_BAND];
  return typeof v === "number" ? (EVT_CLASSES.get(Math.round(v)) ?? null) : null;
}

/** The tile route's group picture (the eight groups), named by its query. */
export const TILE_QUERY = "view=groups&v=1";
export const TILE_KEY = "vegetation-types:groups:v1";

export function parseTileQuery(q: URLSearchParams): true | null {
  return q.get("view") === "groups" && q.get("v") === "1" ? true : null;
}

// ---- The answer's own picture: the largest named types in the box, each in its own color ----

/** Most named types drawn in their own color (spec T09: at most 8 colors, the rest under Other). */
export const TYPE_SLOTS = 7;
/** A type smaller than this share of the box is not given its own color. */
export const TYPE_MIN_SHARE = 0.01;
/** How opaque the other types are drawn (in their group's color), so the named ones stand out and the land still reads. */
export const OTHER_TYPES_ALPHA = 0.3;

/** A color drawn at `alpha` over white (the key's swatch for a see-through fill). */
export const faintOver = (hex: string, alpha: number): string => rgbToHex(hexToRgb(hex).map((c) => 255 - (255 - c) * alpha) as [number, number, number]);

/**
 * Colors the named types take, in turn, after conifer, water and farmland types have taken theirs: sage, light sage,
 * a sage-purple grey, lavender, darker sage, a pale pink and off-white sage, all from the palette, each far enough from
 * its neighbours to be told apart at a glance (Smokies: oak, cove, montane oak, northern hardwood and mesophytic forest).
 */
const TYPE_SEQUENCE = [
  SAGE,
  mix(SAGE, OFF_WHITE, 0.55),
  mix(SAGE, PURPLE, 0.45),
  mix(PURPLE, OFF_WHITE, 0.55),
  deepen(SAGE, -0.16, 1.1),
  mix(PINK, OFF_WHITE, 0.6),
  mix(SAGE, OFF_WHITE, 0.82),
];
/** Conifer types: the deep sage of the group, then a lighter and a bluer one. */
const CONIFER_SEQUENCE = [deepen(SAGE, -0.33, 1.25), deepen(SAGE, -0.24, 1), mix(deepen(SAGE, -0.3, 1.1), PURPLE, 0.3)];

/**
 * One color per named type, in the order given (largest first): conifer types take the deep sages, water purple,
 * farmland and developed types dark grey drawn faint (as a solid swatch), sparse ground its group's grey, and every
 * other type the next of TYPE_SEQUENCE. No two types share a color.
 */
export function typeColors(classes: EvtClass[]): string[] {
  const own: Partial<Record<GroupKey, string[]>> = {
    conifer: CONIFER_SEQUENCE,
    water: [PURPLE, mix(PURPLE, OFF_WHITE, 0.3)],
    developed: [faintOver(DARK_GREY, 0.35), faintOver(DARK_GREY, 0.55), faintOver(DARK_GREY, 0.2)],
    sparse: [groupByKey("sparse")!.color, mix(groupByKey("sparse")!.color, DARK_GREY, 0.15)],
  };
  const taken: Partial<Record<GroupKey, number>> = {};
  let next = 0;
  const used = new Set<string>();
  return classes.map((cls) => {
    const list = own[cls.group];
    const i = taken[cls.group] ?? 0;
    let color: string | undefined;
    if (list && i < list.length) {
      taken[cls.group] = i + 1;
      color = list[i];
    } else {
      while (next < TYPE_SEQUENCE.length && used.has(TYPE_SEQUENCE[next])) next++;
      color = next < TYPE_SEQUENCE.length ? TYPE_SEQUENCE[next++] : mix(groupByKey(cls.group)!.color, OFF_WHITE, 0.3);
    }
    used.add(color);
    return color;
  });
}

/** The named types an answer colors: the largest at least TYPE_MIN_SHARE of the box, up to TYPE_SLOTS. */
export function topTypes(shares: EvtShares): EvtClass[] {
  return shares.classes.filter((c) => c.share >= TYPE_MIN_SHARE).slice(0, TYPE_SLOTS).map((c) => c.cls);
}

/**
 * The picture of an answer: each of `codes` (EVT values, largest first) solid in its typeColors color, every other type
 * in its group's color at OTHER_TYPES_ALPHA.
 */
export function typeTiles(codes: number[]): EeNode {
  const classes = codes.map((c) => EVT_CLASSES.get(c)!);
  const colors = typeColors(classes);
  const n = codes.length;
  const values = [...EVT_CLASSES.keys()];
  const to = values.map((v) => {
    const i = codes.indexOf(v);
    return i >= 0 ? i + 1 : n + groupByKey(EVT_CLASSES.get(v)!.group)!.code;
  });
  const index = call("Image.remap", { image: evt(), from: values, to, bandName: EVT_BAND });
  const alpha = subtract(1, multiply(gte(index, n + 1), 1 - OTHER_TYPES_ALPHA));
  return updateMask(visualize(index, { min: 1, max: n + GROUPS.length, palette: [...colors, ...GROUPS.map((g) => g.color)] }), updateMask(alpha, gte(index, 1)));
}

export function typesTileQuery(codes: number[]): string {
  return `view=types&v=1&c=${codes.join(",")}`;
}

/** The codes of a types picture's query: 1 to TYPE_SLOTS distinct EVT values of the lower 48 table, else null. */
export function parseTypesQuery(q: URLSearchParams): number[] | null {
  if (q.get("view") !== "types" || q.get("v") !== "1") return null;
  const raw = (q.get("c") ?? "").split(",");
  if (raw.length < 1 || raw.length > TYPE_SLOTS) return null;
  const codes = raw.map((s) => (/^\d{4}$/.test(s) ? Number(s) : Number.NaN));
  if (codes.some((c) => !EVT_CLASSES.has(c)) || new Set(codes).size !== codes.length) return null;
  return codes;
}

export const typesTileKey = (codes: number[]) => `vegetation-types:types:v1:${codes.join(",")}`;

