/** A top-level bullet (`-`, `*` or `+` at the start of the line). */
const BULLET = /^[-*+]\s+(.*\S)\s*$/;
/** An indented bullet: a nested list, which follow-ups never are. */
const NESTED_BULLET = /^\s+[-*+]\s+/;
/** A thematic break (`---`, `***`, `___`) often separates the answer from its follow-ups. */
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/** A lead-in that introduces suggestions, e.g. "Next steps – what would you like to explore?". */
const LEAD_IN = /follow[- ]?ups?|next steps?|explore|would you like|you could|you might|try asking|ask me/i;
/** A leading emoji, checkbox ("☐", "[ ]") or arrow some models put on each suggestion. */
const LEADING_MARK =
  /^(?:\[[ xX]?\]|[\u2022\u2192\u2610-\u2612\u2713\u2714\u25A0-\u25FF\u27A1]|\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\uFE0F|\u200D|\p{Extended_Pictographic})*\s*/u;

const MIN_FOLLOW_UPS = 2;
const MAX_FOLLOW_UPS = 3;

/** Drops inline markdown so a follow-up reads (and sends) as plain text. */
function plain(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    // Underscores count as emphasis only at word edges, so tag values like sac_scale survive.
    .replace(/(^|\W)__?(.+?)__?(?!\w)/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(LEADING_MARK, "");
}

/** The last line of prose above the list, without heading or emphasis markers. */
function leadIn(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === "" || RULE.test(lines[i])) continue;
    return plain(lines[i].replace(/^#+\s*/, ""));
  }
  return "";
}

/**
 * Splits an answer's trailing bulleted list of 2–3 follow-ups off the markdown.
 * The prompt asks the agent to end with follow-up questions as a bulleted list. To keep a closing list of
 * facts from turning into buttons, the items must all be questions, or the line above the list must
 * introduce suggestions ("Next steps – what would you like to explore?"). Otherwise the markdown is untouched.
 */
export function extractFollowUps(markdown: string): { body: string; followUps: string[] } {
  const unchanged = { body: markdown, followUps: [] };
  const lines = markdown.replace(/\s+$/, "").split("\n");

  const items: string[] = [];
  let continuation: string[] = [];
  let start = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (NESTED_BULLET.test(line)) return unchanged;
    const bullet = BULLET.exec(line);
    if (bullet) {
      items.unshift([bullet[1], ...continuation].join(" "));
      continuation = [];
      start = i;
    } else if (line.trim() === "") {
      continue;
    } else if (/^\s+\S/.test(line)) {
      // A wrapped line belongs to the bullet above it.
      continuation.unshift(line.trim());
    } else {
      break;
    }
  }
  if (continuation.length > 0) return unchanged;

  const followUps = items.map(plain);
  if (followUps.length < MIN_FOLLOW_UPS || followUps.length > MAX_FOLLOW_UPS) return unchanged;
  const bodyLines = lines.slice(0, start);
  const intro = leadIn(bodyLines);
  const suggestions = followUps.every((q) => q.endsWith("?")) || intro.endsWith("?") || LEAD_IN.test(intro);
  if (!suggestions) return unchanged;

  while (bodyLines.length > 0 && (bodyLines[bodyLines.length - 1].trim() === "" || RULE.test(bodyLines[bodyLines.length - 1]))) {
    bodyLines.pop();
  }
  return { body: bodyLines.join("\n"), followUps };
}
