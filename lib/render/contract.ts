import type { Feature, FeatureCollection } from "geojson";
import { cardTitle, displayOf, labelsOf, legendOf, sourceStatusOf, timeShapeOf, type ResolvedDisplay } from "@/layers/contract";
import type { LabelSpec, LegendSpec, SourceStatus, TimeSpec } from "@/layers/types";
import type { LoadedLayer } from "@/lib/render/state";

/**
 * The layer contract (docs/layer-contract.md) on the client: each helper resolves one loaded layer's declaration
 * (from the catalog) against its answer, through the same functions the server checks (layers/contract.ts). Results are
 * made once per answer, so the row, the card, the time panel and the map read one answer the same way.
 */

/** Per answer and per declaration (the same answer under another declaration resolves again). */
const timeMemo = new WeakMap<LoadedLayer["result"], Map<unknown, TimeSpec>>();
const legendMemo = new WeakMap<LoadedLayer["result"], Map<unknown, LegendSpec>>();

function memoized<T>(memo: WeakMap<LoadedLayer["result"], Map<unknown, T>>, result: LoadedLayer["result"], key: unknown, make: () => T): T {
  let byKey = memo.get(result);
  if (!byKey) {
    byKey = new Map();
    memo.set(result, byKey);
  }
  if (!byKey.has(key)) byKey.set(key, make());
  return byKey.get(key)!;
}

/**
 * What time means for this answer: `none` and `single` get no time panel, `snapshots` a stepper between its dates and
 * a compare, `continuous` the scrubber. The declared shape wins; otherwise inferred from the data.
 */
export function timeShape(layer: Pick<LoadedLayer, "time" | "style" | "attributes" | "result">): TimeSpec {
  return memoized(timeMemo, layer.result, layer.time ?? layer.style, () =>
    timeShapeOf({ time: layer.time, style: layer.style, attributes: layer.attributes }, layer.result),
  );
}

/** True when the layer's time is worth a panel: snapshots or continuous. */
export function hasTimePanel(layer: Pick<LoadedLayer, "time" | "style" | "attributes" | "result">): boolean {
  const shape = timeShape(layer).shape;
  return shape === "snapshots" || shape === "continuous";
}

/** The layer's key (LegendSpec) for this answer: declared, else derived from its attributes, style and data. */
export function layerKey(layer: Pick<LoadedLayer, "id" | "title" | "description" | "legend" | "attributes" | "style" | "result">): LegendSpec {
  return memoized(legendMemo, layer.result, layer.result.legend ?? layer.legend ?? layer.attributes ?? layer.id, () =>
    legendOf(
      { id: layer.id, title: layer.title, description: layer.description ?? "", legend: layer.legend, attributes: layer.attributes, style: layer.style },
      layer.result,
    ),
  );
}

/** Which features get a name on the map (LabelSpec), or undefined for none. */
export function layerLabels(layer: Pick<LoadedLayer, "labels" | "card">): LabelSpec | undefined {
  return labelsOf({ labels: layer.labels, card: layer.card });
}

/** Units and clock for the layer's numbers and times; a layer without a known coverage reads as US-centred only when its box is. */
export function layerDisplay(layer: Pick<LoadedLayer, "display" | "coverage">): ResolvedDisplay {
  return displayOf({ display: layer.display, coverage: layer.coverage ?? "global" });
}

/** The inspect card's title for a feature, never "Feature" (cardTitle). */
export function featureTitle(layer: Pick<LoadedLayer, "id" | "title" | "attributes">, feature: Pick<Feature, "properties">, rank?: number): string {
  return cardTitle({ id: layer.id, title: layer.title, attributes: layer.attributes }, feature, rank);
}

/** Whether the layer's source answered (SourceStatus): absent means it did. */
export function layerSourceStatus(layer: Pick<LoadedLayer, "result">): SourceStatus {
  return sourceStatusOf(layer.result);
}

/** The features of a GeoJSON answer, or null for tiles. */
export function featuresOf(layer: Pick<LoadedLayer, "result">): FeatureCollection | null {
  return layer.result.kind === "geojson" ? layer.result.data : null;
}

/**
 * The failure line for a layer row and the answer (docs/layer-contract.md, owner: "failures are visible"): what the
 * source did, then what the map shows for it ("NOAA's weather service is returning errors (503). Showing nothing for
 * this layer."). Null when the source answered.
 */
export function failureLine(status: SourceStatus | undefined, drawn: number | null): string | null {
  if (!status || status.ok) return null;
  const said = status.message.trim().replace(/[.;]+$/, "");
  if (status.reason === "no-data-for-date") return `${said}.`;
  const shows = drawn === null ? "Showing the latest image it gave." : drawn === 0 ? "Showing nothing for this layer." : "Showing what it returned before the error.";
  return `${said}. ${shows}`;
}
