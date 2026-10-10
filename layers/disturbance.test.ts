import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import { tileUrlForTime } from "@/lib/time";
import layer from "./disturbance";

const RONDONIA: [number, number, number, number] = [-63.5, -10.5, -62.5, -9.5];

function ctx(stub: ReturnType<typeof vi.fn>) {
  return { bbox: RONDONIA, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch };
}

async function tiles(input: Record<string, unknown>) {
  const stub = vi.fn();
  const r = await layer.query(ctx(stub), layer.input.parse(input));
  expect(stub).not.toHaveBeenCalled();
  if (!("kind" in r) || r.kind !== "tiles") throw new Error(`expected tiles, got ${JSON.stringify(r)}`);
  return r;
}

describe("disturbance layer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T01:30:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("declares global coverage, no env and no area cap", () => {
    expect(layer.id).toBe("disturbance");
    expect(layer.coverage).toBe("global");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
  });

  it("defaults to 3 days back on the OPERA color index at zoom 0 to 12", async () => {
    const r = await tiles({});
    expect(r.data.url).toBe(
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/OPERA_L3_DIST-ALERT-HLS_Color_Index/default/2026-10-06/GoogleMapsCompatible_Level12/{z}/{y}/{x}.png",
    );
    expect(r.data).toMatchObject({ minzoom: 0, maxzoom: 12, format: "raster" });
    expect(r.coverageNote).toBe("Vegetation disturbance alerts for 2026-10-06");
  });

  it("publishes the time block and the scrubber clamps to it", async () => {
    const r = await tiles({});
    expect(r.data.time).toEqual({
      template: expect.stringContaining("/default/{date}/GoogleMapsCompatible_Level12/{z}/{y}/{x}.png"),
      cadence: "daily",
      from: "2023-01-01",
      daysBack: 3,
    });
    expect(tileUrlForTime(r.data.url, r.data.time, ["2020-01-01", "2024-08-20T00:00:00Z"], Date.now())).toContain("/default/2024-08-20/");
    expect(tileUrlForTime(r.data.url, r.data.time, ["2020-01-01", "2022-01-01T00:00:00Z"], Date.now())).toContain("/default/2023-01-01/");
  });

  it("clamps a too-new date and rejects one before 2023", async () => {
    const r = await tiles({ date: "2026-10-09" });
    expect(r.data.url).toContain("/default/2026-10-06/");
    expect(r.coverageNote).toContain("showing 2026-10-06");
    expect(await layer.query(ctx(vi.fn()), { date: "2022-12-31" })).toMatchObject({ error: expect.stringContaining("2023-01-01") });
    expect(await layer.query(ctx(vi.fn()), { date: "2026-13-01" })).toMatchObject({ error: expect.stringContaining("not a real date") });
  });

  it("rejects a malformed date at the input schema", () => {
    expect(layer.input.safeParse({ date: "10/05/2026" }).success).toBe(false);
  });

  it("tells the model the cadence, what an alert means and the user's words", () => {
    for (const word of ["daily", "30 m", "forest-loss", "burn-severity", "does not prove deforestation", "new clearing"]) {
      expect(layer.description).toContain(word);
    }
  });

  it("summarizes to the tile URL and time range for the model", async () => {
    expect(summarizeLayerResult(await layer.query(ctx(vi.fn()), {}))).toMatchObject({
      kind: "tiles",
      time: { cadence: "daily", from: "2023-01-01", daysBack: 3 },
    });
  });

  it("runs through runLayer", async () => {
    expect((await runLayer("disturbance", { bbox: RONDONIA, zoom: 9 })).status).toBe(200);
    expect((await runLayer("disturbance", { bbox: RONDONIA, input: { date: "x" } })).status).toBe(400);
  });
});
