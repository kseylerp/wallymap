import type { Feature } from "geojson";
import { layerRole, ROUTE_PIN, scoreRampFor, SYMBOL } from "@/lib/render/palette";
import { rampColor, rgbToHex } from "@/lib/render/ramp";

/**
 * Cartographic point symbols (owner's style board, points variant A): no icons, a shape per layer family, 12px, in a
 * 1.5px dark grey stroke over an off-white fill on a white halo. Square and ring are hollow. Selected symbols fill
 * purple; hazards (fire detections) fill pink; score layers fill by their ramp. Sprites are SVG data URLs built
 * here from the palette (a 24×24 drawing on a 48px canvas, anchored at the center), one per shape and fill.
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

/** An SVG data URL drawing `shape` filled `fill` (none when hollow), stroked dark grey, on a white halo. */
export function symbolSvg(shape: Shape, fill: string | null, fillOpacity = 1): string {
  const s = SYMBOL;
  const halo =
    shape.kind === "road"
      ? `<path d="M5 12h14" stroke="${s.halo}" stroke-width="4" stroke-linecap="round" stroke-opacity="${s.haloOpacity}"/>`
      : element(shape, `fill="none" stroke="${s.halo}" stroke-opacity="${s.haloOpacity}" stroke-width="${s.haloWidth}"`);
  const body =
    shape.kind === "road"
      ? element(shape, `fill="none" stroke="${fill ?? s.stroke}" stroke-width="${s.strokeWidth}" stroke-dasharray="3 2"`)
      : element(
          shape,
          `fill="${fill ?? "none"}"${fill ? ` fill-opacity="${fillOpacity}"` : ""} stroke="${s.stroke}" stroke-width="${s.strokeWidth}"`,
        );
  const dot = shape.dot ? `<circle cx="12" cy="12" r="1.6" fill="${s.stroke}"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24">${halo}${body}${dot}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Score symbols fill by their ramp in this many steps (so the sprite atlas stays small). */
export const SCORE_FILL_STEPS = 5;

/** The fill of a symbol: purple when selected, pink for hazards, the ramp for scores, else off-white (hollow shapes none). */
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
  if (SHAPES[symbol].hollow || symbol === "road") return { key: "plain", fill: null, opacity: 1 };
  return { key: "plain", fill: SYMBOL.fill, opacity: SYMBOL.fillOpacity };
}

/** One shared icon object per sprite, so deck.gl's icon atlas sees the same definition every frame. */
const icons = new Map<string, PinIcon>();

/** The symbol sprite for one feature, anchored at its center. */
export function pinIconFor(layerId: string, feature: Feature, selected = false): PinIcon {
  const symbol = pinSymbolFor(layerId, feature);
  const { key, fill, opacity } = fillFor(layerId, feature, symbol, selected);
  const id = `${symbol}-${key}`;
  let icon = icons.get(id);
  if (!icon) {
    icon = { id, url: symbolSvg(SHAPES[symbol], fill, opacity), width: 24, height: 24, anchorY: 12 };
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
