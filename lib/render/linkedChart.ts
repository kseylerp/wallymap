import type { Feature } from "geojson";
import { fieldAt, flowFrame, sampleField } from "@/lib/render/particles";
import { aggregateMeasure, layerFrames, seriesOf } from "@/lib/render/series";
import type { LoadedLayer, MapState } from "@/lib/render/state";

/**
 * The linked curve under the time scrubber (spec §13a: "a small time-series chart beside the map with the playhead
 * synced, so reversals line up with high and low tide; reused for river discharge, wind speed at a point"), the pure
 * half. Which curve: a layer's own linked series (the tide at the nearest station for currents); else the selected
 * feature's series (discharge at the selected reach); else for a flow field its speed at the map's center; else the
 * series layer's leading feature (the reach with the most flow). One value per scrubber bucket.
 */
export type LinkedCurve = {
  /** "Tide height at Anchorage", "Flow at the Mississippi (selected)". */
  title: string;
  unit: string;
  values: (number | null)[];
  /** Where the curve comes from, for its source line. */
  source?: string;
};

function round(n: number): number {
  return Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
}

/** A feature's series of `key` on the scrubber's buckets. */
function onBuckets(layer: LoadedLayer, f: Feature, key: string, buckets: readonly { start: string }[]): (number | null)[] {
  const s = seriesOf(f, key);
  if (!s) return [];
  return layerFrames(layer, buckets).map((k) => (k >= 0 && typeof s[k] === "number" ? (s[k] as number) : null));
}

/** The feature with the most of `key` on average over the observed frames. */
function leadOf(layer: LoadedLayer, key: string): Feature | undefined {
  if (layer.result.kind !== "geojson") return undefined;
  const now = layer.result.series?.now ?? Infinity;
  let best: { f: Feature; mean: number } | undefined;
  for (const f of layer.result.data.features) {
    const s = seriesOf(f, key);
    if (!s) continue;
    const vals = s.slice(0, now + 1).filter((v): v is number => typeof v === "number");
    if (vals.length === 0) continue;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (!best || mean > best.mean) best = { f, mean };
  }
  return best?.f;
}

const centerMemo = new WeakMap<object, Map<string, (number | null)[]>>();

/** The curve to plot for the map as it is, or null when no shown layer has one. `center` is the map's center. */
export function linkedCurve(state: Pick<MapState, "time" | "layers" | "renderOps" | "selected">, center: [number, number] | null): LinkedCurve | null {
  const time = state.time;
  if (!time?.index.series) return null;
  const buckets = time.index.buckets;
  const shown = [...state.renderOps]
    .reverse()
    .filter((op) => op.visible)
    .map((op) => state.layers[op.layerId])
    .filter((l): l is LoadedLayer => l?.result.kind === "geojson" && l.result.series !== undefined);
  // 1. A layer's own linked series (the tide).
  for (const layer of shown) {
    const linked = layer.result.kind === "geojson" ? layer.result.linked : undefined;
    if (!linked) continue;
    const byHour = new Map(linked.times.map((t, k) => [Date.parse(t), linked.values[k]]));
    return {
      title: `${linked.label} at ${linked.place}`,
      unit: linked.unit,
      values: buckets.map((b) => byHour.get(Date.parse(b.start)) ?? null),
      ...(linked.source && { source: linked.source.source }),
    };
  }
  // 2. The selected feature's own series (discharge at the selected reach).
  const picked = state.selected ? shown.find((l) => l.id === state.selected?.layerId) : undefined;
  const pickedMeasure = picked && aggregateMeasure(picked);
  if (picked && pickedMeasure && state.selected) {
    const values = onBuckets(picked, state.selected.feature, pickedMeasure.key, buckets);
    if (values.some((v) => v !== null)) {
      const name = typeof state.selected.feature.properties?.name === "string" ? state.selected.feature.properties.name : "the selected feature";
      return { title: `${pickedMeasure.label} at ${name} (selected)`, unit: pickedMeasure.unit ?? "", values };
    }
  }
  for (const layer of shown) {
    const measure = aggregateMeasure(layer);
    if (!measure || layer.result.kind !== "geojson") continue;
    // 3. A flow field: its speed at the map's center, frame by frame (remembered per data and center).
    if (layer.result.flow && center) {
      const key = `${center[0].toFixed(2)},${center[1].toFixed(2)}|${buckets.length}|${buckets[0]?.start}`;
      let byKey = centerMemo.get(layer.result.data);
      if (!byKey) {
        byKey = new Map();
        centerMemo.set(layer.result.data, byKey);
      }
      let values = byKey.get(key);
      if (!values) {
        values = buckets.map((_, k) => {
          const field = fieldAt(layer, flowFrame(layer, state, k));
          const at = field && sampleField(field, center[0], center[1]);
          return at ? round(Math.hypot(at.u, at.v)) : null;
        });
        if (byKey.size > 16) byKey.clear();
        byKey.set(key, values);
      }
      if (values.some((v) => v !== null)) return { title: `${measure.label} at the map's center`, unit: measure.unit ?? "", values };
      continue;
    }
    // 4. The feature with the most of the measure (the reach with the most flow).
    const lead = leadOf(layer, measure.key);
    if (!lead) continue;
    const name = typeof lead.properties?.name === "string" ? lead.properties.name : "the largest feature";
    return { title: `${measure.label} at the ${name}, where it is highest`, unit: measure.unit ?? "", values: onBuckets(layer, lead, measure.key, buckets) };
  }
  return null;
}
