import type { Feature, FeatureCollection } from "geojson";
import type { BBox } from "@/layers/types";
import { defaultCompare, snapshotCompare, versionCompare, windowText } from "@/lib/render/compareView";
import { changeStatement, identityKey, type ChangeStatement } from "@/lib/render/change";
import { splitWindows } from "@/lib/render/compare";
import { timeShape } from "@/lib/render/contract";
import { shortTitle } from "@/layers/contract";
import { attributeFor, isLowFirst, measureKeyOf, primaryMeasure, topFeatures, versionSides, versionsAttribute } from "@/lib/render/attributes";
import { applyFilters, type LayerFilters } from "@/lib/render/filters";
import { featureBBox } from "@/lib/render/inspect";
import { scenarioOf } from "@/lib/render/scenario";
import type { Basemap, CompareState, LoadedLayer, ViewKind } from "@/lib/render/state";
import { categoryKey } from "@/lib/render/categories";

/**
 * The standard views (spec §12), the pure half: which view a layer's data asks for when the agent names none, what the
 * camera fits for each, and the compare a change view opens. The reducer applies them (lib/render/reducer.ts
 * `applyView`); the client draws each the same way every time.
 */

/** More points than this read as a density question (clusters by default). */
export const DENSITY_MIN_POINTS = 500;
/** A ranked view lists the top N in the layer row and labels them on the map. */
export const RANKED_TOP_N = 10;
/** How many of the ranked top features get a name label on the map. */
export const RANKED_LABELS = 6;

/** Features per calendar day of `t`. */
function dateCounts(data: FeatureCollection): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of data.features) {
    const t = f.properties?.t;
    if (typeof t === "string" && !Number.isNaN(Date.parse(t))) out.set(t.slice(0, 10), (out.get(t.slice(0, 10)) ?? 0) + 1);
  }
  return out;
}

function dates(data: FeatureCollection): Set<string> {
  return new Set(dateCounts(data).keys());
}

/**
 * The view a layer's data asks for when the agent named none: one feature is a detail; a scenario tile layer a
 * scenario; two versions of the same features (a `versions` attribute, monument boundaries) or exactly two dates of several features each a change;
 * other dated features a timeline; more than 500 points a density. Undefined when nothing stands out (the layer then
 * draws as it always has). Ranked needs the user's superlative words, so only the agent names it.
 */
export function defaultView(layer: LoadedLayer, filters?: LayerFilters): ViewKind | undefined {
  if (layer.result.kind === "tiles") return scenarioOf(layer) ? "scenario" : undefined;
  // A value per frame (river pulse, currents, wind) is a timeline: the scrubber plays its days or hours.
  if (layer.result.series) return "timeline";
  const data = filters ? applyFilters(layer.result.data, filters) : layer.result.data;
  const n = data.features.length;
  if (n === 0) return undefined;
  if (n === 1) return "detail";
  const versions = versionsAttribute(layer);
  if (versions && versionSides(versions, data)) return "change";
  // What time means decides the rest (docs/layer-contract.md): snapshots draw the newest of each thing, with the change
  // stated in the row and the stepper one tap away; continuous dates are a timeline; none and single are not about time.
  const shape = timeShape(layer).shape;
  if (shape === "continuous" && dates(data).size >= 2) return "timeline";
  if (layer.style.geometry === "point" && n > DENSITY_MIN_POINTS) return "density";
  return undefined;
}

/** The measure a change is stated in: area when features carry `areaKm2`, else the primary measure, else `v`. */
function changeMeasure(layer: LoadedLayer, features: readonly Feature[]): { key: string; label: string; unit?: string } | undefined {
  const has = (key: string) => features.some((f) => typeof f.properties?.[key] === "number");
  const measure = primaryMeasure(layer);
  if (has("areaKm2")) return { key: "areaKm2", label: "Area", unit: "km²" };
  if (measure && has(measure.key)) return { key: measure.key, label: measure.label, ...(measure.unit && { unit: measure.unit }) };
  if (has("v") && layer.style.unit && layer.style.unit !== "score") return { key: "v", label: "Value", unit: layer.style.unit };
  return undefined;
}

/**
 * The one-line change between two sides of a layer (its compare, else its first and last snapshot epochs), computed from
 * the data: "121 glaciers mapped in both the 1960s–70s and the 2010s lost 48% of their area (42.4 to 21.9 km²)."
 * Null when the layer has nothing to compare.
 */
export function layerChange(layer: LoadedLayer, filters?: LayerFilters, compare?: CompareState): ChangeStatement | null {
  if (layer.result.kind !== "geojson") return null;
  const spec = compare && compare.layerId === layer.id && !compare.scenario ? compare : snapshotCompare(layer);
  if (!spec) return null;
  const data = filters ? applyFilters(layer.result.data, filters) : layer.result.data;
  const { a, b } = splitWindows(data, spec);
  const field = layer.style.timeField ?? "t";
  const aLabel = spec.aLabel ?? windowText(spec.a);
  const bLabel = spec.bLabel ?? windowText(spec.b);
  return changeStatement(a.features, b.features, {
    noun: shortTitle(layer).toLowerCase(),
    aLabel,
    bLabel,
    idKey: identityKey(data.features, spec.by?.key ?? field),
    measure: changeMeasure(layer, data.features),
    timeField: field,
  });
}

/** The bounding box around every feature's own box; null when none has coordinates. */
export function boundsOf(features: readonly Feature[]): BBox | null {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of features) {
    const b = featureBBox(f);
    if (!b) continue;
    [w, s, e, n] = [Math.min(w, b[0]), Math.min(s, b[1]), Math.max(e, b[2]), Math.max(n, b[3])];
  }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

/** The union of two boxes (either may be missing). */
export function unionBBox(a: BBox | null | undefined, b: BBox | null | undefined): BBox | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** The smallest span a camera fit gets (about 1 km), so one point or a short line is framed, not zoomed to the max. */
export const MIN_FIT_SPAN_DEG = 0.01;

/** A box widened around its center to at least MIN_FIT_SPAN_DEG each way. */
export function padBBox(bbox: BBox): BBox {
  const [w, s, e, n] = bbox;
  if (e - w >= MIN_FIT_SPAN_DEG && n - s >= MIN_FIT_SPAN_DEG) return bbox;
  const cx = (w + e) / 2;
  const cy = (s + n) / 2;
  const hw = Math.max(e - w, MIN_FIT_SPAN_DEG) / 2;
  const hh = Math.max(n - s, MIN_FIT_SPAN_DEG) / 2;
  return [cx - hw, cy - hh, cx + hw, cy + hh];
}

/**
 * What the camera fits for a view of a layer (its drawn features, after `filters`): change and the others the whole
 * data (a change view's data holds both sides, so this is their union); ranked the top N by the layer's measure;
 * detail the one feature. Null for tiles (the caller falls back to the named place) and empty data.
 */
export function viewTarget(view: ViewKind | undefined, layer: LoadedLayer, filters?: LayerFilters, rankBy?: string): BBox | null {
  if (layer.result.kind !== "geojson") return null;
  const data = filters ? applyFilters(layer.result.data, filters) : layer.result.data;
  if (view === "ranked") {
    // The measure the row ranks by (Tahoe's view hikes ranked by length framed the top by distance to a viewpoint).
    const key = rankBy ?? measureKeyOf(layer);
    const top = topFeatures(data, key, RANKED_TOP_N, isLowFirst(layer, key));
    if (top.length > 0) return boundsOf(top);
  }
  return boundsOf(data.features);
}

/**
 * The compare a change view opens: for a `versions` attribute, the earliest version present against the newest, by
 * version (`by`), labelled in the attribute's words; for dated features, the layer's own default compare (its preset, or the span
 * cut in two halves). Delta, so lost and gained show on one map. Null when the layer has neither.
 */
export function changeCompare(layer: LoadedLayer, today: Date = new Date()): CompareState | null {
  const byVersion = versionCompare(layer);
  if (byVersion) return byVersion;
  const bySnapshot = snapshotCompare(layer);
  if (bySnapshot) return bySnapshot;
  if (layer.result.kind === "geojson") {
    if (dates(layer.result.data).size < 2) return null;
  } else if (!layer.result.data.time && (!layer.result.data.scenario || layer.result.data.scenario.control === "toggle")) {
    return null;
  }
  const compare = defaultCompare(layer, today);
  // Tiles have no features to diff: they swipe (a scenario) or toggle.
  return layer.result.kind === "tiles" ? compare : { ...compare, mode: "delta" };
}

/**
 * The measure a ranked view ranks by (spec §12c: ranked, not filtered): the layer's primary measure, else `v` when the
 * features carry one; undefined for a layer with nothing to rank (a class is not a magnitude).
 */
export function rankedMeasure(layer: LoadedLayer): string | undefined {
  const measure = primaryMeasure(layer);
  if (measure) return measure.key;
  if (attributeFor(layer, "v")) return undefined;
  if (layer.result.kind !== "geojson") return undefined;
  return layer.result.data.features.some((f) => typeof f.properties?.v === "number") ? "v" : undefined;
}

/** A line network with at least this many lines draws the land by itself (spec §13), so the console offers Data only. */
export const DENSE_NETWORK_MIN_LINES = 150;

/**
 * True when a drawn layer is a dense network the basemap should step back for (spec §13, "the data draws the
 * geography"): a series of the whole network (river pulse), a flow field (currents, wind), or a line layer drawing at
 * least DENSE_NETWORK_MIN_LINES lines.
 */
export function isDenseNetwork(layer: LoadedLayer, op: { visible: boolean; mode: string } | undefined): boolean {
  if (!op?.visible || layer.result.kind !== "geojson") return false;
  if (layer.result.series || layer.result.flow) return true;
  return layer.style.geometry === "line" && op.mode === "lines" && layer.result.data.features.length >= DENSE_NETWORK_MIN_LINES;
}

/**
 * The basemap a drawn layer's row offers (spec §13): the one its style names, else Data only for a dense network;
 * undefined when the layer has no preference.
 */
export function preferredBasemap(layer: LoadedLayer, op: { visible: boolean; mode: string } | undefined): "data-only" | "outdoors" | undefined {
  if (!op?.visible) return undefined;
  return layer.style.basemap ?? (isDenseNetwork(layer, op) ? "data-only" : undefined);
}

/**
 * True for a map whose areas are colored by a ramp or by kind (temperature anomaly by county, hardiness zones, drought,
 * geology, land cover, protected areas by category): the color is the answer, and satellite imagery under it changes
 * every color, so such answers open on Topographical (or the layer's own basemap), never Satellite (owner, 2026-10-18).
 * Snapshot and version layers (glacier surveys, monument boundaries) color by date, not value, and keep the imagery.
 */
export function isChoropleth(layer: LoadedLayer): boolean {
  if (layer.style.geometry !== "polygon" || layer.style.unit === "score") return false;
  if (timeShape(layer).shape === "snapshots") return false;
  // Two versions of the same areas (monument boundaries, 2021 against current) compare outlines, not values.
  if (layer.attributes?.some((a) => a.versions)) return false;
  if (layer.style.encode?.color) return true;
  const legend = layer.result.legend ?? layer.legend;
  if (legend && (legend.kind === "categories" || legend.kind === "ramp")) {
    const colored = [...(legend.items ?? []), ...(legend.stops ?? [])].filter((i) => i.color).length;
    if (colored >= 3) return true;
  }
  const all = layer.allData ?? (layer.result.kind === "geojson" ? layer.result.data : null);
  return categoryKey(layer, all) !== undefined;
}

/** The basemap a choropleth answer opens on when the map is on imagery: its own preference, else Topographical. */
export function choroplethBasemap(layer: LoadedLayer, current: Basemap): Basemap | undefined {
  if (current !== "satellite" && current !== "outdoors-satellite") return undefined;
  if (layer.style.keepImagery) return undefined;
  return isChoropleth(layer) ? (layer.style.basemap ?? "outdoors") : undefined;
}

/** The legend's sentence for a view: what the encoding means, in words (spec §12: "what pink means in this view"). */
export function viewCaption(view: ViewKind | undefined, layer: LoadedLayer, compare?: CompareState, hexes?: string): string | undefined {
  const measure = attributeFor(layer, measureKeyOf(layer));
  const measureWord = (measure?.label ?? "value").toLowerCase();
  switch (view) {
    case "change": {
      if (!compare || compare.layerId !== layer.id) return undefined;
      const a = compare.aLabel ?? "A";
      const b = compare.bLabel ?? "B";
      if (layer.style.geometry === "polygon") {
        const [la, lb] = [a, b].map((x) => (/^[A-Z][a-z]/.test(x) ? x.toLowerCase() : x));
        return `Pink hatch: only in ${la} · pink line: ${la} edge · grey: ${lb} · purple: only in ${lb}`;
      }
      return `Pink hatch: only ${a.toLowerCase()} · purple: ${b.toLowerCase()} · grey: both`;
    }
    case "ranked":
      if (measure && measure.type !== "measure") return undefined;
      return layer.style.geometry === "point" ? `Symbol size: ${measureWord}; the top ${RANKED_TOP_N} named` : `Top ${RANKED_TOP_N} by ${measureWord}`;
    case "density":
      // A picture from map tiles has no features to cluster (vegetation types read "Clusters count the features...").
      if (layer.result.kind === "tiles") return undefined;
      // Hex cells say what their color means and how big they are (spec §12d).
      return hexes ?? "Clusters count the features near each other; zoom in to split them";
    case "timeline":
      if (layer.result.kind === "geojson" && layer.result.series) {
        return `The map shows the ${layer.result.series.step} above; Play steps ${layer.result.series.step} by ${layer.result.series.step}`;
      }
      return "Features show inside the time window above";
    case "detail":
      return "The selected feature is purple";
    default:
      return undefined;
  }
}

/** One side of a change: its feature count and, when the layer has a measure, its total in the measure's unit. */
export type ChangeSide = { count: number; total?: number };
export type ChangeMeasures = { a: ChangeSide; b: ChangeSide; key?: string; label?: string; unit?: string; difference?: number };

/**
 * Both sides' numbers for the change view's legend (spec §12: "states both values and the difference"): the area in
 * km² when features carry `areaKm2`, else the layer's measure (its primary measure, else `v` in the layer's unit), else
 * the counts alone.
 */
export function changeMeasures(layer: LoadedLayer, a: FeatureCollection, b: FeatureCollection): ChangeMeasures {
  const all = [...a.features, ...b.features];
  const has = (key: string) => all.some((f) => typeof f.properties?.[key] === "number");
  const measure = primaryMeasure(layer);
  const pick = has("areaKm2")
    ? { key: "areaKm2", label: "Area", unit: "km²" }
    : measure && has(measure.key)
      ? { key: measure.key, label: measure.label, unit: measure.unit }
      : has("v")
        ? { key: "v", label: "Value", unit: layer.style.unit }
        : undefined;
  const side = (fc: FeatureCollection): ChangeSide => {
    if (!pick) return { count: fc.features.length };
    const total = fc.features.reduce((sum, f) => sum + (typeof f.properties?.[pick.key] === "number" ? (f.properties[pick.key] as number) : 0), 0);
    return { count: fc.features.length, total };
  };
  const sa = side(a);
  const sb = side(b);
  return {
    a: sa,
    b: sb,
    ...(pick && { key: pick.key, label: pick.label, ...(pick.unit && { unit: pick.unit }) }),
    ...(sa.total !== undefined && sb.total !== undefined && { difference: sb.total - sa.total }),
  };
}
