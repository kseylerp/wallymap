/**
 * When spring greens up, from MODIS Land Cover Dynamics on Earth Engine (`MODIS/061/MCD12Q2`, NASA LP DAAC, Friedl et
 * al.; public domain): the phenology layer's `greenup` view (spec T10 "Green-up timing").
 *
 * Read 2026-10-23 with the project's credentials: one image a year, `2001_01_01` to `2025_01_01`, 500 m. Band
 * Greenup_1 is the date of the first green-up of the year's first growth cycle (when the EVI2 greenness index first
 * passes 15% of the way from its winter low to its summer peak), as days since 1970-01-01; it is masked where the
 * pixel has no cycle (water, bare ground, towns). Each year is turned into a day of that year (0 = 1 January) by
 * subtracting the year's first day, cast to float so the years stack into one collection. Around Asheville
 * ([-82.8, 35.4, -82.3, 35.8]) the box's median was day 87 (29 March) over 2001–2024, 85 in 2024 and 87 in 2025.
 *
 * Two pictures: the usual green-up day (the median of every year, per pixel) on the sage → pink → purple ramp, early
 * to late, and one value per year for the box (the median over its pixels), from which the note says the usual date,
 * the latest year's date and how many days early or late it came.
 */
import { addBands, and, call, gte, lte, rectangle, rename, select, subtract, toFloat, updateMask, visualize, type EeNode } from "./expr";
import type { BBox } from "@/layers/types";
import { PINK, PURPLE, SAGE } from "@/lib/render/palette";

export const MCD12Q2 = "MODIS/061/MCD12Q2";
export const GREENUP_FROM = 2001;
export const GREENUP_TO = 2025;
export const GREENUP_YEARS: number[] = Array.from({ length: GREENUP_TO - GREENUP_FROM + 1 }, (_, i) => GREENUP_FROM + i);
/** The ramp's ends, days of the year: 20 February (sage, early) to 31 May (purple, late). */
export const RAMP_FROM_DAY = 50;
export const RAMP_TO_DAY = 150;
export const RAMP = [SAGE, PINK, PURPLE];

const DAY_MS = 86_400_000;

/** One year's green-up as a day of that year (0 = 1 January), float, masked outside a plausible window. */
export function greenupDay(year: number): EeNode {
  const days = Date.UTC(year, 0, 1) / DAY_MS;
  const day = subtract(toFloat(select(call("Image.load", { id: `${MCD12Q2}/${year}_01_01` }), ["Greenup_1"])), days);
  return rename(updateMask(day, and(gte(day, -90), lte(day, 455))), ["day"]);
}

/** The usual green-up day per pixel: the median of every year. */
export function usualGreenup(): EeNode {
  const collection = call("ImageCollection.fromImages", { images: { arrayValue: { values: GREENUP_YEARS.map(greenupDay) } } });
  return rename(call("ImageCollection.reduce", { collection, reducer: call("Reducer.median") }), ["usual"]);
}

/** The usual green-up picture: early sage, late purple. */
export function greenupTiles(): EeNode {
  return visualize(usualGreenup(), { min: RAMP_FROM_DAY, max: RAMP_TO_DAY, palette: RAMP });
}

/** The scale (m) the box is read at: about 200 samples across, never finer than MODIS's 500 m. */
export function greenupScale([w, s, e, n]: BBox): number {
  const width = (e - w) * 111_320 * Math.cos((((s + n) / 2) * Math.PI) / 180);
  return Math.max(500, Math.round(width / 200));
}

/** Each year's green-up day over the box (the median of its pixels): bands `y2001` .. `y2025`. */
export function yearsExpression(bbox: BBox): EeNode {
  let stack: EeNode | undefined;
  for (const year of GREENUP_YEARS) {
    const band = rename(greenupDay(year), [`y${year}`]);
    stack = stack ? addBands(stack, band) : band;
  }
  return call("Image.reduceRegion", { image: stack as EeNode, reducer: call("Reducer.median"), geometry: rectangle(bbox), scale: greenupScale(bbox), maxPixels: 4e6, bestEffort: true });
}

/** The green-up day at one point, usual and per year (identify). */
export function pointExpression(lon: number, lat: number): EeNode {
  let stack = usualGreenup();
  for (const year of GREENUP_YEARS) stack = addBands(stack, rename(greenupDay(year), [`y${year}`]));
  return call("Image.reduceRegion", { image: stack, reducer: call("Reducer.first"), geometry: call("GeometryConstructors.Point", { coordinates: [lon, lat] }), scale: 500 });
}

export type GreenupYears = { year: number; day: number }[];

/** The `y2001`.. bands of a result as years with a value, oldest first. */
export function readYears(result: Record<string, unknown> | null | undefined): GreenupYears {
  if (!result) return [];
  return GREENUP_YEARS.flatMap((year) => {
    const v = result[`y${year}`];
    return typeof v === "number" && Number.isFinite(v) ? [{ year, day: v }] : [];
  });
}

/** The tile route's query for the usual green-up picture; anything else is refused. */
export const GREENUP_QUERY = "view=greenup";
export const GREENUP_TILE_KEY = "phenology:greenup:v2";

export function parseGreenupQuery(q: URLSearchParams): boolean {
  return q.get("view") === "greenup" && [...q.keys()].every((k) => k === "view");
}
