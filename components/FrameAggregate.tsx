"use client";

import { useSyncExternalStore } from "react";
import { formatValue } from "@/lib/format";
import { playheadStore } from "@/lib/render/playhead";
import { bucketAt } from "@/lib/render/reducer";
import { frameDate, shareOfRange, valueAt, wantsYearDial, yearFraction, type FrameAggregate as Aggregate } from "@/lib/render/series";
import type { TimeState } from "@/lib/render/state";
import { windowLabel } from "@/lib/time";

const MONTH_LETTERS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

function amount(value: number, unit: string | undefined): string {
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  const text = value.toLocaleString("en-US", { maximumFractionDigits: digits });
  return unit && unit !== "score" ? `${text} ${unit}` : text;
}

/** A point on the dial at a share of the year (0 at the top, clockwise). */
function onDial(share: number, r: number, c = 22): [number, number] {
  const a = share * 2 * Math.PI - Math.PI / 2;
  return [c + r * Math.cos(a), c + r * Math.sin(a)];
}

/**
 * The year dial (spec §13: "seasonal data gets a year dial showing where in the year the frame is"): a hairline ring
 * with the twelve months, the period the data spans as a purple arc, and a pink hand at the frame, gliding with the
 * playhead.
 */
function YearDial({ fromMs, toMs, atMs }: { fromMs: number; toMs: number; atMs: number }) {
  const from = yearFraction(fromMs);
  const span = Math.min(0.999, (toMs - fromMs) / (365.25 * 86_400_000));
  const steps = Math.max(2, Math.ceil(span * 48));
  const arc = Array.from({ length: steps + 1 }, (_, k) => onDial(from + (span * k) / steps, 17));
  const [hx, hy] = onDial(yearFraction(atMs), 15);
  return (
    <svg aria-hidden width="44" height="44" viewBox="0 0 44 44" className="shrink-0" data-testid="year-dial">
      <circle cx="22" cy="22" r="17" fill="none" stroke="var(--color-hairline, currentColor)" strokeOpacity="0.35" strokeWidth="1" />
      <polyline points={arc.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ")} fill="none" className="year-dial-span" strokeWidth="2.5" strokeLinecap="round" />
      {MONTH_LETTERS.map((m, i) => {
        const [x, y] = onDial(i / 12 + 1 / 24, 20.5);
        const [tx, ty] = onDial(i / 12, 17);
        const [ux, uy] = onDial(i / 12, 14.5);
        return (
          <g key={i}>
            <line x1={tx} y1={ty} x2={ux} y2={uy} stroke="currentColor" strokeOpacity="0.35" strokeWidth="0.75" />
            {i % 3 === 0 && (
              <text x={x} y={y} fontSize="5.5" textAnchor="middle" dominantBaseline="central" fill="currentColor" opacity="0.6">
                {m}
              </text>
            )}
          </g>
        );
      })}
      <line x1="22" y1="22" x2={hx} y2={hy} className="year-dial-hand" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="22" cy="22" r="1.5" className="year-dial-pin" />
    </svg>
  );
}

/**
 * The live aggregate at the top of the time scrubber (spec §13): the frame's date large, the layer's measure totalled for
 * the frame (sum, largest or mean, or a count of features), a bar from the period's low to its high with the frame
 * marked, and for data spanning months the year dial. While play runs the total and the dial glide between frames with
 * the playhead; the date steps with the frame. A window wider than one frame shows its total instead, without the bar.
 */
export function FrameAggregate({ time, aggregate }: { time: TimeState; aggregate: Aggregate }) {
  const playhead = useSyncExternalStore(playheadStore.subscribe, playheadStore.get, playheadStore.get);
  const { index, window, mode } = time;
  const i = bucketAt(index, window[0]);
  const j = bucketAt(index, window[1]);
  const framed = index.series !== undefined || i === j || mode === "cumulative";
  // The glide only between the frame shown and the next; a stale playhead (another frame) falls back to the frame.
  const at = framed && playhead >= j && playhead <= j + 1 ? playhead : j;
  const windowValues = aggregate.values.slice(i, j + 1).filter((v): v is number => v !== null);
  const value = framed
    ? valueAt(aggregate.values, at)
    : windowValues.length === 0
      ? null
      : aggregate.kind === "max"
        ? Math.max(...windowValues)
        : aggregate.kind === "mean"
          ? windowValues.reduce((a, b) => a + b, 0) / windowValues.length
          : windowValues.reduce((a, b) => a + b, 0);
  const startMs = Date.parse(index.buckets[j].start);
  const nextMs = Date.parse(index.buckets[Math.min(index.buckets.length - 1, j + 1)].start);
  const atMs = startMs + (nextMs - startMs) * Math.max(0, at - j);
  const forecast = index.series?.forecastFrom !== undefined && j >= index.series.forecastFrom;
  const date = framed ? frameDate(startMs, index.bucket) : windowLabel(window, index.bucket);
  const share = value === null ? null : shareOfRange(value, aggregate);
  const dial = wantsYearDial(index);
  const isCount = aggregate.kind === "count";
  const shown = value === null ? "–" : isCount ? formatValue("count", Math.round(value)) : amount(value, aggregate.unit);
  const lowText = aggregate.low ? (isCount ? formatValue("count", aggregate.low.value) : amount(aggregate.low.value, aggregate.unit)) : "";
  const highText = aggregate.high ? (isCount ? formatValue("count", aggregate.high.value) : amount(aggregate.high.value, aggregate.unit)) : "";
  // The low and high's dates without the weekday: "3 Aug 2026", "Mar 2026", "2019".
  const whenOf = (k: number | undefined) => {
    if (k === undefined) return "";
    const text = frameDate(Date.parse(index.buckets[k].start), index.bucket === "hour" ? "day" : index.bucket);
    return index.bucket === "hour" || index.bucket === "day" ? text.replace(/^\w{3} /, "") : text;
  };
  return (
    <div data-testid="frame-aggregate" className="mt-2.5 flex items-start gap-3">
      {dial && <YearDial fromMs={Date.parse(index.buckets[0].start)} toMs={Date.parse(index.buckets[index.buckets.length - 1].end)} atMs={atMs} />}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p data-testid="frame-date" className={`min-w-0 truncate font-medium text-ink tabular-nums ${framed ? "text-[17px] leading-6" : "text-[13px] leading-6"}`}>
            {date}
          </p>
          <p data-testid="frame-total" className="shrink-0 text-[17px] leading-6 font-medium text-ink tabular-nums">
            {shown}
          </p>
        </div>
        <div className="flex items-baseline justify-between gap-3 text-[11px] leading-4 text-ink-muted">
          <span>{forecast ? "Forecast" : framed ? (mode === "cumulative" ? "Up to this frame" : "This frame") : "In the window"}</span>
          <span className="truncate text-right">{aggregate.label}</span>
        </div>
        {framed && share !== null && aggregate.low && aggregate.high && (
          <div className="mt-1.5" data-testid="frame-range">
            <div className="frame-range relative h-[3px] rounded-full">
              <div className="frame-range-fill absolute inset-y-0 left-0 rounded-full" style={{ width: `${(share * 100).toFixed(1)}%` }} />
              <div className="frame-range-mark absolute top-1/2 h-[9px] w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: `${(share * 100).toFixed(1)}%` }} />
            </div>
            <div className="mt-1 flex justify-between text-[10.5px] leading-[14px] text-ink-muted tabular-nums">
              <span title="The period's low">
                Low {lowText} · {whenOf(aggregate.low.at)}
              </span>
              <span title="The period's high">
                High {highText} · {whenOf(aggregate.high.at)}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
