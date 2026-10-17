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
  // A data story (spec §13): the note follows the data's shape, ending with what size or brightness and color mean.
  const story = turn.queries.findLast((q) => q.ok && q.caption !== undefined)?.caption;
  if (story && !turn.noteRewrites.has("story") && !followsStory(markdown)) {
    return {
      reason: "story",
      error:
        "This answer is a data story: the note gives the low and the peak with numbers and dates, the ratio, whether it repeats, what drives it, " +
        "and ends with one sentence on what width, size or brightness and color mean. Call note again built on this caption, in plain sentences " +
        `and at most 120 words: ${story}`,
    };
  }
  return null;
}

/** True when a note has a story's shape: two numbers or more, a peak, and what size or brightness and color mean. */
export function followsStory(markdown: string): boolean {
  const text = markdown.toLowerCase();
  const numbers = (text.match(/\d[\d,.]*/g) ?? []).length;
  const peak = /\b(peak|high|highest|max|maximum|strongest|fastest|top)/.test(text);
  const color = /\bcolou?r/.test(text);
  const size = /\b(width|wide|wider|thick|size|bright|brightness)/.test(text);
  return numbers >= 2 && peak && color && size;
}

/**
 * The note cut to whole lines (or, inside a line, whole sentences) within `max` words, so a note never runs past the
 * limit even when its rewrite is still long or no step is left to rewrite it. Headings left with nothing under them go.
 */
export function trimNote(markdown: string, max = NOTE_MAX_WORDS): string {
  if (noteWords(markdown) <= max) return markdown;
  const out: string[] = [];
  let used = 0;
  for (const line of markdown.split("\n")) {
    const words = noteWords(line);
    if (used + words <= max) {
      out.push(line);
      used += words;
      continue;
    }
    // The first line that does not fit keeps the sentences that do.
    let kept = "";
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const n = noteWords(sentence);
      if (used + n > max) break;
      kept = kept ? `${kept} ${sentence}` : sentence;
      used += n;
    }
    if (kept) out.push(kept);
    break;
  }
  while (out.length > 0 && (/^\s*(?:#{1,6}\s|\*\*[^*]+\*\*\s*$)/.test(out[out.length - 1]) || out[out.length - 1].trim() === "")) out.pop();
  return out.join("\n").trimEnd();
}

/**
 * The note tool's check: an error the model rewrites from (logged on the turn), the note cut to the word limit (a
 * rewrite still too long, or no step left to rewrite it), or null to show the note as written.
 */
export function checkNote(markdown: string, turn: Turn, opts: { lastStep?: boolean } = {}): { error: string } | { markdown: string } | null {
  const problem = noteProblem(markdown, turn);
  if (problem && !opts.lastStep) {
    turn.noteRewrites.add(problem.reason);
    turn.note(`note sent back to rewrite (${problem.reason}): ${problem.error.split(";")[0].split(":")[0]}`);
    return { error: problem.error };
  }
  turn.noted = true;
  if (noteWords(markdown) > NOTE_MAX_WORDS) {
    turn.note(`note cut from ${noteWords(markdown)} to ${NOTE_MAX_WORDS} words or fewer`);
    return { markdown: trimNote(markdown) };
  }
  return null;
}
