"use client";

import { useEffect } from "react";
import type { MapAction } from "@/lib/render/state";

/** Play advances one bucket this often (spec §5); a series steps faster (lib/render/playhead.ts playStepMs). */
export const PLAY_STEP_MS = 600;

/**
 * Drives the time scrubber's play: while `playing`, dispatches `time_tick` every `stepMs` (600 ms by default). It lives
 * in the app, not in the scrubber, so play keeps going while the layer panel (and the scrubber in it) is closed. A
 * hidden tab does not step, so play waits where it was.
 */
export function useTimePlay(playing: boolean, dispatch: (action: MapAction) => void, stepMs: number = PLAY_STEP_MS): void {
  useEffect(() => {
    if (!playing) return;
    const id = globalThis.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      dispatch({ type: "time_tick" });
    }, stepMs);
    return () => globalThis.clearInterval(id);
  }, [playing, dispatch, stepMs]);
}
