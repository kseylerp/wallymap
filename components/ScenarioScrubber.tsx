"use client";

import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { TileScenario } from "@/layers/types";
import { currentScenarioValue, scenarioOf, scenarioReadout, scenarioText } from "@/lib/render/scenario";
import type { LoadedLayer, MapAction, MapState } from "@/lib/render/state";
import { PLAY_STEP_MS } from "@/lib/render/useTimePlay";

const TEXT_BUTTON = "text-[12px] text-ink-muted transition-colors duration-150 hover:text-ink";

/**
 * Drives the scenario scrubber's play: while `playing`, dispatches `scenario_tick` every 600 ms (the time scrubber's
 * step). It lives in the app, like the time scrubber's play, so play goes on while the data console is closed.
 */
export function useScenarioPlay(playing: boolean, dispatch: (action: MapAction) => void): void {
  useEffect(() => {
    if (!playing) return;
    const id = globalThis.setInterval(() => dispatch({ type: "scenario_tick" }), PLAY_STEP_MS);
    return () => globalThis.clearInterval(id);
  }, [playing, dispatch]);
}

/** The loaded layers whose scenario is a scrubber (sea level rise), oldest first; a toggle lives in the layer row only. */
export function scenarioLayers(layers: MapState["layers"]): LoadedLayer[] {
  return Object.values(layers)
    .filter((l) => scenarioOf(l) !== undefined && scenarioOf(l)?.control !== "toggle")
    .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
}

/**
 * One scrubber per loaded scenario layer, for the data console's scenario slot; nothing when there is none. A layer
 * under a scenario compare has none: the compare's A and B amounts are what the map shows.
 */
export function ScenarioScrubbers({ state, dispatch }: { state: Pick<MapState, "layers" | "scenario" | "compare">; dispatch: (action: MapAction) => void }) {
  const compared = state.compare?.scenario ? state.compare.layerId : undefined;
  const layers = scenarioLayers(state.layers).filter((l) => l.id !== compared);
  if (layers.length === 0) return null;
  return (
    <>
      {layers.map((layer) => {
        const scenario = scenarioOf(layer);
        const value = currentScenarioValue(state, layer.id);
        if (!scenario || value === undefined) return null;
        const mine = state.scenario?.layerId === layer.id;
        return (
          <div key={layer.id}>
            <ScenarioScrubber
              layerId={layer.id}
              scenario={scenario}
              value={value}
              playing={mine && state.scenario?.playing === true}
              moved={mine}
              dispatch={dispatch}
            />
            <div aria-hidden className="hairline mx-5" />
          </div>
        );
      })}
    </>
  );
}

type ScenarioScrubberProps = {
  layerId: string;
  scenario: TileScenario;
  /** The amount shown (one of `scenario.values`). */
  value: number;
  playing: boolean;
  /** True when the scrubber moved off the queried amount: × goes back to it. */
  moved: boolean;
  dispatch: (action: MapAction) => void;
};

/**
 * The scenario scrubber in the data console (sea level rise): the layer's `label` in small caps over the amount shown
 * with its conversions ("3 ft · 0.9 m · 36 in"), a track of one even bar per amount (purple up to the amount shown,
 * like a water line) with one handle (drag it, or arrow keys, Home and End), Play (600 ms per amount; space anywhere in
 * the scrubber), step back and forward, and × back to the queried amount. The tile URL follows through
 * lib/render/view.ts; the map debounces it like the time scrubber's.
 */
export function ScenarioScrubber({ layerId, scenario, value, playing, moved, dispatch }: ScenarioScrubberProps) {
  const { values, unit, label } = scenario;
  const n = values.length;
  const at = Math.max(0, values.indexOf(value));
  const trackRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const setAt = (i: number) => {
    const next = values[Math.min(n - 1, Math.max(0, i))];
    if (next !== undefined && next !== value) dispatch({ type: "set_scenario", layerId, value: next });
  };
  const pause = () => {
    if (playing) dispatch({ type: "set_scenario_playing", layerId, playing: false });
  };
  const step = (direction: 1 | -1) => {
    pause();
    setAt(at + direction);
  };
  const indexFromX = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return at;
    return Math.min(n - 1, Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * n)));
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handleRef.current?.focus({ preventScroll: true });
    pause();
    dragging.current = true;
    setAt(indexFromX(e.clientX));
    trackRef.current?.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (dragging.current) setAt(indexFromX(e.clientX));
  };
  const onUp = (e: PointerEvent) => {
    dragging.current = false;
    if (trackRef.current?.hasPointerCapture?.(e.pointerId)) trackRef.current.releasePointerCapture(e.pointerId);
  };
  const onHandleKey = (e: KeyboardEvent) => {
    const delta = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
    if (delta === 0 && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    pause();
    setAt(e.key === "Home" ? 0 : e.key === "End" ? n - 1 : at + delta);
  };
  /** Space plays or pauses from anywhere in the scrubber (a focused button handles its own space). */
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== " " || scenario.labels || (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    dispatch({ type: "set_scenario_playing", layerId, playing: !playing });
  };

  // Named choices read as their words ("Only confident pixels"); amounts with their conversions ("3 ft · 0.9 m").
  const readout = scenario.labels ? scenarioText(scenario, value) : scenarioReadout(value, unit);
  // The handle sits in the middle of its amount's bar.
  const left = ((at + 0.5) / n) * 100;

  return (
    <div role="group" aria-label={label} data-testid="scenario-scrubber" onKeyDown={onKeyDown} className="px-5 pt-4 pb-3">
      <div className="flex items-baseline gap-3">
        <h2 className="small-caps shrink-0">{label}</h2>
        <p aria-live="polite" className="min-w-0 flex-1 truncate text-[13px] leading-[18px] text-ink tabular-nums" data-testid="scenario-readout">
          {readout}
        </p>
        {moved && (
          <button
            type="button"
            onClick={() => dispatch({ type: "clear_scenario" })}
            aria-label={`Back to the queried ${label.toLowerCase()}`}
            title="Back to the queried amount"
            className="hit-target px-1 text-[15px] leading-none text-ink-muted transition-colors hover:text-ink"
          >
            ×
          </button>
        )}
      </div>

      <div
        ref={trackRef}
        data-testid="scenario-track"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        className="time-track relative mt-2.5 h-8 cursor-pointer touch-none select-none"
      >
        <div aria-hidden className="absolute inset-0 flex items-end gap-px">
          {values.map((v, k) => (
            <div
              key={v}
              title={scenarioText(scenario, v)}
              data-in-window={k <= at || undefined}
              className="time-bar flex-1"
              // Taller with the amount, so the track reads as rising water.
              style={{ height: `${20 + (60 * k) / Math.max(1, n - 1)}%` }}
            />
          ))}
        </div>
        <div
          ref={handleRef}
          role="slider"
          tabIndex={0}
          aria-label={`${label} (arrow keys step it)`}
          aria-valuemin={values[0]}
          aria-valuemax={values[n - 1]}
          aria-valuenow={value}
          aria-valuetext={readout}
          data-testid="scenario-handle"
          onKeyDown={onHandleKey}
          className="time-handle absolute inset-y-0"
          style={{ left: `${left}%` }}
        />
      </div>
      <div className="mt-1 flex items-baseline justify-between text-[11px] leading-4 text-ink-muted tabular-nums">
        <span>{scenarioText(scenario, values[0])}</span>
        <span>{n} {scenario.labels ? "choices" : "scenarios"}</span>
        <span>{scenarioText(scenario, values[n - 1])}</span>
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        {/* Named choices (all pixels or only confident ones) are picked, not played. */}
        {!scenario.labels && (
          <button
            type="button"
            onClick={() => dispatch({ type: "set_scenario_playing", layerId, playing: !playing })}
            aria-pressed={playing}
            className="time-play"
            data-testid="scenario-play"
          >
            {playing ? "Pause" : "Play"}
          </button>
        )}
        <button type="button" onClick={() => step(-1)} aria-label="Step down" title="Step down" className={`${TEXT_BUTTON} px-1`}>
          ‹
        </button>
        <button type="button" onClick={() => step(1)} aria-label="Step up" title="Step up" className={`${TEXT_BUTTON} px-1`}>
          ›
        </button>
        <span className="ml-auto text-[11.5px] text-ink-muted tabular-nums" title="The scenario shown, of the scenarios on the scrubber">
          <span className="text-ink">{at + 1}</span> / {n}
        </span>
      </div>
    </div>
  );
}
