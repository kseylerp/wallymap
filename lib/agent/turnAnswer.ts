import { anchorsOf, answerTemplate, chooseFollowUps, type AnswerTemplate } from "./answer";
import { composeNote } from "./compose";
import { followsUp } from "./context";
import type { Turn } from "./turn";

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
  const composed = composeNote(markdown, template);
  if (composed !== markdown) turn.note(template?.lead ? "answer built on the template: lead, top options, then the model's caveats" : "answer put first: the note's first sentence now answers with a number");
  return composed;
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
