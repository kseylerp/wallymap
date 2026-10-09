/**
 * Tuning for the popularity estimate (layers/popularity.ts). Weights sum to 1; each signal is
 * rank-normalized to 0..1 within the features in view before weighting, so a score compares
 * features in the same view, not across the world.
 */
export const POPULARITY_WEIGHTS = {
  photosWithin500m: 0.35,
  parkingCapacityWithin1km: 0.25,
  hasWikiLink: 0.15,
  informalTrailsWithin500m: 0.15,
  named: 0.1,
} as const;

export type PopularitySignal = keyof typeof POPULARITY_WEIGHTS;

/** Radius for counting photos near a feature. */
export const PHOTO_RADIUS_KM = 0.5;
/** Radius for summing parking capacity near a feature. */
export const PARKING_RADIUS_KM = 1;
/** Radius for counting informal (social) trails near a feature. */
export const INFORMAL_RADIUS_KM = 0.5;
/** A long trail is measured from at most this many evenly spaced vertices (plus its midpoint). */
export const MAX_SAMPLE_POINTS_PER_LINE = 24;
