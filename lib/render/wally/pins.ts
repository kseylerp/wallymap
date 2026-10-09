import type { Feature } from "geojson";

/**
 * Wally teardrop pins (docs/superpowers/specs/2026-10-09-wallymap-m3-design.md §3): one 34×44 sprite per glyph in
 * `public/pins/<glyph>.svg`, a #3A3A3C body (coral for the route start) with a white ring and a white glyph,
 * anchored at the tip.
 */

export const PIN_GLYPHS = [
  "start",
  "camp",
  "put-in",
  "take-out",
  "rapid",
  "hazard",
  "trailhead",
  "spring",
  "viewpoint",
  "species",
  "photo",
  "gauge",
  "snow",
  "fire",
  "road",
  "parking",
  "default",
] as const;

export type PinGlyph = (typeof PIN_GLYPHS)[number];

export type PinIcon = { id: PinGlyph; url: string; width: 34; height: 44; anchorY: 44 };

/** A point layer draws pins while its result has at most this many features; past it, small discs. */
export const pinThreshold = 300;

/** The glyph for every feature of a layer, when it does not depend on the feature. */
const LAYER_GLYPHS: Record<string, PinGlyph> = {
  species: "species",
  photos: "photo",
  streamflow: "gauge",
  snowpack: "snow",
  "fire-detections": "fire",
  "forest-roads": "road",
};

/** Layers whose points are camp sites or parking lots, told apart by `kind`. */
const CAMPSITE_LAYERS = new Set(["campsites", "popularity-campsites"]);

/** The glyph for one feature of a layer. */
export function pinGlyphFor(layerId: string, feature: Feature): PinGlyph {
  if (CAMPSITE_LAYERS.has(layerId)) return feature.properties?.kind === "parking" ? "parking" : "camp";
  return LAYER_GLYPHS[layerId] ?? "default";
}

/** One shared icon object per glyph, so deck.gl's icon atlas sees the same definition every frame. */
const icons = new Map<PinGlyph, PinIcon>(
  PIN_GLYPHS.map((glyph) => [glyph, { id: glyph, url: `/pins/${glyph}.svg`, width: 34, height: 44, anchorY: 44 }]),
);

/** The pin sprite for one feature: its URL and size, anchored at the tip (bottom center). */
export function pinIconFor(layerId: string, feature: Feature): PinIcon {
  return icons.get(pinGlyphFor(layerId, feature))!;
}
