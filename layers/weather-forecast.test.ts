import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { CachedFetch } from "@/lib/fetch";
import { contractProblems, legendOf, timeShapeOf } from "./contract";
import layer, { dailySummaries, durationHours, forecastPoints, hourAxis, nwsForecast, nwsHourly, nwsWeatherWords, openMeteoForecast, wmoWords } from "./weather-forecast";
import type { LayerResult } from "./types";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8")) as unknown;
const NWS_POINT = fixture("weather-forecast.nws-points-zion.json");
const NWS_GRID = fixture("weather-forecast.nws-grid-zion.json");
const OM_CHAMONIX = fixture("weather-forecast.openmeteo-chamonix.json");

const ZION: [number, number, number, number] = [-113.2, 37.1, -112.85, 37.5];
const ZION_SMALL: [number, number, number, number] = [-113.05, 37.28, -113.0, 37.32];
const CHAMONIX: [number, number, number, number] = [6.86, 45.91, 6.9, 45.93];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function ctx(bbox: [number, number, number, number], handler: (url: string) => Response) {
  const stub = vi.fn(async (url: string) => handler(url));
  return { stub, ctx: { bbox, zoom: 10, env: {}, fetch: stub as unknown as CachedFetch } };
}

function geojson(r: unknown): Extract<LayerResult, { kind: "geojson" }> {
  if (typeof r !== "object" || r === null || !("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
  return r as Extract<LayerResult, { kind: "geojson" }>;
}

describe("weather-forecast layer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T14:20:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("keeps the layer contract: hourly continuous time, a temperature ramp, US units in local time", () => {
    expect(contractProblems(layer)).toEqual([]);
    expect(timeShapeOf(layer)).toMatchObject({ shape: "continuous", step: "hour" });
    expect(legendOf(layer).kind).toBe("ramp");
    expect(layer.display).toEqual({ units: "us", timeZone: "local" });
    expect(layer.requiredEnv).toEqual([]);
  });

  it("reads NWS durations and spreads a 6-hour precipitation amount over its hours", () => {
    expect(durationHours("PT1H")).toBe(1);
    expect(durationHours("PT6H")).toBe(6);
    expect(durationHours("P1DT2H")).toBe(26);
    const times = hourAxis(new Date("2026-10-23T00:10:00Z"), 1).slice(0, 8);
    const amounts = nwsHourly({ values: [{ validTime: "2026-10-23T00:00:00+00:00/PT6H", value: 6 }] }, times, true);
    expect(amounts.slice(0, 7)).toEqual([1, 1, 1, 1, 1, 1, null]);
  });

  it("puts NWS weather and WMO codes in words", () => {
    expect(nwsWeatherWords([{ coverage: "chance", weather: "rain_showers", intensity: "light" }])).toBe("Chance of light rain showers");
    expect(nwsWeatherWords([{ coverage: null, weather: null, intensity: null }])).toBeNull();
    expect(wmoWords(95)).toBe("Thunderstorms");
    expect(wmoWords(2)).toBeNull();
  });

  it("turns the Zion NWS grid into °F, mph and inches per hour, and days in local time", () => {
    const times = hourAxis(new Date(), 7);
    const fc = nwsForecast(NWS_GRID, times);
    expect(fc).not.toBeNull();
    expect(fc!.hours[0].tempF).toBeGreaterThan(20);
    expect(fc!.hours[0].tempF).toBeLessThan(90);
    const days = dailySummaries({ ...fc!, timeZone: "America/Denver" });
    expect(days[0]).toMatchObject({ day: "2026-10-23", partial: true });
    const sat = days.find((d) => d.day === "2026-10-24")!;
    expect(sat.highF).not.toBeNull();
    expect(sat.precipChance).toBeGreaterThan(0);
    expect(sat.gustMph).toBeGreaterThanOrEqual(sat.windMph ?? 0);
  });

  it("reads Open-Meteo local hours onto the UTC axis", () => {
    const times = hourAxis(new Date(), 2);
    const fc = openMeteoForecast(OM_CHAMONIX, times);
    expect(fc?.timeZone).toBe("Europe/Paris");
    expect(fc?.hours.filter((h) => h.tempF !== null).length).toBe(48);
  });

  it("answers one point for a small view and five for a wide one", () => {
    expect(forecastPoints(ZION_SMALL)).toHaveLength(1);
    const wide = forecastPoints(ZION);
    expect(wide).toHaveLength(5);
    expect(wide[0].kind).toBe("here");
  });

  it("answers Zion from the NWS: Saturday and Sunday in words, hourly series and the linked temperature", async () => {
    const { ctx: c, stub } = ctx(ZION_SMALL, (url) => (url.includes("/points/") ? json(NWS_POINT) : url.includes("/gridpoints/") ? json(NWS_GRID) : json({}, 500)));
    const r = geojson(await layer.query(c, layer.input.parse({})));
    expect(stub).toHaveBeenCalledTimes(2);
    expect(r.data.features).toHaveLength(1);
    const p = r.data.features[0].properties as Record<string, unknown>;
    expect(p).toMatchObject({ kind: "here", source: "nws", timeZone: "America/Denver" });
    expect(p.name).toContain("near Springdale, UT");
    expect(String(p.saturday)).toMatch(/^Sat, Oct 24: high \d+ °F, low \d+ °F; \d+% chance of rain or snow, \d\.\d\d in; wind to \d+ mph, gusts \d+ mph/);
    expect(String(p.sunday)).toMatch(/^Sun, Oct 25:/);
    expect(r.series).toMatchObject({ step: "hour", now: 0 });
    expect(r.series!.times).toHaveLength(168);
    expect((p.series as Record<string, unknown[]>).tempF).toHaveLength(168);
    expect(r.linked).toMatchObject({ label: "Temperature", unit: "°F" });
    expect(r.coverageNote).toContain("National Weather Service");
    expect(r.coverageNote).toContain("Sat, Oct 24");
  });

  it("falls back to Open-Meteo when the NWS fails, and says so", async () => {
    const { ctx: c } = ctx(ZION_SMALL, (url) => (url.includes("open-meteo") ? json([OM_CHAMONIX]) : json({}, 503)));
    const r = geojson(await layer.query(c, layer.input.parse({ days: 2 })));
    expect((r.data.features[0].properties as Record<string, unknown>).source).toBe("open-meteo");
    expect(r.coverageNote).toContain("Open-Meteo filled them");
    expect(r.sourceStatus).toEqual({ ok: true });
  });

  it("uses Open-Meteo outside the US and errors only when nothing answers", async () => {
    const ok = ctx(CHAMONIX, () => json(OM_CHAMONIX));
    const r = geojson(await layer.query(ok.ctx, layer.input.parse({})));
    expect(ok.stub.mock.calls[0][0]).toContain("api.open-meteo.com");
    expect(r.citation.source).toContain("Open-Meteo");
    const down = ctx(CHAMONIX, () => json({}, 500));
    expect(await layer.query(down.ctx, layer.input.parse({}))).toMatchObject({ hint: "upstream" });
  });
});
