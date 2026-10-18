import { describe, expect, it } from "vitest";
import { compositeOver, deltaE, hexToRgb, type Rgb } from "@/lib/render/ramp";
import { CATEGORY_AREA_TINT, CHOROPLETH_ALPHA } from "@/lib/render/deck";
import { CATEGORY_COLORS } from "@/lib/render/categories";
import { groupColors } from "@/lib/render/attributes";
import { stopsColor } from "@/lib/render/encode";
import { SOLID_TILE_FILL } from "@/components/mapTiles";
import { HALF_ZONES, ZONE_COLORS } from "@/layers/hardiness-zones";
import { ERAS } from "@/layers/geology";
import { LEGEND as TEMPERATURE_LEGEND } from "@/layers/temperature-anomaly";

/**
 * Neighbouring classes of a map key must look different once drawn over the basemap (owner, 2026-10-18: the hardiness
 * zones around Denver were one pale lavender, moderate and severe drought the same color). Each pair of classes that
 * sit next to each other in the key is drawn at the alpha the map uses over ground colors sampled from the basemaps
 * (Topo's open land and forest, satellite forest and desert), and must differ by at least MIN_NEIGHBOUR_DELTA_E.
 */
const GROUNDS: Record<string, Rgb> = {
  "Topo land": hexToRgb("#EAEEDF"),
  "Topo forest": hexToRgb("#CFE0BD"),
  "Satellite forest": hexToRgb("#3F4F33"),
  "Satellite desert": hexToRgb("#B49A74"),
};

/** OKLab ×100: about 2 is just noticeable side by side; 5 reads at a glance across a border. */
const MIN_NEIGHBOUR_DELTA_E = 5;

function weakestPair(colors: string[], alpha: number): { pair: string; ground: string; dE: number } {
  let worst = { pair: "", ground: "", dE: Infinity };
  for (const [ground, under] of Object.entries(GROUNDS)) {
    for (let i = 1; i < colors.length; i++) {
      const dE = deltaE(compositeOver(hexToRgb(colors[i - 1]), alpha, under), compositeOver(hexToRgb(colors[i]), alpha, under));
      if (dE < worst.dE) worst = { pair: `${i - 1}|${i}`, ground, dE };
    }
  }
  return worst;
}

describe("neighbouring classes differ visibly over every basemap", () => {
  it("hardiness half-zones (a lighter than b) at the tile fill", () => {
    expect(ZONE_COLORS).toHaveLength(HALF_ZONES.length);
    const w = weakestPair(ZONE_COLORS, SOLID_TILE_FILL[0][1]);
    expect(w.dE, `${w.pair} on ${w.ground}`).toBeGreaterThanOrEqual(MIN_NEIGHBOUR_DELTA_E);
  });

  it("geologic eras at the tile fill", () => {
    const w = weakestPair(
      ERAS.map((e) => e.color),
      SOLID_TILE_FILL[0][1],
    );
    expect(w.dE, `${w.pair} on ${w.ground}`).toBeGreaterThanOrEqual(MIN_NEIGHBOUR_DELTA_E);
  });

  it("ordinal classes (drought, alert severity) at the choropleth alpha, for 3 to 6 classes", () => {
    for (let n = 3; n <= 6; n++) {
      const w = weakestPair(groupColors(n), CHOROPLETH_ALPHA);
      expect(w.dE, `${n} classes: ${w.pair} on ${w.ground}`).toBeGreaterThanOrEqual(MIN_NEIGHBOUR_DELTA_E);
    }
  });

  it("category kinds at the category tint", () => {
    const w = weakestPair([...CATEGORY_COLORS], CATEGORY_AREA_TINT);
    expect(w.dE, `${w.pair} on ${w.ground}`).toBeGreaterThanOrEqual(MIN_NEIGHBOUR_DELTA_E);
  });

  it("the temperature anomaly scale, 3 °F apart, at the choropleth alpha", () => {
    const stops = (TEMPERATURE_LEGEND.stops ?? []).map((s) => ({ value: s.value as number, color: s.color as string }));
    const colors = [-12, -9, -6, -3, 0, 3, 6, 9, 12].map((v) => {
      const c = stopsColor(v, stops)!;
      return `#${c.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
    });
    const w = weakestPair(colors, CHOROPLETH_ALPHA);
    expect(w.dE, `${w.pair} on ${w.ground}`).toBeGreaterThanOrEqual(MIN_NEIGHBOUR_DELTA_E);
  });
});
