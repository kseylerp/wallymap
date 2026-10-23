import { describe, expect, it } from "vitest";
import { listLayers } from "@/layers";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";
import { VOCABULARY, vocabularyForPrompt } from "@/lib/agent/vocabulary";

describe("VOCABULARY", () => {
  const ids = listLayers().map((l) => l.id);

  it("only names registered layers", () => {
    for (const entry of VOCABULARY) expect(ids).toContain(entry.layerId);
  });

  it("has an entry for every registered layer", () => {
    const covered = VOCABULARY.map((e) => e.layerId);
    for (const id of ids) expect(covered).toContain(id);
  });

  it("lists each layer once, each with at least one synonym", () => {
    expect(new Set(VOCABULARY.map((e) => e.layerId)).size).toBe(VOCABULARY.length);
    for (const entry of VOCABULARY) expect(entry.synonyms.length).toBeGreaterThan(0);
  });

  it("renders a table small enough for the prompt", () => {
    expect(vocabularyForPrompt().length).toBeLessThan(11_500);
  });

  it("gives every layer a 6-to-10-word gist for list_layers, kept out of the prompt", () => {
    for (const entry of VOCABULARY) {
      const words = entry.gist.split(/\s+/).filter(Boolean).length;
      expect(words, `${entry.layerId}: "${entry.gist}"`).toBeGreaterThanOrEqual(6);
      expect(words, `${entry.layerId}: "${entry.gist}"`).toBeLessThanOrEqual(10);
    }
    expect(vocabularyForPrompt()).not.toContain(VOCABULARY[0].gist);
  });

  it("appears in the system prompt: every layer id and every synonym", () => {
    for (const entry of VOCABULARY) {
      expect(SYSTEM_PROMPT).toContain(entry.layerId);
      for (const synonym of entry.synonyms) expect(SYSTEM_PROMPT).toContain(synonym);
    }
  });

  it("gives each synonym to one layer only", () => {
    const owners = new Map<string, string>();
    for (const entry of VOCABULARY) {
      for (const synonym of entry.synonyms) {
        expect(owners.get(synonym.toLowerCase()), `"${synonym}" is on ${owners.get(synonym.toLowerCase())} and ${entry.layerId}`).toBeUndefined();
        owners.set(synonym.toLowerCase(), entry.layerId);
      }
    }
  });

  it("does not route common words that belong to other layers", () => {
    // "trails in Yosemite National Park", "how deep is the snow", "fire history" each matched an unrelated layer.
    const bare = VOCABULARY.flatMap((e) => e.synonyms.map((s) => s.toLowerCase()));
    for (const word of ["national park", "depth", "history"]) expect(bare).not.toContain(word);
  });

  it("keeps campsites paired with forest-roads", () => {
    const roads = VOCABULARY.find((e) => e.layerId === "forest-roads");
    expect(roads?.notes).toContain("also query campsites");
  });
});
