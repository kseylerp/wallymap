import { afterEach, describe, expect, it } from "vitest";
import terrain, { statsNote, terrainTileUrl } from "./terrain";
import { legendOf } from "./contract";
import { useTileSource } from "@/lib/terrain/dem";
import { plane, syntheticTiles } from "@/lib/terrain/__fixtures__/synthetic";
import type { LayerResult, QueryContext } from "./types";

afterEach(() => useTileSource());

const ctx = (bbox: [number, number, number, number]) => ({ bbox, zoom: 12, env: {}, fetch: (async () => new Response("")) as never }) as QueryContext;
const BOX: [number, number, number, number] = [-110.95, 43.45, -110.9, 43.5];

describe("terrain layer", () => {
  it("answers slope with this app's tiles and the box's shares by class", async () => {
    useTileSource(syntheticTiles(plane(38, 90)));
    const out = (await terrain.query(ctx(BOX), terrain.input.parse({}))) as Extract<LayerResult, { kind: "tiles" }>;
    expect(out.kind).toBe("tiles");
    expect(out.data.url).toBe("/api/terrain/slope/{z}/{x}/{y}");
    expect(out.data.minzoom).toBe(9);
    expect(out.coverageNote).toMatch(/^Of about \d+ km² sampled every \d+ m: Under 25° 0%, 25 to 30° 0%, 30 to 35° 0%, 35 to 45° 100%, Over 45° 0%; 30 to 45° \(avalanche terrain\) 100%; steepest 38°$/);
    expect(out.viewNote).toBe("100% of this box is 30 to 45°, where most slab avalanches start");
    expect(out.legend?.items?.map((i) => i.label)).toEqual(["25 to 30°", "30 to 35°", "35 to 45°", "Over 45°"]);
  });

  it("answers aspect and shade with their own keys and notes", async () => {
    useTileSource(syntheticTiles(plane(38, 90)));
    const aspect = (await terrain.query(ctx(BOX), terrain.input.parse({ mode: "aspect", faces: ["W"] }))) as Extract<LayerResult, { kind: "tiles" }>;
    expect(aspect.data.url).toBe("/api/terrain/aspect/{z}/{x}/{y}?faces=W");
    expect(aspect.coverageNote).toMatch(/facing north 0%, east 0%, south 0%, west 100%/);
    expect(aspect.legend?.title).toBe("Way the slope faces");
    const shade = (await terrain.query(ctx(BOX), terrain.input.parse({ mode: "shade", date: "2026-10-23" }))) as Extract<LayerResult, { kind: "tiles" }>;
    expect(shade.data.url).toBe("/api/terrain/shade/{z}/{x}/{y}?date=2026-10-23&period=afternoon");
    // A west-facing slope gets the afternoon sun.
    expect(shade.coverageNote).toMatch(/0% faces away from the sun 1 to 5 pm solar time on Oct 23, 2026 \(the sun moving from \d+° to \d+°, S\w* to \w+\)/);
  });

  it("says plainly when the elevation tiles do not answer", async () => {
    useTileSource(async () => null);
    const out = (await terrain.query(ctx(BOX), terrain.input.parse({}))) as Extract<LayerResult, { kind: "tiles" }>;
    expect(out.sourceStatus).toMatchObject({ ok: false, reason: "offline" });
    expect(out.coverageNote).toMatch(/did not answer/);
  });

  it("builds tile URLs from the inputs and keeps a usable legend", () => {
    expect(terrainTileUrl({ mode: "slope", minSlope: 30 })).toBe("/api/terrain/slope/{z}/{x}/{y}?min=30");
    expect(legendOf(terrain).kind).toBe("categories");
    expect(statsNote({ areaKm2: 10, resolutionM: 30, shares: { Flat: 0.5, N: 0.25, S: 0.25 }, steepestDeg: 40, samples: 9 }, { mode: "aspect" }, "Oct 23").coverageNote).toMatch(
      /steeper than 10° \(50% of the box\), facing north 50%, east 0%, south 50%, west 0%/,
    );
  });
});
