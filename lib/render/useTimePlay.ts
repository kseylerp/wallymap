"use client";

import { useEffect } from "react";
import type { MapAction } from "@/lib/render/state";

/** Play advances one bucket this often (spec §5). */
export const PLAY_STEP_MS = 600;

/**
 * Drives the time scrubber's play: while `playing`, dispatches `time_tick` every 600 ms. It lives in the app, not in
 * the scrubber, so play keeps going while the layer panel (and the scrubber in it) is closed.
 */
export function useTimePlay(playing: boolean, dispatch: (action: MapAction) => void): void {
  useEffect(() => {
    if (!playing) return;
    const id = globalThis.setInterval(() => dispatch({ type: "time_tick" }), PLAY_STEP_MS);
    return () => globalThis.clearInterval(id);
  }, [playing, dispatch]);
}
