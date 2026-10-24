/**
 * Tree cover loss in numbers, through Earth Engine (the forest-loss layer draws GFW's tiles; these are the totals the
 * tiles cannot give): km² lost per year and by what drove it, inside the asked region's outline when the box is one
 * state, province or country, else inside the box.
 *
 * Assets (read 2026-10-23 with the project's credentials):
 *   - Hansen Global Forest Change v1.13, `UMD/hansen/global_forest_change_2025_v1_13` (CC BY 4.0): `treecover2000`
 *     (canopy %, MEAN pyramid) and `lossyear` (1..25 = 2001..2025, 0 none, MODE pyramid), 30 m.
 *   - Drivers of forest loss v1.3, WRI and Google DeepMind, `projects/landandcarbon/assets/wri_gdm_drivers_forest_loss_1km/v1_3_2001_2025`
 *     (CC BY 4.0): `classification`, the dominant driver of each 1 km cell over 2001–2025, 1..7 in the published order.
 *     Checked 2026-10-23: the Santiam Canyon box (Oregon, 2020 fires) reads 87% wildfire and 13% logging; Pará 66%
 *     permanent agriculture and 26% wildfire; East Kalimantan has hard commodities (coal) as its second driver.
 *   - geoBoundaries 6.0 ADM0 and ADM1, `WM/geoLab/geoBoundaries/600/ADM0|ADM1` (CC BY 4.0), for the region outline.
 * Sums are estimates: the loss image is sampled on a grid of about 16 million cells over the area (never finer than
 * 30 m); at Pará's size (300 m) the yearly totals stay within 2% of a 150 m count (checked 2026-10-23).
 */
import {
  addBands,
  and,
  clip,
  collectionGeometry,
  divide,
  eq,
  filterEquals,
  filterIntersects,
  gte,
  loadImage,
  loadTable,
  lte,
  multiply,
  pixelArea,
  rectangle,
  reduceRegion,
  reduceRegionsSum,
  rename,
  rows,
  select,
  toFloat,
  type EeNode,
} from "./expr";
import type { BBox } from "@/layers/types";
import { bboxAreaKm2 } from "@/layers/types";

export const HANSEN = "UMD/hansen/global_forest_change_2025_v1_13";
export const DRIVERS = "projects/landandcarbon/assets/wri_gdm_drivers_forest_loss_1km/v1_3_2001_2025";
export const BOUNDARIES = { ADM0: "WM/geoLab/geoBoundaries/600/ADM0", ADM1: "WM/geoLab/geoBoundaries/600/ADM1" } as const;
export type AdminLevel = keyof typeof BOUNDARIES;

export type Driver = { code: number; key: string; label: string; help: string };

/** The seven drivers, in the dataset's class order (Sims et al. 2025, WRI and Google DeepMind). */
export const DRIVER_CLASSES: Driver[] = [
  { code: 1, key: "agriculture", label: "Permanent agriculture", help: "Long-term clearing for crops, pasture and tree crops such as oil palm." },
  { code: 2, key: "commodities", label: "Hard commodities", help: "Mining and energy: mines, quarries, oil and gas." },
  { code: 3, key: "shifting", label: "Shifting cultivation", help: "Small plots cleared for a few years of farming, then left to regrow." },
  { code: 4, key: "logging", label: "Logging", help: "Timber harvest, in natural forest or plantations, where the forest is expected to regrow." },
  { code: 5, key: "wildfire", label: "Wildfire", help: "Trees killed or burned by fire not set to clear land." },
  { code: 6, key: "settlements", label: "Settlements and infrastructure", help: "Towns, roads and other building." },
  { code: 7, key: "natural", label: "Other natural disturbances", help: "Storms, floods, landslides, drought, insects and disease." },
];

/** Grid cells the sums are sampled on, over the area summed. */
const CELLS = 16e6;

/** The scale (m) loss is summed at: about 16 million cells over `areaKm2`, never finer than 30 m (Hansen's own). */
export function lossScale(areaKm2: number): number {
  return Math.max(30, Math.round(Math.sqrt((areaKm2 * 1e6) / CELLS) / 10) * 10);
}

/** The scale (m) the region outlines are measured at: coarse (a match needs shares, not hectares), at least 2 km. */
export function matchScale(bbox: BBox): number {
  return Math.max(2000, Math.round(Math.sqrt((bboxAreaKm2(bbox) * 1e6) / 1e5) / 100) * 100);
}

/** Boxes smaller than this are never matched to a state or country (a park, a valley, a phone's view). */
export const MIN_MATCH_KM2 = 1000;

const km2Image = (): EeNode => divide(toFloat(pixelArea()), 1e6);

/**
 * One image whose bands, summed over an area, give km²: `forest` (canopy at least `threshold`% in 2000), `total` lost
 * from `startYear` to `endYear`, `y<year>` lost in each year, and `d<code>` lost in that span in cells of each driver.
 */
export function lossStack(startYear: number, endYear: number, threshold: number): EeNode {
  const hansen = loadImage(HANSEN);
  const year = select(hansen, ["lossyear"]);
  const forest = gte(select(hansen, ["treecover2000"]), threshold);
  const km2 = km2Image();
  const lostIn = (a: number, b: number) => multiply(km2, and(and(gte(year, a - 2000), lte(year, b - 2000)), forest));
  const lost = lostIn(startYear, endYear);
  const driver = select(loadImage(DRIVERS), ["classification"]);
  let stack = addBands(rename(multiply(km2, forest), ["forest"]), rename(lost, ["total"]));
  for (let y = startYear; y <= endYear; y++) stack = addBands(stack, rename(lostIn(y, y), [`y${y}`]));
  for (const d of DRIVER_CLASSES) stack = addBands(stack, rename(multiply(lost, eq(driver, d.code)), [`d${d.code}`]));
  return stack;
}

/** The sums over a box. */
export function boxLossExpression(bbox: BBox, startYear: number, endYear: number, threshold: number): EeNode {
  return reduceRegion(lossStack(startYear, endYear, threshold), rectangle(bbox), "sum", { scale: lossScale(bboxAreaKm2(bbox)), maxPixels: 1e8, bestEffort: true, tileScale: 4 });
}

/** The sums over one geoBoundaries region (by its id), sampled for its own area. */
export function regionLossExpression(level: AdminLevel, shapeId: string, areaKm2: number, startYear: number, endYear: number, threshold: number): EeNode {
  const region = collectionGeometry(filterEquals(loadTable(BOUNDARIES[level]), "shapeID", shapeId));
  return reduceRegion(lossStack(startYear, endYear, threshold), region, "sum", { scale: lossScale(areaKm2), maxPixels: 1e8, bestEffort: true, tileScale: 4 });
}

/** Every region of a level touching the box, with its whole area and the area of it inside the box (km²). */
export function regionsExpression(level: AdminLevel, bbox: BBox): EeNode {
  const rect = rectangle(bbox);
  const km2 = km2Image();
  const image = addBands(rename(km2, ["all"]), rename(clip(km2, rect), ["inBox"]));
  return rows(reduceRegionsSum(image, filterIntersects(loadTable(BOUNDARIES[level]), rect), matchScale(bbox)), ["shapeID", "shapeName", "shapeGroup", "all", "inBox"]);
}

export type Region = { level: AdminLevel; id: string; name: string; country: string; areaKm2: number; inBoxKm2: number };

export function readRegions(level: AdminLevel, result: unknown): Region[] {
  const list = (result as { list?: unknown } | null)?.list;
  if (!Array.isArray(list)) return [];
  const out: Region[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [id, name, country, all, inBox] = row;
    if (typeof id !== "string" || typeof name !== "string" || typeof all !== "number" || typeof inBox !== "number" || all <= 0) continue;
    out.push({ level, id, name, country: typeof country === "string" ? country : "", areaKm2: all, inBoxKm2: inBox });
  }
  return out;
}

/**
 * The region the box stands for, if any: one that lies almost wholly inside it (85%) and holds at least half of the land
 * in it. Countries tile the land, so the land in the box is the sum of the countries' parts in it. The largest such
 * region wins (a country's box is the country, not its biggest state).
 */
export function matchRegion(regions: Region[]): Region | null {
  const land = regions.filter((r) => r.level === "ADM0").reduce((s, r) => s + r.inBoxKm2, 0) || regions.reduce((s, r) => s + r.inBoxKm2, 0);
  if (land <= 0) return null;
  const fits = regions.filter((r) => r.inBoxKm2 / r.areaKm2 >= 0.85 && r.inBoxKm2 / land >= 0.5).sort((a, b) => b.inBoxKm2 - a.inBoxKm2);
  return fits[0] ?? null;
}

export type LossTotals = { forestKm2: number; totalKm2: number; byYear: Record<number, number>; byDriver: Record<number, number> };

export function readLoss(result: unknown, startYear: number, endYear: number): LossTotals | null {
  const r = result as Record<string, unknown> | null;
  if (!r || typeof r.total !== "number") return null;
  const n = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : 0);
  const byYear: Record<number, number> = {};
  for (let y = startYear; y <= endYear; y++) byYear[y] = n(`y${y}`);
  const byDriver: Record<number, number> = {};
  for (const d of DRIVER_CLASSES) byDriver[d.code] = n(`d${d.code}`);
  return { forestKm2: n("forest"), totalKm2: n("total"), byYear, byDriver };
}

/** "105,900 km²" / "536 km²" / "4.2 km²". */
export function km2Text(v: number): string {
  if (v >= 1000) return `${(Math.round(v / 100) * 100).toLocaleString("en-US")} km²`;
  if (v >= 10) return `${Math.round(v).toLocaleString("en-US")} km²`;
  return `${v.toFixed(1)} km²`;
}

/** "10.6 million ha" / "53,600 ha" / "420 ha". */
export function haText(km2: number): string {
  const ha = km2 * 100;
  if (ha >= 1e6) return `${(ha / 1e6).toFixed(1)} million ha`;
  if (ha >= 1000) return `${(Math.round(ha / 100) * 100).toLocaleString("en-US")} ha`;
  return `${Math.round(ha)} ha`;
}

/** Drivers with at least 1% of the loss, largest first, as shares of it. */
export function driverShares(t: LossTotals): { driver: Driver; km2: number; share: number }[] {
  const known = Object.values(t.byDriver).reduce((s, v) => s + v, 0);
  if (known <= 0) return [];
  return DRIVER_CLASSES.map((driver) => ({ driver, km2: t.byDriver[driver.code] ?? 0, share: (t.byDriver[driver.code] ?? 0) / known }))
    .filter((d) => d.share >= 0.01)
    .sort((a, b) => b.km2 - a.km2);
}

/** The years with the most loss, largest first. */
export function topYears(t: LossTotals, n = 3): { year: number; km2: number }[] {
  return Object.entries(t.byYear)
    .map(([year, km2]) => ({ year: Number(year), km2 }))
    .filter((y) => y.km2 > 0)
    .sort((a, b) => b.km2 - a.km2)
    .slice(0, n);
}
