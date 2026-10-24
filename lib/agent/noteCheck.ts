import { factPool, ungroundedClaims, withoutClaims, type Claim } from "./grounding";
import type { Turn } from "./turn";
import { composeForTurn } from "./turnAnswer";

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
  // Numbers and names no result holds (lib/agent/grounding.ts): sent back once with each one named.
  if (!turn.noteRewrites.has("grounding")) {
    const claims = claimsOf(markdown, turn);
    if (claims.length > 0) {
      return {
        reason: "grounding",
        error:
          `These are not in any result this turn: ${claims.map((c) => c.why ?? c.text).join("; ")}. Call note again with only numbers, names and facts from the results ` +
          "(the summaries' stats, top lists, totals, dates and features, and each feature's own aspect, shade, class or status), converted between units if you like, or leave them out; " +
          "say in one clause what the app cannot show instead of filling it in.",
      };
    }
  }
  const words = noteWords(markdown);
  if (words > NOTE_MAX_WORDS && !turn.noteRewrites.has("long")) {
    return {
      reason: "long",
      error:
        `This note has ${words} words; a note stops at ${NOTE_MAX_WORDS}. Call note again with the same answer in at most 120 words: ` +
        "the answer with its deciding number first, the top options with the facts that decide them, one caveat, nothing else.",
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

/** What a note claims that this turn's results do not hold. */
export function claimsOf(markdown: string, turn: Pick<Turn, "outputs" | "question">): Claim[] {
  if (turn.outputs.length === 0) return [];
  return ungroundedClaims(markdown, factPool(turn.outputs, turn.question));
}

/** The note with its ungrounded sentences cut (logged on the turn), or null when it holds none. */
export function groundedNote(markdown: string, turn: Pick<Turn, "outputs" | "question" | "note">): string | null {
  const claims = claimsOf(markdown, turn);
  if (claims.length === 0) return null;
  const kept = withoutClaims(markdown, claims);
  turn.note(`cut from the note, not in any result: ${claims.map((c) => c.why ?? c.text).join("; ")}`);
  return kept;
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

/** Words of a question that a sentence answering part of it repeats ("avalanche", "alerts", "snow"). */
const STOP = new Set(["what", "which", "where", "when", "there", "here", "this", "that", "with", "near", "from", "have", "been", "your", "about", "going", "like", "around", "right", "under", "over", "make", "made", "does", "much", "many", "good", "best", "some"]);
function questionWords(question: string): string[] {
  return [...new Set(question.toLowerCase().replace(/@view=\S+/g, " ").split(/[^a-z]+/).filter((w) => w.length >= 4 && !STOP.has(w)))].map((w) => w.replace(/(?:ies|es|s)$/, ""));
}

/**
 * Sentences the server adds because the answer is wrong without them (lib/agent/answer.ts, turnAnswer.ts): a rule the
 * person must follow, how close the nearest threat comes, what is closed, and what no free source can say. Kept
 * right after the lead when a long note is cut (Mount Rainier's permit and the whitewater data gap were cut last).
 */
const KEEP = /^(?:Camping rule here:|Closest to |Closed now:|No free source\b)/;

/**
 * The note cut within `max` words by what matters: the lead line and the option list first, then the sentences that
 * answer another part of the question (Lake Tahoe's "no avalanche danger rating today" was cut as the note's last line
 * while sentences about the map stayed), then the rest; sentences that only say what the map or its colors show go
 * first. What is kept stays in its order.
 */
export function trimNoteFor(markdown: string, question: string, max = NOTE_MAX_WORDS): string {
  if (noteWords(markdown) <= max) return markdown;
  const asked = questionWords(question);
  type Unit = { line: number; text: string; rank: number; words: number };
  const units: Unit[] = [];
  const lines = markdown.split("\n");
  const isHeading = (line: string) => /^\s*(?:#{1,6}\s|\*\*[^*]+\*\*\s*$)/.test(line);
  let lead = -1;
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    if (isHeading(line)) {
      units.push({ line: i, text: line, rank: 0, words: noteWords(line) });
      return;
    }
    const bullet = /^\s*(?:[-*+]|\d+\.)\s+/.test(line);
    if (lead === -1) lead = i;
    for (const text of bullet ? [line] : line.split(/(?<=[.!?])\s+/)) {
      const t = text.toLowerCase();
      const mapOnly = /\b(?:colou?r(?:ed)?\s+is|the\s+map\s+(?:shows|draws)|legend|sage\s+low|darker\s+(?:means|=))/.test(t);
      const answers = asked.some((w) => t.includes(w));
      const rank = i === lead ? 0 : KEEP.test(text) ? 0.25 : mapOnly ? 3 : bullet || answers ? 1 : 2;
      units.push({ line: i, text, rank, words: noteWords(text) });
    }
  });
  // A sentence that answers a part of the question the lead does not ("any avalanche danger?" after a snow lead) comes
  // right after the lead, before the options.
  const leadText = units.filter((u) => u.rank === 0).map((u) => u.text.toLowerCase()).join(" ");
  for (const u of units) {
    if (u.rank === 0 || u.rank === 0.25 || u.rank === 3) continue;
    const t = u.text.toLowerCase();
    if (asked.some((w) => t.includes(w) && !leadText.includes(w))) u.rank = 0.5;
  }
  let used = 0;
  const keep = new Set<Unit>();
  for (const rank of [0, 0.25, 0.5, 1, 2, 3]) {
    for (const u of units) {
      if (u.rank !== rank || used + u.words > max) continue;
      keep.add(u);
      used += u.words;
    }
  }
  // The kept units by line, in order; a blank line stays where the note had one between kept lines.
  const out: string[] = [];
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    const kept = units.filter((u) => u.line === i && keep.has(u));
    if (kept.length === 0) continue;
    if (last !== -1 && lines.slice(last + 1, i).some((l) => l.trim() === "")) out.push("");
    out.push(kept.map((u) => u.text).join(" "));
    last = i;
  }
  // A heading with nothing kept under it goes.
  while (out.length > 0 && (isHeading(out[out.length - 1]) || out[out.length - 1].trim() === "")) out.pop();
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
  // What is still not in any result after the rewrite (or with no step left to rewrite) is cut, never shown.
  const grounded = groundedNote(markdown, turn) ?? markdown;
  // The answer's shape (lib/agent/compose.ts): the deciding number first, the top options with their facts, then the
  // model's caveats; whatever the composition carried that no result holds is cut too.
  const composed = composeForTurn(grounded, turn);
  const shown = composed === grounded ? composed : (groundedNote(composed, turn) ?? composed);
  if (noteWords(shown) > NOTE_MAX_WORDS) {
    turn.note(`note cut from ${noteWords(shown)} to ${NOTE_MAX_WORDS} words or fewer`);
    return { markdown: trimNoteFor(shown, turn.question) };
  }
  return shown === markdown ? null : { markdown: shown };
}
