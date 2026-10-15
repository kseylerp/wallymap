"use client";

import { NO_INSETS, safeAreaInsets, type Insets } from "@/lib/render/safeArea";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Copy, MessageCircle, Route, X, ZoomIn } from "lucide-react";
import { LegendKey } from "@/components/LegendKey";
import { formatDate, isLineFeature, summarizeFeature } from "@/lib/render/inspect";
import { cardContent, type CardRow } from "@/lib/render/card";
import { InfoMark } from "@/components/FieldHelp";
import type { BBox } from "@/layers/types";
import type { LoadedLayer, Selection } from "@/lib/render/state";
import { rampSamples, type LegendSymbol } from "@/lib/render/wally/legend";
import { askAboutCellText, cellOf, rankWords, roughly, summarizeCell, type HexCellSummary } from "@/lib/render/hexCells";
import { HEX_TILE } from "@/lib/render/palette";
import { formatValue as formatNumber } from "@/lib/format";
import { previewFeature } from "@/lib/render/wally/playback";

type Point = { x: number; y: number };

type InspectCardProps = {
  selection: Selection;
  layer: LoadedLayer;
  /** The feature's legend key, as drawn on the map (tint and hatch, line, or symbol). */
  swatch: LegendSymbol;
  /** Screen position of a map point; null before the map exists. */
  project: (lngLat: [number, number]) => Point | null;
  /** Re-run on every camera frame; returns the unsubscribe function. */
  onCameraChange: (listener: () => void) => () => void;
  onClose: () => void;
  /** Sends the "Ask about this" message; false when the chat is busy. */
  onAsk: () => boolean;
  onPreviewRoute: () => void;
  /** A hex cell's named feature pressed: open that feature's own card. */
  onOpenFeature?: (feature: GeoJSON.Feature) => void;
  /** "Zoom to this cell": fit the camera to the cell. */
  onZoomTo?: (bbox: BBox) => void;
  /** "Ask about this cell": put the cell's words in the composer for the user to finish. */
  onAskCell?: (text: string) => void;
};

const MAX_WIDTH = 340;
/** Breathing room between the card and the window edge, and between the card and the clicked point. */
const EDGE = 12;
const GAP = 14;
/** The header row of wordmark and basemap switch; the card never tucks under it. */
const TOP_SAFE = 64;
const POINTER = 12;

type Placement = {
  left: number;
  top: number;
  below: boolean;
  pointerX: number;
  /** False when clamping moved the card away from the point, so a pointer would aim at nothing. */
  pointer: boolean;
  offscreen: boolean;
};

/**
 * Where the card goes for an anchor point: centered above it, flipped below when there is more room there,
 * then clamped inside the window (below the header). The pointer shows only while the card still touches the
 * point and the point is within its width.
 */
export function place(
  anchor: Point,
  card: { width: number; height: number },
  view: { width: number; height: number; insets?: Insets },
): Placement {
  const insets = view.insets ?? NO_INSETS;
  // The header and the window edges move in by the phone's safe area (notch, home indicator).
  const topSafe = TOP_SAFE + insets.top;
  const offscreen = anchor.x < 0 || anchor.y < 0 || anchor.x > view.width || anchor.y > view.height;
  const roomAbove = anchor.y - GAP - topSafe;
  const roomBelow = view.height - anchor.y - GAP - EDGE - insets.bottom;
  const below = roomAbove < card.height && roomBelow > roomAbove;
  const ideal = below ? anchor.y + GAP : anchor.y - GAP - card.height;
  const maxTop = Math.max(topSafe, view.height - EDGE - insets.bottom - card.height);
  const top = Math.min(maxTop, Math.max(topSafe, ideal));
  const minLeft = EDGE + insets.left;
  const maxLeft = Math.max(minLeft, view.width - EDGE - insets.right - card.width);
  const left = Math.min(maxLeft, Math.max(minLeft, anchor.x - card.width / 2));
  const rawPointerX = anchor.x - left;
  const pointerX = Math.min(card.width - 20, Math.max(20, rawPointerX));
  const pointer = Math.abs(top - ideal) < 1 && rawPointerX >= 14 && rawPointerX <= card.width - 14;
  return { left, top, below, pointerX, pointer, offscreen };
}

/** Fact rows on hairlines: the label (with the serif "i" when the layer explains the field), the value right-aligned. */
function RowList({ rows }: { rows: CardRow[] }) {
  return (
    <dl className="text-[13px] leading-5">
      {rows.map((r) => (
        <div key={r.key} className="flex items-baseline justify-between gap-3 border-t border-line py-1.5" data-field={r.key}>
          <dt className="flex min-w-0 max-w-[52%] shrink-0 items-center gap-1 text-ink-muted">
            <span className="truncate" title={r.label}>
              {r.label}
            </span>
            {r.help && <InfoMark help={r.help} label={r.label} />}
          </dt>
          <dd className="min-w-0 text-right break-words text-ink tabular-nums">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

type RowIcon = typeof Copy;

/** A 44px action row: icon, label, chevron. */
function ActionRow({ onClick, icon: Icon, children }: { onClick: () => void; icon: RowIcon; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group press flex h-11 w-full items-center gap-2.5 text-left text-[14px] font-medium text-ink transition duration-150 ease-out"
    >
      <Icon aria-hidden size={16} strokeWidth={2} className="shrink-0 text-ink-muted group-hover:text-ink" />
      <span className="flex-1">{children}</span>
      <ChevronRight aria-hidden size={16} strokeWidth={2} className="shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

function SectionLabel({ children }: { children: string }) {
  return <p className="mt-3 mb-0.5 text-[10.5px] font-semibold tracking-[0.08em] text-ink-muted uppercase">{children}</p>;
}

/** "1,234 MW", "36 km²": a number in its unit, separators kept, a score without one. */
function amount(value: number, unit?: string, key = "v"): string {
  const text = formatNumber(key, value, unit, Math.abs(value) >= 100 ? 0 : 1);
  return unit && unit !== "score" ? `${text} ${unit}` : text;
}

/** Features per km², or per 1,000 km² when a cell is big and sparse ("2.4 per 1,000 km²", never "0.00 per km²"). */
function densityText(perKm2: number): string {
  if (perKm2 >= 10) return `${Math.round(perKm2).toLocaleString("en-US")} per km²`;
  if (perKm2 >= 0.1) return `${perKm2.toFixed(perKm2 >= 1 ? 1 : 2)} per km²`;
  const per1000 = perKm2 * 1000;
  return `${per1000 >= 10 ? Math.round(per1000).toLocaleString("en-US") : per1000.toFixed(1)} per 1,000 km²`;
}

/** The share bar's shades: the hex tile ramp from dark grey down, so the largest part reads darkest. */
const SHARE_SHADES = rampSamples(HEX_TILE.ramp).reverse();

/**
 * A hex cell's card (spec §12d): its area and density, its count and rank among the visible cells, the main category's
 * shares as one bar, the measure's total and median, the time span, the top named features (each opens its own card),
 * then "Ask about this cell" (prefills the chat with the cell's bbox and layer) and "Zoom to this cell".
 */
function HexCellBody({
  cell,
  words,
  onOpenFeature,
  onZoomTo,
  onAsk,
}: {
  cell: HexCellSummary;
  words: string;
  onOpenFeature?: (feature: GeoJSON.Feature) => void;
  onZoomTo?: (bbox: BBox) => void;
  onAsk: () => void;
}) {
  const rows: CardRow[] = [{ key: "density", label: "Density", value: densityText(cell.densityPerKm2) }];
  if (cell.measure) {
    rows.push({ key: "sum", label: `Total ${cell.measure.label.toLowerCase()}`, value: amount(cell.measure.sum, cell.measure.unit) });
    if (cell.measure.counted > 1) rows.push({ key: "median", label: `Median ${cell.measure.label.toLowerCase()}`, value: amount(cell.measure.median, cell.measure.unit) });
  }
  if (cell.span) {
    const first = formatDate(cell.span.first);
    const latest = formatDate(cell.span.latest);
    rows.push({ key: "dates", label: "Dates", value: first === latest ? first : `${first} – ${latest}` });
  }
  return (
    <div data-testid="hex-card">
      <p className="mt-1 text-[12.5px] text-ink-muted tabular-nums" data-testid="hex-rank">
        {words} · ≈ {roughly(cell.areaKm2)} km²
      </p>
      <div className="mt-2">
        <RowList rows={rows} />
      </div>
      {cell.shares && (
        <div className="mt-2" data-testid="hex-shares">
          <p className="mb-1 text-[12px] text-ink-muted">{cell.shares.label}</p>
          <div aria-hidden className="flex h-2.5 w-full overflow-hidden rounded-[2px] border border-line">
            {cell.shares.parts.map((p, i) => (
              <span key={p.label} style={{ width: `${Math.max(1, p.share * 100)}%`, background: SHARE_SHADES[Math.min(i, SHARE_SHADES.length - 1)] }} />
            ))}
          </div>
          <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-ink">
            {cell.shares.parts.map((p, i) => (
              <li key={p.label} className="flex items-center gap-1 tabular-nums">
                <span aria-hidden className="inline-block size-2 rounded-[1px] border border-line" style={{ background: SHARE_SHADES[Math.min(i, SHARE_SHADES.length - 1)] }} />
                {p.label} {Math.round(p.share * 100)}%
              </li>
            ))}
          </ul>
        </div>
      )}
      {cell.named.length > 0 && (
        <>
          <SectionLabel>In this cell</SectionLabel>
          <ul className="text-[13px] leading-5" data-testid="hex-named">
            {cell.named.map((n, i) => (
              <li key={`${n.name}-${i}`} className="flex items-baseline justify-between gap-3 border-t border-line py-1">
                <button type="button" onClick={() => onOpenFeature?.(n.feature)} className="dashed-link min-w-0 truncate text-left text-ink">
                  {n.name}
                </button>
                {n.value && <span className="shrink-0 text-ink-muted tabular-nums">{n.value}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      <button
        type="button"
        onClick={onAsk}
        className="press mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-[12px] bg-primary text-[14px] font-medium text-on-primary transition duration-150 ease-out hover:opacity-85"
      >
        <MessageCircle aria-hidden size={16} strokeWidth={2} />
        Ask about this cell
      </button>
      <div className="mt-3 -mb-1.5 divide-y divide-line border-t border-line">
        <ActionRow onClick={() => onZoomTo?.(cell.bbox)} icon={ZoomIn}>
          Zoom to this cell
        </ActionRow>
      </div>
    </div>
  );
}

/** A white card floating at the clicked feature: what it is, its key facts, where the data came from. */
export function InspectCard({
  selection,
  layer,
  swatch,
  project,
  onCameraChange,
  onClose,
  onAsk,
  onPreviewRoute,
  onOpenFeature,
  onZoomTo,
  onAskCell,
}: InspectCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<Point | null>(() => project(selection.lngLat) ?? selection.screen ?? null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [view, setView] = useState(() =>
    typeof window === "undefined"
      ? { width: 1000, height: 800, insets: NO_INSETS }
      : { width: window.innerWidth, height: window.innerHeight, insets: safeAreaInsets() },
  );
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const unit = layer.style.unit;
  const summary = useMemo(() => summarizeFeature(selection.feature, unit), [selection.feature, unit]);
  const content = useMemo(
    () => cardContent(selection.feature, { unit, card: layer.card, fieldHelp: layer.fieldHelp }),
    [selection.feature, unit, layer.card, layer.fieldHelp],
  );
  const { citation, coverageNote } = layer.result;
  const line = isLineFeature(selection.feature);
  const sideB = selection.side === "b";
  // A hex tile or column: the cell's summary instead of the feature's properties (spec §12d).
  const origin = useMemo(() => cellOf(selection.feature), [selection.feature]);
  // Ranked among the cells on screen (spec §12d "3rd busiest of 120"), so it follows the camera like the anchor does.
  const cell = useMemo(() => {
    if (!origin) return null;
    const onScreen = origin.cells.filter((c) => {
      if (c === origin.cell) return true;
      const p = project(c.position);
      return p !== null && p.x >= 0 && p.y >= 0 && p.x <= view.width && p.y <= view.height;
    });
    return summarizeCell(origin.cell, onScreen, origin.basis, origin.ctx);
    // The anchor moves with every camera frame, so the cells on screen are re-read with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, project, view, anchor]);

  // Follow the clicked point as the camera moves (including the ease onto the feature).
  useEffect(() => {
    let frame = 0;
    const update = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const next = project(selection.lngLat);
        if (next) setAnchor(next);
        setView((v) => {
          const insets = safeAreaInsets();
          const same =
            v.width === window.innerWidth &&
            v.height === window.innerHeight &&
            (["top", "right", "bottom", "left"] as const).every((k) => v.insets[k] === insets[k]);
          return same ? v : { width: window.innerWidth, height: window.innerHeight, insets };
        });
      });
    };
    update();
    const off = onCameraChange(update);
    window.addEventListener("resize", update);
    return () => {
      off();
      window.removeEventListener("resize", update);
      cancelAnimationFrame(frame);
    };
  }, [project, onCameraChange, selection.lngLat]);

  // Measure the card (its height changes with the feature and the details disclosure).
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const measure = () => setSize({ width: el.offsetWidth, height: el.offsetHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The dialog takes focus once it shows (a hidden element cannot take it), so keyboard users reach "Ask about this"
  // with one Tab, and hands it back to whatever had it (the map, a button) when it closes.
  useEffect(() => {
    const card = cardRef.current;
    const previous = document.activeElement;
    return () => {
      // Only when focus is still in the card (or fell to the page as the card left): a click elsewhere keeps its focus.
      const active = document.activeElement;
      const stillOurs = active === null || active === document.body || (card?.contains(active) ?? false);
      if (stillOurs && previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape in a text field or select belongs to that field (clearing it, closing its menu).
      const target = e.target;
      if (target instanceof Element && target.closest("input, select, textarea, [contenteditable='true']")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(selection.feature, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard permission denied: nothing useful to show beyond leaving the label as is.
    }
  };

  const ask = () => {
    const sent = onAsk();
    setBusy(!sent);
    if (!sent) window.setTimeout(() => setBusy(false), 2000);
  };

  // Plays the line as a route preview; `onPreviewRoute` (framing the line) is the fallback when no preview
  // control is mounted to run one.
  const preview = () => {
    if (!previewFeature(selection.feature, layer.id, summary.name ?? undefined)) onPreviewRoute();
  };

  const placement = anchor && size ? place(anchor, size, view) : null;
  const hidden = !placement || placement.offscreen;
  const focusedRef = useRef(false);
  useEffect(() => {
    if (hidden || focusedRef.current) return;
    focusedRef.current = true;
    cardRef.current?.focus({ preventScroll: true });
  }, [hidden]);

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={`${layer.title}${sideB ? " (compare side B)" : ""}: ${cell ? "Hex cell" : (summary.name ?? "Feature")}`}
      tabIndex={-1}
      data-testid="inspect-card"
      data-side={sideB ? "b" : undefined}
      className="inspect-card absolute z-30 rounded-[12px] border border-line bg-paper text-ink outline-none"
      style={{
        width: `min(${MAX_WIDTH}px, calc(100vw - ${EDGE * 2}px - var(--safe-left) - var(--safe-right)))`,
        left: placement?.left ?? 0,
        top: placement?.top ?? 0,
        visibility: hidden ? "hidden" : "visible",
        transformOrigin: placement ? `${placement.pointerX}px ${placement.below ? 0 : "100%"}` : undefined,
      }}
    >
      {/* The pointer: a rotated square tucked under the card's edge, aimed at the clicked point. */}
      {placement?.pointer && (
        <span
          aria-hidden
          className="absolute size-3 rotate-45 border-line bg-paper"
          style={{
            left: placement.pointerX - POINTER / 2,
            ...(placement.below
              ? { top: -POINTER / 2, borderTopWidth: 1, borderLeftWidth: 1 }
              : { bottom: -POINTER / 2, borderBottomWidth: 1, borderRightWidth: 1 }),
          }}
        />
      )}

      <div className="relative max-h-[min(70dvh,560px)] overflow-y-auto overscroll-contain px-4 pt-3 pb-3.5">
        <header className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-[11.5px] font-medium text-ink-muted">
              <span aria-hidden data-testid="inspect-swatch" className="shrink-0">
                <LegendKey symbol={swatch} size={16} />
              </span>
              <span className="truncate">{layer.title}</span>
              {/* Picked on a compare's side B: a plain text marker, as the console labels the sides. */}
              {sideB && (
                <span data-testid="inspect-side" title="Compare side B" className="shrink-0 rounded-pill border border-line px-1.5 text-[10.5px] leading-4 font-semibold text-ink">
                  B
                </span>
              )}
            </p>
            <h3 className="mt-0.5 font-serif text-[1.15rem] leading-snug font-semibold break-words text-ink">
              {cell && origin ? `${cell.count.toLocaleString("en-US")} ${cell.count === 1 ? "feature" : origin.ctx.noun} in this cell` : (summary.name ?? "Feature")}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
            className="-mt-0.5 -mr-1.5 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-mist hover:text-ink"
          >
            <X aria-hidden size={16} strokeWidth={2} />
          </button>
        </header>

        {cell && origin && (
          <HexCellBody
            cell={cell}
            words={rankWords(cell, origin.ctx)}
            onOpenFeature={onOpenFeature}
            onZoomTo={onZoomTo}
            onAsk={() => onAskCell?.(askAboutCellText(layer.title, layer.id, cell))}
          />
        )}

        {!cell && (summary.date || summary.estimate) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {summary.date && (
              <span className="rounded-pill bg-sage-tint px-2 py-0.5 text-[11.5px] font-medium text-ink tabular-nums">
                {summary.date}
              </span>
            )}
            {summary.estimate && (
              <span className="rounded-pill border border-line px-2 py-0.5 text-[11.5px] font-medium text-ink-muted">Estimate</span>
            )}
          </div>
        )}

        {/* The measure under its own name ("Routes 5"), with its "i" when the layer explains it; never "VALUE 5". */}
        {!cell && content.measure && (
          <div className="mt-3 flex items-baseline justify-between gap-3" data-testid="inspect-measure">
            <span className="flex items-center gap-1 text-[13px] text-ink-muted">
              {content.measure.label}
              {content.measure.help && <InfoMark help={content.measure.help} label={content.measure.label} />}
            </span>
            <span className="text-[1.35rem] leading-none font-semibold text-ink tabular-nums">{content.measure.value}</span>
          </div>
        )}

        {!cell && content.facts.length > 0 && (
          <div className="mt-2.5">
            <RowList rows={content.facts} />
          </div>
        )}

        {!cell && content.links.length > 0 && (
          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px]" data-testid="inspect-links">
            {content.links.map((link) => (
              <a key={link.key} href={link.url} target="_blank" rel="noreferrer" className="dashed-link text-ink">
                {link.label}
              </a>
            ))}
          </p>
        )}

        {!cell && content.signals.length > 0 && (
          <>
            <SectionLabel>Signals</SectionLabel>
            <RowList rows={content.signals} />
          </>
        )}

        {!cell && content.details.length > 0 && (
          <details className="group mt-2">
            <summary className="cursor-pointer list-none text-[12px] font-medium text-ink-muted select-none hover:text-ink">
              <span className="inline-block transition-transform group-open:rotate-90">›</span> Details
            </summary>
            <div className="mt-1">
              <RowList rows={content.details} />
            </div>
          </details>
        )}

        {!cell && content.facts.length === 0 && content.signals.length === 0 && !content.measure && content.details.length === 0 && (
          <p className="mt-2 text-[13px] text-ink-muted">This feature has no properties beyond its shape.</p>
        )}

        {coverageNote && !cell && <p className="mt-2.5 text-[12px] leading-snug text-ink-muted">{coverageNote}</p>}

        <p className="mt-2.5 text-[12px] text-ink-muted">
          Source:{" "}
          <a
            href={citation.url}
            target="_blank"
            rel="noreferrer"
            className="text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
          >
            {citation.source}
          </a>
          {citation.retrieved && <span className="tabular-nums"> · retrieved {formatDate(citation.retrieved)}</span>}
        </p>

        {/* Wally rows: the primary action as a 44px black button, then 44px rows split by hairlines. */}
        {!cell && (
        <>
        <button
          type="button"
          onClick={ask}
          className="press mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-[12px] bg-primary text-[14px] font-medium text-on-primary transition duration-150 ease-out hover:opacity-85"
        >
          <MessageCircle aria-hidden size={16} strokeWidth={2} />
          {busy ? "Chat is busy" : "Ask about this"}
        </button>
        <div className="mt-3 -mb-1.5 divide-y divide-line border-t border-line">
          <ActionRow onClick={() => void copy()} icon={copied ? Check : Copy}>
            {copied ? "Copied" : "Copy GeoJSON"}
          </ActionRow>
          {line && (
            <ActionRow onClick={preview} icon={Route}>
              Preview route
            </ActionRow>
          )}
        </div>
        </>
        )}
      </div>
    </div>
  );
}
