import type { AnswerTemplate } from "./answer";

/**
 * The note in the answer's shape (docs/top-10-use-cases.md "Answer structure"): the first sentence answers the decision
 * with its deciding number, never "The map shows…"; then the top options with the facts that decide them; then the
 * model's own caveats. Pure: lib/agent/noteCheck.ts applies it to every note shown, and the step guard to a closing
 * answer written as text.
 */

/** Longest first sentence the folded phone chat sheet shows without scrolling (scripts/top10Check.ts). */
export const FIRST_SENTENCE_WORDS = 40;

/** A sentence that describes the map instead of answering. */
const MAP_SAYS =
  /^(?:the\s+|this\s+)?map\s+(?:now\s+)?(?:shows|draws|displays|highlights|is\s+showing|has\s+been)\b|^(?:drawn|shown|mapped)\s+(?:on|here|above|below)\b|^here\s+(?:is|are)\s+(?:the\s+)?(?:map|layers?)\b|^(?:i(?:'ve|\s+have)\s+)?(?:drawn|mapped|plotted|added)\s+(?:the|a|an)\b|^(?:on\s+the\s+map|the\s+layers?\s+(?:show|draw))/i;

const words = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
const isBullet = (line: string) => /^\s*(?:[-*+]|\d+\.)\s+/.test(line);
const isTitle = (line: string) => /^\s*#{1,6}\s/.test(line) || /^\s*(?:\*\*|__)[^*_]+(?:\*\*|__):?\s*$/.test(line);
/** Abbreviations whose period ends no sentence. */
const ABBREV = /\b(?:e\.g|i\.e|approx|vs|Mt|St|No|ca|Ft|Rd|Hwy|Jr|Sr|Dr|U\.S)\.$/i;

/** A paragraph's sentences, split after . ! or ? and a space, abbreviations and decimals kept whole. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const part of text.split(/(?<=[.!?])\s+/)) {
    current = current ? `${current} ${part}` : part;
    if (!ABBREV.test(current)) {
      out.push(current);
      current = "";
    }
  }
  if (current) out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** A line read as prose: list marker, emphasis and code ticks dropped. */
const prose = (line: string) => line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/, "").replace(/\*\*|__|`/g, "").trim();

/** True when a sentence says what the map draws rather than answering. */
export function describesMap(sentence: string): boolean {
  return MAP_SAYS.test(prose(sentence));
}

/** A first sentence the phone shows whole and that answers: a number, at most 40 words, not a description of the map. */
export function answersFirst(sentence: string): boolean {
  const s = prose(sentence);
  return /\d/.test(s) && words(s) <= FIRST_SENTENCE_WORDS && !describesMap(s);
}

/** The first sentence of the note's prose, as the reader meets it (titles skipped). */
export function leadSentence(markdown: string): string {
  const first = markdown.split("\n").find((l) => l.trim() !== "" && !isTitle(l));
  return first ? (sentences(prose(first))[0] ?? "") : "";
}

/** A long first sentence cut at its first clause break, when that part still answers. */
function shortened(sentence: string): string | null {
  // Every clause break, latest first, so the head keeps as much of the answer as fits ("…is overwhelmingly natural—about
  // 75 % of the land…, with only ≈8 % planted forest—while trees cover…" kept the share and cut the heights).
  const cuts: number[] = [];
  for (const sep of [";", " – ", " — ", "—", ": ", ", which", ", while", ", and", ", with", ", but"]) {
    for (let at = sentence.indexOf(sep); at > 0; at = sentence.indexOf(sep, at + 1)) cuts.push(at);
  }
  for (const at of [...new Set(cuts)].sort((x, y) => y - x)) {
    const head = `${sentence.slice(0, at).trim().replace(/[,:;—–-]$/, "").trim()}.`;
    if (answersFirst(head)) return head;
  }
  return null;
}

/**
 * The note with an answer first: a sentence that only describes the map is dropped, and when the first sentence still
 * has no number (or runs past 40 words) the first sentence that answers is moved up to lead it.
 */
export function answerFirst(markdown: string): string {
  let text = markdown.replace(/^\s*\n+/, "");
  if (!text.split("\n").some((l) => l.trim() !== "" && !isTitle(l))) return markdown;
  const lead = leadSentence(text);
  if (answersFirst(lead)) return text;
  // 1. A long first sentence cut at a clause, when its head answers.
  if (/\d/.test(lead) && !describesMap(lead)) {
    const head = shortened(lead);
    if (head) {
      const at = text.indexOf(lead.slice(0, 20));
      if (at >= 0) {
        const rest = text.slice(at + lead.length).replace(/^\s+/, "");
        const tail = lead.slice(head.length - 1).replace(/^[;,:–—\s]+/, "").replace(/^and\s+|^which\s+/i, "");
        return `${text.slice(0, at)}${head} ${tail.charAt(0).toUpperCase()}${tail.slice(1)}${rest ? ` ${rest}` : ""}`.trim();
      }
    }
  }
  // 2. The first sentence anywhere in the note that answers comes first; what described the map follows it.
  const all = text.split("\n");
  for (let i = 0; i < all.length; i++) {
    if (all[i].trim() === "" || isTitle(all[i])) continue;
    const ss = sentences(prose(all[i]));
    const k = ss.findIndex((s) => answersFirst(s));
    if (k === -1) continue;
    const found = ss[k];
    const remaining = ss.filter((_, j) => j !== k).join(" ");
    if (isBullet(all[i])) all.splice(i, 1, ...(remaining ? [all[i].replace(prose(all[i]), remaining)] : []));
    else all.splice(i, 1, ...(remaining ? [remaining] : []));
    text = [found, "", ...all].join("\n").replace(/\n{3,}/g, "\n\n").trim();
    return text;
  }
  return text;
}

/**
 * The note built on the answer template: its lead (or the model's first sentence, when that already answers with a
 * number), then the top options with their deciding facts in place of the model's own list, then the model's other
 * sentences (caveats, what the app cannot show). Without a template, the model's note with its answer moved first.
 */
const SMALL = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Counts and dates as a person reads them and the phone's first line can show: "Twenty-one sightings" is "21 sightings"
 * (two to ninety-nine; "one" stays a word), and "2026-10-23" is "Oct 23" (with the year when it is not this year).
 */
export function readableNumbers(markdown: string, now: Date = new Date()): string {
  const word = String.raw`(?:${TENS.slice(2).join("|")})(?:[-\u2010\u2011 ](?:${SMALL.slice(1, 10).join("|")}))?|${SMALL.slice(2).join("|")}`;
  let out = markdown.replace(new RegExp(String.raw`\b(${word})\b(?![-\u2010\u2011](?:year|day|hour|week|month|mile|km|foot|ft|story|lane|way))`, "gi"), (m) => {
    const parts = m.toLowerCase().split(/[-\u2010\u2011 ]/);
    const n = parts.length === 2 ? TENS.indexOf(parts[0]) * 10 + SMALL.indexOf(parts[1]) : TENS.includes(parts[0]) ? TENS.indexOf(parts[0]) * 10 : SMALL.indexOf(parts[0]);
    return n >= 2 ? String(n) : m;
  });
  out = out.replace(/\b(\d{4})[-\u2010\u2011](\d{2})[-\u2010\u2011](\d{2})\b(?![T:\d])/g, (m, y: string, mo: string, d: string) => {
    const month = MONTHS_SHORT[Number(mo) - 1];
    if (!month || Number(d) < 1 || Number(d) > 31) return m;
    return `${month} ${Number(d)}${Number(y) === now.getUTCFullYear() ? "" : `, ${y}`}`;
  });
  return out;
}

export function composeNote(markdown: string, template: AnswerTemplate | null): string {
  markdown = readableNumbers(markdown);
  if (!template || (!template.lead && template.allLines.length === 0)) return finished(answerFirst(markdown));
  // The template's lead answers first (or, without one, the model's answer moved first), so the model's list stays a list.
  const lines = (template.lead ? finished(markdown) : finished(answerFirst(markdown))).split("\n");
  // The model's prose: every line that is not a list item or a title.
  const proseLines = lines.filter((l) => l.trim() !== "" && !isBullet(l) && !isTitle(l));
  // The template's lead comes first, and the model's own first sentence follows it (it may hold a total the lead does
  // not); for a total or a change, the model's first sentence leads when it answers, and the template's stands in.
  const modelLead = proseLines.length > 0 ? (sentences(prose(proseLines[0]))[0] ?? "") : "";
  const lead = template.modelFirst && answersFirst(modelLead) ? null : template.lead;
  const optionLines = lead ? template.lines : template.allLines;
  const modelBullets = lines.filter((l) => isBullet(l));
  const rest: string[] = [];
  // Composing twice changes nothing: the lead is not kept again as the model's own sentence.
  const same = (a: string, b: string) => a.replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase() === b.replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
  const mapLines: string[] = [];
  for (const line of proseLines) {
    const ss = sentences(prose(line)).filter((s) => !(lead && same(s, lead)));
    // Under the template's lead, what only describes the map comes last.
    const map = lead ? ss.filter((s) => describesMap(s)) : [];
    const said = ss.filter((s) => !map.includes(s));
    if (said.length > 0) rest.push(said.join(" "));
    if (map.length > 0) mapLines.push(map.join(" "));
  }
  rest.push(...mapLines);
  // The template's list replaces the model's: the same top features, with the deciding facts in the person's units. A
  // model line with a number the template's list does not hold is another fact (St. George's "all 96 recent observations
  // are hidden" beside the habitat's list) and stays after it; two at most.
  const numbers = (text: string) => (text.replace(/[\u202f\u00a0]/g, " ").match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]$/, "").replace(/,/g, ""));
  const held = new Set(numbers([lead ?? "", ...optionLines].join(" ")));
  // An option of the model's own (a bold name: "**Swamp Wells Trail** – 26.9 km") is what the list replaces, never kept.
  const extra = optionLines.length > 0 ? modelBullets.filter((b) => !/^\s*(?:[-*+]|\d+\.)\s+(?:\*\*|__)/.test(b) && numbers(b).some((n) => !held.has(n))).slice(0, 2) : [];
  const list = optionLines.length > 0 ? [...optionLines, ...extra] : modelBullets;
  // Without the template's lead, the model's first line leads, then the list.
  const parts = [lead ?? "", rest.length > 0 && !lead ? rest.shift()! : "", list.join("\n"), rest.join("\n\n")].filter((p) => p.trim() !== "");
  return finished(parts.join("\n\n"));
}

/** The follow-up questions as the closing list (lib/agent/followups.ts reads them back as buttons). */
export function followUpList(followUps: readonly string[]): string {
  return followUps.map((q) => `- ${q}`).join("\n");
}

/**
 * An answer written as text, with its follow-ups after it. A rule keeps an answer that ends with a list apart from the
 * follow-ups' list, so the two are not read as one.
 */
export function withFollowUps(body: string, followUps: readonly string[]): string {
  if (followUps.length === 0) return body;
  const lastLine = body.trimEnd().split("\n").pop() ?? "";
  return `${body.trimEnd()}\n\n${isBullet(lastLine) ? "---\n\n" : ""}${followUpList(followUps)}`;
}

/** Every prose line ends its sentence, so a reader (and the phone's first-sentence fold) stops where it ends. */
function finished(markdown: string): string {
  return markdown
    .split("\n")
    .map((l) => {
      const t = l.trimEnd();
      if (t.trim() === "" || isTitle(t) || /^\s*(?:[-*_]\s*){3,}$/.test(t)) return l;
      // The sentence's own end, under any closing emphasis or bracket.
      const bare = t.replace(/[*_)"'”’\]]+$/, "");
      if (/[.!?:…]$/.test(bare)) return l;
      return /[\p{L}\p{N}%°)*_"'”’]$/u.test(t) ? `${t}.` : l;
    })
    .join("\n");
}
