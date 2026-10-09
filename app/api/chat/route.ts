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

async function readMessages(req: Request): Promise<UIMessage[] | null> {
  try {
    const body: unknown = await req.json();
    if (typeof body !== "object" || body === null || !("messages" in body)) return null;
    const { messages } = body;
    return Array.isArray(messages) ? (messages as UIMessage[]) : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request): Promise<Response> {
  const messages = await readMessages(req);
  if (!messages) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

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
