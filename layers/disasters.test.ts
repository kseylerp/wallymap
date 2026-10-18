import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { cardContent } from "@/lib/render/card";
import { parseCounties } from "./_shared/counties";
import { labelsOf, legendOf, timeShapeOf } from "./contract";
import layer, {
  MAX_FOOTPRINTS,
  citationFor,
  declarationDay,
  femaCountyFeatures,
  femaKind,
  femaUrl,
  footprintOf,
  gdacsFeatures,
  gdacsUrl,
  parseFema,
  severityOf,
  simplifyRing,
  titleOf,
  withFootprints,
} from "./disasters";
import gdacsFixture from "./__fixtures__/gdacs-events.sample.json";
import femaFixture from "./__fixtures__/fema-declarations.tx.json";
import countiesFixture from "./__fixtures__/counties.houston.json";
import footprintFixture from "./__fixtures__/disasters.gdacs-footprint-tc.json";

/**
 * Recorded 2026-10-10: GDACS page 1 for FL, TC, DR (all levels) and WF (orange, red) over 90 days, trimmed to three US
 * Gulf cyclones plus two other events per kind; OpenFEMA Texas declarations since 2021-10-10, trimmed to the Houston
 * counties plus three elsewhere; Esri generalized counties for the Houston box.
 */
const HOUSTON: [number, number, number, number] = [-96, 29, -94.5, 30.5];
const GULF: [number, number, number, number] = [-100, 25, -80, 35];
const NOW = new Date("2026-10-10T10:00:00Z");

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function ctx(stub: ReturnType<typeof vi.fn>, bbox = HOUSTON) {
  return { bbox, zoom: 8, env: {}, fetch: stub as unknown as CachedFetch, cacheKey: "disasters:k" };
}

/** GDACS answers with the fixture's events of the requested type; page 2 is the closing 204, as the fetch wrapper passes it on. */
function routed() {
  return vi.fn(async (url: string) => {
    if (url.includes("USA_Counties")) return json(countiesFixture);
    if (url.includes("fema.gov")) return json(femaFixture);
    if (url.includes("getgeometry")) return url.includes("eventtype=TC") ? json(footprintFixture) : new Response("no", { status: 404 });
    const u = new URL(url);
    if (u.searchParams.get("pagenumber") !== "1") return new Response(null, { status: 204 });
    const code = u.searchParams.get("eventlist");
    return json({ type: "FeatureCollection", features: gdacsFixture.features.filter((f) => f.properties.eventtype === code) });
  });
}

function calls(stub: ReturnType<typeof vi.fn>) {
  return stub.mock.calls as unknown as [string, { cacheKey: string; ttlSeconds: number }][];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("GDACS", () => {
  it("builds the search URL and keeps events in the bbox as dated points", () => {
    expect(gdacsUrl("WF", "orange;red", "2026-07-12", "2026-10-10", 2)).toBe(
      "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=WF&alertlevel=orange;red&fromDate=2026-07-12&toDate=2026-10-10&pagenumber=2",
    );
    const f = gdacsFeatures(gdacsFixture.features, GULF);
    expect(f).toHaveLength(3);
    expect(f[0].properties).toMatchObject({
      source: "GDACS",
      kind: "cyclone",
      name: "Tropical Cyclone ISAIAS-26",
      alertLevel: "orange",
      t: "2026-10-06T21:00:00.000Z",
      country: "United States",
      url: expect.stringContaining("report.aspx?eventid="),
      footprintUrl: expect.stringContaining("getgeometry?eventtype=TC"),
    });
    expect(gdacsFeatures(gdacsFixture.features, [-180, -90, 180, 90]).length).toBe(gdacsFixture.features.length);
  });
});

describe("FEMA", () => {
  it("maps incident types onto the GDACS kinds where they overlap", () => {
    expect(femaKind("Fire")).toBe("wildfire");
    expect(femaKind("Hurricane")).toBe("cyclone");
    expect(femaKind("Severe Storm")).toBe("severe storm");
  });

  it("filters by date and state FIPS", () => {
    const u = new URL(femaUrl(["06", "32"], "2021-10-10"));
    expect(u.searchParams.get("$filter")).toBe("declarationDate ge '2021-10-10T00:00:00.000Z' and (fipsStateCode eq '06' or fipsStateCode eq '32')");
    expect(u.searchParams.get("$top")).toBe("10000");
  });

  it("joins declarations to county polygons by FIPS, counting each disaster once", () => {
    const counties = parseCounties(countiesFixture).counties;
    const f = femaCountyFeatures(parseFema(femaFixture), counties);
    const harris = f.find((x) => x.properties?.fips === "48201");
    expect(harris?.properties).toMatchObject({
      source: "FEMA",
      name: "Harris County",
      v: 2,
      kind: "cyclone",
      t: "2024-07-09T00:00:00.000Z",
      latest: "Hurricane Beryl (DR-4798-TX)",
    });
    expect(String(harris?.properties?.declarations)).toMatch(/^Hurricane Beryl \(Jul 9, 2024\)/);
    expect(harris?.properties?.declarationUrl).toBe("https://www.fema.gov/disaster/4798");
    expect(f.every((x) => counties.some((c) => c.fips === x.properties?.fips))).toBe(true);
    expect(f.length).toBeGreaterThan(5);
  });
});

describe("disasters layer", () => {
  it("combines FEMA counties and GDACS points, with shared cache keys", async () => {
    const stub = routed();
    const r = await layer.query(ctx(stub), layer.input.parse({}));
    if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
    expect(r.data.features.filter((f) => f.properties?.source === "FEMA").length).toBeGreaterThan(5);
    expect(r.coverageNote).toBeUndefined();
    const c = calls(stub);
    const gdacs = c.filter(([u]) => u.includes("geteventlist"));
    expect(gdacs.map(([u]) => new URL(u).searchParams.get("eventlist")).sort()).toEqual(["DR", "FL", "TC", "WF"]);
    expect(gdacs.find(([u]) => u.includes("eventlist=WF"))?.[0]).toContain("alertlevel=orange;red");
    expect(gdacs[0][1]).toMatchObject({ cacheKey: expect.stringMatching(/^disasters:gdacs:[A-Z]{2}:2026-07-12:2026-10-10:1$/), ttlSeconds: 3600 });
    const fema = c.find(([u]) => u.includes("fema.gov"));
    expect(fema?.[1]).toMatchObject({ cacheKey: "disasters:fema:48:2021-10-10", ttlSeconds: 21_600 });
  });

  it("pages GDACS until a short page and treats the closing 204 as the end", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ ...gdacsFixture.features[0], properties: { ...gdacsFixture.features[0].properties, eventid: i } }));
    const stub = vi.fn(async (url: string) => {
      if (!url.includes("gdacs")) return json({ type: "FeatureCollection", features: [] });
      const page = new URL(url).searchParams.get("pagenumber");
      if (page === "1") return json({ type: "FeatureCollection", features: full });
      return new Response(null, { status: 204 });
    });
    const r = await layer.query(ctx(stub, [-180, -80, 180, 80]), layer.input.parse({ days: 30 }));
    expect(r).toMatchObject({ kind: "geojson" });
    expect((r as { coverageNote?: string }).coverageNote ?? "").not.toMatch(/could not be loaded/);
    expect(calls(stub).filter(([u]) => u.includes("pagenumber=2")).length).toBe(4);
  });

  it("skips FEMA for big or foreign views and says so", async () => {
    const stub = routed();
    const r = await layer.query(ctx(stub, [-125, 24, -66, 50]), layer.input.parse({}));
    expect(r).toMatchObject({ coverageNote: expect.stringContaining("Zoom in to under 3,000,000 km² to add FEMA") });
    expect(calls(stub).some(([u]) => u.includes("fema.gov"))).toBe(false);
    const abroad = await layer.query(ctx(routed(), [100, 0, 130, 30]), layer.input.parse({}));
    expect((abroad as { coverageNote?: string }).coverageNote ?? "").not.toContain("FEMA");
  });

  it("errors when everything fails and notes a partial failure", async () => {
    const down = vi.fn(async () => new Response("no", { status: 503 }));
    expect(await layer.query(ctx(down), layer.input.parse({}))).toMatchObject({ hint: "upstream" });
    const femaDown = vi.fn(async (url: string) => (url.includes("fema.gov") ? new Response("no", { status: 500 }) : routed()(url)));
    const r = await layer.query(ctx(femaDown), layer.input.parse({}));
    expect(r).toMatchObject({ kind: "geojson", coverageNote: expect.stringContaining("FEMA declarations could not be loaded") });
  });

  it("says to shorten years when FEMA rows are cut, and notes Connecticut", async () => {
    const many = vi.fn(async (url: string) =>
      url.includes("fema.gov") ? json({ ...femaFixture, metadata: { ...femaFixture.metadata, count: 20_000 } }) : routed()(url),
    );
    expect(await layer.query(ctx(many), layer.input.parse({}))).toMatchObject({ coverageNote: expect.stringContaining("shorten years") });
    const ct = { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [-72.7, 41.7] }, properties: { FIPS: "09110", STATE_ABBR: "CT", COUNTY_FIPS: "110", NAME: "Capitol Planning Region" } }] };
    const ctStub = vi.fn(async (url: string) => (url.includes("USA_Counties") ? json(ct) : routed()(url)));
    const r = await layer.query(ctx(ctStub, [-73.5, 41, -72, 42]), layer.input.parse({}));
    expect(r).toMatchObject({ coverageNote: expect.stringContaining("Connecticut has no FEMA county polygons") });
  });

  it("describes kinds, sources, inputs and the user's words", () => {
    for (const word of ["GDACS", "FEMA", "cyclone", "alertLevel", "days", "years", "disasters", "hurricane"]) expect(layer.description).toContain(word);
    expect(layer.input.parse({})).toEqual({ days: 90, years: 5 });
  });
});

/** The live GDACS footprint file of Hurricane SIMON-26 (recorded 2026-10-18), trimmed to its centroid and three areas. */
describe("the most severe events drawn at their affected area", () => {
  it("picks a cyclone's 60 km/h swath, simplified, and says what the area is", () => {
    const area = footprintOf("cyclone", footprintFixture);
    expect(area?.extent).toBe("Winds of 60 km/h (37 mph) or more along the track");
    expect(area?.geometry.type).toMatch(/Polygon$/);
    const coords = JSON.stringify(area?.geometry.coordinates);
    // Simplified to about 1 km and rounded to 3 decimals: far fewer vertices than the 714 GDACS sends.
    expect((coords.match(/\],\[/g) ?? []).length).toBeLessThan(400);
    expect(footprintOf("flood", footprintFixture)).toBeNull();
    expect(footprintOf("cyclone", { nope: 1 })).toBeNull();
    expect(simplifyRing([[0, 0], [1, 0.0001], [2, 0], [2, 2], [0, 0]], 0.01)).toEqual([[0, 0], [2, 0], [2, 2], [0, 0]]);
  });

  it("draws red and orange events as areas first, at most eight, keeps a point when the footprint fails, and skips green floods", async () => {
    const points = gdacsFeatures(gdacsFixture.features, [-180, -90, 180, 90]);
    const stub = vi.fn(async (url: string) => (url.includes("eventtype=TC") ? json(footprintFixture) : new Response("no", { status: 500 })));
    const { features, drawn } = await withFootprints(ctx(stub), points);
    const asked = (stub.mock.calls as unknown as [string][]).map(([u]) => new URL(u).searchParams.get("eventtype"));
    expect(asked.length).toBeLessThanOrEqual(MAX_FOOTPRINTS);
    expect(asked).not.toContain("FL");
    expect(features).toHaveLength(points.length);
    const areas = features.filter((f) => f.geometry.type !== "Point");
    expect(drawn).toBe(areas.length);
    expect(areas.every((f) => f.properties?.kind === "cyclone" && String(f.properties?.extent).startsWith("Winds of 60 km/h"))).toBe(true);
    for (const name of ["Tropical Cyclone SIMON-26", "Tropical Cyclone ISAIAS-26"]) expect(areas.some((f) => f.properties?.name === name)).toBe(true);
  });

  it("draws the Gulf view's cyclones as swaths through the layer", async () => {
    const r = await layer.query(ctx(routed(), GULF), layer.input.parse({}));
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const gdacs = r.data.features.filter((f) => f.properties?.source === "GDACS");
    expect(gdacs.some((f) => f.geometry.type !== "Point")).toBe(true);
  });
});

describe("plain words and the layer contract", () => {
  it("turns GDACS severity into peak wind and the latest class, crop stress area and burned area; floods get nothing", () => {
    expect(severityOf("cyclone", { severity: 249.9984, severitytext: "Tropical Depression (maximum wind speed of 250 km/h)", severityunit: "km/h" })).toEqual({
      peakWindKmh: 250,
      stage: "Tropical depression",
    });
    expect(severityOf("cyclone", { severity: 259, severitytext: "Hurricane/Typhoon > 74 mph (maximum wind speed of 259 km/h)", severityunit: "km/h" }).stage).toBe(
      "Hurricane or typhoon",
    );
    expect(severityOf("drought", { severity: 1759971, severitytext: "Medium impact for agricultural drought in 1759971 km2", severityunit: "km2" })).toEqual({
      affectedKm2: 1759971,
      impact: "Medium impact on crops",
    });
    expect(severityOf("wildfire", { severity: 18310, severitytext: "Orange impact for forestfire in 18310 ha", severityunit: "ha" })).toEqual({ burnedHa: 18310 });
    expect(severityOf("flood", { severity: 0, severitytext: "Magnitude 0 ", severityunit: "" })).toEqual({});
    const simon = gdacsFeatures(gdacsFixture.features, [-180, -90, 180, 90]).find((f) => f.properties?.name === "Tropical Cyclone SIMON-26");
    expect(simon?.properties).toMatchObject({ peakWindKmh: 250, stage: "Hurricane or typhoon" });
    expect(simon?.properties?.severity).toBeUndefined();
  });

  it("writes FEMA titles in title case and lists three declarations with a count of the earlier ones", () => {
    expect(titleOf({ declarationTitle: "SEVERE STORMS AND FLOODING", incidentType: "Flood" })).toBe("Severe Storms and Flooding");
    expect(titleOf({ declarationTitle: null, incidentType: "Hurricane" })).toBe("Hurricane");
    const rows = Array.from({ length: 5 }, (_, i) => ({
      disasterNumber: 4900 + i,
      femaDeclarationString: `DR-${4900 + i}-TX`,
      declarationType: "DR",
      declarationDate: `202${i}-06-01T00:00:00.000Z`,
      incidentType: "Flood",
      declarationTitle: "FLOODING",
      fipsStateCode: "48",
      fipsCountyCode: "201",
    }));
    const [harris] = femaCountyFeatures(rows, [{ fips: "48201", name: "Harris County", stateAbbr: "TX", geometry: { type: "Point", coordinates: [-95.4, 29.8] } }]);
    expect(harris.properties).toMatchObject({ v: 5, first: "2020-06-01", kinds: "flood 5" });
    expect(harris.properties?.declarations).toBe("Flooding (Jun 1, 2024); Flooding (Jun 1, 2023); Flooding (Jun 1, 2022); and 2 earlier");
  });

  it("shows a FEMA county's dates in words and links it to FEMA, never GDACS", () => {
    const counties = parseCounties(countiesFixture).counties;
    const harris = femaCountyFeatures(parseFema(femaFixture), counties).find((x) => x.properties?.fips === "48201");
    if (!harris) throw new Error("expected Harris County");
    const card = cardContent(harris, { card: layer.card, fieldHelp: layer.fieldHelp });
    const rows = [...card.facts, ...card.details];
    expect(rows.filter((r) => /\b\d{4}-\d{2}-\d{2}\b/.test(r.value)).map((r) => `${r.label}: ${r.value}`)).toEqual([]);
    expect(card.facts.find((r) => r.key === "source")?.value).toBe("FEMA disaster declarations");
    expect(card.links.map((l) => l.label)).toEqual(["FEMA declaration page"]);
    expect(card.links.some((l) => l.url.includes("gdacs"))).toBe(false);
    expect(declarationDay("2024-10-11T00:00:00.000Z")).toBe("Oct 11, 2024");
  });

  it("names only the sources drawn in the answer's source line", () => {
    const now = Date.UTC(2026, 9, 10);
    expect(citationFor(3, 0, now)).toMatchObject({ source: expect.stringMatching(/^FEMA/), url: "https://www.fema.gov/disaster/declarations" });
    expect(citationFor(3, 0, now).source).not.toMatch(/GDACS/);
    expect(citationFor(0, 2, now)).toMatchObject({ source: expect.stringMatching(/^GDACS/), url: "https://www.gdacs.org/" });
    expect(citationFor(0, 2, now).source).not.toMatch(/FEMA/);
    expect(citationFor(5, 2, now).source).toMatch(/FEMA.*county declarations.*GDACS.*alerts/);
  });

  it("declares no time panel, hatch density by declarations with a legend that names both sources, and labels the busiest counties", () => {
    expect(timeShapeOf(layer)).toEqual({ shape: "none" });
    expect(layer.style.encode).toEqual({ size: "v" });
    expect(layer.attributes?.find((a) => a.key === "v")).toMatchObject({ type: "measure", encode: "size" });
    expect(legendOf(layer)).toMatchObject({ kind: "size", field: "v", note: expect.stringMatching(/GDACS alerts \(green minor, orange moderate, red severe\)/) });
    expect(labelsOf(layer)).toEqual({ field: "name", max: 5, rankBy: "v" });
    expect(layer.card?.facts?.some((f) => f.key === "severity")).toBe(false);
  });
});
