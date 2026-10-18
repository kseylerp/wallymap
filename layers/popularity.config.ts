/**
 * Tuning for the popularity estimates (layers/popularity.ts).
 *
 * Trails (layer `popularity`) are scored per named trail, not per OpenStreetMap way: ways are merged by name (an
 * unnamed way takes the name of the hiking route it belongs to), so one trail takes one rank slot. Each signal is
 * scaled 0..1 within the trails in view (log scale against the largest in view for counts), so a score compares trails
 * in the same view, not across the world. Weights sum to 1. Calibrated 2026-10-18 against Yosemite Valley, Zion
 * Canyon and Mount Rainier's Paradise area (layers/popularity.test.ts holds the ranks).
 */
export const TRAIL_WEIGHTS = {
  /**
   * Wikipedia page views over the last 60 days: the trail's own article (scaled by the share of a long route that lies
   * in view) plus the best-known place it leads to (waterfall, summit, viewpoint, lake), and a quarter of the others.
   */
  wikipediaViews: 0.45,
  /** The trail has its own Wikipedia article or Wikidata item (on its ways or its hiking route). */
  ownArticle: 0.15,
  /**
   * Geotagged photos along the trail's busiest kilometre (not its whole length, so a long trail does not win by
   * length): Commons photos within TRAIL_PHOTO_RADIUS_KM, Mapillary images only on the trail itself.
   */
  photos: 0.1,
  /** How many named destinations the trail reaches (up to DESTINATION_CAP). */
  destinations: 0.1,
  /** The trail is part of a mapped hiking route. */
  hikingRoute: 0.15,
  /** The largest parking lot near the trail, in spaces (weak in parks served by shuttles, so it weighs little). */
  parking: 0.05,
} as const;

export type TrailSignal = keyof typeof TRAIL_WEIGHTS;

/** A destination counts as reached when it lies within this distance of the trail. */
export const REACH_KM = 0.25;
/** Destinations past this many add nothing to the count signal. */
export const DESTINATION_CAP = 3;
/** Wikimedia Commons photos within this distance of the trail count toward its busiest kilometre. */
export const TRAIL_PHOTO_RADIUS_KM = 0.25;
/**
 * Mapillary images count only within this distance of the trail line: they are taken walking or driving, so one 200 m
 * off a trail was taken on the road beside it, not by a hiker.
 */
export const ON_TRAIL_KM = 0.04;
/** Trails shorter than this in view (a 30 m stub named "Museum") are left out. */
export const MIN_TRAIL_KM = 0.05;
/** A named way shorter than this that belongs to a hiking route is a piece of it ("The Cables", a bridge) and joins it. */
export const PIECE_MAX_KM = 1;
/** The stretch of trail whose photos are counted (its busiest such stretch). */
export const BUSIEST_STRETCH_KM = 1;
/** Parking lots within this distance of the trail count (the largest one is taken). */
export const TRAIL_PARKING_RADIUS_KM = 0.5;
/** A parking lot mapped without a capacity counts as this many spaces. */
export const UNKNOWN_LOT_SPACES = 10;
/** Share of each destination's views, after the best one, that counts toward the trail. */
export const OTHER_DESTINATION_SHARE = 0.25;
/** Days of Wikipedia page views read (the most the Wikipedia API's pageviews property serves). */
export const PAGEVIEW_DAYS = 60;

/**
 * Tuning for the camp site estimate (layer `popularity-campsites`). Weights sum to 1; each signal is rank-normalized to
 * 0..1 within the features in view before weighting.
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
