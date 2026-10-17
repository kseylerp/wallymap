import type { Attribute, Layer } from "@/layers/types";
import { declaredGroups } from "@/lib/render/attributes";

/**
 * The render tool's input made exact on the server before it reaches the map (and the trace): filters written in the
 * words the user sees (chip labels such as "Hard" or "Expert", band names such as "Elite", codes such as "D3", "T4",
 * "S3" or "Class IV") become the raw values the data holds, and a question that asks where most of a measure is
 * ("most wind farms by capacity", "where is most of the capacity") draws the density view with hex cells summing that
 * measure. Unknown keys and values pass through untouched.
 */

type Obj = Record<string, unknown>;
type FilterEntry = { include?: string[]; range?: [number, number]; match?: string };

const norm = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** The codes a level answers to besides its label: "D3" in "D3 Extreme Drought", "T4" in "Alpine hiking (T4)", "S3" in "S3: blocks…". */
function codesOf(label: string, help: string | undefined): string[] {
  const codes: string[] = [];
  const lead = /^([A-Z]{1,2}\d)\b/.exec(label);
  if (lead) codes.push(lead[1]);
  for (const m of label.matchAll(/\(([A-Z]{1,2}\d)\)/g)) codes.push(m[1]);
  const helpCode = help ? /^([A-Z]{1,2}\d)\s*:/.exec(help) : null;
  if (helpCode) codes.push(helpCode[1]);
  // "Class IV" also answers to "IV" and "class 4".
  const roman = /^class\s+([ivx]+)$/i.exec(label);
  if (roman) codes.push(roman[1], `class ${["", "i", "ii", "iii", "iv", "v", "vi"].indexOf(roman[1].toLowerCase())}`);
  return codes.map(norm);
}

/** The raw values one written value stands for on a chip attribute, or null when it names none of its levels. */
function valuesFor(attr: Attribute, written: string): string[] | null {
  const levels = attr.levels ?? [];
  if (levels.length === 0) return null;
  if (levels.some((l) => String(l.value) === written)) return [written];
  const w = norm(written);
  if (w === "") return null;
  // A level value written in another case or with spaces ("Mountain hiking" for mountain_hiking, "Sport" for sport).
  const byValue = levels.filter((l) => norm(String(l.value)) === w);
  if (byValue.length > 0) return byValue.map((l) => String(l.value));
  // A chip label ("Hard", "Expert", "Elite"): every value under it.
  // Also the label without its code ("Extreme Drought" for "D3 Extreme Drought", "Alpine hiking" for "Alpine hiking (T4)").
  const bare = (label: string) => norm(label.replace(/^[A-Z]{1,2}\d\s+/, "").replace(/\s*\([A-Z]{1,2}\d\)\s*$/, ""));
  const group = declaredGroups(attr).find((g) => norm(g.label) === w) ?? declaredGroups(attr).find((g) => bare(g.label) === w);
  if (group) return group.values;
  // A level's code ("D3", "T4", "S3", "Class IV", "IV").
  // A code on a label stands for the whole chip; a code from one level's help (mtb "S3") for that level alone.
  const values: string[] = [];
  for (const l of levels) {
    if (codesOf(l.label, undefined).includes(w)) values.push(...(declaredGroups(attr).find((g) => g.label === l.label)?.values ?? []));
    else if (codesOf("", l.help).includes(w)) values.push(String(l.value));
  }
  return values.length > 0 ? [...new Set(values)] : null;
}

/** The attribute a filter key means: its key, or its label ("difficulty" for mtb-trails' v). */
function attributeFor(attributes: Attribute[], key: string): Attribute | undefined {
  return attributes.find((a) => a.key === key) ?? attributes.find((a) => norm(a.label) === norm(key));
}

/** render.filters with labels, band names and codes turned into the values the data holds. */
export function normalizeFilters(filters: Obj, attributes: Attribute[]): Obj {
  const out: Obj = {};
  for (const [key, raw] of Object.entries(filters)) {
    const attr = attributeFor(attributes, key);
    const target = attr?.key ?? key;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      out[target] = raw;
      continue;
    }
    const entry = { ...(raw as FilterEntry) };
    if (attr && Array.isArray(entry.include)) {
      const values: string[] = [];
      for (const v of entry.include) {
        if (typeof v !== "string") continue;
        const mapped = valuesFor(attr, v);
        // A category without declared levels takes its chips from the data, which holds lower-case values ("wind").
        const fallback = (attr.levels ?? []).length === 0 && v !== v.toLowerCase() ? [v, v.toLowerCase()] : [v];
        for (const value of mapped ?? fallback) if (!values.includes(value)) values.push(value);
      }
      entry.include = values;
    }
    out[target] = entry;
  }
  return out;
}

/** Where a question names a measure after "most … by" or "where is most of the": the measure's words, or null. */
export function measureAsked(question: string): string | null {
  const q = question.replace(/@view=\S+/g, " ");
  const end = String.raw`(?=\s+(?:in|near|around|at|across|on|within|for|over)\b|\s*[?.!,]|\s*$)`;
  const by = new RegExp(String.raw`\bmost\b[^?.!]*?\bby\s+(?:their\s+|its\s+|the\s+)?([a-z][a-z -]*?)${end}`, "i").exec(q);
  if (by) return by[1].trim();
  const of = new RegExp(String.raw`\bwhere\s+(?:is|are|'s)\s+most\s+of\s+the\s+([a-z][a-z -]*?)${end}`, "i").exec(q);
  return of ? of[1].trim() : null;
}

/** The layer's measure attribute the words name (its label, key or unit), or undefined. */
function measureNamed(attributes: Attribute[], words: string): Attribute | undefined {
  const w = norm(words);
  return attributes
    .filter((a) => a.type === "measure")
    .find((a) => {
      const label = norm(a.label);
      return w === label || w.split(" ").includes(label) || label.split(" ").includes(w) || norm(a.key) === w || (a.unit !== undefined && norm(a.unit) === w);
    });
}

/**
 * The render input as the map should get it: filters on attribute values, and for "most … by <measure>" or "where is
 * most of the <measure>" on a point layer with that measure, the density view with hex cells colored by its sum.
 */
export function normalizeRenderInput(input: Obj, layer: Pick<Layer, "attributes" | "style"> | undefined, question: string): Obj {
  if (!layer) return input;
  const attributes = layer.attributes ?? [];
  const out: Obj = { ...input };
  if (typeof out.filters === "object" && out.filters !== null && !Array.isArray(out.filters)) {
    out.filters = normalizeFilters(out.filters as Obj, attributes);
  }
  const words = measureAsked(question);
  const measure = words ? measureNamed(attributes, words) : undefined;
  if (measure && layer.style.geometry === "point") {
    out.view = "density";
    out.hexBasis = "sum";
    delete out.hexShare;
    if (out.mode !== "columns" && out.mode !== "hexbin") delete out.mode;
    if (measure.key !== "v") out.rankBy = measure.key;
  }
  return out;
}
