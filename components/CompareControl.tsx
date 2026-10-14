"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";
import { compareSummary, presetFor, type CompareMode } from "@/lib/render/compare";
import {
  COMPARE_COLORS,
  compareHidden,
  compareSideText,
  defaultCompare,
  effectiveMode,
  hasPreset,
  isComparable,
  modesFor,
  swipeStore,
  windowText,
  type PresetLayer,
} from "@/lib/render/compareView";
import type { CompareState, LoadedLayer, MapAction, MapState } from "@/lib/render/state";
import { scenarioOf, scenarioValueText } from "@/lib/render/scenario";
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

export { windowText };

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

/** Below this viewport height the compare collapses to a one-line summary with a disclosure. */
export const SHORT_VIEWPORT_QUERY = "(max-height: 699px)";

function subscribeShort(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(SHORT_VIEWPORT_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function isShortViewport(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(SHORT_VIEWPORT_QUERY).matches;
}

/** True while the viewport is under 700px tall (a phone in most cases, or a short laptop window). */
function useShortViewport(): boolean {
  return useSyncExternalStore(subscribeShort, isShortViewport, () => false);
}

const MODE_LABEL: Record<CompareMode, string> = { swipe: "Swipe", toggle: "Toggle", delta: "Delta" };

/** Text button segment: black when pressed (the app's primary), muted text otherwise. */
const SEG =
  "h-6 rounded-[4px] px-2.5 text-[12px] whitespace-nowrap transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:text-ink-muted/40";
const SEG_IDLE = "text-ink hover:bg-mist/70";
const SEG_ON = "bg-primary text-on-primary";
const TEXT_BUTTON = "text-[12px] text-ink-muted transition-colors duration-150 hover:text-ink";

/**
 * The layer a compare opens on (the console's Start button and the map's Compare pill): the selected feature's layer
 * when it can be compared, else the comparable layer loaded last.
 */
export function openingLayer(state: MapState, comparable: LoadedLayer[]): LoadedLayer | undefined {
  const selected = comparable.find((l) => l.id === state.selected?.layerId);
  if (selected) return selected;
  return comparable.reduce<LoadedLayer | undefined>(
    (latest, l) => (!latest || Date.parse(l.receivedAt) >= Date.parse(latest.receivedAt) ? l : latest),
    undefined,
  );
}

/** The comparable layers, and the one Compare opens on (null when none can be compared). */
export function compareEntry(state: MapState): { comparable: LoadedLayer[]; opening: LoadedLayer | undefined } {
  const comparable = Object.values(state.layers).filter(isComparable);
  return { comparable, opening: openingLayer(state, comparable) };
}

/** The action that opens a compare on the layer `compareEntry` picks, or null when nothing can be compared. */
export function openCompareAction(state: MapState, today: Date = new Date()): MapAction | null {
  const { opening } = compareEntry(state);
  return opening ? { type: "set_compare", compare: defaultCompare(opening, today, state) } : null;
}

/**
 * Compare over time (spec §7), in the data console under the time scrubber: while a loaded layer has dates (or is
 * night lights or forest loss) a one-line "Compare" row with Start; while a compare is on, the layer, the A and B
 * windows (date fields, or a preset), Swipe / Toggle / Delta, a legend in the compare colors (A purple, B pink, both
 * dark grey) and × to exit. The swipe handle (`CompareSwipe`) and the 1 Hz flip (`useCompareTicker`) live in the app,
 * so they keep working while the console is closed. Hairlines, small caps, tabular figures; text only.
 */
export function CompareControl({ state, dispatch }: CompareControlProps) {
  const comparable = useMemo(() => Object.values(state.layers).filter(isComparable), [state.layers]);
  const compare = state.compare;
  const layer = compare ? state.layers[compare.layerId] : undefined;

  if (!compare || !layer) {
    const opening = openingLayer(state, comparable);
    if (!opening) return null;
    return (
      <>
        <div role="group" aria-label="Compare over time" className="flex items-baseline gap-3 px-5 pt-3.5 pb-3">
          <h2 className="small-caps">Compare</h2>
          <p className="min-w-0 flex-1 truncate text-[12px] text-ink-muted">
            {opening.title} at two {scenarioOf(opening) ? "amounts" : "times"}
          </p>
          <button
            type="button"
            data-testid="compare-open"
            title={`Compare ${opening.title} at two ${scenarioOf(opening) ? "amounts" : "times"}`}
            onClick={() => dispatch({ type: "set_compare", compare: defaultCompare(opening, new Date(), state) })}
            className={TEXT_BUTTON}
          >
            Start
          </button>
        </div>
        <div aria-hidden className="hairline mx-5" />
      </>
    );
  }
  return <CompareStrip compare={compare} layer={layer} comparable={comparable} state={state} dispatch={dispatch} />;
}

/**
 * Toggle mode's 1 Hz flip, and space to pause it. It lives in the app (like the scrubber's play), so the flip keeps
 * going while the data console is closed. Nothing ticks while the compared layer is hidden. Space is left to any
 * focused field, button or slider, and key repeat is ignored. While a route preview runs (its dock is mounted), Space
 * belongs to the preview's play and pause (components/PreviewControl.tsx), so one key press never drives both.
 */
export function useCompareTicker(state: MapState, dispatch: (action: MapAction) => void): void {
  const previewing = state.playback !== undefined && state.routes[state.playback.routeId] !== undefined;
  const toggleMode = effectiveMode(state) === "toggle";
  const spaceKey = toggleMode && !previewing;
  const paused = state.compare?.paused === true;
  const toggling = toggleMode && !paused && !compareHidden(state);
  useEffect(() => {
    if (!toggling) return;
    const id = globalThis.setInterval(() => dispatch({ type: "compare_flip" }), FLIP_MS);
    return () => globalThis.clearInterval(id);
  }, [toggling, dispatch]);
  useEffect(() => {
    if (!spaceKey) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== " " || e.repeat) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest("input, textarea, select, button, [role='slider'], [contenteditable='true']")) return;
      e.preventDefault();
      dispatch({ type: "set_compare_paused", paused: !paused });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [spaceKey, paused, dispatch]);
}

/** The swipe handle over the map while a compare swipes (and its layer is shown). Mount it at the map, not in a panel. */
export function CompareSwipe({ state }: { state: MapState }) {
  const compare = state.compare;
  if (!compare || effectiveMode(state) !== "swipe" || compareHidden(state) || !state.layers[compare.layerId]) return null;
  const layer = state.layers[compare.layerId];
  return <SwipeHandle aText={compareSideText(compare, "a", layer)} bText={compareSideText(compare, "b", layer)} />;
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
  const paused = compare.paused === true;
  const [presetsOpen, setPresetsOpen] = useState(false);
  // Under 700px tall the strip folds to one summary line; More opens it (and Less folds it back).
  const short = useShortViewport();
  const [expanded, setExpanded] = useState(false);
  const presets = comparable.map((l) => l.id).filter(hasPreset);
  // A hidden layer draws nothing, so nothing ticks (useCompareTicker) and the strip says so.
  const hidden = compareHidden(state);

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

  if (short && !expanded) {
    // "2016–2020" reads as "2016–20" here, so the line fits the 280px console.
    const compact = (text: string) => text.replace(/^(\d{2})(\d{2})–\1(\d{2})$/, "$1$2–$3");
    const aText = compact(compareSideText(compare, "a", layer));
    const bText = compact(compareSideText(compare, "b", layer));
    return (
      <>
        <div
          role="group"
          aria-label="Compare over time"
          data-testid="compare-control"
          onKeyDown={(e) => {
            if (e.key === "Escape") exit();
          }}
          className="flex items-baseline gap-1.5 px-5 py-3 text-ink"
        >
          <h2 className="small-caps">Compare</h2>
          {/* The summary line is the disclosure: pressing it opens the whole strip. */}
          <button
            type="button"
            aria-expanded={false}
            aria-label={`Show compare controls: ${layer.title}`}
            onClick={() => setExpanded(true)}
            data-testid="compare-more"
            className="min-w-0 flex-1 truncate text-left text-[11.5px] tracking-[-0.01em] tabular-nums underline-offset-4 hover:underline"
          >
            <span data-testid="compare-summary">
              {MODE_LABEL[mode]} · {aText} vs {bText}
              {hidden && <span className="text-ink-muted"> · layer hidden</span>}
            </span>
          </button>
          {/* The side on screen stays visible however the line truncates. */}
          {!hidden && mode === "toggle" && (
            <span
              data-testid="compare-badge"
              className={`shrink-0 text-[11.5px] font-semibold ${compare.side === "b" ? "text-coral" : "text-accent"}`}
            >
              {compare.side === "b" ? "B" : "A"}
            </span>
          )}
          <button
            type="button"
            onClick={exit}
            aria-label="Exit compare"
            title="Exit compare"
            data-testid="compare-exit"
            className="hit-target px-1 text-[15px] leading-none text-ink-muted transition-colors hover:text-ink"
          >
            ×
          </button>
        </div>
        <div aria-hidden className="hairline mx-5" />
      </>
    );
  }

  const contract = compare.scenario ? scenarioOf(layer) : undefined;
  /** A scenario compare's side: the amount as a select over the layer's amounts ("1 ft"), in place of the date fields. */
  const amountField = (which: "a" | "b") => {
    if (!contract || !compare.scenario) return null;
    const scenario = compare.scenario;
    const name = which.toUpperCase();
    return (
      <select
        aria-label={`${name} ${contract.label.toLowerCase()}`}
        value={String(scenario[which])}
        onChange={(e) => set({ scenario: { ...scenario, [which]: Number(e.target.value) }, [which === "a" ? "aLabel" : "bLabel"]: undefined })}
        data-testid={`compare-amount-${which}`}
        className="compare-date h-6 min-w-0 rounded-[4px] bg-transparent px-1 text-[12px] text-ink tabular-nums outline-none hover:bg-mist/60 focus-visible:bg-mist/70"
      >
        {contract.values.map((v) => (
          <option key={v} value={String(v)}>
            {scenarioValueText(v, contract.unit)}
          </option>
        ))}
      </select>
    );
  };

  const sideRow = (which: "a" | "b") => {
    const w = compare[which];
    const label = which === "a" ? compare.aLabel : compare.bLabel;
    const color = which === "a" ? COMPARE_COLORS.a : COMPARE_COLORS.b;
    const name = which.toUpperCase();
    return (
      // 280px of console: the two dates fill the row, so an agent's label for the side gets its own line under them.
      <div className="min-w-0" data-testid={`compare-side-${which}`}>
        <div className="flex min-w-0 items-center gap-1.5">
          <Swatch color={color} />
          <span className="w-3 shrink-0 text-[12px] font-medium text-ink">{name}</span>
          {contract ? (
            <>
              {amountField(which)}
              <span className="min-w-0 truncate text-[11.5px] text-ink-muted">{contract.label}</span>
            </>
          ) : (
            <>
              <DateField label={`${name} from`} value={w[0].slice(0, 10)} onCommit={(v) => setWindow(which, 0, v)} />
              <span aria-hidden className="text-[12px] text-ink-muted">
                –
              </span>
              <DateField label={`${name} to`} value={w[1].slice(0, 10)} onCommit={(v) => setWindow(which, 1, v)} />
            </>
          )}
        </div>
        {label && (
          <p className="truncate pl-[34px] text-[11.5px] leading-4 text-ink-muted" title={label}>
            {label}
          </p>
        )}
      </div>
    );
  };

  return (
    <>
      <div>
        <div
          role="group"
          aria-label="Compare over time"
          data-testid="compare-control"
          onKeyDown={(e) => {
            if (e.key === "Escape") exit();
          }}
          className="px-5 pt-3.5 pb-3 text-ink"
        >
          <div className="flex items-baseline gap-2">
            <h2 className="small-caps">Compare</h2>
            {comparable.length > 1 ? (
              <select
                aria-label="Layer to compare"
                value={layer.id}
                onChange={(e) => {
                  const next = comparable.find((l) => l.id === e.target.value);
                  if (next) dispatch({ type: "set_compare", compare: { ...defaultCompare(next, new Date(), state), mode: compare.mode } });
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
            {short && (
              <button type="button" aria-expanded onClick={() => setExpanded(false)} className={TEXT_BUTTON} data-testid="compare-less">
                Less
              </button>
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
              className="hit-target px-1 text-[15px] leading-none text-ink-muted transition-colors hover:text-ink"
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

          <div className="hairline mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 pt-2">
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
                  {compareSideText(compare, compare.side === "b" ? "b" : "a", layer)}
                </span>
                <button
                  type="button"
                  onClick={() => dispatch({ type: "set_compare_paused", paused: !paused })}
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
      <div aria-hidden className="hairline mx-5" />
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
      className="compare-date h-6 w-[108px] min-w-0 shrink rounded-[4px] bg-transparent px-1 text-[12px] text-ink tabular-nums outline-none hover:bg-mist/60 focus-visible:bg-mist/70"
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
