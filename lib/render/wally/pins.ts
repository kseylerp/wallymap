import type { Feature } from "geojson";
import { layerRole, ROUTE_PIN, scoreRampFor, SYMBOL } from "@/lib/render/palette";
import { rampColor, rgbToHex } from "@/lib/render/ramp";

/**
 * Cartographic point symbols (owner's style board, points variant A, then "try for simple icons", 2026-10-11): the
 * disc, 10 to 14px (SYMBOL, palette.ts), in a 1.75px dark grey stroke over an off-white fill on a white halo, with a
 * minimal dark grey line glyph inside it, one glyph per layer family (GLYPHS, drawn by hand in public/pins/*.svg).
 * Layers without a glyph keep their plain shape (triangle, square, ring, diamond, dashed line, disc); square and ring
 * take the off-white fill at 0.6 (they read as marks, not holes). Selected symbols fill purple; hazards fill pink;
 * score layers fill by their ramp; glyphs stay dark grey on every fill. Sprites are SVG data URLs built here from the
 * palette (a 24×24 drawing on a 48px canvas, anchored at the center), one per shape, glyph, fill and size; the shape
 * scales with the size but the stroke, glyph stroke and halo keep their pixel widths.
 */

export const PIN_SYMBOLS = ["camp", "parking", "species", "photo", "gauge", "snow", "fire", "road", "trailhead", "point"] as const;

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

/**
 * Line glyphs drawn inside the disc: the `d` of each public/pins/<name>.svg (a 24×24 drawing, 1.5px round-capped
 * strokes, no fills, at most three strokes so it reads at 14px). pins.test.ts keeps the files and these in step.
 */
export const GLYPHS = {
  chevron: "M5.5 15.5 12 8.5l6.5 7",
  mountain: "M3 18 9.5 7.5 14 14.5l2.5-3.5L21 18",
  wave: "M3.5 12c1.4-1.9 2.8-1.9 4.2 0s2.8 1.9 4.3 0 2.8-1.9 4.3 0 2.8 1.9 4.2 0",
  waves: "M5 9.5c1.2-1.5 2.3-1.5 3.5 0s2.3 1.5 3.5 0 2.3-1.5 3.5 0 2.3 1.5 3.5 0M5 14.5c1.2-1.5 2.3-1.5 3.5 0s2.3 1.5 3.5 0 2.3-1.5 3.5 0 2.3 1.5 3.5 0",
  drop: "M12 4c3.3 4.2 5.5 7.1 5.5 10a5.5 5.5 0 0 1-11 0c0-2.9 2.2-5.8 5.5-10Z",
  asterisk: "M12 4v16M5.1 8l13.8 8M5.1 16l13.8-8",
  hook: "M14.5 4v10a4.5 4.5 0 0 1-9 0v-2M5.5 12l2.5 2.5",
  tent: "M3.5 19h17L12 5Z M9 19l3-5.5 3 5.5",
  leaf: "M5.5 18.5C5.5 10 10.5 5.5 19 5.5c0 8.5-4.5 13-13.5 13ZM5.5 18.5l7.5-7.5",
  camera: "M3.5 8.5h4l1.5-2.5h6l1.5 2.5h4V19h-17Z M12 10.25a3.25 3.25 0 1 0 0 6.5 3.25 3.25 0 0 0 0-6.5Z",
  info: "M12 10.5V18M12 6.5v0",
  carabiner: "M7 15c0 3 2 5 5 5s5-2 5-5V9c0-3-2-5-5-5S7 6 7 9M7 9l2 5.5",
  arcs: "M9.5 16.5a2.5 2.5 0 0 1 5 0M6.5 16.5a5.5 5.5 0 0 1 11 0M3.5 16.5a8.5 8.5 0 0 1 17 0",
  exclamation: "M12 5v9M12 18.5v0",
  flame: "M12 3.5c.4 3.3 5.5 5.6 5.5 10.5a5.5 5.5 0 0 1-11 0c0-2.3 1.1-4 2.3-5.1.1 1.7.8 2.8 1.7 3.4C10.6 9.4 10.4 6.3 12 3.5Z M12 20c-1.5 0-2.5-1-2.5-2.4 0-1.6 1.3-2.6 2.5-4.4 1.2 1.8 2.5 2.8 2.5 4.4 0 1.4-1 2.4-2.5 2.4",
  cloud: "M7.5 18h9.5a3.75 3.75 0 0 0 .4-7.5 5.25 5.25 0 0 0-10.1 1.2A3.15 3.15 0 0 0 7.5 18Z",
  trefoil: "M9.4 12H4a8 8 0 0 1 4-6.93l2.7 4.68A2.6 2.6 0 0 0 9.4 12ZM13.3 9.75 16 5.07A8 8 0 0 1 20 12h-5.4a2.6 2.6 0 0 0-1.3-2.25ZM13.3 14.25l2.7 4.68a8 8 0 0 1-8 0l2.7-4.68a2.6 2.6 0 0 0 2.6 0Z",
  pick: "M4.5 9.5c4.5-4 10.5-4 15 0M12 6.5V20",
  dam: "M13 4.5v15M4 10c1.2-1.2 2.4-1.2 3.6 0s2.4 1.2 3.6 0M15.5 16.5H20",
  bolt: "M13.5 3.5 6.5 13.5h5l-1 7 7-10h-5l1-7Z",
  anchor: "M12 4a1.75 1.75 0 1 0 0 3.5A1.75 1.75 0 0 0 12 4ZM12 7.5V20M5.5 14a6.5 6 0 0 0 13 0",
  staff: "M4.5 16.5a7.5 7.5 0 0 1 15 0M12 16.5l4-5",
  tree: "M12 20.5V8M12 14 7.5 9.5M12 11.5l4-4",
} as const;

export type PinGlyph = keyof typeof GLYPHS;

/** The glyph for every point of a layer family (the owner's list, 2026-10-11); every other layer keeps its plain shape. */
export const LAYER_GLYPHS: Readonly<Record<string, PinGlyph>> = {
  trailheads: "chevron",
  "outdoor-features": "chevron",
  peaks: "mountain",
  lakes: "wave",
  "surface-water": "wave",
  "reservoir-levels": "wave",
  streamflow: "drop",
  groundwater: "drop",
  snowpack: "asterisk",
  "snow-cover": "asterisk",
  tides: "waves",
  surf: "waves",
  fishing: "hook",
  campsites: "tent",
  "popularity-campsites": "tent",
  "recreation-sites": "tent",
  species: "leaf",
  "gbif-occurrences": "leaf",
  wildlife: "leaf",
  photos: "camera",
  "wikipedia-nearby": "info",
  climbing: "carabiner",
  earthquakes: "arcs",
  "weather-alerts": "exclamation",
  disasters: "exclamation",
  "fire-detections": "flame",
  "methane-plumes": "cloud",
  uranium: "trefoil",
  mines: "pick",
  dams: "dam",
  "power-plants": "bolt",
  ports: "anchor",
  "sea-level-trends": "staff",
  "tree-mortality": "tree",
  "sequoia-mortality": "tree",
};

/** The glyph inside one feature's disc, or null for a plain shape (unmapped layers; parking lots on campsite layers). */
export function pinGlyphFor(layerId: string, feature: Feature): PinGlyph | null {
  if (CAMPSITE_LAYERS.has(layerId) && feature.properties?.kind === "parking") return null;
  return LAYER_GLYPHS[layerId] ?? null;
}

/** Layers whose points are camp sites or parking lots, told apart by `kind`. */
const CAMPSITE_LAYERS = new Set(["campsites", "popularity-campsites"]);

/** The symbol for one feature of a layer: campsites are triangles (parking squares), unknown layers circles. */
export function pinSymbolFor(layerId: string, feature: Feature): PinSymbol {
  if (CAMPSITE_LAYERS.has(layerId)) return feature.properties?.kind === "parking" ? "parking" : "camp";
  return LAYER_SYMBOLS[layerId] ?? "point";
}

type Shape = { kind: "path" | "rect" | "circle" | "road"; d?: string; r?: number; hollow?: boolean; dot?: boolean };

const SHAPES: Record<PinSymbol, Shape> = {
  camp: { kind: "path", d: "M12 6.2 18.2 17H5.8Z" },
  parking: { kind: "rect" },
  snow: { kind: "rect", hollow: true },
  gauge: { kind: "path", d: "M12 5.6 18.4 12 12 18.4 5.6 12Z" },
  species: { kind: "circle", r: 5.5, hollow: true },
  trailhead: { kind: "circle", r: 5.5, hollow: true, dot: true },
  point: { kind: "circle", r: 5.5 },
  photo: { kind: "circle", r: 3.75 },
  fire: { kind: "circle", r: 5 },
  road: { kind: "road" },
};

/** The element for a shape with the given paint attributes. */
function element(shape: Shape, attrs: string): string {
  switch (shape.kind) {
    case "path":
      return `<path d="${shape.d}" stroke-linejoin="round" ${attrs}/>`;
    case "rect":
      return `<rect x="6.5" y="6.5" width="11" height="11" ${attrs}/>`;
    case "circle":
      return `<circle cx="12" cy="12" r="${shape.r}" ${attrs}/>`;
    case "road":
      return `<path d="M5.75 12h12.5" ${attrs}/>`;
  }
}

/**
 * A glyph's 24×24 drawing, shrunk into the disc (SYMBOL.glyphScale of its size, centered) and stroked dark grey at
 * SYMBOL.glyphStrokeWidth true pixels when the whole symbol is scaled by `k`.
 */
function glyphSvg(glyph: PinGlyph, k: number): string {
  const g = SYMBOL.glyphScale;
  const width = +(SYMBOL.glyphStrokeWidth / (k * g)).toFixed(4);
  return (
    `<g transform="translate(12 12) scale(${g}) translate(-12 -12)">` +
    `<path d="${GLYPHS[glyph]}" fill="none" stroke="${SYMBOL.stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/></g>`
  );
}

/** The drawing's own size in sprite units: the shapes above are laid out for a 12px symbol. */
const DRAWN_SIZE = 12;

/**
 * An SVG data URL drawing `shape` filled `fill` (none when hollow), stroked dark grey, on a white halo. `size` is the
 * symbol's size in pixels; the geometry scales to it while the stroke and halo widths stay in true pixels.
 */
export function symbolSvg(shape: Shape, fill: string | null, fillOpacity = 1, size = DRAWN_SIZE, glyph: PinGlyph | null = null): string {
  const s = SYMBOL;
  const k = size / DRAWN_SIZE;
  const stroke = +(s.strokeWidth / k).toFixed(4);
  const haloW = +((s.strokeWidth + s.haloWidth) / k).toFixed(4);
  const halo =
    shape.kind === "road"
      ? `<path d="M5.75 12h12.5" fill="none" stroke="${s.halo}" stroke-width="${haloW}" stroke-linecap="round" stroke-opacity="${s.haloOpacity}"/>`
      : element(shape, `fill="none" stroke="${s.halo}" stroke-opacity="${s.haloOpacity}" stroke-width="${haloW}"`);
  const body =
    shape.kind === "road"
      ? element(shape, `fill="none" stroke="${fill ?? s.stroke}" stroke-width="${stroke}" stroke-dasharray="3 2"`)
      : element(
          shape,
          `fill="${fill ?? "none"}"${fill ? ` fill-opacity="${fillOpacity}"` : ""} stroke="${s.stroke}" stroke-width="${stroke}"`,
        );
  const dot = shape.dot ? `<circle cx="12" cy="12" r="1.6" fill="${s.stroke}"/>` : "";
  const inner = `${halo}${body}${dot}${glyph ? glyphSvg(glyph, k) : ""}`;
  const g = k === 1 ? inner : `<g transform="translate(12 12) scale(${+k.toFixed(4)}) translate(-12 -12)">${inner}</g>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24">${g}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Score symbols fill by their ramp in this many steps (so the sprite atlas stays small). */
export const SCORE_FILL_STEPS = 5;

/** The fill of a symbol: purple when selected, pink for hazards, the ramp for scores, else off-white (0.6 on hollow shapes). */
function fillFor(layerId: string, feature: Feature, symbol: PinSymbol, selected: boolean): { key: string; fill: string | null; opacity: number } {
  if (selected) return { key: "selected", fill: SYMBOL.selectedFill, opacity: 1 };
  const role = layerRole(layerId);
  if (role === "hazard") return { key: "hazard", fill: SYMBOL.hazardFill, opacity: 1 };
  if (role === "score") {
    const v = Number(feature.properties?.v);
    const step = Number.isFinite(v) ? Math.min(SCORE_FILL_STEPS - 1, Math.max(0, Math.floor((v / 100) * SCORE_FILL_STEPS))) : 0;
    const fill = rgbToHex(rampColor(scoreRampFor(layerId), step / (SCORE_FILL_STEPS - 1)));
    return { key: `score${step}-${scoreRampFor(layerId)}`, fill, opacity: 1 };
  }
  if (symbol === "road") return { key: "plain", fill: null, opacity: 1 };
  if (SHAPES[symbol].hollow) return { key: "hollow", fill: SYMBOL.fill, opacity: SYMBOL.hollowFillOpacity };
  return { key: "plain", fill: SYMBOL.fill, opacity: SYMBOL.fillOpacity };
}

/** One shared icon object per sprite, so deck.gl's icon atlas sees the same definition every frame. */
const icons = new Map<string, PinIcon>();

/** The symbol sprite for one feature at `size` px (the full 14px by default, as the layer panel keys draw it), anchored at its center. */
export function pinIconFor(layerId: string, feature: Feature, selected = false, size: number = SYMBOL.sizeMax): PinIcon {
  const glyph = pinGlyphFor(layerId, feature);
  // A glyph always sits in the plain disc; layers without one keep their family shape.
  const symbol = glyph ? "point" : pinSymbolFor(layerId, feature);
  const { key, fill, opacity } = fillFor(layerId, feature, symbol, selected);
  const id = `${glyph ?? symbol}-${key}-${size}`;
  let icon = icons.get(id);
  if (!icon) {
    icon = { id, url: symbolSvg(SHAPES[symbol], fill, opacity, size, glyph), width: 24, height: 24, anchorY: 12 };
    icons.set(id, icon);
  }
  return icon;
}

export type RoutePinKind = "start" | "end" | "via";

/** Route waypoint symbols for Mapbox: a pink start disc with a center dot, an off-white end disc, small via discs. */
export function routePinUrl(kind: RoutePinKind): string {
  const r = kind === "via" ? 4 : 7;
  const shape: Shape = { kind: "circle", r, dot: kind === "start" };
  return symbolSvg(shape, ROUTE_PIN[kind], kind === "start" ? 1 : SYMBOL.fillOpacity);
}
