/**
 * Each layer's part in an answer (owner's review of the top-10 screens, 2026-10-24: "context layers drown the answer"):
 * the subject is what the question asks about, drawn at full weight; an area drawn around it (public land under Moab's
 * campsites, the ecoregions around the Smokies' vegetation, a wilderness beside what threatens it) is context, drawn as a
 * light tint under a thin outline beneath the answer (RenderOp.role, lib/render/deck.ts and components/mapTiles.ts).
 *
 * An area layer is context when the question does not ask about it in its own words and another layer answers beside
 * it; asked about ("who manages this land", "what protects", "avalanche danger"), or alone, it is the subject.
 */

/** Area layers that may be drawn as context, with the words that make one the subject of a question. */
export const CONTEXT_AREAS: Readonly<Record<string, RegExp>> = {
  "public-lands": /\bwho\s+(?:manages|owns|runs)\b|\bmanaged\s+by\b|\bwhose\s+land\b|\bpublic\s+(?:or\s+private|lands?|access)\b|\bblm\s+land\b|\bland\s+(?:owners?|managers?|ownership)\b/i,
  wilderness: /\bwilderness\b|\bprotect/i,
  "protected-areas-world": /\bprotect|\breserves?\b|\bnational\s+parks?\b/i,
  monuments: /\bmonuments?\b|\bprotect/i,
  ecoregions: /\becoregions?\b|\bbiomes?\b/i,
  avalanche: /\bavalanche/i,
};

/**
 * "context" for an area layer the question does not name while another layer answers beside it (`others`: the other
 * layers this turn queried or plans), else null (the subject).
 */
export function layerRole(layerId: string, question: string, others: readonly string[]): "context" | null {
  const subject = CONTEXT_AREAS[layerId];
  if (!subject || subject.test(question.replace(/@view=\S+/g, " "))) return null;
  return others.some((id) => id !== layerId && !(id in CONTEXT_AREAS)) ? "context" : null;
}
