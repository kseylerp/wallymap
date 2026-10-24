/**
 * TerraClimate monthly normals on Earth Engine (`IDAHO_EPSCOR/TERRACLIMATE`, Abatzoglou et al. 2018, University of
 * Idaho; CC0): the climate-normals layer's global fallback where no NOAA station with 1991–2020 normals is near.
 *
 * Read 2026-10-23 with the project's credentials: 804 monthly images, January 1958 to December 2024, about 4.6 km
 * (1/24°). Bands used: tmmx and tmmn (monthly mean daily high and low, °C, stored times 10), pr (precipitation total,
 * mm), swe (snow water equivalent at the end of the month, mm). One `value:compute` averages each calendar month over
 * 1991–2020 and reads the 48 values at the point (about 0.8 s). Checked at Tahoe City (-120.1428, 39.1678): July
 * 25.4 °C / 7.9 °C (78 °F / 46 °F), January 154 mm (6.1 in), SWE above 10 mm November to April, against the NOAA
 * station's 78.0 / 46.0 °F and 6.21 in.
 */
import { addBands, call, loadCollection, point, rename, select, type EeNode } from "./expr";

export const TERRACLIMATE = "IDAHO_EPSCOR/TERRACLIMATE";
export const NORMALS_FROM = 1991;
export const NORMALS_TO = 2020;
/** TerraClimate's grid, in metres. */
export const TERRACLIMATE_SCALE = 4638;
const BANDS = ["tmmx", "tmmn", "pr", "swe"] as const;

const mm = (m: number) => String(m).padStart(2, "0");

/** The 48-band image of monthly means over 1991–2020: `tmmx_01` .. `swe_12`. */
export function normalsImage(): EeNode {
  const collection = loadCollection(TERRACLIMATE);
  const years = call("Filter.calendarRange", { start: NORMALS_FROM, end: NORMALS_TO, field: "year" });
  let stack: EeNode | undefined;
  for (let m = 1; m <= 12; m++) {
    const month = call("Filter.calendarRange", { start: m, end: m, field: "month" });
    const filtered = call("Collection.filter", { collection, filter: call("Filter.and", { filters: { arrayValue: { values: [years, month] } } }) });
    const mean = call("ImageCollection.reduce", { collection: filtered, reducer: call("Reducer.mean") });
    const img = rename(select(mean, BANDS.map((b) => `${b}_mean`)), BANDS.map((b) => `${b}_${mm(m)}`));
    stack = stack ? addBands(stack, img) : img;
  }
  return stack as EeNode;
}

/** The normals at one point, as one dictionary of 48 numbers. */
export function normalsExpression(lon: number, lat: number): EeNode {
  return call("Image.reduceRegion", { image: normalsImage(), reducer: call("Reducer.first"), geometry: point(lon, lat), scale: TERRACLIMATE_SCALE });
}

/** Twelve values per variable in the source's units made plain: °C for the temperatures, mm for precipitation and SWE. */
export type TerraNormals = { highC: (number | null)[]; lowC: (number | null)[]; precipMm: (number | null)[]; sweMm: (number | null)[] };

/** Reads the `normalsExpression` result; null where TerraClimate has no data (the open sea). */
export function readNormals(result: Record<string, unknown> | null | undefined): TerraNormals | null {
  if (!result) return null;
  const series = (band: string, scale: number) =>
    Array.from({ length: 12 }, (_, i) => {
      const v = result[`${band}_${mm(i + 1)}`];
      return typeof v === "number" && Number.isFinite(v) ? v * scale : null;
    });
  const out = { highC: series("tmmx", 0.1), lowC: series("tmmn", 0.1), precipMm: series("pr", 1), sweMm: series("swe", 1) };
  return out.highC.every((v) => v === null) ? null : out;
}
