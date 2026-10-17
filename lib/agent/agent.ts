import { stepCountIs, wrapLanguageModel, type LanguageModel } from "ai";
import { SYSTEM_PROMPT } from "./prompt";
import { getModel } from "./provider";
import { stepGuard } from "./stepGuard";
import { buildTools, repairToolCall } from "./tools";
import { createTurn, type Turn } from "./turn";
import type { MapView } from "./view";
import { systemForTurn } from "./viewContext";

/** Most model steps in one turn: room for geocode, several queries, renders and the note. */
export const MAX_STEPS = 12;

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
    // Some models glue template tokens onto a tool name (query_power-plants<|channel|>commentary); the guard renames
    // them in the stream, and this catches any it could not read.
    repairToolCall,
  };
}
