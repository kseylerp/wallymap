import type { UIMessage } from "ai";
import { isToolUIPart } from "ai";

/** When one tool call was first seen and when its result arrived, as `Date.now()` milliseconds. */
export type ToolTiming = { startedAt: number; endedAt?: number };

export type ToolTimings = Record<string, ToolTiming>;

const FINISHED = new Set(["output-available", "output-error", "output-denied"]);

/** The SDK's tool parts carry no timestamps, so the client records them (the tool call id keys each one). */
export function observeToolTimings(messages: readonly UIMessage[], prev: ToolTimings, now: number): ToolTimings {
  let next: ToolTimings | null = null;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const saved = timingsFromMetadata(message);
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      const id = part.toolCallId;
      if (saved[id]) continue;
      const finished = FINISHED.has(part.state);
      const known = (next ?? prev)[id];
      // A call first seen already finished (a restored conversation) has no honest duration, so it gets none.
      if (!known && finished) continue;
      if (!known) {
        next ??= { ...prev };
        next[id] = { startedAt: now };
      } else if (finished && known.endedAt === undefined) {
        next ??= { ...prev };
        next[id] = { startedAt: known.startedAt, endedAt: now };
      }
    }
  }
  return next ?? prev;
}

/** Timings stored on a message's metadata under `toolTimings`; only complete entries count. */
export function timingsFromMetadata(message: UIMessage): ToolTimings {
  const meta = message.metadata;
  if (typeof meta !== "object" || meta === null) return {};
  const raw = (meta as { toolTimings?: unknown }).toolTimings;
  if (typeof raw !== "object" || raw === null) return {};
  const out: ToolTimings = {};
  for (const [id, value] of Object.entries(raw)) {
    const t = value as Partial<ToolTiming> | null;
    if (t && typeof t.startedAt === "number" && typeof t.endedAt === "number") out[id] = { startedAt: t.startedAt, endedAt: t.endedAt };
  }
  return out;
}

/**
 * Copies every finished timing onto its message's metadata so it travels with the message. Returns null when
 * there is nothing new to write.
 */
export function stampTimingMetadata(messages: readonly UIMessage[], timings: ToolTimings): UIMessage[] | null {
  let changed = false;
  const out = messages.map((message) => {
    if (message.role !== "assistant") return message;
    const saved = timingsFromMetadata(message);
    const add: ToolTimings = {};
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      const t = timings[part.toolCallId];
      if (t?.endedAt !== undefined && !saved[part.toolCallId]) add[part.toolCallId] = t;
    }
    if (Object.keys(add).length === 0) return message;
    changed = true;
    const meta = typeof message.metadata === "object" && message.metadata !== null ? message.metadata : {};
    return { ...message, metadata: { ...meta, toolTimings: { ...saved, ...add } } } as UIMessage;
  });
  return changed ? out : null;
}

/** The step's own duration, or null while it is running or when it was never timed. */
export function durationOf(timing: ToolTiming | undefined): number | null {
  if (!timing || timing.endedAt === undefined) return null;
  return Math.max(0, timing.endedAt - timing.startedAt);
}

/** "840 ms" under a second, "1.4 s" up to ten, then whole seconds, then "1 m 42 s". */
export function formatDuration(ms: number): string {
  const rounded = Math.max(0, Math.round(ms));
  if (rounded < 1000) return `${rounded} ms`;
  if (rounded < 9950) return `${(rounded / 1000).toFixed(1)} s`;
  const seconds = Math.round(rounded / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} m ${seconds % 60} s`;
}

/** A tiny external store for the timings, so recording one (from an effect) re-renders readers without setState. */
export function createTimingStore() {
  let timings: ToolTimings = {};
  const listeners = new Set<() => void>();
  return {
    get: () => timings,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    observe(messages: readonly UIMessage[], now: number) {
      const next = observeToolTimings(messages, timings, now);
      if (next === timings) return;
      timings = next;
      listeners.forEach((l) => l());
    },
  };
}
