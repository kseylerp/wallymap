/**
 * Names as people say them. Catalogues file a name with its article moved to the end ("Oasis, The", "Battery, The",
 * "Narrows, The"), and OpenBeta and some OpenStreetMap editors copy that order. A trailing ", The", ", A" or ", An"
 * (any case) goes back to the front: "The Oasis". Anything else is left exactly as it is.
 */
const TRAILING_ARTICLE = /^(.+?),\s*(the|a|an)\s*$/i;

export function naturalName(name: string): string {
  const m = TRAILING_ARTICLE.exec(name.trim());
  if (!m || m[1].trim() === "") return name;
  const article = m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase();
  return `${article} ${m[1].trim()}`;
}

/** A feature's `name` (and any `names` it merged) read through naturalName; other properties untouched. */
export function withNaturalName<P extends Record<string, unknown> | null>(properties: P): P {
  if (!properties || typeof properties.name !== "string") return properties;
  const name = naturalName(properties.name);
  return name === properties.name ? properties : ({ ...properties, name } as P);
}
