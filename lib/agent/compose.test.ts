import { describe, expect, it } from "vitest";
import type { AnswerTemplate } from "./answer";
import { answerFirst, answersFirst, composeNote, describesMap, leadSentence, withFollowUps } from "./compose";
import { extractFollowUps } from "./followups";

const template = (over: Partial<AnswerTemplate> = {}): AnswerTemplate => ({
  layerId: "osm-trails",
  where: "near Bend",
  place: "Bend",
  count: 12,
  countGrounded: true,
  noun: { one: "hike", many: "hikes" },
  options: [
    { name: "Tumalo Falls Trail", facts: ["6.8 mi round trip", "650 ft of climb", "out and back"] },
    { name: "Pilot Butte Trail", facts: ["1.9 mi round trip", "480 ft of climb", "loop"] },
  ],
  lead: "12 hikes near Bend; the top is Tumalo Falls Trail, 6.8 mi round trip and 650 ft of climb.",
  lines: ["- **Tumalo Falls Trail**: 6.8 mi round trip, 650 ft of climb, out and back.", "- **Pilot Butte Trail**: 1.9 mi round trip, 480 ft of climb, loop."],
  allLines: ["- **Tumalo Falls Trail**: 6.8 mi round trip, 650 ft of climb, out and back.", "- **Pilot Butte Trail**: 1.9 mi round trip, 480 ft of climb, loop."],
  followUps: ["How does Tumalo Falls Trail compare with Pilot Butte Trail for length and climb?"],
  modelFirst: false,
  ...over,
});

describe("the answer first (docs/top-10-use-cases.md, answer structure)", () => {
  it("knows a sentence that describes the map from one that answers", () => {
    expect(describesMap("The map shows a short-range weather forecast for Paradise.")).toBe(true);
    expect(describesMap("**The map draws** day hikes around Bend.")).toBe(true);
    expect(answersFirst("Saturday at Paradise: high 44 °F, low 30 °F.")).toBe(true);
    expect(answersFirst("The map shows 12 hikes near Bend.")).toBe(false);
    expect(answersFirst("Hikes near Bend are drawn.")).toBe(false);
  });

  it("puts the first sentence that answers with a number ahead of one that describes the map", () => {
    const note = "The map shows forest types around the Smokies.\n\nNatural forest covers 85% of the park; planted forest 2%.";
    const out = answerFirst(note);
    expect(leadSentence(out)).toBe("Natural forest covers 85% of the park; planted forest 2%.");
    // Nothing is lost: the map sentence follows.
    expect(out).toContain("The map shows forest types around the Smokies.");
  });

  it("cuts a long first sentence at a clause when its head answers", () => {
    const long = `The Merced peaks in late May at about 2,500 cfs; ${"snowmelt from the high country feeds it through June ".repeat(4)}and it falls to a trickle by October.`;
    const out = answerFirst(long);
    expect(leadSentence(out)).toBe("The Merced peaks in late May at about 2,500 cfs.");
  });
});

describe("composeNote", () => {
  it("leads with the template's answer, lists the top options in place of the model's, and keeps the model's caveats", () => {
    const model = "The map draws day hikes around Bend.\n\n- **Swamp Wells Trail** – 26.9 km out and back.\n\nTrail conditions change; check recent reports.";
    const out = composeNote(model, template());
    expect(leadSentence(out)).toBe(template().lead);
    expect(out).toContain("- **Pilot Butte Trail**: 1.9 mi round trip");
    expect(out).not.toContain("Swamp Wells");
    expect(out).toContain("Trail conditions change; check recent reports.");
  });

  it("changes nothing the second time", () => {
    const once = composeNote("Hikes are drawn.\n\nTrail conditions change.", template());
    expect(composeNote(once, template())).toBe(once);
  });

  it("without a template, only moves the answer first and ends each line's sentence", () => {
    const out = composeNote("The map shows the soils.\nLoam covers 62% of the view", null);
    expect(leadSentence(out)).toBe("Loam covers 62% of the view.");
  });
});

describe("withFollowUps", () => {
  it("keeps an answer that ends with a list apart from the follow-ups", () => {
    const body = "12 hikes near Bend.\n\n- **Tumalo Falls Trail**: 6.8 mi round trip.";
    const text = withFollowUps(body, ["Is Tumalo Falls Trail busy?", "Which hikes near Bend are loops?", "What is the weather near Bend?"]);
    const read = extractFollowUps(text);
    expect(read.followUps).toHaveLength(3);
    expect(read.body).toBe(body);
  });
});
