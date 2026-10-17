"use client";

import { createStore } from "@/lib/render/wally/playback";
import { DARK_GREY, INK, OFF_WHITE, WHITE } from "@/lib/render/palette";

/**
 * Playback export (spec §13: "a timeline view can be saved as a short video and a still, with the legend, date and
 * running total included, in WallyMap's style"), the browser half. The map registers its two canvases here (Mapbox's
 * and deck's overlay); a compositor copies each into its own buffer right after it draws (a WebGL canvas's pixels are
 * only readable then), and composes them with a WallyMap caption (title, date, total, legend, source) into one canvas,
 * which a still saves as PNG and a recording streams to a WebM. Nothing downloads from here: the console asks first.
 */

export type CaptureSource = {
  mapCanvas: () => HTMLCanvasElement | null;
  deckCanvas: () => HTMLCanvasElement | null;
  /** Calls `listener` after each Mapbox frame; returns the unsubscribe. */
  onMapRender: (listener: () => void) => () => void;
  /** Calls `listener` after each deck frame; returns the unsubscribe. */
  onDeckRender: (listener: () => void) => () => void;
  /** Asks both to draw again (a still after the caption changed). */
  repaint: () => void;
};

/** The map's canvases, set by components/MapCanvas.tsx while the map exists. */
export const captureStore = createStore<CaptureSource | null>(null);

/** What the caption says: the layers, the frame's date, the total, the legend lines and the sources. */
export type Caption = {
  title: string;
  date?: string;
  total?: string;
  totalLabel?: string;
  legend: { word: string; text: string; ramp?: string[] }[];
  source: string;
};

/** The longest side of an export, in pixels: big enough to read, small enough to keep a 30 s video under 25 MB. */
export const MAX_EXPORT_PX = 1600;

function fit(canvas: HTMLCanvasElement): { w: number; h: number } {
  const scale = Math.min(1, MAX_EXPORT_PX / Math.max(canvas.width, canvas.height));
  return { w: Math.max(2, Math.round((canvas.width * scale) / 2) * 2), h: Math.max(2, Math.round((canvas.height * scale) / 2) * 2) };
}

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draws the caption in WallyMap's style: an off-white card top left (title, date, total), the legend and the source below. */
export function drawCaption(ctx: CanvasRenderingContext2D, w: number, h: number, caption: Caption): void {
  const u = Math.max(1, Math.min(w, h) / 900);
  const pad = 18 * u;
  ctx.save();
  ctx.textBaseline = "alphabetic";
  // The card: title in small caps, the date large, the total beside it.
  ctx.font = `600 ${11 * u}px ${FONT}`;
  const titleW = ctx.measureText(caption.title.toUpperCase()).width;
  ctx.font = `600 ${24 * u}px ${FONT}`;
  const dateW = caption.date ? ctx.measureText(caption.date).width : 0;
  ctx.font = `600 ${18 * u}px ${FONT}`;
  const totalW = caption.total ? ctx.measureText(caption.total).width : 0;
  ctx.font = `${11 * u}px ${FONT}`;
  const labelW = caption.totalLabel ? ctx.measureText(caption.totalLabel).width : 0;
  const legendWs = caption.legend.map((l) => {
    ctx.font = `600 ${10.5 * u}px ${FONT}`;
    const a = ctx.measureText(l.word.toUpperCase()).width;
    ctx.font = `${11.5 * u}px ${FONT}`;
    return a + 8 * u + ctx.measureText(l.text).width + (l.ramp ? 40 * u : 0);
  });
  const cardW = Math.min(w - 2 * pad, Math.max(titleW, dateW, totalW + 12 * u + labelW, ...legendWs) + 2 * pad);
  const lines = 1 + (caption.date ? 1 : 0) + (caption.total ? 1 : 0) + caption.legend.length;
  const cardH = pad * 1.4 + lines * 26 * u + (caption.legend.length > 0 ? 6 * u : 0);
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = OFF_WHITE;
  roundRect(ctx, pad, pad, cardW, cardH, 14 * u);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = DARK_GREY;
  ctx.globalAlpha = 0.18;
  ctx.lineWidth = 1 * u;
  ctx.stroke();
  ctx.globalAlpha = 1;
  let y = pad + pad * 0.9 + 6 * u;
  const x = pad * 2;
  ctx.fillStyle = INK;
  ctx.font = `600 ${11 * u}px ${FONT}`;
  ctx.globalAlpha = 0.7;
  ctx.fillText(caption.title.toUpperCase(), x, y);
  ctx.globalAlpha = 1;
  if (caption.date) {
    y += 28 * u;
    ctx.font = `600 ${24 * u}px ${FONT}`;
    ctx.fillText(caption.date, x, y);
  }
  if (caption.total) {
    y += 26 * u;
    ctx.font = `600 ${18 * u}px ${FONT}`;
    ctx.fillText(caption.total, x, y);
    if (caption.totalLabel) {
      ctx.font = `${11 * u}px ${FONT}`;
      ctx.globalAlpha = 0.7;
      ctx.fillText(caption.totalLabel, x + totalW + 10 * u, y);
      ctx.globalAlpha = 1;
    }
  }
  if (caption.legend.length > 0) y += 6 * u;
  for (const l of caption.legend) {
    y += 24 * u;
    let lx = x;
    if (l.ramp && l.ramp.length > 1) {
      const grad = ctx.createLinearGradient(lx, 0, lx + 30 * u, 0);
      l.ramp.forEach((c, i) => grad.addColorStop(i / (l.ramp!.length - 1), c));
      ctx.fillStyle = grad;
      roundRect(ctx, lx, y - 8 * u, 30 * u, 8 * u, 2 * u);
      ctx.fill();
      lx += 40 * u;
    }
    ctx.fillStyle = INK;
    ctx.font = `600 ${10.5 * u}px ${FONT}`;
    ctx.fillText(l.word.toUpperCase(), lx, y);
    const ww = ctx.measureText(l.word.toUpperCase()).width;
    ctx.font = `${11.5 * u}px ${FONT}`;
    ctx.fillText(l.text, lx + ww + 8 * u, y);
  }
  // The source and the name, bottom right, on a white halo.
  ctx.font = `${11 * u}px ${FONT}`;
  const credit = `WallyMap · ${caption.source}`;
  const cw = Math.min(w - 2 * pad, ctx.measureText(credit).width);
  ctx.lineWidth = 3 * u;
  ctx.strokeStyle = WHITE;
  ctx.strokeText(credit, w - pad - cw, h - pad, w - 2 * pad);
  ctx.fillStyle = INK;
  ctx.fillText(credit, w - pad - cw, h - pad, w - 2 * pad);
  ctx.restore();
}

/** Copies the map's two canvases as they draw and composes them with a caption into `out`. */
export class Compositor {
  readonly out: HTMLCanvasElement;
  private base: HTMLCanvasElement;
  private top: HTMLCanvasElement;
  private stops: (() => void)[] = [];
  private frames = 0;

  constructor(private source: CaptureSource) {
    const map = source.mapCanvas();
    const { w, h } = map ? fit(map) : { w: 1280, h: 800 };
    const make = () => Object.assign(document.createElement("canvas"), { width: w, height: h });
    this.out = make();
    this.base = make();
    this.top = make();
  }

  /** Starts copying each frame of the map and of deck into their buffers. */
  start(): void {
    const copy = (from: HTMLCanvasElement | null, to: HTMLCanvasElement, clear: boolean) => {
      if (!from || from.width === 0) return;
      const ctx = to.getContext("2d");
      if (!ctx) return;
      if (clear) ctx.clearRect(0, 0, to.width, to.height);
      ctx.drawImage(from, 0, 0, to.width, to.height);
      this.frames += 1;
    };
    this.stops.push(this.source.onMapRender(() => copy(this.source.mapCanvas(), this.base, false)));
    this.stops.push(this.source.onDeckRender(() => copy(this.source.deckCanvas(), this.top, true)));
  }

  stop(): void {
    for (const s of this.stops) s();
    this.stops = [];
  }

  /** How many frames were copied (a still waits for at least one of each). */
  get copied(): number {
    return this.frames;
  }

  /** Composes the map, the data and the caption into `out`. */
  compose(caption: Caption): void {
    const ctx = this.out.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(this.base, 0, 0);
    ctx.drawImage(this.top, 0, 0);
    drawCaption(ctx, this.out.width, this.out.height, caption);
  }
}

/** The best WebM the browser records, or null when it records none. */
export function webmType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const t of ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]) if (MediaRecorder.isTypeSupported(t)) return t;
  return null;
}

/** The longest a recording runs, and the largest file it may make. */
export const VIDEO_LIMITS = { maxSeconds: 30, maxBytes: 25 * 1024 * 1024 } as const;

/**
 * The step length and bitrate that play `frames` frames inside 28 seconds (a step at least 80 ms, at most the usual
 * 600) and keep the file under 25 MB with room to spare.
 */
export function recordingPlan(frames: number): { stepMs: number; seconds: number; bitsPerSecond: number } {
  const stepMs = Math.max(80, Math.min(600, Math.floor(28_000 / Math.max(1, frames))));
  const seconds = Math.min(VIDEO_LIMITS.maxSeconds, (frames * stepMs) / 1000 + 1);
  const bitsPerSecond = Math.min(6_000_000, Math.floor((VIDEO_LIMITS.maxBytes * 8 * 0.8) / seconds));
  return { stepMs, seconds, bitsPerSecond };
}
