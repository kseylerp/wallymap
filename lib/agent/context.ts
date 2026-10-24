import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { getLayer } from "@/layers/registry";
import type { BBox } from "@/layers/types";
import { placeCandidates } from "./places";

/**
 * What the conversation's last answer left on the map, so a follow-up question reuses it (docs/top-10-use-cases.md,
 * "What a follow-up must reuse"): the place it was about, the layers it drew, and the filters, view and Rank by the
 * person sees. "Show only the loops under 5 miles" keeps Asheville, the trails and the waterfall join, and changes only
 * the length; it never looks Asheville up again.
 */
export type ContextLayer = { layerId: string; input?: Record<string, unknown>; filters?: Record<string, unknown>; view?: string; rankBy?: string };

export type TurnContext = {
  /** The earlier question. */
  question: string;
  /** The place the earlier answer was about, when it looked one up. */
  place: { name: string; bbox: BBox; center: [number, number] } | null;
  /** The layers it drew, in the order they were drawn, each with what the person sees of it. */
  layers: ContextLayer[];
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isBBox = (v: unknown): v is BBox => Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === "number" && Number.isFinite(n));

/** The text of a user message. */
const textOf = (m: UIMessage) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ").trim();

/** The last answer's context from the chat history (every message before the question being asked), or null. */
export function contextFrom(messages: readonly UIMessage[]): TurnContext | null {
  const lastUser = messages.findLastIndex((m) => m.role === "user");
  if (lastUser <= 0) return null;
  const previousUser = messages.slice(0, lastUser).findLastIndex((m) => m.role === "user");
  if (previousUser === -1) return null;
  const answer = messages.slice(previousUser + 1, lastUser).filter((m) => m.role === "assistant");
  let place: TurnContext["place"] = null;
  const layers: ContextLayer[] = [];
  const entry = (layerId: string) => {
    let e = layers.find((l) => l.layerId === layerId);
    if (!e) {
      e = { layerId };
      layers.push(e);
    }
    return e;
  };
  for (const m of answer) {
    for (const part of m.parts) {
      if (!isToolUIPart(part) || part.state !== "output-available") continue;
      const name = getToolName(part);
      const input = isObject(part.input) ? part.input : {};
      const output = part.output;
      if (name === "geocode" && isObject(output) && typeof output.name === "string" && isBBox(output.bbox) && Array.isArray(output.center)) {
        place ??= { name: output.name, bbox: output.bbox, center: output.center as [number, number] };
      } else if (name.startsWith("query_") && !(isObject(output) && "error" in output)) {
        const layerId = name.slice("query_".length);
        if (!getLayer(layerId)) continue;
        const { bbox: _bbox, zoom: _zoom, ...rest } = input;
        void _bbox;
        void _zoom;
        entry(layerId).input = rest;
      } else if (name === "render" && isObject(output) && typeof output.layerId === "string" && getLayer(output.layerId)) {
        const e = entry(output.layerId);
        if (isObject(output.filters)) e.filters = output.filters;
        if (typeof output.view === "string") e.view = output.view;
        if (typeof output.rankBy === "string") e.rankBy = output.rankBy;
      }
    }
  }
  if (layers.length === 0 && !place) return null;
  return { question: textOf(messages[previousUser]), place, layers };
}

/** True when a question names no place of its own, so it is about the place the last answer was about. */
export function followsUp(question: string, context: TurnContext | null): context is TurnContext {
  return context !== null && placeCandidates(question).length === 0;
}

/** The context as one block of the system prompt: what is on the map now, and what a follow-up keeps. */
export function contextForPrompt(context: TurnContext, question: string): string {
  if (!followsUp(question, context)) return "";
  const where = context.place ? `about ${context.place.name.split(",")[0]} (bbox [${context.place.bbox.join(", ")}])` : "about the current map view";
  const drawn = context.layers.map((l) => {
    const bits = [l.filters && Object.keys(l.filters).length > 0 ? `filters ${JSON.stringify(l.filters)}` : "", l.view ? `view ${l.view}` : "", l.rankBy ? `rankBy ${l.rankBy}` : ""].filter(Boolean);
    return `${l.layerId}${bits.length > 0 ? ` (${bits.join(", ")})` : ""}`;
  });
  return [
    `This question follows the last answer ("${context.question.slice(0, 120)}"), which was ${where} and drew ${drawn.join("; ") || "nothing"}.`,
    "Keep that place: do not geocode again, and pass the current map view's bbox (or that bbox) to the queries. Keep those layers and the filters, view and Rank by the person sees; change only what this question asks (\"only the black ones\" changes the difficulty chip and keeps the rest), and render with the filters kept.",
  ].join("\n");
}
