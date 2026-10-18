import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import { tileUrlForTime } from "@/lib/time";
import { contractProblems, legendOf, timeShapeOf } from "./contract";
import layer, { mtbsTileUrl, regionFor } from "./burn-severity";

const SIERRA: [number, number, number, number] = [-120.5, 37.5, -119, 38.5];

function ctx(stub: ReturnType<typeof vi.fn>, bbox = SIERRA) {
  return { bbox, zoom: 8, env: {}, fetch: stub as unknown as CachedFetch };
}

async function tiles(input: Record<string, unknown>, bbox = SIERRA) {
  const stub = vi.fn();
  const r = await layer.query(ctx(stub, bbox), layer.input.parse(input));
  expect(stub).not.toHaveBeenCalled();
  if (!("kind" in r) || r.kind !== "tiles") throw new Error(`expected tiles, got ${JSON.stringify(r)}`);
  return r;
}

/** The decoded query of a tile URL (the bbox token filled so it parses). */
function params(url: string) {
  return new URL(url.replace("{bbox-epsg-3857}", "0,0,1,1")).searchParams;
}

describe("burn-severity layer", () => {
  it("declares US coverage, no env and no area cap", () => {
    expect(layer.id).toBe("burn-severity");
    expect(layer.coverage).toBe("us");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
  });

  it("draws the MTBS severity mosaic for one year, low/moderate/high only, in the palette's ramp (audit 2026-10-17: outlines only)", async () => {
    const r = await tiles({});
    expect(r.data.url.startsWith("https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/USFS_EDW_MTBS_CONUS/ImageServer/exportImage?")).toBe(true);
    const p = params(r.data.url);
    expect(JSON.parse(p.get("mosaicRule")!)).toEqual({ where: "year=2024" });
    expect(JSON.parse(p.get("renderingRule")!)).toEqual({
      rasterFunction: "Colormap",
      rasterFunctionArguments: { Colormap: [[2, 159, 182, 147], [3, 245, 114, 114], [4, 110, 91, 255]] },
    });
    expect(p.get("interpolation")).toBe("RSP_NearestNeighbor");
    expect(r.data).toMatchObject({ minzoom: 0, maxzoom: 14, format: "raster" });
    expect(r.coverageNote).toBe("MTBS burn severity of large fires in 2024, the lower 48 states: low sage, moderate pink, high purple");
  });

  it("uses a supplied year, and shows the newest mapped year (saying so) for 2025 and 2026", async () => {
    expect(JSON.parse(params((await tiles({ year: 2021 })).data.url).get("mosaicRule")!)).toEqual({ where: "year=2021" });
    const partial = await tiles({ year: 2026 });
    expect(JSON.parse(params(partial.data.url).get("mosaicRule")!)).toEqual({ where: "year=2024" });
    expect(partial.coverageNote).toContain("MTBS has not mapped 2026 yet");
  });

  it("picks the Alaska and Hawaii mosaics by the view's centre", async () => {
    expect(regionFor([-150, 63, -147, 65])).toBe("AK");
    expect(regionFor([-156, 19, -155, 20])).toBe("HI");
    expect(regionFor(SIERRA)).toBe("CONUS");
    const hi = await tiles({ year: 2024 }, [-156, 19, -155, 20]);
    expect(hi.data.url).toContain("USFS_EDW_MTBS_HI/ImageServer");
    expect(hi.data.time).toMatchObject({ to: "2023" });
    expect(hi.coverageNote).toContain("showing 2023");
  });

  it("publishes a yearly time block from 1984 to 2024 that the scrubber fills", async () => {
    const r = await tiles({});
    expect(r.data.time).toEqual({ template: mtbsTileUrl("{year}"), cadence: "yearly", from: "1984", to: "2024" });
    expect(r.data.time?.template).toContain("year%3D{year}");
    expect(tileUrlForTime(r.data.url, r.data.time, ["1984-01-01", "2012-06-01T00:00:00Z"], Date.now())).toContain("year%3D2012");
    expect(tileUrlForTime(r.data.url, r.data.time, ["1984-01-01", "2030-06-01T00:00:00Z"], Date.now())).toContain("year%3D2024");
    expect(tileUrlForTime(r.data.url, r.data.time, ["1970-01-01", "1975-06-01T00:00:00Z"], Date.now())).toContain("year%3D1984");
  });

  it("rejects years outside 1984 to 2026 and non-integers at the input schema", () => {
    expect(layer.input.safeParse({ year: 1983 }).success).toBe(false);
    expect(layer.input.safeParse({ year: 2027 }).success).toBe(false);
    expect(layer.input.safeParse({ year: 2020.5 }).success).toBe(false);
  });

  it("keys low, moderate and high in the drawn colors, yearly time, and keeps the user's words", () => {
    expect(contractProblems(layer)).toEqual([]);
    expect(legendOf(layer).items?.map((i) => [i.label, i.color])).toEqual([
      ["Low", "#9FB693"],
      ["Moderate", "#F57272"],
      ["High", "#6E5BFF"],
    ]);
    expect(timeShapeOf(layer)).toMatchObject({ shape: "continuous", step: "year" });
    for (const word of ["burn severity", "how bad was the burn", "burn scars", "fire history", "1,000 acres", "fire-perimeters", "yearly"]) {
      expect(layer.description).toContain(word);
    }
  });

  it("summarizes to the tile URL and time range for the model", async () => {
    expect(summarizeLayerResult(await layer.query(ctx(vi.fn()), { year: 2024 }))).toMatchObject({
      kind: "tiles",
      time: { cadence: "yearly", from: "1984", to: "2024" },
    });
  });

  it("runs through runLayer", async () => {
    expect((await runLayer("burn-severity", { bbox: SIERRA, zoom: 8 })).status).toBe(200);
    expect((await runLayer("burn-severity", { bbox: SIERRA, input: { year: "2020" } })).status).toBe(400);
  });
});
