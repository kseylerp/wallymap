import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";

const REQUIRED = [
  "You answer by drawing on a map.",
  "Prefer tools over prose.",
  "Every claim cites a layer.",
  "End every answer with a Sources line naming each layer's citation; never cite a layer you did not query.",
  "State coverage gaps plainly.",
  "Never invent coordinates; every geometry comes from a tool result.",
  "End with two or three follow-up questions as a bulleted list.",
  "Do not describe the popularity layer as live or real-time.",
  "Popularity and remoteness are estimates computed from other layers; say so, and never call them live.",
  "If a layer returns a zoom_in error, shrink the bounding box once to the central quarter and retry that layer once; do not retry more than once.",
  "The popularity layers already include the trails or campsites they score; do not query osm-trails or campsites again for the same question.",
  "Always leave your last step for the note; write the note even when some layers failed.",
  "Choose the layer whose synonyms match the question; when several match, query them in the listed order; if none match, say which layers exist and ask.",
];

describe("SYSTEM_PROMPT", () => {
  it.each(REQUIRED)("contains %s", (sentence) => {
    expect(SYSTEM_PROMPT).toContain(sentence);
  });
});
