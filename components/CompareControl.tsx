"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";
import { compareSummary, presetFor, type CompareMode } from "@/lib/render/compare";
import {
  COMPARE_COLORS,
  defaultCompare,
  effectiveMode,
  hasPreset,
  isComparable,
  modesFor,
  swipeStore,
  type PresetLayer,
} from "@/lib/render/compareView";
import type { CompareState, LoadedLayer, MapAction, MapState } from "@/lib/render/state";
import { visibleState } from "@/lib/render/view";

/** Toggle mode flips A and B this often (spec §7: 1 Hz). */
export const FLIP_MS = 1000;
/** Arrow keys move the swipe handle this share of the width (Shift: five times as far). */
const SWIPE_STEP = 0.02;

const MODES: { mode: CompareMode; label: string; hint: string }[] = [
  { mode: "swipe", label: "Swipe", hint: "A left of the handle, B right of it" },
  { mode: "toggle", label: "Toggle", hint: "A and B take turns every second; space pauses" },
  { mode: "delta", label: "Delta", hint: "One map: A only, B only, both" },
];

const PRESET_TEXT: Record<PresetLayer, string> = {
  "fire-perimeters": "2016–2020 vs 2021–today",
  "forest-loss": "2015 vs 2025",
  "night-lights": "2020 vs today",
};

type CompareControlProps = {
  state: MapState;
  dispatch: (action: MapAction) => void;
};

/**
 * A window as people say it: "2015" for one whole year, "2016–2020" for whole years, "2021–today" when it runs from a
 * new year to today, else the days ("2020-01-01", "2024-03-01 – 2024-06-30").
 */
export function windowText([start, end]: [string, string], today: Date = new Date()): string {
  const s = start.slice(0, 10);
  const e = end.slice(0, 10);
  const yearStart = s.endsWith("-01-01");
  const endIsToday = e === today.toISOString().slice(0, 10);
  if (yearStart && e.endsWith("-12-31")) return s.slice(0, 4) === e.slice(0, 4) ? s.slice(0, 4) : `${s.slice(0, 4)}–${e.slice(0, 4)}`;
  if (s === e) return endIsToday ? "today" : s;
  if (yearStart && endIsToday) return `${s.slice(0, 4)}–today`;
  return `${s} – ${endIsToday ? "today" : e}`;
}

function Swatch({ color, label }: { color: string; label?: string }) {
  return (
    <span
      aria-hidden={label === undefined}
      aria-label={label}
      className="inline-block size-2.5 shrink-0 rounded-[2px]"
      style={{ background: color, boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.12)" }}
    />
  );
}

/** Text button segment: black when pressed (the app's primary), muted text otherwise. */
const SEG =
  "h-6 rounded-[4px] px-2.5 text-[12px] whitespace-nowrap transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:text-ink-muted/40";
const SEG_IDLE = "text-ink hover:bg-mist/70";
const SEG_ON = "bg-primary text-on-primary";
const TEXT_BUTTON = "text-[12px] text-ink-muted transition-colors duration-150 hover:text-ink";

/**
 * Compare over time (spec §7): the Compare pill under the map pills while any loaded layer has dates (or is night
 * lights or forest loss), and while a compare is on a strip there: the layer, the A and B windows (date fields, or a
 * preset), Swipe / Toggle / Delta, a legend in the compare colors (A purple, B pink, both dark grey) and × to exit.
 * Swipe adds a handle across the map; toggle flips A and B every second with a badge (space pauses). Monochrome
 * chrome, text only.
 */
/**
 * The layer the Compare pill opens on: the selected feature's layer when it can be compared, else the comparable layer
 * loaded last.
 */
export function openingLayer(state: MapState, comparable: LoadedLayer[]): LoadedLayer | undefined {
  const selected = comparable.find((l) => l.id === state.selected?.layerId);
  if (selected) return selected;
  return comparable.reduce<LoadedLayer | undefined>(
    (latest, l) => (!latest || Date.parse(l.receivedAt) >= Date.parse(latest.receivedAt) ? l : latest),
    undefined,
  );
}

export function CompareControl({ state, dispatch }: CompareControlProps) {
  const comparable = useMemo(() => Object.values(state.layers).filter(isComparable), [state.layers]);
  const compare = state.compare;
  const layer = compare ? state.layers[compare.layerId] : undefined;

  if (!compare || !layer) {
    const opening = openingLayer(state, comparable);
    if (!opening) return null;
    return (
      <div className="pointer-events-none absolute top-[56px] left-3 z-10 md:top-[60px] md:left-4">
        <div className="map-pill rise-in pointer-events-auto flex h-9 items-center rounded-pill p-1 text-ink">
          <button
            type="button"
            data-testid="compare-open"
            title={`Compare ${opening.title} at two times`}
            onClick={() => dispatch({ type: "set_compare", compare: defaultCompare(opening, new Date()) })}
            className={`${SEG} h-7 px-2.5 text-[13px] ${SEG_IDLE}`}
          >
            Compare
          </button>
        </div>
      </div>
    );
  }
  return <CompareStrip compare={compare} layer={layer} comparable={comparable} state={state} dispatch={dispatch} />;
}

type StripProps = {
  compare: CompareState;
  layer: LoadedLayer;
  comparable: LoadedLayer[];
  state: MapState;
  dispatch: (action: MapAction) => void;
};

function CompareStrip({ compare, layer, comparable, state, dispatch }: StripProps) {
  const mode = effectiveMode(state) ?? compare.mode;
  const available = modesFor(layer);
  const [paused, setPaused] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const presets = comparable.map((l) => l.id).filter(hasPreset);
  // A hidden layer draws nothing, so nothing ticks and the strip says so.
  const hidden = state.renderOps.find((op) => op.layerId === compare.layerId)?.visible === false;

  // Toggle: flip A and B every second until paused (or the layer is hidden); space pauses outside any control.
  const toggling = mode === "toggle" && !paused && !hidden;
  useEffect(() => {
    if (!toggling) return;
    const id = globalThis.setInterval(() => dispatch({ type: "compare_flip" }), FLIP_MS);
    return () => globalThis.clearInterval(id);
  }, [toggling, dispatch]);
  useEffect(() => {
    if (mode !== "toggle") return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== " " || e.repeat) return;
      const target = e.target instanceof Element ? e.target : null;
      // Text fields keep their spaces, and any focused button or slider (the strip's own too) keeps its own.
      if (target?.closest("input, textarea, select, button, [role='slider'], [contenteditable='true']")) return;
      e.preventDefault();
      setPaused((p) => !p);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  // visibleState is memoized per state and its compare data per layer and windows, so this is the same object until
  // the compare or the data changes (a camera move does not recount).
  const drawn = mode === "delta" ? visibleState(state).layers[compare.layerId] : undefined;
  const deltaData = drawn?.result.kind === "geojson" ? drawn.result.data : null;
  const summary = useMemo(() => (deltaData ? compareSummary(deltaData) : null), [deltaData]);

  const set = (next: Partial<CompareState>) => {
    const { side: _side, ...rest } = compare;
    void _side;
    dispatch({ type: "set_compare", compare: { ...rest, ...next } });
  };
  const setWindow = (which: "a" | "b", end: 0 | 1, value: string) => {
    const w: [string, string] = [...compare[which]];
    if (w[end].slice(0, 10) === value) return;
    w[end] = value;
    set({ [which]: w, [which === "a" ? "aLabel" : "bLabel"]: undefined });
  };
  // A preset (or another layer) sets the windows; the mode the user chose stays.
  const applyPreset = (id: PresetLayer) => {
    setPresetsOpen(false);
    dispatch({ type: "set_compare", compare: { ...presetFor(id, new Date()), mode: compare.mode } });
  };
  const exit = () => dispatch({ type: "clear_compare" });

  const sideRow = (which: "a" | "b") => {
    const w = compare[which];
    const label = which === "a" ? compare.aLabel : compare.bLabel;
    const color = which === "a" ? COMPARE_COLORS.a : COMPARE_COLORS.b;
    const name = which.toUpperCase();
    return (
      <div className="flex min-w-0 items-center gap-1.5" data-testid={`compare-side-${which}`}>
        <Swatch color={color} />
        <span className="w-3 text-[12px] font-medium text-ink">{name}</span>
        <DateField label={`${name} from`} value={w[0].slice(0, 10)} onCommit={(v) => setWindow(which, 0, v)} />
        <span aria-hidden className="text-[12px] text-ink-muted">
          –
        </span>
        <DateField label={`${name} to`} value={w[1].slice(0, 10)} onCommit={(v) => setWindow(which, 1, v)} />
        {label && <span className="truncate text-[11.5px] text-ink-muted">{label}</span>}
      </div>
    );
  };

  return (
    <>
      <div className="pointer-events-none absolute top-[56px] left-3 z-10 max-w-[calc(100%-24px)] md:top-[60px] md:left-4">
        <div
          role="group"
          aria-label="Compare over time"
          data-testid="compare-control"
          onKeyDown={(e) => {
            if (e.key === "Escape") exit();
          }}
          className="map-pill rise-in pointer-events-auto w-[372px] max-w-full rounded-small px-4 pt-3 pb-2.5 text-ink"
        >
          <div className="flex items-baseline gap-2">
            <h2 className="small-caps">Compare</h2>
            {comparable.length > 1 ? (
              <select
                aria-label="Layer to compare"
                value={layer.id}
                onChange={(e) => {
                  const next = comparable.find((l) => l.id === e.target.value);
                  if (next) dispatch({ type: "set_compare", compare: { ...defaultCompare(next, new Date()), mode: compare.mode } });
                }}
                className="min-w-0 flex-1 truncate bg-transparent text-[13px] text-ink outline-none"
              >
                {comparable.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.title}
                  </option>
                ))}
              </select>
            ) : (
              <p className="min-w-0 flex-1 truncate text-[13px] text-ink" data-testid="compare-layer">
                {layer.title}
              </p>
            )}
            {presets.length > 0 && (
              <button
                type="button"
                aria-expanded={presetsOpen}
                onClick={() => setPresetsOpen((o) => !o)}
                className={TEXT_BUTTON}
              >
                Presets
              </button>
            )}
            <button
              type="button"
              onClick={exit}
              aria-label="Exit compare"
              title="Exit compare"
              data-testid="compare-exit"
              className="px-1 text-[15px] leading-none text-ink-muted transition-colors hover:text-ink"
            >
              ×
            </button>
          </div>

          {presetsOpen && (
            <ul role="menu" aria-label="Compare presets" className="hairline mt-2 pt-1.5">
              {presets.map((id) => (
                <li key={id} role="none">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => applyPreset(id)}
                    className="flex w-full items-baseline gap-2 rounded-small px-1 py-1 text-left text-[12px] text-ink hover:bg-mist/60"
                  >
                    <span>{state.layers[id]?.title ?? id}</span>
                    <span className="text-ink-muted">{PRESET_TEXT[id]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-2 flex flex-col gap-1">
            {sideRow("a")}
            {sideRow("b")}
          </div>

          <div className="hairline mt-2.5 flex items-center gap-2 pt-2">
            <div role="group" aria-label="Compare mode" className="flex items-center gap-0.5">
              {MODES.map(({ mode: m, label, hint }) => {
                const supported = available.includes(m);
                return (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={mode === m}
                    disabled={!supported}
                    title={supported ? hint : "Tile layers compare by toggle"}
                    onClick={() => dispatch({ type: "set_compare_mode", mode: m })}
                    className={`${SEG} ${mode === m ? SEG_ON : SEG_IDLE}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {hidden ? (
              <p className="ml-auto text-[11.5px] text-ink-muted" data-testid="compare-hidden">
                Layer hidden
              </p>
            ) : mode === "toggle" && (
              <div className="ml-auto flex items-center gap-2">
                <span className="text-[11.5px] text-ink-muted tabular-nums">
                  {compare.side === "b" ? (compare.bLabel ?? windowText(compare.b)) : (compare.aLabel ?? windowText(compare.a))}
                </span>
                <button
                  type="button"
                  onClick={() => setPaused((p) => !p)}
                  aria-pressed={paused}
                  title="Space pauses"
                  className={TEXT_BUTTON}
                  data-testid="compare-pause"
                >
                  {paused ? "Play" : "Pause"}
                </button>
                {/* The side on screen: its letter in its token color over a thin bar of the same color. */}
                <span
                  aria-live="polite"
                  data-testid="compare-badge"
                  className={`border-b-2 px-0.5 text-[13px] leading-5 font-semibold tabular-nums ${
                    compare.side === "b" ? "border-coral text-coral" : "border-accent text-accent"
                  }`}
                >
                  {compare.side === "b" ? "B" : "A"}
                </span>
              </div>
            )}
          </div>

          <ul aria-label="Legend" className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-muted">
            <li className="flex items-center gap-1.5">
              <Swatch color={COMPARE_COLORS.a} />
              A only{summary && <span className="text-ink tabular-nums">{summary.aOnly.toLocaleString()}</span>}
            </li>
            <li className="flex items-center gap-1.5">
              <Swatch color={COMPARE_COLORS.b} />
              B only{summary && <span className="text-ink tabular-nums">{summary.bOnly.toLocaleString()}</span>}
            </li>
            <li className="flex items-center gap-1.5">
              <Swatch color={COMPARE_COLORS.both} />
              both{summary && <span className="text-ink tabular-nums">{summary.both.toLocaleString()}</span>}
            </li>
            {mode !== "delta" && (
              <li className="ml-auto text-[11px]">{mode === "swipe" ? "Drag the handle" : "Space pauses"}</li>
            )}
          </ul>
        </div>
      </div>
      {mode === "swipe" && !hidden && (
        <SwipeHandle aText={compare.aLabel ?? windowText(compare.a)} bText={compare.bLabel ?? windowText(compare.b)} />
      )}
    </>
  );
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date field that edits a draft: typing never reaches the map (so the reducer never reorders a window under the
 * cursor). The draft is committed on blur, or on Enter (which blurs), when it is a real date; otherwise the field
 * goes back to the committed value.
 */
export function DateField({ label, value, onCommit }: { label: string; value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const next = draft;
    setDraft(null);
    if (next !== null && DATE_RE.test(next) && !Number.isNaN(Date.parse(next)) && next !== value) onCommit(next);
  };
  return (
    <input
      type="date"
      aria-label={label}
      value={draft ?? value}
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      className="compare-date h-6 w-[118px] rounded-[4px] bg-transparent px-1 text-[12px] text-ink tabular-nums outline-none hover:bg-mist/60 focus-visible:bg-mist/70"
    />
  );
}

/**
 * The swipe handle: a hairline across the map with a 36px knob (A and B either side of the line). Drag the knob or
 * the line; arrow keys move it 2% (Shift 10%), Home and End go to the edges. It writes `swipeStore`, which clips the
 * map's two side overlays.
 */
export function SwipeHandle({ aText, bText }: { aText: string; bText: string }) {
  const at = useSyncExternalStore(swipeStore.subscribe, swipeStore.get, swipeStore.get);
  const areaRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const moveTo = (clientX: number) => {
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    swipeStore.set(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)));
  };
  const onDown = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging.current = true;
    (e.currentTarget as HTMLElement).focus({ preventScroll: true });
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: PointerEvent<HTMLElement>) => {
    if (dragging.current) moveTo(e.clientX);
  };
  const onUp = (e: PointerEvent<HTMLElement>) => {
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? SWIPE_STEP * 5 : SWIPE_STEP;
    let next: number | null = null;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = at - step;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = at + step;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = 1;
    if (next === null) return;
    e.preventDefault();
    swipeStore.set(Math.min(1, Math.max(0, Math.round(next * 1000) / 1000)));
  };

  const pct = at * 100;
  const handlers = { onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp };
  return (
    <div ref={areaRef} aria-hidden={false} className="pointer-events-none absolute inset-0 z-[5]" data-testid="compare-swipe">
      {/* The line: 1px off-white with a soft dark edge so it reads on imagery and on the plain map. */}
      <div
        {...handlers}
        className="pointer-events-auto absolute inset-y-0 w-3 -translate-x-1/2 cursor-ew-resize touch-none"
        style={{ left: `${pct}%` }}
      >
        <div
          className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-paper"
          style={{ boxShadow: "0 0 0 0.5px rgba(0,0,0,0.35), 0 0 6px rgba(0,0,0,0.25)" }}
        />
      </div>
      <div
        {...handlers}
        role="slider"
        tabIndex={0}
        aria-label="Swipe between A and B (arrow keys move it)"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={`A (${aText}) left of ${Math.round(pct)}%, B (${bText}) right`}
        data-testid="compare-handle"
        onKeyDown={onKey}
        className="pointer-events-auto absolute top-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize touch-none items-center justify-between rounded-full bg-paper px-[7px] text-[11px] font-semibold text-ink shadow-card outline-none select-none focus-visible:ring-2 focus-visible:ring-ink"
        style={{ left: `${pct}%`, boxShadow: "0 0 0 1px var(--ink), var(--card-shadow)" }}
      >
        <span style={{ color: COMPARE_COLORS.a }}>A</span>
        <span aria-hidden className="h-3.5 w-px bg-ink/40" />
        <span style={{ color: COMPARE_COLORS.b }}>B</span>
      </div>
      {/* Which window each side shows, beside the knob. */}
      <span
        aria-hidden
        className="map-pill absolute top-1/2 -translate-x-full -translate-y-1/2 rounded-pill px-2 py-0.5 text-[11px] whitespace-nowrap text-ink tabular-nums"
        style={{ left: `calc(${pct}% - 26px)` }}
      >
        {aText}
      </span>
      <span
        aria-hidden
        className="map-pill absolute top-1/2 -translate-y-1/2 rounded-pill px-2 py-0.5 text-[11px] whitespace-nowrap text-ink tabular-nums"
        style={{ left: `calc(${pct}% + 26px)` }}
      >
        {bText}
      </span>
    </div>
  );
}
