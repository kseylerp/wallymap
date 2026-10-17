import { CompositeLayer, type Layer, type UpdateParameters } from "@deck.gl/core";
import { TextLayer, type TextLayerProps } from "@deck.gl/layers";
import { placeLabel, type Insets } from "@/lib/render/labelPlacement";

/** About how wide one character is, as a share of the font size, when no canvas can measure the text. */
const CHAR_SHARE = 0.6;

let measureCtx: CanvasRenderingContext2D | null | undefined;

/** The text's width at this font in CSS pixels: measured on a canvas in a browser, else estimated. */
export function textWidth(text: string, size: number, weight: string, family: string): number {
  if (measureCtx === undefined) measureCtx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  const estimate = text.length * size * CHAR_SHARE;
  if (!measureCtx) return estimate;
  measureCtx.font = `${weight} ${size}px ${family}`;
  const w = measureCtx.measureText(text).width;
  return Number.isFinite(w) && w > 0 ? w : estimate;
}

export type PlacedLabelLayerProps<D> = {
  data: readonly D[];
  getPosition: (d: D) => [number, number];
  getText: (d: D) => string;
  /** How far above its point a label's center sits by default (half the symbol plus a gap), in CSS pixels. */
  getGap: (d: D) => number;
  /** Font size in CSS pixels. */
  size: number;
  /** The id the drawn TextLayer gets (the screen checks read it: lib/checks/screenChecks.ts collectLabels). */
  textId: string;
  /** Everything else the TextLayer draws with: color, font, halo, parameters, terrain extension. */
  textProps: Partial<TextLayerProps<D>>;
  /** The floating panels' insets over the canvas, read each time the labels are placed. */
  getInsets?: (canvas: { width: number; height: number }) => Insets;
};

export type PlacedLabels<D> = { key: string; data: D[]; offsets: Map<D, [number, number]> };

export type PlaceOptions<D> = {
  canvas: { width: number; height: number };
  /** Screen position of a longitude/latitude, in CSS pixels from the canvas's top left. */
  project: (p: [number, number]) => number[];
  getPosition: (d: D) => [number, number];
  getText: (d: D) => string;
  getGap: (d: D) => number;
  size: number;
  insets?: (canvas: { width: number; height: number }) => Insets;
  /** The text's width in CSS pixels. */
  measure: (text: string) => number;
  /** Room kept between a label and the edge of the clear map; more on a tilted map (see PITCHED_EDGE_MARGIN_PX). */
  margin?: number;
};

/**
 * Room kept from the edge on a tilted map: labels are placed from the flat projection but drawn lifted onto the
 * terrain, which shifts them sideways near the edges (Red River Gorge at pitch 45: "Left Flank" drew 11 px past the
 * left edge it had been slid inside).
 */
export const PITCHED_EDGE_MARGIN_PX = 24;

/** Each label's offset from its point on this screen, leaving out those whose point is outside the clear map. */
export function placeAll<D>(data: readonly D[], o: PlaceOptions<D>): PlacedLabels<D> {
  const insets = o.insets?.(o.canvas) ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const bounds = { left: insets.left, top: insets.top, right: o.canvas.width - insets.right, bottom: o.canvas.height - insets.bottom };
  const placed: D[] = [];
  const offsets = new Map<D, [number, number]>();
  const parts: string[] = [];
  for (const d of data) {
    const [x, y] = o.project(o.getPosition(d));
    const offset = placeLabel({ x, y, width: o.measure(o.getText(d)), height: o.size, gap: o.getGap(d) }, bounds, o.margin);
    if (!offset) continue;
    const rounded: [number, number] = [Math.round(offset[0]), Math.round(offset[1])];
    placed.push(d);
    offsets.set(d, rounded);
    parts.push(`${placed.length - 1}:${rounded[0]},${rounded[1]}`);
  }
  return { key: parts.join("|"), data: placed, offsets };
}

/**
 * Ranked labels kept inside the clear map (lib/render/labelPlacement.ts): placed again whenever the camera moves, so
 * a label near the edge slides or flips inward and one whose point is off screen or under a panel is not drawn.
 */
export class PlacedLabelLayer<D = unknown> extends CompositeLayer<PlacedLabelLayerProps<D>> {
  static layerName = "PlacedLabelLayer";
  declare state: PlacedLabels<D>;

  shouldUpdateState({ changeFlags }: UpdateParameters<this>): boolean {
    return Boolean(changeFlags.somethingChanged);
  }

  updateState(): void {
    const { data, getPosition, getText, getGap, size, textProps, getInsets } = this.props;
    const viewport = this.context.viewport;
    const weight = String(textProps.fontWeight ?? 400);
    const family = String(textProps.fontFamily ?? "sans-serif");
    const next = placeAll(data, {
      canvas: { width: viewport.width, height: viewport.height },
      project: (p) => viewport.project(p),
      getPosition,
      getText,
      getGap,
      size,
      insets: getInsets,
      measure: (text) => textWidth(text, size, weight, family),
      ...((viewport as { pitch?: number }).pitch ? { margin: PITCHED_EDGE_MARGIN_PX } : {}),
    });
    // Same labels in the same places: keep the arrays, so the TextLayer has nothing to update.
    const prev = this.state;
    if (prev?.key === next.key && prev.data?.length === next.data.length && next.data.every((d, i) => prev.data[i] === d)) return;
    this.setState(next);
  }

  renderLayers(): Layer {
    const { getPosition, getText, size, textId, textProps } = this.props;
    const { data, offsets, key } = this.state;
    return new TextLayer<D>({
      ...this.getSubLayerProps({ id: "text" }),
      ...textProps,
      id: textId,
      data,
      getPosition,
      getText,
      getSize: size,
      sizeUnits: "pixels",
      getPixelOffset: (d: D) => offsets.get(d) ?? [0, 0],
      updateTriggers: { getPixelOffset: key },
    });
  }
}
