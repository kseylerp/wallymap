import { describe, expect, it } from "vitest";
import {
  answerAfterNote,
  noteForDisplay,
  notesBeforeText,
  repeatShare,
  type DedupePart,
} from "@/lib/agent/dedupe";
import { HIKES_NOTE, HIKES_PARTS, HIKES_TEXT, WATER_NOTE, WATER_PARTS, WATER_TEXT } from "./__fixtures__/patagonia-transcript";

const note = (markdown: string): DedupePart => ({ type: "tool-note", state: "output-available", output: { markdown } });
const text = (t: string): DedupePart => ({ type: "text", text: t });

const NOTE =
  "**Trails around Lake Tahoe.** The map shows about 400 named trails, mostly on the west shore, with gaps near the south.";

const REPEATED_HEADINGS = /sources|next steps|coverage notes|what to do next|follow-up questions/i;

describe("the owner's Tierra del Fuego transcript", () => {
  it("answer 2: the text after the note is only its follow-up questions", () => {
    const before = notesBeforeText(WATER_PARTS);
    expect([...before.keys()]).toEqual([5]);
    const { body, followUps } = answerAfterNote(WATER_TEXT, before.get(5) ?? "");
    expect(body).toBe("");
    expect(followUps).toEqual([
      "Should I compare forest loss in 2015 and 2025?",
      "Do you want to see where water has been lost or gained since 1984?",
      "Should I zoom in on Lago Fagnano?",
    ]);
  });

  it("answer 2: no heading or year range is shown twice once the note card drops its Sources", () => {
    const shown = noteForDisplay(WATER_NOTE) + "\n" + answerAfterNote(WATER_TEXT, WATER_NOTE).body;
    for (const heading of ["Coverage notes", "Next steps"]) expect(shown.split(heading).length - 1).toBeLessThanOrEqual(1);
    expect(shown).not.toMatch(/\*\*Sources\*\*/);
    expect(shown).not.toContain("2015–2025");
  });

  it("answer 1: the zoom-in lecture is not repeated after the note", () => {
    const before = notesBeforeText(HIKES_PARTS);
    const { body, followUps } = answerAfterNote(HIKES_TEXT, before.get(2) ?? "");
    expect(body).toBe("");
    expect(followUps).toHaveLength(3);
    expect(noteForDisplay(HIKES_NOTE)).not.toContain("OpenStreetMap contributors");
  });

  it("while streaming, shows the trailing list as markdown and never the repeated prose", () => {
    const partial = WATER_TEXT.slice(0, WATER_TEXT.indexOf("**Next steps**"));
    const streaming = answerAfterNote(partial, WATER_NOTE, false);
    expect(streaming.body).not.toMatch(REPEATED_HEADINGS);
    expect(streaming.body).not.toContain("melt-water");
    expect(answerAfterNote(WATER_TEXT, WATER_NOTE, false)).toEqual({
      body: expect.stringMatching(/^- Should I compare forest loss/),
      followUps: [],
    });
  });
});

describe("answerAfterNote", () => {
  it("drops prose that mostly repeats the note, even reworded", () => {
    const reworded = "The map shows about 400 named trails around Lake Tahoe, mostly on the west shore, with some gaps to the south.";
    expect(answerAfterNote(reworded, NOTE).body).toBe("");
  });

  it("keeps prose the note does not say", () => {
    const fresh = "Snow usually closes the high passes from November to June, so check conditions first.";
    expect(answerAfterNote(fresh, NOTE).body).toBe(fresh);
  });

  it("drops Sources, Next steps and Coverage notes sections and one-line Sources labels", () => {
    const reply = [
      "Snow usually closes the high passes from November to June.",
      "",
      "## Next steps",
      "Zoom in to see more trails and pick a trailhead.",
      "",
      "**Coverage notes**",
      "OSM coverage is patchy in the backcountry.",
      "",
      "Sources: OpenStreetMap",
    ].join("\n");
    expect(answerAfterNote(reply, NOTE).body).toBe("Snow usually closes the high passes from November to June.");
  });

  it("caps the text at a trailing list that is not follow-ups", () => {
    const reply = `${NOTE}\n\nAlso:\n- Rubicon Trail\n- Tahoe Rim Trail\n- Mount Tallac\n- Eagle Falls`;
    expect(answerAfterNote(reply, NOTE)).toEqual({ body: "- Rubicon Trail\n- Tahoe Rim Trail\n- Mount Tallac\n- Eagle Falls", followUps: [] });
  });

  it("measures a repeat as the share of the paragraph's words found in the note", () => {
    const noteWords = new Set(["trails", "tahoe", "west", "shore", "400"]);
    expect(repeatShare("400 trails on the west shore", noteWords)).toBe(1);
    expect(repeatShare("snow closes passes", noteWords)).toBe(0);
    expect(repeatShare("", noteWords)).toBe(0);
  });
});

describe("notesBeforeText", () => {
  it("maps each text part after a note to the notes before it, and ignores text before any note", () => {
    const parts = [text("Looking now."), note("A"), text("B?"), note("C"), text("D?")];
    expect([...notesBeforeText(parts)]).toEqual([
      [2, "A"],
      [4, "A\n\nC"],
    ]);
  });

  it("ignores notes without markdown output", () => {
    expect(notesBeforeText([{ type: "tool-note", state: "input-available" }, text(NOTE)]).size).toBe(0);
  });
});

describe("noteForDisplay", () => {
  it("removes a Sources section or label from the note card and keeps the rest", () => {
    expect(noteForDisplay(`${NOTE}\n\n**Sources**\nOpenStreetMap`)).toBe(NOTE);
    expect(noteForDisplay(`${NOTE}\n\n**Sources:** OpenStreetMap`)).toBe(NOTE);
    expect(noteForDisplay(NOTE)).toBe(NOTE);
  });
});
