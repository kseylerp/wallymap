import { describe, expect, it } from "vitest";
import { asksForTop, checkNote, followsStory, NOTE_MAX_WORDS, noteWords, trimNote } from "./noteCheck";
import { createTurn } from "./turn";

const uraniumTurn = () => {
  const turn = createTurn({ question: "Which uranium mines near the Navajo Nation score highest?" });
  turn.queries.push({
    layerId: "uranium",
    bbox: [-112, 35, -107, 38],
    inputKey: "[]",
    ok: true,
    drawable: true,
    wide: false,
    top: { name: "NA-0420", value: 17600, by: "Hazard score", unit: "score" },
  });
  return turn;
};

describe("note check", () => {
  it("sends a note over the word limit back once, then shows the next one", () => {
    const turn = createTurn({ question: "Show hiking trails around Lake Tahoe" });
    const long = Array.from({ length: NOTE_MAX_WORDS + 20 }, (_, i) => `word${i}`).join(" ");
    expect((checkNote(long, turn) as { error: string }).error).toMatch(/has 160 words/);
    // The rewrite is still too long: it is shown, cut to the limit.
    const shown = checkNote(long, turn) as { markdown: string };
    expect(noteWords(shown.markdown)).toBeLessThanOrEqual(NOTE_MAX_WORDS);
    expect(turn.log[0]).toMatch(/rewrite \(long\)/);
    expect(turn.noted).toBe(true);
  });

  it("cuts a long note on the last step instead of sending it back", () => {
    const turn = createTurn({ question: "Show hiking trails around Lake Tahoe" });
    const long = ["## Trails", ...Array.from({ length: 30 }, (_, i) => `- Trail ${i} runs ${i} km along the lake shore.`)].join("\n");
    const shown = checkNote(long, turn, { lastStep: true }) as { markdown: string };
    expect(noteWords(shown.markdown)).toBeLessThanOrEqual(NOTE_MAX_WORDS);
    expect(shown.markdown.startsWith("## Trails\n- Trail 0")).toBe(true);
    expect(turn.noteRewrites.size).toBe(0);
  });

  it("trimNote keeps whole lines, then whole sentences, and drops a dangling heading", () => {
    expect(trimNote("one two three.\n## Next\nfour five six.", 4)).toBe("one two three.");
    expect(trimNote("a b. c d. e f g h.", 4)).toBe("a b. c d.");
  });

  it("asks for the top one by name when the question asks which ranks highest, once", () => {
    const turn = uraniumTurn();
    expect((checkNote("Mines with high scores cluster near Cameron.", turn) as { error: string }).error).toMatch(/NA-0420 \(Hazard score 17,600\)/);
    expect(checkNote("Mines with high scores cluster near Cameron.", turn)).toBeNull();
  });

  it("passes a note that names the top one, with or without its tag", () => {
    expect(checkNote("The highest is NA-0420 at 17,600.", uraniumTurn())).toBeNull();
    const turn = uraniumTurn();
    turn.queries[0].top = { name: "Taylor Reid No. 1 (A)", value: 9000, by: "Hazard score" };
    expect(checkNote("Taylor Reid No. 1 scores highest.", turn)).toBeNull();
  });

  it("reads which questions ask for a top", () => {
    expect(asksForTop("Which uranium mines near the Navajo Nation score highest?")).toBe(true);
    expect(asksForTop("Which trails around Zion look the most popular?")).toBe(true);
    expect(asksForTop("Where are the most iNaturalist records of mountain lions?")).toBe(false);
    expect(asksForTop("Show hiking trails around Lake Tahoe")).toBe(false);
  });
});

describe("note check: names written with typographic dashes", () => {
  it("reads NA‑0420 with a non-breaking hyphen as NA-0420", () => {
    expect(checkNote("The highest is **NA‑0420** at 6,000.", uraniumTurn())).toBeNull();
  });

  it("sends a data story's note back once when it leaves out the shape, with the caption to build on", () => {
    const turn = createTurn({ question: "How has the Mississippi's flow changed over the last three months?" });
    const caption = "Flow at Mississippi: lowest 7,210 m³/s on 2026-09-20, peak 19,587 m³/s on 2026-08-31 (it nearly triples). Line width is Flow (m³/s); color is Flow vs. the period's median (%), sage low to purple high.";
    turn.queries.push({ layerId: "river-pulse", bbox: [-97, 29, -86, 48], inputKey: "[]", ok: true, drawable: true, wide: false, caption });
    const back = checkNote("The Mississippi rose and fell this summer.", turn) as { error: string };
    expect(back.error).toContain(caption);
    // The rewrite is shown either way.
    expect(checkNote("Still short.", turn)).toBeNull();
    expect(followsStory("It peaked at 19,587 m³/s on 31 August, nearly triple the 7,210 low; width is the flow and color the share of the median.")).toBe(true);
    expect(followsStory("It peaked at 19,587 m³/s on 31 August.")).toBe(false);
  });
});

describe("trimNoteFor", () => {
  it("keeps the lead, the options and the sentences that answer the question; the map's colors go first", async () => {
    const { trimNoteFor } = await import("./noteCheck");
    const note = [
      "No snow on the ground at Lake Tahoe today: 0 in at 3 stations.",
      "",
      "- Fallen Leaf: 0 in, Oct 23.",
      "- Rubicon #2: 0 in, Oct 23.",
      "",
      "Color is Snow depth, sage low to purple high. The map shows the stations as circles sized by depth. No avalanche danger rating today for the Central Sierra zone.",
    ].join("\n");
    const cut = trimNoteFor(note, "Is there snow on the ground at Lake Tahoe right now, and any avalanche danger?", 36);
    expect(cut).toMatch(/^No snow on the ground/);
    expect(cut).toContain("- Fallen Leaf");
    expect(cut).toContain("No avalanche danger rating today");
    expect(cut).not.toContain("Color is");
    expect(noteWords(cut)).toBeLessThanOrEqual(36);
  });
});
