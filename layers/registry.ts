import { attributeProblems } from "./attributes";
import type { Layer } from "./types";

const layers = new Map<string, Layer>();

export function registerLayer(layer: Layer): void {
  if (layers.has(layer.id)) {
    throw new Error(`Duplicate layer id: ${layer.id}`);
  }
  // A bad attribute, help or card declaration fails at load (and in the tests), never on the map.
  const problems = attributeProblems(layer);
  if (problems.length > 0) throw new Error(`Bad attributes on ${layer.id}: ${problems.join("; ")}`);
  layers.set(layer.id, layer);
}

export function getLayer(id: string): Layer | undefined {
  return layers.get(id);
}

export function listLayers(): Layer[] {
  return [...layers.values()];
}

/** Tests only. */
export function clearRegistry(): void {
  layers.clear();
}
