import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import layer from "./night-lights";

const EUROPE: [number, number, number, number] = [-10, 35, 30, 60];

function ctx(stub: ReturnType<typeof vi.fn>) {
  return { bbox: EUROPE, zoom: 2, env: {}, fetch: stub as unknown as CachedFetch };
}

describe("night-lights layer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T01:30:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("declares global coverage, the GIBS license and no env", () => {
    expect(layer.id).toBe("night-lights");
    expect(layer.coverage).toBe("global");
    expect(layer.license).toBe("NASA GIBS (public)");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
  });

  it("accepts an optional YYYY-MM-DD date and rejects other formats", () => {
    expect(layer.input.parse({})).toEqual({});
    expect(layer.input.parse({ date: "2026-01-15" })).toEqual({ date: "2026-01-15" });
    expect(layer.input.safeParse({ date: "Jan 15" }).success).toBe(false);
    expect(layer.input.safeParse({ date: "2026-1-5" }).success).toBe(false);
  });

  it("defaults to 3 days ago in UTC and says so in the coverage note", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub), {});
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.data.url).toBe(
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_DayNightBand_At_Sensor_Radiance/default/2026-10-06/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png",
    );
    expect(r.data.format).toBe("raster");
    expect(r.data).toMatchObject({ minzoom: 0, maxzoom: 8 });
    expect(r.coverageNote).toBe("Night lights for 2026-10-06");
  });

  it("uses the 3 days ago default across a month boundary", async () => {
    vi.setSystemTime(new Date("2026-03-02T23:59:00Z"));
    const r = await layer.query(ctx(vi.fn()), {});
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.coverageNote).toBe("Night lights for 2026-02-27");
  });

  it("uses a supplied date", async () => {
    const r = await layer.query(ctx(vi.fn()), { date: "2025-12-24" });
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.data.url).toContain("/default/2025-12-24/GoogleMapsCompatible_Level8/");
    expect(r.coverageNote).toBe("Night lights for 2025-12-24");
  });

  it("rejects a future date, a date before the archive starts and an impossible date", async () => {
    expect(await layer.query(ctx(vi.fn()), { date: "2026-10-10" })).toMatchObject({ error: expect.stringContaining("future") });
    expect(await layer.query(ctx(vi.fn()), { date: "2020-11-17" })).toMatchObject({ error: expect.stringContaining("2020-11-18") });
    expect(await layer.query(ctx(vi.fn()), { date: "2026-02-31" })).toMatchObject({ error: expect.stringContaining("not a real date") });
  });

  it("describes what the lights are and the daily-image caveats", () => {
    expect(layer.description).toMatch(/radiance/i);
    expect(layer.description).toMatch(/cloud/i);
    expect(layer.description).toMatch(/moon/i);
    expect(layer.description).toMatch(/date/i);
  });

  it("summarizes to the tile URL and format for the model", async () => {
    const summary = summarizeLayerResult(await layer.query(ctx(vi.fn()), {}));
    expect(summary).toMatchObject({ kind: "tiles", format: "raster", url: expect.stringContaining("VIIRS_SNPP_DayNightBand_At_Sensor_Radiance") });
  });

  it("runs through runLayer and rejects a malformed date", async () => {
    expect((await runLayer("night-lights", { bbox: EUROPE, zoom: 2 })).status).toBe(200);
    expect((await runLayer("night-lights", { bbox: EUROPE, input: { date: "yesterday" } })).status).toBe(400);
  });

  it("accepts a whole-globe bbox through runLayer", async () => {
    const res = await runLayer("night-lights", { bbox: [-180, -85, 180, 85], zoom: 1 });
    expect(res.status).toBe(200);
  });
});
