import type { FeatureCollection } from "geojson";
import type { LegendSpec } from "@/layers/types";
import { declaredGroups, encodedAttribute, primaryMeasure, valueKeys } from "@/lib/render/attributes";
import { LINE_DASHES, UNRATED_LABEL, UNRATED_LINE } from "@/lib/render/nativeLines";
import { categoryKey, type CategoryKey } from "@/lib/render/categories";
import { rasterKeyFilter } from "@/lib/render/rasterCalm";
import { layerKey } from "@/lib/render/contract";
import { channelExtent, ENCODE_RAMP, isDiverging, resolveEncoding } from "@/lib/render/encode";
import { compareRampColor, rgbToHex } from "@/lib/render/ramp";
import { areaRecipe, HEX_TILE, lineRampFor, SAGE, scoreRampFor, type RampName } from "@/lib/render/palette";
import { hexbinThreshold } from "@/lib/render/deck";
import { shortTitle } from "@/layers/contract";
import type { LoadedLayer, RenderOp } from "@/lib/render/state";
import { rampSamples } from "@/lib/render/wally/legend";

/**
 * The legend a layer row shows (docs/layer-contract.md `legend`), built from `legendOf` and from what the map draws, so
 * the key never promises what the map does not show: a category's swatches with labels and counts in the colors the
 * map uses (lib/render/categories.ts), a ramp's gradient with its stops and unit, a size key's small-to-large marks,
 * one swatch with a note for raster tiles, or the image the tile service publishes.
 */

export type LegendEntry = { label: string; color?: string; count?: number; help?: string; outline?: boolean; dash?: [number, number] };

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
  /** Raster tiles: the CSS filter the map's raster paint amounts to, so swatches and ramps show the drawn colors. */
  filter?: string;
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
/**
 * One entry per label: a key that lists several raw values under one name (public lands' six "Other federal" agencies)
 * shows the name once, with the first value's swatch and the counts added.
 */
function mergeByLabel(entries: LegendEntry[]): LegendEntry[] {
  const out = new Map<string, LegendEntry>();
  for (const e of entries) {
    const seen = out.get(e.label);
    if (!seen) out.set(e.label, e);
    else if (e.count !== undefined) out.set(e.label, { ...seen, count: (seen.count ?? 0) + e.count });
  }
  return [...out.values()];
}

export function rowLegend(layer: LoadedLayer, op: RenderOp | undefined, data: FeatureCollection | null): LegendBlock[] {
  const shape = shapeOf(layer);
  // Points drawn as hex cells key as the cells: the gray ramp of features per cell.
  const all0 = layer.result.kind === "geojson" ? layer.result.data : null;
  const hexed =
    layer.style.geometry === "point" &&
    op !== undefined &&
    (op.mode === "hexbin" || op.mode === "columns" || (op.mode === "points" && (all0?.features.length ?? 0) > hexbinThreshold && !op.rankBy && op.view !== "ranked"));
  if (hexed) {
    return [{ kind: "ramp", title: `${shortTitle(layer)} per cell`, entries: [{ label: "Fewer" }, { label: "More" }], colors: rampSamples(HEX_TILE.ramp), shape: "polygon" }];
  }
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
          entries: mergeByLabel(
            (spec.items ?? []).map((i) => ({
              label: i.label,
              ...(i.color && { color: i.color }),
              ...(i.symbol === "line" && shape === "polygon" && { outline: true }),
              ...(i.help && { help: i.help }),
              ...(data && spec.field && i.value !== undefined && { count: n.get(String(i.value)) ?? 0 }),
            })),
          ),
          ...(spec.note && { note: spec.note }),
          shape,
        });
      }
      break;
    case "ramp": {
      const declared = (spec.stops ?? []).every((s) => s.color);
      // A measure that runs both sides of zero draws on the diverging ramp (purple below, pink above): so does its key.
      const channel = spec.field && all ? resolveEncoding(layer, op, all)?.color : undefined;
      if (!declared && channel && channel.key === spec.field && isDiverging(channel) && channel.extent) {
        const unit = channel.unit ? ` ${channel.unit}` : "";
        const m = Math.max(Math.abs(channel.extent[0]), Math.abs(channel.extent[1]));
        blocks.push({
          kind: "ramp",
          title: spec.title ?? channel.label,
          field: spec.field,
          entries: [{ label: `−${amount(m)}${unit}` }, { label: "0" }, { label: `+${amount(m)}${unit}` }],
          colors: [-1, -0.5, 0, 0.5, 1].map((t) => rgbToHex(compareRampColor(t))),
          shape,
        });
        break;
      }
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
      if (shape === "point" || shape === "polygon") {
        // Areas show a size measure as hatch density (lib/render/deck.ts areaStep): sparse is small, dense is large.
        const sizeAttr = layer.attributes?.find((a) => a.key === spec.field);
        const extent = all && spec.field ? channelExtent(all, spec.field) : null;
        const unit = spec.unit && spec.unit !== "score" ? ` ${spec.unit}` : "";
        const entries = extent ? [{ label: `${amount(extent[0])}${unit}` }, { label: `${amount(extent[1])}${unit}` }] : (spec.stops ?? []).map((s) => ({ label: s.label }));
        blocks.push({ kind: "size", title: spec.title ?? sizeAttr?.label, ...(spec.field && { field: spec.field }), ...(spec.unit && { unit: spec.unit }), entries, shape });
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
  // A flow field with no color variable (wind) colors its particles by speed (lib/render/particles.ts).
  if (layer.result.kind === "geojson" && layer.result.flow && !layer.result.flow.color) {
    blocks.push({ kind: "ramp", title: "Speed", entries: [{ label: "Slow" }, { label: "Fast" }], colors: rampSamples(ENCODE_RAMP), shape });
  }
  // Lines: kinds told apart by dash (pipelines), and lines the difficulty scale does not rate (a thin grey dash).
  if (shape === "line" && data) {
    const dashAttr = layer.attributes?.find((a) => a.encode === "dash" && (a.levels?.length ?? 0) > 1);
    if (dashAttr) {
      const n2 = counts(data, dashAttr.key);
      blocks.push({
        kind: "categories",
        title: dashAttr.label,
        field: `${dashAttr.key}#dash`,
        entries: declaredGroups(dashAttr).map((g, k) => ({
          label: g.label,
          color: SAGE,
          dash: LINE_DASHES[k % LINE_DASHES.length],
          count: g.values.reduce((t, v) => t + (n2.get(v) ?? 0), 0),
        })),
        shape,
      });
    }
    const facet = encodedAttribute(layer);
    if (facet && !op?.color) {
      const rated = new Set(declaredGroups(facet).filter((g) => !UNRATED_LABEL.test(g.label)).flatMap((g) => g.values));
      const unrated = data.features.filter((f) => !valueKeys(f.properties?.[facet.key]).some((v) => rated.has(v))).length;
      if (unrated > 0) {
        blocks.push({ kind: "categories", field: `${facet.key}#unrated`, entries: [{ label: "Not rated", color: UNRATED_LINE.color, dash: UNRATED_LINE.dash, count: unrated }], shape });
      }
    }
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
  // A raster's swatches and gradients pass through the same calming the tiles do (lib/render/rasterCalm.ts).
  if (shape === "raster") {
    const filter = rasterKeyFilter(layer.style.raster, true);
    if (filter) for (const b of blocks) b.filter = filter;
  }
  // Every row has a key: at least the layer's own swatch and name, in the color it draws.
  if (blocks.length === 0 || blocks.every((b) => b.kind === "size")) {
    blocks.unshift({ kind: "categories", entries: [{ label: shortTitle(layer), color: op?.color ?? areaRecipe(layer.id).color }], shape });
  }
  return blocks;
}
