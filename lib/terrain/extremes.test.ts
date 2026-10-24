import { afterEach, describe, expect, it } from "vitest";
import { useTileSource } from "./dem";
import { bandOf, bandsFor, boxExtremes } from "./extremes";
import { bandTint, CONTOUR_COLOR, hypsoColor, renderElevationTile } from "./view";
import { syntheticTiles } from "./__fixtures__/synthetic";
import { lonToX, latToY } from "./dem";
import { DARK_GREY, OFF_WHITE } from "@/lib/render/palette";
import { hexToRgb } from "@/lib/render/ramp";
import { runLayer } from "@/lib/layers/run";
import "@/layers";

afterEach(() => useTileSource());

/** A Death-Valley-like box: a broad basin floor at -84 m with a few deep one-pixel pits, and one sharp summit at 3,366 m. */
const BOX: [number, number, number, number] = [-117.3, 36.1, -116.5, 36.8];
const SUMMIT: [number, number] = [-117.0892, 36.1699];
const FLOOR: [number, number] = [-116.83, 36.25];
const PITS: [number, number][] = [[-116.958, 36.498], [-116.8835, 36.3034]];

function ground(lon: number, lat: number): number {
  const dS = Math.hypot(lon - SUMMIT[0], lat - SUMMIT[1]);
  const dF = Math.hypot(lon - FLOOR[0], lat - FLOOR[1]);
  // A pit the size of a pixel at zoom 11 (about 60 m): a hole in the model, not ground.
  if (PITS.some(([x, y]) => Math.abs(lon - x) < 0.0004 && Math.abs(lat - y) < 0.0004)) return -251;
  const summit = 3366 * (1 - dS / 0.15);
  const basin = Math.min(200, -84 + dF * 1500);
  return Math.max(summit, basin);
}

describe("boxExtremes", () => {
  it("reads the summit near its true height and the basin floor, not the pits", async () => {
    const ext = await boxExtremes(BOX, { source: syntheticTiles(ground) });
    expect(ext).not.toBeNull();
    expect(Math.abs(ext!.high.m - 3366)).toBeLessThan(25);
    expect(Math.abs(ext!.high.lon - SUMMIT[0])).toBeLessThan(0.01);
    expect(ext!.low.m).toBeGreaterThanOrEqual(-90);
    expect(ext!.low.m).toBeLessThanOrEqual(-60);
    expect(Math.hypot(ext!.low.lon - FLOOR[0], ext!.low.lat - FLOOR[1])).toBeLessThan(0.05);
    expect(ext!.groundAt(SUMMIT[0], SUMMIT[1])).toBeGreaterThan(3000);
  });

  it("returns null when no tile answers", async () => {
    expect(await boxExtremes(BOX, { source: async () => null })).toBeNull();
  });
});

describe("elevation bands", () => {
  it("takes 1,000 ft bands over a mountain view and 2,000 ft over Death Valley's 11,300 ft of relief", () => {
    expect(bandsFor(1200, 2700, true)).toMatchObject({ step: 1000, unit: "ft", lo: 3, hi: 8 });
    expect(bandsFor(-86, 3366, true)).toMatchObject({ step: 2000, unit: "ft", lo: -1, hi: 5 });
    expect(bandsFor(1200, 2700, false)).toMatchObject({ step: 200, unit: "m", lo: 6, hi: 13 });
    expect(bandOf(-1, 304.8)).toBe(-1);
  });

  it("tints from off-white to dark grey, in palette mixes only", () => {
    expect(hypsoColor(0)).toEqual(hexToRgb(OFF_WHITE));
    expect(hypsoColor(1)).toEqual(hexToRgb(DARK_GREY));
    const low = bandTint(0, 0, 5);
    const high = bandTint(5, 0, 5);
    expect(low[0] + low[1] + low[2]).toBeGreaterThan(high[0] + high[1] + high[2]);
    // No teal or blue on the way: blue never leads green and red together by much (sage to purple mixes in sRGB).
    for (let t = 0; t <= 1; t += 0.05) {
      const [r, g, b] = hypsoColor(t);
      expect(g - Math.max(r, b)).toBeLessThan(40);
    }
  });

  it("draws bands with contour lines where the band changes", async () => {
    // Ground rising 1 m per 10 m eastward across one zoom-12 tile: several 100 m bands, so several contours.
    const z = 12;
    const x = Math.floor(lonToX(-119.6, z));
    const y = Math.floor(latToY(37.74, z));
    const source = syntheticTiles((lon) => 1000 + (lon + 119.6) * 111_195 * 0.79 * 0.1);
    const px = await renderElevationTile(z, x, y, { mode: "elevation", bandStepM: 100, bandLo: 9, bandHi: 13 }, source);
    let contour = 0;
    let tinted = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === CONTOUR_COLOR[3] && px[i] === CONTOUR_COLOR[0]) contour++;
      else if (px[i + 3] > 0) tinted++;
    }
    expect(contour).toBeGreaterThan(256);
    expect(tinted).toBeGreaterThan(contour * 10);
  });
});

describe("terrain layer, mode elevation", () => {
  it("draws bands chosen for the box and names its highest and lowest ground in feet and metres", async () => {
    useTileSource(syntheticTiles(ground));
    const res = await runLayer("terrain", { bbox: BOX, zoom: 9, input: { mode: "elevation" } });
    expect(res.status).toBe(200);
    const body = res.body as Extract<typeof res.body, { kind: "tiles" }>;
    expect(body.data.url).toMatch(/^\/api\/terrain\/elevation\/\{z\}\/\{x\}\/\{y\}\?step=609\.6&lo=-1&hi=5$/);
    expect(body.data.minzoom).toBe(5);
    expect(body.legend).toMatchObject({ kind: "ramp", title: "Elevation", unit: "ft" });
    expect(body.legend?.stops?.map((s) => s.label)).toEqual(["-2,000 ft", "0 ft", "2,000 ft", "4,000 ft", "6,000 ft", "8,000 ft", "10,000 ft"]);
    expect(body.coverageNote).toMatch(
      /^Highest ground in this box: 11,0\d\d ft \(3,3\d\d m\) at -117\.\d{4}, 36\.\d{4} \(lon, lat\); lowest: -2\d\d ft \(-\d\d m\), 2\d\d ft below sea level at -116\.\d{4}, 36\.\d{4}/,
    );
  });

  it("keeps slope, aspect and shade to 5,000 km²", async () => {
    const res = await runLayer("terrain", { bbox: BOX, zoom: 9, input: { mode: "slope" } });
    expect(res.body).toMatchObject({ error: expect.stringMatching(/under 5,000 km² for slope/), hint: "zoom_in" });
  });
});
