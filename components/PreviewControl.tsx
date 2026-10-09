"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Mountain, Pause, Play, X } from "lucide-react";
import { ElevationProfile, SeriesLegend, type Units } from "@/components/ElevationProfile";
import type { MapAction, MapState, RouteState } from "@/lib/render/state";
import {
  dockCompactStore,
  elevationStore,
  liveFractionStore,
  mapStateStore,
  onPreviewDispatch,
  SPEEDS,
} from "@/lib/render/wally/playback";
import { gainLoss, sampleAlong, samplePoints } from "@/lib/render/wally/sample";

/**
 * Route preview controls (spec §6): play/pause (Space), speed, a scrub slider, exit (Escape) and the elevation
 * profile, on an off-white glass dock above the chat composer (above the bottom sheet on phones). With no preview
 * running it offers a small "Preview route" pill for the newest route. Mounted by the chat rail, whose
 * `onActions` it registers as the preview dispatcher (see the preview bus in lib/render/wally/playback.ts).
 */

const M_PER_MI = 1609.344;
const FT_PER_M = 3.28084;
const PROFILE_HEIGHT = 180;

type PreviewControlProps = { onActions: (actions: MapAction[]) => void };

const fmt = (n: number, digits = 0) => n.toLocaleString("en-US", { maximumFractionDigits: digits });

/** True when a key press belongs to a text field (the composer stays usable during a preview); sliders do not count. */
function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const field = target.closest("input, select, textarea, [contenteditable='true']");
  return field !== null && !(field instanceof HTMLInputElement && field.type === "range");
}

function useMapState(): MapState | null {
  return useSyncExternalStore(mapStateStore.subscribe, mapStateStore.get, () => null);
}

/** Phones (under the md breakpoint) float the dock above the sheet instead of inside it. */
function useIsPhone(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mq = window.matchMedia("(max-width: 767px)");
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 767px)").matches,
    () => false,
  );
}

export function PreviewControl({ onActions }: PreviewControlProps) {
  useEffect(() => onPreviewDispatch((action) => onActions([action])), [onActions]);
  const state = useMapState();
  const playback = state?.playback;
  const route = playback ? state?.routes[playback.routeId] : undefined;

  if (!state) return null;
  if (playback && route) return <Dock state={state} route={route} onActions={onActions} />;
  const newest = Object.values(state.routes).at(-1);
  return newest ? <StartPill route={newest} onStart={() => onActions([{ type: "preview_start", routeId: newest.id }])} /> : null;
}

function distanceLabel(meters: number, units: Units): string {
  return units === "mi" ? `${fmt(meters / M_PER_MI, 1)} mi` : `${fmt(meters / 1000, 1)} km`;
}

function StartPill({ route, onStart }: { route: RouteState; onStart: () => void }) {
  return (
    <div className="mb-2 flex w-full shrink-0 in-data-[chat-open=true]:px-3">
      <button
        type="button"
        onClick={onStart}
        aria-label={`Preview route${route.name ? ` ${route.name}` : ""}`}
        className="glass-strong press flex h-9 max-w-full items-center gap-2 rounded-pill pr-3.5 pl-1.5 text-[13px] font-medium text-ink transition duration-150 ease-out hover:bg-paper"
      >
        <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary">
          <Play size={12} strokeWidth={2.5} fill="currentColor" className="translate-x-px" />
        </span>
        <span className="truncate">Preview {route.name ?? "route"}</span>
        <span className="shrink-0 text-ink-muted tabular-nums">{distanceLabel(route.distanceKm * 1000, "mi")}</span>
      </button>
    </div>
  );
}

type DockProps = { state: MapState; route: RouteState; onActions: (actions: MapAction[]) => void };

function Dock({ state, route, onActions }: DockProps) {
  const playback = state.playback!;
  const [units, setUnits] = useState<Units>("mi");
  // On a phone with no room above the full dock, the map asks for a 56px controls strip; "Profile" opens it again.
  const compactWanted = useSyncExternalStore(dockCompactStore.subscribe, dockCompactStore.get, () => false);
  const [profileOpen, setProfileOpen] = useState(false);
  const compact = compactWanted && !profileOpen;
  const isPhone = useIsPhone();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [phoneBottom, setPhoneBottom] = useState<number | null>(null);

  const live = useSyncExternalStore(liveFractionStore.subscribe, liveFractionStore.get, () => null);
  const fraction = live?.routeId === route.id ? live.fraction : playback.fraction;
  const heightsSnap = useSyncExternalStore(elevationStore.subscribe, elevationStore.get, () => null);

  const { layers, renderOps } = state;
  const samples = useMemo(() => sampleAlong(route.line, layers, renderOps), [route.line, layers, renderOps]);
  const fallback = useMemo(() => samplePoints(route.line).points.map(() => null), [route.line]);
  const heights = heightsSnap?.routeId === route.id ? heightsSnap.values : fallback;
  const { gain, loss } = useMemo(() => gainLoss(heights), [heights]);

  const total = samples.distancesM[samples.distancesM.length - 1] ?? 0;
  const dispatch = (action: MapAction) => onActions([action]);
  const scrub = (f: number) => {
    // Move the cursor at once; the map adopts the new position from the reducer.
    liveFractionStore.set({ routeId: route.id, fraction: f });
    dispatch({ type: "preview_tick", fraction: f });
  };

  // Pausing tells the reducer where the ride stopped (it is not told the position while playing).
  const toggle = () =>
    onActions(
      playback.playing
        ? [{ type: "preview_tick", fraction }, { type: "preview_toggle" }]
        : [{ type: "preview_toggle" }],
    );
  const toggleRef = useRef(toggle);

  // Space plays or pauses and Escape exits, except while typing (the composer stays usable) or when a control
  // has focus and Space should press it. A toggle compare's Space pause steps aside while the dock is up
  // (useCompareTicker in components/CompareControl.tsx), so one press never pauses both.
  const actionsRef = useRef(onActions);
  useEffect(() => {
    actionsRef.current = onActions;
    toggleRef.current = toggle;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typingIn(e.target)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        actionsRef.current([{ type: "preview_stop" }]);
      } else if (e.key === " " || e.code === "Space") {
        if (e.target instanceof Element && e.target.closest("button, a")) return;
        e.preventDefault();
        toggleRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // On phones the dock floats just above the chat (sheet or collapsed composer), tracking its height.
  useLayoutEffect(() => {
    if (!isPhone) return;
    const chat = anchorRef.current?.closest("section");
    if (!chat) return;
    const measure = () => setPhoneBottom(window.innerHeight - chat.getBoundingClientRect().top + 8);
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(chat);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [isPhone]);

  const doneM = fraction * total;
  const elevUnit = units === "mi" ? "ft" : "m";
  const elevScale = units === "mi" ? FT_PER_M : 1;
  const hasHeights = heights.some((h) => h !== null);

  const dock = (
    <section
      role="region"
      aria-label="Route preview"
      data-testid="preview-control"
      data-compact={compact}
      className={`glass-strong rise-in w-full text-ink ${compact ? "rounded-[28px] p-2" : "rounded-[20px] p-3"}`}
    >
      {!compact && (
        <>
          <header className="flex items-baseline gap-2 px-1">
            <h3 className="min-w-0 flex-1 truncate font-serif text-[15px] font-semibold">{route.name ?? "Route preview"}</h3>
            {hasHeights && (
              <span className="shrink-0 text-[11.5px] text-ink-muted tabular-nums" aria-label={`Climb ${fmt(gain * elevScale)} ${elevUnit}, descent ${fmt(loss * elevScale)} ${elevUnit}`}>
                <span aria-hidden>↑</span> {fmt(gain * elevScale)} {elevUnit}
                <span aria-hidden className="ml-2">↓</span> {fmt(loss * elevScale)} {elevUnit}
              </span>
            )}
            <button
              type="button"
              onClick={() => setUnits((u) => (u === "mi" ? "km" : "mi"))}
              aria-label={`Show ${units === "mi" ? "kilometers" : "miles"}`}
              className="shrink-0 rounded-full px-1.5 text-[11px] font-semibold tracking-wide text-ink-muted uppercase transition-colors hover:bg-mist hover:text-ink"
            >
              {units}
            </button>
          </header>

          <div className="mt-2 overflow-hidden rounded-[14px] border border-line bg-paper pt-1">
            <ElevationProfile
              distancesM={samples.distancesM}
              elevations={heights}
              series={samples.series}
              fraction={fraction}
              units={units}
              height={PROFILE_HEIGHT}
              onScrub={scrub}
            />
          </div>
          <SeriesLegend series={samples.series} distancesM={samples.distancesM} fraction={fraction} />
        </>
      )}

      <div className={`flex items-center gap-2.5 ${compact ? "" : "mt-2.5"}`}>
        <button
          type="button"
          onClick={toggle}
          aria-label={playback.playing ? "Pause preview" : "Play preview"}
          title={playback.playing ? "Pause (Space)" : "Play (Space)"}
          className="press flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary transition duration-150 ease-out hover:opacity-85"
        >
          {playback.playing ? (
            <Pause aria-hidden size={16} strokeWidth={2.5} fill="currentColor" />
          ) : (
            <Play aria-hidden size={16} strokeWidth={2.5} fill="currentColor" className="translate-x-px" />
          )}
        </button>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {/* The visible track; the transparent native range on top does the work (keyboard included). */}
          <div className="relative h-5 rounded-full has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ink/30">
            <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-ink/10" />
            <div
              className="absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded-full"
              style={{ width: `${fraction * 100}%`, backgroundImage: "var(--route-gradient)", backgroundSize: `${100 / Math.max(fraction, 0.001)}% 100%` }}
            />
            <div
              aria-hidden
              className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-line bg-paper shadow-chip"
              style={{ left: `${fraction * 100}%` }}
            />
            <input
              type="range"
              min={0}
              max={1000}
              step={1}
              value={Math.round(fraction * 1000)}
              onChange={(e) => scrub(Number(e.target.value) / 1000)}
              aria-label="Preview position"
              aria-valuetext={`${distanceLabel(doneM, units)} of ${distanceLabel(total, units)}`}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
          </div>
          <p className={`flex justify-between px-0.5 text-[11px] text-ink-muted tabular-nums ${compact ? "hidden" : ""}`}>
            <span>{distanceLabel(doneM, units)}</span>
            <span>{distanceLabel(total, units)}</span>
          </p>
        </div>

        <div role="group" aria-label="Preview speed" className="flex shrink-0 rounded-full bg-mist p-0.5">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => dispatch({ type: "preview_speed", speed: s })}
              aria-pressed={playback.speed === s}
              aria-label={`Speed ${s}×`}
              className={`h-7 rounded-full px-1.5 text-[11.5px] font-semibold tabular-nums transition-colors ${
                playback.speed === s ? "bg-primary text-on-primary" : "text-ink-muted hover:text-ink"
              }`}
            >
              {s}×
            </button>
          ))}
        </div>

        {compactWanted && (
          <button
            type="button"
            onClick={() => setProfileOpen((open) => !open)}
            aria-label="Profile"
            aria-pressed={profileOpen}
            title={profileOpen ? "Hide elevation profile" : "Show elevation profile"}
            className={`flex size-8 shrink-0 items-center justify-center rounded-full transition-colors ${
              profileOpen ? "bg-primary text-on-primary" : "text-ink-muted hover:bg-mist hover:text-ink"
            }`}
          >
            <Mountain aria-hidden size={16} strokeWidth={2} />
          </button>
        )}
        <button
          type="button"
          onClick={() => dispatch({ type: "preview_stop" })}
          aria-label="Exit preview"
          title="Exit (Esc)"
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-mist hover:text-ink"
        >
          <X aria-hidden size={16} strokeWidth={2.25} />
        </button>
      </div>
    </section>
  );

  return (
    <>
      <span ref={anchorRef} hidden />
      {isPhone && typeof document !== "undefined" ? (
        phoneBottom !== null &&
        createPortal(
          <div className="fixed inset-x-3 z-30" style={{ bottom: phoneBottom }}>
            {dock}
          </div>,
          document.body,
        )
      ) : (
        <div className="mb-2 w-full shrink-0 in-data-[chat-open=true]:px-3">{dock}</div>
      )}
    </>
  );
}
