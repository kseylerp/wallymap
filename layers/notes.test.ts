import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { noteProblems } from "@/lib/checks/mapChecks";

/**
 * Every coverage note a layer writes is read by the user in the layer panel and on the card, so it is a plain sentence:
 * no quoted code values, field names or snake_case (the Bears Ears note read "kind '2021' is the earlier …").
 * This reads the note strings from the source: `notes.push(…)`, `coverageNote: …` and `notes = [ … ]`, with `${…}` left out.
 */
const DIRS = ["layers", "layers/_shared", "lib/layers"];

function noteStrings(source: string): string[] {
  const out: string[] = [];
  const opener = /notes?\.push\(|coverageNote:\s*|notes(?::\s*string\[\])?\s*=\s*\[/g;
  for (const m of source.matchAll(opener)) {
    const window = withoutExpressions(source.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 800));
    // String literals in order, up to the end of the call, property or array (an end inside a string does not count).
    const token = /"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`|'(?:[^'\\\n]|\\.)*'|(\)\s*;|\]\s*;|,\s*\n|\n\s*\})/g;
    for (const t of window.matchAll(token)) {
      if (t[3] !== undefined) break;
      const text = t[1] ?? t[2];
      if (text !== undefined && /\s/.test(text)) out.push(text);
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
