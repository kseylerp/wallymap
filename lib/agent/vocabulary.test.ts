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
    expect(vocabularyForPrompt().length).toBeLessThan(4000);
  });

  it("appears in the system prompt: every layer id and every synonym", () => {
    for (const entry of VOCABULARY) {
      expect(SYSTEM_PROMPT).toContain(entry.layerId);
      for (const synonym of entry.synonyms) expect(SYSTEM_PROMPT).toContain(synonym);
    }
  });

  it("keeps campsites paired with forest-roads", () => {
    const roads = VOCABULARY.find((e) => e.layerId === "forest-roads");
    expect(roads?.notes).toContain("also query campsites");
  });
});
