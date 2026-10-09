import type { Layer } from "./types";

const layers = new Map<string, Layer>();

export function registerLayer(layer: Layer): void {
  if (layers.has(layer.id)) {
    throw new Error(`Duplicate layer id: ${layer.id}`);
  }
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
