"use client";

import type { ReactNode } from "react";
import { TimeScrubber } from "@/components/TimeScrubber";
import type { FrameAggregate as Aggregate } from "@/lib/render/series";
import type { LinkedCurve } from "@/lib/render/linkedChart";
import { bucketAt, fullWindow } from "@/lib/render/reducer";
import { snapshotCompare } from "@/lib/render/compareView";
import { layerChange } from "@/lib/render/views";
import { timeShape } from "@/lib/render/contract";
import type { LoadedLayer, MapAction, MapState, TimeState } from "@/lib/render/state";
import { stepWindow, windowLabel, type SnapshotStop, type TimeIndex } from "@/lib/time";

type TimePanelProps = {
  time: TimeState;
  dispatch: (action: MapAction) => void;
  layers: MapState["layers"];
  renderOps: MapState["renderOps"];
  compare?: MapState["compare"];
  missingImage?: string | null;
  aggregate?: Aggregate | null;
  curve?: LinkedCurve | null;
  /** One row (phones): the step buttons and the date only. */
  compact?: boolean;
};

const TEXT_BUTTON = "text-[12px] text-ink-muted transition-colors duration-150 hover:text-ink";

/** True when the window covers the whole span (how a panel opens; snapshots then draw the newest of each). */
export function wholeSpan(index: TimeIndex, window: TimeState["window"]): boolean {
  const [lo, hi] = fullWindow(index);
  return Date.parse(window[0]) <= Date.parse(lo) && Date.parse(window[1]) >= Date.parse(hi);
}

/** The stop the window sits on, or -1 for the whole span (newest of each) or a window that is no stop. */
function stopIndex(stops: readonly SnapshotStop[], window: TimeState["window"]): number {
  return stops.findIndex((s) => Date.parse(s.start) <= Date.parse(window[0]) && Date.parse(s.end) >= Date.parse(window[1]));
}

/** "1963 – 2019 · 5 dates": a snapshot span in one phrase. */
function spanWords(index: TimeIndex): string {
  const stops = index.snapshots?.stops ?? [];
  const span = windowLabel([stops[0]?.start ?? index.min, stops[stops.length - 1]?.start ?? index.max], index.bucket === "day" ? "day" : index.bucket);
  return `${span} · ${stops.length} dates`;
}

/** The first shown snapshot layer behind the index (the one the stepper and the change statement are about). */
export function snapshotLayer(index: TimeIndex, layers: MapState["layers"]): LoadedLayer | undefined {
  return index.layerIds.map((id) => layers[id]).find((l): l is LoadedLayer => l !== undefined && l.result.kind === "geojson" && timeShape(l).shape === "snapshots");
}

/** What the folded time line says: the window, or for snapshots the date shown (newest of each by default). */
export function timeLine(time: TimeState): string {
  const { index, window } = time;
  if (index.snapshots) {
    if (wholeSpan(index, window)) return `Newest of each · ${spanWords(index)}`;
    const k = stopIndex(index.snapshots.stops, window);
    return k >= 0 ? index.snapshots.stops[k].label : windowLabel(window, index.bucket);
  }
  return windowLabel(window, index.bucket);
}

function Header({ title, line, children, dispatch, onFold }: { title: string; line: string; children?: ReactNode; dispatch: (a: MapAction) => void; onFold?: () => void }) {
  return (
    <div className="flex min-w-0 items-baseline gap-3">
      <h2 className="small-caps shrink-0">{title}</h2>
      <p aria-live="polite" className="min-w-0 flex-1 truncate text-[13px] leading-[18px] text-ink tabular-nums" data-testid="time-window-label">
        {line}
      </p>
      {children}
      {onFold && (
        <button type="button" onClick={onFold} className={TEXT_BUTTON} data-testid="time-fold" title="Fold the time panel to one line">
          Fold
        </button>
      )}
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
  );
}

/**
 * Snapshots (docs/layer-contract.md): a compact stepper between the actual dates (each with its count), "Newest of each"
 * first, and the one-line change between the first and last epoch with Compare, which opens the compare strip (swipe,
 * toggle or delta) on them. No histogram, no "Since 19xx".
 */
function SnapshotStepper({ time, dispatch, layers, renderOps, compare, compact }: TimePanelProps) {
  const { index, window } = time;
  const stops = index.snapshots?.stops ?? [];
  const at = wholeSpan(index, window) ? -1 : stopIndex(stops, window);
  const layer = snapshotLayer(index, layers);
  const filters = layer ? renderOps.find((o) => o.layerId === layer.id)?.filters : undefined;
  const change = layer ? layerChange(layer, filters) : null;
  const opening = layer ? snapshotCompare(layer) : null;
  const comparing = compare !== undefined && compare.layerId === layer?.id;
  const go = (k: number) => {
    if (k < 0) dispatch({ type: "set_time_window", window: fullWindow(index) });
    else dispatch({ type: "set_time_window", window: [stops[k].start, stops[k].end] });
  };
  const step = (d: 1 | -1) => go(Math.min(stops.length - 1, Math.max(-1, at + d)));
  const current = at < 0 ? "Newest of each" : stops[at].label;
  const compareButton = opening && !comparing && (
    <button type="button" className="dashed-link shrink-0 text-[12px] text-ink" data-testid="snapshot-compare" onClick={() => dispatch({ type: "set_compare", compare: opening })}>
      Compare {opening.aLabel} with {opening.bLabel}
    </button>
  );

  if (compact) {
    return (
      <div role="group" aria-label="Survey dates" data-testid="time-stepper" className="flex min-w-0 items-center gap-2">
        <button type="button" onClick={() => step(-1)} disabled={at < 0} aria-label="Earlier date" className={`${TEXT_BUTTON} hit-target px-1.5 text-[16px] disabled:opacity-30`}>
          ‹
        </button>
        <span className="min-w-0 flex-1 truncate text-center text-[13px] text-ink tabular-nums" data-testid="time-window-label">
          {current}
          {at >= 0 && <span className="text-ink-muted"> · {stops[at].count.toLocaleString("en-US")}</span>}
        </span>
        <button type="button" onClick={() => step(1)} disabled={at >= stops.length - 1} aria-label="Later date" className={`${TEXT_BUTTON} hit-target px-1.5 text-[16px] disabled:opacity-30`}>
          ›
        </button>
        {opening && !comparing && (
          <button type="button" className="filter-chip shrink-0" onClick={() => dispatch({ type: "set_compare", compare: opening })}>
            Compare
          </button>
        )}
      </div>
    );
  }

  return (
    <div role="group" aria-label="Time" data-testid="time-stepper" className="px-5 pt-4 pb-3">
      <Header title="Mapped" line={spanWords(index)} dispatch={dispatch} onFold={() => dispatch({ type: "set_time_open", open: false })} />
      <div role="group" aria-label="Survey dates" className="mt-2 flex flex-wrap gap-1" data-testid="snapshot-stops">
        <button type="button" aria-pressed={at < 0} onClick={() => go(-1)} className="filter-chip" title="Each thing at its newest date">
          Newest of each
        </button>
        {stops.map((s, k) => (
          <button key={s.start} type="button" aria-pressed={at === k} onClick={() => go(k)} className="filter-chip tabular-nums" title={`${s.count.toLocaleString("en-US")} mapped on this date`}>
            {s.label}
            <span className="filter-chip-count">{s.count.toLocaleString("en-US")}</span>
          </button>
        ))}
      </div>
      {change && (
        <p className="mt-2 text-[12px] leading-4 text-ink" data-testid="change-statement">
          {change.text}
        </p>
      )}
      {compareButton && <p className="mt-1.5">{compareButton}</p>}
    </div>
  );
}

/**
 * The time panel at the top of the data console, by what time means for the layers on it (docs/layer-contract.md):
 * folded to one line unless the question was about time or the data is current (the reducer decides `time.open`);
 * open, a stepper between the dates of snapshots, or the scrubber with presets for continuous data. `compact` (phones)
 * keeps it to one row.
 */
export function TimePanel(props: TimePanelProps) {
  const { time, dispatch, compact = false } = props;
  const open = time.open ?? false;
  if (!open) {
    return (
      <div data-testid="time-folded" className={compact ? "flex min-w-0 items-center gap-2" : "px-5 pt-3 pb-2.5"}>
        {compact ? (
          <>
            <span className="small-caps shrink-0">Time</span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink tabular-nums" data-testid="time-window-label">
              {timeLine(time)}
            </span>
          </>
        ) : (
          <Header title="Time" line={timeLine(time)} dispatch={dispatch}>
            <button type="button" onClick={() => dispatch({ type: "set_time_open", open: true })} className="dashed-link shrink-0 text-[12px] text-ink" data-testid="time-open">
              {time.index.snapshots ? "Dates" : "Scrub"}
            </button>
          </Header>
        )}
      </div>
    );
  }
  if (time.index.snapshots) return <SnapshotStepper {...props} />;
  if (compact) return <CompactScrubber time={time} dispatch={dispatch} />;
  return <TimeScrubber time={time} dispatch={dispatch} missingImage={props.missingImage} aggregate={props.aggregate} curve={props.curve} />;
}

/** The scrubber in one row (phones): play, step back, the window, step forward. */
function CompactScrubber({ time, dispatch }: { time: TimeState; dispatch: (a: MapAction) => void }) {
  const { index, window, playing, mode } = time;
  const step = (d: 1 | -1) => {
    if (playing) dispatch({ type: "set_time_playing", playing: false });
    dispatch({ type: "set_time_window", window: stepWindow(index, window, d, mode) });
  };
  const j = bucketAt(index, window[1]);
  return (
    <div role="group" aria-label="Time" data-testid="time-compact" className="flex min-w-0 items-center gap-2">
      <button type="button" onClick={() => dispatch({ type: "set_time_playing", playing: !playing })} aria-pressed={playing} className="time-play shrink-0" data-testid="time-play">
        {playing ? "Pause" : "Play"}
      </button>
      <button type="button" onClick={() => step(-1)} aria-label="Step back" className={`${TEXT_BUTTON} hit-target px-1.5 text-[16px]`}>
        ‹
      </button>
      <span className="min-w-0 flex-1 truncate text-center text-[13px] text-ink tabular-nums" data-testid="time-window-label">
        {windowLabel(window, index.bucket)}
      </span>
      <button type="button" onClick={() => step(1)} aria-label="Step forward" className={`${TEXT_BUTTON} hit-target px-1.5 text-[16px]`}>
        ›
      </button>
      <span className="shrink-0 text-[11px] text-ink-muted tabular-nums">
        {j + 1}/{index.buckets.length}
      </span>
    </div>
  );
}
