/**
 * Free disk for the eval's screen checks (scripts/evalScreens.ts): a dev server, Chromium and screenshots fill the disk
 * fast. Screens refuse to start under START_MIN_FREE and the run stops cleanly under RUN_MIN_FREE; the guard keeps the
 * lowest free space it saw, so the run can say how much disk it used at its peak.
 */
import { statfsSync } from "node:fs";

const GB = 1024 ** 3;
/** Screens do not start with less free disk than this. */
export const START_MIN_FREE = 5 * GB;
/** A run stops cleanly when free disk drops under this. */
export const RUN_MIN_FREE = 2 * GB;

/** Free bytes for this user on the disk holding `path`. */
export function freeBytes(path = "/"): number {
  const s = statfsSync(path);
  return s.bavail * s.bsize;
}

/** Bytes as "1.2 GB" or "340 MB". */
export function sizeText(bytes: number): string {
  return bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export type DiskGuard = {
  /** True once free disk dropped under RUN_MIN_FREE: finish the current step, clean up and stop. */
  low: () => boolean;
  /** Reads free disk now (also done on a timer) and returns it. */
  sample: () => number;
  /** "disk used at peak 1.4 GB (free 27.0 GB at the start, 25.6 GB at the lowest)". */
  report: () => string;
  stop: () => void;
};

/** Watches free disk every `everyMs` from now on; `onLow` runs once when it drops under RUN_MIN_FREE. */
export function watchDisk(onLow: (free: number) => void = () => {}, everyMs = 2000, read: () => number = freeBytes): DiskGuard {
  const start = read();
  let lowest = start;
  let isLow = false;
  const sample = () => {
    const free = read();
    lowest = Math.min(lowest, free);
    if (!isLow && free < RUN_MIN_FREE) {
      isLow = true;
      onLow(free);
    }
    return free;
  };
  const timer = setInterval(sample, everyMs);
  timer.unref();
  return {
    low: () => isLow,
    sample,
    report: () => `disk used at peak ${sizeText(Math.max(0, start - lowest))} (free ${sizeText(start)} at the start, ${sizeText(lowest)} at the lowest)`,
    stop: () => clearInterval(timer),
  };
}
