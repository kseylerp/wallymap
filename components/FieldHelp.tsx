"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FieldHelp } from "@/layers/types";

/** The help as one line for a `title` (hover on chips and legend keys): the sentence, the scale, the source. */
export function helpTitle(help: FieldHelp | undefined): string | undefined {
  if (!help) return undefined;
  return [help.text, help.unit && `Unit: ${help.unit}.`, help.scale && `Scale: ${help.scale}.`, help.source && `Source: ${help.source}.`]
    .filter(Boolean)
    .join(" ");
}

/**
 * The small serif "i" ring (the top nav's "i", at field size) beside a number or code that needs explaining (spec
 * §12b). Pressing it opens a hairline popover with the sentence, the unit and scale, who computed it and the source
 * link; Escape, a second press or a click outside closes it. Text only, no icon font.
 */
export function InfoMark({ help, label }: { help: FieldHelp; label: string }) {
  const [open, setOpen] = useState(false);
  // Fixed to the window, under the mark, so a scrolling card or panel never clips it.
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const id = `help-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      // The popover lives in a portal: a press inside it (its link) is not outside.
      const inside = e.target instanceof Node && (ref.current?.contains(e.target) || document.getElementById(id)?.contains(e.target));
      if (!inside) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The popover's Escape closes only the popover, not the card around it.
      e.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, id]);
  return (
    <span ref={ref} className="relative inline-flex align-baseline">
      <button
        type="button"
        aria-label={`About ${label}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={helpTitle(help)}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          const width = Math.min(POPOVER_WIDTH, window.innerWidth - 2 * POPOVER_EDGE);
          setAt({ left: Math.min(Math.max(POPOVER_EDGE, r.left - 10), window.innerWidth - width - POPOVER_EDGE), top: r.bottom + 6 });
          setOpen((o) => !o);
        }}
        data-testid="info-mark"
        className="info-mark"
      >
        i
      </button>
      {open &&
        createPortal(
        <span id={id} role="note" data-testid="info-popover" className="info-popover" style={at ?? undefined}>
          <span className="block text-ink">{help.text}</span>
          {(help.unit || help.scale) && (
            <span className="mt-1 block text-ink-muted tabular-nums">
              {help.unit && <>Unit: {help.unit}</>}
              {help.unit && help.scale && " · "}
              {help.scale && <>Scale: {help.scale}</>}
            </span>
          )}
          {(help.source || help.url) && (
            <span className="mt-1 block text-ink-muted">
              {help.source ?? "Source"}
              {help.url && (
                <>
                  {" · "}
                  <a href={help.url} target="_blank" rel="noreferrer" className="dashed-link text-ink">
                    {hostOf(help.url)}
                  </a>
                </>
              )}
            </span>
          )}
        </span>,
          document.body,
        )}
    </span>
  );
}

const POPOVER_WIDTH = 260;
const POPOVER_EDGE = 12;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
