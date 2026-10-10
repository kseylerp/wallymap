import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import layer, {
  floodFeatures,
  floodSampleLocations,
  ivFeatures,
  joinGauges,
  parseDailyMedians,
  riverSamplePoints,
  statSites,
  STAT_SITE_CAP,
} from "./streamflow";
import { ivStrips, parseIv } from "./_shared/usgs";
import latestFixture from "./__fixtures__/usgs-latest.tahoe.json";
import locationsFixture from "./__fixtures__/usgs-locations.tahoe.json";
import ivFixture from "./__fixtures__/usgs-iv.tahoe.json";
import riversFixture from "./__fixtures__/osm-rivers.lyon.json";
import glofasFixture from "./__fixtures__/glofas.lyon.json";

/** Recorded 2026-10-10 ~02:08 UTC (Oct 9 evening Pacific) for TAHOE; the stat file is trimmed to Oct 8-10. */
const statRdb = readFileSync(join(__dirname, "__fixtures__/usgs-stat.tahoe.rdb"), "utf8");

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
      name: "TRUCKEE R NR TRUCKEE CA",
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

describe("percent of median", () => {
  it("parses daily medians by site and calendar day", () => {
    const medians = parseDailyMedians(statRdb);
    expect(medians.get("10310000")?.get("10-09")).toBe(23);
    expect(medians.get("10336610")?.get("10-09")).toBe(11);
    expect(parseDailyMedians("")).toEqual(new Map());
  });

  it("adds pctOfMedian, medianCfs and vsNormal for the reading's local day", () => {
    const fc = ivFeatures(parseIv([ivFixture], IV_NOW), "00060", parseDailyMedians(statRdb));
    const woodfords = fc.features.find((f) => f.properties?.siteId === "USGS-10310000")?.properties ?? {};
    expect(woodfords.medianCfs).toBe(23);
    expect(woodfords.pctOfMedian).toBe(Math.round((Number(woodfords.v) / 23) * 100));
    expect(["low", "normal", "high"]).toContain(woodfords.vsNormal);
    expect(woodfords.kind).toBe("gauge");
    const upper = fc.features.find((f) => f.properties?.siteId === "USGS-10336610")?.properties ?? {};
    expect(typeof upper.tempC).toBe("number");
  });

  it("labels low under 50% and high over 150%", () => {
    const site = (v: number) => ({
      siteId: "USGS-1",
      siteNo: "1",
      name: "A",
      coordinates: [-120, 39] as [number, number],
      readings: { "00060": { time: IV_NOW.getTime(), local: "2026-10-09T18:00:00.000-07:00", value: v } },
    });
    const medians = new Map([["1", new Map([["10-09", 100]])]]);
    const label = (v: number) => ivFeatures([site(v)], "00060", medians).features[0].properties?.vsNormal;
    expect(label(40)).toBe("low");
    expect(label(100)).toBe("normal");
    expect(label(200)).toBe("high");
  });

  it("looks medians up for the largest-flow gauges only, capped", () => {
    const sites = Array.from({ length: 45 }, (_, i) => ({
      siteId: `USGS-${i}`,
      siteNo: String(1000 + i),
      name: String(i),
      coordinates: [-120, 39] as [number, number],
      readings: { "00060": { time: 0, local: "2026-10-09T00:00:00-07:00", value: i } },
    }));
    const chosen = statSites(sites);
    expect(chosen).toHaveLength(STAT_SITE_CAP);
    expect(chosen).toContain("1044");
    expect(chosen).not.toContain("1000");
  });
});

describe("outside the US (GloFAS)", () => {
  it("samples one point per river, longest rivers first", () => {
    const points = riverSamplePoints(riversFixture);
    expect(points.map((p) => p.name)).toEqual(["Le Rhône", "La Saône", "La Reyssouze"]);
    expect(floodSampleLocations(points)).toHaveLength(27);
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

  it("fetches medians 10 sites per call under a bbox-independent cache key", async () => {
    const stub = liveStub();
    await layer.query(ctx(stub, { cacheKey: "streamflow:k" }), FLOW);
    const stats = callsOf(stub).filter((c) => c[0].includes("/nwis/stat/"));
    expect(stats).toHaveLength(2);
    for (const [url, init] of stats) {
      expect((param(url, "sites") ?? "").split(",").length).toBeLessThanOrEqual(10);
      expect(param(url, "statReportType")).toBe("daily");
      expect(param(url, "statTypeCd")).toBe("median");
      expect(init.cacheKey).toMatch(/^streamflow:stat:\d/);
    }
  });

  it("returns gauges with t, v, pctOfMedian and tempC", async () => {
    const r = await layer.query(ctx(liveStub()), FLOW);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features.length).toBeGreaterThanOrEqual(18);
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
    expect(r.data.features.every((f) => f.properties?.pctOfMedian === undefined)).toBe(true);
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
    expect(layer.description).toMatch(/running high/i);
    expect(layer.description).toMatch(/CFS/);
    expect(layer.description).toMatch(/provisional/i);
    expect(layer.style).toEqual({ geometry: "point", color: "#3A3A3C", unit: "cfs" });
    expect(layer.coverage).toBe("global");
    expect(layer.license).toMatch(/Public domain \(USGS\)/);
    expect(layer.license).toMatch(/non-commercial/);
    expect(layer.maxAreaKm2).toBe(400_000);
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.optionalEnv).toEqual(["USGS_API_KEY", "OVERPASS_URL"]);
  });

  it("rejects an oversized bbox and bad input through runLayer", async () => {
    const big = await runLayer("streamflow", { bbox: [-125, 31, -110, 49], zoom: 4 });
    expect(big.status).toBe(422);
    const bad = await runLayer("streamflow", { bbox: TAHOE, input: { parameter: "00010" } });
    expect(bad.status).toBe(400);
  });
});
