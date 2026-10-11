/**
 * One place that turns a number into reader text, so a year never reads "2,026" while an acreage still reads
 * "2,026 acres". The key (the property name or label the number belongs to) and the unit decide which it is.
 */

const YEAR_WORDS = /\b(year|yr|date|from|to|since|until|decade|t)\b/i;

/** True when numbers under this key (or unit) are calendar values: `year`, `yearCompleted`, `start_year`, `t`, `date`. */
export function isYearLike(key = "", unit?: string): boolean {
  if (unit !== undefined && /^years?$/i.test(unit.trim())) return true;
  // Split camelCase and snake_case so `yearCompleted` and `start_year` read as words.
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return YEAR_WORDS.test(words);
}

/**
 * A number as text: years and dates under a year-like key (or in unit "year") get no separators; everything else
 * keeps its grouping. Decimals are rounded to `maxDecimals` places (default 2) and never padded.
 */
export function formatValue(key: string, value: number, unit?: string, maxDecimals = 2): string {
  return value.toLocaleString("en-US", {
    useGrouping: !isYearLike(key, unit),
    maximumFractionDigits: maxDecimals,
    minimumFractionDigits: 0,
  });
}
