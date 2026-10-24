import { afterEach, describe, expect, it } from "vitest";
import type { Feature } from "geojson";
import { runLayer } from "@/lib/layers/run";
import { cardContent } from "@/lib/render/card";
import { profileOfFeature, pointAlong, verticalExaggeration } from "@/lib/render/crossSection";
import { useTileSource } from "@/lib/terrain/dem";
import { crossSection, pathLengthM, steepestStretch, stepFor } from "@/lib/terrain/profile";
import { plane, syntheticTiles } from "@/lib/terrain/__fixtures__/synthetic";
import { contractProblems } from "./contract";
import layer, { pathOf } from "./elevation-profile";

/** Offline: the elevation comes from formulas (lib/terrain/__fixtures__/synthetic.ts), never from S3. */
afterEach(() => useTileSource());

const ORIGIN: [number, number] = [-119.59, 37.745];
/** About 2 km due east of ORIGIN. */
const EAST: [number, number] = [ORIGIN[0] + 2000 / (111_195 * Math.cos((ORIGIN[1] * Math.PI) / 180)), ORIGIN[1]];

/** A valley floor at 1,200 m for the first kilometre, then a 30° wall up to the end. */
function valleyAndWall(lon: number): number {
  const kx = 111_195 * Math.cos((ORIGIN[1] * Math.PI) / 180);
  const x = (lon - ORIGIN[0]) * kx;
  return x < 1000 ? 1200 : 1200 + (x - 1000) * Math.tan((30 * Math.PI) / 180);
}

describe("crossSection", () => {
  it("reads a tilted plane: the climb, the ends, and the steepest stretch at the plane's slope", async () => {
    const source = syntheticTiles(plane(10, 90, ORIGIN, 1500));
    const cs = await crossSection([ORIGIN, EAST], { source });
    expect(cs).not.toBeNull();
    const rise = 2000 * Math.tan((10 * Math.PI) / 180);
    expect(cs!.lengthM).toBeGreaterThan(1990);
    expect(cs!.lengthM).toBeLessThan(2010);
    expect(cs!.startM).toBeCloseTo(1500, -1);
    expect(cs!.endM).toBeCloseTo(1500 + rise, -1);
    expect(Math.abs(cs!.climbM - rise)).toBeLessThan(10);
    expect(cs!.descentM).toBe(0);
    expect(cs!.steepest).toMatchObject({ deg: 10, direction: "climbing" });
    expect(cs!.steepest!.gradePct).toBe(18);
    expect(cs!.stepM).toBe(10);
  });

  it("finds the wall: the steepest 100 m is 30° and lies past the first kilometre", async () => {
    const cs = await crossSection([ORIGIN, EAST], { source: syntheticTiles((lon) => valleyAndWall(lon)) });
    expect(cs!.steepest!.deg).toBe(30);
    expect(cs!.steepest!.fromM).toBeGreaterThanOrEqual(990);
    expect(cs!.high.atM).toBeGreaterThan(1990);
    expect(cs!.low.m).toBe(1200);
  });

  it("measures descending stretches as descending", async () => {
    const cs = await crossSection([EAST, ORIGIN], { source: syntheticTiles(plane(10, 90, ORIGIN, 1500)) });
    expect(cs!.steepest!.direction).toBe("descending");
    expect(cs!.climbM).toBe(0);
  });

  it("returns null when no elevation tiles answer", async () => {
    expect(await crossSection([ORIGIN, EAST], { source: async () => null })).toBeNull();
  });

  it("spaces samples 10 m on short lines and up to 30 m on long ones", () => {
    expect(stepFor(5_000)).toBe(10);
    expect(stepFor(40_000)).toBe(20);
    expect(stepFor(150_000)).toBe(30);
  });

  it("keeps the steepest stretch at least 100 m long", () => {
    const d = [0, 10, 20, 30, 200];
    const e = [0, 0, 50, 50, 60];
    const pos = d.map(() => [0, 0] as [number, number]);
    // 0 to 50 m within 20 m is a step, not a 100 m stretch: the steepest measured stretch spans 100 m or more.
    expect(steepestStretch(d, e, pos)!.toM - steepestStretch(d, e, pos)!.fromM).toBeGreaterThanOrEqual(100);
  });
});

describe("elevation-profile layer", () => {
  it("passes the layer contract", () => {
    expect(contractProblems(layer)).toEqual([]);
  });

  it("takes from and to, or points", () => {
    expect(pathOf({ from: { lon: 1, lat: 2, name: "A" }, to: { lon: 3, lat: 4, name: "B" } })).toEqual({ path: [[1, 2], [3, 4]], start: "A", end: "B" });
    expect(pathOf({ points: [[1, 2], [3, 4], [5, 6]] })?.path).toHaveLength(3);
    expect(pathOf({})).toBeNull();
  });

  it("answers one line with the facts, the profile and a note quoting them (feet first in the US)", async () => {
    useTileSource(syntheticTiles((lon) => valleyAndWall(lon)));
    const res = await runLayer("elevation-profile", {
      bbox: [ORIGIN[0] - 0.01, ORIGIN[1] - 0.01, EAST[0] + 0.01, ORIGIN[1] + 0.01],
      input: { from: { lon: ORIGIN[0], lat: ORIGIN[1], name: "The valley" }, to: { lon: EAST[0], lat: EAST[1], name: "The rim" } },
    });
    expect(res.status).toBe(200);
    const body = res.body as Extract<typeof res.body, { kind: "geojson" }>;
    expect(body.data.features).toHaveLength(1);
    const f = body.data.features[0] as Feature;
    expect(f.geometry.type).toBe("LineString");
    const p = f.properties!;
    expect(p.name).toBe("The valley to The rim");
    expect(p.startText).toBe("3,937 ft (1,200 m)");
    expect(p.steepestDeg).toBe(30);
    expect(p.steepestText).toMatch(/^30° \(58% grade\) over 100 m, about 0\.\d mi from The valley, climbing$/);
    expect(Array.isArray(p.profileDistancesM)).toBe(true);
    expect(body.coverageNote).toMatch(/^Straight line from The valley to The rim, 1\.2 mi \(2 km\): starts at 3,937 ft \(1,200 m\)/);
    expect(body.coverageNote).toMatch(/climbs [\d,]+ ft/);
    expect(body.coverageNote).toMatch(/steepest 100 m: 30°/);
    expect(body.coverageNote).toMatch(/×\d/);
    // The card leads with the climb and lists start, top and end.
    const card = cardContent(f, { card: layer.card, fieldHelp: layer.fieldHelp });
    expect(card.measure?.label).toBe("Climb");
    expect(card.facts.slice(0, 3).map((x) => x.label)).toEqual(["Start", "Top", "End"]);
    // The chart reads the profile back off the feature.
    const view = profileOfFeature(f);
    expect(view?.distancesM.length).toBe(view?.elevationsM.length);
    expect(view?.steepest?.deg).toBe(30);
  });

  it("refuses a missing end, a line under 50 m and one over 200 km", async () => {
    const bbox = [-120, 37, -119, 38];
    expect((await runLayer("elevation-profile", { bbox, input: { from: { lon: -119.5, lat: 37.5 } } })).body).toMatchObject({ error: expect.stringMatching(/two ends/) });
    expect((await runLayer("elevation-profile", { bbox, input: { points: [[-119.5, 37.5], [-119.5001, 37.5]] } })).body).toMatchObject({ error: expect.stringMatching(/50 m/) });
    expect((await runLayer("elevation-profile", { bbox, input: { points: [[-119.5, 37.5], [-116, 37.5]] } })).body).toMatchObject({ error: expect.stringMatching(/200 km/) });
  });
});

describe("cross-section chart helpers", () => {
  it("states the vertical exaggeration a chart draws at", () => {
    // 5,300 m across 360 px and 1,480 m up 140 px: about 1.4 times steeper than the ground.
    expect(verticalExaggeration(5_300, 1_480)).toBe(1.4);
    expect(verticalExaggeration(40_000, 300)).toBe(52);
    expect(verticalExaggeration(1_000, 0)).toBe(1);
  });

  it("finds the point a distance along the line", () => {
    const at = pointAlong([ORIGIN, EAST], pathLengthM([ORIGIN, EAST]) / 2)!;
    expect(at[0]).toBeCloseTo((ORIGIN[0] + EAST[0]) / 2, 6);
    expect(pointAlong([ORIGIN, EAST], 1e9)).toEqual(EAST);
  });
});
