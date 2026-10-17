import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { noteProblems } from "@/lib/checks/mapChecks";

/**
 * Every coverage note a layer writes is read by the user in the layer panel and on the card, so it is a plain sentence:
 * no quoted code values, field names or snake_case (the Bears Ears note read "kind '2021' is the earlier …").
 * This reads the note strings from the source: `notes.push(…)` and `coverageNote: …`, with `${…}` read as a word.
 */
const DIRS = ["layers", "layers/_shared", "lib/layers"];

function noteStrings(source: string): string[] {
  const out: string[] = [];
  const call = /(?:notes?\.push\(|coverageNote:\s*)([\s\S]{0,600}?)(?:\)\s*;|,\s*\n|\n\s*\})/g;
  for (const m of source.matchAll(call)) {
    for (const lit of withoutExpressions(m[1]).matchAll(/"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
      const text = lit[1] ?? lit[2] ?? "";
      if (/\s/.test(text)) out.push(text);
    }
  }
  return out;
}

/** The text with every template expression `${…}` (nested braces and quotes included) left out. */
function withoutExpressions(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "$" || text[i + 1] !== "{") {
      out += text[i];
      continue;
    }
    let depth = 0;
    for (i += 1; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) break;
    }
  }
  return out;
}

describe("layer coverage notes", () => {
  it("are plain sentences, with no quoted code values, field names or snake_case", () => {
    const problems: string[] = [];
    for (const dir of DIRS) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
        for (const note of noteStrings(readFileSync(join(dir, file), "utf8"))) {
          for (const p of noteProblems(note)) problems.push(`${dir}/${file}: ${p} in "${note}"`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
