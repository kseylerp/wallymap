/**
 * Tuning for the remoteness score (layers/remoteness.ts). Weights sum to 1 and are fixed, so a
 * score means the same thing in every view: the wilderness and no-campsite parts are bonuses on
 * top of road distance, and where a bonus cannot be known (outside the US) it scores 0.
 */
export const REMOTENESS_WEIGHTS = {
  roadDistance: 0.7,
  wilderness: 0.2,
  noCamps: 0.1,
} as const;

/** Road distance stops adding remoteness past this. */
export const ROAD_DISTANCE_CAP_KM = 20;
/** A cell with no camp site this close gets the no-camps bonus. */
export const CAMP_RADIUS_KM = 2;
/** Most H3 cells one request may fill; above it the layer asks for a lower resolution or a smaller view. */
export const MAX_CELLS = 4_000;
/** Road vertices kept after thinning, to bound memory and nearest-road search time. */
export const MAX_ROAD_VERTICES = 50_000;
/** Roads are fetched this far beyond the view so edge cells see roads just outside it. */
export const ROAD_PADDING_KM = 3;

/** OSM highway values that count as a road or track (paths, footways, steps and cycleways do not). */
export const ROAD_HIGHWAYS = [
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "service",
  "track",
  "living_street",
  "road",
] as const;
