import type { Padding } from "@/lib/render/deck";

/** Breathing room between a fitted bbox and whatever frames it. */
const MARGIN = 40;
/** The header row: wordmark, basemap switch and (on the right) the layer chips. */
const HEADER = 64;
/** Desktop chat panel: 420px wide at left 16px, plus the margin. */
const PANEL_FOOTPRINT = 436;
/** Desktop zoom/globe controls along the right edge. */
const CONTROLS = 56;
/** The open layer panel: 320px wide at right 16px (components/LayerStack.tsx). */
export const LAYER_PANEL_WIDTH = 320;
const LAYER_PANEL_FOOTPRINT = LAYER_PANEL_WIDTH + 16;
/** The input pill (and the WildMap tag above it when collapsed) at the bottom while no panel is open. */
const INPUT_STACK = 72;
/** Phone bottom sheet height as a share of the viewport (`h-[46vh]` in ChatRail). */
const SHEET_SHARE = 0.46;
/** Never leave less than this much map to fit into; fitBounds rejects an empty target. */
const MIN_VISIBLE = 120;

type VisibleMapInput = {
  width: number;
  height: number;
  panelOpen: boolean;
  isMobile: boolean;
  /** The layer panel is open: a drawer on the right on a desktop, a sheet from the bottom on a phone. */
  layerPanelOpen?: boolean;
};

/** Shrinks the two paddings on one axis together so at least MIN_VISIBLE pixels stay clear. */
function fitAxis(size: number, a: number, b: number): [number, number] {
  const room = size - MIN_VISIBLE;
  if (a + b <= room) return [a, b];
  if (room <= 0) return [0, 0];
  const scale = room / (a + b);
  return [Math.floor(a * scale), Math.floor(b * scale)];
}

/**
 * The fitBounds padding that keeps a result inside the part of the map nobody has covered: on desktop, right
 * of the open chat panel, left of the open layer panel and below the header; on phones, above the bottom sheet (or the input pill).
 */
/** The share of a phone's height the layer sheet takes at its half snap. */
export const LAYER_SHEET_SHARE = 0.55;

export function visibleMapPadding({ width, height, panelOpen, isMobile, layerPanelOpen = false }: VisibleMapInput): Padding {
  let top = MARGIN + HEADER;
  let right = MARGIN;
  let bottom = MARGIN;
  let left = MARGIN;
  if (isMobile) {
    // The layer sheet (components/PhoneSheet.tsx) opens at half the screen from the bottom.
    bottom += Math.max(panelOpen ? Math.round(height * SHEET_SHARE) : INPUT_STACK, layerPanelOpen ? Math.round(height * LAYER_SHEET_SHARE) : 0);
  } else {
    // The open layer panel is wider than the zoom controls beneath it, so it sets the right edge.
    right += layerPanelOpen ? LAYER_PANEL_FOOTPRINT : CONTROLS;
    if (panelOpen) left += PANEL_FOOTPRINT;
    else bottom += INPUT_STACK;
  }
  [top, bottom] = fitAxis(height, top, bottom);
  [left, right] = fitAxis(width, left, right);
  return { top, right, bottom, left };
}
