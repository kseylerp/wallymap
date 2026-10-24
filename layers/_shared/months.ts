/**
 * Twelve values a year, January first: the month names, the highest and lowest month, and when a season (snow) starts
 * and ends, shared by the layers that answer "how does this place change through the year" (climate-normals,
 * flow-by-month, phenology's green-up) and their monthly strip (layers/types.ts MonthlyStrip).
 */

export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const MONTH_SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));

export type MonthValue = { month: number; value: number };

/** The month with the largest value (the first of equals), or undefined when none has a value. */
export function highestMonth(values: readonly (number | null | undefined)[]): MonthValue | undefined {
  let best: MonthValue | undefined;
  values.forEach((v, month) => {
    if (typeof v === "number" && Number.isFinite(v) && (best === undefined || v > best.value)) best = { month, value: v };
  });
  return best;
}

/** The month with the smallest value (the first of equals), or undefined when none has a value. */
export function lowestMonth(values: readonly (number | null | undefined)[]): MonthValue | undefined {
  let best: MonthValue | undefined;
  values.forEach((v, month) => {
    if (typeof v === "number" && Number.isFinite(v) && (best === undefined || v < best.value)) best = { month, value: v };
  });
  return best;
}

/** The season year starts in August (index 7), so a northern winter reads as one run (snow from November to April). */
const SEASON_START = 7;

/**
 * When a seasonal thing (snow) is usually there: the first month, counting from August, whose value reaches
 * `threshold` (`arrives`), and the first month after the last such month (`goneBy`, when it is gone). Undefined when no
 * month reaches it; `allYear` when every month does.
 */
export function seasonSpan(
  values: readonly (number | null | undefined)[],
  threshold: number,
): { arrives: number; goneBy: number; allYear: boolean } | undefined {
  const order = Array.from({ length: 12 }, (_, i) => (SEASON_START + i) % 12);
  const on = order.filter((m) => {
    const v = values[m];
    return typeof v === "number" && v >= threshold;
  });
  if (on.length === 0) return undefined;
  if (on.length === 12) return { arrives: SEASON_START, goneBy: SEASON_START, allYear: true };
  const last = on[on.length - 1];
  return { arrives: on[0], goneBy: (last + 1) % 12, allYear: false };
}

/** A value rounded for a sentence: whole numbers from 10 up, one decimal below ("6.2 in", "78 °F", "2,170 cfs"). */
export function amountText(value: number, digitsUnderTen = 1): string {
  const abs = Math.abs(value);
  const digits = abs >= 10 ? 0 : digitsUnderTen;
  return value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** Days in each month of a common year (for a share of days). */
export const DAYS_IN_MONTH = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Day of year (0 = 1 January, a common year) as a month index and the fraction of that month gone. */
export function monthOfDay(day: number): { month: number; fraction: number } {
  let d = Math.max(0, Math.min(364.99, day));
  for (let m = 0; m < 12; m++) {
    const len = Math.floor(DAYS_IN_MONTH[m]);
    if (d < len) return { month: m, fraction: d / len };
    d -= len;
  }
  return { month: 11, fraction: 0.99 };
}

/** "Mar 29": a day of year (0 = 1 January) as a calendar date in a common year. */
export function dayText(day: number): string {
  const date = new Date(Date.UTC(2023, 0, 1) + Math.round(day) * 86_400_000);
  return `${MONTH_SHORT[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/** The middle value of the finite numbers, or undefined when there are none. */
export function median(values: readonly (number | null | undefined)[]): number | undefined {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return undefined;
  const mid = xs.length >> 1;
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}
