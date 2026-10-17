import type { Attribute, Layer } from "@/layers/types";
import type { ViewKind } from "@/lib/render/state";
import { declaredGroups } from "@/lib/render/attributes";

/**
 * The render tool's input made exact on the server before it reaches the map (and the trace): filters written in the
 * words the user sees (chip labels such as "Hard" or "Expert", band names such as "Elite", codes such as "D3", "T4",
 * "S3" or "Class IV") become the raw values the data holds, and a question that asks where most of a measure is
 * ("most wind farms by capacity", "where is most of the capacity") draws the density view with hex cells summing that
 * measure. A question whose words call for a standard view ("busiest", "where are the most", "over the last ten years")
 * gets it when the model named none. Unknown keys and values pass through untouched.
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

/** View cues in a question's words, strongest first: only clear ones, so anything else is left to the model and the map. */
const VIEW_CUES: [Exclude<ViewKind, "change" | "scenario" | "route">, RegExp][] = [
  ["density", /\b(?:heat ?map|hot ?spots?|where (?:are|is|do) (?:the )?most|where (?:are|is) most of)\b/],
  ["timeline", /\b(?:year by year|over (?:the )?(?:last|past) (?:\d+|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|few|several) (?:years|decades)|over time|each year|by (?:the )?(?:year|decade)s?|since (?:19|20)\d\d|this (?:month|year)|in the (?:last|past) (?:\d+|few|several) (?:days|weeks|months))\b/],
  ["ranked", /\b(?:busiest|biggest|largest|highest|deepest|tallest|longest|top \d+|which\b[^?]*\b(?:the )?most)\b/],
  ["detail", /^(?:tell me about|how deep is|how tall is|how high is|what rock is)\b/],
];

/** "Show as" words in a question, for the render tool's mode: what the user asked to see, whatever the model picked. */
const MODE_CUES: [string, RegExp, Layer["style"]["geometry"][]][] = [
  ["heat", /\bheat ?maps?\b/, ["point"]],
  ["columns", /\b(?:3d|three-dimensional) columns?\b|\bas columns\b/, ["point", "polygon"]],
  ["clusters", /\bas clusters\b|\bclustered\b/, ["point"]],
  ["hexbin", /\bhex(?:agon)?(?:bins?| cells| tiles|agons)\b/, ["point"]],
];

/** The render mode a question's words ask for on a layer of this geometry ("heatmap of …": heat), or null. */
export function modeAsked(question: string, geometry: Layer["style"]["geometry"]): string | null {
  const q = question.replace(/@view=\S+/g, " ").toLowerCase();
  return MODE_CUES.find(([, cue, fits]) => cue.test(q) && fits.includes(geometry))?.[0] ?? null;
}

/** A question about change ("since 2021", "before and after", "than in 2012"): its view is the model's compare. */
const CHANGE_CUE = /\b(?:before and after|changed?|shrunk|shrink|shrank|grown|grew|smaller|bigger|less|more|compared?)\b[^?]*\b(?:since|than in|than|to|with)\b|\bbefore and after\b/;

/** True when a question asks what changed between two times ("less sea ice than in 2012", "before and after"). */
export function asksChange(question: string): boolean {
  return CHANGE_CUE.test(question.replace(/@view=\S+/g, " ").toLowerCase());
}

/** The standard view a question's words call for, or null when they name none clearly (or ask about change). */
export function viewAsked(question: string): ViewKind | null {
  const q = question.replace(/@view=\S+/g, " ").toLowerCase().trim();
  if (CHANGE_CUE.test(q)) return null;
  return VIEW_CUES.find(([, cue]) => cue.test(q))?.[0] ?? null;
}

/** True when a layer can be drawn in `view`: a timeline needs dates, density points, ranked a measure. */
function viewFits(view: ViewKind, layer: Pick<Layer, "attributes" | "style"> & { description?: string }): boolean {
  const attributes = layer.attributes ?? [];
  // Dated features: a time attribute, a time field, or a description that says each feature carries its year or date.
  if (view === "timeline") return layer.style.timeField !== undefined || attributes.some((a) => a.type === "time") || /\b(?:year|date|dated)\b/i.test(layer.description ?? "");
  if (view === "density") return layer.style.geometry === "point";
  if (view === "ranked") return attributes.some((a) => a.type === "measure") || layer.style.unit !== undefined || layer.style.extrude === "v";
  return true;
}

/**
 * The render input as the map should get it: filters on attribute values, and for "most … by <measure>" or "where is
 * most of the <measure>" on a point layer with that measure, the density view with hex cells colored by its sum.
 */
export function normalizeRenderInput(input: Obj, layer: (Pick<Layer, "attributes" | "style"> & { description?: string }) | undefined, question: string): Obj {
  if (!layer) return input;
  const attributes = layer.attributes ?? [];
  const out: Obj = { ...input };
  if (typeof out.filters === "object" && out.filters !== null && !Array.isArray(out.filters)) {
    out.filters = normalizeFilters(out.filters as Obj, attributes);
  }
  // The view the question asks for, on a layer that can draw it: filled in when the model left it out, and put in
  // place of a ranked or detail choice the words contradict ("wolf packs since 2014" drawn as one detail).
  const asked = viewAsked(question);
  // A ranked or detail choice gives way to what the words ask; change, scenario, route, timeline and density stay.
  const loose = out.view === undefined || out.view === "ranked" || out.view === "detail";
  if (asked && viewFits(asked, layer) && loose && out.view !== asked) {
    out.view = asked;
  }
  // The mode the user named ("heatmap of brown bear sightings" was drawn as clusters).
  const mode = modeAsked(question, layer.style.geometry);
  if (mode) out.mode = mode;
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
