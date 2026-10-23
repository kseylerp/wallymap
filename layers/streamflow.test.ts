import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { cardContent } from "@/lib/render/card";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import layer, {
  gaugeName,
  MAX_IV_STRIPS,
  WIDE_LIMIT,
  floodFeatures,
  floodSampleLocations,
  ivFeatures,
  joinGauges,
  namedRiverCount,
  RIVER_POINTS,
  parseDailyStats,
  flowClass,
  FLOW_CLASSES,
  riverSamplePoints,
  keepLargest,
  statSites,
  STAT_SITE_CAP,
  waterTempText,
} from "./streamflow";
import { hardMaxAreaKm2 } from "./types";
import { cardTitle, displayOf, labelsOf, legendOf, timeShapeOf } from "./contract";
import { ivStrips, parseIv } from "./_shared/usgs";
import latestFixture from "./__fixtures__/usgs-latest.tahoe.json";
import locationsFixture from "./__fixtures__/usgs-locations.tahoe.json";
import ivFixture from "./__fixtures__/usgs-iv.tahoe.json";
import riversFixture from "./__fixtures__/osm-rivers.lyon.json";
import glofasFixture from "./__fixtures__/glofas.lyon.json";

/**
 * The IV fixture was recorded 2026-10-10 ~02:08 UTC (Oct 9 evening Pacific) for TAHOE; the statistics (statTypeCd=all,
 * recorded 2026-10-18 for the same gauges) are trimmed to Oct 8-10.
 */
const statRdb = readFileSync(join(__dirname, "__fixtures__/streamflow-stat.tahoe.rdb"), "utf8");

const latest = latestFixture as unknown as { features: unknown[] };
const locations = locationsFixture as unknown as { features: unknown[] };

/** Lake Tahoe area; the fixtures were recorded for this bbox on 2026-10-09 around 18:45 UTC. */
const TAHOE: [number, number, number, number] = [-120.6, 38.6, -119.8, 39.3];
const FLOW = { parameter: "00060" } as const;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function ctx(stub: ReturnType<typeof vi.fn>, opts: { cacheKey?: string; bbox?: typeof TAHOE; env?: Record<string, string> } = {}) {
  return {
    bbox: opts.bbox ?? TAHOE,
    zoom: 9,
    env: opts.env ?? {},
    fetch: stub as unknown as CachedFetch,
    cacheKey: opts.cacheKey,
  };
}

function param(url: unknown, name: string): string | null {
  return new URL(String(url)).searchParams.get(name);
}

function callsOf(stub: ReturnType<typeof vi.fn>): [string, { cacheKey?: string; headers?: Record<string, string> }][] {
  return stub.mock.calls as unknown as [string, { cacheKey?: string; headers?: Record<string, string> }][];
}

const NOW = new Date("2026-10-09T19:00:00Z");
/** Just after the IV and stat fixtures were recorded. */
const IV_NOW = new Date("2026-10-10T02:10:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("joinGauges", () => {
  it("joins each recent reading to its gauge name by monitoring location id", () => {
    const fc = joinGauges(latest, locations, NOW);
    expect(fc.features).toHaveLength(18);
    const truckee = fc.features.find((f) => f.properties?.siteId === "USGS-10338000");
    expect(truckee?.properties).toEqual({
      name: "Truckee River near Truckee, CA",
      nameInSource: "TRUCKEE R NR TRUCKEE CA",
      siteId: "USGS-10338000",
      t: "2026-10-09T18:15:00.000Z",
      v: 70.3,
    });
    expect(truckee?.geometry.type).toBe("Point");
  });

  it("leaves out gauges whose latest reading is more than 7 days old", () => {
    const ids = joinGauges(latest, locations, NOW).features.map((f) => f.properties?.siteId);
    // These sites only have readings from 2011, 1998 and so on in the fixture.
    expect(ids).not.toContain("USGS-10336740");
    expect(ids).not.toContain("USGS-10310358");
  });

  it("keeps only the newest reading when a site has several time series", () => {
    const point = { type: "Point", coordinates: [-120, 39] };
    const row = (time: string, value: string) => ({
      type: "Feature",
      geometry: point,
      properties: { monitoring_location_id: "USGS-1", time, value },
    });
    const fc = joinGauges(
      { features: [row("2026-10-09T10:00:00+00:00", "5"), row("2026-10-09T18:00:00+00:00", "7")] },
      { features: [] },
      NOW,
    );
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toMatchObject({ v: 7, t: "2026-10-09T18:00:00.000Z" });
  });

  it("parses string values and falls back to the site id when a name is missing", () => {
    const row = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-120, 39] },
      properties: { monitoring_location_id: "USGS-2", time: "2026-10-09T18:00:00+00:00", value: "12.50" },
    };
    const fc = joinGauges({ features: [row] }, { features: [] }, NOW);
    expect(fc.features[0].properties).toEqual({
      name: "USGS-2",
      siteId: "USGS-2",
      t: "2026-10-09T18:00:00.000Z",
      v: 12.5,
    });
  });

  it("skips readings with a non-numeric value or no point geometry", () => {
    const base = { monitoring_location_id: "USGS-3", time: "2026-10-09T18:00:00+00:00" };
    const features = [
      { type: "Feature", geometry: { type: "Point", coordinates: [-120, 39] }, properties: { ...base, value: "Ice" } },
      { type: "Feature", geometry: null, properties: { ...base, monitoring_location_id: "USGS-4", value: "3" } },
      { type: "Feature", geometry: { type: "Point", coordinates: [-120, 39] }, properties: { ...base, monitoring_location_id: "USGS-5", value: null } },
    ];
    expect(joinGauges({ features }, { features: [] }, NOW).features).toHaveLength(0);
  });
});

describe("gaugeName", () => {
  it("titles USGS station names in plain words, with the state kept at the end", () => {
    expect(gaugeName("TRUCKEE R A FARAD CA")).toBe("Truckee River at Farad, CA");
    expect(gaugeName("GRANITE C AB GRANITE C SUPPLEMENTAL, NR MOOSE, WY")).toBe("Granite Creek above Granite Creek Supplemental, near Moose, WY");
    expect(gaugeName("W FK CARSON RV AT MULLER LN NR MINDEN, NV")).toBe("West Fork Carson River at Muller Lane near Minden, NV");
    expect(gaugeName("FLAT CREEK BELOW CACHE CREEK, NEAR JACKSON, WY")).toBe("Flat Creek below Cache Creek, near Jackson, WY");
    expect(gaugeName("PILOT C AB STUMPY MEADOWS RES CA")).toBe("Pilot Creek above Stumpy Meadows Reservoir, CA");
    expect(gaugeName("TROUT CK AT USFS RD 12N01 NR MEYERS, CA")).toBe("Trout Creek at USFS Road 12N01 near Meyers, CA");
    expect(gaugeName("BEAR C TRIB BL DAM NR X, UT")).toBe("Bear Creek Tributary below Dam near X, UT");
  });

  it("keeps a name already in ordinary capitals and a bare site id", () => {
    expect(gaugeName("Gros Ventre River at Kelly")).toBe("Gros Ventre River at Kelly");
    expect(gaugeName("USGS-2")).toBe("USGS-2");
  });

  it("titles the card in plain words and keeps USGS's capitals off it", () => {
    const fc = joinGauges(latest, locations, NOW);
    const truckee = fc.features.find((f) => f.properties?.siteId === "USGS-10338000");
    if (!truckee) throw new Error("expected the Truckee gauge");
    expect(cardTitle(layer, truckee)).toBe("Truckee River near Truckee, CA");
    const card = cardContent(truckee, { card: layer.card, fieldHelp: layer.fieldHelp });
    const rows = [...card.facts, ...card.details];
    expect(rows.map((r) => r.key)).not.toContain("nameInSource");
    expect(rows.some((r) => r.value === "TRUCKEE R NR TRUCKEE CA")).toBe(false);
  });
});

describe("parseIv and ivStrips", () => {
  it("reads each site's newest discharge and water temperature", () => {
    const sites = parseIv([ivFixture], IV_NOW);
    const upper = sites.find((s) => s.siteNo === "10336610");
    expect(upper?.name).toBe("UPPER TRUCKEE RV AT SOUTH LAKE TAHOE, CA");
    expect(upper?.siteId).toBe("USGS-10336610");
    expect(upper?.readings["00060"]?.value).toBeGreaterThan(0);
    expect(upper?.readings["00010"]?.value).toBeGreaterThan(0);
    expect(sites.every((s) => s.coordinates[0] < -119 && s.coordinates[1] > 38)).toBe(true);
  });

  it("drops readings older than 7 days and the no-data value", () => {
    expect(parseIv([ivFixture], new Date("2026-12-31T00:00:00Z"))).toEqual([]);
    const series = {
      sourceInfo: {
        siteName: "X",
        siteCode: [{ value: "1" }],
        geoLocation: { geogLocation: { latitude: 39, longitude: -120 } },
      },
      variable: { variableCode: [{ value: "00060" }], noDataValue: -999999 },
      values: [{ value: [{ value: "-999999", dateTime: "2026-10-09T18:00:00.000-07:00" }] }],
    };
    expect(parseIv([{ value: { timeSeries: [series] } }], IV_NOW)).toEqual([]);
  });

  it("splits a box over 25 square degrees into longitude strips", () => {
    expect(ivStrips([-120, 38, -119, 39])).toEqual([[-120, 38, -119, 39]]);
    const strips = ivStrips([-125, 35, -117, 41]);
    expect(strips).toHaveLength(2);
    for (const [w, s, e, n] of strips) expect((e - w) * (n - s)).toBeLessThanOrEqual(25);
    expect(strips[0][0]).toBe(-125);
    expect(strips[1][2]).toBe(-117);
  });
});

describe("flow vs. normal for the date", () => {
  it("parses each day's record low, percentiles, median, record high and years by site", () => {
    const stats = parseDailyStats(statRdb);
    expect(stats.get("10310000")?.get("10-09")).toEqual({ min: 7.7, p10: 13, p25: 16, p50: 23, p75: 29, p90: 38, max: 82, beginYr: 1901, endYr: 2026, years: 95 });
    expect(stats.get("10336610")?.get("10-09")?.p50).toBe(11);
    expect(parseDailyStats("")).toEqual(new Map());
  });

  it("classes a flow in WaterWatch's percentile classes, with the record low and high beyond them", () => {
    const day = { min: 5, p10: 10, p25: 20, p50: 30, p75: 40, p90: 50, max: 90 };
    expect(flowClass(4, day)).toBe("record_low");
    expect(flowClass(5, day)).toBe("much_below");
    expect(flowClass(15, day)).toBe("below");
    expect(flowClass(20, day)).toBe("normal");
    expect(flowClass(40, day)).toBe("normal");
    expect(flowClass(45, day)).toBe("above");
    expect(flowClass(60, day)).toBe("much_above");
    expect(flowClass(91, day)).toBe("record_high");
    expect(flowClass(30, { p50: 30 })).toBeUndefined();
    expect(FLOW_CLASSES.map((c) => c.value)).toEqual(["record_low", "much_below", "below", "normal", "above", "much_above", "record_high"]);
  });

  it("gives each gauge its class, percent of median, normal range and years for the reading's local day", () => {
    const fc = ivFeatures(parseIv([ivFixture], IV_NOW), "00060", parseDailyStats(statRdb));
    const at = (site: string) => fc.features.find((f) => f.properties?.siteId === `USGS-${site}`)?.properties ?? {};
    expect(at("10310000")).toMatchObject({
      kind: "gauge",
      v: 19.4,
      flowClass: "normal",
      vsNormal: "normal",
      pctOfMedian: 84,
      medianCfs: 23,
      normalRange: "16 to 29 cfs",
      recordYears: "1901 to 2026 (95 years)",
    });
    // 0.05 cfs under the lowest Oct 9 on record (0.08), and 1.00 cfs under the 10th percentile (1.2).
    expect(at("10336730").flowClass).toBe("record_low");
    expect(at("10336730").vsNormal).toBe("low");
    expect(at("10336660").flowClass).toBe("much_below");
    expect(at("103366092").flowClass).toBe("above");
    // No statistics for this gauge: no class, drawn as "No reading".
    expect(at("10348505").flowClass).toBeUndefined();
    const upper = at("10336610");
    expect(upper.tempC).toBe(14.9);
    expect(upper.tempF).toBe(58.8);
    expect(upper.waterTemp).toBe("59 °F (14.9 °C)");
  });

  it("writes water temperature in °F first", () => {
    expect(waterTempText(8.5)).toBe("47 °F (8.5 °C)");
    expect(waterTempText(20)).toBe("68 °F (20.0 °C)");
  });

  it("looks statistics up for every gauge with a discharge reading, largest first up to the cap", () => {
    const sites = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        siteId: `USGS-${i}`,
        siteNo: String(1000 + i),
        name: String(i),
        coordinates: [-120, 39] as [number, number],
        readings: { "00060": { time: 0, local: "2026-10-09T00:00:00-07:00", value: i } },
      }));
    expect(statSites(sites(45))).toHaveLength(45);
    expect(STAT_SITE_CAP).toBeGreaterThanOrEqual(400);
    const capped = statSites(sites(45), 30);
    expect(capped).toHaveLength(30);
    expect(capped).toContain("1044");
    expect(capped).not.toContain("1000");
  });
});

describe("outside the US (GloFAS)", () => {
  it("samples one point per river, longest rivers first", () => {
    const points = riverSamplePoints(riversFixture);
    expect(points.map((p) => p.name)).toEqual(["Le Rhône", "La Saône", "La Reyssouze"]);
    expect(floodSampleLocations(points)).toHaveLength(27);
    expect(namedRiverCount(riversFixture)).toBe(3);
  });

  it("caps the sampled rivers at 12 per view", () => {
    const elements = Array.from({ length: 20 }, (_, i) => ({
      type: "way",
      id: i,
      center: { lat: 46, lon: 5 + i * 0.01 },
      tags: { name: `River ${i}` },
    }));
    expect(RIVER_POINTS).toBe(12);
    expect(riverSamplePoints({ elements })).toHaveLength(12);
    expect(namedRiverCount({ elements })).toBe(20);
  });

  it("keeps the largest discharge of each river's 3 x 3 cells and converts it to cfs", () => {
    const points = riverSamplePoints(riversFixture);
    const fc = floodFeatures(points, glofasFixture, new Date("2026-10-10T03:00:00Z"));
    const rhone = fc.features.find((f) => f.properties?.name === "Le Rhône")?.properties ?? {};
    expect(rhone.kind).toBe("model");
    expect(Number(rhone.dischargeM3s)).toBeGreaterThan(100);
    expect(rhone.v).toBe(Math.round(Number(rhone.dischargeM3s) * 35.3147));
    expect(rhone.t).toBe("2026-10-10T00:00:00.000Z");
  });
});

/** Routes IV, stat and Water Data API calls to their fixtures. */
function liveStub(overrides: { iv?: () => Response } = {}) {
  return vi.fn(async (url: string) => {
    if (url.includes("/nwis/iv/")) return overrides.iv ? overrides.iv() : json(ivFixture);
    if (url.includes("/nwis/stat/")) return new Response(statRdb, { status: 200 });
    if (url.includes("/latest-continuous/")) return json(latest);
    return json(locations);
  });
}

describe("streamflow layer", () => {
  beforeEach(() => {
    vi.setSystemTime(IV_NOW);
  });

  it("asks the IV service for the bbox, discharge plus water temperature, active stream sites", async () => {
    const stub = liveStub();
    const r = await layer.query(ctx(stub, { cacheKey: "streamflow:k" }), FLOW);
    expect(r).toMatchObject({ kind: "geojson" });
    const [ivUrl, ivInit] = callsOf(stub)[0];
    expect(ivUrl).toContain("https://waterservices.usgs.gov/nwis/iv/?");
    expect(param(ivUrl, "bBox")).toBe("-120.6,38.6,-119.8,39.3");
    expect(param(ivUrl, "parameterCd")).toBe("00060,00010");
    expect(param(ivUrl, "siteStatus")).toBe("active");
    expect(param(ivUrl, "siteType")).toBe("ST");
    expect(ivInit.cacheKey).toBe("streamflow:k:usgs-iv");
    expect((ivInit as { ttlSeconds?: number }).ttlSeconds).toBe(600);
  });

  it("fetches every gauge's statistics, 10 sites per call, under a bbox-independent cache key", async () => {
    const stub = liveStub();
    await layer.query(ctx(stub, { cacheKey: "streamflow:k" }), FLOW);
    const stats = callsOf(stub).filter((c) => c[0].includes("/nwis/stat/"));
    expect(stats).toHaveLength(2);
    const asked = stats.flatMap(([url]) => (param(url, "sites") ?? "").split(","));
    expect(asked).toHaveLength(18);
    for (const [url, init] of stats) {
      expect((param(url, "sites") ?? "").split(",").length).toBeLessThanOrEqual(10);
      expect(param(url, "statReportType")).toBe("daily");
      expect(param(url, "statTypeCd")).toBe("all");
      expect(init.cacheKey).toMatch(/^streamflow:stat-all:\d/);
      expect((init as { ttlSeconds?: number }).ttlSeconds).toBe(7 * 86_400);
    }
  });

  it("returns gauges with t, v, a class for the date, pctOfMedian and tempC", async () => {
    const r = await layer.query(ctx(liveStub()), FLOW);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features.length).toBeGreaterThanOrEqual(18);
    const withFlow = r.data.features.filter((f) => typeof f.properties?.v === "number");
    // Every gauge with statistics is classed, not only the largest; one gauge has none.
    expect(withFlow.filter((f) => typeof f.properties?.flowClass === "string")).toHaveLength(withFlow.length - 1);
    expect(r.data.features.some((f) => typeof f.properties?.pctOfMedian === "number")).toBe(true);
    expect(r.data.features.some((f) => typeof f.properties?.tempC === "number")).toBe(true);
    for (const f of r.data.features) {
      const p = f.properties ?? {};
      expect(String(p.siteId)).toMatch(/^USGS-\d+$/);
      expect(new Date(p.t).toISOString()).toBe(p.t);
    }
    expect(r.citation.source).toContain("USGS");
  });

  it("asks for gage height without median lookups", async () => {
    const stub = liveStub();
    await layer.query(ctx(stub), { parameter: "00065" });
    expect(param(callsOf(stub)[0][0], "parameterCd")).toBe("00065,00010");
    expect(callsOf(stub).some((c) => c[0].includes("/nwis/stat/"))).toBe(false);
  });

  it("still answers when the median lookup fails", async () => {
    const stub = vi.fn(async (url: string) =>
      url.includes("/nwis/stat/") ? new Response("bad", { status: 400 }) : json(ivFixture),
    );
    const r = await layer.query(ctx(stub), FLOW);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features.length).toBeGreaterThan(0);
    expect(r.data.features.every((f) => f.properties?.pctOfMedian === undefined && f.properties?.flowClass === undefined)).toBe(true);
    expect(r.coverageNote).toMatch(/statistics service did not answer/);
  });

  it("returns an empty collection with a note when the IV service has no gauges", async () => {
    const stub = vi.fn(async () => json({ value: { timeSeries: [] } }));
    const r = await layer.query(ctx(stub), FLOW);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toMatch(/No active USGS stream gauges/);
  });

  describe("Water Data API fallback when the IV service fails", () => {
    const ivDown = () => new Response("down", { status: 503 });

    it("asks latest-continuous for the bbox, parameter and stream sites, then names for the recent ids", async () => {
      vi.setSystemTime(NOW);
      const stub = liveStub({ iv: ivDown });
      const r = await layer.query(ctx(stub, { cacheKey: "streamflow:k" }), FLOW);
      if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
      expect(r.data.features).toHaveLength(18);
      expect(r.coverageNote).toMatch(/Water Data API/);
      const calls = callsOf(stub).filter((c) => !c[0].includes("/nwis/"));
      const [latestUrl, namesUrl] = calls.map((c) => c[0]);
      expect(param(latestUrl, "bbox")).toBe("-120.6,38.6,-119.8,39.3");
      expect(param(latestUrl, "parameter_code")).toBe("00060");
      expect(param(latestUrl, "site_type_code")).toBe("ST");
      expect(param(namesUrl, "properties")).toBe("id,monitoring_location_name");
      expect(calls.map((c) => c[1].cacheKey)).toEqual(["streamflow:k:usgs-latest", "streamflow:k:usgs-names"]);
    });

    it("sends USGS_API_KEY as X-Api-Key to the Water Data API", async () => {
      vi.setSystemTime(NOW);
      const stub = liveStub({ iv: ivDown });
      await layer.query(ctx(stub, { env: { USGS_API_KEY: "test-key" } }), FLOW);
      for (const c of callsOf(stub).filter((c) => c[0].includes("waterdata"))) {
        expect(c[1].headers).toEqual({ "X-Api-Key": "test-key" });
      }
    });

    it("says so when every gauge's latest reading is old", async () => {
      vi.setSystemTime(new Date("2026-12-31T00:00:00Z"));
      const r = await layer.query(ctx(liveStub({ iv: ivDown })), FLOW);
      if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
      expect(r.data.features).toHaveLength(0);
      expect(r.coverageNote).toMatch(/last 7 days/);
    });

    it("maps a failure of both services to an upstream error", async () => {
      const down = vi.fn(async () => new Response("nope", { status: 500 }));
      expect(await layer.query(ctx(down), FLOW)).toMatchObject({ hint: "upstream" });
    });
  });

  it("outside the United States samples OSM rivers in the GloFAS model", async () => {
    const stub = vi.fn(async (url: string, init?: { body?: string }) => {
      if (url.includes("overpass") || init?.body?.startsWith("data=")) return json(riversFixture);
      return json(glofasFixture);
    });
    const r = await layer.query(ctx(stub, { bbox: [4.7, 45.6, 6.3, 46.3] }), FLOW);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(3);
    const overpassBody = decodeURIComponent(String((stub.mock.calls[0] as unknown as [string, { body: string }])[1].body));
    expect(overpassBody).toContain("(45.6,4.7,46.3,6.3)");
    expect(overpassBody).toContain("out center tags 3000;");
    expect(r.data.features.every((f) => f.properties?.kind === "model")).toBe(true);
    expect(r.coverageNote).toMatch(/modelled/);
    expect(r.citation.source).toMatch(/non-commercial/);
    const floodUrl = callsOf(stub).map((c) => c[0]).find((u) => u.includes("flood-api.open-meteo.com"));
    expect(param(floodUrl, "daily")).toBe("river_discharge");
    expect((param(floodUrl, "latitude") ?? "").split(",")).toHaveLength(27);
  });

  it("states what the number means, how fresh it is and the user words", () => {
    expect(layer.description).toMatch(/cubic feet per second/i);
    expect(layer.description).toMatch(/gage height/i);
    expect(layer.description).toMatch(/percent of the median|pctOfMedian/i);
    expect(layer.description).toMatch(/flowClass/);
    expect(layer.description).toMatch(/running high/i);
    expect(layer.description).toMatch(/CFS/);
    expect(layer.description).toMatch(/provisional/i);
    expect(layer.description).not.toMatch(/30 largest/);
    expect(layer.style).toEqual({ geometry: "point", color: "#3A3A3C", unit: "cfs", encode: { size: "v", color: "flowClass" } });
    expect(layer.coverage).toBe("global");
    expect(layer.license).toMatch(/Public domain \(USGS\)/);
    expect(layer.license).toMatch(/non-commercial/);
    expect(layer.maxAreaKm2).toBe(400_000);
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.optionalEnv).toEqual(["USGS_API_KEY", "OVERPASS_URL"]);
  });

  it("declares one reading per gauge, a key for every class plus No reading, labels and US units", async () => {
    const r = await layer.query(ctx(liveStub()), FLOW);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(timeShapeOf(layer, r).shape).toBe("single");
    const legend = legendOf(layer, r);
    expect(legend.kind).toBe("categories");
    expect(legend.field).toBe("flowClass");
    expect(legend.items?.map((i) => i.label)).toEqual([
      "Lowest on record for the date",
      "Much below normal",
      "Below normal",
      "Normal",
      "Above normal",
      "Much above normal",
      "Highest on record for the date",
      "No reading",
    ]);
    expect(labelsOf(layer)).toEqual({ field: "name", max: 5, rankBy: "v" });
    expect(displayOf(layer).units).toBe("us");
    const chips = layer.attributes?.find((a) => a.primary);
    expect(chips?.key).toBe("flowClass");
    expect(layer.attributes?.find((a) => a.key === "kind")?.levels?.map((l) => l.label)).toEqual(["USGS gauge", "Modelled river", "NWS river gauge", "Dam release"]);
    const woodfords = r.data.features.find((f) => f.properties?.siteId === "USGS-10310000")!;
    expect(cardTitle(layer, woodfords)).toBe("West Fork Carson River at Woodfords, CA");
    const running = layer.card?.facts?.find((f) => f.key === "flowClass");
    expect(running?.values?.normal).toBe("Normal (25th to 75th percentile for the date)");
    expect(layer.card?.facts?.map((f) => f.key)).toContain("pctOfMedian");
    expect(layer.card?.hidden).toEqual(expect.arrayContaining(["tempC", "tempF", "vsNormal"]));
  });

  it("rejects a box over the hard cap and bad input through runLayer", async () => {
    const big = await runLayer("streamflow", { bbox: [-125, 31, -110, 49], zoom: 4 });
    expect(big.status).toBe(422);
    expect(big.body).toMatchObject({ hint: "zoom_in", error: expect.stringMatching(/under 1600000 km²$/) });
    const bad = await runLayer("streamflow", { bbox: TAHOE, input: { parameter: "00010" } });
    expect(bad.status).toBe(400);
  });
});

/** One synthetic IV discharge series for a site, read at 2026-10-09 18:45 Pacific. */
function ivSeries(siteNo: string, lon: number, lat: number, cfs: number) {
  return {
    sourceInfo: { siteName: `GAUGE ${siteNo}`, siteCode: [{ value: siteNo }], geoLocation: { geogLocation: { latitude: lat, longitude: lon } } },
    variable: { variableCode: [{ value: "00060" }], noDataValue: -999999 },
    values: [{ value: [{ value: String(cfs), dateTime: "2026-10-09T18:45:00.000-07:00" }] }],
  };
}

describe("streamflow wide mode (over 400,000 km²)", () => {
  beforeEach(() => {
    vi.setSystemTime(IV_NOW);
  });

  it("declares every gauge up to 1,000, highest flow first, under the default hard cap", () => {
    expect(layer.wide).toEqual({ orderBy: "current flow or gage height", limit: 1000 });
    expect(WIDE_LIMIT).toBe(1000);
    expect(layer.hardMaxAreaKm2).toBeUndefined();
    expect(hardMaxAreaKm2(layer)).toBe(1_600_000);
    expect(layer.description).toMatch(/Over 400,000 km² it returns up to 1,000 gauges, highest flow first/);
    expect(layer.description).not.toMatch(/Needs a region under/);
  });

  it("keeps the largest v when more gauges than the limit are in the box, and counts them all", () => {
    const fc = {
      type: "FeatureCollection" as const,
      features: [3, undefined, 10, 1].map((v, i) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [i, 0] },
        properties: v === undefined ? { name: `g${i}` } : { name: `g${i}`, v },
      })),
    };
    const cut = keepLargest(fc, 2);
    expect(cut.total).toBe(4);
    expect(cut.data.features.map((f) => f.properties?.v)).toEqual([10, 3]);
    expect(keepLargest(fc, 4)).toEqual({ data: fc });
  });

  it("splits a wide box into IV strips, ranks by flow, cuts at the limit and sets total", async () => {
    const stub = vi.fn(async (url: string) => {
      if (!url.includes("/nwis/iv/")) return new Response("no", { status: 400 });
      const [w, s] = (param(url, "bBox") ?? "").split(",").map(Number);
      return json({ value: { timeSeries: [ivSeries(`${Math.abs(w)}1`, w + 0.5, s + 0.5, Math.round(200 - w)), ivSeries(`${Math.abs(w)}2`, w + 1, s + 1, 5)] } });
    });
    const bbox: typeof TAHOE = [-112, 36, -102, 42];
    const r = await layer.query({ ...ctx(stub, { bbox }), wide: true, wideStrategy: { ...layer.wide!, limit: 3 } }, FLOW);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const ivCalls = callsOf(stub).filter((c) => c[0].includes("/nwis/iv/"));
    expect(ivCalls).toHaveLength(3);
    expect(r.total).toBe(6);
    // One big gauge per strip (200 - west edge) outranks the three 5 cfs ones.
    expect(r.data.features.map((f) => f.properties?.v)).toEqual([312, 309, 305]);
    expect(r.coverageNote ?? "").not.toMatch(/zoom in for the rest$/);
  });

  it("refuses a far-north box that would need more than the strip cap, without fetching", async () => {
    const stub = vi.fn();
    const r = await layer.query({ ...ctx(stub, { bbox: [-170, 55, -128, 72] }), wide: true, wideStrategy: layer.wide }, FLOW);
    expect(r).toMatchObject({ hint: "zoom_in", error: expect.stringMatching(new RegExp(`at most ${MAX_IV_STRIPS}`)) });
    expect(stub).not.toHaveBeenCalled();
  });

  it("answers a 600,000 km² box through runLayer with a wide note instead of zoom_in", async () => {
    const stub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes("/nwis/iv/")) return new Response("no", { status: 400 });
      const [w, s] = (param(url, "bBox") ?? "").split(",").map(Number);
      return json({ value: { timeSeries: [ivSeries(`${Math.abs(Math.round(w))}9`, w + 0.5, s + 0.5, 42)] } });
    });
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("streamflow", { bbox: [-112.5, 36.5, -102.5, 42.5], zoom: 5 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ coverageNote: expect.stringMatching(/^Showing all 3 in this wide view \(ranked by current flow or gage height\)/) });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
