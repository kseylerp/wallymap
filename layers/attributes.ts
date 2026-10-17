import type { Attribute, AttributeType, FieldHelp, Layer } from "./types";

const TYPES: readonly AttributeType[] = ["category", "ordinal", "measure", "time", "flag", "name", "place"];
const ENCODES: readonly NonNullable<Attribute["encode"]>[] = ["color", "dash", "width", "size"];

/**
 * What is wrong with a layer's attributes, field help and card (spec §12b, §12c), as sentences; empty when nothing is.
 * Checked when the layer registers, so a bad declaration fails the build and the tests, never the map: an attribute
 * needs a key, a label and a known type, and keys do not repeat; an ordinal lists at least two levels in order and
 * names the source scale it normalises from; a category's levels (when declared) have labels and no repeated value; a
 * measure takes presets (each with a label and a bound), never levels; time, flag, name and place take neither; color
 * encodes a category or ordinal, size a measure, dash and width lines only; at most one attribute is primary, and it is
 * a category or ordinal; help needs its sentence and an https link.
 */
export function attributeProblems(layer: Pick<Layer, "id" | "style" | "fieldHelp" | "card" | "attributes">): string[] {
  const problems: string[] = [];
  const attributes = layer.attributes ?? [];
  const at = (i: number, a: Attribute) => `${layer.id} attribute ${i + 1}${a.key ? ` (${a.key})` : ""}`;
  const keys = new Set<string>();
  attributes.forEach((a, i) => {
    const where = at(i, a);
    if (!a.key?.trim()) problems.push(`${where} has no key`);
    if (!a.label?.trim()) problems.push(`${where} has no label`);
    if (keys.has(a.key)) problems.push(`${where} repeats the key ${a.key}`);
    keys.add(a.key);
    if (!TYPES.includes(a.type)) problems.push(`${where} has an unknown type`);
    if (a.encode !== undefined && !ENCODES.includes(a.encode)) problems.push(`${where} has an unknown encode`);
    if ((a.encode === "dash" || a.encode === "width") && layer.style.geometry !== "line") problems.push(`${where} encodes ${a.encode} on a ${layer.style.geometry} layer`);
    if (a.encode === "color" && a.type !== "category" && a.type !== "ordinal") problems.push(`${where} encodes color but is a ${a.type}`);
    if (a.encode === "size" && a.type !== "measure") problems.push(`${where} encodes size but is a ${a.type}`);
    if (a.primary && a.type !== "category" && a.type !== "ordinal") problems.push(`${where} is primary but is a ${a.type}; the row's chip set is a category or ordinal`);
    const levels = a.levels ?? [];
    if (a.type === "category" || a.type === "ordinal") {
      if (a.type === "ordinal" && levels.length < 2) problems.push(`${where} is an ordinal with fewer than two levels`);
      if (a.type === "ordinal" && !a.scale?.trim()) problems.push(`${where} is an ordinal that does not name its source scale`);
      const seen = new Set<string>();
      for (const level of levels) {
        if (!level.label?.trim()) problems.push(`${where} level ${String(level.value)} has no label`);
        if (seen.has(String(level.value))) problems.push(`${where} repeats the level ${String(level.value)}`);
        seen.add(String(level.value));
      }
      if (a.versions && new Set(levels.map((l) => l.label)).size < 2) problems.push(`${where} marks versions but has fewer than two`);
      if (a.presets !== undefined) problems.push(`${where} is a ${a.type} with presets`);
    } else {
      if (a.levels !== undefined) problems.push(`${where} is a ${a.type} with levels`);
      if (a.versions) problems.push(`${where} is a ${a.type} marked as versions`);
      if (a.multi) problems.push(`${where} is a ${a.type} marked multi`);
      if (a.presets !== undefined && a.type !== "measure") problems.push(`${where} is a ${a.type} with presets`);
    }
    for (const preset of a.presets ?? []) {
      if (!preset.label?.trim()) problems.push(`${where} has a preset with no label`);
      if (preset.min === undefined && preset.max === undefined) problems.push(`${where} preset "${preset.label}" has no bound`);
      if (preset.min !== undefined && preset.max !== undefined && preset.min > preset.max) problems.push(`${where} preset "${preset.label}" runs backwards`);
    }
    if (a.help) checkHelp(problems, `${where} help`, a.help);
  });
  if (attributes.filter((a) => a.primary).length > 1) problems.push(`${layer.id} marks more than one attribute primary`);
  // Two measures on one mark (spec §13): size reads a measure, color a measure, ordinal or category.
  for (const channel of ["size", "color"] as const) {
    const key = layer.style.encode?.[channel];
    if (key === undefined) continue;
    const attr = attributes.find((x) => x.key === key);
    if (!attr) problems.push(`${layer.id} encodes ${channel} by ${key}, which is not one of its attributes`);
    else if (channel === "size" && attr.type !== "measure") problems.push(`${layer.id} encodes size by ${key}, a ${attr.type}; size reads a measure`);
    else if (channel === "color" && attr.type !== "measure" && attr.type !== "ordinal" && attr.type !== "category") {
      problems.push(`${layer.id} encodes color by ${key}, a ${attr.type}; color reads a measure, ordinal or category`);
    }
  }
  for (const a of attributes) if (a.aggregate !== undefined && a.type !== "measure") problems.push(`${layer.id} attribute ${a.key} totals a ${a.type}; only a measure has an aggregate`);
  for (const a of attributes) if ((a.aggregateOver !== undefined || a.aggregateLabel !== undefined) && a.aggregate === undefined) problems.push(`${layer.id} attribute ${a.key} names how it is totalled but has no aggregate`);
  const card = layer.card;
  if (card?.measure && (!card.measure.label.trim() || /^value$/i.test(card.measure.label.trim()))) {
    problems.push(`${layer.id} card measure needs its own name, not "Value"`);
  }
  for (const fact of card?.facts ?? []) if (!fact.label.trim()) problems.push(`${layer.id} card fact ${fact.key} has no label`);
  for (const link of card?.links ?? []) if (!link.label.trim()) problems.push(`${layer.id} card link ${link.key} has no label`);
  for (const [key, help] of Object.entries(layer.fieldHelp ?? {}) as [string, FieldHelp][]) checkHelp(problems, `${layer.id} field help for ${key}`, help);
  return problems;
}

function checkHelp(problems: string[], where: string, help: FieldHelp): void {
  if (!help.text?.trim()) problems.push(`${where} has no text`);
  if (help.url !== undefined && !/^https:\/\/\S+$/.test(help.url)) problems.push(`${where} has a link that is not https`);
}
