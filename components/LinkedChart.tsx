"use client";

import { useRef, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";
import { playheadStore } from "@/lib/render/playhead";
import { valueAt } from "@/lib/render/series";
import type { LinkedCurve } from "@/lib/render/linkedChart";
import type { MapAction, TimeState } from "@/lib/render/state";

const W = 280;
const H = 56;
const PAD = 2;

function amount(value: number, unit: string): string {
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  return `${value.toLocaleString("en-US", { maximumFractionDigits: digits })}${unit ? ` ${unit}` : ""}`;
}

/**
 * The linked curve under the time scrubber (spec §13a): a small line chart of one series over the scrubber's frames,
 * the tide for currents, the flow at the selected (or largest) reach, the wind at the map's center, with a pink playhead
 * gliding with play, the value at the playhead, and forecast frames lighter. Clicking (or arrow keys on) the chart moves
 * the map to that frame.
 */
export function LinkedChart({ curve, time, dispatch }: { curve: LinkedCurve; time: TimeState; dispatch: (action: MapAction) => void }) {
  const playhead = useSyncExternalStore(playheadStore.subscribe, playheadStore.get, playheadStore.get);
  const ref = useRef<SVGSVGElement>(null);
  const n = curve.values.length;
  const known = curve.values.filter((v): v is number => v !== null);
  if (n < 2 || known.length < 2) return null;
  const lo = Math.min(...known);
  const hi = Math.max(...known);
  const span = hi - lo || 1;
  const x = (k: number) => PAD + ((W - 2 * PAD) * k) / (n - 1);
  const y = (v: number) => PAD + (H - 2 * PAD) * (1 - (v - lo) / span);
  const forecastFrom = time.index.series?.forecastFrom;
  const path = (from: number, to: number) => {
    let d = "";
    let pen = false;
    for (let k = from; k <= to; k++) {
      const v = curve.values[k];
      if (v === null) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${x(k).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  const split = forecastFrom !== undefined && forecastFrom < n ? forecastFrom : n;
  const past = path(0, Math.min(n - 1, split));
  const future = split < n ? path(split, n - 1) : "";
  const at = Math.min(n - 1, Math.max(0, playhead));
  const value = valueAt(curve.values, at);
  const seek = (k: number) => {
    const i = Math.min(n - 1, Math.max(0, Math.round(k)));
    if (time.playing) dispatch({ type: "set_time_playing", playing: false });
    const b = time.index.buckets[i];
    dispatch({ type: "set_time_window", window: [b.start, b.end] });
  };
  const onPointer = (e: PointerEvent<SVGSVGElement>) => {
    if (e.type === "pointermove" && e.buttons !== 1) return;
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    seek(((e.clientX - rect.left) / rect.width) * (n - 1));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    seek(Math.round(at) + (e.key === "ArrowRight" ? 1 : -1));
  };
  return (
    <div data-testid="linked-chart" className="mt-3">
      <div className="flex items-baseline justify-between gap-2 text-[11px] leading-4">
        <span className="min-w-0 truncate text-ink-muted" title={curve.source ? `${curve.title} · ${curve.source}` : curve.title}>
          {curve.title}
        </span>
        <span className="shrink-0 text-ink tabular-nums" data-testid="linked-chart-value">
          {value === null ? "–" : amount(value, curve.unit)}
        </span>
      </div>
      <svg
        ref={ref}
        role="slider"
        tabIndex={0}
        aria-label={`${curve.title}: click to move the map to that time`}
        aria-valuemin={0}
        aria-valuemax={n - 1}
        aria-valuenow={Math.round(at)}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        onPointerDown={onPointer}
        onPointerMove={onPointer}
        onKeyDown={onKey}
        className="mt-1 block h-14 w-full cursor-pointer touch-none select-none"
      >
        <path d={`${past}`} fill="none" className="frame-chart-line" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
        {future && <path d={future} fill="none" className="frame-chart-line" strokeWidth="1.25" strokeDasharray="3 3" opacity="0.55" vectorEffect="non-scaling-stroke" />}
        <line x1={x(at)} x2={x(at)} y1={0} y2={H} className="frame-chart-head" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        {value !== null && <circle cx={x(at)} cy={y(value)} r="2.5" className="frame-chart-dot" />}
      </svg>
      <div className="flex justify-between text-[10.5px] leading-[14px] text-ink-muted tabular-nums">
        <span>{amount(lo, curve.unit)}</span>
        <span>{amount(hi, curve.unit)}</span>
      </div>
    </div>
  );
}
