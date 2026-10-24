import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { readNormals } from "@/lib/ee/terraclimate";
import layer, { gridNormals, kmBetween, monthsLine, normalsFacts, normalsStrip, pickStation, readStationNormals, snowSeason, stationName, type Normals } from "./climate-normals";
import search from "./__fixtures__/climate-normals.search-tahoe.json";
import tahoeCity from "./__fixtures__/climate-normals.tahoe-city.json";

/**
 * Fixtures are real NCEI answers (2026-10-23): the stations with temperature normals within 40 km of Lake Tahoe's
 * middle (data types trimmed to the four the layer reads), and Tahoe City's 1991–2020 monthly normals.
 */
const LAKE: [number, number] = [-120.04, 39.09];
const BBOX: [number, number, number, number] = [-120.25, 38.9, -119.9, 39.3];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function stubFetch() {
  return vi.fn(async (url: string) => {
    if (url.includes("/search/v1/data")) return json(search);
    if (url.includes("/data/v1") && url.includes("stations=USC00048758")) return json(tahoeCity);
    return json([], 404);
  });
}

function ctx(stub: ReturnType<typeof vi.fn>, env: Record<string, string> = {}) {
  return { bbox: BBOX, zoom: 10, env, fetch: stub as unknown as CachedFetch };
}

async function geojson(stub: ReturnType<typeof vi.fn>, input: Record<string, unknown>) {
  const r = await layer.query(ctx(stub), layer.input.parse(input));
  if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
  return r;
}

describe("climate-normals layer", () => {
  it("declares worldwide coverage, no required env, Earth Engine optional, and optional lon, lat and name", () => {
    expect(layer.id).toBe("climate-normals");
    expect(layer.coverage).toBe("global");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.optionalEnv).toContain("EE_PROJECT");
    expect(layer.input.parse({})).toEqual({});
    expect(layer.input.parse({ lon: -120, lat: 39, name: "Lake Tahoe" })).toMatchObject({ name: "Lake Tahoe" });
    expect(() => layer.input.parse({ lon: 200, lat: 0 })).toThrow();
    expect(layer.description).toMatch(/typical temperature by month/);
  });

  it("names stations as people say them", () => {
    expect(stationName("TAHOE CITY, CA US")).toBe("Tahoe City, CA");
    expect(stationName("ASHEVILLE RGNL AP, NC US")).toBe("Asheville Regional Airport, NC");
    expect(stationName("BLACK MTN 2 W, NC US")).toBe("Black Mountain 2 W, NC");
  });

  it("picks the nearest station, but one with snow normals when it is nearly as near", () => {
    // Tahoma (7.9 km) and Glenbrook (8.5 km) keep no snow normals; Tahoe City (12.4 km) does.
    const s = pickStation(search, LAKE);
    expect(s).toMatchObject({ id: "USC00048758", name: "Tahoe City, CA", hasSnow: true });
    expect(s?.distanceKm).toBeCloseTo(12.4, 0);
    // At Tahoe City itself it is the nearest anyway.
    expect(pickStation(search, [-120.1428, 39.1678])?.id).toBe("USC00048758");
    // Nothing within 40 km.
    expect(pickStation(search, [-118, 37])).toBeNull();
    expect(kmBetween([0, 0], [0, 1])).toBeCloseTo(111.2, 0);
  });

  it("reads Tahoe City's normals: °F, inches, snowfall and days with snow on the ground", () => {
    const read = readStationNormals(tahoeCity);
    expect(read?.elevationM).toBeCloseTo(1898.9, 1);
    expect(read?.normals.highF[6]).toBe(78);
    expect(read?.normals.lowF[6]).toBe(46);
    expect(read?.normals.precipIn[0]).toBe(6.21);
    expect(read?.normals.snowIn?.[10]).toBe(9.4);
    expect(read?.normals.snowDays?.[0]).toBe(27.1);
    expect(readStationNormals([{ DATE: "01", "MLY-PRCP-NORMAL": "1.0" }])).toBeNull();
    // A trace is 0; a flagged missing value is null.
    const flagged = readStationNormals([{ DATE: "01", "MLY-TMAX-NORMAL": "40", "MLY-PRCP-NORMAL": "-7777", "MLY-SNOW-NORMAL": "-9999" }]);
    expect(flagged?.normals.precipIn[0]).toBe(0);
    expect(flagged?.normals.snowIn).toBeUndefined();
  });

  it("answers Lake Tahoe with the station's point, the deciding facts first and every month in the note", async () => {
    const stub = stubFetch();
    const r = await geojson(stub, { lon: LAKE[0], lat: LAKE[1], name: "Lake Tahoe" });
    const [searchUrl] = stub.mock.calls[0] as unknown as [string];
    expect(searchUrl).toMatch(/dataset=normals-monthly-1991-2020&bbox=39\.\d+,-120\.\d+,38\.\d+,-119\.\d+&dataTypes=MLY-TMAX-NORMAL/);
    const [dataUrl] = stub.mock.calls[1] as unknown as [string];
    expect(dataUrl).toContain("stations=USC00048758");
    expect(dataUrl).toContain("MLY-SNWD-AVGNDS-GE001WI");
    expect(r.data.features).toHaveLength(1);
    const f = r.data.features[0];
    expect(f.geometry).toEqual({ type: "Point", coordinates: [-120.1428, 39.1678] });
    expect(f.properties).toMatchObject({
      name: "Tahoe City, CA",
      place: "Lake Tahoe",
      warmest: "July: 78 °F by day and 46 °F at night",
      coldest: "January: 40 °F by day and 21 °F at night",
      wettest: "January: 6.2 in",
      snowSeason: "Snow usually arrives in November and is gone by May",
      period: "1991–2020",
    });
    expect(r.coverageNote).toMatch(/^At Tahoe City, CA \(NOAA weather station, 6,230 ft, 12 km from Lake Tahoe\), the 1991–2020 normals: July is warmest, averaging 78 °F by day and 46 °F at night/);
    expect(r.coverageNote).toContain("the wettest month is January with 6.2 in");
    expect(r.coverageNote).toContain("Snow usually arrives in November and is gone by May");
    expect(r.coverageNote).toContain("Jul 78/46, 0.2");
    expect(r.citation.source).toContain("NOAA NCEI");
    expect(r.months?.rows.map((row) => row.kind)).toEqual(["band", "bars", "cells"]);
    for (const row of r.months?.rows ?? []) {
      if (row.kind === "band") expect([row.high.length, row.low.length]).toEqual([12, 12]);
      else expect(row.values).toHaveLength(12);
    }
    expect(r.months?.rows[2]).toMatchObject({ key: "snowGround", max: 1 });
    expect(r.months?.rows[1].legend).toBe("Bars: normal monthly precipitation (rain and melted snow), 1991–2020");
  });

  it("without lon and lat reads the centre of the view", async () => {
    const stub = stubFetch();
    const r = await geojson(stub, {});
    expect(r.coverageNote).toMatch(/from the centre of the view/);
  });

  it("says why when no station is near and Earth Engine is not set up, inside and outside the US", async () => {
    const none = vi.fn(async () => json({ results: [] }));
    const us = await layer.query(ctx(none), { lon: -118, lat: 37 });
    expect(us).toMatchObject({ hint: "unavailable", error: expect.stringContaining("No NOAA weather station") });
    const alps = await layer.query({ ...ctx(none), bbox: [7.5, 46.4, 7.9, 46.7] }, { lon: 7.66, lat: 46.62 });
    expect(alps).toMatchObject({ hint: "unavailable", error: expect.stringContaining("TerraClimate") });
    // Outside the US the NOAA services are not asked.
    expect(none).toHaveBeenCalledTimes(1);
  });

  it("reads TerraClimate's 48 bands into °F, inches and snow water, and finds the snow season from it", () => {
    const result: Record<string, number> = {};
    const tmmx = [44, 47, 71, 98, 148, 203, 254, 252, 216, 151, 84, 39];
    const swe = [262, 348, 220, 27, 0.3, 0, 0, 0, 0, 0, 15, 146];
    tmmx.forEach((v, i) => {
      const m = String(i + 1).padStart(2, "0");
      Object.assign(result, { [`tmmx_${m}`]: v, [`tmmn_${m}`]: v - 150, [`pr_${m}`]: 100, [`swe_${m}`]: swe[i] });
    });
    const grid = readNormals(result);
    expect(grid?.highC[6]).toBeCloseTo(25.4, 5);
    const n = gridNormals(grid!);
    expect(n.highF[6]).toBeCloseTo(77.7, 1);
    expect(n.precipIn[0]).toBeCloseTo(3.94, 2);
    expect(snowSeason(n, true)).toMatchObject({ arrives: 10, goneBy: 4, sentence: "Snow usually lies on the ground from November and is gone by May" });
    expect(readNormals({})).toBeNull();
  });

  it("calls light snow occasional rather than a season, and states °C first outside the US", () => {
    const asheville: Normals = {
      highF: [48, 52, 59, 69, 76, 83, 86, 85, 79, 69, 59, 51],
      lowF: [29, 32, 38, 46, 54, 61, 65, 64, 58, 47, 37, 32],
      precipIn: [3.3, 2.9, 3.5, 3.7, 3.5, 3.4, 4.1, 3.6, 3.7, 2.6, 3.1, 3.3],
      snowIn: [3.8, 2.2, 2, 0.3, 0, 0, 0, 0, 0, 0, 0.5, 2.7],
      snowDays: [2.6, 1.6, 0.7, 0, 0, 0, 0, 0, 0, 0, 0.2, 2],
    };
    expect(snowSeason(asheville, true).sentence).toBe("Snow is occasional here: about 12 in a year, most in January (3.8 in), and it seldom stays on the ground");
    const facts = normalsFacts(asheville, false);
    expect(facts.warmest).toBe("July: 30 °C (86 °F) by day and 18 °C (65 °F) at night");
    expect(monthsLine(asheville, false)).toMatch(/^Jan 9\/-2, 84; /);
    const strip = normalsStrip(asheville, false, "Somewhere", "1991–2020", "x");
    expect(strip.rows[0]).toMatchObject({ unit: "°C" });
    expect(strip.rows[1]).toMatchObject({ unit: "mm" });
  });
});
