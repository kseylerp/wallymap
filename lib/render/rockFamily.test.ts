import { describe, expect, it } from "vitest";
import {
  AGE_STEPS,
  ageStepOf,
  FAMILY_COLORS,
  FAMILY_LABELS,
  ROCK_FAMILY_FIELD,
  ROCK_FAMILY_LEGEND,
  rockFamilyColor,
  rockFamilyExpression,
  rockFamilyFillExpression,
  rockFamilyOf,
  tileFieldValue,
  type RockFamily,
  type RockProps,
} from "./rockFamily";
import { hexToRgb, rgbToOklch } from "./ramp";
import { stippleImage, HATCH_FRAME } from "./hatch";
import { DARK_GREY } from "./palette";

/**
 * A small evaluator for the subset of Mapbox expressions the rock family paint uses, so the map's expression is checked
 * against the same units as `rockFamilyOf`.
 */
function evaluate(expr: unknown, props: Record<string, unknown>, vars: Record<string, unknown> = {}): unknown {
  if (!Array.isArray(expr)) return expr;
  const [op, ...args] = expr as [string, ...unknown[]];
  const ev = (e: unknown) => evaluate(e, props, vars);
  switch (op) {
    case "get":
      return props[args[0] as string] ?? null;
    case "coalesce":
      for (const a of args) {
        const v = ev(a);
        if (v !== null && v !== undefined) return v;
      }
      return null;
    case "to-string":
      return ev(args[0]) === null ? "" : String(ev(args[0]));
    case "to-number":
      return Number(ev(args[0]));
    case "downcase":
      return String(ev(args[0])).toLowerCase();
    case "concat":
      return args.map((a) => String(ev(a))).join("");
    case "in": {
      const hay = ev(args[1]);
      return Array.isArray(hay) ? hay.includes(ev(args[0])) : String(hay).includes(String(ev(args[0])));
    }
    case "literal":
      return args[0];
    case "any":
      return args.some((a) => ev(a) === true);
    case "<=":
      return (ev(args[0]) as number) <= (ev(args[1]) as number);
    case "case":
      for (let i = 0; i + 1 < args.length; i += 2) if (ev(args[i]) === true) return ev(args[i + 1]);
      return ev(args[args.length - 1]);
    case "match": {
      const v = ev(args[0]);
      for (let i = 1; i + 1 < args.length; i += 2) if (args[i] === v) return ev(args[i + 1]);
      return ev(args[args.length - 1]);
    }
    case "step": {
      const v = ev(args[0]) as number;
      let out = ev(args[1]);
      for (let i = 2; i + 1 < args.length; i += 2) if (v >= (args[i] as number)) out = ev(args[i + 1]);
      return out;
    }
    case "let":
      return evaluate(args[2], props, { ...vars, [args[0] as string]: ev(args[1]) });
    case "var":
      return vars[args[0] as string];
    default:
      throw new Error(`unsupported expression ${op}`);
  }
}

/** Units shaped as Macrostrat serves them (the carto tiles over Zion and Lake Tahoe, 2026-10-23) and the family each is. */
const UNITS: [RockProps, RockFamily][] = [
  [{ name: "Navajo Sandstone", lith: "sandstone", descrip: "Cross-bedded quartz sandstone", best_age_top: 170.3, best_age_bottom: 180.55 }, "sedimentary"],
  [{ name: "Kayenta Formation, main body", lith: "", descrip: "Red to red-brown sandstone, siltstone, and claystone", best_age_top: 180.55 }, "sedimentary"],
  [{ name: "Alluvial gravel", lith: "alluvium,gravel", descrip: "Poorly to well-sorted gravel, sand", best_age_top: 0, best_age_bottom: 0.126 }, "unconsolidated"],
  [{ name: "Eolian and residual deposits", lith: "sand and bedrock", descrip: "", best_age_top: 0 }, "unconsolidated"],
  [{ name: "Talus deposits", lith: "talus", best_age_top: 0 }, "unconsolidated"],
  [{ name: "Till", lith: "", descrip: "Bouldery deposits", best_age_top: 0.01 }, "unconsolidated"],
  [{ name: "Mesozoic granitic rocks", lith: "Major:{granodiorite}, Minor:{granite}", best_age_top: 66 }, "plutonic"],
  [{ name: "Granite gneiss", lith: "", best_age_top: 2500 }, "metamorphic"],
  [{ name: "Basalt of Cinder Cone", lith: "basalt", best_age_top: 0.001, best_age_bottom: 0.01 }, "volcanic"],
  [{ name: "Bandelier Tuff", lith: "", descrip: "", best_age_top: 1.2 }, "volcanic"],
  [{ name: "Vishnu Schist", lith: "", best_age_top: 1680 }, "metamorphic"],
  [{ name: "Unit A", lith: "", descrip: "", best_age_top: 0, best_age_bottom: 1 }, "unconsolidated"],
  [{ name: "Unit B", lith: "", descrip: "", best_age_top: 300, best_age_bottom: 350 }, "sedimentary"],
  [{ name: "Conejos Formation", lith: "", descrip: "Andesitic lava flows and breccias", best_age_top: 29 }, "volcanic"],
  [{ name: "Gravelly sandstone", lith: "", best_age_top: 5 }, "sedimentary"],
];

describe("rock family classifier", () => {
  it.each(UNITS)("classes %o as %s", (unit, family) => {
    expect(rockFamilyOf(unit)).toBe(family);
  });

  it("the map's expression classes every unit as rockFamilyOf does", () => {
    const expr = rockFamilyExpression();
    for (const [unit, family] of UNITS) expect(evaluate(expr, unit as Record<string, unknown>)).toBe(family);
  });

  it("fills each unit in its family's color at the age step of its youngest rock", () => {
    const fill = rockFamilyFillExpression();
    for (const [unit, family] of UNITS) {
      expect(evaluate(fill, unit as Record<string, unknown>)).toBe(rockFamilyColor(family, unit.best_age_top));
    }
    expect(evaluate(fill, { name: "Navajo Sandstone", best_age_top: 170 })).toBe(FAMILY_COLORS.sedimentary[2]);
    expect(evaluate(fill, { name: "Vishnu Schist", best_age_top: 1680 })).toBe(FAMILY_COLORS.metamorphic[4]);
  });

  it("steps ages at the era bounds, youngest first", () => {
    expect(AGE_STEPS).toEqual([0, 2.58, 66, 252, 541]);
    expect([0, 2.57, 2.58, 65.9, 66, 251, 252, 540, 541, 4000].map(ageStepOf)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
    expect(ageStepOf(undefined)).toBe(0);
  });

  it("darkens every family with age (older is darker) and keeps the families apart", () => {
    expect(new Set(FAMILY_COLORS.unconsolidated).size).toBe(1);
    for (const [family, colors] of Object.entries(FAMILY_COLORS)) {
      if (family === "unconsolidated") continue;
      const lightness = colors.map((c) => rgbToOklch(hexToRgb(c))[0]);
      for (let i = 1; i < lightness.length; i++) expect(lightness[i]).toBeLessThan(lightness[i - 1]);
    }
    const middles = Object.values(FAMILY_COLORS).map((c) => c[2]);
    expect(new Set(middles).size).toBe(5);
  });

  it("keys the legend as five rock families with how darkness reads and the age bands", () => {
    expect(ROCK_FAMILY_LEGEND).toMatchObject({ kind: "categories", title: "Rock family", field: ROCK_FAMILY_FIELD });
    expect(ROCK_FAMILY_LEGEND.items?.map((i) => i.label)).toEqual(["Sedimentary", "Volcanic", "Plutonic", "Metamorphic", "Loose sediment"]);
    expect(ROCK_FAMILY_LEGEND.note).toMatch(/^Darker = older/);
    expect(ROCK_FAMILY_LEGEND.note).toContain("Precambrian (over 541 million years)");
    expect(FAMILY_LABELS.map((f) => f.id)).toEqual(ROCK_FAMILY_LEGEND.items?.map((i) => i.value));
  });

  it("derives the rock family for the in-view shares and passes other fields as served", () => {
    expect(tileFieldValue(ROCK_FAMILY_FIELD, { name: "Navajo Sandstone" })).toBe("sedimentary");
    expect(tileFieldValue("best_age_top", { best_age_top: 170 })).toBe(170);
    expect(tileFieldValue(ROCK_FAMILY_FIELD, undefined)).toBeUndefined();
  });

  it("draws a seamless dark grey stipple tile", () => {
    const img = stippleImage(DARK_GREY);
    expect(img.width).toBe(HATCH_FRAME);
    const alphas = [];
    for (let i = 3; i < img.data.length; i += 4) alphas.push(img.data[i]);
    const inked = alphas.filter((a) => a > 128).length / alphas.length;
    expect(inked).toBeGreaterThan(0.01);
    expect(inked).toBeLessThan(0.15);
    // The pattern repeats with a period that divides the tile on both axes, so tiles meet without a seam.
    const a = (x: number, y: number) => img.data[(((y + HATCH_FRAME) % HATCH_FRAME) * HATCH_FRAME + ((x + HATCH_FRAME) % HATCH_FRAME)) * 4 + 3];
    const step = 18;
    for (let y = 0; y < HATCH_FRAME; y += 5) for (let x = 0; x < HATCH_FRAME; x += 3) {
      expect(a(x + step, y)).toBe(a(x, y));
      expect(a(x, y + 2 * step)).toBe(a(x, y));
    }
  });
});
