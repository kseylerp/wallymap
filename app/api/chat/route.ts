import { convertToModelMessages, streamText, type UIMessage } from "ai";
import "@/layers";
import { agentTurn } from "@/lib/agent/agent";
import { lastUserText } from "@/lib/agent/turn";
import type { MapView } from "@/lib/agent/view";
import { parseMapView } from "@/lib/agent/viewContext";
import { chatRules, limitRequest } from "@/lib/fetch/rateLimit";

// Room for several tool steps, each of which may wait on a slow upstream.
export const maxDuration = 120;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Caps on what one request may send, so the endpoint cannot be used to push
// arbitrarily large prompts through the deployer's model key. The text cap counts
// the characters people and the model wrote; tool results are bounded by the body cap.
const MAX_MESSAGES = 40;
const MAX_TEXT_CHARS = 60_000;
const MAX_BODY_BYTES = 256 * 1024;

type ReadResult = { messages: UIMessage[]; view: MapView | null } | { error: string; status: 400 | 413 };

/** Characters in every text part of every message. */
function textChars(messages: unknown[]): number {
  let total = 0;
  for (const message of messages) {
    const parts = typeof message === "object" && message !== null && "parts" in message ? message.parts : null;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") {
        total += part.text.length;
      }
    }
  }
  return total;
}

async function readMessages(req: Request): Promise<ReadResult> {
  const invalid = { error: "Invalid request body", status: 400 as const };
  const tooLarge = { error: "Request too large", status: 413 as const };
  let text: string;
  try {
    text = await req.text();
  } catch {
    return invalid;
  }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return tooLarge;

  try {
    const body: unknown = JSON.parse(text);
    if (typeof body !== "object" || body === null || !("messages" in body)) return invalid;
    const { messages } = body;
    if (!Array.isArray(messages)) return invalid;
    if (messages.length > MAX_MESSAGES || textChars(messages) > MAX_TEXT_CHARS) return tooLarge;
    // The map view is per turn: a malformed one is dropped rather than failing the question.
    return { messages: messages as UIMessage[], view: "view" in body ? parseMapView(body.view) : null };
  } catch {
    return invalid;
  }
}

export async function POST(req: Request): Promise<Response> {
  const limited = await limitRequest(req, chatRules());
  if (limited) return limited;

  const read = await readMessages(req);
  if ("error" in read) {
    return Response.json({ error: read.error }, { status: read.status });
  }
  const { messages, view } = read;

  try {
    // Setup errors name the missing env var (never its value), so they are safe to return.
    // The view goes into this turn's system prompt only, never the history, so old views are not resent. The model
    // runs inside the step guard, which keeps tool names canonical in this stream (lib/agent/stepGuard.ts).
    const { model, system, tools, stopWhen, prepareStep, repairToolCall } = agentTurn({ question: lastUserText(messages), view, history: messages });
    const result = streamText({
      model,
      system,
      tools,
      messages: await convertToModelMessages(messages, { tools }),
      stopWhen,
      prepareStep,
      repairToolCall,
    });
    return result.toUIMessageStreamResponse({ onError: errorMessage });
  } catch (err) {
    return Response.json({ error: errorMessage(err) }, { status: 500 });
  }
}
