import type { LoadedLayer, MapState } from "@/lib/render/state";
import { createStore } from "@/lib/render/wally/playback";
import { periodOfUrl } from "@/lib/time";

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

const fallbackMemo = new WeakMap<MapState, { missing: ReadonlySet<string>; out: MapState }>();

/** The loaded layer behind a drawn dated tile layer whose window's image is missing, when its own image is not. */
function fallbackFor(drawn: LoadedLayer, loaded: LoadedLayer | undefined, missing: ReadonlySet<string>): LoadedLayer | null {
  if (drawn.result.kind !== "tiles" || !drawn.result.data.time || !missing.has(drawn.result.data.url)) return null;
  if (loaded?.result.kind !== "tiles" || loaded.result.data.url === drawn.result.data.url || missing.has(loaded.result.data.url)) return null;
  return { ...drawn, result: { ...drawn.result, data: { ...drawn.result.data, url: loaded.result.data.url } } };
}

/**
 * The drawn state with every dated tile layer whose window has no image pointed back at the image it was loaded with
 * (the newest the source had when asked), so a date with no data shows the latest available picture, never a blank
 * map. `view` is the visible state (lib/render/view.ts), `state` the loaded one.
 */
export function withTileFallback(view: MapState, state: MapState, missing: ReadonlySet<string>): MapState {
  if (missing.size === 0) return view;
  const hit = fallbackMemo.get(view);
  if (hit && hit.missing === missing) return hit.out;
  let changed = false;
  const layers: MapState["layers"] = {};
  for (const [id, drawn] of Object.entries(view.layers)) {
    const next = fallbackFor(drawn, state.layers[id], missing);
    if (next) changed = true;
    layers[id] = next ?? drawn;
  }
  const out = changed ? { ...view, layers } : view;
  fallbackMemo.set(view, { missing, out });
  return out;
}

const DAY_FORMAT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" };

function periodText(ms: number | null, yearly: boolean): string {
  if (ms === null) return "the loaded date";
  return yearly ? String(new Date(ms).getUTCFullYear()) : new Date(ms).toLocaleDateString("en-US", DAY_FORMAT);
}

/**
 * What the scrubber says when a dated tile layer has no image for the window's date: "No image for Oct 12, 2026;
 * showing Oct 15, 2026" (the image it was loaded with), or null when every dated layer has its image.
 */
export function missingImageText(view: MapState, state: MapState, missing: ReadonlySet<string>): string | null {
  for (const [id, drawn] of Object.entries(view.layers)) {
    if (drawn.result.kind !== "tiles" || !drawn.result.data.time || !missing.has(drawn.result.data.url)) continue;
    const time = drawn.result.data.time;
    const yearly = time.cadence === "yearly";
    const asked = periodText(periodOfUrl(drawn.result.data.url, time), yearly);
    const loaded = state.layers[id];
    if (fallbackFor(drawn, loaded, missing) && loaded?.result.kind === "tiles") {
      return `No image for ${asked}; showing ${periodText(periodOfUrl(loaded.result.data.url, time), yearly)}`;
    }
    return `No image for ${asked}`;
  }
  return null;
}

/** Forgets everything (tests). */
export function resetTileNotes(): void {
  counts.clear();
  missingTilesStore.set(new Set());
}
