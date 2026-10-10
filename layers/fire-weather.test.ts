import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import { tileUrlForTime } from "@/lib/time";
import layer, { fwiTileUrl } from "./fire-weather";

const SOCAL: [number, number, number, number] = [-119, 33, -116, 35];

function ctx(stub: ReturnType<typeof vi.fn>) {
  return { bbox: SOCAL, zoom: 7, env: {}, fetch: stub as unknown as CachedFetch };
}

async function tiles(input: Record<string, unknown>) {
  const stub = vi.fn();
  const r = await layer.query(ctx(stub), layer.input.parse(input));
  expect(stub).not.toHaveBeenCalled();
  if (!("kind" in r) || r.kind !== "tiles") throw new Error(`expected tiles, got ${JSON.stringify(r)}`);
  return r;
}

describe("fire-weather layer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T01:30:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("declares global coverage, no env and no area cap", () => {
    expect(layer.id).toBe("fire-weather");
    expect(layer.coverage).toBe("global");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
  });

  it("defaults to today on the global GWIS ECMWF FWI WMS with the bbox placeholder", async () => {
    const r = await tiles({});
    expect(r.data.url).toBe(
      "https://maps.wild-fire.eu/gwis?service=WMS&version=1.3.0&request=GetMap&layers=ecmwf.fwi&styles=&format=image/png&transparent=true&crs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}&time=2026-10-09",
    );
    expect(r.data).toMatchObject({ minzoom: 0, format: "raster" });
    expect(r.coverageNote).toBe("Fire Weather Index for 2026-10-09");
  });

  it("publishes a daily time template from 2024-01-01 and the scrubber fills the {date}", async () => {
    const r = await tiles({});
    expect(r.data.time).toEqual({ template: fwiTileUrl("global", "{date}"), cadence: "daily", from: "2024-01-01" });
    expect(r.data.time?.template).toContain("&time={date}");
    expect(tileUrlForTime(r.data.url, r.data.time, ["2025-01-01", "2025-07-04T00:00:00Z"], Date.now())).toContain("&time=2025-07-04");
    expect(tileUrlForTime(r.data.url, r.data.time, ["2020-01-01", "2020-02-01T00:00:00Z"], Date.now())).toContain("&time=2024-01-01");
  });

  it("allows forecast days up to 9 ahead for global and clamps beyond", async () => {
    expect((await tiles({ date: "2026-10-18" })).data.url).toContain("&time=2026-10-18");
    const r = await tiles({ date: "2026-10-25" });
    expect(r.data.url).toContain("&time=2026-10-18");
    expect(r.coverageNote).toContain("showing 2026-10-18");
  });

  it("region europe uses the EFFIS Meteo-France layer, 3 forecast days and starts 2024-05-31", async () => {
    const r = await tiles({ region: "europe" });
    expect(r.data.url).toContain("https://maps.effis.emergency.copernicus.eu/effis?service=WMS");
    expect(r.data.url).toContain("layers=mf010.fwi");
    expect(r.data.time?.from).toBe("2024-05-31");
    expect((await tiles({ region: "europe", date: "2026-10-20" })).data.url).toContain("&time=2026-10-12");
    expect(await layer.query(ctx(vi.fn()), { region: "europe", date: "2024-05-30" })).toMatchObject({ error: expect.stringContaining("2024-05-31") });
  });

  it("rejects a date before 2024 and an impossible date", async () => {
    expect(await layer.query(ctx(vi.fn()), { region: "global", date: "2023-12-31" })).toMatchObject({ error: expect.stringContaining("2024-01-01") });
    expect(await layer.query(ctx(vi.fn()), { region: "global", date: "2026-02-30" })).toMatchObject({ error: expect.stringContaining("not a real date") });
  });

  it("rejects an unknown region or date format at the input schema", () => {
    expect(layer.input.safeParse({ region: "asia" }).success).toBe(false);
    expect(layer.input.safeParse({ date: "tomorrow" }).success).toBe(false);
  });

  it("tells the model what it is, the cadence, the forecast window and the user's words", () => {
    for (const word of ["Fire Weather Index", "daily", "fire danger", "fire-detections", "9 days ahead", "forecast"]) {
      expect(layer.description).toContain(word);
    }
  });

  it("summarizes to the tile URL and time range for the model", async () => {
    expect(summarizeLayerResult(await layer.query(ctx(vi.fn()), { region: "global" }))).toMatchObject({
      kind: "tiles",
      time: { cadence: "daily", from: "2024-01-01" },
    });
  });

  it("runs through runLayer", async () => {
    expect((await runLayer("fire-weather", { bbox: SOCAL, zoom: 7 })).status).toBe(200);
    expect((await runLayer("fire-weather", { bbox: SOCAL, input: { date: "x" } })).status).toBe(400);
  });
});
