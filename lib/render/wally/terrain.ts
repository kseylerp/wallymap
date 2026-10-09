import type {
  FillExtrusionLayerSpecification,
  FogSpecification,
  RasterDEMSourceSpecification,
  SkyLayerSpecification,
  TerrainSpecification,
} from "mapbox-gl";

/**
 * Wally's 3D look (docs/superpowers/specs/2026-10-09-wallymap-m3-design.md §3): terrain on by default, a warm
 * sky, light fog, extruded buildings from zoom 13.5, and the pitch presets the camera uses. Pure specs only;
 * `components/MapCanvas.tsx` adds them to the map on every style load.
 */

export const TERRAIN_SOURCE_ID = "wally-dem";
export const SKY_LAYER_ID = "wally-sky";
export const BUILDINGS_LAYER_ID = "wally-buildings";
/** Wally iOS: `mapbox-terrain-dem-v1` drawn 1.2× taller than life so ridges read at a glance. */
export const TERRAIN_EXAGGERATION = 1.2;
/** At or above this zoom an arriving camera tilts to the Explore pitch; below it the globe stays flat. */
export const ARRIVAL_MIN_ZOOM = 10;
/** Camera ease for pitch changes (Wally: 300–500 ms, ease-in-out). */
export const PITCH_EASE_MS = 400;
/** Buildings appear at this zoom and fade in over the next 1.5 zoom levels (Wally iOS). */
export const BUILDINGS_MIN_ZOOM = 13.5;

/** The camera presets: Explore when arriving somewhere, Detail on a selected feature, Follow for route playback. */
export type PitchKind = "explore" | "detail" | "follow";

const PITCH: Record<PitchKind, number> = { explore: 45, detail: 72, follow: 65 };

export function pitchFor(kind: PitchKind): number {
  return PITCH[kind];
}

/** Ease-in-out cubic, the curve Wally's camera moves use. */
export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** The pitch a camera landing at `zoom` takes: Explore at trail zooms unless the user flattened the map. */
export function arrivalPitch(zoom: number, flattened: boolean): number {
  return !flattened && zoom >= ARRIVAL_MIN_ZOOM ? pitchFor("explore") : 0;
}

/**
 * How far to back the zoom off after fitting a bbox at pitch 0 and then tilting the camera. Tilting pushes the
 * far half of the view toward the horizon, so a tight fit would lose the far edge of the target. The amounts are
 * a heuristic tuned by eye on Tahoe and Chamonix fits: 0.4 at Explore (45°), 0.8 at Detail (72°), linear between
 * and from 0 at a flat camera.
 */
export function fitZoomOffset(pitch: number): number {
  if (!(pitch > 0)) return 0;
  const explore = pitchFor("explore");
  if (pitch <= explore) return (0.4 * pitch) / explore;
  const detail = pitchFor("detail");
  return 0.4 + (0.4 * (Math.min(pitch, detail) - explore)) / (detail - explore);
}

/** Wally iOS terrain source: Mapbox's DEM at tileSize 514 (512 plus a 1px border each side), max zoom 14. */
export function terrainSource(): RasterDEMSourceSpecification {
  return { type: "raster-dem", url: "mapbox://mapbox.mapbox-terrain-dem-v1", tileSize: 514, maxzoom: 14 };
}

export function terrainSpec(exaggeration = TERRAIN_EXAGGERATION): TerrainSpecification {
  return { source: TERRAIN_SOURCE_ID, exaggeration };
}

/** An atmosphere sky with a warm horizon, faded out at globe zooms so the world view stays a clean globe. */
export function skySpec(): SkyLayerSpecification {
  return {
    id: SKY_LAYER_ID,
    type: "sky",
    paint: {
      "sky-type": "atmosphere",
      "sky-atmosphere-sun": [0, 80],
      "sky-atmosphere-sun-intensity": 10,
      "sky-atmosphere-color": "#F4E4CC",
      "sky-atmosphere-halo-color": "#FFF3E0",
      "sky-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0, 7, 1],
    },
  };
}

/**
 * Light, warm fog that softens the horizon when the camera is pitched. Only applied when the style brings no fog
 * of its own, so the satellite hybrid's clearer atmosphere (components/mapTiles.ts) keeps winning there.
 */
export function fogSpec(): FogSpecification {
  return {
    range: [1, 12],
    color: "#F6EFE4",
    "high-color": "#C9DCEB",
    "horizon-blend": 0.06,
    "space-color": "#0B1020",
    "star-intensity": 0.15,
  };
}

/** Wally's buildings: flat gray extrusions from the Streets `building` layer, fading to 0.6 opacity by zoom 15. */
export function buildingsSpec(source = "composite"): FillExtrusionLayerSpecification {
  return {
    id: BUILDINGS_LAYER_ID,
    type: "fill-extrusion",
    source,
    "source-layer": "building",
    minzoom: BUILDINGS_MIN_ZOOM,
    filter: ["==", ["get", "extrude"], "true"],
    paint: {
      "fill-extrusion-color": "#D9D9D9",
      "fill-extrusion-height": ["coalesce", ["get", "height"], 0],
      "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
      "fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], BUILDINGS_MIN_ZOOM, 0, BUILDINGS_MIN_ZOOM + 1.5, 0.6],
    },
  };
}

/** The first symbol layer in the style: buildings go just below it so labels stay on top. */
export function firstSymbolLayerId(layers: readonly { id: string; type: string }[]): string | undefined {
  return layers.find((layer) => layer.type === "symbol")?.id;
}
