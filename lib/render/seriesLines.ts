import type { FeatureCollection } from "geojson";
import { colorT, sizeT } from "@/lib/render/encode";
import { lineSourceId, type LineEntry } from "@/lib/render/nativeLines";
import { layerFrames, seriesOf, valueAt } from "@/lib/render/series";
import type { MapState } from "@/lib/render/state";

/**
 * A series line layer moving with the playhead (spec §13: "frames step daily with smooth transitions between days"):
 * the source is uploaded once, and every animation frame each line's width and color shares (`sz`, `ct`, read by the
 * encoded paint in lib/render/nativeLines.ts) are set as feature state from its series at the playhead, interpolated
 * between the two frames around it. Only shares that moved are sent.
 */

/** What a map needs to set feature state; Mapbox's Map satisfies it. */
export type FeatureStateMap = { setFeatureState(target: { source: string; id: number }, state: Record<string, number>): void };

/** One line's shares at a fractional frame of its layer's series, or null when it has no series for the channels. */
export function sharesAt(
  properties: Record<string, unknown> | null | undefined,
  look: Extract<LineEntry["look"], { kind: "encoded" }>,
  frame: number,
): { sz?: number; ct?: number } | null {
  if (!properties) return null;
  const f = { type: "Feature", geometry: null, properties } as unknown as GeoJSON.Feature;
  const out: { sz?: number; ct?: number } = {};
  if (look.size) {
    const s = seriesOf(f, look.size.key);
    if (s) out.sz = Math.round(sizeT(valueAt(s, frame) ?? undefined, look.size.extent) * 1000) / 1000;
  }
  if (look.color) {
    const s = seriesOf(f, look.color.key);
    if (s) out.ct = Math.round((colorT(valueAt(s, frame) ?? undefined, look.color) ?? -1) * 1000) / 1000;
  }
  return out.sz === undefined && out.ct === undefined ? null : out;
}

/** Per map, per uploaded collection: the shares last sent for each line (a new upload starts over). */
const sent = new WeakMap<object, WeakMap<FeatureCollection, Map<number, string>>>();

/**
 * Sets every drawn series line's shares at the playhead `frame` (in scrubber buckets). `entries` are the line entries
 * the map draws (components/mapTiles.ts drawnLineEntries); `view` the visible state. Returns how many lines changed.
 */
export function animateSeriesLines(map: FeatureStateMap, entries: Iterable<LineEntry>, view: Pick<MapState, "layers" | "time">, frame: number): number {
  const index = view.time?.index;
  if (!index?.series) return 0;
  let byMap = sent.get(map);
  if (!byMap) {
    byMap = new WeakMap();
    sent.set(map, byMap);
  }
  let changed = 0;
  for (const entry of entries) {
    if (entry.look.kind !== "encoded" || !entry.shown) continue;
    const layer = view.layers[entry.layerId];
    if (layer?.result.kind !== "geojson" || !layer.result.series) continue;
    const frames = layerFrames(layer, index.buckets);
    const k = Math.min(frames.length - 1, Math.max(0, Math.floor(frame)));
    if (frames[k] === undefined || frames[k] < 0) continue;
    const at = frames[k] + Math.max(0, Math.min(1, frame - k));
    const source = lineSourceId(entry.id);
    const data: FeatureCollection = entry.data;
    let last = byMap.get(data);
    if (!last) {
      last = new Map();
      byMap.set(data, last);
    }
    data.features.forEach((f, i) => {
      const shares = sharesAt(f.properties, entry.look as Extract<LineEntry["look"], { kind: "encoded" }>, at);
      if (!shares) return;
      const key = `${shares.sz ?? ""}|${shares.ct ?? ""}`;
      if (last.get(i) === key) return;
      last.set(i, key);
      try {
        map.setFeatureState({ source, id: i }, shares);
        changed += 1;
      } catch {
        // The source is not on the map yet (a style still loading): the next frame sets it.
        last.delete(i);
      }
    });
  }
  return changed;
}

/** Forgets what was sent to a map's sources (a style swap drops every source and its feature state). */
export function resetSeriesLines(map: object): void {
  sent.delete(map);
}
