import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import { tileUrlForTime } from "@/lib/time";
import layer from "./flood-extent";

const MEMPHIS: [number, number, number, number] = [-90.3, 34.9, -89.8, 35.3];

function ctx(stub: ReturnType<typeof vi.fn>) {
  return { bbox: MEMPHIS, zoom: 10, env: {}, fetch: stub as unknown as CachedFetch };
}

async function tiles(input: Record<string, unknown>) {
  const stub = vi.fn();
  const r = await layer.query(ctx(stub), layer.input.parse(input));
  expect(stub).not.toHaveBeenCalled();
  if (!("kind" in r) || r.kind !== "tiles") throw new Error(`expected tiles, got ${JSON.stringify(r)}`);
  return r;
}

describe("flood-extent layer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T01:30:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("declares global coverage, no env and no area cap", () => {
    expect(layer.id).toBe("flood-extent");
    expect(layer.coverage).toBe("global");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
  });

  it("defaults to OPERA DSWx 3 days back at zoom 0 to 12", async () => {
    const r = await tiles({});
    expect(r.data.url).toBe(
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/OPERA_L3_Dynamic_Surface_Water_Extent-HLS/default/2026-10-06/GoogleMapsCompatible_Level12/{z}/{y}/{x}.png",
    );
    expect(r.data).toMatchObject({ minzoom: 0, maxzoom: 12, format: "raster" });
    expect(r.data.time).toEqual({
      template: expect.stringContaining("/default/{date}/GoogleMapsCompatible_Level12/"),
      cadence: "daily",
      from: "2023-01-01",
      daysBack: 3,
    });
  });

  it("source modis uses the 1-day flood product at level 9, 1 day back", async () => {
    const r = await tiles({ source: "modis" });
    expect(r.data.url).toBe(
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Combined_Flood_1-Day/default/2026-10-08/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png",
    );
    expect(r.data.maxzoom).toBe(9);
    expect(r.data.time).toMatchObject({ from: "2021-01-01", daysBack: 1 });
  });

  it("clamps a date past the newest day and rejects a date before the archive", async () => {
    const r = await tiles({ date: "2026-10-09" });
    expect(r.data.url).toContain("/default/2026-10-06/");
    expect(r.coverageNote).toContain("showing 2026-10-06");
    expect(await layer.query(ctx(vi.fn()), { source: "opera", date: "2022-12-31" })).toMatchObject({ error: expect.stringContaining("2023-01-01") });
    expect(await layer.query(ctx(vi.fn()), { source: "modis", date: "2020-12-31" })).toMatchObject({ error: expect.stringContaining("2021-01-01") });
  });

  it("the scrubber moves the date and holds a window ending today 3 days back", async () => {
    const r = await tiles({});
    expect(tileUrlForTime(r.data.url, r.data.time, ["2025-01-01", "2025-05-17T00:00:00Z"], Date.now())).toContain("/default/2025-05-17/");
    expect(tileUrlForTime(r.data.url, r.data.time, ["2025-01-01", "2026-10-09T00:00:00Z"], Date.now())).toContain("/default/2026-10-06/");
  });

  it("rejects an unknown source or date format", () => {
    expect(layer.input.safeParse({ source: "sentinel" }).success).toBe(false);
    expect(layer.input.safeParse({ date: "yesterday" }).success).toBe(false);
  });

  it("tells the model the cadence, the legend meaning, caveats and the user's words", () => {
    for (const word of ["opera", "modis", "daily", "flooded", "flood extent", "cloud", "surface-water"]) {
      expect(layer.description).toContain(word);
    }
  });

  it("summarizes to the tile URL and time range for the model", async () => {
    expect(summarizeLayerResult(await layer.query(ctx(vi.fn()), { source: "opera" }))).toMatchObject({
      kind: "tiles",
      time: { cadence: "daily", from: "2023-01-01", daysBack: 3 },
    });
  });

  it("runs through runLayer", async () => {
    expect((await runLayer("flood-extent", { bbox: MEMPHIS, zoom: 10 })).status).toBe(200);
    expect((await runLayer("flood-extent", { bbox: MEMPHIS, input: { source: "x" } })).status).toBe(400);
  });
});
