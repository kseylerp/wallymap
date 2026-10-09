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

/**
 * The monochrome research look (owner direction, Task 12): data draws in one ink over white, told apart by symbol
 * shape and dash pattern rather than by color. Only routes keep Wally's purple to coral gradient.
 */
export const INK = "#1F1F1F";

/** Score ramp on `v` (0 to 100): white at 25% alpha up to ink at 70%. */
export const SCORE_RAMP = { from: "#FFFFFF", fromAlpha: 0.25, to: INK, toAlpha: 0.7 } as const;

/** Deck dash arrays ([dash, gap] in line widths) that tell line layers apart; [0, 0] is solid. */
export const LINE_DASHES = {
  solid: [0, 0],
  dashed: [4, 3],
  dotted: [2, 2],
  long: [8, 3],
} as const satisfies Record<string, readonly [number, number]>;

/** The dash per line layer; others take one by a stable hash of their id. */
export const LAYER_LINE_DASH: Record<string, keyof typeof LINE_DASHES> = {
  "osm-trails": "solid",
  "forest-roads": "dashed",
};

/** Polygon fill as a share of ink, per layer: outlines only for boundaries, a 10% wash for events. Default 10%. */
export const POLYGON_INK_FILL: Record<string, number> = {
  "fire-perimeters": 0.1,
  wilderness: 0,
  "public-lands": 0,
  "physical-regions": 0,
};

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
