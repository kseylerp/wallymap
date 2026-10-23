import { describe, expect, it } from "vitest";
import { compositeOver, deltaE, hexToRgb } from "@/lib/render/ramp";
import { isPaletteColor } from "@/lib/render/palette";
import {
  areaScale,
  CLASSES,
  OTHER_ALPHA,
  parseTileQuery,
  readConversionAreas,
  readPoint,
  readShares,
  sharesScale,
  TARGETS,
  tileKey,
  tileQuery,
  type TileParams,
} from "./forestTypes";
import recorded from "./__fixtures__/forest-types.json";

/** Ground colors of the basemaps (as in lib/render/classContrast.test.ts). */
const GROUNDS = { "Topo land": "#EAEEDF", "Topo forest": "#CFE0BD", "Satellite forest": "#3F4F33", "Satellite desert": "#B49A74" };
/** The forest types draw at the layer's raster opacity. */
const DRAWN_ALPHA = 0.85;

describe("ForTy readings", () => {
  it("reads a point's six probabilities (stored as 0..250) and its most likely class", () => {
    const danum = readPoint(recorded.pointDanumBaseline);
    expect(danum?.classCode).toBe(1);
    expect(danum?.probabilities.primary).toBeCloseTo(0.992, 3);
    const sabah = readPoint(recorded.pointSabah2025);
    expect(sabah?.classCode).toBe(5);
    expect(sabah?.probabilities.treeCrops).toBeCloseTo(0.888, 3);
    // The sea has no ForTy pixel.
    expect(readPoint(recorded.pointSea)).toBeNull();
  });

  it("turns a class histogram into shares of the mapped land, with 0 for the pixels below the confidence asked", () => {
    const all = readShares(recorded.sharesSabahAll);
    expect(Object.values(all).reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6);
    expect(all["1"]).toBeGreaterThan(0.9);
    expect(all["0"]).toBeUndefined();
    const confident = readShares(recorded.sharesSabahConfident);
    expect(confident["0"]).toBeGreaterThan(0.02);
    expect(readShares({ class: {} })).toEqual({});
  });

  it("adds up converted natural forest by target", () => {
    const a = readConversionAreas(recorded.areasKalimantanSince2017)!;
    expect(a.converted).toBeCloseTo(732.28 + 0.17 + 175.95, 1);
    expect(a.naturalBefore).toBeCloseTo(a.standing + a.converted, 6);
    expect(a.byTarget.toTreeCrops).toBeCloseTo(175.95, 1);
    expect(readConversionAreas(null)).toBeNull();
  });

  it("picks reduction scales from the box: ~300 samples across for shares, ~4 million cells for areas", () => {
    expect(sharesScale([117.6, 4.8, 118.0, 5.1])).toBe(148);
    expect(sharesScale([117.79, 4.97, 117.7901, 4.9701])).toBe(10);
    expect(areaScale([113, -2, 114, -1])).toBe(60);
    expect(areaScale([117.79, 4.97, 117.8, 4.98])).toBe(30);
  });
});

describe("ForTy tile queries", () => {
  it("round-trips every picture the layer publishes, with its own map key", () => {
    const pictures: TileParams[] = [
      { view: "classes", source: { kind: "baseline" }, minConfidence: 0 },
      { view: "classes", source: { kind: "baseline" }, minConfidence: 0.7 },
      { view: "classes", source: { kind: "year", year: 2019 }, minConfidence: 0 },
      { view: "change", since: 2017, to: 2025, minConfidence: 0.7 },
    ];
    for (const p of pictures) expect(parseTileQuery(new URLSearchParams(tileQuery(p)))).toEqual(p);
    expect(new Set(pictures.map(tileKey)).size).toBe(pictures.length);
  });

  it("refuses anything it does not publish", () => {
    for (const q of [
      "view=classes&src=2020v1",
      "view=classes&src=2016&conf=all",
      "view=classes&src=2020v1&conf=0.3",
      "view=change&since=2025&to=2017&conf=all",
      "view=change&since=2017&to=2030&conf=all",
      "view=expression&src=2020v1&conf=all",
    ]) {
      expect(parseTileQuery(new URLSearchParams(q)), q).toBeNull();
    }
  });
});

describe("ForTy colors", () => {
  it("come from the palette family, and other land and the converted pinks are distinct", () => {
    expect(CLASSES.map((c) => c.code)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const c of CLASSES.filter((x) => [2, 4, 5, 6].includes(x.code))) expect(isPaletteColor(c.color), c.label).toBe(true);
    expect(OTHER_ALPHA).toBeLessThan(0.5);
    expect(new Set(TARGETS.map((t) => t.color)).size).toBe(3);
  });

  it("any two forest classes differ visibly over every basemap", () => {
    const forest = CLASSES.filter((c) => c.code <= 5);
    for (const [ground, under] of Object.entries(GROUNDS)) {
      for (let i = 0; i < forest.length; i++) {
        for (let j = i + 1; j < forest.length; j++) {
          const dE = deltaE(compositeOver(hexToRgb(forest[i].color), DRAWN_ALPHA, hexToRgb(under)), compositeOver(hexToRgb(forest[j].color), DRAWN_ALPHA, hexToRgb(under)));
          expect(dE, `${forest[i].label} | ${forest[j].label} on ${ground}`).toBeGreaterThanOrEqual(8);
        }
      }
    }
  });

  it("each converted pink stands off the basemap and the others", () => {
    for (const [ground, under] of Object.entries(GROUNDS)) {
      for (let i = 0; i < TARGETS.length; i++) {
        const a = compositeOver(hexToRgb(TARGETS[i].color), DRAWN_ALPHA, hexToRgb(under));
        expect(deltaE(a, hexToRgb(under)), `${TARGETS[i].label} on ${ground}`).toBeGreaterThanOrEqual(8);
        for (let j = i + 1; j < TARGETS.length; j++) {
          const b = compositeOver(hexToRgb(TARGETS[j].color), DRAWN_ALPHA, hexToRgb(under));
          expect(deltaE(a, b), `${TARGETS[i].label} | ${TARGETS[j].label} on ${ground}`).toBeGreaterThanOrEqual(5);
        }
      }
    }
  });
});
