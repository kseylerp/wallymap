import { attributeProblems } from "./attributes";
import { contractProblems } from "./contract";
import type { Layer } from "./types";

const layers = new Map<string, Layer>();

export function registerLayer(layer: Layer): void {
  // The dev server's hot reload evaluates a changed layer module again against the same registry: the new version
  // replaces the old there. Anywhere else (tests, production) two layers with one id are a bug.
  if (layers.has(layer.id) && process.env.NODE_ENV !== "development") {
    throw new Error(`Duplicate layer id: ${layer.id}`);
  }
  // A bad attribute, help or card declaration fails at load (and in the tests), never on the map.
  const problems = attributeProblems(layer);
  if (problems.length > 0) throw new Error(`Bad attributes on ${layer.id}: ${problems.join("; ")}`);
  // Time, legend (as resolved: every layer needs a usable key), labels and display (docs/layer-contract.md).
  const contract = contractProblems(layer);
  if (contract.length > 0) throw new Error(`Bad layer contract on ${layer.id}: ${contract.join("; ")}`);
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
