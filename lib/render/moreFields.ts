import type { Feature, FeatureCollection } from "geojson";
import type { Attribute, CardSpec, FieldHelp } from "@/layers/types";
import { deriveFilterFields, labelFor, type FilterField } from "@/lib/render/filters";

/**
 * What "More filters" offers beyond a layer's declared attributes (owner, 2026-10-18: power plants listed one measure
 * three times, as Capacity, "Mw" and "Nameplate mw"): only undeclared fields that are not the same values as a declared
 * attribute (or as each other), equal or a unit conversion away, each with a label in words and its unit, never a raw
 * key. The pure half; the row (components/LayerStack.tsx) and the check over every layer's sample (tests) share it.
 */

type Describable = { attributes?: Attribute[]; card?: CardSpec; fieldHelp?: Record<string, FieldHelp>; style: { unit?: string } };

/** Unit words a key may end in ("nameplateMw", "lengthKm", "depthFt"), and how they read. */
const UNIT_TOKENS: Record<string, string> = {
  mw: "MW",
  kw: "kW",
  gw: "GW",
  mwh: "MWh",
  km2: "km²",
  sqkm: "km²",
  km: "km",
  m: "m",
  ft: "ft",
  mi: "mi",
  in: "in",
  cm: "cm",
  mm: "mm",
  ha: "ha",
  acres: "acres",
  af: "acre-feet",
  cfs: "cfs",
  mph: "mph",
  kph: "km/h",
  kn: "kn",
  c: "°C",
  f: "°F",
  pct: "%",
  percent: "%",
  m3: "m³",
  usd: "US$",
};

/** True for a label that is a raw key: snake case, camel case, or nothing but a unit ("Mw"). */
export function isRawLabel(label: string, key?: string): boolean {
  const t = label.trim();
  if (t === "" || (key !== undefined && t === key)) return true;
  if (/_/.test(t) || /[a-z][A-Z]/.test(t)) return true;
  return UNIT_TOKENS[t.toLowerCase()] !== undefined;
}

/** A field's words and unit: the card's label for it, else its key in words with a trailing unit word split off. */
export function fieldWords(key: string, layer?: Describable): { label: string; unit?: string } {
  const fact = layer?.card?.facts?.find((f) => f.key === key);
  const help = layer?.fieldHelp?.[key];
  if (fact?.label && !isRawLabel(fact.label, key)) return { label: fact.label, ...((fact.unit ?? help?.unit) && { unit: fact.unit ?? help?.unit }) };
  const words = labelFor(key).split(" ");
  const last = words[words.length - 1]?.toLowerCase() ?? "";
  if (words.length > 1 && UNIT_TOKENS[last]) {
    const rest = words.slice(0, -1).join(" ");
    return { label: rest.charAt(0).toUpperCase() + rest.slice(1), unit: help?.unit ?? UNIT_TOKENS[last] };
  }
  return { label: labelFor(key), ...(help?.unit && { unit: help.unit }) };
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : typeof v === "boolean" ? String(v) : undefined);

/**
 * True when two properties hold the same values over the features: numbers equal or one a fixed multiple of the other
 * (a unit conversion: acres and hectares, MW and kW), or labels that split the features the same way.
 */
export function sameValues(features: Feature[], a: string, b: string): boolean {
  let pairs = 0;
  let ratio: number | undefined;
  let numeric = true;
  const ab = new Map<string, string>();
  const ba = new Map<string, string>();
  let labels = true;
  for (const f of features) {
    const pa = f.properties?.[a];
    const pb = f.properties?.[b];
    if (pa === undefined || pa === null || pb === undefined || pb === null) continue;
    pairs++;
    const na = num(pa);
    const nb = num(pb);
    if (numeric) {
      if (na === undefined || nb === undefined) numeric = false;
      else if (nb === 0 || na === 0) {
        if (na !== nb) numeric = false;
      } else {
        const r = na / nb;
        if (ratio === undefined) ratio = r;
        else if (Math.abs(r - ratio) > Math.abs(ratio) * 1e-3) numeric = false;
      }
    }
    if (labels) {
      // Two numbers are the same only by ratio; a split is a property of labels.
      const ta = text(pa);
      const tb = text(pb);
      if (ta === undefined || tb === undefined) labels = false;
      else if ((ab.has(ta) && ab.get(ta) !== tb) || (ba.has(tb) && ba.get(tb) !== ta)) labels = false;
      else {
        ab.set(ta, tb);
        ba.set(tb, ta);
      }
    }
    if (!numeric && !labels) return false;
  }
  // Too few features to tell a coincidence from a copy: a ratio needs three pairs, a matching split five features in at
  // least two groups (and not every feature its own group, which any two unique fields share).
  if (numeric && pairs >= 3 && ratio !== undefined) return true;
  return labels && pairs >= 5 && ab.size >= 2 && ab.size < pairs;
}

/** The undeclared fields "More filters" offers for a layer: no duplicates of a declared attribute or of each other, worded. */
export function moreFilterFields(layer: Describable, data: FeatureCollection): FilterField[] {
  const declared = (layer.attributes ?? []).map((a) => a.key);
  const kept: FilterField[] = [];
  for (const field of deriveFilterFields(data, { unitForV: layer.style.unit })) {
    if (declared.includes(field.key)) continue;
    const others = [...declared, ...kept.map((k) => k.key)];
    if (others.some((k) => sameValues(data.features, field.key, k))) continue;
    // The value channel `v` with no declared attribute keeps its own label (filters.ts names it from the layer's unit).
    const words = field.key === "v" ? { label: field.label, unit: field.kind === "range" ? field.unit : undefined } : fieldWords(field.key, layer);
    if (isRawLabel(words.label, field.key)) continue;
    kept.push(field.kind === "range" ? { ...field, label: words.label, ...(words.unit && { unit: words.unit }) } : { ...field, label: words.label });
  }
  return kept;
}
