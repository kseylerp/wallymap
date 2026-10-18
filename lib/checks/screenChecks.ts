/**
 * Screen checks (the eval's Tier 2, scripts/evalScreens.ts): what a person sees once a question's final map is open in a
 * browser. The browser half (`collectLayout`, `collectLabels`) measures the page and returns plain numbers; the pure
 * half here turns them into failures as plain sentences, so every rule is unit-tested without a browser:
 *
 * - layout: no element of the console, card, legend, chat or top bar outside its panel or the viewport, no panel
 *   scrolling sideways, no text overflowing its box without an ellipsis, and in a card none cut even with one;
 * - placeholder: the chat input's placeholder fits its box and nothing covers it;
 * - labels: hex counts fit inside their cell, ranked symbol labels are not cut by the map's edge;
 * - lines: a line layer shows against the basemap (the pixels along its lines change when it is hidden, on average and
 *   at most of the points along them), also with a card open (its siblings fade).
 * - rows: the console shows each layer row from its header, never scrolled mid-row.
 */

import { rowsCutAtTop, type Span } from "@/lib/render/consoleScroll";

export type Rect = { x: number; y: number; width: number; height: number };

/** One measured element of a panel: where it is, the scroller that clips it (if any), and its own text box. */
export type MeasuredElement = {
  /** A short description for the failure sentence: tag, test id or label, and the start of its text. */
  desc: string;
  rect: Rect;
  /** The nearest ancestor (inside the panel) that scrolls or clips; its content may sit outside the panel vertically. */
  scroller?: Rect;
  /**
   * Set for an element that holds text directly: how far its text runs (left and right edges of the laid-out text) against
   * the content box it lays out in (its own, or for an inline element its nearest box ancestor's), and how that box clips.
   */
  text?: { left: number; right: number; boxLeft: number; boxRight: number; overflowX: string; textOverflow: string };
  /** Set for an element that scrolls sideways (overflow-x auto or scroll): how wide its content is against its box. */
  scroll?: { scrollWidth: number; clientWidth: number; overflowX: string };
};

export type MeasuredPanel = {
  name: string;
  rect: Rect;
  elements: MeasuredElement[];
  /** The console's layer rows (by layer id) and the box that scrolls them, as screen spans. */
  rows?: { scroller: Span; rows: (Span & { id: string })[] };
};

export type LayoutMeasure = { viewport: { width: number; height: number }; panels: MeasuredPanel[] };

/** Rounding slack, in CSS pixels. */
const SLACK = 1.5;

function right(r: Rect): number {
  return r.x + r.width;
}

function bottom(r: Rect): number {
  return r.y + r.height;
}

function inside(inner: Rect, outer: Rect, axis: "x" | "both" = "both"): boolean {
  const xOk = inner.x >= outer.x - SLACK && right(inner) <= right(outer) + SLACK;
  if (axis === "x") return xOk;
  return xOk && inner.y >= outer.y - SLACK && bottom(inner) <= bottom(outer) + SLACK;
}

function px(n: number): string {
  return `${Math.round(n)}px`;
}

/** How far a rect pokes out of another, as words: "18px past the right edge". */
function overhang(inner: Rect, outer: Rect, axis: "x" | "both" = "both"): string {
  const parts: string[] = [];
  if (right(inner) > right(outer) + SLACK) parts.push(`${px(right(inner) - right(outer))} past the right edge`);
  if (inner.x < outer.x - SLACK) parts.push(`${px(outer.x - inner.x)} past the left edge`);
  if (axis === "both" && bottom(inner) > bottom(outer) + SLACK) parts.push(`${px(bottom(inner) - bottom(outer))} below the bottom`);
  if (axis === "both" && inner.y < outer.y - SLACK) parts.push(`${px(outer.y - inner.y)} above the top`);
  return parts.join(" and ");
}

/** Layout failures: elements outside their panel or the viewport, panels scrolling sideways, text cut without "…". */
export function layoutProblems(m: LayoutMeasure): string[] {
  const problems: string[] = [];
  const screen: Rect = { x: 0, y: 0, width: m.viewport.width, height: m.viewport.height };
  for (const panel of m.panels) {
    const name = panel.name;
    if (!inside(panel.rect, screen)) problems.push(`The ${name} runs off the screen (${overhang(panel.rect, screen)}).`);
    const outPanel: string[] = [];
    const outScreen: string[] = [];
    const sideways: string[] = [];
    const cut: string[] = [];
    for (const el of panel.elements) {
      // Content in a scroller may sit above or below the panel (scrolled away); it must still fit its width.
      const axis = el.scroller ? "x" : "both";
      if (!inside(el.rect, panel.rect, axis)) outPanel.push(`${el.desc} (${overhang(el.rect, panel.rect, axis)})`);
      else if (!el.scroller && !inside(el.rect, screen)) outScreen.push(`${el.desc} (${overhang(el.rect, screen)})`);
      if (el.scroll && el.scroll.scrollWidth > el.scroll.clientWidth + SLACK && (el.scroll.overflowX === "auto" || el.scroll.overflowX === "scroll")) {
        sideways.push(`${el.desc} (content ${px(el.scroll.scrollWidth)} wide in a ${px(el.scroll.clientWidth)} box)`);
      }
      const t = el.text;
      const spill = t ? Math.max(t.right - t.boxRight, t.boxLeft - t.left) : 0;
      if (t && spill > SLACK) {
        if (t.overflowX === "visible") cut.push(`${el.desc} spills ${px(spill)} out of its box`);
        else if (t.textOverflow !== "ellipsis") cut.push(`${el.desc} is cut off without an ellipsis`);
        // A card's labels and values are what it says: shortened with "…" they say nothing ("Flow vs. the period's …").
        else if (name === "card") cut.push(`${el.desc} is cut off with an ellipsis (${px(spill)} hidden)`);
      }
    }
    const list = (items: string[]) => `${items.slice(0, 3).join("; ")}${items.length > 3 ? `; and ${items.length - 3} more` : ""}`;
    if (outPanel.length > 0) problems.push(`In the ${name}, ${outPanel.length === 1 ? "an element sits" : `${outPanel.length} elements sit`} outside the panel: ${list(outPanel)}.`);
    if (outScreen.length > 0) problems.push(`In the ${name}, ${outScreen.length === 1 ? "an element runs" : `${outScreen.length} elements run`} off the screen: ${list(outScreen)}.`);
    if (sideways.length > 0) problems.push(`In the ${name}, content is wider than its box and scrolls sideways: ${list(sideways)}.`);
    if (cut.length > 0) problems.push(`In the ${name}, text does not fit: ${list(cut)}.`);
    // A row shows from its header: the dams row sat scrolled to its opacity slider, Rank by cut off at the top.
    for (const row of panel.rows ? rowsCutAtTop(panel.rows.scroller, panel.rows.rows) : []) {
      problems.push(`In the ${name}, the ${row.id} row is scrolled mid-row: its header is ${px((panel.rows?.scroller.top ?? 0) - row.top)} above the top of the list.`);
    }
  }
  return problems;
}

/** The chat input's placeholder: its text width against the input's content box, and what is on top along it. */
export type PlaceholderMeasure = {
  text: string;
  textWidth: number;
  contentWidth: number;
  /** For points spread along the placeholder text: true when the input itself is the top element there. */
  onTop: boolean[];
  /** What covers it where it is covered, e.g. "button Suggestions". */
  coveredBy?: string;
};

export function placeholderProblems(p: PlaceholderMeasure | null): string[] {
  if (!p) return ["The chat input is missing, so its placeholder cannot be read."];
  const problems: string[] = [];
  if (p.textWidth > p.contentWidth + SLACK) {
    problems.push(`The chat placeholder "${p.text}" is cut off: it needs ${px(p.textWidth)} and the input shows ${px(p.contentWidth)}.`);
  }
  const covered = p.onTop.filter((t) => !t).length;
  if (covered > 0) problems.push(`Something covers the chat placeholder "${p.text}" (${covered} of ${p.onTop.length} points${p.coveredBy ? `, under ${p.coveredBy}` : ""}).`);
  return problems;
}

/** A label drawn on the map: hex counts in their cell (with the cell's inner width), ranked symbol names. */
export type MeasuredLabel = {
  kind: "hex" | "symbol";
  layerId: string;
  text: string;
  /** Measured text width at its font and size, in CSS pixels. */
  width: number;
  height: number;
  /** Center of the label on screen. */
  x: number;
  y: number;
  /** Hex only: the cell's inner width on screen (flat side to flat side). */
  cellPx?: number;
};

export function labelProblems(labels: MeasuredLabel[], canvas: Rect): string[] {
  const byLayer = new Map<string, { hex: MeasuredLabel[]; symbol: MeasuredLabel[] }>();
  for (const l of labels) {
    const entry = byLayer.get(l.layerId) ?? { hex: [], symbol: [] };
    if (l.kind === "hex" && l.cellPx !== undefined && l.width > l.cellPx - 2) entry.hex.push(l);
    if (l.kind === "symbol") {
      const box: Rect = { x: l.x - l.width / 2, y: l.y - l.height / 2, width: l.width, height: l.height };
      const partly = !inside(box, canvas) && right(box) > canvas.x && box.x < right(canvas) && bottom(box) > canvas.y && box.y < bottom(canvas);
      if (partly) entry.symbol.push(l);
    }
    byLayer.set(l.layerId, entry);
  }
  const problems: string[] = [];
  for (const [layerId, { hex, symbol }] of byLayer) {
    if (hex.length > 0) {
      const e = hex[0];
      problems.push(`${layerId}: ${hex.length} hex ${hex.length === 1 ? "label does" : "labels do"} not fit the cell, e.g. "${e.text}" is ${px(e.width)} wide in a ${px(e.cellPx ?? 0)} cell.`);
    }
    if (symbol.length > 0) problems.push(`${layerId}: ${symbol.length} symbol ${symbol.length === 1 ? "label is" : "labels are"} cut by the edge of the map, e.g. "${symbol[0].text}".`);
  }
  return problems;
}

/**
 * The smallest mean pixel change (0 to 255) along a line layer's lines between shown and hidden for it to count as
 * visible. Calibrated on the owner's case (commit 331355b: plain sage trails on green Topo around Tahoe read 27 to 31)
 * against lines he reads easily (mountain bike facets 40, ski routes 56, T1 trails at Chamonix 57).
 */
export const LINE_VISIBLE_DIFF = 32;

/**
 * A sampled point along a line counts as showing when hiding the layer changes it by at least this much (0 to 255), the
 * same bar as the mean. Calibrated on 2026-10-17 readings (quartiles of the per-point change): rivers on Topo 20 / 33 / 50
 * and with a card open on satellite 20 / 34 / 52, both of which the coordinator could not see; T1 trails at Tahoe 52 / 56
 * / 63 and mountain bike facets at Moab 34 / 55 / 72, which read easily.
 */
export const LINE_POINT_VISIBLE_DIFF = 32;

/**
 * The least share of sampled points along a line layer that must show. The mean alone passed a river network on
 * satellite whose three big rivers changed the pixels a lot and whose hundred thin ones showed nothing (coordinator,
 * 2026-10-17): every line of the layer must read, not its widest.
 */
export const LINE_VISIBLE_SHARE = 0.6;

/** The share of `diffs` at or above LINE_POINT_VISIBLE_DIFF. */
export function visibleShare(diffs: number[]): number {
  return diffs.length === 0 ? 1 : diffs.filter((d) => d >= LINE_POINT_VISIBLE_DIFF).length / diffs.length;
}

/**
 * A line layer's visibility on one basemap: the mean color change at sampled points along its rendered lines between
 * the map with the layer and without it (each a mean of the three channels, 0 to 255), and for lines the share of those
 * points that change visibly.
 */
export function lineVisibilityProblem(layerId: string, basemap: string, diffs: number[], what: "lines" | "symbols" | "outlines" = "lines"): string | null {
  if (diffs.length === 0) return null;
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const where = what === "symbols" ? "under them" : "along them";
  if (mean < LINE_VISIBLE_DIFF) {
    return `${layerId} ${what} barely show on ${basemap}: hiding them changes the pixels ${where} by ${mean.toFixed(1)} of 255 on average (needs ${LINE_VISIBLE_DIFF}).`;
  }
  const share = visibleShare(diffs);
  if (what === "lines" && share < LINE_VISIBLE_SHARE) {
    return `${layerId} lines mostly do not show on ${basemap}: hiding them changes only ${Math.round(share * 100)}% of the points along them by ${LINE_POINT_VISIBLE_DIFF} or more (needs ${Math.round(LINE_VISIBLE_SHARE * 100)}%); the widest lines carry the average.`;
  }
  return null;
}

/**
 * The smallest mean pixel change (0 to 255) inside an area layer's polygons between shown and hidden for its fill (tint
 * and hatch) to count as visible. The hatch covers only part of the inside, so this is lower than for lines; calibrated
 * on the owner's cases (see AREA_FILL_VISIBLE_DIFF's readings in the Last run of docs/questions.md).
 */
export const AREA_FILL_VISIBLE_DIFF = 10;

/**
 * The smallest mean pixel change inside a choropleth's areas (colored by a ramp or by kind, lib/render/views.ts
 * isChoropleth): the color is the answer, so it must read as a fill, not a tint. Calibrated 2026-10-18 on the owner's
 * cases: Texas counties at 0.62 alpha with a card open (every other county faded to 0.22) and the hardiness zones
 * around Denver at 0.55 read faint; at 0.8 they change the pixels by 40 to 60 on Topo, Topo + Satellite and Satellite.
 */
export const CHOROPLETH_FILL_VISIBLE_DIFF = 24;

/**
 * An area layer's fill on one basemap: the mean pixel change at points inside its polygons between shown and hidden,
 * against AREA_FILL_VISIBLE_DIFF (a tint and a hatch), or CHOROPLETH_FILL_VISIBLE_DIFF when `choropleth`.
 */
export function areaFillProblem(layerId: string, basemap: string, diffs: number[], choropleth = false): string | null {
  if (diffs.length === 0) return null;
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const needs = choropleth ? CHOROPLETH_FILL_VISIBLE_DIFF : AREA_FILL_VISIBLE_DIFF;
  if (mean >= needs) return null;
  return `${layerId} ${choropleth ? "fills" : "areas"} barely show on ${basemap}: hiding them changes the pixels inside them by ${mean.toFixed(1)} of 255 on average (needs ${needs}).`;
}

/* ---------- Browser half (each function runs inside the page: no imports, no outer variables) ---------- */

/** Panels by name and selector, as the app marks them. */
export const PANELS: [string, string][] = [
  ["top bar", '[data-testid="top-bar"]'],
  ["chat", 'section[aria-label="Chat"]'],
  ["console", '[data-testid="layer-stack"]'],
  ["card", '[data-testid="inspect-card"]'],
];

/** Runs in the page: measures every visible element of each panel. */
export function collectLayout(panels: [string, string][]): LayoutMeasure {
  const rectOf = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const describe = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    const id = el.getAttribute("data-testid") ?? el.getAttribute("aria-label") ?? "";
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    const cls = id || text ? "" : (el.getAttribute("class") ?? "").split(/\s+/).slice(0, 4).join(".");
    return `${tag}${id ? ` "${id}"` : ""}${text ? ` ("${text}")` : ""}${cls ? `.${cls}` : ""}`;
  };
  const out: MeasuredPanel[] = [];
  for (const [name, selector] of panels) {
    for (const root of Array.from(document.querySelectorAll(selector))) {
      const rootRect = rectOf(root);
      if (rootRect.width === 0 || rootRect.height === 0) continue;
      const rootStyle = getComputedStyle(root);
      if (rootStyle.visibility === "hidden" || rootStyle.display === "none") continue;
      const elements: MeasuredElement[] = [];
      for (const el of Array.from(root.querySelectorAll("*"))) {
        const style = getComputedStyle(el);
        const rect = rectOf(el);
        if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
        // Inside a closed <details>, a popover, an svg's insides or a screen-reader-only text: not laid out for the eye.
        if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
        if (el.closest('[role="tooltip"], [data-testid="info-popover"], .sr-only')) continue;
        // Decoration (the card's pointer, a line key): hidden from readers and holding no text.
        if (el.closest('[aria-hidden="true"]') && !(el.textContent ?? "").trim()) continue;
        if (style.position === "fixed") continue;
        // A phone's chip row scrolls sideways on purpose (components/PhoneSheet.tsx): its chips may sit past the edge.
        if (el.closest("[data-chip-row]") && !el.hasAttribute("data-chip-row")) continue;
        // The nearest ancestor below the panel that scrolls or clips.
        let scroller: Element | null = null;
        for (let a = el.parentElement; a && a !== root.parentElement; a = a.parentElement) {
          const s = getComputedStyle(a);
          if (s.overflowY !== "visible" || s.overflowX !== "visible") {
            scroller = a;
            break;
          }
        }
        const item: MeasuredElement = { desc: describe(el), rect };
        if (scroller && scroller !== el) item.scroller = rectOf(scroller);
        const textNodes = Array.from(el.childNodes).filter((n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "");
        if (textNodes.length > 0) {
          // The box the text lays out in: the element, or for inline text its nearest box ancestor.
          let box: Element = el;
          while (box !== root && getComputedStyle(box).display.startsWith("inline") && getComputedStyle(box).display !== "inline-block" && box.parentElement) box = box.parentElement;
          const bs = getComputedStyle(box);
          const br = box.getBoundingClientRect();
          let left = Infinity;
          let right = -Infinity;
          for (const node of textNodes) {
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const r of Array.from(range.getClientRects())) {
              if (r.width === 0) continue;
              left = Math.min(left, r.left);
              right = Math.max(right, r.right);
            }
          }
          if (Number.isFinite(left)) {
            item.text = {
              left,
              right,
              boxLeft: br.left + parseFloat(bs.borderLeftWidth) + parseFloat(bs.paddingLeft),
              boxRight: br.right - parseFloat(bs.borderRightWidth) - parseFloat(bs.paddingRight),
              overflowX: bs.overflowX,
              textOverflow: bs.textOverflow,
            };
          }
        }
        if ((style.overflowX === "auto" || style.overflowX === "scroll") && !el.hasAttribute("data-chip-row")) {
          item.scroll = { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflowX: style.overflowX };
        }
        elements.push(item);
      }
      // The layer rows and the box that scrolls them (the list on a desktop, the whole console on a phone).
      const rowEls = Array.from(root.querySelectorAll("li[data-layer-id]"));
      let rowScroller: Element | null = null;
      for (let a = rowEls[0]?.parentElement ?? null; a && a !== root.parentElement; a = a.parentElement) {
        const s = getComputedStyle(a);
        if ((s.overflowY === "auto" || s.overflowY === "scroll") && a.scrollHeight > a.clientHeight) {
          rowScroller = a;
          break;
        }
      }
      const panel: MeasuredPanel = { name, rect: rootRect, elements };
      if (rowScroller) {
        const sr = rowScroller.getBoundingClientRect();
        panel.rows = {
          scroller: { top: sr.top, bottom: sr.bottom },
          rows: rowEls.map((el) => {
            const r = el.getBoundingClientRect();
            return { id: el.getAttribute("data-layer-id") ?? "layer", top: r.top, bottom: r.bottom };
          }),
        };
      }
      out.push(panel);
    }
  }
  return { viewport: { width: window.innerWidth, height: window.innerHeight }, panels: out };
}

/** Runs in the page: the chat input's placeholder width against its content box, and whether it is the top element. */
export function collectPlaceholder(): PlaceholderMeasure | null {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[aria-label="Message"]');
  if (!input || !input.placeholder) return null;
  const style = getComputedStyle(input);
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const textWidth = ctx.measureText(input.placeholder).width;
  const contentWidth = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const r = input.getBoundingClientRect();
  const left = r.x + parseFloat(style.paddingLeft);
  const span = Math.min(textWidth, contentWidth);
  const onTop: boolean[] = [];
  let coveredBy: string | undefined;
  for (let i = 0; i < 8; i++) {
    const x = left + (span * (i + 0.5)) / 8;
    const y = r.y + r.height / 2;
    const top = document.elementFromPoint(x, y);
    const ok = top === input || (top !== null && input.contains(top));
    onTop.push(ok);
    if (!ok && top && !coveredBy) coveredBy = `${top.tagName.toLowerCase()} ${top.getAttribute("aria-label") ?? top.getAttribute("data-testid") ?? (top.textContent ?? "").trim().slice(0, 30)}`.trim();
  }
  return { text: input.placeholder, textWidth, contentWidth, onTop, ...(coveredBy && { coveredBy }) };
}

/** Average H3 edge length in metres by resolution (h3geo.org), for a cell's width when it has no neighbour on screen. */
export const H3_EDGE_M = [1281256, 483057, 182513, 68979, 26072, 9854, 3725, 1406, 531, 201, 75.9, 28.7, 10.8, 4.1, 1.5, 0.58];

/** Runs in the page (development build): the deck labels on the map, measured at their font, with each hex's cell width. */
export function collectLabels(edges: number[]): { labels: MeasuredLabel[]; canvas: Rect } | null {
  type Deckish = { id: string; props: Record<string, unknown> };
  type MapLike = {
    project: (p: [number, number]) => { x: number; y: number };
    getCanvas: () => HTMLCanvasElement;
    getZoom: () => number;
    getCenter: () => { lat: number };
  };
  const hook = (window as unknown as { __wallyMap?: { map: MapLike; overlay: { _deck?: { layerManager?: { getLayers: () => Deckish[] } } } } }).__wallyMap;
  if (!hook) return null;
  const { map, overlay } = hook;
  const layers = overlay._deck?.layerManager?.getLayers() ?? [];
  const cr = map.getCanvas().getBoundingClientRect();
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  const at = (p: number[]) => {
    const q = map.project([p[0], p[1]]);
    return [q.x + cr.x, q.y + cr.y];
  };
  const call = (v: unknown, d: unknown) => (typeof v === "function" ? (v as (x: unknown) => unknown)(d) : v);
  const labels: MeasuredLabel[] = [];
  for (const layer of layers) {
    const hex = layer.id.endsWith(":hexbin:labels");
    const symbol = layer.id.endsWith(":points:labels");
    if (!hex && !symbol) continue;
    const props = layer.props;
    const layerId = layer.id.split(":")[0].replace(/@.*$/, "");
    const data = Array.from((props.data as Iterable<unknown>) ?? []);
    let centers: number[][] = [];
    let expected = 0;
    if (hex) {
      const cells = layers.find((l) => l.id === layer.id.replace(/:labels$/, ""));
      const all = Array.from(((cells?.props.data as Iterable<{ geometry: { coordinates: number[] }; properties: { h3: string } }>) ?? []));
      centers = all.map((f) => at(f.geometry.coordinates));
      const res = all[0] ? parseInt(all[0].properties.h3[1], 16) : 0;
      const mpp = (78271.517 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** map.getZoom();
      expected = (Math.sqrt(3) * (edges[res] ?? 0)) / mpp;
    }
    for (const d of data) {
      const text = String(call(props.getText, d));
      const size = Number(call(props.getSize, d));
      const pos = call(props.getPosition, d) as number[];
      const offset = (call(props.getPixelOffset, d) as number[] | undefined) ?? [0, 0];
      const [x, y] = at(pos);
      ctx.font = `${String(props.fontWeight ?? 400)} ${size}px ${String(props.fontFamily)}`;
      const width = ctx.measureText(text).width;
      const label: MeasuredLabel = { kind: hex ? "hex" : "symbol", layerId, text, width, height: size, x: x + offset[0], y: y + offset[1] };
      if (hex) {
        // The flat-to-flat width: the distance to the nearest neighbouring cell's center, else the resolution's average.
        let nearest = Infinity;
        for (const c of centers) {
          const dd = Math.hypot(c[0] - x, c[1] - y);
          if (dd > 0.5 && dd < nearest) nearest = dd;
        }
        label.cellPx = nearest < expected * 1.3 ? nearest : expected;
      }
      labels.push(label);
    }
  }
  return { labels, canvas: { x: cr.x, y: cr.y, width: cr.width, height: cr.height } };
}

/** Runs in the page (development build): screen points along a native line layer's rendered lines, not under a panel. */
export function collectLineSamples({ layerId, max }: { layerId: string; max: number }): { x: number; y: number }[] {
  type MapLike = {
    getStyle: () => { layers: { id: string }[] };
    queryRenderedFeatures: (q: undefined, o: { layers: string[] }) => { geometry: { type: string; coordinates: unknown } }[];
    project: (p: [number, number]) => { x: number; y: number };
    getCanvas: () => HTMLCanvasElement;
  };
  const hook = (window as unknown as { __wallyMap?: { map: MapLike } }).__wallyMap;
  if (!hook) return [];
  const { map } = hook;
  const canvas = map.getCanvas();
  const cr = canvas.getBoundingClientRect();
  const ids = map
    .getStyle()
    .layers.map((l) => l.id)
    .filter((id) => id.startsWith(`lines-${layerId}:`) && /:(core|route)$/.test(id));
  if (ids.length === 0) return [];
  const points: { x: number; y: number }[] = [];
  for (const f of map.queryRenderedFeatures(undefined, { layers: ids })) {
    const lines = (f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.type === "MultiLineString" ? f.geometry.coordinates : []) as number[][][];
    for (const line of lines) {
      for (let i = 0; i + 1 < line.length; i++) {
        // Midpoints: on the line's core even where a vertex sits at a sharp join.
        const q = map.project([(line[i][0] + line[i + 1][0]) / 2, (line[i][1] + line[i + 1][1]) / 2]);
        const x = Math.round(q.x + cr.x);
        const y = Math.round(q.y + cr.y);
        if (x < cr.x + 2 || y < cr.y + 2 || x > cr.x + cr.width - 3 || y > cr.y + cr.height - 3) continue;
        if (document.elementFromPoint(x, y) !== canvas) continue;
        points.push({ x, y });
      }
    }
  }
  if (points.length <= max) return points;
  return Array.from({ length: max }, (_, i) => points[Math.floor((i * points.length) / max)]);
}

/** Runs in the page: the mean channel difference (0 to 255) at each point between two screenshots (PNG data URLs). */
export async function pixelDiffs({ a, b, points }: { a: string; b: string; points: { x: number; y: number }[] }): Promise<number[]> {
  const load = async (url: string) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, img.width, img.height);
  };
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  return points.map(({ x, y }) => {
    const i = (y * ia.width + x) * 4;
    return (Math.abs(ia.data[i] - ib.data[i]) + Math.abs(ia.data[i + 1] - ib.data[i + 1]) + Math.abs(ia.data[i + 2] - ib.data[i + 2])) / 3;
  });
}

/**
 * Runs in the page (development build): a screen point that picks a feature of one of `layerIds` the way a click
 * does (deck first, then the native lines), on the open map and nearest its center, or null when none does yet.
 */
export function findPickPoint(layerIds: string[]): { x: number; y: number; layerId: string } | null {
  type MapLike = {
    getCanvas: () => HTMLCanvasElement;
    getStyle: () => { layers: { id: string }[] };
    queryRenderedFeatures: (p: [number, number], o: { layers: string[] }) => unknown[];
  };
  type Picker = {
    pickObject: (o: { x: number; y: number; radius: number; layerIds?: string[] }) => { layer?: { id: string } | null; object?: unknown } | null;
    _deck?: { props: { layers: { id: string; props: { pickable?: unknown; terrainDrawMode?: unknown } }[] } };
  };
  const hook = (window as unknown as { __wallyMap?: { map: MapLike; overlay: Picker } }).__wallyMap;
  if (!hook) return null;
  const { map, overlay } = hook;
  const top = (overlay._deck?.props.layers ?? []).flat(Infinity as 1).filter((l) => l && l.props.pickable && l.id !== "wally-terrain");
  const passes = { direct: top.filter((l) => l.props.terrainDrawMode !== "drape").map((l) => l.id), draped: top.some((l) => l.props.terrainDrawMode === "drape") };
  const canvas = map.getCanvas();
  const r = canvas.getBoundingClientRect();
  const lineLayers = map
    .getStyle()
    .layers.map((l) => l.id)
    .filter((id) => /:(core|route)$/.test(id) && layerIds.some((l) => id.startsWith(`lines-${l}:`)));
  const cx = r.width / 2;
  const cy = r.height / 2;
  const points: [number, number][] = [];
  for (let y = 12; y < r.height - 12; y += 18) for (let x = 12; x < r.width - 12; x += 18) points.push([x, y]);
  points.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
  // Nothing drawn in the rows' counts (layer-count "0"): no point probing deck at every pixel.
  const counts = Array.from(document.querySelectorAll('[data-testid="layer-count"]')).map((el) => (el.textContent ?? "").replace(/[^0-9]/g, ""));
  if (counts.length > 0 && counts.every((c) => c === "0")) return null;
  for (const [x, y] of points) {
    if (document.elementFromPoint(x + r.x, y + r.y) !== canvas) continue;
    let hit: { layer?: { id: string } | null; object?: unknown } | null = null;
    try {
      // As the app picks (lib/render/inspect.ts pickPasses): symbols without the terrain mesh, then draped areas.
      hit = passes.direct.length > 0 ? overlay.pickObject({ x, y, radius: 2, layerIds: passes.direct }) : null;
      if (!hit?.object && passes.draped) hit = overlay.pickObject({ x, y, radius: 2 });
    } catch {
      hit = null;
    }
    const deckId = hit?.object && hit.layer ? hit.layer.id : "";
    const layerId = layerIds.find((l) => deckId.startsWith(`${l}:`) || deckId.startsWith(`${l}@`));
    if (layerId && !deckId.includes(":casing") && !deckId.includes(":labels")) return { x: x + r.x, y: y + r.y, layerId };
    if (lineLayers.length > 0 && map.queryRenderedFeatures([x, y], { layers: lineLayers }).length > 0) {
      const id = layerIds.find((l) => lineLayers.some((ll) => ll.startsWith(`lines-${l}:`))) ?? layerIds[0];
      return { x: x + r.x, y: y + r.y, layerId: id };
    }
  }
  return null;
}

/**
 * Runs in the page (development build): screen points at the drawn symbols of a point layer (deck's `<layer>…:points`
 * IconLayer, the map flat), each nudged off the centre onto the glyph's ring, not under a panel.
 */
export function collectPointSamples({ layerId, max }: { layerId: string; max: number }): { x: number; y: number }[] {
  type MapLike = { project: (p: [number, number]) => { x: number; y: number }; getCanvas: () => HTMLCanvasElement };
  type Deckish = { id: string; props: Record<string, unknown> };
  const hook = (window as unknown as { __wallyMap?: { map: MapLike; overlay: { _deck?: { layerManager?: { getLayers: () => Deckish[] } } } } }).__wallyMap;
  if (!hook) return [];
  const { map, overlay } = hook;
  const canvas = map.getCanvas();
  const cr = canvas.getBoundingClientRect();
  const layer = (overlay._deck?.layerManager?.getLayers() ?? []).find((l) => (l.id.startsWith(`${layerId}:`) || l.id.startsWith(`${layerId}@`)) && l.id.endsWith(":points"));
  if (!layer) return [];
  const get = layer.props.getPosition;
  const points: { x: number; y: number }[] = [];
  for (const d of Array.from((layer.props.data as Iterable<unknown>) ?? [])) {
    const pos = (typeof get === "function" ? get(d) : (d as { geometry?: { coordinates?: number[] } }).geometry?.coordinates) as number[] | undefined;
    if (!pos) continue;
    const q = map.project([pos[0], pos[1]]);
    // The centre and four points 3px out: the glyph and the disc, not one pixel of either.
    for (const [dx, dy] of [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3]]) {
      const x = Math.round(q.x + cr.x + dx);
      const y = Math.round(q.y + cr.y + dy);
      if (x < cr.x + 2 || y < cr.y + 2 || x > cr.x + cr.width - 3 || y > cr.y + cr.height - 3) continue;
      if (document.elementFromPoint(x, y) !== canvas) continue;
      points.push({ x, y });
    }
  }
  if (points.length <= max) return points;
  return Array.from({ length: max }, (_, i) => points[Math.floor((i * points.length) / max)]);
}

/**
 * Runs in the page (development build): screen points on an area layer's drawn polygons (deck's `<layer>…:polygons`
 * GeoJsonLayer, the map flat), not under a panel: `outline` at the midpoints of the rings' edges, `inside` on a grid
 * within the polygons (in screen space, so it lands on the tint and the hatch alike).
 */
export function collectAreaSamples({ layerId, max }: { layerId: string; max: number }): { outline: { x: number; y: number }[]; inside: { x: number; y: number }[] } {
  type MapLike = { project: (p: [number, number]) => { x: number; y: number }; getCanvas: () => HTMLCanvasElement };
  type Deckish = { id: string; props: Record<string, unknown> };
  type Geo = { type: string; coordinates: unknown };
  const empty = { outline: [], inside: [] };
  const hook = (window as unknown as { __wallyMap?: { map: MapLike; overlay: { _deck?: { layerManager?: { getLayers: () => Deckish[] } } } } }).__wallyMap;
  if (!hook) return empty;
  const { map, overlay } = hook;
  const canvas = map.getCanvas();
  const cr = canvas.getBoundingClientRect();
  const layer = (overlay._deck?.layerManager?.getLayers() ?? []).find(
    (l) => (l.id.startsWith(`${layerId}:`) || l.id.startsWith(`${layerId}@`)) && /:(polygons|columns)$/.test(l.id) && l.props.filled === true,
  );
  if (!layer) return empty;
  const data = layer.props.data as { features?: { geometry?: Geo | null }[] } | undefined;
  const rings: { x: number; y: number }[][] = [];
  for (const f of data?.features ?? []) {
    const g = f.geometry;
    if (!g) continue;
    const polys = (g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []) as number[][][][];
    for (const poly of polys) {
      for (const ring of poly) {
        rings.push(
          ring.map((c) => {
            const q = map.project([c[0], c[1]]);
            return { x: q.x + cr.x, y: q.y + cr.y };
          }),
        );
      }
    }
  }
  const onMap = (x: number, y: number) => x >= cr.x + 2 && y >= cr.y + 2 && x <= cr.x + cr.width - 3 && y <= cr.y + cr.height - 3 && document.elementFromPoint(x, y) === canvas;
  const outline: { x: number; y: number }[] = [];
  for (const ring of rings) {
    for (let i = 0; i + 1 < ring.length; i++) {
      const x = Math.round((ring[i].x + ring[i + 1].x) / 2);
      const y = Math.round((ring[i].y + ring[i + 1].y) / 2);
      if (onMap(x, y)) outline.push({ x, y });
    }
  }
  // Even-odd over every ring: holes stay out.
  const insideAny = (x: number, y: number) => {
    let inside = false;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i];
        const b = ring[j];
        if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
    }
    return inside;
  };
  const inside: { x: number; y: number }[] = [];
  for (let y = Math.ceil(cr.y) + 4; y < cr.y + cr.height - 4; y += 3) {
    for (let x = Math.ceil(cr.x) + 4; x < cr.x + cr.width - 4; x += 3) {
      if (insideAny(x, y) && document.elementFromPoint(x, y) === canvas) inside.push({ x, y });
    }
  }
  const thin = <T,>(list: T[]) => (list.length <= max ? list : Array.from({ length: max }, (_, i) => list[Math.floor((i * list.length) / max)]));
  return { outline: thin(outline), inside: thin(inside) };
}

/**
 * Runs in the page (development build): screen points inside a vector tile area layer (`tiles-<id>`, a grid over the
 * canvas where the layer has a feature), not under a panel; empty when the layer is not a vector fill.
 */
export function collectTileAreaSamples({ layerId, max }: { layerId: string; max: number }): { x: number; y: number }[] {
  type MapLike = {
    getCanvas: () => HTMLCanvasElement;
    getLayer: (id: string) => { type: string } | undefined;
    queryRenderedFeatures: (p: [number, number], o: { layers: string[] }) => unknown[];
  };
  const hook = (window as unknown as { __wallyMap?: { map: MapLike } }).__wallyMap;
  if (!hook) return [];
  const id = `tiles-${layerId}`;
  if (hook.map.getLayer(id)?.type !== "fill") return [];
  const canvas = hook.map.getCanvas();
  const r = canvas.getBoundingClientRect();
  const points: { x: number; y: number }[] = [];
  for (let y = 8; y < r.height - 8; y += 12) {
    for (let x = 8; x < r.width - 8; x += 12) {
      if (document.elementFromPoint(x + r.x, y + r.y) !== canvas) continue;
      if (hook.map.queryRenderedFeatures([x, y], { layers: [id] }).length > 0) points.push({ x: Math.round(x + r.x), y: Math.round(y + r.y) });
    }
  }
  if (points.length <= max) return points;
  return Array.from({ length: max }, (_, i) => points[Math.floor((i * points.length) / max)]);
}

/**
 * True for a 404 from Mapbox's terrain DEM tiles (mapbox-terrain-dem-v1): Mapbox serves no tile over open ocean and
 * answers 404 by design (checked 2026-10-17: 6/19/25 and 7/39/50 off New England are 404, land tiles at the same zooms
 * 200, the tileset's maxzoom is 14), and the map skips those tiles. Only these are left out of the zero-errors check.
 */
export function isOceanDemTile404(url: string, status: number): boolean {
  return status === 404 && /^https:\/\/api\.mapbox\.com\/(?:v4|raster\/v1)\/mapbox\.mapbox-terrain-dem-v1\/\d+\/\d+\/\d+/.test(url);
}
