import { anchorsOf, answerTemplate, chooseFollowUps, type AnswerTemplate } from "./answer";
import { composeNote } from "./compose";
import { followsUp } from "./context";
import type { Turn } from "./turn";
import { getLayer } from "@/layers";

/**
 * The answer template for a turn (lib/agent/answer.ts) from what the turn recorded: its tool calls, the results the
 * model read, the places it found (or, for a follow-up that names none, the last answer's place), and the question's
 * own reading (the layers it names lead the choice of main layer; its time window picks a forecast's days).
 */
export function answerForTurn(turn: Turn): AnswerTemplate | null {
  const places = turn.places.length > 0 ? turn.places : followsUp(turn.question, turn.context) && turn.context.place ? [turn.context.place] : [];
  try {
    return answerTemplate({
      calls: turn.calls,
      question: turn.question,
      outputs: turn.outputs,
      places,
      view: turn.view,
      prefer: turn.reading.layers.map((l) => l.layerId),
      window: turn.reading.time,
      taxon: turn.reading.taxon,
      change: turn.reading.change,
    });
  } catch (err) {
    // The answer still shows as the model wrote it.
    turn.note(`answer template failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** The note in the answer's shape, and the follow-ups it ends with kept on the turn. */
export function composeForTurn(markdown: string, turn: Turn): string {
  const template = answerForTurn(turn);
  turn.followUps = template?.followUps ?? [];
  const composed = withLandManagers(withAskedPictures(withEmptyLayers(composeNote(markdown, template), turn), turn), turn);
  if (composed !== markdown) turn.note(template?.lead ? "answer built on the template: lead, top options, then the model's caveats" : "answer put first: the note's first sentence now answers with a number");
  return composed;
}

/**
 * Layers asked this turn that answered with nothing (Zion's faults: 0) have no row in the layer panel, so the note says
 * so in one sentence, unless it already names them: "Quaternary faults: none mapped in the area asked."
 */
export function withEmptyLayers(markdown: string, turn: Pick<Turn, "queries">): string {
  const empty: string[] = [];
  for (const q of turn.queries) {
    if (!q.ok || q.drawable || empty.includes(q.layerId)) continue;
    if (turn.queries.some((o) => o.layerId === q.layerId && o.drawable)) continue;
    empty.push(q.layerId);
  }
  const lines: string[] = [];
  const text = markdown.toLowerCase();
  for (const id of empty) {
    const title = getLayer(id)?.title.replace(/\s*\([^)]*\)\s*/g, " ").trim();
    if (!title) continue;
    // Already said: the note names the layer's main word ("faults") next to a none, no or zero.
    const word = title.toLowerCase().split(/\s+/).filter((w) => w.length > 3).pop() ?? title.toLowerCase();
    const stem = word.replace(/s$/, "");
    if (new RegExp(`\\b(?:no|none|zero|0|not any|without)\\b[^.]{0,60}\\b${stem}|\\b${stem}\\w*\\b[^.]{0,40}\\b(?:none|no|zero|0)\\b`).test(text)) continue;
    lines.push(`${title}: none mapped in the area asked.`);
  }
  return lines.length === 0 ? markdown : `${markdown.trimEnd()}\n\n${lines.join(" ")}`;
}

/** Exactly three follow-ups, at least two naming a feature or place from this answer: the model's that do, then the template's. */
export function followUpsForTurn(turn: Turn, model: readonly string[]): string[] {
  const places = turn.places.length > 0 ? turn.places : turn.context?.place ? [turn.context.place] : [];
  const built = turn.followUps.length > 0 ? turn.followUps : (answerForTurn(turn)?.followUps ?? []);
  return chooseFollowUps(model, built, anchorsOf(turn.calls, places));
}

/** Waits for the tool calls still running (the renders sent beside a note), so the answer reads the finished map. */
export async function settle(turn: Turn): Promise<void> {
  // Every call of a step is started in the same task; one tick later all of them are in flight.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.allSettled([...turn.inflight]);
}

/**
 * Where to camp depends on who manages the land: when public-lands answered a camping or land question and the note
 * names no manager, it ends with the two largest units ("Land here: San Isabel National Forest (US Forest Service) and
 * Royal Gorge Field Office (Bureau of Land Management).").
 */
export function withLandManagers(markdown: string, turn: Pick<Turn, "question" | "calls">): string {
  if (!/\bcamp\w*|\bdispersed\b|\bwho\s+(?:manages|owns)\b|\bpublic\s+land|\bwhose\s+land/i.test(turn.question)) return markdown;
  if (/national\s+forest|\bBLM\b|bureau\s+of\s+land|forest\s+service|state\s+trust|national\s+park|tribal|reservation|wilderness/i.test(markdown)) return markdown;
  const out = turn.calls.findLast((c) => c.toolName === "query_public-lands")?.output as { coverageNote?: unknown } | undefined;
  const note = typeof out?.coverageNote === "string" ? out.coverageNote : "";
  const m = /^Land here, largest units first:\s*([^;]+)/.exec(note);
  if (!m) return markdown;
  const units = m[1].split(/\),\s+/).map((u) => (u.endsWith(")") ? u : `${u})`)).slice(0, 2);
  return `${markdown.trimEnd()}\n\nLand here: ${units.join(" and ")}.`;
}

/**
 * A picture layer the question asks for by its words (burn severity in "burn scars", the satellite snow map in "snow on
 * the ground") that the note never mentions gets one clause from its coverage note: Paradise's answer drew the burn
 * severity and said nothing of it. Two at most.
 */
export function withAskedPictures(markdown: string, turn: Pick<Turn, "reading" | "calls">): string {
  const text = markdown.toLowerCase();
  const lines: string[] = [];
  for (const hint of turn.reading.layers.filter((l) => l.strong)) {
    const out = turn.calls.findLast((c) => c.toolName === `query_${hint.layerId}`)?.output as { kind?: unknown; coverageNote?: unknown } | undefined;
    if (out?.kind !== "tiles" || typeof out.coverageNote !== "string" || out.coverageNote.trim() === "") continue;
    const title = getLayer(hint.layerId)?.title.replace(/\s*\([^)]*\)\s*/g, " ").trim() ?? hint.layerId;
    // Mentioned already: the title's longest word ("severity", "cover") is in the note.
    const word = title.toLowerCase().split(/[\s:,]+/).sort((x, y) => y.length - x.length)[0] ?? "";
    if (word && text.includes(word.replace(/s$/, ""))) continue;
    const clause = out.coverageNote.split(/;\s+|\.\s+/)[0].trim().replace(/[.:]$/, "");
    if (clause.split(/\s+/).length > 30) continue;
    lines.push(`${clause}.`);
    if (lines.length >= 2) break;
  }
  return lines.length === 0 ? markdown : `${markdown.trimEnd()}\n\n${lines.join(" ")}`;
}

