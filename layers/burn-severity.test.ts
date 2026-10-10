import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import { tileUrlForTime } from "@/lib/time";
import layer, { mtbsTileUrl } from "./burn-severity";

const SIERRA: [number, number, number, number] = [-120.5, 37.5, -119, 38.5];

function ctx(stub: ReturnType<typeof vi.fn>) {
  return { bbox: SIERRA, zoom: 8, env: {}, fetch: stub as unknown as CachedFetch };
}

async function tiles(input: Record<string, unknown>) {
  const stub = vi.fn();
  const r = await layer.query(ctx(stub), layer.input.parse(input));
  expect(stub).not.toHaveBeenCalled();
  if (!("kind" in r) || r.kind !== "tiles") throw new Error(`expected tiles, got ${JSON.stringify(r)}`);
  return r;
}

describe("burn-severity layer", () => {
  it("declares US coverage, no env and no area cap", () => {
    expect(layer.id).toBe("burn-severity");
    expect(layer.coverage).toBe("us");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
  });

  it("defaults to 2024 with a layerDefs year filter on the all-years layer", async () => {
    const r = await tiles({});
    expect(r.data.url).toBe(
      "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MTBS_01/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&f=image&transparent=true&layers=show:63&layerDefs=63:year%3D2024",
    );
    expect(r.data).toMatchObject({ minzoom: 0, maxzoom: 14, format: "raster" });
    expect(r.coverageNote).toContain("2024");
    expect(r.coverageNote).not.toContain("partial");
  });

  it("uses a supplied year and marks 2025 and 2026 as partial", async () => {
    expect((await tiles({ year: 2020 })).data.url).toContain("layerDefs=63:year%3D2020");
    const partial = await tiles({ year: 2026 });
    expect(partial.data.url).toContain("year%3D2026");
    expect(partial.coverageNote).toContain("partial year");
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

  it("says plainly that it draws burned areas, not severity colors, and keeps the user's words", () => {
    expect(layer.description).toMatch(/does not color how severely/);
    for (const word of ["burn severity", "burn scars", "fire history", "1,000 acres", "fire-perimeters", "yearly"]) {
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
