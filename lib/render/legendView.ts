import type { FeatureCollection } from "geojson";
import type { LegendSpec } from "@/layers/types";
import { primaryMeasure, valueKeys } from "@/lib/render/attributes";
import { categoryKey, type CategoryKey } from "@/lib/render/categories";
import { layerKey } from "@/lib/render/contract";
import { channelExtent, ENCODE_RAMP } from "@/lib/render/encode";
import { lineRampFor, scoreRampFor, type RampName } from "@/lib/render/palette";
import type { LoadedLayer, RenderOp } from "@/lib/render/state";
import { rampSamples } from "@/lib/render/wally/legend";

/**
 * The legend a layer row shows (docs/layer-contract.md `legend`), built from `legendOf` and from what the map draws, so
 * the key never promises what the map does not show: a category's swatches with labels and counts in the colors the
 * map uses (lib/render/categories.ts), a ramp's gradient with its stops and unit, a size key's small-to-large marks,
 * one swatch with a note for raster tiles, or the image the tile service publishes.
 */

export type LegendEntry = { label: string; color?: string; count?: number; help?: string; outline?: boolean };

export type LegendBlock = {
  kind: LegendSpec["kind"];
  title?: string;
  /** The feature property the block reads, so a row whose chips already key it can leave it out. */
  field?: string;
  unit?: string;
  entries: LegendEntry[];
  /** Ramps: the gradient's colors, low to high. */
  colors?: string[];
  imageUrl?: string;
  note?: string;
  /** How a category's swatch is drawn: a disc, a line or a tinted square, as the map draws the layer. */
  shape: "point" | "line" | "polygon" | "raster";
};

function shapeOf(layer: Pick<LoadedLayer, "style" | "result">): LegendBlock["shape"] {
  if (layer.result.kind === "tiles" && layer.result.data.format === "raster") return "raster";
  return layer.style.geometry;
}

function counts(data: FeatureCollection | null, key: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of data?.features ?? []) for (const v of new Set(valueKeys(f.properties?.[key]))) out.set(v, (out.get(v) ?? 0) + 1);
  return out;
}

function amount(n: number): string {
  const abs = Math.abs(n);
  return n.toLocaleString("en-US", { maximumFractionDigits: abs >= 100 ? 0 : abs >= 10 ? 1 : 2 });
}

/** The ramp a legend's gradient draws: a score layer's own ramp, lines on the line ramp, else the encode ramp. */
function rampOf(layer: Pick<LoadedLayer, "id" | "style">): RampName {
  if (layer.style.unit === "score") return layer.style.geometry === "line" ? lineRampFor(layer.id) : scoreRampFor(layer.id);
  return ENCODE_RAMP;
}

function categoryBlock(key: CategoryKey, data: FeatureCollection | null, shape: LegendBlock["shape"]): LegendBlock {
  const n = counts(data, key.attr.key);
  const shown = key.other ? key.groups.slice(0, 4) : key.groups;
  const entries: LegendEntry[] = shown.map((g) => ({
    label: g.label,
    color: g.color,
    count: g.values.reduce((s, v) => s + (n.get(v) ?? 0), 0),
    ...(g.outline && { outline: true }),
  }));
  if (key.other) {
    const rest = key.groups.slice(4);
    entries.push({ label: `Other (${rest.map((g) => g.label.toLowerCase()).join(", ")})`, color: rest[0]?.color, count: rest.reduce((s, g) => s + g.values.reduce((t, v) => t + (n.get(v) ?? 0), 0), 0) });
  }
  return { kind: "categories", title: key.attr.label, field: key.attr.key, ...(key.attr.unit && { unit: key.attr.unit }), entries: entries.filter((e) => e.count === undefined || e.count > 0 || data === null), shape };
}

/**
 * The row's legend blocks, top to bottom. A declared legend is shown as declared (counts added from the data); else the
 * category the map colors by, then what legendOf derives when it says something more (a ramp, a size key, a raster
 * note), then the size key of the measure that sizes the symbols. `data` is the drawn data (counts follow filters).
 */
export function rowLegend(layer: LoadedLayer, op: RenderOp | undefined, data: FeatureCollection | null): LegendBlock[] {
  const shape = shapeOf(layer);
  const all = layer.allData ?? (layer.result.kind === "geojson" ? layer.result.data : null);
  const spec = layerKey(layer);
  const blocks: LegendBlock[] = [];
  const declared = layer.result.legend ?? layer.legend;
  const key = op?.color ? undefined : categoryKey(layer.result.legend ? { ...layer, legend: declared } : layer, all);
  if (!declared && key) blocks.push(categoryBlock(key, data, shape));
  const n = spec.field ? counts(data, spec.field) : new Map<string, number>();
  switch (spec.kind) {
    case "categories":
      if (!key || key.attr.key !== spec.field || declared) {
        blocks.unshift({
          kind: "categories",
          ...(spec.title && { title: spec.title }),
          ...(spec.field && { field: spec.field }),
          ...(spec.unit && { unit: spec.unit }),
          entries: (spec.items ?? []).map((i) => ({
            label: i.label,
            ...(i.color && { color: i.color }),
            ...(i.symbol === "line" && shape === "polygon" && { outline: true }),
            ...(i.help && { help: i.help }),
            ...(data && spec.field && i.value !== undefined && { count: n.get(String(i.value)) ?? 0 }),
          })),
          ...(spec.note && { note: spec.note }),
          shape,
        });
      }
      break;
    case "ramp": {
      const declared = (spec.stops ?? []).every((s) => s.color);
      const colors = declared ? spec.stops!.map((s) => s.color!) : rampSamples(rampOf(layer));
      blocks.push({
        kind: "ramp",
        ...(spec.title && { title: spec.title }),
        ...(spec.field && { field: spec.field }),
        ...(spec.unit && spec.unit !== "score" && { unit: spec.unit }),
        entries: (spec.stops ?? []).map((s) => ({ label: s.label })),
        colors,
        ...(spec.note && { note: spec.note }),
        shape,
      });
      break;
    }
    case "size":
      if (shape === "point") {
        blocks.push({ kind: "size", ...(spec.title && { title: spec.title }), ...(spec.field && { field: spec.field }), ...(spec.unit && { unit: spec.unit }), entries: (spec.stops ?? []).map((s) => ({ label: s.label })), shape });
      }
      break;
    case "image":
      blocks.push({ kind: "image", ...(spec.title && { title: spec.title }), entries: [], ...(spec.imageUrl && { imageUrl: spec.imageUrl }), ...(spec.note && { note: spec.note }), shape });
      break;
    case "symbol":
      if (blocks.length === 0) {
        blocks.push({ kind: "symbol", entries: (spec.items ?? []).map((i) => ({ label: i.label })), ...(spec.note && { note: spec.note }), ...(spec.unit && { unit: spec.unit }), shape });
      }
      break;
  }
  // Symbols sized by the primary measure (encode by default) say so, with the range the data spans.
  const measure = primaryMeasure(layer);
  const sized = shape === "point" && op?.mode === "points" && op.rankBy !== "" && !layer.style.encode?.size && measure;
  if (sized && !blocks.some((b) => b.kind === "size") && all) {
    const extent = channelExtent(all, measure.key);
    if (extent) {
      const unit = measure.unit && measure.unit !== "score" ? ` ${measure.unit}` : "";
      blocks.push({ kind: "size", title: measure.label, field: measure.key, entries: [{ label: `${amount(extent[0])}${unit}` }, { label: `${amount(extent[1])}${unit}` }], shape });
    }
  }
  return blocks;
}
