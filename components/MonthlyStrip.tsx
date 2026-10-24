"use client";

import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { legendLines, MONTH_INITIALS, monthLine, shapeStrip, stripSource, type StripSource } from "@/lib/render/monthlyStrip";
import type { MapState } from "@/lib/render/state";

/** The strip's drawing width in SVG units: the data console's 320 px less its 20 px gutters. */
const W = 280;
const INITIALS_ROOM = 11;

/**
 * The monthly strip (spec T10 "Monthly climate strip"), in the linked chart's slot under the time panel: twelve
 * columns January to December, a temperature band, precipitation or flow bars and a shaded snow or green-up row, the
 * current month marked by the pink playhead. Tapping a month (or arrow keys) puts that month's values in words above
 * it; the legend says what each row is. `compact` (phones) keeps it small, well under 40% of the screen.
 */
export function MonthlyStrip({ source, compact = false }: { source: StripSource; compact?: boolean }) {
  const { strip } = source;
  const shaped = useMemo(() => shapeStrip(strip, W, new Date(), compact), [strip, compact]);
  const [focus, setFocus] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const month = focus ?? shaped.current;
  const H = shaped.height + INITIALS_ROOM;
  const pick = (m: number) => setFocus(Math.min(11, Math.max(0, m)));
  const onPointer = (e: PointerEvent<SVGSVGElement>) => {
    if (e.type === "pointermove" && e.buttons !== 1) return;
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    pick(Math.floor(((e.clientX - rect.left) / rect.width) * 12));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    pick(month + (e.key === "ArrowRight" ? 1 : -1));
  };
  const legends = legendLines(strip);
  const focused = shaped.columns[month];
  return (
    <div data-testid="monthly-strip" className={compact ? "" : "px-5 pt-3 pb-3"}>
      <div className="flex items-baseline justify-between gap-2 text-[11px] leading-4">
        <span className="small-caps min-w-0 truncate" title={strip.source ? `${strip.place} · ${strip.source}` : strip.place}>
          The year at {strip.place}
        </span>
        <span className="shrink-0 text-ink-muted tabular-nums">{strip.period}</span>
      </div>
      <p className="mt-0.5 truncate text-[12px] leading-4 text-ink tabular-nums" data-testid="monthly-strip-month">
        {monthLine(strip, month)}
      </p>
      <svg
        ref={ref}
        role="slider"
        tabIndex={0}
        aria-label={`Months at ${strip.place}: tap a month to read its values`}
        aria-valuemin={0}
        aria-valuemax={11}
        aria-valuenow={month}
        aria-valuetext={monthLine(strip, month)}
        viewBox={`0 0 ${W} ${H}`}
        onPointerDown={onPointer}
        onPointerMove={onPointer}
        onKeyDown={onKey}
        className="mt-1 block w-full cursor-pointer touch-none select-none"
      >
        {focus !== null && focus !== shaped.current && <rect x={focused.x} y={0} width={focused.width} height={shaped.height} className="month-focus" />}
        {shaped.rows.map((r) => {
          if (r.kind === "band") {
            return (
              <g key={r.row.key}>
                <path d={r.path} className="month-band" />
                <path d={r.high} className="month-band-edge" strokeWidth="1" fill="none" />
                <path d={r.low} className="month-band-edge" strokeWidth="1" fill="none" />
                {r.peak && (
                  <text x={r.peak.x} y={r.peak.y} textAnchor="middle" className="month-label">
                    {r.peak.text}
                  </text>
                )}
                {r.trough && (
                  <text x={r.trough.x} y={r.trough.y} textAnchor="middle" className="month-label">
                    {r.trough.text}
                  </text>
                )}
              </g>
            );
          }
          if (r.kind === "bars") {
            return (
              <g key={r.row.key}>
                {r.bars.map((b) => (
                  <rect key={b.month} x={b.x} y={b.y} width={b.width} height={b.height} rx={1} className="month-bar" />
                ))}
                {r.peak && (
                  <text x={r.peak.x} y={r.peak.y} textAnchor="middle" className="month-label">
                    {r.peak.text}
                  </text>
                )}
              </g>
            );
          }
          const tone = /^snow/.test(r.row.key) ? "month-cell-snow" : "month-cell-green";
          return (
            <g key={r.row.key}>
              {r.cells.map((c) => (
                <rect key={c.month} x={c.x} y={r.top} width={c.width} height={r.height} rx={1.5} className="month-cell-empty" />
              ))}
              {r.cells.map((c) =>
                c.alpha > 0 ? <rect key={`v${c.month}`} x={c.x} y={r.top} width={c.width} height={r.height} rx={1.5} className={tone} fillOpacity={0.15 + 0.75 * c.alpha} /> : null,
              )}
            </g>
          );
        })}
        {shaped.mark && <line x1={shaped.mark.x} x2={shaped.mark.x} y1={0} y2={shaped.height} className="month-mark" strokeWidth="1" />}
        <line x1={shaped.playheadX} x2={shaped.playheadX} y1={0} y2={shaped.height + 2} className="month-head" strokeWidth="1.5" />
        {shaped.columns.map((c) => (
          <text key={c.month} x={c.center} y={H - 1} textAnchor="middle" className={c.month === shaped.current ? "month-initial month-initial-now" : "month-initial"}>
            {MONTH_INITIALS[c.month]}
          </text>
        ))}
      </svg>
      {compact ? (
        <p className="mt-0.5 line-clamp-2 text-[10px] leading-[13px] text-ink-muted">{legends.join(" · ")}</p>
      ) : (
        <ul className="mt-1 space-y-0.5 text-[10.5px] leading-[14px] text-ink-muted">
          {legends.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The data console's slot: the strip of the top shown layer with monthly values, with its hairline; nothing otherwise. */
export function MonthlyStripSlot({ state }: { state: Pick<MapState, "layers" | "renderOps"> }) {
  const source = stripSource(state);
  if (!source) return null;
  return (
    <>
      <MonthlyStrip key={`${source.layerId}:${source.strip.place}`} source={source} />
      <div aria-hidden className="hairline mx-5" />
    </>
  );
}

/** Phones with the console closed: the strip in the time dock's place above the chat, small. */
export function PhoneMonthDock({ state }: { state: Pick<MapState, "layers" | "renderOps"> }) {
  const source = stripSource(state);
  if (!source) return null;
  return (
    <div data-testid="phone-month-dock" className="glass-strong rise-in pointer-events-auto rounded-[12px] px-2.5 py-1.5">
      <MonthlyStrip key={`${source.layerId}:${source.strip.place}`} source={source} compact />
    </div>
  );
}
