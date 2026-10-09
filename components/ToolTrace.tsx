"use client";

import { useEffect, useState } from "react";
import { DotSpinner } from "@/components/DotSpinner";

const INPUT_PREVIEW_CHARS = 300;

type ToolTraceProps = {
  name: string;
  /** The tool part's state, e.g. "input-streaming" or "output-available". */
  state: string;
  input: unknown;
  output: unknown;
  errorText?: string;
};

function featureCount(output: unknown): number | null {
  if (typeof output !== "object" || output === null) return null;
  const record = output as Record<string, unknown>;
  const collection = record.type === "FeatureCollection" ? record : record.data;
  if (typeof collection !== "object" || collection === null) return null;
  const fc = collection as Record<string, unknown>;
  return fc.type === "FeatureCollection" && Array.isArray(fc.features) ? fc.features.length : null;
}

function preview(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  return text.length > INPUT_PREVIEW_CHARS ? `${text.slice(0, INPUT_PREVIEW_CHARS)}…` : text;
}

/**
 * One small chip per tool call: Wally's 3×3 dot spinner while it runs, then a 6px dot (green when done, red when it
 * failed); name, feature count, and elapsed time. The input is behind a disclosure.
 */
export function ToolTrace({ name, state, input, output, errorText }: ToolTraceProps) {
  const [open, setOpen] = useState(false);
  // Timed from when this row first mounts (the part first appears) until its output lands.
  const [startedAt] = useState(() => performance.now());
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const finished = state === "output-available" || state === "output-error" || state === "output-denied";

  useEffect(() => {
    if (!finished || elapsedMs !== null) return;
    const frame = requestAnimationFrame(() => setElapsedMs(Math.round(performance.now() - startedAt)));
    return () => cancelAnimationFrame(frame);
  }, [finished, elapsedMs, startedAt]);

  const count = featureCount(output);
  const failed = state === "output-error";
  const dot = failed ? "bg-danger" : "bg-moss";

  return (
    <div
      data-testid="tool-trace"
      className={[
        "text-xs text-ink-muted",
        open ? "basis-full overflow-hidden rounded-2xl border border-line bg-paper" : "rounded-pill bg-mist",
      ].join(" ")}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-7 w-full items-center gap-1.5 rounded-pill px-2.5 py-1 text-left transition-colors hover:text-ink"
      >
        {finished ? (
          <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${dot}`} />
        ) : (
          <DotSpinner className="shrink-0 text-ink-muted" />
        )}
        <span className={`font-mono text-[11px] ${failed ? "text-danger" : "text-ink"}`}>{name}</span>
        {count !== null && <span className="tabular-nums">· {count.toLocaleString()} features</span>}
        <span className={`tabular-nums ${open ? "ml-auto" : ""}`}>
          {!finished ? "…" : elapsedMs !== null ? `· ${elapsedMs} ms` : ""}
        </span>
      </button>
      {open && (
        <pre className="max-h-48 overflow-auto border-t border-line px-3 py-2 font-mono text-[11px] break-all whitespace-pre-wrap text-ink-muted">
          {preview(input)}
          {errorText ? `\n${errorText}` : ""}
        </pre>
      )}
    </div>
  );
}
