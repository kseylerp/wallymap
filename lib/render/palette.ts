/**
 * The satellite-safe data palette (docs/superpowers/specs/2026-10-09-wildmap-restyle.md, "Data palette for
 * satellite imagery") and Wally's land-manager palette (2026-10-09-wallymap-m3-design.md §3). The default basemap
 * is imagery, so every data color must stand out against forest green, water blue, rock gray and snow white.
 */

/** Per-layer data colors, by layer id. Tile layers (raster imagery) keep their own colors and are not listed. */
export const DATA_COLORS = {
  "osm-trails": "#2F3A44",
  "fire-perimeters": "#FF5A36",
  "fire-detections": "#FF5A36",
  snowpack: "#CFF2FF",
  streamflow: "#3FA9F5",
  species: "#E24BB1",
  photos: "#FFD23F",
  campsites: "#F2A33A",
  "forest-roads": "#F2A33A",
  "public-lands": "#B9A6FF",
  wilderness: "#B9A6FF",
  "physical-regions": "#FFFFFF",
  popularity: "#F2A33A",
  "popularity-campsites": "#F2A33A",
  remoteness: "#FFFFFF",
} as const;

/** Every color in the data palette; a registered layer's `style.color` must be one of these. */
export const DATA_PALETTE: ReadonlySet<string> = new Set(Object.values(DATA_COLORS));

/** Layers that return raster tiles: the imagery carries its own colors, so they are exempt from the palette. */
export const RASTER_TILE_LAYERS: ReadonlySet<string> = new Set(["forest-loss", "forest-alerts", "population", "night-lights"]);

/** Raster tile layers draw their own imagery colors; their swatch shows this neutral gray. */
export const TILE_SWATCH = "#9A9A96";

/** Score ramp on `v` (0 to 100): white at 25% alpha up to amber at 70%. */
export const SCORE_RAMP = { from: "#FFFFFF", fromAlpha: 0.25, to: "#F2A33A", toAlpha: 0.7 } as const;

/** Wally's public land palette by manager (PAD-US `agency`), plus wilderness designations. */
export const LAND_MANAGER_COLORS = {
  NPS: "#357647",
  USFS: "#7E9A54",
  BLM: "#C9A254",
  FWS: "#488C89",
  State: "#4A7DB5",
  Wilderness: "#24543A",
  other: "#B9A6FF",
} as const;

/** Wally's basemap-trail look for trails on plain Outdoors: green dashes over a white casing. */
export const OUTDOORS_TRAIL = {
  /** A shade darker than Wally's #16A34A so the dashes read over Outdoors' green park fills. */
  color: "#15803D",
  /** Mapbox `line-dasharray` in line widths. */
  dash: [2, 1.6] as const,
  /** Widths in pixels at zoom 11, 14 and 18 (interpolated linearly, clamped outside). */
  zooms: [11, 14, 18] as const,
  casing: [1.8, 2.6, 4.6] as const,
  core: [1.1, 1.7, 3.2] as const,
  /** Added to every casing width so the white edge frames the dashes on green fills. */
  casingExtra: 0.6,
};

/** The Wally pin body, and the coral start pin. */
export const PIN_BODY = "#3A3A3C";
export const PIN_START = "#F57272";

/** Contours in the hybrid, as Wally draws them over imagery, faded out from z13 to z14 where they get busy. */
export const CONTOUR_PAINT = { color: "#FAF9F5", opacity: 0.85, width: 0.6, minzoom: 9, fadeFrom: 13, fadeTo: 14 } as const;
