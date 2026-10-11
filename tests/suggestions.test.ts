import { describe, expect, it } from "vitest";
import { FIRST_VISIT, SUGGESTION_POOL, SET_SIZE, THEMES, suggestionSet } from "@/lib/suggestions";

describe("suggestion pool", () => {
  it("has about forty distinct questions, each tagged with a theme and a named place", () => {
    expect(SUGGESTION_POOL.length).toBeGreaterThanOrEqual(38);
    expect(new Set(SUGGESTION_POOL.map((s) => s.q)).size).toBe(SUGGESTION_POOL.length);
    for (const s of SUGGESTION_POOL) {
      expect(THEMES).toContain(s.theme);
      expect(s.needsPlace).toBe(true);
    }
  });

  it("gives every theme at least two questions, so both halves of the rotation have one", () => {
    for (const theme of THEMES) {
      expect(SUGGESTION_POOL.filter((s) => s.theme === theme).length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("suggestionSet", () => {
  it("set 0 is the six starters", () => {
    expect(suggestionSet(0)).toEqual([...FIRST_VISIT]);
  });

  it("is repeatable per index, draws six themes once each, and never repeats the set before it", () => {
    for (let i = 1; i < 200; i++) {
      const set = suggestionSet(i);
      expect(suggestionSet(i)).toEqual(set);
      expect(set).toHaveLength(SET_SIZE);
      const themes = set.map((q) => SUGGESTION_POOL.find((s) => s.q === q)?.theme);
      expect(new Set(themes).size).toBe(SET_SIZE);
      const before = suggestionSet(i - 1);
      expect(set.filter((q) => before.includes(q))).toEqual([]);
    }
  });
});
