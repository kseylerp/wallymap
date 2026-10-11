"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { suggestionSet } from "@/lib/suggestions";

/** Set once the suggestions card has been dismissed or a question has been sent; the card opens by itself only without it. */
export const SUGGESTIONS_SEEN_KEY = "wallymap.suggestionsSeen";

/** The number of the question set shown last (0 is the six starters); each later open or "More" moves to the next, so reloads keep rotating. */
export const SUGGESTIONS_SET_KEY = "wallymap.suggestionsSet";

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

function readSetIndex(): number {
  try {
    const n = Number(window.localStorage.getItem(SUGGESTIONS_SET_KEY));
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeSetIndex(index: number) {
  try {
    window.localStorage.setItem(SUGGESTIONS_SET_KEY, String(index));
  } catch {
    // Nothing to remember it with; the rotation restarts after a reload.
  }
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => void listeners.delete(notify);
}

/**
 * Whether the suggestions card shows. The server cannot read storage, so it renders the card closed; the browser then
 * opens it on the first visit only. Closing it, or sending a question, marks it seen for good; the top-row "i" pill
 * can still toggle it (an explicit choice, held until the page reloads).
 *
 * The questions: the automatic first open shows the six starters. Every later open (the pill) and every "More" press
 * moves to the next set from the pool (lib/suggestions.ts), and the number of the last set shown is stored.
 */
export function useSuggestionsCard() {
  const seen = useSyncExternalStore(subscribe, readSeen, () => true);
  // Null until the pill or the × decides; then it wins over the stored flag.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? !seen;
  // The set shown now; 0 is the starters. Held in state too, so a blocked storage still rotates within the page.
  const [setIndex, setSetIndex] = useState(0);
  const questions = useMemo(() => suggestionSet(setIndex), [setIndex]);
  const nextSet = useCallback(() => {
    const next = Math.max(readSetIndex(), setIndex) + 1;
    writeSetIndex(next);
    setSetIndex(next);
  }, [setIndex]);
  // A sent question hands control back to the stored flag: a card the pill had opened before the first message closes.
  const markSeen = useCallback(() => {
    writeSeen();
    setChosen(null);
  }, []);
  const close = useCallback(() => {
    setChosen(false);
    writeSeen();
  }, []);
  const toggle = useCallback(() => {
    if (open) writeSeen();
    else nextSet();
    setChosen(!open);
  }, [open, nextSet]);
  return { open, close, toggle, markSeen, questions, more: nextSet };
}
