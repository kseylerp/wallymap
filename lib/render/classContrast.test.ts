import { describe, expect, it } from "vitest";
import { compositeOver, deltaE, hexToRgb, rgbToOklch, type Rgb } from "@/lib/render/ramp";
import { EVT_CLASSES, typeColors } from "@/lib/ee/vegetation";
import { CATEGORY_AREA_TINT, CHOROPLETH_ALPHA } from "@/lib/render/deck";
import { CATEGORY_COLORS } from "@/lib/render/categories";
import { groupColors } from "@/lib/render/attributes";
import { stopsColor } from "@/lib/render/encode";
import { SOLID_TILE_FILL } from "@/components/mapTiles";
import { HALF_ZONES, ZONE_COLORS } from "@/layers/hardiness-zones";
import { FAMILY_COLORS } from "@/lib/render/rockFamily";
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

  it("geologic rock families at the tile fill: each family's age steps, and the families at the same age", () => {
    for (const [family, colors] of Object.entries(FAMILY_COLORS)) {
      // Loose sediments keep one shade (young, almost all Quaternary).
      if (family === "unconsolidated") continue;
      const w = weakestPair(colors, SOLID_TILE_FILL[0][1]);
      expect(w.dE, `${family} ${w.pair} on ${w.ground}`).toBeGreaterThanOrEqual(MIN_NEIGHBOUR_DELTA_E);
    }
    for (let step = 0; step < 5; step++) {
      const w = weakestPair(
        Object.values(FAMILY_COLORS).map((c) => c[step]),
        SOLID_TILE_FILL[0][1],
      );
      expect(w.dE, `age step ${step}: ${w.pair} on ${w.ground}`).toBeGreaterThanOrEqual(MIN_NEIGHBOUR_DELTA_E);
    }
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

/**
 * The top five classes in view must tell apart at a glance, not only side by side: a different hue, or a clearly
 * different lightness or saturation, and far enough apart overall (owner, 2026-10-24: the Smokies' oak forest, 27%, and
 * cove forest, 26%, drew a sage and a paler sage that read as one color). Checked over Topo's and the satellite's ground
 * at the vegetation picture's 85% opacity, for the mixes of groups a top five has: all broadleaf, conifer-led, alpine.
 */
const VEGETATION_ALPHA = 0.85;

function atAGlance(a: string, b: string, ground: Rgb): { ok: boolean; why: string } {
  const ca = compositeOver(hexToRgb(a), VEGETATION_ALPHA, ground);
  const cb = compositeOver(hexToRgb(b), VEGETATION_ALPHA, ground);
  const [la, xa, ha] = rgbToOklch(ca);
  const [lb, xb, hb] = rgbToOklch(cb);
  const dh = Math.min(Math.abs(ha - hb), 360 - Math.abs(ha - hb));
  const dE = deltaE(ca, cb);
  const distinct = dE >= 15 || (dE >= 10 && ((xa >= 0.03 && xb >= 0.03 && dh >= 60) || Math.abs(la - lb) >= 0.13 || Math.abs(xa - xb) >= 0.08));
  return { ok: distinct, why: `${a}|${b} ΔE ${dE.toFixed(1)}, ΔL ${Math.abs(la - lb).toFixed(2)}, Δhue ${dh.toFixed(0)}°` };
}

describe("the top five vegetation types differ at a glance on Topo and Topo + Satellite", () => {
  const byGroup = (group: string) => [...EVT_CLASSES.values()].filter((c) => c.group === group);
  const mixes = [
    ["hardwood", "hardwood", "hardwood", "hardwood", "hardwood"],
    ["conifer", "hardwood", "hardwood", "hardwood", "hardwood"],
    ["conifer", "conifer", "hardwood", "shrub", "grass"],
    ["conifer", "conifer", "conifer", "shrub", "wet"],
    ["sparse", "grass", "conifer", "shrub", "sparse"],
    ["shrub", "shrub", "grass", "wet", "hardwood"],
  ];

  it.each(mixes.map((m) => [m.join(", "), m] as const))("%s", (_, groups) => {
    const taken: Record<string, number> = {};
    const classes = groups.map((g) => byGroup(g)[(taken[g] = (taken[g] ?? -1) + 1)]);
    const colors = typeColors(classes).slice(0, 5);
    expect(new Set(colors).size).toBe(5);
    const weak: string[] = [];
    for (const [name, ground] of Object.entries(GROUNDS)) {
      for (let i = 0; i < colors.length; i++) {
        for (let j = i + 1; j < colors.length; j++) {
          const r = atAGlance(colors[i], colors[j], ground);
          if (!r.ok) weak.push(`${r.why} on ${name}`);
        }
      }
    }
    expect(weak).toEqual([]);
  });
});
