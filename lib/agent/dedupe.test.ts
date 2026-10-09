import { describe, expect, it } from "vitest";
import { dedupeNoteAndText, type DedupePart } from "@/lib/agent/dedupe";

const note = (markdown: string): DedupePart => ({ type: "tool-note", state: "output-available", output: { markdown } });
const text = (t: string): DedupePart => ({ type: "text", text: t });

const LONG =
  "**Trails around Lake Tahoe.** The map shows about 400 named trails, mostly on the west shore, with gaps near the south.";

describe("dedupeNoteAndText", () => {
  it("hides the note card when the later text repeats it", () => {
    const parts = [note(LONG), text(`${LONG}\n\n- Which trails are easiest?`)];
    expect([...dedupeNoteAndText(parts)]).toEqual([0]);
  });

  it("ignores emphasis marks and spacing differences", () => {
    const plain = LONG.replace(/\*/g, "").replace(/ /g, "  ");
    expect(dedupeNoteAndText([note(LONG), text(plain)]).has(0)).toBe(true);
  });

  it("keeps both when the text says something different", () => {
    const parts = [note(LONG), text("Here are some ideas for your next trip to the Sierra, plus a few questions to try.")];
    expect(dedupeNoteAndText(parts).size).toBe(0);
  });

  it("compares whole strings when the text is under 60 characters", () => {
    expect(dedupeNoteAndText([note("Done."), text("Done.")]).has(0)).toBe(true);
    expect(dedupeNoteAndText([note(LONG), text(LONG.slice(0, 30))]).size).toBe(0);
  });

  it("ignores text that comes before the note", () => {
    expect(dedupeNoteAndText([text(LONG), note(LONG)]).size).toBe(0);
  });

  it("ignores notes without markdown output", () => {
    expect(dedupeNoteAndText([{ type: "tool-note", state: "input-available" }, text(LONG)]).size).toBe(0);
  });
});
