import { isToolUIPart, type UIMessage } from "ai";
import { isFullLayerResult, summarizeLayerResult } from "@/lib/layers/summarize";

/**
 * Copies the chat history with every finished query_<layer> output replaced by
 * its summary. The browser keeps the full GeoJSON for the map, but resending it
 * on each turn would blow past the chat route's request-size cap, and the model
 * only ever sees the summary anyway.
 */
export function compactMessages<M extends UIMessage>(messages: M[]): M[] {
  return messages.map((message) => {
    let changed = false;
    const parts = message.parts.map((part) => {
      if (!isToolUIPart(part) || part.state !== "output-available") return part;
      if (!part.type.startsWith("tool-query_") || !isFullLayerResult(part.output)) return part;
      changed = true;
      return { ...part, output: summarizeLayerResult(part.output) };
    });
    return changed ? { ...message, parts } : message;
  });
}
