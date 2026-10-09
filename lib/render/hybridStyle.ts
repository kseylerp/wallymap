/**
 * Pure helpers for the `outdoors-satellite` hybrid basemap: which Outdoors layers would cover the imagery,
 * and how to lighten the hillshade without breaking its zoom expression. `components/mapTiles.ts` applies them.
 */

/** The slice of a Mapbox style layer these helpers read. */
export type StyleLayerLike = {
  id: string;
  type: string;
  "source-layer"?: string;
  layout?: { visibility?: unknown };
};

/** Area fills that paint over the imagery, by id prefix (Outdoors names) ... */
const OCCLUDING_ID =
  /^(landcover|landuse|national-park|land-structure-polygon|wetland|park|pitch|glacier|snow|sand|scrub|wood|grass|golf)/;
/** ... and by vector source layer, so renamed or added fills in a newer Outdoors style are still caught. */
const OCCLUDING_SOURCE_LAYERS = new Set(["landcover", "landuse", "landuse_overlay", "national_park", "wetland", "structure"]);

/** Park, protected-area, land-use and land-structure outlines: green or tan strokes that look wrong on imagery. */
const OCCLUDING_LINE_SOURCE_LAYERS = new Set(["landuse", "landuse_overlay", "national_park"]);
const OCCLUDING_LINE_ID = /park|national|land-structure|landuse/;
/** Lines the hybrid always keeps: roads and paths, water, contours and admin boundaries. */
const KEPT_LINE_SOURCE_LAYERS = new Set(["road", "water", "waterway", "contour", "admin"]);
const KEPT_LINE_ID = /road|path|water|contour/;

/** Labels that sit on the imagery and get white text with a dark halo; road labels and shields are left alone. */
const LABEL_SOURCE_LAYERS = new Set(["natural_label", "poi_label", "place_label", "airport_label"]);

/** Paint the hybrid puts on country and state boundaries: thin white, half opacity. */
export const ADMIN_LINE_PAINT = { "line-color": "rgba(255, 255, 255, 0.5)" } as const;
/** Paint the hybrid puts on labels so they read on any photo. */
export const LABEL_PAINT = {
  "text-color": "#FFFFFF",
  "text-halo-color": "rgba(26, 26, 26, 0.85)",
  "text-halo-width": 1.2,
} as const;

/** A paint property the hybrid sets on one layer. */
export type PaintOverride = { id: string; property: string; value: unknown };

/** True for the terrain shading layers, which the hybrid keeps but lightens. */
export function isHillshadeLayer(layer: StyleLayerLike): boolean {
  return layer.id.includes("hillshade") || layer["source-layer"] === "hillshade";
}

/** True for water area fills, which the hybrid keeps but thins so the real shoreline shows through. */
export function isWaterFill(layer: StyleLayerLike): boolean {
  return layer.type === "fill" && (layer["source-layer"] === "water" || /^water($|-)/.test(layer.id));
}

function isAdminLine(layer: StyleLayerLike): boolean {
  return layer.type === "line" && (layer["source-layer"] === "admin" || layer.id.startsWith("admin"));
}

function isOccludingFill(layer: StyleLayerLike): boolean {
  return (
    layer.type === "fill" &&
    !isHillshadeLayer(layer) &&
    (OCCLUDING_ID.test(layer.id) || OCCLUDING_SOURCE_LAYERS.has(layer["source-layer"] ?? ""))
  );
}

function isOccludingLine(layer: StyleLayerLike): boolean {
  if (layer.type !== "line") return false;
  const sourceLayer = layer["source-layer"] ?? "";
  // An admin boundary's wide soft casing ("-bg") reads as a smear on imagery; the thin line itself stays.
  if (isAdminLine(layer)) return layer.id.endsWith("-bg");
  if (KEPT_LINE_SOURCE_LAYERS.has(sourceLayer) || KEPT_LINE_ID.test(layer.id)) return false;
  return OCCLUDING_LINE_SOURCE_LAYERS.has(sourceLayer) || OCCLUDING_LINE_ID.test(layer.id);
}

/**
 * Ids of the visible layers the hybrid hides: area fills that would cover the imagery (land cover, land use,
 * parks, wetlands, structures), the outlines of parks, protected and land-use areas, and the soft casing under
 * admin boundaries. Water, hillshade, contours, roads, paths, boundaries themselves and labels are kept.
 */
export function occludingLayerIds(layers: readonly StyleLayerLike[]): string[] {
  return layers
    .filter((layer) => layer.layout?.visibility !== "none" && (isOccludingFill(layer) || isOccludingLine(layer)))
    .map((layer) => layer.id);
}

/**
 * The paint the hybrid sets so kept layers read on imagery: country and state boundaries become a faint white
 * line, and natural, POI, place and airport labels become white text on a dark halo.
 */
export function hybridPaintOverrides(layers: readonly StyleLayerLike[]): PaintOverride[] {
  const overrides: PaintOverride[] = [];
  for (const layer of layers) {
    let paint: Record<string, unknown> | null = null;
    if (isAdminLine(layer) && !layer.id.endsWith("-bg")) paint = ADMIN_LINE_PAINT;
    else if (layer.type === "symbol" && LABEL_SOURCE_LAYERS.has(layer["source-layer"] ?? "")) paint = LABEL_PAINT;
    if (!paint) continue;
    for (const [property, value] of Object.entries(paint)) overrides.push({ id: layer.id, property, value });
  }
  return overrides;
}

function scaleOutput(value: unknown, factor: number): unknown {
  return typeof value === "number" ? value * factor : ["*", value, factor];
}

/**
 * Multiplies an opacity-like paint value by `factor`. A zoom expression must stay the top-level
 * `interpolate`/`step`, so its outputs are scaled in place; any other expression is wrapped in `["*", ...]`.
 * `undefined` (the default of 1) becomes `factor`; an unrecognised shape is returned unchanged.
 */
export function scaleOpacity(value: unknown, factor: number): unknown {
  if (value === undefined) return factor;
  if (typeof value === "number") return value * factor;
  if (Array.isArray(value)) {
    const op = value[0];
    if (op === "interpolate" || op === "interpolate-hcl" || op === "interpolate-lab") {
      // ["interpolate", type, input, stop0, out0, stop1, out1, ...]
      return value.map((v, i) => (i >= 4 && i % 2 === 0 ? scaleOutput(v, factor) : v));
    }
    if (op === "step") {
      // ["step", input, out0, stop1, out1, ...]
      return value.map((v, i) => (i >= 2 && i % 2 === 0 ? scaleOutput(v, factor) : v));
    }
    return ["*", value, factor];
  }
  if (typeof value === "object" && value !== null && Array.isArray((value as { stops?: unknown }).stops)) {
    // Legacy zoom function: { stops: [[zoom, value], ...] }.
    const fn = value as { stops: [unknown, unknown][] };
    return { ...fn, stops: fn.stops.map(([z, v]) => [z, typeof v === "number" ? v * factor : v]) };
  }
  return value;
}
