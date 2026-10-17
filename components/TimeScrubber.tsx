"use client";

import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { FrameAggregate } from "@/components/FrameAggregate";
import { formatValue } from "@/lib/format";
import type { FrameAggregate as Aggregate } from "@/lib/render/series";
import { bucketAt } from "@/lib/render/reducer";
import type { MapAction, TimeMode, TimeState } from "@/lib/render/state";
import { stepLabel, stepWindow, timePresets, windowLabel, type Bucket, type TimeIndex, type TimeWindow } from "@/lib/time";

type TimeScrubberProps = {
  time: TimeState;
  dispatch: (action: MapAction) => void;
  /** True when a dated tile layer has no image for the window's date (its tiles all failed). */
  missingImage?: boolean;
  /** The live aggregate (spec §13): the frame's date and total against the period's low and high. */
  aggregate?: Aggregate | null;
};

/** One bucket's start as the scrubber's axis shows it: "2019", "Mar 2024" or "2024-06-01". */
function bucketName(start: string, bucket: Bucket): string {
  return windowLabel([start, start], bucket).split(" – ")[0];
}

/** The window from bucket `a` through bucket `b` (either order). */
function spanOf(index: TimeIndex, a: number, b: number): TimeWindow {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(index.buckets.length - 1, Math.max(a, b));
  return [index.buckets[lo].start, index.buckets[hi].end];
}

type Drag = { kind: "start" | "end" | "move"; from: number; i: number; j: number };

const TEXT_BUTTON = "text-[12px] text-ink-muted transition-colors duration-150 hover:text-ink";

/**
 * The time scrubber at the top of the data console: a histogram of features per bucket (ink bars, the window's
 * bars purple; with dated tile layers alone, one even bar per published image), a window with two handles (drag them, or arrow keys on each; drag or arrow keys on the window
 * itself move it whole), play/pause (space anywhere in the scrubber), step back and forward, slide or cumulative mode,
 * the window's dates, and × to clear. Text only; the window and its handles are purple (palette §11). It only shows and changes state: the play timer runs in
 * the app (lib/render/useTimePlay.ts), so play goes on while the panel is closed.
 */
export function TimeScrubber({ time, dispatch, missingImage = false, aggregate = null }: TimeScrubberProps) {
  const { index, window, playing, mode } = time;
  const n = index.buckets.length;
  const i = bucketAt(index, window[0]);
  const j = bucketAt(index, window[1]);
  // A series has no features to count per frame: its bars are the aggregate's total per frame.
  const fromAggregate = index.series !== undefined && aggregate !== null;
  const counts = fromAggregate ? aggregate.values.map((v) => Math.max(0, v ?? 0)) : index.buckets.map((b) => b.count);
  const max = Math.max(1, ...counts);
  const total = counts.reduce((a, b) => a + b, 0);
  const shown = counts.slice(i, j + 1).reduce((a, b) => a + b, 0);
  const label = windowLabel(window, index.bucket);

  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const windowRef = useRef<HTMLDivElement>(null);

  const setSpan = (a: number, b: number) => dispatch({ type: "set_time_window", window: spanOf(index, a, b) });
  const pause = () => {
    if (playing) dispatch({ type: "set_time_playing", playing: false });
  };
  const step = (direction: 1 | -1) => {
    pause();
    dispatch({ type: "set_time_window", window: stepWindow(index, window, direction, mode) });
  };
  const setMode = (next: TimeMode) => dispatch({ type: "set_time_mode", mode: next });

  const bucketFromX = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return Math.min(n - 1, Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * n)));
  };

  const beginDrag = (e: PointerEvent, kind: Drag["kind"]) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // preventDefault keeps text from selecting but also blocks focus; focus by hand so arrow keys follow the press.
    (kind === "move" ? windowRef.current : (e.currentTarget as HTMLElement))?.focus({ preventScroll: true });
    pause();
    const at = bucketFromX(e.clientX);
    let from = { i, j };
    if (kind === "move" && (at < i || at > j)) {
      // A press outside the window jumps it there (same width in slide mode), then drags it.
      const width = mode === "cumulative" ? 0 : j - i;
      const start = Math.min(at, n - 1 - width);
      from = { i: start, j: start + width };
      if (mode === "cumulative") setSpan(0, at);
      else setSpan(from.i, from.j);
    }
    dragRef.current = { kind, from: at, ...from };
    trackRef.current?.setPointerCapture?.(e.pointerId);
  };

  const onDragMove = (e: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const at = bucketFromX(e.clientX);
    if (drag.kind === "start") setSpan(Math.min(at, j), j);
    else if (drag.kind === "end") setSpan(mode === "cumulative" ? 0 : i, Math.max(at, mode === "cumulative" ? 0 : i));
    else if (mode === "cumulative") setSpan(0, at);
    else {
      const delta = Math.min(n - 1 - drag.j, Math.max(-drag.i, at - drag.from));
      setSpan(drag.i + delta, drag.j + delta);
    }
  };

  const endDrag = (e: PointerEvent) => {
    dragRef.current = null;
    if (trackRef.current?.hasPointerCapture?.(e.pointerId)) trackRef.current.releasePointerCapture(e.pointerId);
  };

  /** Arrow keys (and Home/End) on a handle move that end one bucket at a time. */
  const onHandleKey = (end: "start" | "end") => (e: KeyboardEvent) => {
    const delta = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
    if (delta === 0 && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    pause();
    if (end === "start") {
      const next = e.key === "Home" ? 0 : e.key === "End" ? j : Math.min(j, Math.max(0, i + delta));
      setSpan(next, j);
    } else {
      const next = e.key === "Home" ? i : e.key === "End" ? n - 1 : Math.min(n - 1, Math.max(i, j + delta));
      setSpan(i, next);
    }
  };

  /** Arrow keys on the window move it whole, one bucket a step. */
  const onWindowKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    step(e.key === "ArrowRight" ? 1 : -1);
  };

  /** Space plays or pauses from anywhere in the scrubber (a focused button handles its own space). */
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== " " || (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    dispatch({ type: "set_time_playing", playing: !playing });
  };

  const left = (i / n) * 100;
  const width = ((j - i + 1) / n) * 100;
  // Tile layers alone have no features to count: every step is one image, drawn as an even bar.
  const imagesOnly = index.cadence !== undefined;
  // Quick windows beside the scrubber (spec §12c): the last week, this year, since a decade; pressed when the window is it.
  const presets = timePresets(index);
  const isPreset = (w: TimeWindow) => bucketAt(index, w[0]) === i && bucketAt(index, w[1]) === j;

  return (
    <div role="group" aria-label="Time" data-testid="time-scrubber" onKeyDown={onKeyDown} className="px-5 pt-4 pb-3">
      <div className="flex items-baseline gap-3">
        <h2 className="small-caps">Time</h2>
        <p aria-live="polite" className="min-w-0 flex-1 truncate text-[13px] leading-[18px] text-ink tabular-nums" data-testid="time-window-label">
          {label}
        </p>
        <button
          type="button"
          onClick={() => dispatch({ type: "clear_time" })}
          aria-label="Clear time window"
          title="Show all dates"
          className="hit-target px-1 text-[15px] leading-none text-ink-muted transition-colors hover:text-ink"
        >
          ×
        </button>
      </div>

      {aggregate && <FrameAggregate time={time} aggregate={aggregate} />}

      <div
        ref={trackRef}
        data-testid="time-track"
        onPointerDown={(e) => beginDrag(e, "move")}
        onPointerMove={onDragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="time-track relative mt-2.5 h-10 cursor-pointer touch-none select-none"
      >
        <div aria-hidden className="absolute inset-0 flex items-end gap-px">
          {index.buckets.map((b, k) => (
            <div
              key={b.start}
              title={
                imagesOnly
                  ? bucketName(b.start, index.bucket)
                  : fromAggregate
                    ? `${bucketName(b.start, index.bucket)}: ${aggregate.values[k] === null ? "no value" : formatValue("v", aggregate.values[k] ?? 0, aggregate.unit)}`
                    : `${bucketName(b.start, index.bucket)}: ${formatValue("count", b.count)}`
              }
              data-forecast={(index.series?.forecastFrom !== undefined && k >= index.series.forecastFrom) || undefined}
              data-in-window={(k >= i && k <= j) || undefined}
              className="time-bar flex-1"
              style={{ height: imagesOnly ? "30%" : counts[k] > 0 ? `${Math.max(4, (counts[k] / max) * 100)}%` : "1px" }}
            />
          ))}
        </div>
        <div
          role="slider"
          tabIndex={0}
          aria-label="Time window (arrow keys move it)"
          aria-valuemin={0}
          aria-valuemax={n - 1}
          aria-valuenow={j}
          aria-valuetext={label}
          data-testid="time-window"
          ref={windowRef}
          onKeyDown={onWindowKey}
          onPointerDown={(e) => beginDrag(e, "move")}
          className="time-band absolute inset-y-0 cursor-grab active:cursor-grabbing"
          style={{ left: `${left}%`, width: `${width}%` }}
        />
        {mode === "slide" && (
          <div
            role="slider"
            tabIndex={0}
            aria-label="Window start"
            aria-valuemin={0}
            aria-valuemax={n - 1}
            aria-valuenow={i}
            aria-valuetext={bucketName(index.buckets[i].start, index.bucket)}
            onKeyDown={onHandleKey("start")}
            onPointerDown={(e) => beginDrag(e, "start")}
            className="time-handle absolute inset-y-0"
            style={{ left: `${left}%` }}
          />
        )}
        <div
          role="slider"
          tabIndex={0}
          aria-label="Window end"
          aria-valuemin={0}
          aria-valuemax={n - 1}
          aria-valuenow={j}
          aria-valuetext={bucketName(index.buckets[j].start, index.bucket)}
          onKeyDown={onHandleKey("end")}
          onPointerDown={(e) => beginDrag(e, "end")}
          className="time-handle absolute inset-y-0"
          style={{ left: `${left + width}%` }}
        />
      </div>
      <div className="mt-1 flex items-baseline justify-between text-[11px] leading-4 text-ink-muted tabular-nums">
        <span>{bucketName(index.buckets[0].start, index.bucket)}</span>
        {missingImage ? (
          <span role="status" data-testid="time-missing-image" className="text-ink">
            No image for {bucketName(index.buckets[j].start, index.bucket)}
          </span>
        ) : (
          <span data-testid="time-step-label">{stepLabel(index)}</span>
        )}
        <span>{bucketName(index.buckets[n - 1].start, index.bucket)}</span>
      </div>

      {presets.length > 0 && (
        <div role="group" aria-label="Time presets" data-testid="time-presets" className="mt-2 flex flex-wrap gap-1">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              aria-pressed={isPreset(p.window)}
              onClick={() => {
                pause();
                if (mode === "cumulative") setMode("slide");
                dispatch({ type: "set_time_window", window: p.window });
              }}
              className="filter-chip"
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => dispatch({ type: "set_time_playing", playing: !playing })}
          aria-pressed={playing}
          className="time-play"
          data-testid="time-play"
        >
          {playing ? "Pause" : "Play"}
        </button>
        <button type="button" onClick={() => step(-1)} aria-label="Step back" title="Step back" className={`${TEXT_BUTTON} px-1`}>
          ‹
        </button>
        <button type="button" onClick={() => step(1)} aria-label="Step forward" title="Step forward" className={`${TEXT_BUTTON} px-1`}>
          ›
        </button>
        <div role="group" aria-label="Window mode" className="ml-1 flex items-baseline gap-2">
          {(["slide", "cumulative"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              title={m === "slide" ? "The window moves" : "The window grows from the first date"}
              className="time-mode"
            >
              {m === "slide" ? "Slide" : "Cumulative"}
            </button>
          ))}
        </div>
        {imagesOnly || index.series ? (
          <span className="ml-auto text-[11.5px] text-ink-muted tabular-nums" title={index.series ? "The frame shown, of the frames on the scrubber" : "The image shown, of the images on the scrubber"}>
            <span className="text-ink">{formatValue("count", j + 1)}</span> / {formatValue("count", n)}
          </span>
        ) : (
          <span className="ml-auto text-[11.5px] text-ink-muted tabular-nums" title="Dated features in the window, of all dated features">
            <span className="text-ink">{formatValue("count", shown)}</span> / {formatValue("count", total)}
          </span>
        )}
      </div>
    </div>
  );
}
