import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from "ai";
import "@/layers";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";
import { getModel } from "@/lib/agent/provider";
import { buildTools } from "@/lib/agent/tools";

export const maxDuration = 60;

const MAX_STEPS = 8;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Caps on what one request may send, so the endpoint cannot be used to push
// arbitrarily large prompts through the deployer's model key.
const MAX_MESSAGES = 40;
const MAX_BODY_BYTES = 256 * 1024;

type ReadResult = { messages: UIMessage[] } | { error: string };

async function readMessages(req: Request): Promise<ReadResult> {
  const invalid = { error: "Invalid request body" };
  const tooLarge = { error: "Request too large" };
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
    if (messages.length > MAX_MESSAGES) return tooLarge;
    return { messages: messages as UIMessage[] };
  } catch {
    return invalid;
  }
}

export async function POST(req: Request): Promise<Response> {
  const read = await readMessages(req);
  if ("error" in read) {
    return Response.json({ error: read.error }, { status: 400 });
  }
  const { messages } = read;

  try {
    // Setup errors name the missing env var (never its value), so they are safe to return.
    const model = getModel();
    const tools = buildTools();
    const result = streamText({
      model,
      system: SYSTEM_PROMPT,
      tools,
      messages: await convertToModelMessages(messages, { tools }),
      stopWhen: stepCountIs(MAX_STEPS),
    });
    return result.toUIMessageStreamResponse({ onError: errorMessage });
  } catch (err) {
    return Response.json({ error: errorMessage(err) }, { status: 500 });
  }
}
