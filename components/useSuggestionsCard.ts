"use client";

import { useCallback, useState, useSyncExternalStore } from "react";

/** Set once the suggestions card has been dismissed or a question has been sent; the card opens by itself only without it. */
export const SUGGESTIONS_SEEN_KEY = "wallymap.suggestionsSeen";

const listeners = new Set<() => void>();

function readSeen(): boolean {
  try {
    return window.localStorage.getItem(SUGGESTIONS_SEEN_KEY) !== null;
  } catch {
    // Storage blocked (private window, site data off): treat as unseen, so the card still shows.
    return false;
  }
}

function writeSeen() {
  try {
    window.localStorage.setItem(SUGGESTIONS_SEEN_KEY, "1");
  } catch {
    // Nothing to remember it with; the card simply opens next visit too.
  }
  for (const notify of listeners) notify();
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => void listeners.delete(notify);
}

/**
 * Whether the suggestions card shows. The server cannot read storage, so it renders the card closed; the browser then
 * opens it on the first visit only. Closing it, or sending a question, marks it seen for good; the top-row "i" pill
 * can still toggle it (an explicit choice, held until the page reloads).
 */
export function useSuggestionsCard() {
  const seen = useSyncExternalStore(subscribe, readSeen, () => true);
  // Null until the pill or the × decides; then it wins over the stored flag.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? !seen;
  const markSeen = useCallback(() => writeSeen(), []);
  const close = useCallback(() => {
    setChosen(false);
    writeSeen();
  }, []);
  const toggle = useCallback(() => {
    if (open) writeSeen();
    setChosen(!open);
  }, [open]);
  return { open, close, toggle, markSeen };
}
