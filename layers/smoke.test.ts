import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import type { FeatureCollection } from "geojson";
import { attributeProblems } from "./attributes";
import { cardTitle, contractProblems, legendOf } from "./contract";
import layer, { FORECAST_URL, forecastFeatures, kmlUrl, parseHmsKml } from "./smoke";
/**
 * NDGD smoke forecast answer recorded 2026-10-18 ~06:25 UTC (run 03:00 UTC) over the West Coast: one real polygon of each
 * class present (3-25, 25-63, 63-158) cut to its extent, with the clean-air class and the 158-1000 class (none forecast
 * that day) added on the same shape so every class is read; hours 06:00:01 to 09:00:01 as the feed stamps them.
 */
import forecastFixture from "./__fixtures__/smoke-ndgd.forecast.json";

const KML = readFileSync(path.join(__dirname, "__fixtures__/smoke.hms.kml"), "utf8");
const US: [number, number, number, number] = [-125, 24, -66, 50];
/** Around Spokane, WA: holds the Medium polygon in the fixture. */
const SPOKANE: [number, number, number, number] = [-119, 47.5, -117.5, 49];

function ctx(stub: ReturnType<typeof vi.fn>, bbox: [number, number, number, number] = US) {
  return { bbox, zoom: 5, env: {}, fetch: stub as unknown as CachedFetch, cacheKey: "smoke:test" };
}

const kmlResponse = () => new Response(KML, { status: 200 });
const calls = (stub: ReturnType<typeof vi.fn>) => stub.mock.calls as unknown as [string, RequestInit?][];

describe("parseHmsKml", () => {
  it("turns each Placemark into a polygon with t, v, density, satellite and times", () => {
    const features = parseHmsKml(KML, "2026-10-08");
    expect(features).toHaveLength(3);
    const [light, medium, heavy] = features;
    expect(light.geometry.type).toBe("Polygon");
    expect(light.properties).toEqual({
      t: "2026-10-08T12:00:00.000Z",
      v: 1,
      density: "Light",
      satellite: "GOES-WEST",
      start: "2026-10-08T12:00:00.000Z",
      end: "2026-10-08T15:00:00.000Z",
      seen: "2026-10-08, 12:00–15:00 UTC",
      heading: "Light smoke overhead, seen 12:00–15:00 UTC",
    });
    expect(medium.properties).toMatchObject({ v: 2, density: "Medium", satellite: "GOES-EAST", start: "2026-10-08T20:00:00.000Z" });
    expect(heavy.properties).toMatchObject({ v: 3, density: "Heavy" });
    // The card's title is the density and the hours, not "Feature" (audit 2026-10-17).
    expect(cardTitle(layer, medium)).toBe("Medium smoke overhead, seen 20:00–23:30 UTC");
  });

  it("colors polygons by density on one four-step scale with a key (audit 2026-10-17: one pink for all)", () => {
    expect(layer.style.encode).toEqual({ color: "density" });
    expect(attributeProblems(layer)).toEqual([]);
    expect(contractProblems(layer)).toEqual([]);
    expect(legendOf(layer).items?.map((i) => i.label)).toEqual(["Light", "Medium", "Heavy", "Very heavy"]);
  });

  it("reads the near-surface forecast: clean air dropped, hourly t, the PM2.5 class on the shared scale", () => {
    const features = forecastFeatures(forecastFixture as unknown as FeatureCollection);
    expect(features.map((f) => f.properties?.density)).toEqual(["Light", "Medium", "Heavy", "Very heavy"]);
    expect(features[1].properties).toMatchObject({
      t: "2026-10-18T07:00:00.000Z",
      kind: "forecast",
      v: 2,
      pm25: "25–63 µg/m³",
      run: "2026-10-18T03:00:00.000Z",
      heading: "Medium smoke near the ground (25–63 µg/m³), forecast for 2026-10-18 07:00 UTC",
    });
  });

  it("source forecast asks the NDGD feed for the view from this hour on", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-18T06:25:00Z"));
    try {
      const stub = vi.fn(async (_url: string, _init?: unknown) => new Response(JSON.stringify(forecastFixture), { status: 200 }));
      const r = await layer.query(ctx(stub, [-125, 32, -114, 46]), layer.input.parse({ source: "forecast" }));
      if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
      const url = new URL(stub.mock.calls[0][0]);
      expect(url.origin + url.pathname).toBe(`${FORECAST_URL}/query`);
      expect(url.searchParams.get("where")).toBe("smoke_classdesc <> '0 - 3' AND todate >= TIMESTAMP '2026-10-18 06:00:00'");
      expect(r.data.features).toHaveLength(4);
      expect(r.coverageNote).toBe("Smoke near the ground forecast hourly from 2026-10-18 06:00 to 2026-10-18 09:00 UTC");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps lon,lat order, drops altitude, and closes rings", () => {
    const light = parseHmsKml(KML, "2026-10-08")[0];
    if (light.geometry.type !== "Polygon") throw new Error("expected Polygon");
    const outer = light.geometry.coordinates[0];
    expect(outer[0]).toEqual([-92.138957, 31.847885]);
    expect(outer[0]).toEqual(outer[outer.length - 1]);
    expect(outer.every((p) => p.length === 2)).toBe(true);
  });

  it("reads inner boundaries as holes and a MultiGeometry as a MultiPolygon", () => {
    const kml = `<kml><Document><Placemark><description><![CDATA[<div>Start Time: 2026281 0100UTC<br>End Time: 2026281 0400UTC<br>Density: Heavy<br>Satellite: GOES-EAST</div>]]></description>
      <MultiGeometry>
      <Polygon><outerBoundaryIs><LinearRing><coordinates>-100,40,0 -99,40,0 -99,41,0 -100,41,0 -100,40,0</coordinates></LinearRing></outerBoundaryIs>
        <innerBoundaryIs><LinearRing><coordinates>-99.8,40.2,0 -99.6,40.2,0 -99.6,40.4,0 -99.8,40.2,0</coordinates></LinearRing></innerBoundaryIs></Polygon>
      <Polygon><outerBoundaryIs><LinearRing><coordinates>-98,40,0 -97,40,0 -97,41,0 -98,40,0</coordinates></LinearRing></outerBoundaryIs></Polygon>
      </MultiGeometry></Placemark></Document></kml>`;
    const [f] = parseHmsKml(kml, "2026-10-08");
    if (f.geometry.type !== "MultiPolygon") throw new Error("expected MultiPolygon");
    expect(f.geometry.coordinates).toHaveLength(2);
    expect(f.geometry.coordinates[0]).toHaveLength(2);
  });

  it("drops polygons outside the bbox and Placemarks with no usable ring", () => {
    expect(parseHmsKml(KML, "2026-10-08", SPOKANE)).toHaveLength(1);
    expect(parseHmsKml("<Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>1,2,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>", "2026-10-08")).toHaveLength(0);
    expect(parseHmsKml("not kml", "2026-10-08")).toEqual([]);
  });

  it("leaves v off for an unknown density instead of guessing", () => {
    const kml = `<Placemark><description><![CDATA[<div>Density: Extreme<br>Satellite: GOES-EAST</div>]]></description><Polygon><outerBoundaryIs><LinearRing><coordinates>1,2,0 2,2,0 2,3,0 1,2,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`;
    const [f] = parseHmsKml(kml, "2026-10-08");
    expect(f.properties).not.toHaveProperty("v");
    expect(f.properties?.density).toBe("Extreme");
  });
});

describe("smoke layer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T15:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("declares a Americas coverage box, no env and no area cap", () => {
    expect(layer.id).toBe("smoke");
    expect(layer.coverage).toEqual({ bbox: [-180, 5, -50, 75] });
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
    expect(layer.style).toMatchObject({ geometry: "polygon", unit: "class" });
  });

  it("builds the NOAA KML path per day", () => {
    expect(kmlUrl("2026-10-08")).toBe("https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/KML/2026/10/hms_smoke20261008.kml");
    expect(kmlUrl("2005-08-05")).toContain("/KML/2005/08/hms_smoke20050805.kml");
  });

  it("fetches the requested day with a bbox-independent cache key and returns cited polygons", async () => {
    const stub = vi.fn(async () => kmlResponse());
    const r = await layer.query(ctx(stub), { source: "observed", date: "2026-10-08", days: 1 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(stub).toHaveBeenCalledTimes(1);
    expect(calls(stub)[0][0]).toBe(kmlUrl("2026-10-08"));
    expect(calls(stub)[0][1]).toMatchObject({ cacheKey: "hms-smoke:2026-10-08" });
    expect(r.data.features).toHaveLength(3);
    expect(r.data.features.every((f) => String(f.properties?.t).startsWith("2026-10-08T"))).toBe(true);
    expect(r.citation.source).toMatch(/Hazard Mapping System/);
    expect(r.coverageNote).toBe("Smoke for 2026-10-08");
  });

  it("filters polygons to the bbox", async () => {
    const stub = vi.fn(async () => kmlResponse());
    const r = await layer.query(ctx(stub, SPOKANE), { source: "observed", date: "2026-10-08", days: 1 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(1);
    expect(r.data.features[0].properties?.v).toBe(2);
  });

  it("without a date asks for today and one earlier day, and shows the newest map that exists", async () => {
    const stub = vi.fn(async (url: string) => (url.includes("20261009") ? new Response("", { status: 404 }) : kmlResponse()));
    const r = await layer.query(ctx(stub as unknown as ReturnType<typeof vi.fn>), { source: "observed", days: 1 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(calls(stub as unknown as ReturnType<typeof vi.fn>).map((c) => c[0])).toEqual([kmlUrl("2026-10-09"), kmlUrl("2026-10-08")]);
    expect(r.data.features).toHaveLength(3);
    expect(r.coverageNote).toBe("Smoke for 2026-10-08");
  });

  it("loads several days, notes a day with no map, and stamps each feature with its own day", async () => {
    const stub = vi.fn(async (url: string) => (url.includes("20261007") ? new Response("", { status: 404 }) : kmlResponse()));
    const r = await layer.query(ctx(stub as unknown as ReturnType<typeof vi.fn>), { source: "observed", date: "2026-10-08", days: 3 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(6);
    expect(new Set(r.data.features.map((f) => String(f.properties?.t).slice(0, 10)))).toEqual(new Set(["2026-10-08", "2026-10-06"]));
    expect(r.coverageNote).toBe("Smoke for 2026-10-06 to 2026-10-08; no map published for 2026-10-07");
  });

  it("returns an empty collection with a note when the day has no map", async () => {
    const stub = vi.fn(async () => new Response("", { status: 404 }));
    const r = await layer.query(ctx(stub), { source: "observed", date: "2026-10-01", days: 1 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toEqual([]);
    expect(r.coverageNote).toBe("No HMS smoke map was published for 2026-10-01");
  });

  it("maps an upstream failure to an upstream error", async () => {
    const stub = vi.fn(async () => new Response("down", { status: 503 }));
    expect(await layer.query(ctx(stub), { source: "observed", date: "2026-10-08", days: 1 })).toMatchObject({ hint: "upstream" });
    const thrower = vi.fn(async () => {
      throw new Error("network");
    });
    expect(await layer.query(ctx(thrower), { source: "observed", date: "2026-10-08", days: 1 })).toMatchObject({ hint: "upstream" });
  });

  it("says smoke is not mapped outside the Americas without calling upstream", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub, [2, 48, 3, 49]), { source: "observed", days: 1 });
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toEqual([]);
    expect(r.coverageNote).toMatch(/North and Central America/);
  });

  it("clamps a future date to today and rejects one before 2005", async () => {
    const stub = vi.fn(async () => kmlResponse());
    const r = await layer.query(ctx(stub), { source: "observed", date: "2026-10-20", days: 1 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(calls(stub)[0][0]).toBe(kmlUrl("2026-10-09"));
    expect(r.coverageNote).toContain("showing 2026-10-09");
    expect(await layer.query(ctx(vi.fn()), { source: "observed", date: "2005-08-04", days: 1 })).toMatchObject({ error: expect.stringContaining("2005-08-05") });
  });

  it("rejects days outside 1 to 7 and a malformed date at the input schema", () => {
    expect(layer.input.safeParse({ days: 0 }).success).toBe(false);
    expect(layer.input.safeParse({ days: 8 }).success).toBe(false);
    expect(layer.input.safeParse({ date: "yesterday" }).success).toBe(false);
  });

  it("tells the model the density classes, cadence, caveats and the user's words", () => {
    for (const word of ["1 light, 2 medium, 3 heavy", "smoke", "daily", "2005", "days (1 to 7", "hand-drawn", "fire-detections"]) {
      expect(layer.description).toContain(word);
    }
  });

  it("summarizes to counts and the citation for the model", async () => {
    const stub = vi.fn(async () => kmlResponse());
    expect(summarizeLayerResult(await layer.query(ctx(stub), { source: "observed", date: "2026-10-08", days: 1 }))).toMatchObject({ kind: "geojson", featureCount: 3 });
  });

  it("runs through runLayer with a stubbed fetch via the global", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => kmlResponse()) as unknown as typeof fetch;
    try {
      const res = await runLayer("smoke", { bbox: SPOKANE, zoom: 6, input: { date: "2026-10-08" } });
      expect(res.status).toBe(200);
      expect((await runLayer("smoke", { bbox: SPOKANE, input: { days: 9 } })).status).toBe(400);
    } finally {
      globalThis.fetch = original;
    }
  });
});
