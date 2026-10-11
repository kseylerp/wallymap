import type { Feature } from "geojson";
import { layerRole, ROUTE_PIN, scoreRampFor, SYMBOL } from "@/lib/render/palette";
import { rampColor, rgbToHex } from "@/lib/render/ramp";

/**
 * Cartographic point symbols (owner's style board, points variant A): no icons, a shape per layer family, 10 to 14px
 * (SYMBOL, palette.ts), in a 1.75px dark grey stroke over an off-white fill on a white halo. Square and ring take the
 * off-white fill at 0.6 (they read as marks, not holes). Selected symbols fill purple; hazards (fire detections) fill
 * pink; score layers fill by their ramp. Sprites are SVG data URLs built here from the palette (a 24×24 drawing on a
 * 48px canvas, anchored at the center), one per shape, fill and size; the shape scales with the size but the stroke
 * and halo keep their pixel widths.
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

/** The drawing's own size in sprite units: the shapes above are laid out for a 12px symbol. */
const DRAWN_SIZE = 12;

/**
 * An SVG data URL drawing `shape` filled `fill` (none when hollow), stroked dark grey, on a white halo. `size` is the
 * symbol's size in pixels; the geometry scales to it while the stroke and halo widths stay in true pixels.
 */
export function symbolSvg(shape: Shape, fill: string | null, fillOpacity = 1, size = DRAWN_SIZE): string {
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
  const g = k === 1 ? `${halo}${body}${dot}` : `<g transform="translate(12 12) scale(${+k.toFixed(4)}) translate(-12 -12)">${halo}${body}${dot}</g>`;
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
  const symbol = pinSymbolFor(layerId, feature);
  const { key, fill, opacity } = fillFor(layerId, feature, symbol, selected);
  const id = `${symbol}-${key}-${size}`;
  let icon = icons.get(id);
  if (!icon) {
    icon = { id, url: symbolSvg(SHAPES[symbol], fill, opacity, size), width: 24, height: 24, anchorY: 12 };
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
