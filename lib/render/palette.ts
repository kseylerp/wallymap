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
/** Off-white scaffold: the low end of area, hex and heat ramps (never lines), and symbol fills (owner's board, points variant A). */
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
  "river-pulse": "data",
  "ocean-currents": "data",
  "wind-flow": "data",
  glaciers: "natural",
  "critical-habitat": "natural",
  "grazing-allotments": "data",
  "gbif-occurrences": "data",
  "protected-areas-world": "natural",
  "fire-hazard": "raster",
  "flood-zones": "hazard",
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
  geology: "data",
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
  "carbon-flux": "raster",
  "condor-range": "natural",
  "dams": "data",
  "wolf-packs": "natural",
  "methane-plumes": "hazard",
  "ports": "data",
  "river-basins": "natural",
  "hardiness-zones": "natural",
  "temperature-anomaly": "data",
  "pipelines-lines": "data",
  "aquifers": "natural",
  "groundwater": "data",
  "power-plants": "data",
  disasters: "hazard",
  "monuments": "natural",
  "tree-mortality": "hazard",
  permafrost: "natural",
  "mining-claims": "hazard",
  "imagery-by-date": "raster",
  "mines": "data",
  "uranium": "hazard",
  avalanche: "hazard",
  "weather-forecast": "data",
};

/**
 * Layers whose legend colors are a published safety standard people read by color (the North American Public Avalanche
 * Danger Scale: green Low to black Extreme): their areas draw in the legend's own colors, not the palette.
 */
export const STANDARD_COLOR_LAYERS: ReadonlySet<string> = new Set(["avalanche"]);

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
 * Data lines draw as native Mapbox line layers (lib/render/nativeLines.ts): crisp, constant pixel widths at every zoom,
 * draped by Mapbox itself on 3D terrain, as the Wally app draws its polylines. Owner (2026-10-14): no dark grey line
 * cores anywhere; dark grey stays for area outlines and symbol strokes. Every line sits on a white casing two pixels
 * wider than its core at 0.9; the selected line is purple 3.5px.
 */
export const TRAIL_LINE = {
  casing: { color: WHITE, width: 4.5, opacity: 0.9 },
  width: 2.5,
  /** Maintained trails, board T1 (owner pick; ruled 2026-10-14): 8px dark grey dashes alternating with the sage core. */
  under: SAGE,
  over: { color: DARK_GREY, dash: [8, 8] as [number, number] },
  selected: { color: PURPLE, width: 3.5 },
} as const;

/**
 * One line class: a core color with a dash in pixels ([on, off]; [0, 0] solid). A `gradient` class runs the Wally
 * route gradient (start color to end color, along the line) instead of one core color; `width` and `casing` override
 * the data line widths (LINE) for the class.
 */
export type LineRecipe = {
  color: string;
  /** A solid core under `color`'s dashes (T1 trails): the two alternate along the line. */
  under?: string;
  dash: [number, number];
  gradient?: readonly [start: string, end: string];
  width?: number;
  casing?: number;
};

/**
 * Line classes on a white casing, told apart by dash. Maintained trails T1 (dark grey 8px dashes alternating with sage;
 * with forest roads the only dark grey on a line), other data lines (streams, mtb, pistes) solid sage, forest roads thin dark grey short dashes
 * (sage dashes vanished on green Topo and read as white noodles on satellite), use (informal, unmaintained) trails sage dots (round caps make a dash as long as
 * the line is wide a dot). Selected lines purple. Named routes (see `isRouteProperties`) take Wally's route gradient,
 * purple at the start to pink at the end, 3px over a white casing with no dash, as the route tool draws a route
 * (lib/render/wally/routeLine.ts). Score lines (popularity) take the sage → pink → purple ramp (`lineRampFor`).
 */
export const LINE_CLASSES = {
  trail: { color: TRAIL_LINE.over.color, under: TRAIL_LINE.under, dash: TRAIL_LINE.over.dash },
  /** Forest roads (coordinator, 2026-10-16): thin dark grey short dashes on the casing, T1's grammar without the sage. */
  road: { color: DARK_GREY, dash: [4, 4], width: 1.75 },
  useTrail: { color: SAGE, dash: [2.5, 6] },
  solid: { color: SAGE, dash: [0, 0] },
  /** Named routes: the Wally gradient (the route tool's ROUTE.start to ROUTE.end), solid, a pixel wider than a path. */
  route: { color: PURPLE, dash: [0, 0], gradient: [PURPLE, PINK], width: 3, casing: 5 },
} as const satisfies Record<string, LineRecipe>;

/** While a feature is selected, the rest of its layer fades to this share of its alpha. */
export const SIBLING_FADE = 0.35;

/**
 * Areas colored by a ramp or by kind (choropleths, categories) fade only to this share while one is selected: the
 * other areas are what the selected one is compared against, and at 0.35 a card open over Texas left every county
 * but the selected one barely tinted (owner, 2026-10-18). The selected area's purple outline marks it.
 */
export const CLASS_SIBLING_FADE = 0.85;

/**
 * While an area is selected, the outlines (and their white casings) of the rest of its layer keep this share of their
 * alpha: their fill fades with SIBLING_FADE, but at 0.35 a glacier's dark 1px outline vanished on satellite ice and the
 * map seemed to hold one glacier (owner, 2026-10-16).
 */
export const AREA_OUTLINE_SIBLING_FADE = 0.8;

/**
 * The change view's delta (spec §12): what only A had (lost) wally pink with a pink hatch, what only B has (gained)
 * purple, unchanged dark grey; lines draw unchanged sage (never a dark grey line).
 */
export const DELTA_COLORS = { "a-only": PINK, "b-only": PURPLE, both: DARK_GREY } as const;
export const DELTA_LINE_COLORS = { "a-only": PINK, "b-only": PURPLE, both: SAGE } as const;

/** A palette color asked for on a line: dark grey and ink read as sage, since no line core is ever dark. */
export function lineColorFor(color: string): string {
  const c = color.trim().toUpperCase();
  return c === DARK_GREY || c === INK ? SAGE : c;
}

export type LineClass = keyof typeof LINE_CLASSES;

/**
 * True when a feature is a named route rather than a plain segment: `kind` is "route" (mtb-trails and paddling route
 * relations, osm-trails' wide-scale hiking routes, ski-routes relations with no piste type) or it carries a `route`
 * property (ski-routes sets `route: true` on piste and route relations of every kind; osm-trails sets the OSM route
 * type, "hiking"). A `route` of false, "no" or "false" does not count.
 */
export function isRouteProperties(properties?: Record<string, unknown> | null): boolean {
  if (!properties) return false;
  if (properties.kind === "route") return true;
  const route = properties.route;
  if (typeof route === "string") return !["", "no", "false", "0"].includes(route.trim().toLowerCase());
  return route === true;
}

/**
 * The line class of a feature on a line layer: a named route (any layer: `kind` "route" or a `route` property) takes the
 * Wally gradient; else OSM trails (use trails when `informal`), forest roads, else solid. Plain paths and piste ways
 * that are not routes keep their own class.
 */
export function lineClassFor(layerId: string, properties?: Record<string, unknown> | null): LineClass {
  if (isRouteProperties(properties)) return "route";
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
  // Owner, 2026-10-17 ("needs to be discernible"): tints a step stronger so areas read on green Topo, outlines on a
  // white casing wide enough that they never pass for contours or borders.
  natural: { color: SAGE, tint: 0.18, hatchAlpha: 0.9, step: 1, outline: DARK_GREY, outlineWidth: 1.25, casing: 1 },
  data: { color: DARK_GREY, tint: 0.16, hatchAlpha: 0.7, step: 1, outline: DARK_GREY, outlineWidth: 1.25, casing: 1 },
};

/** Selected areas: purple tint, hatch and a 2.5px outline over the white casing. */
/** The selected area: an ink outline 2.5px over a white casing; its fill keeps its own color. */
export const SELECTED_AREA = { color: DARK_GREY, outlineWidth: 2.5, casing: 1 } as const;

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

/**
 * Ramp stops, low to high. Lightness falls monotonically along every ramp. Off-white is the low end only for area
 * fills, hex tiles and heat; line ramps (the `*Line` ones) start at sage, because an off-white line reads as plain
 * white on satellite (spec §11a keeps white for casings, hatch lines and 3D edges).
 */
export const RAMPS = {
  density: [OFF_WHITE, SAGE, PURPLE, DARK_GREY],
  popularity: [OFF_WHITE, PINK, PURPLE],
  remoteness: [OFF_WHITE, SAGE, DARK_GREY],
  /** Owner's board, hex tiles variant A: a plain gray ramp. */
  gray: [OFF_WHITE, DARK_GREY],
  /** Score and facet lines (trail popularity, difficulty): sage → pink → purple. Never dark grey on a line. */
  scoreLine: [SAGE, PINK, PURPLE],
  /**
   * Score lines (trail popularity, remoteness): pink → purple, so the lowest scores still read on green Topo (pale sage
   * vanished there, lines fixer 2026-10-18). The legend draws the same ramp.
   */
  scoreLineVisible: [PINK, PURPLE],
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

/**
 * Which ramp a layer's lines use: score lines (popularity, remoteness) pink → purple so low scores read on Topo; other
 * lines sage → pink → purple (owner, 2026-10-14: no dark grey line
 * cores), which starts at sage instead of off-white so the low end never reads as plain white on satellite.
 */
export function lineRampFor(layerId: string): RampName {
  return layerRole(layerId) === "score" || layerId.startsWith("popularity") || layerId === "remoteness" ? "scoreLineVisible" : "scoreLine";
}

// ---- Symbols ----

/**
 * Point symbols (owner's board, variant A), tuned to read on all three basemaps (owner, 2026-10-11): a dark grey 1.75px
 * stroke at full opacity, off-white fill at 0.85 (0.6 on the hollow classes, ring and square, so they still read as
 * marks on dark or busy ground), and a white halo 3.5px wide across the outline (1.75px a side) at 0.9. The symbol is
 * `sizeMax` px from zoom `sizeMaxZoom` up, easing down to `sizeMin` px at `sizeMinZoom` and never below. Strokes and
 * halos stay these exact pixel widths at every size. Glyph layers (owner, 2026-10-11: "try for simple icons") put a
 * line glyph inside the disc: its 24×24 drawing shrunk to `glyphScale` and stroked dark grey `glyphStrokeWidth` px.
 */
export const SYMBOL = {
  stroke: DARK_GREY,
  strokeWidth: 1.75,
  fill: OFF_WHITE,
  fillOpacity: 0.85,
  hollowFillOpacity: 0.6,
  halo: WHITE,
  haloWidth: 3.5,
  haloOpacity: 0.9,
  selectedFill: PURPLE,
  hazardFill: PINK,
  sizeMax: 14,
  sizeMin: 10,
  sizeMaxZoom: 11,
  sizeMinZoom: 6,
  glyphScale: 0.42,
  glyphStrokeWidth: 1.25,
} as const;

/** The symbol's on-screen size in whole pixels at a map zoom: 10 at zoom 6 and below, 14 at zoom 11 and above. */
export function symbolSizePx(zoom: number): number {
  const z = Number.isFinite(zoom) ? zoom : SYMBOL.sizeMinZoom;
  const t = Math.min(1, Math.max(0, (z - SYMBOL.sizeMinZoom) / (SYMBOL.sizeMaxZoom - SYMBOL.sizeMinZoom)));
  return Math.round(SYMBOL.sizeMin + t * (SYMBOL.sizeMax - SYMBOL.sizeMin));
}

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

/**
 * The "Data only" basemap (spec §13): land off-white, water the off-white surface, a dark grey hairline coast and
 * faint dashed country lines; no roads, labels or relief, so the data draws the land.
 */
export const DATA_ONLY_BASEMAP = {
  land: OFF_WHITE,
  water: SURFACE,
  coast: DARK_GREY,
  coastOpacity: 0.35,
  borderOpacity: 0.3,
  stateOpacity: 0.18,
  label: DARK_GREY,
  labelOpacity: 0.62,
  labelHalo: OFF_WHITE,
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

/**
 * Third-party raster tiles (NASA GIBS, GFW, USGS ...) arrive in their own saturated colors. Mapbox raster paint calms
 * them: with no per-layer hint every raster is desaturated this much and drawn at this opacity. A layer's
 * `style.raster` overrides either; `raster: null` (imagery) skips both.
 */
export const RASTER_CALM = { saturation: -0.55, opacity: 0.72 } as const;
/** The opacity raster tiles drawn as served (`raster: null`) keep. */
export const RASTER_AS_SERVED_OPACITY = 0.8;
