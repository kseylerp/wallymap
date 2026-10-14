import type { Facet, FieldHelp, Layer } from "./types";

const ENCODES: readonly NonNullable<Facet["encode"]>[] = ["color", "dash", "width", "size"];

/**
 * What is wrong with a layer's facets and field help (spec §12a, §12b), as sentences; empty when nothing is. Checked
 * when the layer registers, so a bad declaration fails the build and the tests, never the map: a facet needs a key, a
 * label and a kind; a category facet needs values with labels and no repeated value; a range facet takes no values;
 * at most two facets; dash and width encode lines only, size points and areas; help needs its sentence and an https link.
 */
export function facetProblems(layer: Pick<Layer, "id" | "style" | "fieldHelp" | "card">): string[] {
  const problems: string[] = [];
  const facets = layer.style.facets ?? [];
  const at = (i: number) => `${layer.id} facet ${i + 1}`;
  if (facets.length > 2) problems.push(`${layer.id} declares ${facets.length} facets; one or two are what people filter by`);
  const keys = new Set<string>();
  facets.forEach((facet: Facet, i) => {
    if (!facet.key?.trim()) problems.push(`${at(i)} has no key`);
    if (!facet.label?.trim()) problems.push(`${at(i)} (${facet.key}) has no label`);
    if (keys.has(facet.key)) problems.push(`${at(i)} repeats the key ${facet.key}`);
    keys.add(facet.key);
    if (facet.kind !== "category" && facet.kind !== "range") problems.push(`${at(i)} (${facet.key}) has an unknown kind`);
    if (facet.encode !== undefined && !ENCODES.includes(facet.encode)) problems.push(`${at(i)} (${facet.key}) has an unknown encode`);
    if ((facet.encode === "dash" || facet.encode === "width") && layer.style.geometry !== "line") {
      problems.push(`${at(i)} (${facet.key}) encodes ${facet.encode} on a ${layer.style.geometry} layer`);
    }
    if (facet.kind === "category") {
      const values = facet.values ?? [];
      if (values.length === 0) problems.push(`${at(i)} (${facet.key}) is a category with no values`);
      const seen = new Set<string>();
      for (const v of values) {
        if (!v.label?.trim()) problems.push(`${at(i)} (${facet.key}) value ${String(v.value)} has no label`);
        if (seen.has(String(v.value))) problems.push(`${at(i)} (${facet.key}) repeats the value ${String(v.value)}`);
        seen.add(String(v.value));
      }
      if (facet.versions && new Set(values.map((v) => v.label)).size < 2) problems.push(`${at(i)} (${facet.key}) marks versions but has fewer than two`);
    } else if (facet.kind === "range") {
      if (facet.values !== undefined) problems.push(`${at(i)} (${facet.key}) is a range with values`);
      if (facet.versions) problems.push(`${at(i)} (${facet.key}) is a range marked as versions`);
    }
  });
  const card = layer.card;
  if (card?.measure && (!card.measure.label.trim() || /^value$/i.test(card.measure.label.trim()))) {
    problems.push(`${layer.id} card measure needs its own name, not "Value"`);
  }
  for (const fact of card?.facts ?? []) if (!fact.label.trim()) problems.push(`${layer.id} card fact ${fact.key} has no label`);
  for (const link of card?.links ?? []) if (!link.label.trim()) problems.push(`${layer.id} card link ${link.key} has no label`);
  for (const [key, help] of Object.entries(layer.fieldHelp ?? {}) as [string, FieldHelp][]) {
    if (!help.text?.trim()) problems.push(`${layer.id} field help for ${key} has no text`);
    if (help.url !== undefined && !/^https:\/\/\S+$/.test(help.url)) problems.push(`${layer.id} field help for ${key} has a link that is not https`);
  }
  return problems;
}
