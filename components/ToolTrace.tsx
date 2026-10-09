"use client";

import { useEffect, useState } from "react";

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

/** One compact row per tool call: name, feature count, and elapsed time; the input is behind a disclosure. */
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

  return (
    <div data-testid="tool-trace" className="rounded-md border border-neutral-200 bg-neutral-50 text-xs text-neutral-600">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left font-mono"
      >
        <span aria-hidden className="text-neutral-400">{open ? "▾" : "▸"}</span>
        <span className={failed ? "text-red-700" : "text-neutral-800"}>{name}</span>
        {count !== null && <span>features: {count}</span>}
        <span className="ml-auto tabular-nums">
          {!finished ? "…" : elapsedMs !== null ? `${elapsedMs} ms` : ""}
        </span>
      </button>
      {open && (
        <pre className="overflow-x-auto border-t border-neutral-200 px-2 py-1 font-mono break-all whitespace-pre-wrap">
          {preview(input)}
          {errorText ? `\n${errorText}` : ""}
        </pre>
      )}
    </div>
  );
}
