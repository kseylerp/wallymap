import type { BBox } from "../types";

/** Rough US extent (including Alaska and Hawaii); a bbox wholly outside it has no data. */
export const US_EXTENT: BBox = [-170, 18, -65, 72];

/** True when two bboxes share no area (touching edges do not count as disjoint). */
export function bboxesDisjoint(a: BBox, b: BBox): boolean {
  const [aw, as, ae, an] = a;
  const [bw, bs, be, bn] = b;
  return ae < bw || aw > be || an < bs || as > bn;
}

/** True when `bbox` does not touch the rough US extent, so a US-only layer has nothing to return. */
export function outsideUs(bbox: BBox): boolean {
  return bboxesDisjoint(bbox, US_EXTENT);
}

/**
 * Hard area caps for sources whose whole coverage is cheap to rank (a count and the top N): any box up to the source's
 * own extent answers. The lower 48's bounding box is about 15 million km²; with Alaska and Hawaii about 49 million.
 */
export const LOWER_48_KM2 = 16_000_000;
export const WHOLE_US_KM2 = 50_000_000;

export const OUTSIDE_US_NOTE = "No data outside the United States";
