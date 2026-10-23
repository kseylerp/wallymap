import type { Attribute, CardSpec, FieldHelp, LayerResult, LegendSpec, StyleHints } from "@/layers/types";
import type { LoadedLayer, MapAction, RenderMode, RenderOp } from "./state";

/**
 * A `combine` result (lib/spatial/tool.ts) on the map: a layer of its own, under the id `combine:<...>`, drawn with
 * the source layer's look, card and filters plus the join's numbers (distance, overlap acres), and the source layer
 * hidden under it so the kept features are not drawn twice. Malformed output maps to nothing.
 */

export const COMBINED_PREFIX = "combine:";

/** True for the id of a layer the combine tool made (not in the layer registry). */
export function isCombinedId(id: string): boolean {
  return id.startsWith(COMBINED_PREFIX);
}

/** The combined layer drawn last, for a render call that names the tool ("combine") instead of the layer's id. */
export function latestCombinedId(ops: RenderOp[]): string | undefined {
  return ops.findLast((op) => isCombinedId(op.layerId))?.layerId;
}

/** What the browser needs of the source layer's catalog entry. */
type SourceEntry = {
  card?: CardSpec;
  attributes?: Attribute[];
  fieldHelp?: Record<string, FieldHelp>;
  description?: string;
  display?: LoadedLayer["display"];
  labels?: LoadedLayer["labels"];
};

/** The opacity the other side of a join is dimmed to under a combined layer of areas. */
const OTHER_OPACITY = 0.4;

const MODE: Record<StyleHints["geometry"], RenderMode> = { point: "points", line: "lines", polygon: "polygons" };

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function combinedActions(output: unknown, source: (id: string) => SourceEntry | undefined, existingOps: RenderOp[] = []): MapAction[] {
  if (!isObject(output) || output.kind !== "geojson" || !isObject(output.data) || !isObject(output.combined)) return [];
  const c = output.combined;
  if (typeof c.id !== "string" || !isCombinedId(c.id) || typeof c.sourceLayerId !== "string" || !isObject(c.style)) return [];
  const style = c.style as StyleHints;
  if (!(style.geometry in MODE)) return [];
  const entry = source(c.sourceLayerId) ?? {};
  const facts = Array.isArray(c.facts) ? (c.facts as NonNullable<CardSpec["facts"]>) : [];
  const extra = Array.isArray(c.attributes) ? (c.attributes as Attribute[]) : [];
  const keys = new Set([...facts.map((f) => f.key), ...extra.map((a) => a.key)]);
  const card: CardSpec = { ...entry.card, facts: [...facts, ...(entry.card?.facts ?? []).filter((f) => !keys.has(f.key))] };
  const attributes = [...extra, ...(entry.attributes ?? []).filter((a) => !keys.has(a.key))];
  const title = typeof output.title === "string" && output.title ? output.title : c.id;
  const { combined: _combined, ...result } = output;
  void _combined;
  const layer: LoadedLayer = {
    id: c.id,
    title,
    style,
    result: result as unknown as LayerResult,
    receivedAt: new Date().toISOString(),
    card,
    ...(attributes.length > 0 && { attributes }),
    ...(entry.fieldHelp && { fieldHelp: entry.fieldHelp }),
    description: typeof c.statement === "string" ? c.statement : title,
    ...(entry.display && { display: entry.display }),
    ...(entry.labels && { labels: entry.labels }),
    ...(isObject(output.legend) && { legend: output.legend as unknown as LegendSpec }),
    time: { shape: "none" },
  };
  const actions: MapAction[] = [
    { type: "layer_loaded", layer },
    { type: "render", op: { layerId: c.id, mode: MODE[style.geometry], visible: true }, defaultMode: true },
  ];
  // The source layer stays loaded (its row can show it again) but is hidden under the kept features.
  const shown = existingOps.find((op) => op.layerId === c.sourceLayerId && op.visible);
  if (shown) actions.push({ type: "render", op: { ...shown, visible: false } });
  // The layer they were tested against stays as context, dimmed, so the kept areas stand out on it (wild horse herds
  // in drought: the herds' hatching on the drought fill at full strength could not be told apart).
  const other = typeof c.otherLayerId === "string" ? existingOps.find((op) => op.layerId === c.otherLayerId && op.visible) : undefined;
  if (other && style.geometry === "polygon" && (other.opacity ?? 1) > OTHER_OPACITY) actions.push({ type: "render", op: { ...other, opacity: OTHER_OPACITY } });
  return actions;
}
