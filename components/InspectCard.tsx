"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AskIcon, CheckIcon, CloseIcon, CopyIcon, RouteIcon } from "@/components/icons";
import { formatDate, isLineFeature, summarizeFeature, type Row } from "@/lib/render/inspect";
import type { LoadedLayer, Selection } from "@/lib/render/state";

type Point = { x: number; y: number };

type InspectCardProps = {
  selection: Selection;
  layer: LoadedLayer;
  /** Swatch color as drawn on the map. */
  color: string;
  /** Screen position of a map point; null before the map exists. */
  project: (lngLat: [number, number]) => Point | null;
  /** Re-run on every camera frame; returns the unsubscribe function. */
  onCameraChange: (listener: () => void) => () => void;
  onClose: () => void;
  /** Sends the "Ask about this" message; false when the chat is busy. */
  onAsk: () => boolean;
  onPreviewRoute: () => void;
};

const MAX_WIDTH = 340;
/** Breathing room between the card and the window edge, and between the card and the clicked point. */
const EDGE = 12;
const GAP = 14;
/** The header row of wordmark and basemap switch; the card never tucks under it. */
const TOP_SAFE = 64;
const POINTER = 12;

type Placement = { left: number; top: number; below: boolean; pointerX: number; offscreen: boolean };

/**
 * Where the card goes for an anchor point: centered above it, flipped below when there is no room above,
 * slid sideways to stay on screen, with the pointer still aimed at the point.
 */
function place(anchor: Point, card: { width: number; height: number }, view: { width: number; height: number }): Placement {
  const offscreen = anchor.x < 0 || anchor.y < 0 || anchor.x > view.width || anchor.y > view.height;
  const roomAbove = anchor.y - GAP - TOP_SAFE;
  const below = roomAbove < card.height && view.height - anchor.y - GAP - EDGE > roomAbove;
  const top = below ? anchor.y + GAP : Math.max(TOP_SAFE, anchor.y - GAP - card.height);
  const maxLeft = Math.max(EDGE, view.width - EDGE - card.width);
  const left = Math.min(maxLeft, Math.max(EDGE, anchor.x - card.width / 2));
  const pointerX = Math.min(card.width - 20, Math.max(20, anchor.x - left));
  return { left, top, below, pointerX, offscreen };
}

function RowList({ rows }: { rows: Row[] }) {
  return (
    <dl className="text-[13px] leading-5">
      {rows.map((r) => (
        <div key={r.key} className="flex items-baseline justify-between gap-3 border-t border-line py-1.5">
          <dt className="min-w-0 max-w-[48%] shrink-0 truncate text-ink-muted" title={r.label}>
            {r.label}
          </dt>
          <dd className="min-w-0 text-right break-words text-ink tabular-nums">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SectionLabel({ children }: { children: string }) {
  return <p className="mt-3 mb-0.5 text-[10.5px] font-semibold tracking-[0.08em] text-ink-muted uppercase">{children}</p>;
}

/** A white card floating at the clicked feature: what it is, its key facts, where the data came from. */
export function InspectCard({
  selection,
  layer,
  color,
  project,
  onCameraChange,
  onClose,
  onAsk,
  onPreviewRoute,
}: InspectCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<Point | null>(() => project(selection.lngLat) ?? selection.screen ?? null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [view, setView] = useState(() =>
    typeof window === "undefined" ? { width: 1000, height: 800 } : { width: window.innerWidth, height: window.innerHeight },
  );
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const unit = layer.style.unit;
  const summary = useMemo(() => summarizeFeature(selection.feature, unit), [selection.feature, unit]);
  const { citation, coverageNote } = layer.result;
  const line = isLineFeature(selection.feature);

  // Follow the clicked point as the camera moves (including the ease onto the feature).
  useEffect(() => {
    let frame = 0;
    const update = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const next = project(selection.lngLat);
        if (next) setAnchor(next);
        setView({ width: window.innerWidth, height: window.innerHeight });
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
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

  const placement = anchor && size ? place(anchor, size, view) : null;
  const hidden = !placement || placement.offscreen;

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={`${layer.title}: ${summary.name ?? "Feature"}`}
      data-testid="inspect-card"
      className="inspect-card absolute z-30 rounded-[12px] border border-line bg-paper text-ink"
      style={{
        width: `min(${MAX_WIDTH}px, calc(100vw - ${EDGE * 2}px))`,
        left: placement?.left ?? 0,
        top: placement?.top ?? 0,
        visibility: hidden ? "hidden" : "visible",
        transformOrigin: placement ? `${placement.pointerX}px ${placement.below ? 0 : "100%"}` : undefined,
      }}
    >
      {/* The pointer: a rotated square tucked under the card's edge, aimed at the clicked point. */}
      {placement && (
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

      <div className="relative max-h-[min(70vh,560px)] overflow-y-auto overscroll-contain px-4 pt-3 pb-3.5">
        <header className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-[11.5px] font-medium text-ink-muted">
              <span aria-hidden className="size-2 shrink-0 rounded-full ring-1 ring-black/20 ring-inset" style={{ backgroundColor: color }} />
              <span className="truncate">{layer.title}</span>
            </p>
            <h3 className="mt-0.5 font-serif text-[1.15rem] leading-snug font-semibold break-words text-ink">
              {summary.name ?? "Feature"}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
            className="-mt-0.5 -mr-1.5 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-mist hover:text-ink"
          >
            <CloseIcon width={15} height={15} />
          </button>
        </header>

        {(summary.date || summary.estimate) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {summary.date && (
              <span className="rounded-pill bg-mist px-2 py-0.5 text-[11.5px] font-medium text-ink tabular-nums">
                {summary.date}
              </span>
            )}
            {summary.estimate && (
              <span className="rounded-pill bg-accent/20 px-2 py-0.5 text-[11.5px] font-medium text-ink">Estimate</span>
            )}
          </div>
        )}

        {summary.value && (
          <div className="mt-3 flex items-baseline justify-between gap-3">
            <span className="text-[11px] font-semibold tracking-[0.08em] text-ink-muted uppercase">{summary.value.label}</span>
            <span className="text-[1.35rem] leading-none font-semibold text-ink tabular-nums">{summary.value.value}</span>
          </div>
        )}

        {summary.rows.length > 0 && (
          <div className="mt-2.5">
            <RowList rows={summary.rows} />
          </div>
        )}

        {summary.signals.length > 0 && (
          <>
            <SectionLabel>Signals</SectionLabel>
            <RowList rows={summary.signals} />
          </>
        )}

        {summary.details.length > 0 && (
          <details className="group mt-2">
            <summary className="cursor-pointer list-none text-[12px] font-medium text-ink-muted select-none hover:text-ink">
              <span className="inline-block transition-transform group-open:rotate-90">›</span> Details
            </summary>
            <div className="mt-1">
              <RowList rows={summary.details} />
            </div>
          </details>
        )}

        {summary.rows.length === 0 && summary.signals.length === 0 && !summary.value && (
          <p className="mt-2 text-[13px] text-ink-muted">This feature has no properties beyond its shape.</p>
        )}

        {coverageNote && <p className="mt-2.5 text-[12px] leading-snug text-ink-muted">{coverageNote}</p>}

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

        <div className="mt-3 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={ask}
            className="inline-flex h-8 items-center gap-1.5 rounded-pill bg-ink px-3 text-[12.5px] font-medium text-paper transition-[background-color,transform] hover:bg-ink/85 active:scale-[0.98]"
          >
            <AskIcon width={14} height={14} />
            {busy ? "Chat is busy" : "Ask about this"}
          </button>
          <button
            type="button"
            onClick={() => void copy()}
            className="inline-flex h-8 items-center gap-1.5 rounded-pill border border-line px-3 text-[12.5px] font-medium text-ink transition-[background-color,transform] hover:bg-mist active:scale-[0.98]"
          >
            {copied ? <CheckIcon width={14} height={14} /> : <CopyIcon width={14} height={14} />}
            {copied ? "Copied" : "Copy GeoJSON"}
          </button>
          {line && (
            <button
              type="button"
              onClick={onPreviewRoute}
              className="inline-flex h-8 items-center gap-1.5 rounded-pill border border-line px-3 text-[12.5px] font-medium text-ink transition-[background-color,transform] hover:bg-mist active:scale-[0.98]"
            >
              <RouteIcon width={14} height={14} />
              Preview route
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
