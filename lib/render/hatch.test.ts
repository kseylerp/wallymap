import { describe, expect, it } from "vitest";
import {
  acresStep,
  HATCH_FRAME,
  HATCH_GUTTER,
  HATCH_SCALE,
  HATCH_STEPS,
  HATCH_TILE_PX,
  hatchAtlas,
  hatchAtlasCanvas,
  hatchImage,
  hatchPatternId,
  stepFor,
} from "@/lib/render/hatch";
import { HATCH_COLORS, HATCH_SPACINGS, PINK, SAGE, WHITE } from "@/lib/render/palette";
import { hexToRgb } from "@/lib/render/ramp";

/** Share of a tile's pixels covered by the pattern (alpha-weighted). */
function ink({ data }: { data: Uint8ClampedArray }): number {
  let sum = 0;
  for (let i = 3; i < data.length; i += 4) sum += data[i];
  return sum / (255 * (data.length / 4));
}

describe("hatch patterns", () => {
  it("steps 12 → 3 px in five densities, each dividing the tile so patterns repeat seamlessly", () => {
    expect(HATCH_SPACINGS).toEqual([12, 9, 6, 4, 3]);
    expect(HATCH_STEPS).toBe(5);
    for (const spacing of HATCH_SPACINGS) expect(HATCH_TILE_PX % spacing).toBe(0);
    expect(HATCH_FRAME).toBe(HATCH_TILE_PX * HATCH_SCALE);
  });

  it("names patterns by color and step, clamping the step", () => {
    expect(hatchPatternId(PINK, 4)).toBe("hatch-F57272-4");
    expect(hatchPatternId(SAGE, 9)).toBe("hatch-9FB693-4");
    expect(hatchPatternId(SAGE, -2)).toBe("hatch-9FB693-0");
  });

  it("draws one tile per pattern in its own color, denser steps covering more", () => {
    const tiles = HATCH_SPACINGS.map((_, step) => hatchImage(PINK, step));
    for (const tile of tiles) {
      expect(tile).toMatchObject({ width: HATCH_FRAME, height: HATCH_FRAME });
      expect(tile.data.length).toBe(HATCH_FRAME * HATCH_FRAME * 4);
      expect([...tile.data.slice(0, 3)]).toEqual(hexToRgb(PINK));
    }
    const coverage = tiles.map(ink);
    for (let i = 1; i < coverage.length; i++) expect(coverage[i]).toBeGreaterThan(coverage[i - 1]);
    // Lines and gaps both exist even at the densest step.
    const alphas = new Set(tiles[4].data.filter((_, i) => i % 4 === 3));
    expect(alphas.has(0) || Math.min(...alphas) < 128).toBe(true);
  });

  it("runs lines at 45° (bottom-left to top-right) and tiles seamlessly", () => {
    const { data } = hatchImage(SAGE, 0);
    const a = (x: number, y: number) => data[(y * HATCH_FRAME + x) * 4 + 3];
    // Along a "/" diagonal the alpha repeats; one period across it changes.
    expect(a(10, 20)).toBe(a(11, 19));
    expect(a(10, 20)).toBe(a(20, 10));
    // Wrapping: column 0 continues column HATCH_FRAME - 1 as column 1 continues column 0.
    for (let y = 0; y < HATCH_FRAME; y += 7) expect(a(0, y)).toBe(a(HATCH_FRAME - 1, (y + 1) % HATCH_FRAME));
  });

  it("is memoized: one buffer per pattern", () => {
    expect(hatchImage(PINK, 2)).toBe(hatchImage(PINK, 2));
    expect(hatchAtlas()).toBe(hatchAtlas());
  });

  it("packs every color × density into one atlas with gutters, frames mapping into it", () => {
    const atlas = hatchAtlas();
    const cell = HATCH_FRAME + 2 * HATCH_GUTTER;
    expect(atlas.width).toBe(cell * HATCH_STEPS);
    expect(atlas.height).toBe(cell * HATCH_COLORS.length);
    expect(Object.keys(atlas.mapping)).toHaveLength(HATCH_STEPS * HATCH_COLORS.length);
    expect(HATCH_COLORS).toContain(WHITE);
    const frame = atlas.mapping[hatchPatternId(SAGE, 3)];
    expect(frame).toEqual({ x: 3 * cell + HATCH_GUTTER, y: 2 * cell + HATCH_GUTTER, width: HATCH_FRAME, height: HATCH_FRAME });
    // The frame inside the atlas matches the standalone tile.
    const tile = hatchImage(SAGE, 3);
    for (const [x, y] of [[0, 0], [5, 9], [40, 71]]) {
      const i = ((frame.y + y) * atlas.width + frame.x + x) * 4 + 3;
      expect(atlas.data[i]).toBe(tile.data[(y * HATCH_FRAME + x) * 4 + 3]);
    }
  });

  it("has no canvas outside a browser, so deck draws the tint alone", () => {
    expect(hatchAtlasCanvas()).toBeUndefined();
  });
});

describe("density steps", () => {
  it("steps fires by burned acres: under 100 sparsest, 100k and up densest", () => {
    expect([50, 100, 999, 5_000, 50_000, 100_000, 400_000].map(acresStep)).toEqual([0, 1, 1, 2, 3, 4, 4]);
    expect(acresStep(undefined)).toBe(0);
    expect(acresStep("12000")).toBe(3);
  });

  it("clamps to the five steps", () => {
    expect(stepFor(10, [1, 2, 3, 4, 5, 6])).toBe(4);
  });
});
