import { describe, expect, it } from "vitest";
import type { FeatureCollection } from "geojson";
import { listLayers } from "@/layers";
import { readSamples } from "@/scripts/card-samples.mjs";
import { isRawLabel, moreFilterFields, sameValues } from "@/lib/render/moreFields";

/**
 * Every layer's filter controls over its recorded live sample (scripts/card-samples.mts): no two controls on one layer
 * hold the same values (power plants offered Capacity, "Mw" and "Nameplate mw", owner 2026-10-18), and no control is
 * labelled with a raw key.
 */
const samples = readSamples();

describe("filter controls on every layer's recorded sample", () => {
  for (const layer of listLayers()) {
    const sample = samples[layer.id];
    if (sample?.kind !== "geojson") continue;
    const data: FeatureCollection = { type: "FeatureCollection", features: sample.features };
    const holds = (key: string) => data.features.some((f) => f.properties?.[key] !== undefined && f.properties?.[key] !== null);
    it(`${layer.id}: no measure or kind offered twice, no raw-key label`, () => {
      const declared = (layer.attributes ?? []).filter((a) => a.type !== "name" && a.type !== "place" && holds(a.key));
      // How many values a declared attribute can take (its levels; a flag two): two with different counts differ by
      // declaration, however a small sample happens to pair them (fuel and fuel group, a cleanup step and a flag).
      const kinds = new Map(declared.map((a) => [a.key, a.type === "flag" ? 2 : a.levels && a.levels.length > 0 ? new Set(a.levels.map((l) => l.label)).size : undefined]));
      const extra = moreFilterFields(layer, data);
      const controls = [...declared.map((a) => ({ key: a.key, label: a.label })), ...extra.map((f) => ({ key: f.key, label: f.label }))];
      const twice: string[] = [];
      for (let i = 0; i < controls.length; i++) {
        for (let j = i + 1; j < controls.length; j++) {
          const [ki, kj] = [kinds.get(controls[i].key), kinds.get(controls[j].key)];
          if (ki !== undefined && kj !== undefined && ki !== kj) continue;
          if (sameValues(data.features, controls[i].key, controls[j].key)) twice.push(`${controls[i].label} = ${controls[j].label}`);
        }
      }
      expect(twice).toEqual([]);
      expect(controls.filter((c) => isRawLabel(c.label, c.key)).map((c) => c.label)).toEqual([]);
    });
  }
});
