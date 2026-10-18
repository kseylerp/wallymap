import type { Feature, FeatureCollection } from "geojson";
import type { Attribute, LegendSpec, StyleHints } from "@/layers/types";
import { attributesOf, declaredGroups, groupColors, isChipAttribute, valueKeys } from "@/lib/render/attributes";
import { DARK_GREY, OFF_WHITE, PINK, PURPLE, SAGE, layerRole } from "@/lib/render/palette";

/**
 * Encode by default (owner, 2026-10-17: "needs to be discernible"): a layer's primary category colors its symbols and
 * areas with distinct palette colors, an ordinal by the sage → pink → purple ramp, so the map, the legend and the chips
 * say the same thing. The pure half: which attribute colors a layer, each group's color, and a feature's color.
 */

/**
 * Category colors, most distinct first, all hatchable (lib/render/palette.ts HATCH_COLORS): purple and pink read on
 * Topo, Topo + Satellite and Satellite; dark grey with its white halo on all three; sage last (it sinks into green
 * Topo, so it only ever colors a fourth kind). More kinds than this share off-white as "Other".
 */
export const CATEGORY_COLORS = [PURPLE, PINK, DARK_GREY, SAGE] as const;
/** The color of every kind past the fourth, and of features with no value. */
export const OTHER_COLOR = OFF_WHITE;

/**
 * One group of the key. `outline`: its areas draw as an outline only, no tint or hatch (a legend item drawn as a line
 * on an area layer: condor range "Early 1800s" against "Today" filled).
 */
export type CategoryGroup = { label: string; values: string[]; color: string; outline?: boolean };

/** What colors a layer: the attribute, its groups in order with their colors, and whether past groups fold to Other. */
export type CategoryKey = { attr: Attribute; groups: CategoryGroup[]; ordinal: boolean; other: boolean };

type Keyable = { id: string; attributes?: Attribute[]; style: Pick<StyleHints, "encode" | "unit">; legend?: LegendSpec };

const keyMemo = new WeakMap<object, Map<string, CategoryKey | null>>();

/** The most common values of an open category in the data, most common first. */
function dataGroups(key: string, data: FeatureCollection | null | undefined): { label: string; values: string[] }[] {
  if (!data) return [];
  const counts = new Map<string, number>();
  for (const f of data.features) for (const v of new Set(valueKeys(f.properties?.[key]))) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([v]) => ({ label: v.replace(/_/g, " ").replace(/^[a-z]/, (c) => c.toUpperCase()), values: [v] }));
}

/**
 * The category key a layer's map draws by, or undefined: none for score layers (their ramp is the key) or layers whose
 * `style.encode.color` already colors them (lib/render/encode.ts). Else the layer's chip attribute (the primary
 * category or ordinal, else the first): declared levels in order, or for an open category the data's most common
 * values. An ordinal takes the ramp; a category the CATEGORY_COLORS, a declared legend's own colors winning, kinds past
 * the fourth folding to Other (off-white). Undefined with fewer than two groups (one color says nothing).
 */
export function categoryKey(layer: Keyable, data?: FeatureCollection | null): CategoryKey | undefined {
  if (layer.style.unit === "score" || layerRole(layer.id) === "score" || layer.style.encode?.color) return undefined;
  const attrs = attributesOf(layer);
  const attr = attrs.find((a) => a.primary && isChipAttribute(a)) ?? attrs.find(isChipAttribute);
  if (!attr) return undefined;
  const declared = declaredGroups(attr);
  const memoKey = `${attr.key}|${declared.length > 0 ? "d" : "o"}`;
  const memoOwner = (declared.length > 0 ? layer : data) ?? layer;
  let byKey = keyMemo.get(memoOwner);
  if (!byKey) {
    byKey = new Map();
    keyMemo.set(memoOwner, byKey);
  }
  if (byKey.has(memoKey)) return byKey.get(memoKey) ?? undefined;
  const base = declared.length > 0 ? declared : dataGroups(attr.key, data);
  let out: CategoryKey | null = null;
  if (base.length >= 2) {
    const ordinal = attr.type === "ordinal";
    const legendColors = new Map<string, string>();
    const outlines = new Set<string>();
    if (layer.legend?.field === attr.key) {
      for (const item of layer.legend.items ?? []) {
        if (item.value === undefined) continue;
        if (item.color) legendColors.set(String(item.value), item.color);
        if (item.symbol === "line") outlines.add(String(item.value));
      }
    }
    const ramp = ordinal ? groupColors(base.length) : [];
    const groups = base.map((g, i) => ({
      label: g.label,
      values: g.values,
      color: g.values.map((v) => legendColors.get(v)).find(Boolean) ?? (ordinal ? ramp[i] : (CATEGORY_COLORS[i] ?? OTHER_COLOR)),
      ...(g.values.some((v) => outlines.has(v)) && { outline: true }),
    }));
    out = { attr, groups, ordinal, other: !ordinal && base.length > CATEGORY_COLORS.length };
  }
  byKey.set(memoKey, out);
  return out ?? undefined;
}

/** A feature's group in the key (its first value that belongs to one), or undefined. */
export function groupOf(key: CategoryKey, feature: Pick<Feature, "properties">): CategoryGroup | undefined {
  for (const v of valueKeys(feature.properties?.[key.attr.key])) {
    const g = key.groups.find((x) => x.values.includes(v));
    if (g) return g;
  }
  return undefined;
}

/** A feature's color in the key: its group's, else Other's. */
export function categoryColor(key: CategoryKey, feature: Pick<Feature, "properties">): string {
  return groupOf(key, feature)?.color ?? OTHER_COLOR;
}
