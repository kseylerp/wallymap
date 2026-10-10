import { describe, expect, it } from "vitest";
import { COMPARE_COLORS, DARK_GREY, OFF_WHITE, PINK, PURPLE, RAMPS, SAGE, type RampName } from "@/lib/render/palette";
import { compareRampColor, hexToRgb, interpolateStops, lightness, oklchToRgb, rampColor, rgbToHex, rgbToOklch } from "@/lib/render/ramp";

const hex = (name: RampName, t: number) => rgbToHex(rampColor(name, t));

describe("palette ramps (OKLCH)", () => {
  it("round-trips sRGB through OKLCH", () => {
    for (const color of [PINK, PURPLE, SAGE, OFF_WHITE, DARK_GREY]) {
      const back = oklchToRgb(rgbToOklch(hexToRgb(color)));
      hexToRgb(color).forEach((c, i) => expect(Math.abs(c - back[i])).toBeLessThanOrEqual(1));
    }
  });

  it.each([
    ["density", OFF_WHITE, DARK_GREY],
    ["popularity", OFF_WHITE, PURPLE],
    ["remoteness", OFF_WHITE, DARK_GREY],
    ["gray", OFF_WHITE, DARK_GREY],
  ] as const)("%s runs from %s to %s", (name, low, high) => {
    expect(hex(name, 0)).toBe(low);
    expect(hex(name, 1)).toBe(high);
  });

  it("passes through its middle stops: density sage then purple, popularity pink, remoteness sage", () => {
    expect(interpolateStops(RAMPS.density, 1 / 3)).toEqual(hexToRgb(SAGE));
    expect(interpolateStops(RAMPS.density, 2 / 3)).toEqual(hexToRgb(PURPLE));
    expect(rgbToHex(interpolateStops(RAMPS.popularity, 0.5))).toBe(PINK);
    expect(rgbToHex(interpolateStops(RAMPS.remoteness, 0.5))).toBe(SAGE);
  });

  it.each(Object.keys(RAMPS) as RampName[])("%s falls in lightness monotonically", (name) => {
    let previous = Infinity;
    for (let i = 0; i <= 100; i++) {
      const l = lightness(interpolateStops(RAMPS[name], i / 100));
      expect(l).toBeLessThanOrEqual(previous + 1e-3);
      previous = l;
    }
  });

  it("clamps out-of-range and non-numeric positions", () => {
    expect(hex("density", -1)).toBe(OFF_WHITE);
    expect(hex("density", 7)).toBe(DARK_GREY);
    expect(hex("density", Number.NaN)).toBe(OFF_WHITE);
  });

  it("diverges for compare: purple at -1, off-white at 0, pink at 1, lightness falling away from 0", () => {
    expect(rgbToHex(compareRampColor(-1))).toBe(COMPARE_COLORS.a);
    expect(rgbToHex(compareRampColor(0))).toBe(OFF_WHITE);
    expect(rgbToHex(compareRampColor(1))).toBe(COMPARE_COLORS.b);
    for (const sign of [-1, 1]) {
      let previous = Infinity;
      for (let i = 0; i <= 20; i++) {
        const l = lightness(compareRampColor((sign * i) / 20));
        expect(l).toBeLessThanOrEqual(previous + 1e-3);
        previous = l;
      }
    }
  });
});
