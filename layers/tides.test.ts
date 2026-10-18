import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { timeShapeOf } from "./contract";
import layer, {
  FRAMES,
  LIVE_FIRST,
  TIMED_STATIONS,
  WIDE_LIMIT,
  eventText,
  frameTimes,
  heightAt,
  hourlyOnFrames,
  localLabel,
  observedLevel,
  orderedStations,
  parseStations,
  pickTimed,
  tideEvents,
  tideFeature,
  upcomingEvents,
  wallToUtc,
  wideStations,
  zoneOf,
} from "./tides";
import stationsFixture from "./__fixtures__/tides-stations.sf.json";
import waterlevelsFixture from "./__fixtures__/coops-waterlevels.sf.json";
import hiloFixture from "./__fixtures__/tides-hilo.9414290.json";
import hourlyFixture from "./__fixtures__/tides-hourly.9414290.json";
import wlFixture from "./__fixtures__/tides-wl.9414290.json";
import { hardMaxAreaKm2 } from "./types";

/**
 * Recorded 2026-10-18 ~06:30 UTC (11:30 pm PDT Saturday) with time_zone=lst_ldt: the station list trimmed to San
 * Francisco Bay (60 stations) plus The Battery (NY) to test the filter; Golden Gate's highs and lows from local midnight
 * Oct 17, its hourly heights from 11 pm Oct 17 (48 hours) and its latest water level.
 */
const BAY: [number, number, number, number] = [-122.6, 37.4, -122.0, 38.0];
const NOW = new Date("2026-10-18T06:30:00Z");
const NO_DATA = { error: { message: "No data was found. This product may not be offered at this station at the requested time." } };
const PDT = "America/Los_Angeles";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function routedStub() {
  return vi.fn(async (url: string) => {
    if (url.includes("type=tidepredictions")) return json(stationsFixture);
    if (url.includes("type=waterlevels")) return json(waterlevelsFixture);
    if (url.includes("product=water_level")) return url.includes("station=9414290&") ? json(wlFixture) : json(NO_DATA);
    if (url.includes("interval=h&")) return json(hourlyFixture);
    return json(hiloFixture);
  });
}

function ctx(stub: ReturnType<typeof vi.fn>, bbox = BAY) {
  return { bbox, zoom: 10, env: {}, fetch: stub as unknown as CachedFetch, cacheKey: "tides:k" };
}

function calls(stub: ReturnType<typeof vi.fn>) {
  return stub.mock.calls as unknown as [string, { cacheKey?: string; ttlSeconds?: number; shouldCache?: unknown }][];
}

const stations = parseStations(stationsFixture);
const goldenGate = stations.find((s) => s.id === "9414290")!;
const live = new Set(parseStations(waterlevelsFixture).map((s) => s.id));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("local time", () => {
  it("reads each station's zone from its standard offset and state", () => {
    expect(goldenGate.timezonecorr).toBe(-8);
    expect(zoneOf(goldenGate)).toBe(PDT);
    expect(zoneOf({ timezonecorr: -5, state: "NY", lng: -74 })).toBe("America/New_York");
    expect(zoneOf({ timezonecorr: -10, state: "HI", lng: -157.9 })).toBe("Pacific/Honolulu");
    expect(zoneOf({ timezonecorr: -10, state: "AK", lng: -176.6 })).toBe("America/Adak");
    expect(zoneOf({ timezonecorr: null, state: "CA", lng: -122.4 })).toBe(PDT);
  });

  it("turns NOAA's local clock readings into instants and prints them with the zone and weekday", () => {
    expect(new Date(wallToUtc("2026-10-17 23:38", PDT)).toISOString()).toBe("2026-10-18T06:38:00.000Z");
    // Winter: PST is UTC-8.
    expect(new Date(wallToUtc("2026-12-01 00:24", PDT)).toISOString()).toBe("2026-12-01T08:24:00.000Z");
    expect(localLabel("2026-10-18 00:24", PDT, Date.parse("2026-10-18T07:24:00Z"))).toBe("12:24 am PDT Sun");
    expect(localLabel("2026-12-01 13:05", PDT, Date.parse("2026-12-01T21:05:00Z"))).toBe("1:05 pm PST Tue");
  });
});

describe("parsing", () => {
  it("draws every station in view nearest the centre first, and times the nearest live gauges first then the nearest", () => {
    const ordered = orderedStations(stations, BAY);
    expect(ordered).toHaveLength(60);
    expect(ordered.map((s) => s.id)).not.toContain("8518750");
    const timed = pickTimed(ordered, live);
    expect(timed).toHaveLength(TIMED_STATIONS);
    expect(LIVE_FIRST).toBeGreaterThan(0);
    // Golden Gate is not among the 24 nearest Hunters Point, but it is a live gauge.
    expect(ordered.slice(0, TIMED_STATIONS).map((s) => s.id)).not.toContain("9414290");
    expect(timed.map((s) => s.id)).toContain("9414290");
    expect(timed[0].id).toBe(ordered[0].id);
  });

  it("lists highs and lows in local time, upcoming soonest first", () => {
    const events = tideEvents(hiloFixture, PDT);
    expect(events[0]).toMatchObject({ time: Date.parse("2026-10-17T13:48:00Z"), height: 4.25, type: "high", local: "6:48 am PDT Sat" });
    const next = upcomingEvents(events, NOW);
    expect(next[0]).toMatchObject({ type: "low", height: 0.631, local: "11:38 pm PDT Sat" });
    expect(eventText(next[0])).toBe("Low 0.6 ft at 11:38 pm PDT Sat");
    expect(eventText(next[1])).toBe("High 4.4 ft at 7:47 am PDT Sun");
    expect(tideEvents(NO_DATA, PDT)).toEqual([]);
  });

  it("reads heights between highs and lows with NOAA's cosine rule, close to NOAA's own hourly heights", () => {
    const events = tideEvents(hiloFixture, PDT);
    expect(heightAt(events, events[3].time)).toBeCloseTo(0.631, 2);
    const mid = (events[3].time + events[4].time) / 2;
    expect(heightAt(events, mid)).toBeCloseTo((0.631 + 4.353) / 2, 2);
    expect(heightAt(events, events[0].time - 3_600_000)).toBeNull();
    const times = frameTimes(NOW);
    const noaa = hourlyOnFrames(hourlyFixture, PDT, times);
    const ours = times.map((t) => heightAt(events, Date.parse(t)));
    const worst = Math.max(...noaa.map((v, k) => Math.abs((v ?? 0) - (ours[k] ?? 0))));
    expect(worst).toBeLessThan(0.5);
  });

  it("puts NOAA's hourly heights on 48 hourly frames from the current hour", () => {
    const times = frameTimes(NOW);
    expect(times).toHaveLength(FRAMES);
    expect(times[0]).toBe("2026-10-18T06:00:00.000Z");
    const values = hourlyOnFrames(hourlyFixture, PDT, times);
    expect(values[0]).toBe(Math.round(Number(hourlyFixture.predictions[0].v) * 100) / 100);
    expect(values.every((v) => typeof v === "number")).toBe(true);
    expect(hourlyOnFrames(NO_DATA, PDT, times).every((v) => v === null)).toBe(true);
  });

  it("reads the latest water level in local time and ignores errors and stale readings", () => {
    expect(observedLevel(wlFixture, PDT, NOW)).toEqual({ time: Date.parse("2026-10-18T06:24:00Z"), height: 1.576, local: "11:24 pm PDT Sat" });
    expect(observedLevel(NO_DATA, PDT, NOW)).toBeUndefined();
    expect(observedLevel(wlFixture, PDT, new Date("2026-10-18T12:00:00Z"))).toBeUndefined();
  });

  it("builds a station point with the height now and per hour, four tides as rows, and the live level", () => {
    const f = tideFeature(goldenGate, true, tideEvents(hiloFixture, PDT), observedLevel(wlFixture, PDT, NOW), NOW, frameTimes(NOW));
    expect(f?.properties).toMatchObject({
      stationId: "9414290",
      kind: "live",
      nextType: "low",
      nextAt: "2026-10-18T06:38:00.000Z",
      v: 0.631,
      tide1: "Low 0.6 ft at 11:38 pm PDT Sat",
      tide2: "High 4.4 ft at 7:47 am PDT Sun",
      trend: "Falling toward low tide",
      thenType: "high",
      observedNow: 1.576,
      observedLocal: "11:24 pm PDT Sat",
    });
    expect(f?.properties?.tide4).toMatch(/^High .* PDT Sun$/);
    expect(f?.properties?.t).toBeUndefined();
    expect(f?.properties?.level).toBeCloseTo(0.63, 1);
    expect((f?.properties?.series as { level: unknown[] }).level).toHaveLength(FRAMES);
    expect(tideFeature(goldenGate, true, [], undefined, NOW, frameTimes(NOW))).toBeNull();
  });
});

describe("tides layer", () => {
  it("draws every station in view, times 24 with local-time requests cached per local day, and plays 48 hourly frames", async () => {
    const stub = routedStub();
    const r = await layer.query(ctx(stub), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(60);
    const timed = r.data.features.filter((f) => typeof f.properties?.tide1 === "string");
    expect(timed).toHaveLength(TIMED_STATIONS);
    expect(r.data.features.slice(0, TIMED_STATIONS)).toEqual(timed);
    const rest = r.data.features.slice(TIMED_STATIONS);
    expect(rest.every((f) => typeof f.properties?.noTimes === "string" && ["live", "prediction"].includes(String(f.properties?.kind)))).toBe(true);
    expect(r.coverageNote).toMatch(/^Tide times at the 24 stations nearest the centre \(live gauges first\); the other 36 are drawn without times/);

    const c = calls(stub);
    expect(c[0][1]).toMatchObject({ cacheKey: "tides:stations:predictions", ttlSeconds: 86_400 });
    const hilo = c.filter((x) => x[0].includes("interval=hilo"));
    expect(hilo).toHaveLength(TIMED_STATIONS);
    const u = new URL(hilo[0][0]);
    expect(u.searchParams.get("time_zone")).toBe("lst_ldt");
    expect(u.searchParams.get("datum")).toBe("MLLW");
    expect(u.searchParams.get("units")).toBe("english");
    // 11:30 pm Saturday Oct 17 in San Francisco: from local midnight the day before.
    expect(u.searchParams.get("begin_date")).toBe("20261016");
    expect(hilo[0][1].cacheKey).toMatch(/^tides:hilo:v2:\d+:20261016$/);
    expect(hilo[0][1].ttlSeconds).toBe(6 * 3600);

    expect(r.series).toMatchObject({ step: "hour", now: 0 });
    expect(r.series?.times).toHaveLength(FRAMES);
    expect(timeShapeOf(layer, r)).toMatchObject({ shape: "continuous", step: "hour" });
  });

  it("links the central harmonic station's NOAA hourly curve on the scrubber's frames", async () => {
    const stub = routedStub();
    const r = await layer.query(ctx(stub), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const hourly = calls(stub).filter((x) => x[0].includes("interval=h&"));
    expect(hourly).toHaveLength(1);
    const centre = orderedStations(stations, BAY).find((s) => s.type === "R")!;
    expect(hourly[0][0]).toContain(`station=${centre.id}&`);
    expect(r.linked).toMatchObject({ label: "Tide height", unit: "ft", place: centre.name });
    expect(r.linked?.times).toEqual(r.series?.times);
    expect(r.linked?.values[0]).toBe(Math.round(Number(hourlyFixture.predictions[0].v) * 100) / 100);
  });

  it("falls back to the nearest timed station's curve when the hourly call fails", async () => {
    const stub = vi.fn(async (url: string) => (url.includes("interval=h&") ? json(NO_DATA) : routedStub()(url)));
    const r = await layer.query(ctx(stub), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.linked?.place).toBe(r.data.features[0].properties?.name);
    expect(r.linked?.values.filter((v) => v !== null).length).toBeGreaterThan(40);
  });

  it("asks for observed water level only at live gauges among the timed stations", async () => {
    const stub = routedStub();
    const r = await layer.query(ctx(stub), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const wl = calls(stub).filter((x) => x[0].includes("product=water_level"));
    expect(wl.length).toBe(3);
    for (const [url, init] of wl) {
      expect(url).toContain("date=latest");
      expect(url).toContain("time_zone=lst_ldt");
      expect(init.ttlSeconds).toBe(360);
      expect(typeof init.shouldCache).toBe("function");
    }
    const gg = r.data.features.find((f) => f.properties?.stationId === "9414290");
    expect(gg?.properties).toMatchObject({ kind: "live", observedNow: 1.576, observedLocal: "11:24 pm PDT Sat" });
  });

  it("returns a note and no station calls when nothing is in view", async () => {
    const stub = routedStub();
    const r = await layer.query(ctx(stub, [-123.5, 36.0, -123.3, 36.2]), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toMatch(/No NOAA tide stations/);
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("skips upstream outside the US and maps a failed station list to an upstream error", async () => {
    const none = vi.fn();
    const r = await layer.query(ctx(none, [2, 45, 3, 46]), {});
    expect(none).not.toHaveBeenCalled();
    expect(r).toMatchObject({ coverageNote: "No data outside the United States" });

    const down = vi.fn(async () => new Response("no", { status: 502 }));
    expect(await layer.query(ctx(down), {})).toMatchObject({ hint: "upstream" });
  });

  it("errors when every station's predictions fail, and notes partial failures", async () => {
    const predDown = vi.fn(async (url: string) => {
      if (url.includes("type=tidepredictions")) return json(stationsFixture);
      if (url.includes("type=waterlevels")) return json(waterlevelsFixture);
      return new Response("busy", { status: 503 });
    });
    expect(await layer.query(ctx(predDown), {})).toMatchObject({ hint: "upstream" });

    let n = 0;
    const someDown = vi.fn(async (url: string) => {
      if (url.includes("interval=hilo") && n++ === 0) return new Response("busy", { status: 503 });
      return routedStub()(url);
    });
    const r = await layer.query(ctx(someDown), {});
    expect(r).toMatchObject({ kind: "geojson" });
    expect((r as { coverageNote?: string }).coverageNote).toMatch(/1 station did not answer/);
  });

  it("describes units, datum, local time and the user's words", () => {
    for (const word of ["tide", "low tide", "high tide", "feet", "MLLW", "local time", "observedNow", "tide1"]) {
      expect(layer.description).toContain(word);
    }
    expect(layer.license).toBe("Public domain (NOAA CO-OPS)");
    expect(layer.style).toMatchObject({ geometry: "point", unit: "ft", series: "hour", encode: { size: "level" } });
    expect(layer.coverage).toBe("us");
  });

  it("declares station kind chips, a continuous hourly time, the size legend, labels and US units", () => {
    const kind = layer.attributes?.find((a) => a.key === "kind");
    expect(kind).toMatchObject({ type: "category", primary: true });
    expect(kind?.levels?.map((l) => l.label)).toEqual(["Live gauge", "Predictions only"]);
    expect(layer.attributes?.find((a) => a.key === "level")).toMatchObject({ type: "measure", unit: "ft", encode: "size" });
    expect(layer.time).toEqual({ shape: "continuous", step: "hour" });
    expect(layer.legend).toMatchObject({ kind: "size", field: "level" });
    expect(layer.labels).toMatchObject({ field: "name" });
    expect(layer.display).toEqual({ units: "us", timeZone: "local" });
    expect(layer.card?.measure?.key).toBe("level");
    expect(layer.card?.facts?.slice(0, 4).map((f) => f.key)).toEqual(["tide1", "tide2", "tide3", "tide4"]);
    expect(layer.card?.hidden).toEqual(expect.arrayContaining(["stationId", "series"]));
  });

  it("rejects only a box bigger than the whole US through runLayer", async () => {
    const res = await runLayer("tides", { bbox: [-180, -60, 180, 80] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ hint: "zoom_in", error: expect.stringMatching(/under 50000000 km²$/) });
  });
});

describe("tides wide mode (over 50,000 km²)", () => {
  /** The fixture's 60 Bay stations sit inside this box (and The Battery outside it). */
  const BAY_AREA: [number, number, number, number] = [-124, 36.5, -121, 39];

  it("declares every station up to 1,000, nearest the centre first, up to the whole US", () => {
    expect(layer.wide).toEqual({ orderBy: "distance from the centre", limit: 1000, rank: "nearest" });
    expect(WIDE_LIMIT).toBe(1000);
    expect(layer.hardMaxAreaKm2).toBe(50_000_000);
    expect(hardMaxAreaKm2(layer)).toBe(50_000_000);
    expect(layer.description).toMatch(/over 50,000 km² the rest \(up to 1,000\) are listed without times/);
  });

  it("times 24 stations and lists the rest without times", async () => {
    const stub = routedStub();
    const r = await layer.query({ ...ctx(stub, BAY_AREA), wide: true, wideStrategy: layer.wide }, {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(calls(stub).filter((x) => x[0].includes("interval=hilo"))).toHaveLength(TIMED_STATIONS);
    expect(r.data.features).toHaveLength(60);
    const timed = r.data.features.filter((f) => typeof f.properties?.tide1 === "string");
    expect(r.data.features.slice(0, TIMED_STATIONS)).toEqual(timed);
    expect(r.data.features.slice(TIMED_STATIONS).every((f) => /wide/.test(String(f.properties?.noTimes)))).toBe(true);
    expect(r.total).toBeUndefined();
  });

  it("cuts at the limit, timed stations first, and counts every station", () => {
    const station = (id: string) => ({ id, name: id, lat: 37, lng: -122, state: "CA", type: "S" });
    const timed = [1.2, 5.3].map((v, i) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [-122, 37] },
      properties: { name: `q${i}`, v },
    }));
    const out = wideStations(timed, [station("a"), station("b"), station("c")], new Set(["b"]), 3);
    expect(out.total).toBe(5);
    expect(out.features.map((f) => f.properties?.name)).toEqual(["q0", "q1", "a"]);
    const all = wideStations(timed, [station("a"), station("b")], new Set(["b"]), 10);
    expect(all.total).toBeUndefined();
    expect(all.features[3].properties).toMatchObject({ kind: "live", stationId: "b" });
  });
});
