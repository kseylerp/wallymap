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

/** True for the terrain shading layers, which the hybrid keeps but lightens. */
export function isHillshadeLayer(layer: StyleLayerLike): boolean {
  return layer.id.includes("hillshade") || layer["source-layer"] === "hillshade";
}

/** True for water area fills, which the hybrid keeps but thins so the real shoreline shows through. */
export function isWaterFill(layer: StyleLayerLike): boolean {
  return layer.type === "fill" && (layer["source-layer"] === "water" || /^water($|-)/.test(layer.id));
}

/**
 * Ids of the visible fill layers that would hide the satellite imagery: land cover, land use, parks,
 * wetlands, structures and similar areas. Water, hillshade, contours, roads, paths and labels are kept.
 */
export function occludingLayerIds(layers: readonly StyleLayerLike[]): string[] {
  return layers
    .filter(
      (layer) =>
        layer.type === "fill" &&
        layer.layout?.visibility !== "none" &&
        !isHillshadeLayer(layer) &&
        (OCCLUDING_ID.test(layer.id) || OCCLUDING_SOURCE_LAYERS.has(layer["source-layer"] ?? "")),
    )
    .map((layer) => layer.id);
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
