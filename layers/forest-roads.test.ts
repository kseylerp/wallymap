import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, {
  CAMPING_RULES,
  attachCampingRules,
  campingRuleNote,
  campingRulesFor,
  datesOpen,
  maintLevelOf,
  mvumOffset,
  mvumWhere,
  normalizeMvum,
  surfaceKindOf,
} from "./forest-roads";
import { colorStops } from "@/lib/render/attributes";
import { hardMaxAreaKm2 } from "./types";
import { WHOLE_US_KM2 } from "./_shared/coverage";
import { cardTitle, legendOf } from "./contract";
import { cardContent } from "@/lib/render/card";
import raw from "./__fixtures__/forest-roads.tahoe.json";
import sedonaRaw from "./__fixtures__/forest-roads.sedona.json";

const fixture = raw as unknown as FeatureCollection;
const sedona = sedonaRaw as unknown as FeatureCollection;
const TAHOE: [number, number, number, number] = [-120.2, 38.85, -120, 39];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string, bbox = TAHOE) {
  return { bbox, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

function params(url: unknown): URLSearchParams {
  return new URL(String(url)).searchParams;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mvumWhere", () => {
  it("keeps only roads open to ordinary highway-legal vehicles by default", () => {
    expect(mvumWhere(false)).toBe("symbol IN ('1','2','3','4')");
  });

  it("adds the special-designation roads (symbols 11 and 12) when all roads are requested", () => {
    expect(mvumWhere(true)).toBe("symbol IN ('1','2','3','4','11','12')");
  });
});

describe("normalizeMvum", () => {
  it("maps fixture rows to road lines with route id, access class, seasonality and vehicle flags", () => {
    const fc = normalizeMvum(fixture);
    expect(fc.features).toHaveLength(fixture.features.length);
    for (const f of fc.features) {
      expect(f.geometry.type).toBe("LineString");
      const p = f.properties ?? {};
      expect(typeof p.routeId).toBe("string");
      expect(typeof p.access).toBe("string");
      expect(typeof p.seasonal).toBe("boolean");
      expect(typeof p.passengerCar).toBe("boolean");
      expect(typeof p.highClearance).toBe("boolean");
      // The national MVUM service has no dispersed-camping attribute, so none is claimed.
      expect(p).not.toHaveProperty("dispersedCamping");
    }
    const tallac = fc.features.find((f) => f.properties?.routeId === "1302");
    expect(tallac?.properties).toMatchObject({
      name: "TALLAC HISTORIC SITE",
      forest: "Lake Tahoe Basin Management Unit",
      access: "Roads open to highway legal vehicles only, Seasonal",
      seasonal: true,
      passengerCar: true,
      highClearance: true,
      surface: "AC - ASPHALT",
    });
  });

  it("omits name when the service has none and derives seasonality from the symbol when the field is null", () => {
    const fc = normalizeMvum({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
          properties: { id: "9", name: null, symbol: "12", seasonal: null, passengervehicle: "restricted" },
        },
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
          properties: { id: "10", symbol: "3", seasonal: null },
        },
      ],
    });
    expect(fc.features[0].properties).not.toHaveProperty("name");
    expect(fc.features[0].properties).toMatchObject({ seasonal: true, passengerCar: false });
    expect(fc.features[1].properties).toMatchObject({ seasonal: false });
  });

  it("keeps the segment length as miles, to two decimals, and leaves it out when missing or zero", () => {
    const row = (id: string, gis_miles: unknown) => ({
      type: "Feature" as const,
      geometry: { type: "LineString" as const, coordinates: [[0, 0], [1, 1]] },
      properties: { id, symbol: "1", gis_miles },
    });
    const fc = normalizeMvum({ type: "FeatureCollection", features: [row("1", 35.0649), row("2", null), row("3", 0)] });
    expect(fc.features.map((f) => f.properties?.miles)).toEqual([35.06, undefined, undefined]);
  });

  it("skips rows with no geometry or no route id", () => {
    const fc = normalizeMvum({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: null as never, properties: { id: "1" } },
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
          properties: { name: "No id" },
        },
      ],
    });
    expect(fc.features).toHaveLength(0);
  });
});

describe("maintenance level, surface group and dates open (Sedona, read live 2026-10-18)", () => {
  it("reads the level from its leading digit 1 to 5 and leaves blank, 0 and other text unrated", () => {
    expect(maintLevelOf("2 - HIGH CLEARANCE VEHICLES")).toBe(2);
    expect(maintLevelOf("5 - HIGH DEGREE OF USER COMFORT")).toBe(5);
    expect(maintLevelOf("2")).toBe(2);
    expect(maintLevelOf("0 - NOT MAINTAINED")).toBeUndefined();
    expect(maintLevelOf(" ")).toBeUndefined();
    expect(maintLevelOf(null)).toBeUndefined();
  });

  it("groups the surface types as paved, gravel or dirt", () => {
    expect(surfaceKindOf("AC - ASPHALT")).toBe("paved");
    expect(surfaceKindOf("BST - BITUMINOUS SURFACE TREATMENT")).toBe("paved");
    expect(surfaceKindOf("AGG - CRUSHED AGGREGATE OR GRAVEL")).toBe("gravel");
    expect(surfaceKindOf("NAT - NATIVE MATERIAL")).toBe("dirt");
    expect(surfaceKindOf("IMP - IMPROVED NATIVE MATERIAL")).toBe("dirt");
    expect(surfaceKindOf("OTHER - OTHER")).toBeUndefined();
  });

  it("writes the dates passenger cars may use the road in words", () => {
    expect(datesOpen("01/01-12/31")).toBe("All year");
    expect(datesOpen("04/02-12/14")).toBe("Apr 2 to Dec 14");
    expect(datesOpen("01/01-01/15,04/08-05/13,10/01-12/31")).toBe("Jan 1 to Jan 15, Apr 8 to May 13, Oct 1 to Dec 31");
    expect(datesOpen("06/01 - 9/30")).toBe("Jun 1 to Sep 30");
    expect(datesOpen("open")).toBeUndefined();
    expect(datesOpen(null)).toBeUndefined();
  });

  it("gives each Sedona road its level, district, surface group, dates and the other vehicles it is legal for", () => {
    const fc = normalizeMvum(sedona);
    expect(fc.features).toHaveLength(sedona.features.length);
    const levels = new Set(fc.features.map((f) => f.properties?.level));
    expect([...levels].sort()).toEqual([2, 3, 4, 5]);
    // Schnebly Hill's Red Rock segment: legal for cars, but the Forest Service maintains it for high clearance only.
    const schnebly = fc.features.find((f) => f.properties?.routeId === "153" && f.properties?.level === 2);
    expect(schnebly?.properties).toMatchObject({
      name: "SCHNEBLY HILL",
      passengerCar: true,
      level: 2,
      district: "Red Rock Ranger District",
      carDates: "All year",
      motorhome: true,
    });
    const seasonal = fc.features.find((f) => f.properties?.routeId === "6352");
    expect(seasonal?.properties).toMatchObject({ seasonal: true, carDates: "Apr 2 to Dec 14", atv: true, surfaceKind: "dirt", heading: "Forest Road 6352" });
    expect(seasonal?.properties).not.toHaveProperty("eBike");
  });

  it("puts the maintenance level first on the card and says open to passenger cars by law, not suited to them", () => {
    const fc = normalizeMvum(sedona);
    const schnebly = fc.features.find((f) => f.properties?.routeId === "153" && f.properties?.level === 2);
    if (!schnebly) throw new Error("expected Schnebly Hill");
    const card = cardContent(schnebly, { card: layer.card, fieldHelp: layer.fieldHelp });
    expect(card.facts[0]).toMatchObject({ label: "Maintenance level", value: "2, high-clearance vehicles only" });
    expect(card.facts[1]).toMatchObject({ label: "Open to passenger cars by law", value: "Yes" });
    expect(card.facts.map((r) => r.label)).toContain("Ranger district");
    expect(card.facts.find((r) => r.label === "Surface")?.value).toBe("Improved dirt (native material with added rock)");
    expect(card.facts.some((r) => /open$/i.test(r.value))).toBe(false);
    expect(card.details.map((r) => r.key)).not.toContain("surfaceKind");
  });

  it("titles an unnamed road by its number", () => {
    const fc = normalizeMvum(sedona);
    const unnamed = fc.features.find((f) => f.properties?.routeId === "6352");
    if (!unnamed) throw new Error("expected road 6352");
    expect(cardTitle(layer, unnamed)).toBe("Forest Road 6352");
  });
});

describe("forest-roads layer", () => {
  it("colors the lines by maintenance level, the primary chip set, with a legend that names unrated roads", () => {
    expect(layer.style.encode).toEqual({ color: "level" });
    const level = layer.attributes?.find((a) => a.key === "level");
    expect(level).toMatchObject({ type: "ordinal", primary: true, encode: "color" });
    // Two plain chips: levels 3 to 5 are maintained for passenger cars, 1 and 2 for high clearance (UC14, Leadville).
    expect(level?.levels?.map((l) => [l.value, l.label])).toEqual([
      [5, "Passenger car"],
      [4, "Passenger car"],
      [3, "Passenger car"],
      [2, "High clearance"],
      [1, "High clearance"],
    ]);
    const stops = Object.fromEntries(colorStops(level!));
    expect(new Set([stops["3"], stops["4"], stops["5"]]).size).toBe(1);
    expect(stops["2"]).toBe(stops["1"]);
    expect(stops["2"]).not.toBe(stops["3"]);
    expect(layer.attributes?.find((a) => a.key === "surfaceKind")?.levels?.map((l) => l.label)).toEqual(["Paved", "Gravel", "Dirt"]);
    expect(layer.attributes?.find((a) => a.key === "seasonal")?.type).toBe("flag");
    const legend = legendOf(layer);
    expect(legend.kind).toBe("categories");
    expect(legend.items?.map((i) => i.label)).toEqual([...(level?.levels ?? []).map((l) => l.label), "Not rated"]);
    // Each level's swatch is its chip's color, as the map draws it.
    for (const item of legend.items ?? []) if (item.value !== undefined) expect(item.color).toBe(stops[String(item.value)]);
    expect(layer.time).toEqual({ shape: "none" });
    expect(layer.labels).toEqual({ field: "name", max: 5, rankBy: "miles" });
    expect(layer.display).toEqual({ units: "us", timeZone: "local" });
  });

  it("declares US coverage, no key, a 25,000 km2 cap and the longest segments up to the whole US past it", () => {
    expect(layer.coverage).toBe("us");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(25_000);
    expect(layer.wide).toEqual({ orderBy: "segment length in miles", rank: "longest", limit: 2000 });
    expect(hardMaxAreaKm2(layer)).toBe(WHOLE_US_KM2);
    expect(layer.style).toEqual({ geometry: "line", color: "#3A3A3C", encode: { color: "level" } });
    expect(layer.license).toBe("Public domain (USDA Forest Service)");
  });

  it("queries MVUM roads layer 1 with the filter, a 24 hour cache and a cache key", async () => {
    const stub = vi.fn(async () => json(fixture));
    const r = await layer.query(ctx(stub, "forest-roads:k"), { includeAllRoads: false });
    const [url, init] = stub.mock.calls[0] as unknown as [
      string,
      RequestInit & { cacheKey?: string; ttlSeconds?: number },
    ];
    expect(url.startsWith("https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MVUM_01/MapServer/1/query?")).toBe(true);
    expect(params(url).get("where")).toBe("symbol IN ('1','2','3','4')");
    expect(params(url).get("geometry")).toBe("-120.2,38.85,-120,39");
    expect(params(url).get("outFields")).toContain("mvum_symbol_name");
    expect(init.ttlSeconds).toBe(86_400);
    expect(init.cacheKey).toBe("forest-roads:k:mvum-roads");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(fixture.features.length);
    expect(r.citation.source).toContain("Forest Service");
    // The Tahoe box sits in the Lake Tahoe Basin, whose order bans dispersed camping.
    expect(r.coverageNote).toMatch(/^Camping rule here: Lake Tahoe Basin Management Unit .*Forest Order 19-24-05/);
    expect(r.data.features.some((f) => f.properties?.campingRuleUrl === "https://fs.usda.gov/r05/laketahoebasin/alerts/camping-overnight-stay-restriction")).toBe(true);
  });

  it("uses the wider where clause when includeAllRoads is true", async () => {
    const stub = vi.fn(async (_url: string) => json(fixture));
    await layer.query(ctx(stub), { includeAllRoads: true });
    expect(params(stub.mock.calls[0][0]).get("where")).toBe("symbol IN ('1','2','3','4','11','12')");
  });

  it("maps a 200 ArcGIS { error } body to an upstream error", async () => {
    const stub = vi.fn(async () => json({ error: { code: 400, message: "Unable to complete operation." } }));
    const r = await layer.query(ctx(stub), { includeAllRoads: false });
    expect(r).toEqual({ error: "ArcGIS service error: Unable to complete operation.", hint: "upstream" });
  });

  it("maps a non-2xx response to an upstream error", async () => {
    const stub = vi.fn(async () => new Response("down", { status: 503 }));
    const r = await layer.query(ctx(stub), { includeAllRoads: false });
    expect(r).toEqual({ error: "ArcGIS service returned 503", hint: "upstream" });
  });

  it("flags a truncated result", async () => {
    const stub = vi.fn(async () => json({ ...fixture, exceededTransferLimit: true }));
    const r = await layer.query(ctx(stub), { includeAllRoads: false });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toMatch(/^Showing the first 2,000 road segments; zoom in for the rest; Camping rule here: /);
  });

  it("returns an empty result with a note, without calling upstream, outside the US", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub, undefined, [2, 48, 3, 49]), { includeAllRoads: false });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toBe("No data outside the United States");
    expect(stub).not.toHaveBeenCalled();
  });

  it("simplifies to about 10 m for a forest and to 1/4,000 of the box's width for a wide view", () => {
    expect(mvumOffset(TAHOE, false)).toBe(0.0001);
    expect(mvumOffset([-112, 37, -109, 39.5], true)).toBe(0.00075);
    expect(mvumOffset([-120.2, 38.85, -120.19, 39], true)).toBe(0.0001);
  });

  it("over 25,000 km2 fetches the longest segments first with a count, and run.ts writes the note", async () => {
    const rows = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "LineString", coordinates: [[-111, 38], [-110, 38]] }, properties: { id: "1", name: "ELK RIDGE", symbol: "1", gis_miles: 35.07 } },
        { type: "Feature", geometry: { type: "LineString", coordinates: [[-111, 38], [-111, 38.1]] }, properties: { id: "2", symbol: "2", gis_miles: 2.5 } },
      ],
      exceededTransferLimit: true,
    };
    const stub = vi.fn(async (url: string) => json(params(url).get("returnCountOnly") === "true" ? { count: 2440 } : rows));
    vi.stubGlobal("fetch", stub);
    try {
      // South-east Utah, about 72,500 km².
      const res = await runLayer("forest-roads", { bbox: [-112, 37, -109, 39.5], zoom: 7 });
      expect(res.status).toBe(200);
      const query = stub.mock.calls.map((c) => params(c[0])).find((p) => p.get("returnCountOnly") !== "true");
      expect(query?.get("where")).toBe("symbol IN ('1','2','3','4') AND gis_miles > 0");
      expect(query?.get("orderByFields")).toBe("gis_miles DESC");
      expect(query?.get("resultRecordCount")).toBe("2000");
      expect(query?.get("maxAllowableOffset")).toBe("0.00075");
      if (!("kind" in res.body) || res.body.kind !== "geojson") throw new Error("expected geojson");
      expect(res.body.data.features.map((f) => f.properties?.miles)).toEqual([35.07, 2.5]);
      expect(res.body).toMatchObject({
        total: 2440,
        truncated: true,
      });
      expect(res.body.coverageNote).toMatch(/^Showing the 2 longest of 2,440 \(ranked by segment length in miles\); zoom in under 25,000 km² for all/);
      // South-east Utah takes in the Moab area.
      expect(res.body.coverageNote).toContain("Bureau of Land Management, Moab Field Office");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns 422 zoom_in from runLayer only for a box wider than the whole US", async () => {
    const res = await runLayer("forest-roads", { bbox: [-180, -60, 180, 80] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ hint: "zoom_in" });
  });
});

describe("dispersed camping rules (AUDIT R14)", () => {
  const SEDONA: [number, number, number, number] = [-111.95, 34.75, -111.65, 34.95];
  const MOAB: [number, number, number, number] = [-109.75, 38.45, -109.4, 38.7];
  const LEADVILLE: [number, number, number, number] = [-106.5, 39.1, -106.1, 39.4];
  const NOW = new Date("2026-10-23T12:00:00Z");

  it("keeps every rule with an https order link, a date and a box", () => {
    expect(CAMPING_RULES.map((r) => r.id)).toEqual(["sedona-west", "sedona-oak-creek", "moab", "lake-tahoe-basin", "crested-butte"]);
    for (const r of CAMPING_RULES) {
      expect(r.url).toMatch(/^https:\/\/(www\.)?(fs\.usda\.gov|blm\.gov)\//);
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.bbox[0]).toBeLessThan(r.bbox[2]);
      expect(r.bbox[1]).toBeLessThan(r.bbox[3]);
    }
  });

  it("finds Sedona's two Coconino orders, Moab's BLM rule, and none near Leadville", () => {
    expect(campingRulesFor(SEDONA, NOW).map((r) => r.id)).toEqual(["sedona-west", "sedona-oak-creek"]);
    expect(campingRulesFor(MOAB, NOW).map((r) => r.id)).toEqual(["moab"]);
    expect(campingRulesFor(LEADVILLE, NOW)).toEqual([]);
    expect(campingRuleNote([])).toMatch(/check the ranger district's \(or BLM field office's\) closure orders/);
  });

  it("drops a rule past its end date", () => {
    expect(campingRulesFor(SEDONA, new Date("2029-01-01T00:00:00Z")).map((r) => r.id)).toEqual(["sedona-oak-creek"]);
  });

  it("puts the rule on Sedona's roads inside its box, with the order link on the card", () => {
    const fc = normalizeMvum(sedona);
    const n = attachCampingRules(fc, campingRulesFor(SEDONA, NOW));
    expect(n).toBeGreaterThan(0);
    const road = fc.features.find((f) => f.properties?.campingRule !== undefined)!;
    expect(road.properties?.campingRule).toMatch(/^Coconino National Forest, Red Rock Ranger District, .*\(Forest Order 03-04-06-2[36]-0[34], 20\d{2}-\d{2}-\d{2}\)$/);
    const card = cardContent(road, { card: layer.card, fieldHelp: layer.fieldHelp });
    expect(card.facts.map((r) => r.label)).toContain("Camping rule here");
    expect(card.links.find((l) => l.label === "Closure order")?.url).toMatch(/^https:\/\/www\.fs\.usda\.gov\/r03\/coconino\//);
  });
});
