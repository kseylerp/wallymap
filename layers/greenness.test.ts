import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import { tileUrlForTime } from "@/lib/time";
import { legendOf, legendProblems } from "./contract";
import layer, { compositeStart, EVI_LEGEND, NDVI_LEGEND } from "./greenness";

const ALPS: [number, number, number, number] = [5, 44, 15, 48];

function ctx(stub: ReturnType<typeof vi.fn>) {
  return { bbox: ALPS, zoom: 5, env: {}, fetch: stub as unknown as CachedFetch };
}

async function tiles(input: Record<string, unknown>) {
  const stub = vi.fn();
  const r = await layer.query(ctx(stub), layer.input.parse(input));
  expect(stub).not.toHaveBeenCalled();
  if (!("kind" in r) || r.kind !== "tiles") throw new Error(`expected tiles, got ${JSON.stringify(r)}`);
  return r;
}

describe("greenness layer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T01:30:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("declares global coverage, no env and no area cap", () => {
    expect(layer.id).toBe("greenness");
    expect(layer.coverage).toBe("global");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
  });

  it("defaults to NDVI on the newest composite (25 days back) at zoom 0 to 9", async () => {
    const r = await tiles({});
    expect(r.data.url).toBe(
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_L3_NDVI_16Day/default/2026-09-14/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png",
    );
    expect(r.data).toMatchObject({ minzoom: 0, maxzoom: 9, format: "raster" });
    expect(r.coverageNote).toBe("NDVI 16-day composite 2026-09-14 to 2026-09-29 (the composite containing 2026-09-14)");
  });

  it("names the composite period, not the requested day", async () => {
    const r = await tiles({ date: "2025-07-01" });
    expect(r.coverageNote).toBe("NDVI 16-day composite 2025-06-26 to 2025-07-11 (the composite containing 2025-07-01)");
    expect(compositeStart("2026-01-01")).toBe("2026-01-01");
    expect(compositeStart("2026-01-16")).toBe("2026-01-01");
    expect(compositeStart("2026-01-17")).toBe("2026-01-17");
    expect(compositeStart("2000-03-05")).toBe("2000-03-05");
  });

  it("switches to EVI", async () => {
    const r = await tiles({ index: "evi", date: "2025-07-01" });
    expect(r.data.url).toContain("MODIS_Terra_L3_EVI_16Day/default/2025-07-01/");
  });

  it("publishes a scrubbable time block that the scrubber can fill", async () => {
    const r = await tiles({});
    expect(r.data.time).toEqual({
      template: expect.stringContaining("/default/{date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png"),
      cadence: "16day",
      from: "2000-03-05",
      daysBack: 25,
    });
    const filled = tileUrlForTime(r.data.url, r.data.time, ["2020-01-01", "2024-06-20T00:00:00Z"], Date.now());
    // snapped to the composite holding 20 June 2024 (the one starting 9 June, day-of-year 161)
    expect(filled).toContain("/default/2024-06-09/");
    // a window ending today is held 25 days back so the tiles are not blank
    expect(tileUrlForTime(r.data.url, r.data.time, ["2020-01-01", "2026-10-09T00:00:00Z"], Date.now())).toContain("/default/2026-09-14/");
  });

  it("clamps a date that is too new and rejects one before MODIS started", async () => {
    const r = await tiles({ date: "2026-10-09" });
    expect(r.data.url).toContain("/default/2026-09-14/");
    expect(r.coverageNote).toContain("showing 2026-09-14");
    expect(await layer.query(ctx(vi.fn()), { index: "ndvi", date: "2000-03-04" })).toMatchObject({ error: expect.stringContaining("2000-03-05") });
    expect(await layer.query(ctx(vi.fn()), { index: "ndvi", date: "2026-02-31" })).toMatchObject({ error: expect.stringContaining("not a real date") });
  });

  it("rejects a malformed index or date at the input schema", () => {
    expect(layer.input.safeParse({ index: "ndwi" }).success).toBe(false);
    expect(layer.input.safeParse({ date: "last week" }).success).toBe(false);
  });

  it("tells the model what it shows, the cadence, the unit and the user's words", () => {
    expect(layer.description).toMatch(/16-day/);
    expect(layer.description).toMatch(/NDVI/);
    expect(layer.description).toMatch(/EVI/);
    for (const word of ["greenness", "how green", "green-up", "compare"]) expect(layer.description).toContain(word);
  });

  it("summarizes to the tile URL and the time range for the model", async () => {
    const summary = summarizeLayerResult(await layer.query(ctx(vi.fn()), { index: "ndvi" }));
    expect(summary).toMatchObject({ kind: "tiles", format: "raster", time: { cadence: "16day", from: "2000-03-05", daysBack: 25 } });
  });

  it("draws GIBS's ramp as served, with a key in its colors from bare to dense forest", () => {
    expect(layer.style.raster).toMatchObject({ saturation: 0 });
    expect(legendOf(layer)).toBe(NDVI_LEGEND);
    expect(legendProblems(NDVI_LEGEND, "ndvi")).toEqual([]);
    expect(legendProblems(EVI_LEGEND, "evi")).toEqual([]);
    expect(NDVI_LEGEND.stops?.[0]).toMatchObject({ value: 0, color: "#F1ECEC" });
    expect(NDVI_LEGEND.stops?.at(-1)).toMatchObject({ value: 1, color: "#001800" });
  });

  it("runs through runLayer and rejects a bad date", async () => {
    expect((await runLayer("greenness", { bbox: ALPS, zoom: 5 })).status).toBe(200);
    expect((await runLayer("greenness", { bbox: ALPS, input: { date: "soon" } })).status).toBe(400);
  });
});
