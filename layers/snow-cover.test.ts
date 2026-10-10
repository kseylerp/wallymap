import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import { tileUrlForTime } from "@/lib/time";
import layer, { nohrscDepthTileUrl } from "./snow-cover";

const TAHOE: [number, number, number, number] = [-120.2, 38.85, -120, 39];

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
  });
  afterEach(() => vi.useRealTimers());

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
});
