/**
 * Where the console scrolls so a layer row shows from its header: the dams row was left scrolled to its opacity slider,
 * with its Rank by header cut off at the top. Pure, so the rule is tested without a browser.
 */

/** A vertical span on screen, in CSS pixels. */
export type Span = { top: number; bottom: number };

/** Rounding slack, in CSS pixels. */
const SLACK = 1;

/**
 * The scrollTop that puts the row's top at the scroller's top, or null when its top already shows: a row whose header
 * is above the visible area or below it is brought to the top; a row whose header shows is left alone.
 */
export function rowScrollTop(scroller: Span, scrollTop: number, row: Span): number | null {
  const headerShows = row.top >= scroller.top - SLACK && row.top < scroller.bottom - SLACK;
  if (headerShows) return null;
  return Math.max(0, scrollTop + (row.top - scroller.top));
}

/**
 * The rows a scroller shows cut at the top, mid-row: their header is above the visible area while the rest of the row
 * shows. Each is a problem: a row is shown from its header or not at all.
 */
export function rowsCutAtTop<T extends Span>(scroller: Span, rows: T[]): T[] {
  return rows.filter((r) => r.top < scroller.top - SLACK && r.bottom > scroller.top + SLACK);
}
