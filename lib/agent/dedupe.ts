/** The few fields of a UI message part this check reads. Real `UIMessage` parts satisfy it. */
export type DedupePart = {
  type: string;
  text?: string;
  output?: unknown;
  state?: string;
};

const HEAD = 60;

/** Comparison key: markdown emphasis removed, whitespace collapsed and trimmed. */
function normalize(text: string): string {
  return text.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
}

function noteMarkdown(part: DedupePart): string | null {
  if (part.type !== "tool-note") return null;
  const out = part.output;
  if (typeof out !== "object" || out === null || !("markdown" in out)) return null;
  return typeof out.markdown === "string" ? out.markdown : null;
}

function sameStart(note: string, text: string): boolean {
  if (note === "" || text === "") return false;
  // Short strings must match whole; longer ones match when their first 60 characters agree.
  if (note.length < HEAD || text.length < HEAD) return note === text;
  return note.slice(0, HEAD) === text.slice(0, HEAD);
}

/**
 * The model often writes its answer in the `note` tool and then says it again as its closing text.
 * Returns the indexes of `note` parts whose card repeats a later text part, so the caller can skip those
 * cards and show only the text (which also carries the follow-up questions).
 */
export function dedupeNoteAndText(parts: readonly DedupePart[]): Set<number> {
  const hidden = new Set<number>();
  parts.forEach((part, i) => {
    const note = noteMarkdown(part);
    if (note === null) return;
    const normalizedNote = normalize(note);
    for (let j = i + 1; j < parts.length; j++) {
      const later = parts[j];
      if (later.type !== "text" || typeof later.text !== "string") continue;
      if (sameStart(normalizedNote, normalize(later.text))) {
        hidden.add(i);
        return;
      }
    }
  });
  return hidden;
}
