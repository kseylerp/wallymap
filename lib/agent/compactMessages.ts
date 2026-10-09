import { isToolUIPart, type UIMessage } from "ai";
import { isFullLayerResult, summarizeLayerResult } from "@/lib/layers/summarize";

/** What an earlier turn's list_layers output becomes when the history is resent. */
export const LIST_LAYERS_STUB = "Layer list from an earlier turn, omitted; call list_layers again if you need it.";

/**
 * Copies the chat history with every finished query_<layer> output replaced by
 * its summary, every finished route output by the route without its line, and
 * every list_layers output by a one-line stub. The browser keeps the full GeoJSON
 * for the map, but resending it on each turn would blow past the chat route's
 * request-size cap, and the model only ever sees the summary anyway.
 */
export function compactMessages<M extends UIMessage>(messages: M[]): M[] {
  return messages.map((message) => {
    let changed = false;
    const parts = message.parts.map((part) => {
      if (!isToolUIPart(part) || part.state !== "output-available") return part;
      if (part.type === "tool-list_layers" && part.output !== LIST_LAYERS_STUB) {
        changed = true;
        return { ...part, output: LIST_LAYERS_STUB };
      }
      if (part.type === "tool-route" && hasLine(part.output)) {
        changed = true;
        return { ...part, output: routeOutputForModel(part.output) };
      }
      if (!part.type.startsWith("tool-query_") || !isFullLayerResult(part.output)) return part;
      changed = true;
      return { ...part, output: summarizeLayerResult(part.output) };
    });
    return changed ? { ...message, parts } : message;
  });
}

function hasLine(output: unknown): output is { line: { coordinates: unknown[] } } {
  if (typeof output !== "object" || output === null || !("line" in output)) return false;
  const line = (output as { line: unknown }).line;
  return typeof line === "object" && line !== null && Array.isArray((line as { coordinates?: unknown }).coordinates);
}

/**
 * What the model sees for a `route` result, and what the browser resends: everything but the line's coordinates,
 * plus how many there were. Errors and already-compacted outputs pass through. Lives here rather than in
 * route.ts so the browser can use it without pulling in the server-side fetch cache.
 */
export function routeOutputForModel(output: unknown): unknown {
  if (!hasLine(output)) return output;
  const { line, ...rest } = output;
  return { ...rest, pointCount: line.coordinates.length };
}
