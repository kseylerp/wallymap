import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import { tileUrlForTime } from "@/lib/time";
import layer, { annualTileUrl, dailyTileUrl } from "./phenology";

const OHIO: [number, number, number, number] = [-84, 38, -80, 41];

function ctx(stub: ReturnType<typeof vi.fn>) {
  return { bbox: OHIO, zoom: 6, env: {}, fetch: stub as unknown as CachedFetch };
}

async function tiles(input: Record<string, unknown>) {
  const stub = vi.fn();
  const r = await layer.query(ctx(stub), layer.input.parse(input));
  expect(stub).not.toHaveBeenCalled();
  if (!("kind" in r) || r.kind !== "tiles") throw new Error(`expected tiles, got ${JSON.stringify(r)}`);
  return r;
}

describe("phenology layer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T01:30:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("declares US coverage, no env and no area cap", () => {
    expect(layer.id).toBe("phenology");
    expect(layer.coverage).toBe("us");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
  });

  it("defaults to the leaf anomaly 31 days back on the NPN WMS", async () => {
    const r = await tiles({});
    expect(r.data.url).toBe(
      "https://geoserver.usanpn.org/geoserver/wms?service=WMS&version=1.3.0&request=GetMap&layers=si-x:leaf_anomaly&styles=&format=image/png&transparent=true&crs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}&time=2026-09-08",
    );
    expect(r.data).toMatchObject({ minzoom: 0, format: "raster" });
    expect(r.coverageNote).toContain("First leaf");
    expect(r.coverageNote).toContain("2026-09-08");
    expect(r.coverageNote).toContain("lower 48");
  });

  it("publishes a daily time block for the current year and the scrubber fills it", async () => {
    const r = await tiles({ stage: "bloom" });
    expect(r.data.url).toContain("layers=si-x:bloom_anomaly&");
    expect(r.data.time).toEqual({ template: dailyTileUrl("bloom", "{date}"), cadence: "daily", from: "2026-01-01", daysBack: 31 });
    expect(tileUrlForTime(r.data.url, r.data.time, ["2026-01-01", "2026-04-15T00:00:00Z"], Date.now())).toContain("&time=2026-04-15");
    expect(tileUrlForTime(r.data.url, r.data.time, ["2026-01-01", "2026-10-09T00:00:00Z"], Date.now())).toContain("&time=2026-09-08");
  });

  it("clamps a date past the newest day and rejects one before this year", async () => {
    const r = await tiles({ date: "2026-10-01" });
    expect(r.data.url).toContain("&time=2026-09-08");
    expect(r.coverageNote).toContain("showing 2026-09-08");
    expect(await layer.query(ctx(vi.fn()), { stage: "leaf", date: "2025-12-31" })).toMatchObject({ error: expect.stringContaining("2026-01-01") });
  });

  it("year picks the annual PRISM anomaly with a yearly {year} template", async () => {
    const r = await tiles({ stage: "leaf", year: 2012 });
    expect(r.data.url).toContain("layers=si-x:leaf_anomaly_prism&");
    expect(r.data.url).toContain("&time=2012-01-01");
    expect(r.data.time).toEqual({ template: annualTileUrl("leaf", "{year}"), cadence: "yearly", from: "1981", to: "2024" });
    expect(r.coverageNote).toContain("2012");
    expect(tileUrlForTime(r.data.url, r.data.time, ["1981-01-01", "1999-06-01T00:00:00Z"], Date.now())).toContain("&time=1999-01-01");
    expect(tileUrlForTime(r.data.url, r.data.time, ["1981-01-01", "2030-06-01T00:00:00Z"], Date.now())).toContain("&time=2024-01-01");
  });

  it("clamps a year after 2024 and rejects one before 1981 or combined with a date", async () => {
    const r = await tiles({ year: 2026 });
    expect(r.data.url).toContain("&time=2024-01-01");
    expect(r.coverageNote).toContain("not published yet");
    expect(await layer.query(ctx(vi.fn()), { stage: "leaf", year: 1970 })).toMatchObject({ error: expect.stringContaining("1981") });
    expect(await layer.query(ctx(vi.fn()), { stage: "leaf", year: 2010, date: "2026-03-01" })).toMatchObject({ error: expect.stringContaining("not both") });
  });

  it("rejects an unknown stage or date format at the input schema", () => {
    expect(layer.input.safeParse({ stage: "frost" }).success).toBe(false);
    expect(layer.input.safeParse({ date: "April 1" }).success).toBe(false);
  });

  it("tells the model the cadence, the legend, the US-only caveat and the user's words", () => {
    for (const word of ["spring arrived", "30-year average", "lower 48", "1981 to 2024", "leaf", "bloom", "compare"]) {
      expect(layer.description).toContain(word);
    }
  });

  it("summarizes to the tile URL and time range for the model", async () => {
    expect(summarizeLayerResult(await layer.query(ctx(vi.fn()), { stage: "leaf" }))).toMatchObject({
      kind: "tiles",
      time: { cadence: "daily", from: "2026-01-01", daysBack: 31 },
    });
  });

  it("runs through runLayer", async () => {
    expect((await runLayer("phenology", { bbox: OHIO, zoom: 6 })).status).toBe(200);
    expect((await runLayer("phenology", { bbox: OHIO, input: { stage: "x" } })).status).toBe(400);
  });
});
