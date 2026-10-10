/**
 * The approved palette (docs/superpowers/specs/2026-10-09-wallymap-m3-design.md §11 and §11a) and every map color
 * recipe built from it. This is the only file under lib/render and components that may spell a hex color
 * (tests/tokens.test.ts enforces it); CSS tokens live in app/globals.css.
 *
 * Five colors carry data: wally pink, purple, sage, off-white (ramp low ends only) and dark grey. Ink is for text.
 * White is reserved for three uses: hatch lines, casings and selected outlines, and 3D volumes and edges.
 */

/** Wally pink: route start, compare side B, hazards (fire perimeters and detections, forest alerts). */
export const PINK = "#F57272";
/** Wally purple: selection, the active trail, the time window and playhead, compare side A. */
export const PURPLE = "#6E5BFF";
/** Sage: natural and protected areas (wilderness, public lands, physical regions). */
export const SAGE = "#9FB693";
/** Off-white scaffold: the low end of every ramp, and symbol fills (owner's board, points variant A). */
export const OFF_WHITE = "#FAF9F5";
/** Off-white surface. */
export const SURFACE = "#ECEAE7";
/** Dark grey: data lines, symbol strokes, polygon outlines, hex count labels. */
export const DARK_GREY = "#3A3A3C";
/** Ink: text only. */
export const INK = "#1F1F1F";
/** White: hatch lines, casings and selected outlines, 3D volumes and edges. Never a data fill on its own. */
export const WHITE = "#FFFFFF";

/** Every approved color. */
export const PALETTE: ReadonlySet<string> = new Set([PINK, PURPLE, SAGE, OFF_WHITE, SURFACE, DARK_GREY, INK, WHITE]);

/** True when `color` (any case, `#rrggbb`) is an approved palette color. */
export function isPaletteColor(color: string | undefined): color is string {
  return color !== undefined && PALETTE.has(color.trim().toUpperCase());
}

// ---- Roles per layer ----

/**
 * What a layer is, which picks its color: `hazard` pink, `natural` sage, `data` dark grey. `score` layers shade by a
 * ramp on `v` (popularity, remoteness); `raster` layers draw their own imagery.
 */
export type LayerRole = "hazard" | "natural" | "data" | "score" | "raster";

export const LAYER_ROLES: Record<string, LayerRole> = {
  "fire-perimeters": "hazard",
  "fire-detections": "hazard",
  "forest-alerts": "raster",
  wilderness: "natural",
  "public-lands": "natural",
  "physical-regions": "natural",
  "osm-trails": "data",
  "forest-roads": "data",
  campsites: "data",
  "mtb-trails": "data",
  "ski-routes": "data",
  climbing: "data",
  paddling: "data",
  "outdoor-features": "data",
  species: "data",
  photos: "data",
  snowpack: "data",
  streamflow: "data",
  glaciers: "natural",
  "critical-habitat": "natural",
  "grazing-allotments": "data",
  "gbif-occurrences": "data",
  "protected-areas-world": "raster",
  "fire-hazard": "raster",
  "flood-zones": "raster",
  drought: "hazard",
  popularity: "score",
  "popularity-campsites": "score",
  remoteness: "score",
  "forest-loss": "raster",
  population: "raster",
  "night-lights": "raster",
  surf: "data",
  tides: "data",
  lakes: "data",
  fishing: "data",
  "weather-alerts": "hazard",
  earthquakes: "hazard",
  smoke: "hazard",
  "fire-weather": "hazard",
  "recreation-sites": "data",
  peaks: "data",
  "wikipedia-nearby": "data",
  "geologic-unit": "data",
  geology: "raster",
  greenness: "raster",
  "snow-cover": "raster",
  "land-cover": "raster",
  "surface-water": "raster",
  "flood-extent": "raster",
  disturbance: "raster",
  "sea-ice": "raster",
  phenology: "raster",
  "burn-severity": "raster",
  "sequoia-groves": "natural",
  "sea-level-trends": "data",
  "sequoia-mortality": "hazard",
  "reservoir-levels": "data",
  "sea-level-rise": "raster",
  "old-growth": "natural",
};

/** Layers that return raster tiles: the imagery carries its own colors. */
export const RASTER_TILE_LAYERS: ReadonlySet<string> = new Set(
  Object.entries(LAYER_ROLES)
    .filter(([, role]) => role === "raster")
    .map(([id]) => id),
);

export const ROLE_COLORS: Record<LayerRole, string> = {
  hazard: PINK,
  natural: SAGE,
  data: DARK_GREY,
  score: DARK_GREY,
  raster: DARK_GREY,
};

/** A layer's role; unknown layers are plain data. */
export function layerRole(layerId: string): LayerRole {
  return LAYER_ROLES[layerId] ?? "data";
}

/** A layer's palette color (its `style.color`, swatch and legend color). */
export function layerColor(layerId: string): string {
  return ROLE_COLORS[layerRole(layerId)];
}

// ---- Lines ----

/**
 * Trails (owner, style board: "some combo of white, black, sage with dashes, breaks, change in order, sort of like
 * line B"). The owner is still choosing between variants on the style board, so the whole recipe lives here and a
 * swap is a change to this constant only. Today: railroad-style alternating dashes, dark grey over a solid sage core,
 * on a white casing. `under` draws solid, `over` draws dashed on top of it (`dash` in pixels, [on, off]).
 */
export const TRAIL_LINE = {
  casing: { color: WHITE, width: 4.5, opacity: 0.9 },
  width: 2.5,
  under: SAGE,
  over: { color: DARK_GREY, dash: [8, 8] as [number, number] },
  selected: { color: PURPLE, width: 3.5 },
} as const;

/** One line class: a core color (optionally over a solid `under` color) with a dash in pixels ([0, 0] solid). */
export type LineRecipe = { color: string; under?: string; dash: [number, number] };

/**
 * Line classes (owner's board, lines B + C): a dark grey core on a white casing, with one quiet palette hue per class
 * where a class exists, told apart by dash and order. Trails as TRAIL_LINE, forest roads dark grey dashes, use
 * (informal, unmaintained) trails sage dots, other data lines (streams, water) solid dark grey. Selected lines purple.
 */
export const LINE_CLASSES = {
  trail: { color: TRAIL_LINE.over.color, under: TRAIL_LINE.under, dash: TRAIL_LINE.over.dash },
  road: { color: DARK_GREY, dash: [10, 7.5] },
  /** Short dashes as long as the line is wide read as dots at 2.5px (deck has no round dash caps). */
  useTrail: { color: SAGE, dash: [2.5, 6] },
  solid: { color: DARK_GREY, dash: [0, 0] },
} as const satisfies Record<string, LineRecipe>;

export type LineClass = keyof typeof LINE_CLASSES;

/** The line class of a feature on a line layer: OSM trails (use trails when `informal`), forest roads, else solid. */
export function lineClassFor(layerId: string, properties?: Record<string, unknown> | null): LineClass {
  if (layerId === "osm-trails") return properties?.informal === true ? "useTrail" : "trail";
  if (layerId === "forest-roads") return "road";
  return "solid";
}

/** Data line widths in pixels: the core and the white casing it sits on (selected: TRAIL_LINE.selected). */
export const LINE = { width: TRAIL_LINE.width, casing: TRAIL_LINE.casing.width, casingOpacity: TRAIL_LINE.casing.opacity } as const;

// ---- Polygons and hatching ----

/** Hatch line spacing in CSS pixels, sparse to dense (spec §11: five densities, 12 → 3 px). */
export const HATCH_SPACINGS = [12, 9, 6, 4, 3] as const;
/** Hatch line width in CSS pixels. */
export const HATCH_LINE_PX = 1;
/** The colors the hatch atlas carries: the four non-white palette colors, and white for dark tints. */
export const HATCH_COLORS = [PINK, PURPLE, SAGE, DARK_GREY, WHITE] as const;
export type HatchColor = (typeof HATCH_COLORS)[number];

/**
 * How an area layer draws (deck polygons and the public-lands vector tiles): a tint of its color behind a 45° hatch
 * in the same color, under an outline over a white casing. `step` is the hatch density (index into HATCH_SPACINGS)
 * when the layer has no value to encode.
 */
export type AreaRecipe = {
  color: string;
  tint: number;
  hatchAlpha: number;
  step: number;
  outline: string;
  outlineWidth: number;
  casing: number;
};

const AREA_RECIPES: Record<"hazard" | "natural" | "data", AreaRecipe> = {
  // Fire must read as fire on any basemap: pink tint, pink hatch (denser for larger fires), pink outline.
  hazard: { color: PINK, tint: 0.15, hatchAlpha: 1, step: 2, outline: PINK, outlineWidth: 1.5, casing: 1 },
  natural: { color: SAGE, tint: 0.12, hatchAlpha: 0.9, step: 1, outline: DARK_GREY, outlineWidth: 1, casing: 0.75 },
  data: { color: DARK_GREY, tint: 0.1, hatchAlpha: 0.7, step: 1, outline: DARK_GREY, outlineWidth: 1, casing: 0.75 },
};

/** Selected areas: purple tint, hatch and a 2.5px outline over the white casing. */
export const SELECTED_AREA = { color: PURPLE, outlineWidth: 2.5, casing: 1 } as const;

/** The area recipe for a layer, recolored when a palette color was asked for (a compare side, the layer panel). */
export function areaRecipe(layerId: string, requested?: string): AreaRecipe {
  const role = layerRole(layerId);
  const base = AREA_RECIPES[role === "hazard" || role === "natural" ? role : "data"];
  if (!requested || !isPaletteColor(requested) || requested.toUpperCase() === base.color) return base;
  const color = requested.toUpperCase();
  return { ...base, color, outline: color };
}

/** Burned-acre bounds between the five hatch densities: under 100 sparsest, 100k and up densest. */
export const FIRE_ACRE_STEPS = [100, 1_000, 10_000, 100_000] as const;

// ---- Ramps (stops; lib/render/ramp.ts interpolates them in OKLCH) ----

/** Ramp stops, low to high. Lightness falls monotonically along every ramp. */
export const RAMPS = {
  density: [OFF_WHITE, SAGE, PURPLE, DARK_GREY],
  popularity: [OFF_WHITE, PINK, PURPLE],
  remoteness: [OFF_WHITE, SAGE, DARK_GREY],
  /** Owner's board, hex tiles variant A: a plain gray ramp. */
  gray: [OFF_WHITE, DARK_GREY],
} as const satisfies Record<string, readonly string[]>;
export type RampName = keyof typeof RAMPS;

/** Compare (spec §7): side A purple, side B pink, unchanged dark grey; the diverging ramp runs A ← off-white → B. */
export const COMPARE_COLORS = { a: PURPLE, b: PINK, both: DARK_GREY, mid: OFF_WHITE } as const;

/** Which ramp a score layer uses. */
export function scoreRampFor(layerId: string): RampName {
  if (layerId === "remoteness") return "remoteness";
  if (layerId.startsWith("popularity")) return "popularity";
  return "density";
}

// ---- Symbols ----

/** Point symbols (owner's board, variant A): dark grey 1.5px stroke, off-white fill at 0.85, a white 3.5px halo. */
export const SYMBOL = {
  stroke: DARK_GREY,
  strokeWidth: 1.5,
  fill: OFF_WHITE,
  fillOpacity: 0.85,
  halo: WHITE,
  haloWidth: 3.5,
  haloOpacity: 0.85,
  selectedFill: PURPLE,
  hazardFill: PINK,
} as const;

// ---- Hex tiles and columns ----

/**
 * Dense points as flat H3 tiles (owner's board, variant A): the gray ramp from off-white (fewest) to dark grey
 * (busiest, log scaled) at 0.55 to 0.80 opacity, white 1px edges at 0.8, dark grey counts on a white halo from 2.
 */
export const HEX_TILE = {
  ramp: "gray" as RampName,
  alpha: [0.55, 0.8] as const,
  edge: WHITE,
  edgeAlpha: 0.8,
  coverage: 0.94,
  labelMin: 2,
  labelSize: 11,
  label: DARK_GREY,
  labelHalo: WHITE,
} as const;

/**
 * Extruded hex columns (owner's board, variant C): translucent white volumes with dark grey edges and white caps
 * outlined in dark grey; only the tallest column takes purple, with its count. White is allowed: 3D is one of its uses.
 */
export const HEX_COLUMN = {
  wall: WHITE,
  wallAlpha: 0.26,
  cap: WHITE,
  capAlpha: 0.78,
  capOutline: DARK_GREY,
  capOutlinePx: 1.25,
  edge: DARK_GREY,
  edgeAlpha: 0.4,
  top: PURPLE,
  topCapAlpha: 0.95,
  topWallAlpha: 0.55,
  label: DARK_GREY,
  labelHalo: WHITE,
} as const;

// ---- Basemap, routes and atmosphere ----

/** Contours in the hybrid, as Wally draws them over imagery, faded out from z13 to z14 where they get busy. */
export const CONTOUR_PAINT = { color: OFF_WHITE, opacity: 0.85, width: 0.6, minzoom: 9, fadeFrom: 13, fadeTo: 14 } as const;

/** Basemap labels on the satellite hybrid: white text on an ink halo. */
export const HYBRID_LABEL = { text: WHITE, halo: INK } as const;

/** Routes: the purple to pink gradient over a white casing; mile dots dark grey on a white ring. */
export const ROUTE = { start: PURPLE, end: PINK, casing: WHITE, dart: WHITE, mileDot: DARK_GREY, mileRing: WHITE, label: DARK_GREY } as const;

/** Route waypoint symbols: the start pink, the end and via stops off-white, all stroked dark grey. */
export const ROUTE_PIN = { start: PINK, end: OFF_WHITE, via: OFF_WHITE, stroke: DARK_GREY, halo: WHITE } as const;

/** The 3D sky and fog: a warm horizon over a light fog (basemap atmosphere, not data). */
export const ATMOSPHERE = {
  sky: "#F4E4CC",
  skyHalo: "#FFF3E0",
  fog: "#F6EFE4",
  fogHigh: "#C9DCEB",
  space: "#0B1020",
} as const;

/** Buildings: off-white surface extrusions. */
export const BUILDINGS = SURFACE;

// ---- Point render modes (clusters, columns) ----

/**
 * Cluster blobs (render mode `clusters`): circles sized by count on the gray density ramp (off-white for the smallest
 * group, darkening with the log of the count up to `rampMax`), a dark grey outline, and the count in dark grey on a
 * white halo.
 * Radius grows from `minPx` with the log of the count, up to `maxPx`. Singletons keep the layer's own symbol.
 */
export const CLUSTER_BLOB = {
  ramp: "gray" as RampName,
  /** The busiest blob stops this far along the ramp: a full dark grey fill swallowed its dark grey count. */
  rampMax: 0.62,
  alpha: 0.85,
  outline: DARK_GREY,
  outlinePx: 1.25,
  minPx: 11,
  maxPx: 30,
  label: DARK_GREY,
  labelHalo: WHITE,
  labelSize: 11,
} as const;

/**
 * Column walls (render mode `columns`, owner's board 3D C): translucent white at three strengths by height, tallest
 * third first (0.34, 0.26, 0.18), so the tall columns read as the solid ones. Caps, edges and the purple tallest cell
 * follow HEX_COLUMN.
 */
export const COLUMN_WALL_ALPHAS = [0.34, 0.26, 0.18] as const;
