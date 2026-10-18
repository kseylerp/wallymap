import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import { tileUrlForTime } from "@/lib/time";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { legendOf, legendProblems } from "./contract";
import layer, { DEPTH_LEGEND, NDSI_LEGEND, nohrscDepthTileUrl } from "./snow-cover";
import { CLOUD_INDEX, clearSnowProbeMemo, decodePalettePng, lookbackDays, probeTiles, snowPixels } from "./snow-cover-probe";

const TAHOE: [number, number, number, number] = [-120.2, 38.85, -120, 39];

/** A 256 x 256 8-bit palette PNG whose pixel (x, y) holds `fill(x, y)` (filter 0 rows; CRCs are not checked). */
function palettePng(fill: (x: number, y: number) => number): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set(Buffer.from(type, "ascii"), 4);
    out.set(data, 8);
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 256);
  new DataView(ihdr.buffer).setUint32(4, 256);
  ihdr.set([8, 3, 0, 0, 0], 8);
  const raw = new Uint8Array(257 * 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) raw[y * 257 + 1 + x] = fill(x, y);
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  return Buffer.concat(parts);
}
const SNOW_TILE = palettePng(() => 60);
const BARE_TILE = palettePng(() => 0);

/** Serves GIBS NDSI tiles: snow on the days in `snowDays` (all days when omitted), bare ground otherwise. */
function gibs(snowDays?: string[]) {
  return vi.fn(async (url: string) => {
    const day = /\/default\/(\d{4}-\d{2}-\d{2})\//.exec(url)?.[1] ?? "";
    const snow = snowDays === undefined || snowDays.includes(day);
    return new Response(Buffer.from(snow ? SNOW_TILE : BARE_TILE), { status: 200, headers: { "content-type": "image/png" } });
  });
}

function ctx(stub: ReturnType<typeof vi.fn>) {
  return { bbox: TAHOE, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch };
}

async function tiles(input: Record<string, unknown>) {
  const stub = vi.fn();
  const r = await layer.query(ctx(stub), layer.input.parse(input));
  expect(stub).not.toHaveBeenCalled();
  if (!("kind" in r) || r.kind !== "tiles") throw new Error(`expected tiles, got ${JSON.stringify(r)}`);
  return r;
}

describe("snow-cover layer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T01:30:00Z"));
    clearSnowProbeMemo();
    // The snow probe reads GIBS tiles with the platform fetch; by default every day has snow in view.
    vi.stubGlobal("fetch", gibs());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("declares global coverage, no env and no area cap", () => {
    expect(layer.id).toBe("snow-cover");
    expect(layer.coverage).toBe("global");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
  });

  it("defaults to the MODIS day before today at zoom 0 to 8", async () => {
    const r = await tiles({});
    expect(r.data.url).toBe(
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_NDSI_Snow_Cover/default/2026-10-08/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png",
    );
    expect(r.data).toMatchObject({ minzoom: 0, maxzoom: 8, format: "raster" });
    expect(r.coverageNote).toBe("Snow cover for 2026-10-08");
  });

  it("publishes a daily time block from 2000-02-24 and the scrubber fills it", async () => {
    const r = await tiles({});
    expect(r.data.time).toEqual({
      template: expect.stringContaining("/default/{date}/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png"),
      cadence: "daily",
      from: "2000-02-24",
      daysBack: 1,
    });
    expect(tileUrlForTime(r.data.url, r.data.time, ["2020-01-01", "2024-02-10T00:00:00Z"], Date.now())).toContain("/default/2024-02-10/");
  });

  it("clamps today to yesterday and rejects a day before MODIS", async () => {
    const r = await tiles({ date: "2026-10-09" });
    expect(r.data.url).toContain("/default/2026-10-08/");
    expect(r.coverageNote).toContain("showing 2026-10-08");
    expect(await layer.query(ctx(vi.fn()), { depth: false, date: "2000-02-23" })).toMatchObject({ error: expect.stringContaining("2000-02-24") });
  });

  it("depth: true switches to the NOHRSC export, with no time block", async () => {
    const r = await tiles({ depth: true });
    expect(r.data.url).toBe(nohrscDepthTileUrl());
    expect(r.data.url).toContain("NOHRSC_Snow_Analysis/MapServer/export?bbox={bbox-epsg-3857}");
    expect(r.data.url).toContain("layers=show:0");
    expect(r.data.time).toBeUndefined();
    expect(r.coverageNote).toMatch(/lower 48/);
    expect(r.citation.source).toMatch(/NOHRSC/);
    expect(legendOf(layer, r)).toBe(DEPTH_LEGEND);
    expect(legendProblems(DEPTH_LEGEND, "depth")).toEqual([]);
  });

  it("the daily key describes only the NDSI snow classes it draws", () => {
    expect(NDSI_LEGEND.note).not.toMatch(/depth|inch|\bin\b/i);
    expect(NDSI_LEGEND.items?.every((i) => /snow/i.test(i.label))).toBe(true);
  });

  it("depth: true with a date is an error that says why", async () => {
    expect(await layer.query(ctx(vi.fn()), { depth: true, date: "2026-01-05" })).toMatchObject({ error: expect.stringContaining("only the latest") });
  });

  it("rejects a malformed date at the input schema", () => {
    expect(layer.input.safeParse({ date: "Jan 5" }).success).toBe(false);
    expect(layer.input.safeParse({ depth: "yes" }).success).toBe(false);
  });

  it("tells the model the cadence, the depth option, the caveats and the user's words", () => {
    expect(layer.description).toMatch(/daily/);
    expect(layer.description).toMatch(/depth/);
    expect(layer.description).toMatch(/cloud/);
    expect(layer.description).toContain("snow cover");
    expect(layer.description).toMatch(/lower 48/);
  });

  it("summarizes to the tile URL for the model", async () => {
    expect(summarizeLayerResult(await layer.query(ctx(vi.fn()), { depth: false }))).toMatchObject({
      kind: "tiles",
      format: "raster",
      time: { cadence: "daily", from: "2000-02-24" },
    });
  });

  it("runs through runLayer and rejects a bad date", async () => {
    expect((await runLayer("snow-cover", { bbox: TAHOE, zoom: 9 })).status).toBe(200);
    expect((await runLayer("snow-cover", { bbox: TAHOE, input: { date: "winter" } })).status).toBe(400);
  });

  it("draws the tiles as served and names GIBS's own colors, not blue-white", () => {
    expect(layer.style.raster).toMatchObject({ saturation: 0 });
    expect(layer.style.raster).not.toHaveProperty("hueRotate");
    expect(legendOf(layer)).toBe(NDSI_LEGEND);
    expect(NDSI_LEGEND.items?.map((i) => i.color)).toEqual(["#F0F089", "#F0D289", "#F0B489", "#F09689", "#F08081"]);
    expect(layer.description).not.toMatch(/blue-white/);
    expect(layer.description).toMatch(/pale yellow/);
  });

  it("steps back from an empty newest day to the newest day with snow in the view, and says so", async () => {
    vi.stubGlobal("fetch", gibs(["2026-10-05"]));
    const r = await tiles({});
    expect(r.data.url).toContain("/default/2026-10-05/");
    expect(r.coverageNote).toBe("Snow cover for 2026-10-05, the newest day with snow in the view; none was seen on 2026-10-08 (no snow on the ground, or cloud)");
  });

  it("keeps the newest day and says no snow was seen when the whole look-back is empty", async () => {
    vi.stubGlobal("fetch", gibs([]));
    const r = await tiles({});
    expect(r.data.url).toContain("/default/2026-10-08/");
    expect(r.coverageNote).toBe("Snow cover for 2026-10-08; no snow seen in the view on any day checked from 2026-04-07 to 2026-10-08");
  });

  it("keeps the newest day with no claim when GIBS does not answer the probe", async () => {
    const down = vi.fn(async () => new Response("no", { status: 503 }));
    vi.stubGlobal("fetch", down);
    const r = await tiles({});
    expect(r.data.url).toContain("/default/2026-10-08/");
    expect(r.coverageNote).toBe("Snow cover for 2026-10-08");
    // One wave of six days, then it stops.
    expect(down.mock.calls.length).toBeLessThanOrEqual(6 * 4);
  });

  it("never moves an asked day, but says when it shows no snow", async () => {
    vi.stubGlobal("fetch", gibs([]));
    const r = await tiles({ date: "2026-03-10" });
    expect(r.data.url).toContain("/default/2026-03-10/");
    expect(r.coverageNote).toBe("Snow cover for 2026-03-10; no snow seen in the view that day (none on the ground, or hidden by cloud)");
  });

  it("looks back daily for a week, then every 3 days, then weekly to six months", () => {
    const days = lookbackDays("2026-10-17", "2000-02-24");
    expect(days.slice(0, 8)).toEqual(["2026-10-17", "2026-10-16", "2026-10-15", "2026-10-14", "2026-10-13", "2026-10-12", "2026-10-11", "2026-10-08"]);
    expect(days[days.length - 1]).toBe("2026-04-16");
    expect(lookbackDays("2000-02-26", "2000-02-24")).toEqual(["2000-02-26", "2000-02-25", "2000-02-24"]);
  });
});

describe("snow-cover probe", () => {
  it("decodes a real GIBS NDSI tile (Mount Hood, 2026-03-10, zoom 6) and finds the snow", () => {
    const bytes = new Uint8Array(readFileSync(new URL("./__fixtures__/snow-cover.hood-2026-03-10-z6.png", import.meta.url)));
    const img = decodePalettePng(bytes);
    expect(img).toMatchObject({ width: 256, height: 256 });
    expect(snowPixels(img!, [0, 0, 256, 256])).toBeGreaterThan(1_000);
    expect(decodePalettePng(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("counts snow only inside a patch and away from cloud, so cloud-edge specks are not snow", () => {
    const specks = decodePalettePng(palettePng((x, y) => (x % 3 === 0 && y % 3 === 0 ? 60 : 0)))!;
    expect(snowPixels(specks, [0, 0, 256, 256])).toBe(0);
    const patch = decodePalettePng(palettePng((x, y) => (x >= 10 && x < 20 && y >= 10 && y < 20 ? 60 : 0)))!;
    expect(snowPixels(patch, [0, 0, 256, 256])).toBe(96);
    expect(snowPixels(patch, [0, 0, 15, 15])).toBe(24);
    const clouded = decodePalettePng(palettePng((x, y) => (x >= 10 && x < 20 && y >= 10 && y < 20 ? 60 : CLOUD_INDEX)))!;
    expect(snowPixels(clouded, [0, 0, 256, 256])).toBe(64);
  });

  it("reads the view at the zoom where it spans about one tile, at most four tiles", () => {
    const hood = probeTiles([-122, 45, -121, 46]);
    expect(hood.every((t) => t.z === 8)).toBe(true);
    expect(hood.length).toBeLessThanOrEqual(4);
    expect(probeTiles([-180, -80, 180, 80]).length).toBeLessThanOrEqual(4);
  });
});
