import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";

const REQUIRED = [
  "You answer by drawing on a map.",
  "Prefer tools over prose.",
  "Every claim cites a layer.",
  "State coverage gaps plainly.",
  "Never invent coordinates; every geometry comes from a tool result.",
  "End with two or three follow-up questions as a bulleted list.",
  "Do not describe the popularity layer as live or real-time.",
];

describe("SYSTEM_PROMPT", () => {
  it.each(REQUIRED)("contains %s", (sentence) => {
    expect(SYSTEM_PROMPT).toContain(sentence);
  });
});
