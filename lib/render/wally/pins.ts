import type { Feature } from "geojson";

/**
 * Monochrome cartographic point symbols (docs/superpowers/plans/2026-10-09-m3-wallymap.md, Task 12, owner direction:
 * "a scientific/research look, not consumer"). No icons and no color: each point layer gets a shape, 12px, drawn
 * in a 1.5px #1F1F1F stroke over a white 85% fill on a white halo, from `public/pins/<symbol>.svg` (a 24×24 canvas,
 * anchored at the center). The `-selected` twin fills solid ink. `start.svg` and `default.svg` in the same folder
 * are the route's teardrops, drawn by Mapbox, and are not symbols.
 */

export const PIN_SYMBOLS = [
  "camp",
  "parking",
  "species",
  "photo",
  "gauge",
  "snow",
  "fire",
  "road",
  "trailhead",
  "point",
] as const;

export type PinSymbol = (typeof PIN_SYMBOLS)[number];

export type PinIcon = { id: string; url: string; width: 24; height: 24; anchorY: 12 };

/** The symbol for every feature of a layer, when it does not depend on the feature. */
const LAYER_SYMBOLS: Record<string, PinSymbol> = {
  species: "species",
  photos: "photo",
  streamflow: "gauge",
  snowpack: "snow",
  "fire-detections": "fire",
  "forest-roads": "road",
  trailheads: "trailhead",
};

/** Layers whose points are camp sites or parking lots, told apart by `kind`. */
const CAMPSITE_LAYERS = new Set(["campsites", "popularity-campsites"]);

/** The symbol for one feature of a layer: campsites are triangles (parking squares), unknown layers circles. */
export function pinSymbolFor(layerId: string, feature: Feature): PinSymbol {
  if (CAMPSITE_LAYERS.has(layerId)) return feature.properties?.kind === "parking" ? "parking" : "camp";
  return LAYER_SYMBOLS[layerId] ?? "point";
}

const icon = (symbol: PinSymbol, selected: boolean): PinIcon => {
  const name = `${symbol}${selected ? "-selected" : ""}`;
  return { id: name, url: `/pins/${name}.svg`, width: 24, height: 24, anchorY: 12 };
};
/** One shared icon object per symbol and state, so deck.gl's icon atlas sees the same definition every frame. */
const icons = new Map<PinSymbol, PinIcon>(PIN_SYMBOLS.map((s) => [s, icon(s, false)]));
const selectedIcons = new Map<PinSymbol, PinIcon>(PIN_SYMBOLS.map((s) => [s, icon(s, true)]));

/** The symbol sprite for one feature, anchored at its center; filled solid ink while selected. */
export function pinIconFor(layerId: string, feature: Feature, selected = false): PinIcon {
  return (selected ? selectedIcons : icons).get(pinSymbolFor(layerId, feature))!;
}
