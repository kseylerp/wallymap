"use client";

import type { LegendBlock, LegendEntry } from "@/lib/render/legendView";
import { DARK_GREY, LINE, WHITE } from "@/lib/render/palette";

/** One category's swatch, drawn as the map draws the layer: a disc on a halo, a line on its casing, or a tinted square. */
export function Swatch({ color, shape, outline = false, dash, twoTone = false }: { color?: string; shape: LegendBlock["shape"]; outline?: boolean; dash?: [number, number]; twoTone?: boolean }) {
  const c = color ?? DARK_GREY;
  if (shape === "line") {
    const dashed = dash && dash[0] > 0;
    return (
      <svg aria-hidden viewBox="0 0 22 6" width={22} height={6} className="shrink-0">
        <line x1={1} y1={3} x2={21} y2={3} stroke={WHITE} strokeWidth={LINE.casing} strokeLinecap="round" />
        <line x1={1} y1={3} x2={21} y2={3} stroke={c} strokeWidth={dashed && dash[0] <= 2 ? 1.25 : LINE.width} strokeLinecap="butt" strokeDasharray={dashed ? `${dash[0]} ${dash[1]}` : undefined} />
        {/* A sage level draws with dark grey dashes over it on the map (lib/render/nativeLines.ts), so its key does too. */}
        {twoTone && !dashed && <line x1={1} y1={3} x2={21} y2={3} stroke={DARK_GREY} strokeWidth={LINE.width} strokeLinecap="butt" strokeDasharray="4 4" />}
      </svg>
    );
  }
  if (shape === "polygon" || shape === "raster") {
    return (
      <svg aria-hidden viewBox="0 0 14 10" width={14} height={10} className="shrink-0">
        <rect x={1} y={1} width={12} height={8} rx={1} fill={c} fillOpacity={outline ? 0 : shape === "raster" ? 0.85 : 0.7} stroke={c} strokeWidth={1.25} />
      </svg>
    );
  }
  return (
    <svg aria-hidden viewBox="0 0 10 10" width={10} height={10} className="shrink-0">
      <circle cx={5} cy={5} r={4} fill={c} stroke={DARK_GREY} strokeWidth={1} />
    </svg>
  );
}

function Entry({ entry, shape, filter }: { entry: LegendEntry; shape: LegendBlock["shape"]; filter?: string }) {
  return (
    <li className="flex min-w-0 items-center gap-1.5" title={entry.help}>
      <span className="flex shrink-0" style={filter ? { filter } : undefined}>
        <Swatch color={entry.color} shape={shape} outline={entry.outline} dash={entry.dash} twoTone={entry.twoTone} />
      </span>
      <span className="min-w-0 truncate">{entry.label}</span>
      {entry.count !== undefined && <span className="shrink-0 text-ink-muted tabular-nums">{entry.count.toLocaleString("en-US")}</span>}
      {entry.count === undefined && entry.share !== undefined && (
        <span className="shrink-0 text-ink-muted tabular-nums" title="Share of the map in view">
          {entry.share < 0.01 ? "<1%" : `${Math.round(entry.share * 100)}%`}
        </span>
      )}
    </li>
  );
}

/** A block's heading: its title and unit, small and muted. */
function Title({ block }: { block: LegendBlock }) {
  if (!block.title) return null;
  return (
    <p className="text-[11px] leading-4 text-ink-muted">
      {block.title}
      {block.unit && block.kind !== "size" ? ` (${block.unit})` : ""}
    </p>
  );
}

/**
 * A layer's legend (lib/render/legendView.ts): category swatches with labels and counts, a ramp's gradient with its
 * stops, a size key from small to large, one swatch with a note, or the source's legend image. `compact` (the phone's
 * mini legend) keeps the first block on one line.
 */
/** The phone's short key: the `n` kinds with the most features on the map, in the key's own order. */
function mostDrawn(entries: LegendBlock["entries"], n: number): LegendBlock["entries"] {
  if (entries.length <= n) return entries;
  // No counts (tiles): the ends and evenly spaced kinds between, so a 19-zone key reads 3a … 12a, not 3a to 4b.
  const size = (e: LegendBlock["entries"][number]) => e.count ?? e.share;
  if (!entries.some((e) => size(e) !== undefined)) return Array.from({ length: n }, (_, i) => entries[Math.round((i * (entries.length - 1)) / (n - 1))]);
  const keep = new Set([...entries].sort((x, y) => (size(y) ?? 0) - (size(x) ?? 0)).slice(0, n));
  return entries.filter((e) => keep.has(e));
}

export function RowLegend({ blocks, compact = false }: { blocks: LegendBlock[]; compact?: boolean }) {
  if (blocks.length === 0) return null;
  const shown = compact ? blocks.slice(0, 2) : blocks;
  return (
    <div data-testid="row-legend" className={compact ? "min-w-0 text-[11px] leading-4 text-ink" : "mt-1.5 space-y-1.5 text-[11.5px] leading-4 text-ink"}>
      {shown.map((block, k) => (
        <div key={k} data-legend-kind={block.kind} className="min-w-0">
          {!compact && <Title block={block} />}
          {block.kind === "categories" && (
            <ul className={compact ? "flex min-w-0 flex-wrap gap-x-2.5 gap-y-0.5" : "flex flex-wrap gap-x-3 gap-y-0.5"}>
              {(compact ? mostDrawn(block.entries, 4) : block.entries).map((e, i) => (
                <Entry key={`${e.label}-${i}`} entry={e} shape={block.shape} filter={block.filter} />
              ))}
            </ul>
          )}
          {block.kind === "ramp" && (
            <div className={compact ? "max-w-[260px]" : undefined}>
              {compact && block.title && <p className="truncate text-ink-muted">{block.title}</p>}
              <div className="relative">
                <div
                  aria-hidden
                  className="h-2 rounded-[2px] border border-line"
                  style={{ background: `linear-gradient(to right, ${(block.colors ?? []).join(", ")})`, ...(block.filter && { filter: block.filter }) }}
                />
                {block.range && (
                  // The values in view, bracketed on the fixed scale.
                  <div
                    aria-hidden
                    data-testid="legend-range"
                    className="absolute -top-[3px] h-[14px] rounded-[2px] border-[1.5px] border-ink"
                    style={{ left: `${(block.range.from * 100).toFixed(1)}%`, width: `max(4px, ${((block.range.to - block.range.from) * 100).toFixed(1)}%)` }}
                  />
                )}
              </div>
              {/* End labels wrap (up to three lines) rather than cut: "Sink: takes up carbon" is the key's meaning. */}
              <div className="mt-0.5 flex justify-between gap-2 text-[10.5px] leading-[13px] text-ink-muted tabular-nums">
                {(block.entries.length > 3 ? [block.entries[0], block.entries[Math.floor(block.entries.length / 2)], block.entries[block.entries.length - 1]] : block.entries).map((e, i, shown) => (
                  <span
                    key={`${e.label}-${i}`}
                    className={`line-clamp-3 min-w-0 flex-1 break-words ${i === 0 ? "text-left" : i === shown.length - 1 ? "text-right" : "text-center"}`}
                  >
                    {e.label.replace(/^Lower\b.*/, "Low").replace(/^Higher\b.*/, "High")}
                  </span>
                ))}
              </div>
              {block.range && (
                <p className="mt-0.5 truncate text-[10.5px] leading-[13px] text-ink tabular-nums" data-testid="legend-range-text">
                  {block.range.text}
                </p>
              )}
            </div>
          )}
          {block.kind === "size" && (
            <p className="flex min-w-0 items-center gap-1.5">
              {block.shape === "polygon" ? (
                <svg aria-hidden viewBox="0 0 30 12" width={30} height={12} className="shrink-0">
                  {[0, 1].map((k) => (
                    <g key={k}>
                      <rect x={1 + k * 16} y={1} width={12} height={10} fill="none" stroke={DARK_GREY} strokeWidth={1} />
                      {Array.from({ length: k ? 6 : 2 }, (_, i) => {
                        const step = k ? 4 : 10;
                        const x = 1 + k * 16 + i * step;
                        return <line key={i} x1={x} y1={11} x2={x + 10} y2={1} stroke={DARK_GREY} strokeWidth={0.75} />;
                      })}
                    </g>
                  ))}
                </svg>
              ) : (
                <svg aria-hidden viewBox="0 0 34 14" width={34} height={14} className="shrink-0">
                  {[2.5, 4.5, 6.5].map((r, i) => (
                    <circle key={r} cx={4 + i * 10 + (i ? 2 : 0)} cy={7} r={r} fill="none" stroke={DARK_GREY} strokeWidth={1} />
                  ))}
                </svg>
              )}
              <span className="min-w-0 truncate">
                {block.shape === "polygon" ? `Denser hatch, larger ${(block.title ?? "value").toLowerCase()}: ` : compact && block.title ? `${block.title}: ` : "Size: "}
                {block.entries.map((e) => e.label).join(" to ")}
              </span>
            </p>
          )}
          {block.kind === "symbol" && block.note && <p className={compact ? "truncate" : "line-clamp-3 text-ink-muted"}>{block.note}</p>}
          {block.kind === "image" && block.imageUrl && (
            // A legend image the tile service publishes (a key we cannot redraw); decorative beside its title.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={block.imageUrl} alt={block.title ? `${block.title} legend` : "Legend"} className="max-h-24 max-w-full" loading="lazy" />
          )}
          {block.kind !== "symbol" && block.note && !compact && <p className="mt-0.5 text-ink-muted">{block.note}</p>}
        </div>
      ))}
    </div>
  );
}
