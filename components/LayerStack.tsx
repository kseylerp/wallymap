"use client";

import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { ChevronUpIcon, CloseIcon, EyeIcon, EyeOffIcon, GripIcon, LayersIcon } from "@/components/icons";
import type { LayerCatalog } from "@/lib/agent/applyToolResult";
import { SLATE } from "@/lib/render/deck";
import type { LoadedLayer, MapAction, MapState, RenderMode, RenderOp } from "@/lib/render/state";
import { LAYER_PANEL_WIDTH } from "@/lib/render/viewportPadding";

type LayerStackProps = {
  layers: MapState["layers"];
  renderOps: RenderOp[];
  catalog: LayerCatalog | null;
  dispatch: (action: MapAction) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Map data colors offered in the swatch popover: satellite-safe and distinct from each other. */
export const PRESET_COLORS = ["#2F3A44", "#E0893F", "#5E7D5A", "#C2410C", "#3E7CB1", "#8E6CC9"] as const;

const MODES: { value: RenderMode; label: string; ready: boolean }[] = [
  { value: "points", label: "Points", ready: true },
  { value: "lines", label: "Lines", ready: true },
  { value: "polygons", label: "Polygons", ready: true },
  { value: "heat", label: "Heat", ready: true },
  { value: "columns", label: "Columns (Milestone 3)", ready: false },
  { value: "hexbin", label: "Hexbin (Milestone 3)", ready: false },
];

/** The color the map actually draws: a valid render-op color, else slate for points, else the style color. */
export function drawnColor(layer: LoadedLayer, op: RenderOp | undefined): string {
  if (op?.color && HEX.test(op.color.trim())) return op.color;
  return op?.mode === "points" ? SLATE : layer.style.color;
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

type SwatchProps = { color: string; title: string; disabled: boolean; onPick: (color: string) => void };

/** The color dot; clicking it opens six presets and a hex field. */
function Swatch({ color, title, disabled, onPick }: SwatchProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const commit = () => {
    const hex = draft.trim().startsWith("#") ? draft.trim() : `#${draft.trim()}`;
    if (HEX.test(hex)) {
      onPick(hex.toUpperCase());
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setDraft(color.replace(/^#/, ""));
          setOpen((o) => !o);
        }}
        aria-label={`Color for ${title}`}
        aria-expanded={open}
        title="Color"
        className="flex size-6 items-center justify-center rounded-full transition-transform hover:scale-110 disabled:opacity-40 disabled:hover:scale-100"
      >
        {/* The inset hairline keeps a white swatch (remoteness) visible on the white card. */}
        <span className="size-3.5 rounded-full shadow-chip ring-1 ring-black/20 ring-inset" style={{ backgroundColor: color }} />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={`Pick a color for ${title}`}
          className="absolute top-8 left-0 z-10 w-[188px] rounded-[12px] border border-line bg-paper p-2.5 shadow-card"
        >
          <div className="grid grid-cols-6 gap-1.5">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => {
                  onPick(c);
                  setOpen(false);
                }}
                aria-label={`Use ${c}`}
                aria-pressed={c.toLowerCase() === color.toLowerCase()}
                className="size-6 rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.15)] ring-offset-2 ring-offset-paper transition-transform hover:scale-110 aria-pressed:ring-2 aria-pressed:ring-ink"
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
          <label className="mt-2.5 flex h-8 items-center gap-1 rounded-[8px] border border-line px-2 text-[12.5px] focus-within:border-slate">
            <span aria-hidden className="text-ink-muted">
              #
            </span>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value.replace(/[^0-9a-f#]/gi, "").slice(0, 7))}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
              }}
              onBlur={commit}
              aria-label="Custom hex color"
              placeholder="2F3A44"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent font-mono text-ink uppercase outline-none placeholder:text-ink-muted/60"
            />
          </label>
        </div>
      )}
    </div>
  );
}

type CardProps = {
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
};

function LayerCard({ layer, op, license, dispatch, onMove, dragProps, armDrag, dropTarget, dragging }: CardProps) {
  const visible = op?.visible ?? false;
  const opacity = op?.opacity ?? 1;
  const count = layer.result.kind === "geojson" ? layer.result.data.features.length : null;
  const { citation, coverageNote } = layer.result;
  const host = hostOf(citation.url);

  const onHandleKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      onMove(1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      onMove(-1);
    }
  };

  return (
    <li
      data-testid="layer-card"
      data-layer-id={layer.id}
      {...dragProps}
      className={[
        "group/card relative rounded-[14px] border bg-paper/70 py-2.5 pr-2 pl-1.5 transition-[border-color,opacity,box-shadow]",
        dropTarget ? "border-slate shadow-chip" : "border-line",
        dragging ? "opacity-50" : "",
      ].join(" ")}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={`Reorder ${layer.title} (arrow keys)`}
          title="Drag to reorder"
          disabled={!op}
          onPointerDown={() => armDrag(true)}
          onPointerUp={() => armDrag(false)}
          onKeyDown={onHandleKey}
          className="flex h-7 w-5 shrink-0 cursor-grab items-center justify-center rounded-[6px] text-ink-muted/70 transition-colors hover:text-ink active:cursor-grabbing disabled:cursor-default disabled:opacity-30"
        >
          <GripIcon width={14} height={14} />
        </button>
        <Swatch
          color={drawnColor(layer, op)}
          title={layer.title}
          disabled={!op}
          onPick={(color) => dispatch({ type: "set_style", layerId: layer.id, color })}
        />
        <p className={`ml-1 min-w-0 flex-1 truncate text-[13.5px] font-medium ${visible ? "text-ink" : "text-ink-muted"}`} title={layer.title}>
          {layer.title}
        </p>
        {count !== null ? (
          // Text is --ink on the amber badge: 6.5:1 (white on amber is only 2.7:1).
          <span
            className="rounded-pill bg-accent px-1.5 py-px text-[11px] leading-4 font-semibold text-ink tabular-nums"
            title={`${count.toLocaleString()} ${count === 1 ? "feature" : "features"}`}
          >
            {count.toLocaleString()}
          </span>
        ) : (
          <span className="rounded-pill bg-mist px-1.5 py-px text-[11px] leading-4 font-medium text-ink-muted">tiles</span>
        )}
        <button
          type="button"
          onClick={() => dispatch({ type: "toggle_layer", layerId: layer.id })}
          disabled={!op}
          aria-pressed={visible}
          aria-label={`Show ${layer.title}`}
          title={visible ? "Hide layer" : "Show layer"}
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-mist hover:text-ink disabled:opacity-40"
        >
          {visible ? <EyeIcon width={16} height={16} /> : <EyeOffIcon width={16} height={16} />}
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: "remove_layer", layerId: layer.id })}
          aria-label={`Remove ${layer.title}`}
          title="Remove layer"
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-mist hover:text-ink"
        >
          <CloseIcon width={14} height={14} />
        </button>
      </div>

      <div className="mt-1 space-y-1 pl-[52px] text-[11.5px] leading-snug text-ink-muted">
        {coverageNote && <p className="line-clamp-2" title={coverageNote}>{coverageNote}</p>}
        <p className="truncate">
          {license && <span title={license}>{license} · </span>}
          <a
            href={citation.url}
            target="_blank"
            rel="noreferrer"
            title={citation.source}
            className="text-ink underline decoration-ink/25 underline-offset-2 hover:decoration-ink"
          >
            {host ?? citation.source}
          </a>
        </p>
      </div>

      {op && (
        <div className="mt-2 flex items-center gap-2 pl-[52px]">
          <label className="flex min-w-0 flex-1 items-center gap-2">
            <span className="sr-only">Opacity for {layer.title}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={opacity}
              onChange={(e) => dispatch({ type: "set_opacity", layerId: layer.id, opacity: Number(e.target.value) })}
              className="layer-opacity w-full min-w-[80px] flex-1"
              style={{ ["--fill" as string]: `${Math.round(opacity * 100)}%` }}
            />
            <span aria-hidden className="w-8 text-right text-[11px] text-ink-muted tabular-nums">
              {Math.round(opacity * 100)}%
            </span>
          </label>
          {layer.result.kind === "geojson" && (
            <label className="shrink-0">
              <span className="sr-only">Draw {layer.title} as</span>
              <select
                value={op.mode}
                onChange={(e) => dispatch({ type: "set_style", layerId: layer.id, mode: e.target.value as RenderMode })}
                className="h-7 w-[104px] rounded-pill border border-line bg-paper pl-2.5 text-[12px] text-ink outline-none focus-visible:border-slate"
              >
                {MODES.map((m) => (
                  <option key={m.value} value={m.value} disabled={!m.ready} title={m.ready ? undefined : "Milestone 3"}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The layer panel: a glass drawer on the right listing every loaded layer top first, with visibility, opacity,
 * color, render mode, removal and drag-to-reorder; it collapses to a "Layers" pill with a count.
 */
export function LayerStack({ layers, renderOps, catalog, dispatch, open, onOpenChange }: LayerStackProps) {
  const items = stackOrder(layers, renderOps);
  const [armed, setArmed] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  if (items.length === 0) return null;

  const moveTo = (layerId: string, targetId: string) => {
    const toIndex = renderOps.findIndex((op) => op.layerId === targetId);
    if (toIndex !== -1 && layerId !== targetId) dispatch({ type: "reorder", layerId, toIndex });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        aria-expanded={false}
        aria-label={`Layers, ${items.length} loaded`}
        className="glass-strong rise-in pointer-events-auto flex h-10 items-center gap-2 rounded-pill pr-2 pl-3 text-[13px] font-medium text-ink"
      >
        <LayersIcon width={16} height={16} />
        Layers
        <span className="rounded-pill bg-accent px-1.5 text-[11px] leading-5 font-semibold text-ink tabular-nums">
          {items.length}
        </span>
      </button>
    );
  }

  return (
    <section
      aria-label="Layers"
      data-testid="layer-stack"
      // Phones: below the header row (wordmark and basemap switch) instead of over it.
      className="glass-strong rise-in pointer-events-auto flex max-h-[calc(100dvh-24px)] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-[20px] max-md:mt-12 max-md:max-h-[calc(54dvh-72px)] md:max-h-[calc(100dvh-260px)]"
      style={{ width: LAYER_PANEL_WIDTH }}
    >
      <header className="flex shrink-0 items-center gap-2 pt-3 pr-2 pb-2 pl-4">
        <h2 className="font-serif text-[1.05rem] font-semibold text-ink">Layers</h2>
        <span className="text-[12px] text-ink-muted tabular-nums">{items.length}</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => dispatch({ type: "clear_layers" })}
          className="h-7 rounded-pill px-2.5 text-[12px] font-medium text-ink-muted transition-colors hover:bg-mist hover:text-ink"
        >
          Clear all
        </button>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-expanded
          aria-label="Collapse layers"
          title="Collapse"
          className="flex size-7 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-mist hover:text-ink"
        >
          <ChevronUpIcon width={16} height={16} />
        </button>
      </header>
      <ul className="flex min-h-0 flex-col gap-1.5 overflow-y-auto overscroll-contain px-2 pb-2">
        {items.map(({ layer, op }) => {
          const index = renderOps.findIndex((o) => o.layerId === layer.id);
          return (
            <LayerCard
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
              dragProps={{
                // Only the grip starts a drag, so the slider and text stay usable.
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
