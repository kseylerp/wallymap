import { describe, expect, it } from "vitest";
import { gibsDatedResult, type GibsDatedSpec } from "./gibs-dated";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const spec: GibsDatedSpec = {
  gibsId: "SOME_Layer",
  level: 8,
  from: "2020-01-01",
  daysBack: 2,
  cadence: "daily",
  label: "snow cover",
  citationSource: "NASA GIBS: test",
};

describe("gibsDatedResult", () => {
  it("defaults to the newest processed day and publishes the time template", () => {
    const r = gibsDatedResult(spec, undefined, NOW);
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.data.url).toBe(
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/SOME_Layer/default/2026-10-07/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png",
    );
    expect(r.data).toMatchObject({ minzoom: 0, maxzoom: 8, format: "raster" });
    expect(r.data.time).toEqual({
      template: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/SOME_Layer/default/{date}/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png",
      cadence: "daily",
      from: "2020-01-01",
      daysBack: 2,
    });
    expect(r.coverageNote).toBe("Snow cover for 2026-10-07");
  });

  it("clamps a too-new day, and rejects a day before the archive", () => {
    const r = gibsDatedResult(spec, "2026-10-09", NOW);
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.data.url).toContain("/default/2026-10-07/");
    expect(r.coverageNote).toContain("showing 2026-10-07");
    expect(gibsDatedResult(spec, "2019-12-31", NOW)).toMatchObject({ error: expect.stringContaining("2020-01-01") });
  });

  it("passes `to` into the time block and caps the day there", () => {
    const r = gibsDatedResult({ ...spec, to: "2025-09-01" }, undefined, NOW);
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.data.url).toContain("/default/2025-09-01/");
    expect(r.data.time?.to).toBe("2025-09-01");
  });
});
