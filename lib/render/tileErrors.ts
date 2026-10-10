import type { MapState } from "@/lib/render/state";
import { createStore } from "@/lib/render/wally/playback";

/**
 * Tile URL templates (as handed to Mapbox) whose tiles all failed: at least one failed and none loaded. A dated tile
 * layer (GIBS snow cover, an ArcGIS export) answers 404 for every tile of a date it has no image for; the scrubber
 * says so instead of showing an empty map. A template with one failed tile among loaded ones (an edge tile) is fine.
 */
export const missingTilesStore = createStore<ReadonlySet<string>>(new Set());

/** Most templates remembered; a played scrubber passes one per step. */
const MAX_TEMPLATES = 400;
const counts = new Map<string, { failed: number; loaded: number }>();

function isMissing(c: { failed: number; loaded: number }): boolean {
  return c.failed > 0 && c.loaded === 0;
}

/** Records one tile of `template` loading (`ok`) or failing, and updates the store when the template's state flips. */
export function noteTile(template: string, ok: boolean): void {
  let c = counts.get(template);
  if (!c) {
    if (counts.size >= MAX_TEMPLATES) {
      const oldest = counts.keys().next().value;
      if (oldest !== undefined) counts.delete(oldest);
    }
    c = { failed: 0, loaded: 0 };
    counts.set(template, c);
  }
  const before = isMissing(c);
  if (ok) c.loaded += 1;
  else c.failed += 1;
  const after = isMissing(c);
  if (before === after) return;
  const next = new Set(missingTilesStore.get());
  if (after) next.add(template);
  else next.delete(template);
  missingTilesStore.set(next);
}

/** True when a dated tile layer on the map (`layers`: the visible state's, with the window's URL) shows no image. */
export function hasMissingImage(layers: MapState["layers"], missing: ReadonlySet<string>): boolean {
  if (missing.size === 0) return false;
  return Object.values(layers).some((l) => l.result.kind === "tiles" && l.result.data.time !== undefined && missing.has(l.result.data.url));
}

/** Forgets everything (tests). */
export function resetTileNotes(): void {
  counts.clear();
  missingTilesStore.set(new Set());
}
