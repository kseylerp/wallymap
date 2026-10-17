/**
 * Where a ranked label goes on screen (spec §12c names a ranked view's top features). A label sits centered above its
 * symbol; near an edge of the clear map it moves inward so it is never cut: near the left or right edge it slides
 * sideways until it fits, near the top it flips below the symbol, and near the bottom it stays above. A label whose
 * point is outside the clear map (off screen, or under a floating panel) is not drawn.
 */

/** Edges of the clear map, in CSS pixels from the canvas's top left. */
export type Bounds = { left: number; top: number; right: number; bottom: number };
export type Insets = { top: number; right: number; bottom: number; left: number };
export type ScreenRect = { left: number; top: number; right: number; bottom: number };

/** A label to place: its point on screen, its text box, and how far above the point its center sits by default. */
export type LabelBox = { x: number; y: number; width: number; height: number; gap: number };

/** Room kept between a label and the edge of the clear map. */
export const LABEL_EDGE_MARGIN_PX = 4;

/**
 * The pixel offset of the label's center from its point, or null when the point is outside `bounds`. The label box
 * stays inside `bounds` less `margin` on every side whenever it fits there.
 */
export function placeLabel(label: LabelBox, bounds: Bounds, margin = LABEL_EDGE_MARGIN_PX): [number, number] | null {
  const { x, y, width, height, gap } = label;
  if (!(x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom)) return null;
  const halfW = width / 2;
  const halfH = height / 2;
  const top = bounds.top + margin + halfH;
  const bottom = bounds.bottom - margin - halfH;
  // Above the symbol, or below it when above would cross the top edge.
  let cy = y - gap;
  if (cy < top) cy = y + gap;
  if (cy > bottom) cy = Math.max(top, bottom);
  const left = bounds.left + margin + halfW;
  const right = bounds.right - margin - halfW;
  const cx = left > right ? (bounds.left + bounds.right) / 2 : Math.min(Math.max(x, left), right);
  return [cx - x, cy - y];
}

/**
 * The insets that keep a canvas clear of floating panels: each panel (clipped to the canvas) pushes in from whichever
 * side leaves the larger clear area, so a left-hand chat panel insets the left and a phone's bottom sheet the bottom.
 */
export function clearInsets(canvas: { width: number; height: number }, panels: ScreenRect[]): Insets {
  let insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const area = (p: Insets) => Math.max(0, canvas.width - p.left - p.right) * Math.max(0, canvas.height - p.top - p.bottom);
  for (const r of panels) {
    const left = Math.max(0, r.left);
    const top = Math.max(0, r.top);
    const right = Math.min(canvas.width, r.right);
    const bottom = Math.min(canvas.height, r.bottom);
    if (right <= left || bottom <= top) continue;
    const options: Insets[] = [
      { ...insets, left: Math.max(insets.left, right) },
      { ...insets, right: Math.max(insets.right, canvas.width - left) },
      { ...insets, top: Math.max(insets.top, bottom) },
      { ...insets, bottom: Math.max(insets.bottom, canvas.height - top) },
    ];
    insets = options.reduce((best, o) => (area(o) > area(best) ? o : best));
  }
  return insets;
}
