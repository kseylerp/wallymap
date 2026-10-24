import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import waterDepth, { depthLegend, depthNotes, depthText, depthTileUrl } from "./water-depth";
import { contractProblems, legendOf, timeShapeOf } from "./contract";
import type { LayerResult, QueryContext } from "./types";
import { exportUrl, isWater, parseBsq, parseSamples, sourceOf, SURVEYS_ONLY_RULE, type BinaryFetch } from "@/lib/depth/ncei";
import { contourStep, depthColor, depthStats, drawTile, gridSize, maskInland, rampMax, type LandTest } from "@/lib/depth/view";
import { rampColor } from "@/lib/render/ramp";
import elliottSamples from "./__fixtures__/water-depth.samples.elliott.json";
import tahoeSamples from "./__fixtures__/water-depth.samples.tahoe.json";

/**
 * Fixtures, recorded 2026-10-23 from NOAA NCEI's DEM_all ImageServer: water-depth.elliott-64x48.bsq is exportImage
 * (format bsq, F32) of the T10.5 view -122.55,47.55,-122.35,47.7 at 64 by 48; the samples files are getSamples at
 * mid Elliott Bay (-122.37, 47.6: CUDEM 1/9 arc-second, -81.47 m) and mid Lake Tahoe (-120.04, 39.09: ETOPO only,
 * its flat surface at 1,897 m). Everything else is a synthetic grid.
 */
const ELLIOTT_BSQ = new Uint8Array(readFileSync(new URL("./__fixtures__/water-depth.elliott-64x48.bsq", import.meta.url)));

/** A `bsq` answer for a grid: little-endian floats, then one validity bit per pixel (NaN is invalid), most significant first. */
function encodeBsq(values: number[]): Uint8Array {
  const n = values.length;
  const out = new Uint8Array(n * 4 + Math.ceil(n / 8));
  const view = new DataView(out.buffer);
  values.forEach((v, i) => {
    view.setFloat32(i * 4, Number.isNaN(v) ? 0 : v, true);
    if (!Number.isNaN(v)) out[n * 4 + (i >> 3)] |= 1 << (7 - (i & 7));
  });
  return out;
}

/** The size an exportImage URL asks for. */
function sizeOf(url: string): [number, number] {
  const [w, h] = (new URL(url).searchParams.get("size") ?? "0,0").split(",").map(Number);
  return [w, h];
}

/** A bowl: 0 m at the edges, `deepest` metres below sea level at column `ci`, row `cj` (as shares of the grid). */
function bowl(deepest: number, ci = 0.25, cj = 0.75): BinaryFetch {
  return async (url) => {
    const [w, h] = sizeOf(url);
    const values: number[] = [];
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const d = Math.hypot((i + 0.5) / w - ci, (j + 0.5) / h - cj);
        values.push(-deepest * Math.max(0, 1 - d / 0.5) + 1);
      }
    }
    return encodeBsq(values);
  };
}

const NO_LAND: LandTest = { isLand: () => false, coastDistanceKm: (_lon, _lat, max) => max };
const OCEAN: [number, number, number, number] = [-142, 18, -138, 22];
const ELLIOTT: [number, number, number, number] = [-122.55, 47.55, -122.35, 47.7];

afterEach(() => vi.unstubAllGlobals());

describe("NOAA NCEI mosaic", () => {
  it("asks for raw floats in the view's reference, and leaves ETOPO out only for the surveys-only grid", () => {
    const q = new URL(exportUrl(ELLIOTT, 4326, 64, 48)).searchParams;
    expect(Object.fromEntries(q)).toMatchObject({ bbox: "-122.55,47.55,-122.35,47.7", bboxSR: "4326", imageSR: "4326", size: "64,48", format: "bsq", pixelType: "F32", f: "image" });
    expect(q.has("mosaicRule")).toBe(false);
    const rule = JSON.parse(new URL(exportUrl(ELLIOTT, 3857, 8, 8, true)).searchParams.get("mosaicRule") ?? "{}");
    expect(rule).toEqual(SURVEYS_ONLY_RULE);
    expect(rule.where).toBe("Name NOT LIKE 'ETOPO%'");
  });

  it("decodes the recorded Elliott Bay grid: land above 0, Puget Sound below -200 m, every pixel valid", () => {
    const grid = parseBsq(ELLIOTT_BSQ, 64, 48);
    expect(grid).not.toBeNull();
    const values = [...(grid?.values ?? [])];
    expect(values.every(Number.isFinite)).toBe(true);
    expect(Math.min(...values)).toBeLessThan(-200);
    expect(Math.max(...values)).toBeGreaterThan(50);
    const water = values.filter(isWater).length / values.length;
    expect(water).toBeGreaterThan(0.5);
    expect(water).toBeLessThan(0.75);
  });

  it("reads the validity bits most significant first and refuses a body of the wrong size", () => {
    const grid = parseBsq(encodeBsq([-1, NaN, -3, -4, -5, -6, -7, NaN, -9, -10, -11, -12, -13, -14, -15, -16]), 16, 1);
    expect([...(grid?.values ?? [])].map((v) => (Number.isNaN(v) ? null : v))).toEqual([-1, null, -3, -4, -5, -6, -7, null, -9, -10, -11, -12, -13, -14, -15, -16]);
    expect(parseBsq(new Uint8Array(10), 16, 1)).toBeNull();
  });

  it("names the survey behind a value in words, finest first", () => {
    const [first] = parseSamples(elliottSamples);
    expect(first).toMatchObject({ elevationM: -81.468925476, demName: "ncei19_n47x75_w122x50_2023v1" });
    expect(sourceOf(first.demName, first.cellArcSeconds)).toEqual({ name: "NOAA CUDEM coastal survey", spacingM: 3, surveyed: true });
    expect(sourceOf("greatlakes_lakedatum", 3).name).toMatch(/Great Lakes/);
    expect(sourceOf("ETOPO_2022_v1_15s_surface_elev", 15)).toMatchObject({ spacingM: 463, surveyed: false });
    // Lake Tahoe has no survey: only ETOPO, at its flat surface.
    expect(parseSamples(tahoeSamples)[0]).toMatchObject({ elevationM: 1897, demName: "ETOPO_2022_v1_15s_surface_elev" });
    expect(parseSamples({ error: { code: 500 } })).toEqual([]);
  });
});

describe("scale and picture", () => {
  it("contours every 50 ft in the US and 10 m elsewhere, wider when the view is deep", () => {
    expect(contourStep(286, true)).toEqual({ stepM: 15.24, label: "50 ft" });
    expect(contourStep(100, false)).toEqual({ stepM: 10, label: "10 m" });
    expect(contourStep(403, false)).toEqual({ stepM: 20, label: "20 m" });
    expect(contourStep(5_777, false)).toEqual({ stepM: 500, label: "500 m" });
    expect(contourStep(5_777, true).label).toBe("1,000 ft");
    expect(rampMax(286, 15.24)).toBeCloseTo(289.56, 2);
    expect(rampMax(0, 15.24)).toBe(15.24);
  });

  it("sizes the sample grid to the box's shape in whole bytes of validity bits", () => {
    const [w, h] = gridSize(ELLIOTT);
    expect(w % 8).toBe(0);
    expect(h).toBe(512);
    expect(w).toBeGreaterThan(400);
    expect(gridSize(OCEAN)).toEqual([480, 512]);
  });

  it("draws land clear, water on the off-white to dark grey ramp, contour lines and the deepest point's ring", () => {
    const side = 264;
    const values: number[] = [];
    // Left half land; right half deepening eastward from 0 to 100 m; the tile's PAD is 4 pixels.
    for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) values.push(i < side / 2 ? 10 : -((i - side / 2) / (side / 2)) * 100);
    const grid = { width: side, height: side, values: Float32Array.from(values) };
    // Tile 0/0/0 spans the world; the deepest point at lon 170 lands near the right edge, at the equator in the middle.
    const px = drawTile(grid, 0, 0, 0, { maxM: 100, stepM: 10, deepest: [170, 0] });
    const at = (i: number, j: number) => [...px.slice((j * 256 + i) * 4, (j * 256 + i) * 4 + 4)];
    expect(at(10, 10)).toEqual([0, 0, 0, 0]);
    const deep = at(250, 10);
    const shallow = at(140, 10);
    expect(deep[3]).toBeGreaterThan(200);
    // Deeper is darker.
    expect(deep[0] + deep[1] + deep[2]).toBeLessThan(shallow[0] + shallow[1] + shallow[2]);
    expect(depthColor(0, 100)).toEqual(rampColor("depth", 0));
    // Somewhere along a row the contour crossings differ from their neighbours.
    const row = Array.from({ length: 120 }, (_, k) => at(134 + k, 40)[1]);
    expect(new Set(row).size).toBeGreaterThan(10);
    // The ring: an opaque dark edge around an off-white middle.
    const cx = Math.round(((170 + 180) / 360) * 256);
    expect(at(cx, 128)[3]).toBe(255);
  });

  it("masks dry ground below sea level inland, keeping what the surveys-only grid holds", async () => {
    const w = 32;
    const grid = { width: w, height: 16, values: new Float32Array(w * 16).fill(-50) };
    const inland: LandTest = { isLand: (lon) => lon < 16, coastDistanceKm: () => 10 };
    const surveyed = vi.fn(async () => ({ width: w, height: 16, values: Float32Array.from({ length: w * 16 }, (_, k) => (k % w < 8 ? -20 : NaN)) }));
    const { masked } = await maskInland(grid, (i) => [i, 0], inland, surveyed);
    expect(surveyed).toHaveBeenCalledTimes(1);
    expect(grid.values[0]).toBe(-20);
    expect(Number.isNaN(grid.values[10])).toBe(true);
    expect(grid.values[20]).toBe(-50);
    expect(masked).toBe(8 * 16);
    const untouched = vi.fn(async () => null);
    await maskInland({ width: w, height: 16, values: new Float32Array(w * 16).fill(-50) }, (i) => [i, 0], NO_LAND, untouched);
    expect(untouched).not.toHaveBeenCalled();
  });

  it("finds the box's deepest point, median depth and water share", async () => {
    const stats = await depthStats(OCEAN, { fetch: bowl(300), land: NO_LAND });
    expect(stats?.deepest?.depthM).toBeGreaterThan(290);
    expect(stats?.deepest?.lon).toBeCloseTo(-141, 0);
    expect(stats?.deepest?.lat).toBeCloseTo(19, 0);
    expect(stats?.waterShare).toBeGreaterThan(0.3);
    expect(stats?.waterShare).toBeLessThan(0.7);
    expect(stats?.medianM).toBeGreaterThan(0);
    expect(await depthStats(OCEAN, { fetch: async () => null, land: NO_LAND })).toBeNull();
  });
});

describe("water-depth layer", () => {
  const samplesFetch = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  const ctx = (bbox: [number, number, number, number], fetch = samplesFetch(elliottSamples)) => ({ bbox, zoom: 9, env: {}, fetch: fetch as never }) as QueryContext;
  const stubMosaic = (f: BinaryFetch) =>
    vi.stubGlobal("fetch", async (url: string) => {
      const bytes = await f(url);
      return bytes ? new Response(new Uint8Array(bytes)) : new Response("down", { status: 503 });
    });

  it("answers with this app's tiles, a ramp legend for the view and the deepest point in the note", async () => {
    stubMosaic(bowl(5_000));
    const out = (await waterDepth.query(ctx(OCEAN), {})) as Extract<LayerResult, { kind: "tiles" }>;
    expect(out.kind).toBe("tiles");
    expect(out.data.url).toMatch(/^\/api\/water-depth\/\{z\}\/\{x\}\/\{y\}\?max=5000&step=200&deep=-141\.\d+%2C19\.\d+$/);
    expect(out.coverageNote).toMatch(
      /^Deepest point in this view: 4,9\d\d m \(16,\d{3} ft\) at 19\.\d{4}, -141\.\d{4} \(NOAA CUDEM coastal survey, about 3 m grid\); typical depth \(median of the water\) [\d,]+ m \([\d,]+ ft\); water covers \d+% of the box, sampled every \d+ m; contours every 200 m$/,
    );
    expect(out.viewNote).toMatch(/^Deepest 4,9\d\d m \(16,\d{3} ft\) at 19\.\d{4}, -141\.\d{4}; typical/);
    expect(out.legend).toMatchObject({ kind: "ramp", title: "Depth", unit: "m" });
    expect(out.legend?.stops?.map((s) => s.label)).toEqual(["0 m", "1,250 m (4,101 ft)", "2,500 m (8,202 ft)", "3,750 m (12,303 ft)", "5,000 m (16,404 ft)"]);
  });

  it("says there is no surveyed water where every value is above sea level (Lake Tahoe's flat surface)", async () => {
    stubMosaic(async (url) => {
      const [w, h] = sizeOf(url);
      return encodeBsq(Array(w * h).fill(1897));
    });
    const out = (await waterDepth.query(ctx([-120.16, 38.93, -119.93, 39.25]), {})) as Extract<LayerResult, { kind: "tiles" }>;
    expect(out.coverageNote).toMatch(/^No water with a surveyed depth in this box: .*Lake Tahoe and Crater Lake.*use lakes$/);
    expect(out.viewNote).toBe("No surveyed water depth in this view");
    expect(out.sourceStatus).toBeUndefined();
  });

  it("says plainly when the mosaic does not answer", async () => {
    stubMosaic(async () => null);
    const out = (await waterDepth.query(ctx(OCEAN), {})) as Extract<LayerResult, { kind: "tiles" }>;
    expect(out.sourceStatus).toMatchObject({ ok: false, reason: "offline" });
    expect(out.coverageNote).toMatch(/did not answer/);
  });

  it("gives the depth and its survey at a tapped point, and nothing on land or a lake without a survey", async () => {
    const water = await waterDepth.identify?.(ctx(ELLIOTT), { lon: -122.37, lat: 47.6 }, {});
    expect(water && "properties" in water ? water.properties : water).toEqual({
      name: "267 ft (81 m) deep",
      depthM: 81.5,
      depthText: "267 ft (81 m)",
      source: "NOAA CUDEM coastal survey, about 3 m grid",
    });
    expect(await waterDepth.identify?.(ctx(ELLIOTT, samplesFetch(tahoeSamples)), { lon: -120.04, lat: 39.09 }, {})).toBeNull();
    expect(await waterDepth.identify?.(ctx(ELLIOTT, samplesFetch({ samples: [] })), { lon: -120.04, lat: 39.09 }, {})).toMatchObject({ hint: "upstream" });
  });

  it("words depths, notes and tile URLs in the view's units", () => {
    expect(depthText(285.4, true)).toBe("936 ft (285 m)");
    expect(depthText(285.4, false)).toBe("285 m (936 ft)");
    expect(depthTileUrl(289.56, 15.24, { lon: -122.46358, lat: 47.66323 })).toBe("/api/water-depth/{z}/{x}/{y}?max=289.6&step=15.24&deep=-122.46358%2C47.66323");
    const note = depthNotes({ spacingM: 63, waterShare: 0.18, deepest: { depthM: 62, lon: -122.2779, lat: 47.6146 }, medianM: 32, maskedInland: 0 }, true, "50 ft", { inLake: true });
    expect(note.coverageNote).toContain("the deepest point is in a lake: depths are below sea level");
    expect(depthLegend(290, true, "50 ft").note).toContain("contour lines every 50 ft");
  });

  it("declares a clean contract: no time, a ramp legend, global water coverage and an identify", () => {
    expect(contractProblems(waterDepth)).toEqual([]);
    expect(timeShapeOf(waterDepth)).toEqual({ shape: "none" });
    expect(legendOf(waterDepth).kind).toBe("ramp");
    expect(waterDepth.surface).toBe("water");
    expect(waterDepth.requiredEnv).toEqual([]);
    expect(typeof waterDepth.identify).toBe("function");
    expect(waterDepth.description).toMatch(/how deep is the water here/);
  });
});
