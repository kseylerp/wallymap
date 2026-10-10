/**
 * Date handling shared by the over-time tile layers (greenness, snow cover, flood extent, sea ice, fire weather, ...).
 * Pure: no network. A layer asks `resolveTileDate` which day to draw; the answer is clamped to what the source
 * publishes, with a note when it had to move the date.
 */
import { z } from "zod";

export const DAY_MS = 86_400_000;

/** Optional `YYYY-MM-DD` input shared by every dated layer. */
export const dateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** True when the string is a real calendar day (rejects 2026-02-31, which Date would roll over). */
export function isRealDate(day: string): boolean {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) && isoDay(ms) === day;
}

export type DateWindow = {
  /** First day published (YYYY-MM-DD). */
  from: string;
  /** Last day published when the archive has ended (YYYY-MM-DD); omit when it runs to the present. */
  to?: string;
  /** Newest day offered, relative to today (UTC): -3 is "three days behind today", +9 is "nine days of forecast". */
  latestOffsetDays: number;
  /** Day drawn when none is asked for, relative to today; defaults to `latestOffsetDays`. */
  defaultOffsetDays?: number;
  /** Used in messages, e.g. "night lights". */
  label: string;
};

export type DateChoice = { ok: true; date: string; note?: string } | { ok: false; error: string };

/**
 * The day to draw. Rejects a malformed date or one before the archive starts; a date after the newest published day
 * is moved back to it and `note` says so (the newest days are often not processed yet, which would draw blank tiles).
 */
export function resolveTileDate(requested: string | undefined, w: DateWindow, now: number = Date.now()): DateChoice {
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const newestMs = Math.min(today + w.latestOffsetDays * DAY_MS, w.to !== undefined ? Date.parse(`${w.to}T00:00:00Z`) : Infinity);
  // A source that has not published its first day yet still draws that day rather than nothing.
  const newest = isoDay(newestMs) < w.from ? w.from : isoDay(newestMs);
  const fallbackMs = Math.min(today + (w.defaultOffsetDays ?? w.latestOffsetDays) * DAY_MS, newestMs);
  const fallback = isoDay(fallbackMs) < w.from ? w.from : isoDay(fallbackMs);

  const date = requested ?? fallback;
  if (!isRealDate(date)) return { ok: false, error: `${date} is not a real date; use YYYY-MM-DD` };
  if (date < w.from) return { ok: false, error: `${w.label} start on ${w.from}; ${date} is earlier` };
  if (date > newest) {
    return { ok: true, date: newest, note: `${date} is later than the newest ${w.label} available; showing ${newest}` };
  }
  return { ok: true, date };
}

/** The coverage note: what is shown, plus the clamping note when the date moved. */
export function dateNote(label: string, date: string, note?: string): string {
  return note === undefined ? `${label} for ${date}` : `${label} for ${date} (${note})`;
}
