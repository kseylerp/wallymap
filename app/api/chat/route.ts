import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from "ai";
import "@/layers";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";
import { getModel } from "@/lib/agent/provider";
import { buildTools } from "@/lib/agent/tools";

export const maxDuration = 60;

const MAX_STEPS = 8;

export async function POST(req: Request): Promise<Response> {
  const { messages } = (await req.json()) as { messages: UIMessage[] };
  const tools = buildTools();
  const result = streamText({
    model: getModel(),
    system: SYSTEM_PROMPT,
    tools,
    messages: await convertToModelMessages(messages, { tools }),
    stopWhen: stepCountIs(MAX_STEPS),
  });
  return result.toUIMessageStreamResponse();
}
