"use client";

import { useEffect } from "react";
import type { TimeIndex } from "@/lib/time";
import { frameIndex } from "@/lib/render/series";
import type { TimeState } from "@/lib/render/state";
import { createStore } from "@/lib/render/wally/playback";

/**
 * The playhead between frames (spec §13: "frames step daily with smooth transitions between days"). The reducer steps
 * the scrubber one whole frame at a time; while it plays, this store glides from the frame shown toward the next one
 * over the step's duration, every animation frame, so the live total, the river widths and the particles move smoothly
 * instead of jumping. Paused, it sits on the frame. Read it outside React (the map) or with useSyncExternalStore.
 */
export const playheadStore = createStore<number>(0);

/** How long one play step lasts: an hourly series 120 ms, a daily one 250 ms, dated features 600 ms (spec §5). */
export function playStepMs(index: Pick<TimeIndex, "series"> | undefined): number {
  if (index?.series?.step === "hour") return 120;
  if (index?.series?.step === "day") return 250;
  return 600;
}

/** A step length set by a recording (the video export), which plays the whole timeline in its own time. */
export const stepOverrideStore = createStore<number | null>(null);

/**
 * Drives the playhead from the scrubber's frame: on each step it restarts the glide from the new frame, and while
 * playing it moves toward the next frame every animation frame (paused while the tab is hidden).
 */
export function usePlayhead(time: TimeState | undefined, stepMs: number): void {
  const frame = time ? frameIndex(time) : 0;
  const last = time ? time.index.buckets.length - 1 : 0;
  const playing = time?.playing ?? false;
  useEffect(() => {
    playheadStore.set(frame);
    if (!playing || frame >= last) return;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      if (!document.hidden) playheadStore.set(Math.min(frame + 1, frame + Math.max(0, now - start) / stepMs));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [frame, last, playing, stepMs]);
}
