import type { Turn } from "./turn";

/**
 * The note is the answer (lib/agent/prompt.ts): about 120 words, and for a question that asks which ranks highest, it
 * names the top one. A note that breaks either comes back once per reason as an error the model rewrites from, so the
 * rule holds in code rather than in the model's memory of the prompt.
 */

/** Words a note may run to before it comes back (the prompt asks for about 120; the eval fails over 150). */
export const NOTE_MAX_WORDS = 140;

/** Words in markdown, as the eval counts them: markup dropped, only tokens with a letter or digit. */
export function noteWords(markdown: string): number {
  return markdown.replace(/[#*_`>|-]+/g, " ").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** A question that asks for the top of a ranking: highest, largest and the like, or "which … most". */
const SUPERLATIVE = /\b(?:highest|largest|biggest|deepest|tallest|longest|strongest|hottest|warmest|worst)\b/i;
const WHICH_MOST = /\b(?:which|what)\b[^?]*\b(?:most|top)\b/i;

export function asksForTop(question: string): boolean {
  return SUPERLATIVE.test(question) || WHICH_MOST.test(question);
}

/** Lower case, straight apostrophes and hyphens, single spaces. */
function comparable(text: string): string {
  // Models write "NA‑0420" with a non-breaking hyphen and "6 000" with a narrow space; those are the same name.
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019`]/g, "'")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\s\u00a0\u202f]+/g, " ");
}

/** True when the note names `name`, with or without a trailing "(A)" or "(mine 123)" tag. */
function names(note: string, name: string): boolean {
  const n = comparable(note);
  const full = comparable(name);
  const bare = full.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return n.includes(full) || (bare.length >= 3 && n.includes(bare));
}

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/**
 * The reason to send a note back, or null to show it. Each reason is used once per turn, so a second note always shows.
 */
export function noteProblem(markdown: string, turn: Turn): { reason: string; error: string } | null {
  const words = noteWords(markdown);
  if (words > NOTE_MAX_WORDS && !turn.noteRewrites.has("long")) {
    return {
      reason: "long",
      error:
        `This note has ${words} words; a note stops at ${NOTE_MAX_WORDS}. Call note again with the same answer in at most 120 words: ` +
        "one line on what is drawn, two to four findings with numbers, one caveat, nothing else.",
    };
  }
  if (asksForTop(turn.question) && !turn.noteRewrites.has("top")) {
    // The layer drawn as a ranking, else the last one queried with a named top.
    const ranked = turn.queries.find((q) => q.ok && q.top !== undefined && turn.views.get(q.layerId) === "ranked");
    const top = (ranked ?? turn.queries.findLast((q) => q.ok && q.top !== undefined))?.top;
    if (top && !names(markdown, top.name)) {
      const unit = top.unit && top.unit !== "score" ? ` ${top.unit}` : "";
      return {
        reason: "top",
        error:
          `The question asks which ranks highest, and the note does not name the top one: ${top.name} (${top.by} ${fmt(top.value)}${unit}). ` +
          "Call note again with it named first, then the next ones, keeping the rest of the answer.",
      };
    }
  }
  return null;
}

/** The note tool's check: an error the model rewrites from (logged on the turn), or null to show the note as written. */
export function checkNote(markdown: string, turn: Turn): { error: string } | null {
  const problem = noteProblem(markdown, turn);
  if (!problem) return null;
  turn.noteRewrites.add(problem.reason);
  turn.note(`note sent back to rewrite (${problem.reason}): ${problem.error.split(";")[0].split(":")[0]}`);
  return { error: problem.error };
}
