import { stepCountIs, wrapLanguageModel, type LanguageModel } from "ai";
import { SYSTEM_PROMPT } from "./prompt";
import { getModel } from "./provider";
import { stepGuard } from "./stepGuard";
import { buildTools, repairToolCall } from "./tools";
import { createTurn, MAX_STEPS, type Turn } from "./turn";
import type { MapView } from "./view";
import { systemForTurn } from "./viewContext";

export { MAX_STEPS };

/** Tools that draw or answer: the only ones offered in the last two steps before a note. */
const ANSWER_TOOLS = ["render", "compare", "set_time", "set_view", "note"];

/**
 * The step budget, kept in code: each step records its number on the turn (the step guard reads it). With two steps
 * left and no note yet, only drawing and the note are offered; on the last step, only the note (the guard adds renders
 * for anything queried and not drawn), so a turn never runs out of steps on queries and ends with no answer.
 */
export function prepareStepFor(turn: Turn, toolNames: readonly string[]) {
  return ({ stepNumber }: { stepNumber: number }) => {
    turn.step = stepNumber;
    if (turn.noted || stepNumber < MAX_STEPS - 2) return {};
    if (stepNumber >= MAX_STEPS - 1) {
      turn.note("last step and no note yet: only the note is offered");
      return { activeTools: ["note"], toolChoice: "required" as const };
    }
    turn.note("two steps left and no note yet: queries are no longer offered");
    return { activeTools: ANSWER_TOOLS.filter((t) => toolNames.includes(t)) };
  };
}

/**
 * Everything one turn of the agent runs with, shared by the chat route (streamText) and the eval (generateText) so
 * both answer the same way: this turn's record, the tools writing into it, the system prompt with the map view, and
 * the model wrapped in the step guard (lib/agent/stepGuard.ts).
 */
export function agentTurn({ question, view, model = getModel() }: { question: string; view: MapView | null; model?: LanguageModel }) {
  const turn: Turn = createTurn({ question, view });
  const tools = buildTools({ view, turn });
  if (typeof model === "string") throw new Error("A model instance is required (MODEL_PROVIDER and MODEL_NAME)");
  return {
    turn,
    tools,
    system: systemForTurn(SYSTEM_PROMPT, view),
    model: wrapLanguageModel({ model, middleware: stepGuard(turn, Object.keys(tools)) }),
    stopWhen: stepCountIs(MAX_STEPS),
    prepareStep: prepareStepFor(turn, Object.keys(tools)),
    // Some models glue template tokens onto a tool name (query_power-plants<|channel|>commentary); the guard renames
    // them in the stream, and this catches any it could not read.
    repairToolCall,
  };
}
