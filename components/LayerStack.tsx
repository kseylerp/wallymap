"use client";

import { useId, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import type { LayerCatalog } from "@/lib/agent/applyToolResult";
import { TILE_SWATCH } from "@/lib/render/palette";
import type { LoadedLayer, MapAction, MapState, RenderMode, RenderOp } from "@/lib/render/state";
import { LAYER_PANEL_WIDTH } from "@/lib/render/viewportPadding";
import { legendSymbol, type LegendMode, type LegendSymbol } from "@/lib/render/wally/legend";

type LayerStackProps = {
  layers: MapState["layers"];
  renderOps: RenderOp[];
  catalog: LayerCatalog | null;
  dispatch: (action: MapAction) => void;
  /** Whether the panel shows; the layers map pill (MapPills) opens and closes it. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The layer holding the selected feature; its row gets the ink selection rule. */
  selectedLayerId?: string;
};

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

const MODES: { value: RenderMode; label: string; ready: boolean }[] = [
  { value: "points", label: "Points", ready: true },
  { value: "lines", label: "Lines", ready: true },
  { value: "polygons", label: "Polygons", ready: true },
  { value: "heat", label: "Heat", ready: true },
  { value: "columns", label: "Columns (Milestone 3)", ready: false },
  { value: "hexbin", label: "Hexbin (Milestone 3)", ready: false },
];

/**
 * The color the map actually draws: a valid render-op color, else the style color. Raster tiles carry their own
 * imagery colors, so they read as a neutral gray. (The inspect card uses it; the panel shows no colors.)
 */
export function drawnColor(layer: LoadedLayer, op: RenderOp | undefined): string {
  if (op?.color && HEX.test(op.color.trim())) return op.color;
  if (layer.result.kind === "tiles" && layer.result.data.format === "raster") return TILE_SWATCH;
  return layer.style.color;
}

/** Loaded layers top first (the last render op draws on top), then any layer still waiting for an op. */
function stackOrder(layers: MapState["layers"], renderOps: RenderOp[]): { layer: LoadedLayer; op?: RenderOp }[] {
  const withOps = renderOps
    .map((op) => ({ layer: layers[op.layerId], op }))
    .filter((item): item is { layer: LoadedLayer; op: RenderOp } => item.layer !== undefined)
    .reverse();
  const rest = Object.values(layers)
    .filter((layer) => !renderOps.some((op) => op.layerId === layer.id))
    .map((layer) => ({ layer }));
  return [...withOps, ...rest];
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** How the map draws a layer, for its legend key: raster tiles hatch, vector tiles by geometry, geojson by mode. */
function legendModeFor(layer: LoadedLayer, op: RenderOp | undefined): LegendMode {
  if (layer.result.kind === "tiles") {
    if (layer.result.data.format === "raster") return "tiles";
    const geometry = layer.result.data.geometry ?? layer.style.geometry;
    return geometry === "polygon" ? "polygons" : geometry === "line" ? "lines" : "points";
  }
  if (op) return op.mode;
  return layer.style.geometry === "polygon" ? "polygons" : layer.style.geometry === "line" ? "lines" : "points";
}

/** Dash lengths in the legend sample, per line width of deck's [dash, gap]: short enough to show the rhythm in 22px. */
const DASH_SCALE = 1.5;
/** Five gray steps, light to dark, matching the score ramp's alpha range on the map. */
const RAMP_STEPS = [0.1, 0.25, 0.4, 0.55, 0.7];

/**
 * The legend key: a 24px inline SVG in `currentColor` (ink) and white, drawn the way the map draws the layer. The
 * point key is the layer's own sprite.
 */
function LegendKey({ symbol }: { symbol: LegendSymbol }) {
  const hatchId = `hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg viewBox="0 0 24 24" width={24} height={24} aria-hidden className="legend-key block shrink-0" data-kind={symbol.kind}>
      {symbol.kind === "symbol" && symbol.spriteUrl && <image href={symbol.spriteUrl} x={0} y={0} width={24} height={24} />}
      {symbol.kind === "line" && (
        <>
          <line x1={1} y1={12} x2={23} y2={12} stroke="currentColor" strokeWidth={3.5} />
          <line
            x1={1}
            y1={12}
            x2={23}
            y2={12}
            stroke="white"
            strokeWidth={2}
            strokeDasharray={
              symbol.dash && symbol.dash[0] > 0 ? `${symbol.dash[0] * DASH_SCALE} ${symbol.dash[1] * DASH_SCALE}` : undefined
            }
          />
        </>
      )}
      {symbol.kind === "polygon" && (
        <rect x={4.5} y={4.5} width={15} height={15} fill="currentColor" fillOpacity={0.1} stroke="currentColor" strokeWidth={1} />
      )}
      {symbol.kind === "score" && (
        <>
          {RAMP_STEPS.map((alpha, i) => (
            <rect key={alpha} x={2 + i * 4} y={8} width={4} height={8} fill="currentColor" fillOpacity={alpha} />
          ))}
          <rect x={2.25} y={8.25} width={19.5} height={7.5} fill="none" stroke="currentColor" strokeOpacity={0.35} strokeWidth={0.5} />
        </>
      )}
      {symbol.kind === "tiles" && (
        <>
          <defs>
            <pattern id={hatchId} width={3} height={3} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1={0} y1={0} x2={0} y2={3} stroke="currentColor" strokeWidth={0.75} />
            </pattern>
          </defs>
          <rect x={4.5} y={4.5} width={15} height={15} fill={`url(#${hatchId})`} stroke="currentColor" strokeWidth={1} />
        </>
      )}
    </svg>
  );
}

type RowProps = {
  layer: LoadedLayer;
  op: RenderOp | undefined;
  license: string | undefined;
  dispatch: (action: MapAction) => void;
  onMove: (delta: 1 | -1) => void;
  dragProps: {
    draggable: boolean;
    onDragStart: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
    onDragEnd: () => void;
  };
  armDrag: (armed: boolean) => void;
  dropTarget: boolean;
  dragging: boolean;
  selected: boolean;
};

/**
 * One legend row: the key (also the drag handle), the title over a muted line of coverage, license and source, the
 * feature count in tabular figures, and (on hover or focus) visibility, opacity, mode and remove.
 */
function LegendRow({ layer, op, license, dispatch, onMove, dragProps, armDrag, dropTarget, dragging, selected }: RowProps) {
  const visible = op?.visible ?? false;
  const opacity = op?.opacity ?? 1;
  const count = layer.result.kind === "geojson" ? layer.result.data.features.length : null;
  const { citation, coverageNote } = layer.result;
  const host = hostOf(citation.url);
  const symbol = legendSymbol(layer.id, legendModeFor(layer, op), layer.style.unit);

  const gripRef = useRef<HTMLButtonElement>(null);
  const onHandleKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    onMove(e.key === "ArrowUp" ? 1 : -1);
    // React moves the row's node to its new place, which drops focus; put it back so repeated presses work.
    requestAnimationFrame(() => gripRef.current?.focus());
  };

  return (
    <li
      data-testid="layer-card"
      data-layer-id={layer.id}
      data-selected={selected || undefined}
      data-hidden={!visible || undefined}
      data-drop-target={dropTarget || undefined}
      {...dragProps}
      className={`legend-row relative py-2.5 transition-opacity duration-150 ${dragging ? "opacity-40" : ""}`}
    >
      <div className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-start gap-x-3">
        <button
          type="button"
          ref={gripRef}
          aria-label={`Reorder ${layer.title} (arrow keys)`}
          title="Drag to reorder"
          disabled={!op}
          onPointerDown={() => armDrag(true)}
          onPointerUp={() => armDrag(false)}
          onKeyDown={onHandleKey}
          className="-my-[3px] flex h-6 w-6 cursor-grab items-center justify-center rounded-[4px] text-ink active:cursor-grabbing disabled:cursor-default"
        >
          <LegendKey symbol={symbol} />
        </button>
        <div className="min-w-0">
          <p className={`truncate text-[13px] leading-[18px] ${visible ? "text-ink" : "text-ink-muted"}`} title={layer.title}>
            {layer.title}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-4 text-ink-muted">
            {coverageNote && (
              <>
                <span title={coverageNote}>{coverageNote}</span>
                {" · "}
              </>
            )}
            {license && <span title={license}>{license} · </span>}
            <a href={citation.url} target="_blank" rel="noreferrer" title={citation.source} className="dashed-link whitespace-nowrap">
              {host ?? citation.source}
            </a>
          </p>
        </div>
        {count !== null ? (
          <span
            className="text-right text-[12px] leading-[18px] text-ink tabular-nums"
            title={`${count.toLocaleString()} ${count === 1 ? "feature" : "features"}`}
          >
            {count.toLocaleString()}
          </span>
        ) : (
          <span className="small-caps text-right leading-[18px]">tiles</span>
        )}
      </div>

      <div className="legend-controls">
        <div className="flex items-center gap-2.5 pt-2 pl-9">
          <button
            type="button"
            onClick={() => dispatch({ type: "toggle_layer", layerId: layer.id })}
            disabled={!op}
            aria-pressed={visible}
            aria-label={`Show ${layer.title}`}
            title={visible ? "Hide layer" : "Show layer"}
            className="legend-check"
          />
          {op && (
            <label className="flex items-center gap-1.5">
              <span className="sr-only">Opacity for {layer.title}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={opacity}
                onChange={(e) => dispatch({ type: "set_opacity", layerId: layer.id, opacity: Number(e.target.value) })}
                className="layer-opacity w-[60px]"
                style={{ ["--fill" as string]: `${Math.round(opacity * 100)}%` }}
              />
              <span aria-hidden className="w-7 text-right text-[11px] text-ink-muted tabular-nums">
                {Math.round(opacity * 100)}%
              </span>
            </label>
          )}
          {op && layer.result.kind === "geojson" && (
            <label>
              <span className="sr-only">Draw {layer.title} as</span>
              <select
                value={op.mode}
                onChange={(e) => dispatch({ type: "set_style", layerId: layer.id, mode: e.target.value as RenderMode })}
                className="legend-select"
              >
                {MODES.map((m) => (
                  <option key={m.value} value={m.value} disabled={!m.ready} title={m.ready ? undefined : "Milestone 3"}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            onClick={() => dispatch({ type: "remove_layer", layerId: layer.id })}
            aria-label={`Remove ${layer.title}`}
            title="Remove layer"
            className="ml-auto px-1 text-[15px] leading-none text-ink-muted transition-colors hover:text-ink"
          >
            ×
          </button>
        </div>
      </div>
    </li>
  );
}

/** Quiet text buttons in the panel header. */
const TEXT_BUTTON = "text-[12px] text-ink-muted transition-colors duration-150 hover:text-ink";

/**
 * The layer panel, a research legend: one row per loaded layer, top first, with its monochrome key, title, source
 * and count; visibility, opacity, render mode and removal on hover or focus; drag (or arrow keys on the key) to
 * reorder. The top slot holds the time scrubber when one is mounted. Closed, it renders nothing: the layers map pill
 * reopens it.
 */
export function LayerStack({ layers, renderOps, catalog, dispatch, open, onOpenChange, selectedLayerId }: LayerStackProps) {
  const items = stackOrder(layers, renderOps);
  const [armed, setArmed] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  if (items.length === 0) return null;

  const moveTo = (layerId: string, targetId: string) => {
    const toIndex = renderOps.findIndex((op) => op.layerId === targetId);
    if (toIndex !== -1 && layerId !== targetId) dispatch({ type: "reorder", layerId, toIndex });
  };

  if (!open) return null;

  return (
    <section
      aria-label="Layers"
      data-testid="layer-stack"
      // Phones: below the header row (wordmark and basemap switch) instead of over it.
      className="glass-strong rise-in pointer-events-auto flex max-h-[calc(100dvh-24px)] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-panel max-md:mt-12 max-md:max-h-[calc(54dvh-72px)] md:max-h-[calc(100dvh-260px)]"
      style={{ width: LAYER_PANEL_WIDTH }}
    >
      {/* The time scrubber mounts here (Task 7); empty, it takes no space. */}
      <div data-slot="time-scrubber" className="shrink-0 empty:hidden" />
      <header className="flex shrink-0 items-baseline gap-3 px-5 pt-4 pb-1.5">
        <h2 className="small-caps">
          Layers <span className="ml-1 text-ink tabular-nums">{items.length}</span>
        </h2>
        <span className="flex-1" />
        <button type="button" onClick={() => dispatch({ type: "clear_layers" })} className={TEXT_BUTTON}>
          Clear all
        </button>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-expanded
          aria-label="Collapse layers"
          title="Collapse"
          className={TEXT_BUTTON}
        >
          Hide
        </button>
      </header>
      <div aria-hidden className="hairline mx-5 shrink-0" />
      <ul className="legend-table min-h-0 overflow-y-auto overscroll-contain px-5 pb-2">
        {items.map(({ layer, op }) => {
          const index = renderOps.findIndex((o) => o.layerId === layer.id);
          return (
            <LegendRow
              key={layer.id}
              layer={layer}
              op={op}
              license={catalog?.[layer.id]?.license}
              dispatch={dispatch}
              onMove={(delta) => {
                if (index !== -1) dispatch({ type: "reorder", layerId: layer.id, toIndex: index + delta });
              }}
              armDrag={(on) => setArmed(on ? layer.id : null)}
              dropTarget={overId === layer.id && dragId !== null && dragId !== layer.id}
              dragging={dragId === layer.id}
              selected={selectedLayerId === layer.id}
              dragProps={{
                // Only the key starts a drag, so the slider and text stay usable.
                draggable: armed === layer.id,
                onDragStart: (e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", layer.id);
                  setDragId(layer.id);
                },
                onDragOver: (e) => {
                  if (!dragId || !op) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (overId !== layer.id) setOverId(layer.id);
                },
                onDrop: (e) => {
                  e.preventDefault();
                  if (dragId) moveTo(dragId, layer.id);
                  setDragId(null);
                  setOverId(null);
                  setArmed(null);
                },
                onDragEnd: () => {
                  setDragId(null);
                  setOverId(null);
                  setArmed(null);
                },
              }}
            />
          );
        })}
      </ul>
    </section>
  );
}
