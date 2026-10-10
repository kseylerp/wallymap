import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { compactDescription } from "@/lib/agent/tools";
import layer, { probeDays, tileFor } from "./imagery-by-date";
import probes from "./__fixtures__/hls-probe.yosemite.json";

/**
 * Recorded 2026-10-10: byte size of the zoom 9 HLS tile over Yosemite Valley (x85 y197) for each day 2026-09-24 to
 * 2026-10-08, Landsat (L30) and Sentinel-2 (S30). The stub answers each probe with a body of that length.
 */
const YOSEMITE: [number, number, number, number] = [-119.7, 37.7, -119.5, 37.8];
const NOW = new Date("2026-10-10T10:00:00Z");
const sizes = probes.bytes as Record<"L30" | "S30", Record<string, number>>;

function stub() {
  return vi.fn(async (url: string) => {
    const sensor = url.includes("HLS_L30") ? "L30" : "S30";
    const day = url.match(/\/default\/(\d{4}-\d{2}-\d{2})\//)?.[1] ?? "";
    return new Response("x".repeat(sizes[sensor][day] ?? 334), { status: 200 });
  });
}

function ctx(fetch: ReturnType<typeof vi.fn>, bbox = YOSEMITE) {
  return { bbox, zoom: 11, env: {}, fetch: fetch as unknown as CachedFetch, cacheKey: "imagery-by-date:k" };
}

async function tiles(fetch: ReturnType<typeof vi.fn>, input: Record<string, unknown>) {
  const r = await layer.query(ctx(fetch), layer.input.parse(input));
  if (!("kind" in r) || r.kind !== "tiles") throw new Error(`expected tiles, got ${JSON.stringify(r)}`);
  return r;
}

function calls(fetch: ReturnType<typeof vi.fn>) {
  return fetch.mock.calls as unknown as [string, { cacheKey: string; ttlSeconds: number; shouldCache?: unknown }][];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("probe helpers", () => {
  it("finds the zoom 9 tile at the view's centre", () => {
    expect(tileFor(-119.6, 37.75, 9)).toEqual({ x: 85, y: 197 });
  });

  it("orders days outward from the asked day, inside the archive", () => {
    expect(probeDays("2026-10-01", "2013-03-22", "2026-10-08", 5)).toEqual(["2026-10-01", "2026-09-30", "2026-10-02", "2026-09-29", "2026-10-03"]);
    expect(probeDays("2026-10-08", "2013-03-22", "2026-10-08", 4)).toEqual(["2026-10-08", "2026-10-07", "2026-10-06", "2026-10-05"]);
    expect(probeDays("2015-11-28", "2015-11-28", "2026-10-08", 3)).toEqual(["2015-11-28", "2015-11-29", "2015-11-30"]);
  });
});

describe("imagery-by-date", () => {
  it("moves a day with no pass to the nearest day that has one and says so", async () => {
    const f = stub();
    const r = await tiles(f, { date: "2026-10-01" });
    expect(r.data.url).toBe(
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/HLS_S30_Nadir_BRDF_Adjusted_Reflectance/default/2026-09-30/GoogleMapsCompatible_Level12/{z}/{y}/{x}.png",
    );
    expect(r.coverageNote).toBe("Sentinel-2 (HLS S30) true colour for 2026-09-30, the nearest day with a pass over the view to 2026-10-01");
    expect(calls(f)).toHaveLength(4);
    expect(calls(f)[0][0]).toContain("/GoogleMapsCompatible_Level12/9/197/85.png");
  });

  it("keeps an asked day that has a pass, and picks the fuller sensor on a day both pass", async () => {
    expect((await tiles(stub(), { date: "2026-09-28" })).coverageNote).toBe("Landsat 8/9 (HLS L30) true colour for 2026-09-28");
    const both = await tiles(stub(), { date: "2026-10-07" });
    expect(both.data.url).toContain("HLS_L30_");
    expect(both.data.url).toContain("/2026-10-07/");
  });

  it("defaults to two days back and searches back from there", async () => {
    const r = await tiles(stub(), {});
    expect(r.coverageNote).toContain("for 2026-10-07, the nearest day with a pass over the view to 2026-10-08");
  });

  it("limits the search to one sensor when asked", async () => {
    const f = stub();
    const r = await tiles(f, { date: "2026-10-01", sensor: "landsat" });
    expect(r.data.url).toContain("HLS_L30_");
    expect(r.data.url).toContain("/2026-09-29/");
    expect(calls(f).every(([u]) => u.includes("HLS_L30"))).toBe(true);
  });

  it("caches every probe answer, blank or not, longer for old days", async () => {
    const f = stub();
    await tiles(f, { date: "2026-10-04" });
    const [, init] = calls(f)[0];
    expect(init.cacheKey).toMatch(/^imagery-by-date:probe:(landsat|sentinel):9\/85\/197:2026-10-04$/);
    expect(init.shouldCache).toBeUndefined();
    expect(init.ttlSeconds).toBe(86_400);
    const old = stub();
    await tiles(old, { date: "2020-06-01" });
    expect(calls(old)[0][1].ttlSeconds).toBe(2_592_000);
  });

  it("falls back to the asked day with a warning after 10 blank days", async () => {
    const blank = vi.fn(async () => new Response("x".repeat(334), { status: 200 }));
    const r = await tiles(blank, { date: "2020-06-01" });
    expect(r.data.url).toContain("HLS_S30_");
    expect(r.data.url).toContain("/2020-06-01/");
    expect(r.coverageNote).toMatch(/no satellite pass found .* from 5 days before to 4 after 2020-06-01/);
    expect(blank).toHaveBeenCalledTimes(20);
  });

  it("does not count a failed probe as blank, and says which days could not be checked", async () => {
    const flaky = vi.fn(async (url: string) => {
      if (url.includes("/2026-10-01/")) return new Response("busy", { status: 503 });
      return stub()(url);
    });
    const r = await tiles(flaky, { date: "2026-10-01" });
    expect(r.data.url).toContain("/2026-09-30/");
    expect(r.coverageNote).toContain("nearer days could not be checked (2026-10-01)");

    const down = vi.fn(async () => new Response("busy", { status: 503 }));
    const none = await tiles(down, { date: "2020-06-01" });
    expect(none.coverageNote).toMatch(/not verified: the satellite check failed for 2020-06-01, /);
  });

  it("publishes a daily time template for the scrubber and compare", async () => {
    const r = await tiles(stub(), { date: "2026-09-28" });
    expect(r.data).toMatchObject({ minzoom: 5, maxzoom: 12, format: "raster" });
    expect(r.data.time).toEqual({
      template: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/HLS_L30_Nadir_BRDF_Adjusted_Reflectance/default/{date}/GoogleMapsCompatible_Level12/{z}/{y}/{x}.png",
      cadence: "daily",
      from: "2013-03-22",
      daysBack: 2,
    });
  });

  it("rejects days before the archive, clamps future days, and caps the area", async () => {
    expect(await layer.query(ctx(stub()), layer.input.parse({ date: "2012-01-01" }))).toMatchObject({ error: expect.stringContaining("2013-03-22") });
    expect(await layer.query(ctx(stub()), layer.input.parse({ date: "2015-01-01", sensor: "sentinel" }))).toMatchObject({ error: expect.stringContaining("2015-11-28") });
    const future = await tiles(stub(), { date: "2026-12-25" });
    expect(future.coverageNote).toContain("later than the newest HLS images available");
    expect((await runLayer("imagery-by-date", { bbox: [-125, 30, -110, 42] })).status).toBe(422);
  });

  it("tells the model about the nearest-day search, compare and the user's words", () => {
    for (const word of ["date", "nearest day", "compare", "before and after", "satellite image on a date", "map tiles"]) expect(layer.description).toContain(word);
    const trimmed = compactDescription(layer.description, { inputs: ["date", "sensor"] });
    expect(trimmed).toContain("compare");
    expect(trimmed).toContain("sensor is 'auto'");
  });
});
