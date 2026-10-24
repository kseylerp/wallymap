"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Series } from "@/lib/render/wally/sample";

/**
 * Wally's elevation profile (spec §6, `ElevationProfileChart`): a 2px purple→coral line, 180px tall, with a cursor
 * at the preview position. On the off-white surface the grid is ink at 10% (Wally's dark chart uses white at 15%).
 * The part already ridden is drawn bright and the rest dim, as on the map. Up to three dashed dark grey series plot
 * visible layers' values along the route, each scaled to its own range. Dragging on the chart scrubs.
 */

export type Units = "mi" | "km";

/** A stretch of the line drawn in pink with its label (the cross-section's steepest 100 m: "80° · 544%"). */
export type ProfileHighlight = { fromM: number; toM: number; label: string };
/** A labelled point on the line (the start and the top with their elevations). */
export type ProfileMark = { distanceM: number; label: string };

type ElevationProfileProps = {
  distancesM: number[];
  /** Meters, aligned with `distancesM`; null where terrain has not loaded yet. */
  elevations: (number | null)[];
  series?: Series[];
  fraction: number;
  units: Units;
  height?: number;
  onScrub?: (fraction: number) => void;
  /**
   * The cross-section's options (components/CrossSection.tsx): a pointer moving over the chart scrubs without a press
   * (`hover`), and `onLeave` says when it left; `cursor` false hides the cursor; `progress` false draws the whole line
   * bright (no part "already ridden"); `solid` draws the line purple instead of the route gradient, so the pink
   * highlight reads; `highlight` and `marks` label it; `exaggeration` states the vertical exaggeration it is drawn at.
   */
  hover?: boolean;
  onLeave?: () => void;
  cursor?: boolean;
  progress?: boolean;
  solid?: boolean;
  highlight?: ProfileHighlight;
  marks?: ProfileMark[];
  exaggeration?: boolean;
};

/** How many times steeper the chart draws the ground than it is: plot height per metre over plot width per metre. */
export function chartExaggeration(totalM: number, spanM: number, plotW: number, plotH: number): number {
  if (!(totalM > 0) || !(spanM > 0) || !(plotW > 0)) return 1;
  const ve = plotH / spanM / (plotW / totalM);
  return ve >= 2 ? Math.round(ve) : Math.round(ve * 10) / 10;
}

const M_PER_MI = 1609.344;
const FT_PER_M = 3.28084;
const PAD = { left: 40, right: 10, top: 14, bottom: 20 };
/** Secondary series: dark grey (ink at 60%) told apart by dash pattern (owner palette, spec §2). */
const SERIES_STYLE = [
  { color: "var(--ink)", dash: "4 3" },
  { color: "var(--ink)", dash: "1 3" },
  { color: "var(--ink)", dash: "6 2" },
];

/** A round step (1, 2 or 5 times a power of ten) giving about `count` intervals over `range`. */
export function niceStep(range: number, count: number): number {
  if (!(range > 0)) return 1;
  const raw = range / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

const fmt = (n: number, digits = 0) => n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });

/** The value at distance `d`, interpolated between the nearest known samples on either side. */
export function valueAt(distancesM: number[], values: (number | null)[], d: number): number | null {
  let i = 0;
  while (i < distancesM.length - 1 && distancesM[i + 1] < d) i++;
  let a = i;
  while (a >= 0 && values[a] === null) a--;
  let b = i + 1;
  while (b < values.length && values[b] === null) b++;
  const va = a >= 0 ? values[a] : null;
  const vb = b < values.length ? values[b] : null;
  if (va === null || va === undefined) return vb ?? null;
  if (vb === null || vb === undefined) return va;
  const span = distancesM[b] - distancesM[a];
  return span > 0 ? va + ((vb - va) * (d - distancesM[a])) / span : va;
}

/** An SVG path through the known points, broken where a value is missing. */
function pathFor(xs: number[], ys: (number | null)[]): string {
  let d = "";
  let pen = false;
  ys.forEach((y, i) => {
    if (y === null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${xs[i].toFixed(1)} ${y.toFixed(1)}`;
    pen = true;
  });
  return d;
}

export function ElevationProfile({
  distancesM,
  elevations,
  series = [],
  fraction,
  units,
  height = 180,
  onScrub,
  hover = false,
  onLeave,
  cursor = true,
  progress = true,
  solid = false,
  highlight,
  marks = [],
  exaggeration = false,
}: ElevationProfileProps) {
  const id = useId().replace(/:/g, "");
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(360);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0) setWidth(el.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const total = distancesM[distancesM.length - 1] ?? 0;
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const toUnit = units === "mi" ? 1 / M_PER_MI : 1 / 1000;
  const elevUnit = units === "mi" ? "ft" : "m";
  const elevScale = units === "mi" ? FT_PER_M : 1;

  const chart = useMemo(() => {
    const known = elevations.filter((e): e is number => e !== null).map((e) => e * elevScale);
    const hasData = known.length > 1;
    let lo = hasData ? Math.min(...known) : 0;
    let hi = hasData ? Math.max(...known) : 100;
    // Flat routes still get a little relief so the line does not sit on a grid line.
    const minSpan = units === "mi" ? 60 : 20;
    if (hi - lo < minSpan) {
      const mid = (hi + lo) / 2;
      lo = mid - minSpan / 2;
      hi = mid + minSpan / 2;
    }
    const yStep = niceStep(hi - lo, 3);
    const yMin = Math.floor(lo / yStep) * yStep;
    const yMax = Math.ceil(hi / yStep) * yStep;
    const y = (v: number) => PAD.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;
    const x = (d: number) => PAD.left + (total > 0 ? (d / total) * plotW : 0);
    const xs = distancesM.map(x);
    const ys = elevations.map((e) => (e === null ? null : y(e * elevScale)));
    const line = pathFor(xs, ys);
    const firstKnown = ys.findIndex((v) => v !== null);
    const lastKnown = ys.findLastIndex((v) => v !== null);
    const area =
      hasData && firstKnown >= 0
        ? `${line}L${xs[lastKnown].toFixed(1)} ${PAD.top + plotH}L${xs[firstKnown].toFixed(1)} ${PAD.top + plotH}Z`
        : "";
    const yTicks: number[] = [];
    for (let v = yMin; v <= yMax + 1e-9; v += yStep) yTicks.push(v);
    const totalUnits = total * toUnit;
    const xStep = niceStep(totalUnits, Math.max(2, Math.floor(plotW / 70)));
    const xTicks: number[] = [];
    for (let v = 0; v <= totalUnits + 1e-9; v += xStep) xTicks.push(v);
    const seriesPaths = series.slice(0, 3).map((s) => {
      const vals = s.values.filter((v): v is number => v !== null);
      const sLo = Math.min(...vals);
      const sHi = Math.max(...vals);
      // Each series uses the middle 70% of the plot, scaled to its own range (a flat series sits mid-height).
      const sy = (v: number) => PAD.top + plotH * (0.85 - (sHi > sLo ? ((v - sLo) / (sHi - sLo)) * 0.7 : 0.35));
      return pathFor(xs, s.values.map((v) => (v === null ? null : sy(v))));
    });
    // The highlighted stretch, drawn over the line; the exaggeration, from the axis span in metres.
    const inStretch = highlight ? ys.map((v, i) => (distancesM[i] >= highlight.fromM && distancesM[i] <= highlight.toM ? v : null)) : null;
    const stretch = inStretch ? pathFor(xs, inStretch) : "";
    const ve = chartExaggeration(total, (yMax - yMin) / elevScale, plotW, plotH);
    return { hasData, y, x, line, area, yTicks, xTicks, seriesPaths, stretch, ve };
  }, [distancesM, elevations, series, elevScale, units, plotH, plotW, total, toUnit, highlight]);

  const f = Math.min(1, Math.max(0, fraction));
  const cursorX = PAD.left + f * plotW;
  const doneX = progress ? cursorX : width;
  const lineStroke = solid ? "var(--accent)" : `url(#${id}-line)`;
  /** A labelled point's position, its label kept inside the plot. */
  const markAt = (distanceM: number) => {
    const v = valueAt(distancesM, elevations, distanceM);
    if (v === null) return null;
    return { x: chart.x(distanceM), y: chart.y(v * elevScale) };
  };
  const highlightAt = highlight ? markAt((highlight.fromM + highlight.toM) / 2) : null;
  const here = valueAt(distancesM, elevations, f * total);
  const cursorY = here === null ? null : chart.y(here * elevScale);
  const readout = here === null ? null : `${fmt(here * elevScale)} ${elevUnit}`;

  const scrubFrom = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!onScrub) return;
    const rect = e.currentTarget.getBoundingClientRect();
    onScrub(Math.min(1, Math.max(0, (e.clientX - rect.left - PAD.left) / plotW)));
  };

  return (
    <div ref={boxRef} className="relative w-full">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={
          readout
            ? `Elevation profile, ${fmt(total * toUnit, 1)} ${units}; ${readout} at the cursor`
            : `Elevation profile, ${fmt(total * toUnit, 1)} ${units}; terrain loading`
        }
        className={`block select-none ${onScrub ? "cursor-ew-resize touch-none" : ""}`}
        onPointerDown={(e) => {
          if (!onScrub) return;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          scrubFrom(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1 || hover) scrubFrom(e);
        }}
        onPointerLeave={() => onLeave?.()}
      >
        <defs>
          <linearGradient id={`${id}-line`} gradientUnits="userSpaceOnUse" x1={PAD.left} x2={PAD.left + plotW} y1="0" y2="0">
            <stop offset="0" style={{ stopColor: "var(--accent)" }} />
            <stop offset="1" style={{ stopColor: "var(--coral)" }} />
          </linearGradient>
          <linearGradient id={`${id}-area`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" style={{ stopColor: "var(--accent)", stopOpacity: 0.12 }} />
            <stop offset="1" style={{ stopColor: "var(--accent)", stopOpacity: 0 }} />
          </linearGradient>
          <clipPath id={`${id}-done`}>
            <rect x="0" y="0" width={doneX} height={height} />
          </clipPath>
        </defs>

        {/* Grid: ink at 10% (Wally's white-at-15% grid, for an off-white surface). */}
        <g stroke="var(--ink)" strokeOpacity="0.1" strokeWidth="1" shapeRendering="crispEdges">
          {chart.yTicks.map((v) => (
            <line key={`y${v}`} x1={PAD.left} x2={PAD.left + plotW} y1={chart.y(v)} y2={chart.y(v)} />
          ))}
          {chart.xTicks.map((v) => (
            <line key={`x${v}`} x1={chart.x(v / toUnit)} x2={chart.x(v / toUnit)} y1={PAD.top} y2={PAD.top + plotH} />
          ))}
        </g>
        <g fill="var(--ink-muted)" fontSize="10" style={{ fontVariantNumeric: "tabular-nums" }}>
          {chart.yTicks.map((v) => (
            <text key={`yl${v}`} x={PAD.left - 6} y={chart.y(v) + 3} textAnchor="end">
              {fmt(v)}
            </text>
          ))}
          {chart.xTicks.map((v, i) => (
            <text
              key={`xl${v}`}
              x={chart.x(v / toUnit)}
              y={height - 5}
              textAnchor={i === 0 ? "start" : "middle"}
            >
              {i === 0 ? `0 ${units}` : fmt(v, 1)}
            </text>
          ))}
          <text x={PAD.left - 6} y={PAD.top - 4} textAnchor="end" fillOpacity="0.7">
            {elevUnit}
          </text>
        </g>

        {chart.seriesPaths.map((d, i) => (
          <path
            key={series[i].layerId}
            d={d}
            fill="none"
            stroke={SERIES_STYLE[i].color}
            strokeOpacity="0.6"
            strokeWidth="1.5"
            strokeDasharray={SERIES_STYLE[i].dash}
          />
        ))}

        {chart.hasData ? (
          <>
            <path d={chart.area} fill={`url(#${id}-area)`} clipPath={`url(#${id}-done)`} />
            <path d={chart.line} fill="none" stroke={lineStroke} strokeOpacity="0.35" strokeWidth="2" strokeLinejoin="round" />
            <path
              d={chart.line}
              fill="none"
              stroke={lineStroke}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              clipPath={`url(#${id}-done)`}
            />
            {chart.stretch && (
              <path data-testid="profile-highlight" d={chart.stretch} fill="none" stroke="var(--coral)" strokeWidth="3.5" strokeLinejoin="round" strokeLinecap="round" />
            )}
            {highlight && highlightAt && (
              <text
                x={Math.min(PAD.left + plotW, Math.max(PAD.left, highlightAt.x - 6))}
                y={Math.max(PAD.top + 9, highlightAt.y + 4)}
                textAnchor="end"
                fill="var(--coral)"
                fontSize="10.5"
                fontWeight="600"
                style={{ fontVariantNumeric: "tabular-nums", paintOrder: "stroke", stroke: "var(--paper)", strokeWidth: 3 }}
              >
                {highlight.label}
              </text>
            )}
            {marks.map((m) => {
              const p = markAt(m.distanceM);
              if (!p) return null;
              const nearEnd = p.x > PAD.left + plotW * 0.6;
              return (
                <g key={`${m.distanceM}:${m.label}`} data-testid="profile-mark">
                  <circle cx={p.x} cy={p.y} r="3" fill="var(--paper)" stroke="var(--ink)" strokeWidth="1.5" />
                  <text
                    x={p.x + (nearEnd ? -6 : 6)}
                    y={Math.max(PAD.top + 8, p.y - 6)}
                    textAnchor={nearEnd ? "end" : "start"}
                    fill="var(--ink)"
                    fontSize="10.5"
                    fontWeight="600"
                    style={{ fontVariantNumeric: "tabular-nums", paintOrder: "stroke", stroke: "var(--paper)", strokeWidth: 3 }}
                  >
                    {m.label}
                  </text>
                </g>
              );
            })}
          </>
        ) : (
          <text
            x={PAD.left + plotW / 2}
            y={PAD.top + plotH / 2}
            textAnchor="middle"
            fill="var(--ink-muted)"
            fontSize="12"
          >
            Reading terrain…
          </text>
        )}

        {exaggeration && chart.hasData && (
          <text data-testid="profile-exaggeration" x={PAD.left + plotW} y={PAD.top - 4} textAnchor="end" fill="var(--ink-muted)" fontSize="10">
            {`×${fmt(chart.ve, 1)} vertical`}
          </text>
        )}

        {/* The cursor: a hairline, the position on the line, and its height. */}
        {cursor && <line x1={cursorX} x2={cursorX} y1={PAD.top - 4} y2={PAD.top + plotH} stroke="var(--ink)" strokeOpacity="0.45" strokeWidth="1" />}
        {cursor && cursorY !== null && (
          <>
            <circle cx={cursorX} cy={cursorY} r="7" fill="var(--coral)" fillOpacity="0.2" />
            <circle cx={cursorX} cy={cursorY} r="3.5" fill="var(--paper)" stroke="var(--coral)" strokeWidth="2" />
          </>
        )}
      </svg>
      {cursor && readout && (
        <span
          aria-hidden
          data-testid="profile-readout"
          className="pointer-events-none absolute top-0 rounded-full bg-ink px-1.5 py-px text-[10.5px] font-semibold text-white tabular-nums"
          style={{
            left: Math.min(width - 60, Math.max(PAD.left, cursorX - 28)),
          }}
        >
          {readout}
        </span>
      )}
    </div>
  );
}

/** The sample closest to distance `d` (no interpolation: a layer's value is not continuous between features). */
function nearestSample(distancesM: number[], values: (number | null)[], d: number): number | null {
  let best = 0;
  for (let i = 1; i < distancesM.length; i++) if (Math.abs(distancesM[i] - d) < Math.abs(distancesM[best] - d)) best = i;
  return values[best] ?? null;
}

/** The legend for the dotted series, with each one's value at the cursor. */
export function SeriesLegend({ series, distancesM, fraction }: { series: Series[]; distancesM: number[]; fraction: number }) {
  if (series.length === 0) return null;
  const total = distancesM[distancesM.length - 1] ?? 0;
  return (
    <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-muted">
      {series.slice(0, 3).map((s, i) => {
        const v = nearestSample(distancesM, s.values, fraction * total);
        return (
          <li key={s.layerId} className="flex min-w-0 items-center gap-1.5">
            <svg aria-hidden width="16" height="4" className="shrink-0">
              <line
                x1="2"
                x2="14"
                y1="2"
                y2="2"
                stroke={SERIES_STYLE[i].color}
                strokeOpacity="0.6"
                strokeWidth="2"
                strokeDasharray={SERIES_STYLE[i].dash}
              />
            </svg>
            <span className="truncate">{s.title}</span>
            {v !== null && (
              <span className="font-medium text-ink tabular-nums">
                {fmt(v, 1)}
                {s.unit ? ` ${s.unit}` : ""}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
