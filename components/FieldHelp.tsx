"use client";

import { useEffect, useId, useRef, useState } from "react";
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
  const id = `help-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) setOpen(false);
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
  }, [open]);
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
          setOpen((o) => !o);
        }}
        data-testid="info-mark"
        className="info-mark"
      >
        i
      </button>
      {open && (
        <span id={id} role="note" data-testid="info-popover" className="info-popover">
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
        </span>
      )}
    </span>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
