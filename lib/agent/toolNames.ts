/**
 * Tool names as the model writes them, made canonical. Shared by the server (repairToolCall, lib/agent/tools.ts) and
 * the browser (lib/agent/applyToolResult.ts), so a call the server repaired never reaches the map under its garbled
 * name (a phantom "climbing<|channel|>commentary" layer).
 */

/**
 * Junk some models leave on a tool name: a chat-template token and what follows it (`query_power-plants<|channel|>commentary`),
 * or a stray quote, bracket or space.
 */
const TOOL_NAME_JUNK = /(?:<\|[\s\S]*|[\s"'`<>()[\]{}:;,.]+[\s\S]*)$/;

/**
 * The registered tool a garbled name means, or null: the name with trailing junk (`<|channel|>commentary`, `<|...|>`)
 * cut off, when that prefix is exactly one registered tool name, or the start of exactly one.
 */
export function repairToolName(name: string, toolNames: readonly string[]): string | null {
  if (toolNames.includes(name)) return name;
  const prefix = name.replace(TOOL_NAME_JUNK, "").trim();
  if (prefix === "" || prefix === name) return null;
  if (toolNames.includes(prefix)) return prefix;
  const matches = toolNames.filter((t) => t.startsWith(prefix));
  return matches.length === 1 ? matches[0] : null;
}


/**
 * The layer id a render or compare call means: junk cut off (`climbing<|channel|>commentary`), and the query tool's
 * name read as its layer (`query_peaks` is peaks) when that is a registered layer.
 */
export function canonicalLayerId(id: string, layerIds: readonly string[]): string {
  const bare = id.replace(TOOL_NAME_JUNK, "").trim() || id;
  if (layerIds.includes(bare)) return bare;
  const unprefixed = bare.replace(/^query_/, "");
  return layerIds.includes(unprefixed) ? unprefixed : bare;
}
