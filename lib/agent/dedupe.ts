import { extractFollowUps } from "./followups";

/** The few fields of a UI message part this check reads. Real `UIMessage` parts satisfy it. */
export type DedupePart = {
  type: string;
  text?: string;
  output?: unknown;
  state?: string;
};

/** What an assistant text part renders as: markdown, then follow-up questions shown as buttons. */
export type TrimmedAnswer = { body: string; followUps: string[] };

/**
 * Headings whose whole section never belongs in the text after a note: the note already is the answer, and the
 * sources line is drawn from citations under every answer. Matched against the heading's plain words.
 */
const REPEATED_HEADING =
  /^(?:sources?|references?|citations?|data sources?|next steps?|what to do next|what you can do next|suggested next steps|coverage(?: notes?| gaps?)?|caveats?|notes?|summary|key findings|findings|what(?:'s| is) (?:drawn|on the map|shown)|follow[- ]?up(?: questions?)?)$/i;

/** Sections the note card itself drops: the sources line under the answer already lists every citation. */
const SOURCES_HEADING = /^(?:sources?|references?|citations?|data sources?)$/i;

/** A markdown heading, a bold-only line ("**Next steps**", "**Sources:**") or a bare label line ("Next steps:"). */
const HEADING_LINE = /^\s*(?:#{1,6}\s+(.+?)\s*#*\s*|(?:\*\*|__)(.+?)(?:\*\*|__)\s*|([A-Z][\w' -]{1,40}):)\s*$/;

/** A label with its content on the same line: "Sources: GFW, NASA" or "**Sources:** GFW". */
const LABEL_LINE = /^\s*(?:\*\*|__)?([A-Z][\w' -]{1,40}?)\s*(?:(?:\*\*|__)\s*:|:\s*(?:\*\*|__)?)\s*\S/;

const BULLET_LINE = /^(?:[-*+]|\d+[.)])\s+\S/;
const CONTINUATION_LINE = /^\s+\S/;

/** Shares of a paragraph's words found in the note at or above which the paragraph counts as a repeat. */
export const REPEAT_THRESHOLD = 0.6;

const STOPWORDS = new Set(
  "the and for with this that these those from into over under are was were has have had not but you your its it's they them their there here than then also only about which what when where who how all any can may more most some such each per one two".split(
    " ",
  ),
);

/** A heading line's plain words, or null when the line is not a heading. */
function headingText(line: string): string | null {
  const m = HEADING_LINE.exec(line);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? "").replace(/[*_`:]/g, "").replace(/^\p{Extended_Pictographic}\s*/u, "").trim();
}

/**
 * Drops every section whose heading matches `heading` (the heading through the line before the next heading of any
 * kind, or only through its first paragraph with `paragraph`) and every one-line label with that name ("Sources: ...").
 */
function dropSections(markdown: string, heading: RegExp, { paragraph = false }: { paragraph?: boolean } = {}): string {
  const out: string[] = [];
  let skipping = false;
  let seenContent = false;
  for (const line of markdown.split("\n")) {
    if (skipping && paragraph && line.trim() === "") {
      if (seenContent) skipping = false;
      continue;
    }
    const title = headingText(line);
    if (title !== null) {
      skipping = heading.test(title);
      seenContent = false;
      if (!skipping) out.push(line);
      continue;
    }
    if (skipping) {
      seenContent = true;
      continue;
    }
    const label = LABEL_LINE.exec(line)?.[1];
    if (label !== undefined && heading.test(label.trim())) continue;
    out.push(line);
  }
  return out.join("\n");
}

/** Lowercase words of three or more letters or any digits, without common filler words. */
function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu) ?? []).filter(
    (w) => (w.length >= 3 || /\d/.test(w)) && !STOPWORDS.has(w),
  );
}

/** The share of `paragraph`'s words that also appear in `noteWords` (0 when it has none). */
export function repeatShare(paragraph: string, noteWords: ReadonlySet<string>): number {
  const own = words(paragraph);
  if (own.length === 0) return 0;
  return own.filter((w) => noteWords.has(w)).length / own.length;
}

/** Paragraphs (blocks between blank lines) of `markdown` that do not mostly repeat the note. */
function dropRepeats(markdown: string, note: string): string {
  const noteWords = new Set(words(note));
  const blocks = markdown.split(/\n\s*\n/).filter((block) => {
    if (block.trim() === "") return false;
    return repeatShare(block, noteWords) < REPEAT_THRESHOLD;
  });
  // A heading left with nothing under it goes too.
  while (blocks.length > 0 && headingText(blocks[blocks.length - 1].trim().split("\n").at(-1) ?? "") !== null) blocks.pop();
  return blocks.join("\n\n").trim();
}

/** The trailing bulleted list (bullets and their wrapped lines) of `markdown`, or "" when it does not end in one. */
function trailingList(markdown: string): string {
  const lines = markdown.replace(/\s+$/, "").split("\n");
  let start = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (BULLET_LINE.test(line)) start = i;
    else if (line.trim() === "" || CONTINUATION_LINE.test(line)) continue;
    else break;
  }
  if (start === lines.length) return "";
  return lines.slice(start).join("\n").trim();
}

/**
 * What an assistant text part that follows a `note` call shows. The note is the answer, so the text is capped at its
 * trailing list (after any Sources section is dropped): finished follow-up questions become buttons with no body, any other trailing list stays as a list,
 * and text with no list keeps only the paragraphs that do not repeat the note, without Sources, Next steps, Coverage
 * notes and similar sections. While the text is still streaming (`done` false), follow-ups are not split off yet.
 */
export function answerAfterNote(text: string, note: string, done = true): TrimmedAnswer {
  // A Sources section after the follow-ups would hide them, and the sources line under the answer replaces it.
  const cleaned = dropSections(text, SOURCES_HEADING, { paragraph: true }).trim();
  if (done) {
    const { followUps } = extractFollowUps(cleaned);
    if (followUps.length > 0) return { body: "", followUps };
  }
  const list = trailingList(cleaned);
  if (list !== "") return { body: list, followUps: [] };
  return { body: dropRepeats(dropSections(cleaned, REPEATED_HEADING), note), followUps: [] };
}

/** A note card's markdown without a Sources section: the sources line under the answer already lists them. */
export function noteForDisplay(markdown: string): string {
  return dropSections(markdown, SOURCES_HEADING, { paragraph: true }).trim();
}

/** The note tool's markdown from a finished `tool-note` part, or null. */
export function noteMarkdownOf(part: DedupePart): string | null {
  if (part.type !== "tool-note") return null;
  const out = part.output;
  if (typeof out !== "object" || out === null || !("markdown" in out)) return null;
  return typeof out.markdown === "string" ? out.markdown : null;
}

/**
 * For each text part that comes after at least one finished note in the same message: the markdown of every note
 * before it, joined. ChatRail passes it to answerAfterNote so the text after a note shows only what the note lacks.
 */
export function notesBeforeText(parts: readonly DedupePart[]): Map<number, string> {
  const before = new Map<number, string>();
  const notes: string[] = [];
  parts.forEach((part, i) => {
    const note = noteMarkdownOf(part);
    if (note !== null) notes.push(note);
    else if (part.type === "text" && notes.length > 0) before.set(i, notes.join("\n\n"));
  });
  return before;
}
