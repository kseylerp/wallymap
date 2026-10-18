import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { attributeProblems } from "./attributes";
import { cardTitle, contractProblems, displayOf, legendOf, timeShapeOf } from "./contract";
import esriFixture from "./__fixtures__/weather-alerts-esri.outer-banks.json";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, {
  ESRI_ALERTS,
  esriAlertFeatures,
  esriOffset,
  isMarine,
  isWithdrawn,
  shortAreas,
  untilText,
  alertFeatures,
  MAX_ZONE_FETCHES,
  nowFeature,
  parseAlerts,
  samplePoints,
  setPointMissCache,
  statesFor,
  weatherWords,
  WIDE_GRID,
  WIDE_LIMIT,
  zonesFromPoint,
  zonesToFetch,
} from "./weather-alerts";
import alertsFixture from "./__fixtures__/nws-alerts.ca-nv.json";
import pointsFixture from "./__fixtures__/nws-points.tahoe.json";
import zonesFixture from "./__fixtures__/nws-zones.tahoe.json";
import nowFixture from "./__fixtures__/openmeteo-now.tahoe.json";
import { hardMaxAreaKm2 } from "./types";

/**
 * Recorded 2026-10-10 ~02:28 UTC: /alerts/active?area=CA,NV trimmed to 10 of 46 alerts (those touching Tahoe
 * zones, every polygon alert, three others), the 9 /points answers for the Tahoe grid, those zones' shapes,
 * and Open-Meteo current conditions at the centre.
 */
const TAHOE: [number, number, number, number] = [-120.6, 38.6, -119.8, 39.3];
const points = pointsFixture as Record<string, unknown>;
const zones = zonesFixture as Record<string, { geometry: Polygon | MultiPolygon }>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function routedStub(down: string[] = []) {
  return vi.fn(async (url: string) => {
    if (url.includes("open-meteo")) return down.includes("now") ? json({}, 503) : json(nowFixture);
    if (url.includes("/alerts/active")) return down.includes("alerts") ? json({}, 503) : json(alertsFixture);
    if (url.includes("/points/")) return json(points[url.slice(url.indexOf("/points/") + 8)] ?? {}, 200);
    if (url.includes("/zones/")) return zones[url] ? json(zones[url]) : json({}, 404);
    return json({}, 404);
  });
}

function ctx(stub: ReturnType<typeof vi.fn>, bbox = TAHOE) {
  return { bbox, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch, cacheKey: "weather-alerts:k" };
}

function calls(stub: ReturnType<typeof vi.fn>) {
  return stub.mock.calls as unknown as [string, { cacheKey?: string; ttlSeconds?: number; headers?: Record<string, string> }][];
}

const inViewZones = new Set(Object.values(points).flatMap((b) => zonesFromPoint(b)));

describe("helpers", () => {
  it("picks the states whose padded extent touches the view", () => {
    expect(statesFor(TAHOE)).toEqual(["CA", "NV"]);
    expect(statesFor([-111.9, 40.5, -111.5, 40.8])).toEqual(["UT"]);
    expect(statesFor([2, 45, 3, 46])).toEqual([]);
  });

  it("samples a 3 x 3 grid of points rounded to 0.01°", () => {
    const pts = samplePoints(TAHOE);
    expect(pts).toHaveLength(9);
    expect(Object.keys(points).sort()).toEqual(pts.map(([lat, lon]) => `${lat},${lon}`).sort());
  });

  it("reads forecast, county and fire zones from a points answer", () => {
    const z = zonesFromPoint(points["38.95,-120.2"]);
    expect(z).toHaveLength(3);
    expect(z[0]).toMatch(/^https:\/\/api\.weather\.gov\/zones\/forecast\/CAZ\d+$/);
    expect(z[1]).toMatch(/\/zones\/county\/CAC\d+$/);
    expect(z[2]).toMatch(/\/zones\/fire\/CAZ\d+$/);
    expect(zonesFromPoint({ status: 404 })).toEqual([]);
  });

  it("fetches shapes only for in-view zones of zone-based alerts, capped", () => {
    const alerts = parseAlerts(alertsFixture);
    const { urls, capped } = zonesToFetch(alerts, inViewZones);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => inViewZones.has(u))).toBe(true);
    expect(capped).toBe(false);
    const many = Array.from({ length: 40 }, (_, i) => `https://api.weather.gov/zones/forecast/CAZ${100 + i}`);
    const big = parseAlerts({ features: [{ geometry: null, properties: { event: "X", affectedZones: many } }] });
    const r = zonesToFetch(big, new Set(many));
    expect(r.urls).toHaveLength(MAX_ZONE_FETCHES);
    expect(r.capped).toBe(true);
  });

  it("keeps in-view alerts with their zone shapes, sorted by severity, with onset and expiry", () => {
    const shapes = new Map(Object.entries(zones).map(([u, f]) => [u, f.geometry]));
    const { features, unplaced } = alertFeatures(parseAlerts(alertsFixture), inViewZones, shapes, TAHOE);
    expect(unplaced).toBe(0);
    const events = features.map((f) => f.properties?.event);
    expect(events).toContain("Red Flag Warning");
    expect(events).toContain("Lake Wind Advisory");
    expect(events).not.toContain("Tropical Storm Watch");
    expect(events).not.toContain("Coastal Flood Advisory");
    const red = features.find((f) => f.properties?.event === "Red Flag Warning");
    expect(red?.geometry.type).toBe("MultiPolygon");
    expect(red?.properties).toMatchObject({ kind: "Red Flag Warning", severity: "Severe", v: 3 });
    expect(new Date(String(red?.properties?.t)).toISOString()).toBe(red?.properties?.t);
    expect(typeof red?.properties?.expires).toBe("string");
    expect(features[0].properties?.v).toBeGreaterThanOrEqual(Number(features[features.length - 1].properties?.v));
  });

  it("filters by event text and counts in-view alerts whose shapes are missing", () => {
    const alerts = parseAlerts(alertsFixture);
    const shapes = new Map(Object.entries(zones).map(([u, f]) => [u, f.geometry]));
    const red = alertFeatures(alerts, inViewZones, shapes, TAHOE, "red flag");
    expect(red.features.map((f) => f.properties?.event)).toEqual(["Red Flag Warning"]);
    expect(alertFeatures(alerts, inViewZones, new Map(), TAHOE).unplaced).toBeGreaterThan(0);
  });

  it("builds the current-conditions point and names weather codes", () => {
    const f = nowFeature(nowFixture, [-120.2, 38.95]);
    expect(f?.properties).toMatchObject({ kind: "now", temperatureC: 13.3, weather: "clear" });
    expect(f?.properties?.v).toBe(f?.properties?.temperatureC);
    expect(weatherWords(73)).toBe("snow");
    expect(weatherWords(95)).toBe("thunderstorm");
    expect(nowFeature({}, [0, 0])).toBeNull();
  });
});

/**
 * Recorded 2026-10-18 ~06:15 UTC: the Esri Living Atlas copy of the NWS feed over the Outer Banks [-76.2,34.9,-75.2,36.0],
 * 27 entries (marine gale and storm warnings, a replaced High Wind Watch, a cancelled one, and the land alerts), each
 * shape cut to its extent and instructions to 200 characters to keep the file small.
 */
const OBX: [number, number, number, number] = [-76.2, 34.9, -75.2, 36.0];
const OBX_NOW = Date.parse("2026-10-18T06:15:00Z");
const esriFc = esriFixture as unknown as FeatureCollection;

function esriStub(newest = OBX_NOW - 27 * 60_000, down = false) {
  return vi.fn(async (url: string) => {
    if (url.startsWith(ESRI_ALERTS) && url.includes("outStatistics")) return json({ features: [{ attributes: { newest } }] });
    if (url.startsWith(ESRI_ALERTS)) return down ? json({}, 503) : json(esriFixture);
    if (url.includes("open-meteo")) return json(nowFixture);
    if (url.includes("/alerts/active")) return json({ type: "FeatureCollection", features: [] });
    return json({}, 404);
  });
}

describe("weather-alerts from the full NWS feed (audit 2026-10-17: zone sampling missed both Severe coastal flood warnings)", () => {
  it("keeps every land alert in view with its own shape, most severe first, and drops withdrawn and marine entries", () => {
    const features = esriAlertFeatures(esriFc, OBX_NOW);
    const events = features.map((f) => f.properties?.event);
    expect(features.slice(0, 2).map((f) => f.properties?.heading)).toEqual(["Coastal Flood Warning, Hatteras Island", "Coastal Flood Warning, Ocracoke Island"]);
    expect(features[0].properties).toMatchObject({ severity: "Severe", v: 3, until: "October 20 at 5:00PM EDT", senderName: "NWS Newport/Morehead City NC", expires: "2026-10-20T21:00:00.000Z" });
    expect(events).not.toContain("Gale Warning");
    expect(events).not.toContain("Storm Watch");
    expect(events).not.toContain("High Wind Watch");
    expect(features).toHaveLength(16);
    expect(features.every((f) => f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")).toBe(true);
    const severities = features.map((f) => Number(f.properties?.v));
    expect([...severities].sort((a, b) => b - a)).toEqual(severities);
    const marine = esriAlertFeatures(esriFc, OBX_NOW, { marine: true });
    expect(marine.filter((f) => f.properties?.marine === true).map((f) => f.properties?.event)).toContain("Gale Warning");
    expect(esriAlertFeatures(esriFc, OBX_NOW, { event: "coastal flood" }).map((f) => f.properties?.event)).toEqual([
      "Coastal Flood Warning",
      "Coastal Flood Warning",
      "Coastal Flood Advisory",
      "Coastal Flood Advisory",
      "Coastal Flood Advisory",
    ]);
    // An alert past its end is gone even while the copy still lists it.
    expect(esriAlertFeatures(esriFc, Date.parse("2026-10-21T00:00:00Z"))).toHaveLength(0);
  });

  it("reads marine zones, withdrawn entries, the local end and short area lists", () => {
    expect(isMarine("AMZ150 AMZ152")).toBe(true);
    expect(isMarine("NCZ203 AMZ150")).toBe(false);
    expect(isMarine("")).toBe(false);
    expect(isWithdrawn("The High Wind Watch has been replaced. Please see the latest information")).toBe(true);
    expect(isWithdrawn("The High Wind Watch has been cancelled.")).toBe(true);
    expect(isWithdrawn("Wind Advisory issued October 17 at 8:26PM EDT until October 19 at 8:00PM EDT by NWS Newport/Morehead City NC")).toBe(false);
    expect(untilText("Wind Advisory issued October 17 at 8:26PM EDT until October 19 at 8:00PM EDT by NWS Newport/Morehead City NC")).toBe("October 19 at 8:00PM EDT");
    expect(shortAreas("Northern Outer Banks; Ocracoke Island; Hatteras Island")).toBe("Northern Outer Banks, Ocracoke Island and 1 more");
    expect(esriOffset(OBX)).toBe(0.0013);
  });

  it("asks the feed once for the view with no NWS zone lookups, and the card title is the event and its areas", async () => {
    const stub = esriStub();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(OBX_NOW);
    try {
      const r = await layer.query(ctx(stub, OBX), { marine: false });
      if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
      const urls = calls(stub).map(([u]) => u);
      expect(urls.some((u) => u.includes("api.weather.gov"))).toBe(false);
      const query = new URL(urls.find((u) => u.startsWith(`${ESRI_ALERTS}/query`) && u.includes("geometry="))!);
      expect(query.searchParams.get("geometry")).toBe(OBX.join(","));
      expect(query.searchParams.get("f")).toBe("geojson");
      const alerts = r.data.features.filter((f) => f.properties?.kind !== "now");
      expect(alerts).toHaveLength(16);
      expect(cardTitle(layer, alerts[0])).toBe("Coastal Flood Warning, Hatteras Island");
      const now = r.data.features.find((f) => f.properties?.kind === "now");
      expect(String(now?.properties?.heading)).toMatch(/^Weather now: -?\d+ °F \(-?\d+ °C\)/);
      expect(r.sourceStatus).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to NWS itself, and says so, when the feed fails or its copy is over two hours old", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(OBX_NOW);
    try {
      for (const stub of [esriStub(OBX_NOW - 3 * 3_600_000), esriStub(undefined, true)]) {
        const r = await layer.query(ctx(stub, OBX), { marine: false });
        if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
        expect(calls(stub).some(([u]) => u.includes("api.weather.gov/alerts/active"))).toBe(true);
        expect(r.coverageNote).toMatch(/full NWS alert feed was unavailable/);
        expect(r.sourceStatus).toEqual({ ok: true });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("colors alerts by severity with a four-class key, one moment in time, US units", () => {
    expect(layer.style.encode).toEqual({ color: "severity" });
    expect(attributeProblems(layer)).toEqual([]);
    expect(contractProblems(layer)).toEqual([]);
    expect(legendOf(layer).items?.map((i) => i.label)).toEqual(["Minor", "Moderate", "Severe", "Extreme"]);
    expect(timeShapeOf(layer).shape).toBe("single");
    expect(displayOf(layer).units).toBe("us");
  });
});

describe("weather-alerts layer", () => {
  it("asks NWS once for the states, with a User-Agent, caching alerts 5 minutes and points and zones 30 days", async () => {
    const stub = routedStub();
    const r = await layer.query(ctx(stub), { marine: false });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const c = calls(stub);
    const alerts = c.filter((x) => x[0].includes("/alerts/active"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0][0]).toBe("https://api.weather.gov/alerts/active?status=actual&area=CA,NV");
    expect(alerts[0][1]).toMatchObject({ cacheKey: "weather-alerts:nws:CA,NV", ttlSeconds: 300 });
    expect(alerts[0][1].headers?.["user-agent"]).toBe("WallyMap/0.1 (https://wallymap.vercel.app)");
    const pts = c.filter((x) => x[0].includes("/points/"));
    expect(pts).toHaveLength(9);
    expect(pts[0][1].ttlSeconds).toBe(30 * 86_400);
    expect(pts[0][1].cacheKey).toMatch(/^weather-alerts:point:/);
    const kinds = r.data.features.map((f) => f.properties?.kind);
    expect(kinds).toContain("Red Flag Warning");
    expect(kinds).toContain("now");
  });

  it("remembers points NWS has no answer for (404) for an hour instead of asking again each view", async () => {
    const store = new Map<string, string>();
    const ttls: number[] = [];
    setPointMissCache({
      get: async (k) => store.get(k) ?? null,
      set: async (k, v, ttl) => {
        store.set(k, v);
        ttls.push(ttl);
      },
    });
    const water = () =>
      vi.fn(async (url: string) => {
        if (url.includes("/points/")) return json({ status: 404, title: "Data Unavailable For Requested Point" }, 404);
        return routedStub()(url);
      });
    const first = water();
    await layer.query(ctx(first), { marine: false });
    expect(calls(first).filter((c) => c[0].includes("/points/"))).toHaveLength(9);
    expect(store.size).toBe(9);
    expect(ttls.every((t) => t === 3_600)).toBe(true);
    const second = water();
    await layer.query(ctx(second), { marine: false });
    expect(calls(second).filter((c) => c[0].includes("/points/"))).toHaveLength(0);
    setPointMissCache(null);
  });

  it("returns only current conditions abroad, without calling NWS", async () => {
    const stub = routedStub();
    const r = await layer.query(ctx(stub, [6.0, 46.0, 6.5, 46.4]), { marine: false });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(calls(stub).every((x) => x[0].includes("open-meteo"))).toBe(true);
    expect(r.data.features.map((f) => f.properties?.kind)).toEqual(["now"]);
    expect(r.coverageNote).toMatch(/United States only/);
  });

  it("keeps current conditions when NWS fails, and errors only when both fail", async () => {
    const r = await layer.query(ctx(routedStub(["alerts"])), { marine: false });
    expect(r).toMatchObject({ kind: "geojson", coverageNote: expect.stringMatching(/NWS alerts failed/) });
    expect(await layer.query(ctx(routedStub(["alerts", "now"])), { marine: false })).toMatchObject({ hint: "upstream" });
  });

  it("describes events, times, the now point and the user's words", () => {
    for (const word of ["warnings", "alerts", "Red Flag Warning", "Avalanche Warning", "Winter Storm Warning", "severity", "expires", "onset", "non-commercial"]) {
      expect(layer.description).toContain(word);
    }
    expect(layer.style).toMatchObject({ geometry: "polygon" });
    expect(layer.license).toMatch(/NWS/);
  });

  it("rejects an oversized bbox and bad input through runLayer", async () => {
    const big = await runLayer("weather-alerts", { bbox: [-125, 30, -110, 49] });
    expect(big.status).toBe(422);
    expect(big.body).toMatchObject({ hint: "zoom_in", error: expect.stringMatching(/under 1600000 km²$/) });
    expect((await runLayer("weather-alerts", { bbox: TAHOE, input: { event: "" } })).status).toBe(400);
  });
});

describe("weather-alerts wide mode (over 400,000 km²)", () => {
  /** California and Nevada, about 1 million km². */
  const CA_NV: [number, number, number, number] = [-124.5, 32.5, -114, 42];

  it("declares the 1,000 most severe alerts under the default hard cap", () => {
    expect(layer.wide).toEqual({ orderBy: "severity", limit: 1000, rank: "most severe" });
    expect(WIDE_LIMIT).toBe(1000);
    expect(hardMaxAreaKm2(layer)).toBe(1_600_000);
    expect(layer.description).toMatch(/Over 400,000 km² it keeps the 1,000 most severe alerts/);
    expect(layer.description).not.toMatch(/Zoom in to under/);
  });

  it("samples a 5 x 5 grid instead of 3 x 3, one alerts call, and cuts at the limit with total", async () => {
    expect(samplePoints(CA_NV, WIDE_GRID)).toHaveLength(25);
    const stub = routedStub();
    const full = await layer.query({ ...ctx(stub, CA_NV), wide: true, wideStrategy: layer.wide }, { marine: false });
    if (!("kind" in full) || full.kind !== "geojson") throw new Error("expected geojson");
    expect(calls(stub).filter((x) => x[0].includes("/points/"))).toHaveLength(25);
    expect(calls(stub).filter((x) => x[0].includes("/alerts/active"))).toHaveLength(1);
    const alerts = full.data.features.filter((f) => f.properties?.kind !== "now");
    expect(alerts.length).toBeGreaterThan(1);
    expect(full.total).toBeUndefined();

    const cut = await layer.query({ ...ctx(routedStub(), CA_NV), wide: true, wideStrategy: { ...layer.wide!, limit: 1 } }, { marine: false });
    if (!("kind" in cut) || cut.kind !== "geojson") throw new Error("expected geojson");
    expect(cut.data.features.map((f) => f.properties?.kind)).toEqual([alerts[0].properties?.kind, "now"]);
    expect(cut.total).toBe(alerts.length + 1);
  });

  it("answers the owner-sized Texas box (1.4 million km²) through runLayer instead of zoom_in", async () => {
    const stub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("open-meteo")) return json(nowFixture);
      if (url.includes("/alerts/active")) return json({ type: "FeatureCollection", features: [] });
      return json({}, 404);
    });
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("weather-alerts", { bbox: [-106, 26, -93, 36.5] });
      expect(res.status).toBe(200);
      const area = stub.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/alerts/active"));
      expect(new URL(area!).searchParams.get("area")?.split(",")).toContain("TX");
      expect(res.body).toMatchObject({ coverageNote: expect.stringMatching(/^Showing all 1 in this wide view \(ranked by severity\)/) });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("input", () => {
  it("caps event at 120 characters", async () => {
    const { default: layer } = await import("./weather-alerts");
    expect(layer.input.safeParse({ event: "a".repeat(120) }).success).toBe(true);
    expect(layer.input.safeParse({ event: "a".repeat(121) }).success).toBe(false);
  });
});
