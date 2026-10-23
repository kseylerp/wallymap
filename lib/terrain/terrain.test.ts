import { afterEach, describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import type { Feature } from "geojson";
import type { LayerResult } from "@/layers/types";
import { decodePng, encodePng } from "./png";
import { decodeTerrarium, Dem, latToY, loadDem, lonToX, metresPerPixel, terrariumElevation, tileRange, useTileSource, yToLat, xToLon } from "./dem";
import {
  compass4,
  compass8,
  declination,
  gainLoss,
  hornSlopeAspect,
  incidence,
  profileOf,
  resample,
  shadedThrough,
  slopeAspectAt,
  slopeClass,
  sunPath,
  sunPosition,
} from "./analysis";
import { areaStats, renderTile, SLOPE_COLORS, FACE_COLORS } from "./view";
import { enrichWithTerrain, withTerrainFields } from "./enrich";
import { plane, syntheticTiles } from "./__fixtures__/synthetic";
import { haversineM } from "@/lib/spatial/geo";

afterEach(() => useTileSource());

describe("PNG", () => {
  it("round-trips RGBA through the encoder and decoder", () => {
    const data = new Uint8Array(4 * 4 * 4).map((_, i) => (i * 37) % 256);
    const back = decodePng(encodePng({ width: 4, height: 4, data }));
    expect(back.width).toBe(4);
    expect([...back.data]).toEqual([...data]);
  });

  it("reads an RGB image with every row filter (none, sub, up, average, paeth)", () => {
    // 2x5 RGB; each row uses a different filter over the same intended pixels.
    const want = [
      [10, 20, 30, 40, 50, 60],
      [12, 22, 32, 42, 52, 62],
      [200, 100, 50, 210, 110, 60],
      [5, 5, 5, 250, 250, 250],
      [7, 8, 9, 9, 8, 7],
    ];
    const rows: number[][] = [];
    const paeth = (a: number, b: number, c: number) => {
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    want.forEach((row, y) => {
      const filter = y;
      const prev = y > 0 ? want[y - 1] : [0, 0, 0, 0, 0, 0];
      const out = row.map((v, x) => {
        const a = x >= 3 ? row[x - 3] : 0;
        const b = prev[x];
        const c = x >= 3 ? prev[x - 3] : 0;
        const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
        return (v - pred + 256) & 255;
      });
      rows.push([filter, ...out]);
    });
    const header = Buffer.alloc(13);
    header.writeUInt32BE(2, 0);
    header.writeUInt32BE(5, 4);
    header[8] = 8;
    header[9] = 2;
    const chunk = (type: string, body: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length);
      return Buffer.concat([len, Buffer.from(type, "latin1"), body, Buffer.alloc(4)]);
    };
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.from(rows.flat()))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    const img = decodePng(png);
    const rgb = [...img.data].filter((_, i) => i % 4 !== 3);
    expect(rgb).toEqual(want.flat());
  });

  it("decodes Terrarium elevations: R*256 + G + B/256 - 32768", () => {
    expect(terrariumElevation(128, 0, 0)).toBe(0);
    expect(terrariumElevation(132, 27, 128)).toBe(1051.5);
    const data = new Uint8Array(256 * 256 * 4);
    for (let i = 0; i < 256 * 256; i++) data.set([132, 27, 128, 255], i * 4);
    const tile = decodeTerrarium(encodePng({ width: 256, height: 256, data }), 12, 1, 2);
    expect(tile.elev[0]).toBe(1051.5);
    expect(tile.elev[65_535]).toBe(1051.5);
  });
});

describe("tile math", () => {
  it("round-trips lon and lat through tile coordinates", () => {
    expect(xToLon(lonToX(-110.9, 12), 12)).toBeCloseTo(-110.9, 9);
    expect(yToLat(latToY(43.5, 12), 12)).toBeCloseTo(43.5, 9);
    expect(metresPerPixel(0, 0)).toBeCloseTo(156_543, 0);
    const [x0, y0, x1, y1] = tileRange([-111, 43.4, -110.8, 43.6], 12);
    expect(x1 - x0 + 1).toBe(3);
    expect(y1 - y0 + 1).toBe(4);
  });

  it("lowers the zoom until the box fits the tile budget", async () => {
    const source = syntheticTiles(() => 100);
    const dem = await loadDem([-112, 43, -110, 45], { zoom: 12, maxTiles: 16, source });
    expect(dem.z).toBeLessThan(12);
    expect(source.asked.length).toBeLessThanOrEqual(25); // the budget plus a margin row and column
    expect(dem.at(-111, 44)).toBe(100);
    expect(Number.isNaN(new Dem(12, []).at(-111, 44))).toBe(true);
  });
});

describe("slope, aspect and the sun", () => {
  it("Horn's method on a window: slope and the downhill direction", () => {
    // Rising 10 m per 10 m to the east: 45°, facing west.
    const east = hornSlopeAspect([0, 10, 20, 0, 10, 20, 0, 10, 20], 10);
    expect(east.slope).toBeCloseTo(45, 5);
    expect(east.aspect).toBeCloseTo(270, 5);
    // Rising to the north: faces south.
    expect(hornSlopeAspect([20, 20, 20, 10, 10, 10, 0, 0, 0], 10).aspect).toBeCloseTo(180, 5);
    expect(Number.isNaN(hornSlopeAspect([5, 5, 5, 5, 5, 5, 5, 5, 5], 10).aspect)).toBe(true);
    expect([compass8(0), compass8(44), compass8(46), compass8(350), compass4(100), compass4(NaN)]).toEqual(["N", "NE", "NE", "N", "E", "Flat"]);
  });

  it("reads a 38° plane facing west as 38° and west, at a point and over 100 m", async () => {
    const dem = await loadDem([-110.95, 43.45, -110.9, 43.5], { zoom: 13, source: syntheticTiles(plane(38, 90)) });
    const at = slopeAspectAt(dem, -110.92, 43.47)!;
    expect(at.slope).toBeCloseTo(38, 0);
    expect(at.aspect).toBeCloseTo(270, 0);
    expect(slopeAspectAt(dem, -110.92, 43.47, 50)!.slope).toBeCloseTo(38, 0);
    expect(SLOPE_COLORS[slopeClass(at.slope)]).toEqual(SLOPE_COLORS[3]);
    expect([slopeClass(10), slopeClass(27), slopeClass(31), slopeClass(50)]).toEqual([0, 1, 2, 4]);
  });

  it("puts the sun due south at solar noon and south-west in the afternoon", () => {
    const oct23 = new Date("2026-10-23T12:00:00Z");
    expect(declination(oct23)).toBeCloseTo(-11.6, 0);
    const noon = sunPosition(38.6, declination(oct23), 0);
    expect(noon.azimuth).toBeCloseTo(180, 5);
    expect(noon.altitude).toBeCloseTo(90 - 38.6 - 11.6, 0);
    const three = sunPosition(38.6, declination(oct23), 45);
    expect(three.azimuth).toBeGreaterThan(215);
    expect(three.azimuth).toBeLessThan(240);
    expect(sunPath(38.6, oct23, "afternoon").length).toBe(9);
  });

  it("finds north and east walls in shade through an autumn afternoon in Moab, and south and west walls in sun", () => {
    const path = sunPath(38.6, new Date("2026-10-23T12:00:00Z"), "afternoon");
    expect(shadedThrough(90, 0, path)).toBe(true);
    expect(shadedThrough(90, 45, path)).toBe(true);
    expect(shadedThrough(90, 90, path)).toBe(true);
    expect(shadedThrough(90, 180, path)).toBe(false);
    expect(shadedThrough(90, 260, path)).toBe(false);
    // Flat ground faces the sky: lit whenever the sun is up.
    expect(incidence(0, NaN, path[0])).toBeGreaterThan(0);
  });
});

describe("along a line", () => {
  it("resamples a path at a fixed step, ends included", () => {
    const pts = resample([[0, 0], [0, 0.01]], 100);
    expect(pts.length).toBe(13);
    expect(haversineM(pts[0], pts[1])).toBeCloseTo(100, 0);
    expect(pts[pts.length - 1]).toEqual([0, 0.01]);
  });

  it("counts climb past a 3 m threshold so noise on the flat adds nothing", () => {
    expect(gainLoss([100, 101, 99, 100, 110, 120, 115, 130])).toEqual({ gain: 35, loss: 5 });
    expect(gainLoss([100, 102, 99, 101, 98, 100, 101])).toEqual({ gain: 0, loss: 0 });
  });

  it("measures the climb of a trail up a 10° slope and the steepest ground it crosses", async () => {
    const source = syntheticTiles(plane(10, 0));
    const dem = await loadDem([-110.95, 43.45, -110.9, 43.5], { zoom: 13, source });
    const north1km = 1000 / 111_195;
    const profile = profileOf(dem, [[[-110.92, 43.46], [-110.92, 43.46 + north1km]]], { slope: true })!;
    expect(profile.gainM).toBeGreaterThan(170);
    expect(profile.gainM).toBeLessThan(180);
    expect(profile.lossM).toBe(0);
    expect(profile.maxSlopeDeg).toBe(10);
    expect(profile.maxM - profile.minM).toBeCloseTo(176, -1);
  });
});

describe("the terrain view", () => {
  it("draws a 38° plane in the avalanche band, and nothing on a 20° plane", async () => {
    const z = 12;
    const x = Math.floor(lonToX(-110.92, z));
    const y = Math.floor(latToY(43.47, z));
    const steep = await renderTile(z, x, y, { mode: "slope" }, syntheticTiles(plane(38, 90)));
    expect([...steep.slice(0, 4)]).toEqual(SLOPE_COLORS[3]);
    expect([...steep.slice(-4)]).toEqual(SLOPE_COLORS[3]);
    const gentle = await renderTile(z, x, y, { mode: "slope" }, syntheticTiles(plane(20, 90)));
    expect(gentle.every((v) => v === 0)).toBe(true);
    const aspect = await renderTile(z, x, y, { mode: "aspect" }, syntheticTiles(plane(38, 90)));
    expect([...aspect.slice(0, 4)]).toEqual(FACE_COLORS.W);
    const onlyNorth = await renderTile(z, x, y, { mode: "aspect", faces: ["N"] }, syntheticTiles(plane(38, 90)));
    expect(onlyNorth.every((v) => v === 0)).toBe(true);
  });

  it("counts a box by class for the note", async () => {
    const stats = (await areaStats([-110.95, 43.45, -110.9, 43.5], { mode: "slope" }, syntheticTiles(plane(32, 0))))!;
    expect(stats.shares["30 to 35°"]).toBe(1);
    expect(stats.steepestDeg).toBe(32);
    expect(stats.areaKm2).toBeGreaterThan(20);
    const shade = (await areaStats([-110.95, 43.45, -110.9, 43.5], { mode: "shade", date: "2026-12-21" }, syntheticTiles(plane(40, 180))))!;
    // Rising to the south, the ground faces north: in its own shade all winter afternoon.
    expect(shade.shares["In shade"]).toBe(1);
    expect(shade.sunAzimuths![0]).toBeGreaterThan(180);
  });
});

describe("terrain on layer cards", () => {
  const point = (lon: number, lat: number, name: string): Feature => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { name } });
  const answer = (features: Feature[]): LayerResult => ({
    kind: "geojson",
    data: { type: "FeatureCollection", features },
    citation: { source: "OpenBeta", url: "https://openbeta.io", retrieved: "2026-10-23" },
  });
  const now = new Date("2026-10-23T18:00:00Z");

  it("gives crags their aspect and afternoon shade: an east face is shaded, a west face is not", async () => {
    const eastFace = await enrichWithTerrain("climbing", answer([point(-109.6, 38.6, "Wall Street")]), { source: syntheticTiles(plane(30, 270, [-109.6, 38.6])), now });
    const p = (eastFace as Extract<LayerResult, { kind: "geojson" }>).data.features[0].properties!;
    expect(p).toMatchObject({ name: "Wall Street", aspect: "E", afternoonShade: true, slopeDeg: 30 });
    const westFace = await enrichWithTerrain("climbing", answer([point(-109.6, 38.6, "Ice Cream Parlor")]), { source: syntheticTiles(plane(30, 90, [-109.6, 38.6])), now });
    expect((westFace as Extract<LayerResult, { kind: "geojson" }>).data.features[0].properties).toMatchObject({ aspect: "W", afternoonShade: false });
    expect((westFace as Extract<LayerResult, { kind: "geojson" }>).coverageNote).toMatch(/Aspect, slope and afternoon shade for 1 of 1 from AWS Terrain Tiles/);
  });

  it("gives trails their climb and ski routes their steepest ground", async () => {
    const line: Feature = { type: "Feature", geometry: { type: "LineString", coordinates: [[-110.92, 43.46], [-110.92, 43.47]] }, properties: { name: "Up" } };
    const trail = (await enrichWithTerrain("osm-trails", answer([line]), { source: syntheticTiles(plane(10, 0)) })) as Extract<LayerResult, { kind: "geojson" }>;
    expect(trail.data.features[0].properties?.gainM).toBeGreaterThan(190);
    expect(trail.data.features[0].properties?.maxSlopeDeg).toBeUndefined();
    const ski = (await enrichWithTerrain("ski-routes", answer([line]), { source: syntheticTiles(plane(33, 0)) })) as Extract<LayerResult, { kind: "geojson" }>;
    expect(ski.data.features[0].properties?.maxSlopeDeg).toBe(33);
  });

  it("leaves other layers, errors and empty answers alone, and says so when tiles fail", async () => {
    const plain = answer([point(0, 0, "x")]);
    expect(await enrichWithTerrain("dams", plain)).toBe(plain);
    expect(await enrichWithTerrain("climbing", { error: "down" })).toEqual({ error: "down" });
    const failed = await enrichWithTerrain("climbing", plain, { source: async () => null });
    expect((failed as Extract<LayerResult, { kind: "geojson" }>).coverageNote).toMatch(/terrain tiles did not answer/);
    const slow = await enrichWithTerrain("climbing", plain, { source: () => new Promise(() => {}), budgetMs: 20 });
    expect((slow as Extract<LayerResult, { kind: "geojson" }>).coverageNote).toMatch(/too slow/);
  });

  it("adds the card facts and attributes without displacing a layer's own primary measure", () => {
    const base = {
      id: "climbing",
      title: "Climbing",
      description: "Crags.",
      card: { facts: [{ key: "routes", label: "Routes" }] },
      attributes: [{ key: "disciplines", type: "category" as const, label: "Discipline" }],
    };
    const crag = withTerrainFields(base as never) as typeof base & { fieldHelp: Record<string, unknown> };
    expect(crag.card.facts.map((f) => f.key)).toEqual(["routes", "aspect", "slopeDeg", "afternoonShade"]);
    expect(crag.attributes.map((a) => a.key)).toEqual(["disciplines", "afternoonShade", "aspect"]);
    expect(crag.fieldHelp.aspect).toBeDefined();
    const trails = withTerrainFields({ ...base, id: "osm-trails", attributes: [] } as never) as typeof base;
    expect(trails.attributes.map((a) => a.key)).toEqual([]);
    const scored = withTerrainFields({ ...base, id: "popularity", attributes: [{ key: "v", type: "measure", label: "Score" }] } as never) as typeof base;
    expect(scored.attributes.map((a) => a.key)).toEqual(["v", "gainM"]);
    expect(withTerrainFields(base as never)).not.toBe(base);
    const other = { ...base, id: "dams" };
    expect(withTerrainFields(other as never)).toBe(other);
  });
});
