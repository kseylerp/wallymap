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

/** "query_osm-trails" reads as "query osm-trails". */
const labelFor = (name: string) => name.replace(/_/g, " ");

/**
 * One hairline row per tool call, in the research-console style: a small-caps monospace label, a 1px ink ring
 * while the call runs and a "·" once it is done, the feature count, and the elapsed time in tabular figures at the
 * right. The input is behind a disclosure. No colors, no spinner.
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

  return (
    <div data-testid="tool-trace" className="text-[12px] text-ink-muted">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-7 w-full items-center gap-2 py-1 text-left transition-colors hover:text-ink"
      >
        {finished ? (
          <span aria-hidden className="w-2 shrink-0 text-center leading-none">
            ·
          </span>
        ) : (
          <span aria-hidden className="trace-dot size-2 shrink-0 rounded-full border border-ink" />
        )}
        <span className="trace-label font-mono">{labelFor(name)}</span>
        {failed && <span>· failed</span>}
        {count !== null && <span className="tabular-nums">· {count.toLocaleString()} features</span>}
        <span className="ml-auto pl-2 tabular-nums">{finished && elapsedMs !== null ? `${elapsedMs} ms` : ""}</span>
      </button>
      {open && (
        <pre className="max-h-48 overflow-auto border-t border-line py-2 pl-4 font-mono text-[11px] break-all whitespace-pre-wrap text-ink-muted">
          {preview(input)}
          {errorText ? `\n${errorText}` : ""}
        </pre>
      )}
    </div>
  );
}
