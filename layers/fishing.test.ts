import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, {
  attachWaterTemps,
  buildFishingQuery,
  buildWideFishingQuery,
  dropSingleGaugeTemps,
  gaugeFor,
  gaugeMatch,
  gaugeNote,
  gaugeStream,
  inatUrl,
  montanaFeatures,
  nameUnnamed,
  osmFeatures,
  sightingFeatures,
  spotWater,
  troutBand,
  troutVerdict,
  usfsFeatures,
} from "./fishing";
import { parseIv, type IvSite } from "./_shared/usgs";
import { cardContent } from "@/lib/render/card";
import { labelsOf, legendOf, timeShapeOf } from "./contract";
import fwpFixture from "./__fixtures__/fishing-fwp.bozeman.json";
import osmFixture from "./__fixtures__/fishing-osm.tahoe.json";
import usfsFixture from "./__fixtures__/fishing-usfs.tahoe.json";
import inatFixture from "./__fixtures__/fishing-inat.tahoe.json";
import tempFixture from "./__fixtures__/usgs-temp.tahoe.json";

/** All four sources recorded for the Lake Tahoe box on 2026-10-10 ~02:23 UTC. */
const TAHOE: [number, number, number, number] = [-120.6, 38.6, -119.8, 39.3];
const NOW = new Date("2026-10-10T02:30:00Z");

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function routedStub(down: string[] = []) {
  return vi.fn(async (url: string, init?: { body?: string }) => {
    const which = init?.body?.startsWith("data=")
      ? "osm"
      : url.includes("apps.fs.usda.gov")
        ? "usfs"
        : url.includes("inaturalist")
          ? "inat"
          : "usgs";
    if (down.includes(which)) return new Response("down", { status: 503 });
    return json({ osm: osmFixture, usfs: usfsFixture, inat: inatFixture, usgs: tempFixture }[which]);
  });
}

function ctx(stub: ReturnType<typeof vi.fn>, bbox = TAHOE) {
  return { bbox, zoom: 10, env: {}, fetch: stub as unknown as CachedFetch, cacheKey: "fishing:k" };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("sources", () => {
  it("asks Overpass for fishing spots, slipways and fishing piers in (south,west,north,east) order", () => {
    const q = buildFishingQuery(TAHOE);
    expect(q).toContain('nwr["leisure"="fishing"](38.6,-120.6,39.3,-119.8)');
    expect(q).toContain('nwr["leisure"="slipway"]');
    expect(q).toContain('nwr["man_made"="pier"]["fishing"~"^(yes|designated)$"]');
    expect(q).toContain("out center tags");
  });

  it("turns OSM nodes and way centres into ramps with names", () => {
    const fs = osmFeatures(osmFixture);
    expect(fs).toHaveLength(48);
    expect(fs.every((f) => f.properties?.kind === "ramp")).toBe(true);
    expect(fs[0].properties).toMatchObject({ name: "Boat ramp", source: "OpenStreetMap", osmId: "node/90018423" });
    const pier = osmFeatures({ elements: [{ type: "way", id: 1, center: { lat: 1, lon: 2 }, tags: { man_made: "pier", fishing: "yes", name: "P" } }] });
    expect(pier[0]).toMatchObject({ geometry: { coordinates: [2, 1] }, properties: { kind: "pier", name: "P" } });
  });

  it("groups USFS activity rows into one access point per recreation area", () => {
    const fs = usfsFeatures(usfsFixture as unknown as FeatureCollection);
    expect(fs.length).toBeLessThan((usfsFixture as { features: unknown[] }).features.length);
    const big = fs.find((f) => f.properties?.name === "Big Meadow");
    expect(big?.properties).toMatchObject({
      kind: "access",
      source: "USFS",
      activities: "Lake and Pond Fishing; River and Stream Fishing",
      forest: "Lake Tahoe Basin Management Unit",
    });
  });

  it("asks iNaturalist for ray-finned fish in the last N days and drops hidden locations", () => {
    const u = new URL(inatUrl(TAHOE, 30, NOW));
    expect(u.searchParams.get("iconic_taxa")).toBe("Actinopterygii");
    expect(u.searchParams.get("d1")).toBe("2026-09-10");
    const { features, skipped } = sightingFeatures(inatFixture);
    expect(skipped).toBe(4);
    expect(features).toHaveLength(24);
    expect(features[0].properties).toMatchObject({ kind: "sighting", source: "iNaturalist" });
    expect(typeof features[0].properties?.t).toBe("string");
  });

  it("attaches a water temperature only from a gauge on the place's own water, never to sightings", () => {
    const places = osmFeatures(osmFixture);
    const sightings = sightingFeatures(inatFixture).features;
    const n = attachWaterTemps([...places, ...sightings], parseIv([tempFixture], NOW));
    expect(n).toBeGreaterThan(0);
    const withTemp = places.find((f) => f.properties?.waterTempC !== undefined)?.properties ?? {};
    expect(typeof withTemp.waterTempSite).toBe("string");
    expect(Number(withTemp.waterTempKm)).toBeLessThanOrEqual(30);
    expect(sightings.every((f) => f.properties?.waterTempC === undefined)).toBe(true);
  });
});

describe("a gauge on the spot's own water (UC11: 27 of 27 spots near Denver read one urban gauge)", () => {
  const gauge = (name: string, lon: number, lat: number, c: number): IvSite => ({
    siteId: `USGS-${name}`,
    siteNo: name,
    name,
    coordinates: [lon, lat],
    readings: { "00010": { value: c, time: Date.parse("2026-10-23T15:00:00Z"), local: "2026-10-23T09:00:00-06:00" } },
  });
  // Denver: three South Platte gauges and South Boulder Creek, as read live 2026-10-23.
  const DENVER = [
    gauge("SOUTH PLATTE R AT 64TH AVE. COMMERCE CITY, CO.", -104.95, 39.81, 13.9),
    gauge("SOUTH PLATTE RIVER AT ENGLEWOOD, CO.", -105.0, 39.66, 13.8),
    gauge("SOUTH BOULDER CR AT FOREBAY NR ELDORADO SPRINGS CO", -105.3, 39.93, 9.8),
  ];

  it("takes the gauge on the river the spot names, within 30 km, past a nearer gauge on other water", () => {
    const g = gaugeFor("South Boulder Creek Interpretive Site", [-105.2, 39.75], DENVER);
    expect(g).toMatchObject({ match: "same", stream: "South Boulder Creek" });
    expect(g!.km).toBeGreaterThan(15);
  });

  it("leaves a lake or other water without a temperature, however close a river gauge is", () => {
    expect(gaugeFor("Chatfield Reservoir Boat Ramp", [-105.0, 39.665], DENVER)).toBeUndefined();
    expect(gaugeFor("Clear Creek Fishing Access", [-104.96, 39.81], DENVER)).toBeUndefined();
  });

  it("gives a spot named for no water only a gauge within 3 km, marked as maybe other water", () => {
    expect(gaugeFor("West Boat Ramp", [-104.97, 39.81], DENVER)).toMatchObject({ match: "unknown" });
    expect(gaugeFor("West Boat Ramp", [-104.9, 39.75], DENVER)).toBeUndefined();
  });

  it("draws distinct readings: spots without a gauge on their water get no band at all", () => {
    const pt = (name: string, lon: number, lat: number) => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [lon, lat] }, properties: { kind: "access", name } });
    const spots = [pt("Fishing is Fun #4", -105.1, 39.7), pt("Gross Reservoir Boat Ramp", -105.36, 39.95), pt("South Platte River Trail Access", -105.0, 39.67)];
    expect(attachWaterTemps(spots, DENVER)).toBe(1);
    expect(spots.map((f) => (f.properties as Record<string, unknown>).tempBand)).toEqual([undefined, undefined, "good"]);
  });
});

describe("card", () => {
  it("never prints iNaturalist's taxon id (it read 'Taxon id 49,591')", () => {
    const first = sightingFeatures(inatFixture).features[0];
    const sighting = { ...first, properties: { ...first.properties, taxonId: 49591 } };
    const card = cardContent(sighting, { card: layer.card, fieldHelp: layer.fieldHelp });
    const rows = [...card.facts, ...card.details].map((r) => `${r.label} ${r.value}`).join(" | ");
    expect(rows).not.toMatch(/taxon/i);
    expect(layer.card?.hidden).toContain("taxonId");
  });
});

describe("ranking and names", () => {
  const point = (lon: number, lat: number, properties: Record<string, string | number>) => ({
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [lon, lat] },
    properties,
  });

  it("leaves waterTempF off when every place reads one gauge, so temperature is not offered as a rank, and keeps it with two", () => {
    const one = [
      point(-111.1, 44.8, { kind: "ramp", name: "Boat ramp", waterTempF: 47.1, waterTempSite: "Madison River near West Yellowstone, MT" }),
      point(-111.2, 44.8, { kind: "access", name: "Baker's Hole", waterTempF: 47.1, waterTempSite: "Madison River near West Yellowstone, MT" }),
      point(-111.2, 44.8, { kind: "sighting", species: "Brown Trout" }),
    ];
    expect(dropSingleGaugeTemps(one)).toBe("Madison River near West Yellowstone, MT");
    expect(one.every((f) => f.properties.waterTempF === undefined)).toBe(true);
    expect(one[0].properties.waterTempSite).toBe("Madison River near West Yellowstone, MT");
    const two = [
      point(-111.1, 44.8, { kind: "ramp", name: "Boat ramp", waterTempF: 52.3, waterTempSite: "Madison River bl Hebgen Lake nr Grayling MT" }),
      point(-111.2, 44.8, { kind: "access", name: "Baker's Hole", waterTempF: 48.7, waterTempSite: "Madison River near West Yellowstone, MT" }),
    ];
    expect(dropSingleGaugeTemps(two)).toBeUndefined();
    expect(two.map((f) => f.properties.waterTempF)).toEqual([52.3, 48.7]);
  });

  it("says on the card which gauge the temperature is from", () => {
    expect(layer.card?.facts?.find((f) => f.key === "waterTempSite")?.label).toBe("Gauge");
    expect(layer.card?.hidden).not.toContain("waterTempSite");
  });

  it("names an unnamed ramp or pier after the nearest named place within 5 km, and leaves a lone one as its kind", () => {
    const features = [
      point(-111.25, 44.75, { kind: "access", name: "Rainbow Point Campground" }),
      point(-111.26, 44.76, { kind: "ramp", name: "Boat ramp" }),
      point(-111.24, 44.74, { kind: "pier", name: "Fishing pier" }),
      point(-110.5, 44.0, { kind: "ramp", name: "Boat ramp" }),
      point(-111.25, 44.75, { kind: "sighting", species: "Brown Trout" }),
    ];
    expect(nameUnnamed(features)).toBe(2);
    expect(features.map((f) => f.properties.name)).toEqual([
      "Rainbow Point Campground",
      "Boat ramp near Rainbow Point Campground",
      "Fishing pier near Rainbow Point Campground",
      "Boat ramp",
      undefined,
    ]);
  });

  it("names the Tahoe ramps near named places, after the named places in the list", async () => {
    const r = await layer.query(ctx(routedStub()), { days: 30 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const names = r.data.features.filter((f) => f.properties?.kind === "ramp").map((f) => String(f.properties?.name));
    expect(names.some((n) => n.startsWith("Boat ramp near "))).toBe(true);
    expect(r.data.features[0].properties?.name).not.toMatch(/^Boat ramp/);
  });
});

describe("water temperature for trout", () => {
  it("bands the temperature and says the verdict in °F first", () => {
    expect([9.9, 10, 18, 18.5, 20.5].map(troutBand)).toEqual(["cold", "good", "good", "warm", "too_warm"]);
    expect(troutVerdict(8.5)).toBe("47 °F (8.5 °C): cold; trout feed best at 50 to 64 °F (10 to 18 °C)");
    expect(troutVerdict(14)).toBe("57 °F (14.0 °C): good; trout feed best at 50 to 64 °F (10 to 18 °C)");
    expect(troutVerdict(21)).toBe("70 °F (21.0 °C): too warm; trout are stressed above about 68 °F (20 °C)");
  });

  it("reads the stream from a USGS station name", () => {
    expect(gaugeStream("W FK CARSON R NR WOODFORDS CA")).toBe("West Fork Carson River");
    expect(gaugeStream("BLACKWOOD C NR TAHOE CITY CA")).toBe("Blackwood Creek");
    expect(gaugeStream("UPPER TRUCKEE RV AT SOUTH LAKE TAHOE, CA")).toBe("Upper Truckee River");
    expect(gaugeStream("Gallatin River near Gallatin Gateway, MT")).toBe("Gallatin River");
  });

  it("warns when the spot's name names other water than the gauge's, and says how far", () => {
    expect(gaugeMatch("Gallatin River Access", "Gallatin River")).toBe("same");
    expect(gaugeMatch("Moose Creek Flat Campground", "Gallatin River")).toBe("different");
    expect(gaugeMatch("Lake Tahoe - West Shore", "Blackwood Creek")).toBe("different");
    expect(gaugeMatch("Trout Lake Ramp", "Trout Creek")).toBe("different");
    expect(gaugeMatch("Erwin Bridge Fishing Access Site", "Gallatin River")).toBe("unknown");
    expect(spotWater("Lake Tahoe - West Shore")).toBe("Lake Tahoe");
    expect(spotWater("Moose Creek Flat Campground")).toBe("Moose Creek");
    expect(gaugeNote("different", "Gallatin River", 5, "Moose Creek Flat Campground")).toBe(
      "A gauge on Gallatin River, 3.1 mi (5.0 km) away, not on Moose Creek; that water can run warmer or colder",
    );
    expect(gaugeNote("same", "Gallatin River", 1.6)).toBe("The Gallatin River gauge, 1.0 mi (1.6 km) away");
    expect(gaugeNote("unknown", "Gallatin River", 14)).toBe("A gauge on Gallatin River, 8.7 mi (14.0 km) away; it may not be this spot's water");
  });

  it("gives each place near a gauge its band, verdict and gauge note", () => {
    const places = [...osmFeatures(osmFixture), ...usfsFeatures(usfsFixture as unknown as FeatureCollection)];
    attachWaterTemps(places, parseIv([tempFixture], NOW));
    const p = places.find((f) => f.properties?.waterTempC !== undefined)!.properties!;
    expect(p.tempBand).toBe(troutBand(p.waterTempC));
    expect(p.tempVerdict).toMatch(/^\d+ °F \(\d+\.\d °C\): /);
    expect(p.waterTempF).toBeCloseTo((p.waterTempC * 9) / 5 + 32, 1);
    expect(["same", "different", "unknown"]).toContain(p.gaugeMatch);
    expect(p.gaugeNote).toMatch(/mi \(\d+\.\d km\) away/);
  });

  it("turns Montana FWP fishing access sites into access points with the boat launch and page", () => {
    const fs = montanaFeatures(fwpFixture as unknown as FeatureCollection);
    expect(fs).toHaveLength(3);
    expect(fs[1].properties).toMatchObject({
      kind: "access",
      source: "Montana FWP",
      name: "Damselfly Fishing Access Site",
      boatLaunch: "Ramp (Concrete)",
      camping: "Yes",
      url: "https://myfwp.mt.gov/fishMT/fas/39754720",
    });
  });

  it("asks Montana FWP only when the box touches Montana", async () => {
    const BOZEMAN: [number, number, number, number] = [-111.6, 45.6, -111.0, 45.9];
    const stub = vi.fn(async (url: string, init?: { body?: string }) => {
      if (url.includes("fwp-gis.mt.gov")) return json(fwpFixture);
      return routedStub()(url, init);
    });
    const r = await layer.query(ctx(stub, BOZEMAN), { days: 30 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const fwp = (stub.mock.calls as unknown as [string][]).filter(([u]) => u.includes("fwp-gis.mt.gov"));
    expect(fwp).toHaveLength(1);
    expect(new URL(fwp[0][0]).searchParams.get("outFields")).toBe("NAME,BOAT_FAC,CAMPING,WEB_PAGE");
    expect(r.data.features.filter((f) => f.properties?.source === "Montana FWP")).toHaveLength(3);
    const tahoe = routedStub();
    await layer.query(ctx(tahoe), { days: 30 });
    expect((tahoe.mock.calls as unknown as [string][]).some(([u]) => u.includes("fwp-gis"))).toBe(false);
  });
});

describe("fishing layer", () => {
  it("declares kind chips, a trout band key with No water temperature, labels and sightings over days", async () => {
    const kind = layer.attributes?.find((a) => a.key === "kind");
    expect(kind?.primary).toBe(true);
    expect(kind?.levels?.map((l) => l.label)).toEqual(["Access", "Boat ramp", "Pier", "Fish seen"]);
    expect(layer.style.encode).toEqual({ color: "tempBand" });
    expect(legendOf(layer).items?.map((i) => i.label)).toEqual([
      "Cold: under 50 °F (10 °C)",
      "Good: 50 to 64 °F (10 to 18 °C)",
      "Warm: 64 to 68 °F (18 to 20 °C)",
      "Too warm: over 68 °F (20 °C)",
      "No water temperature",
    ]);
    expect(timeShapeOf(layer).shape).toBe("continuous");
    expect(labelsOf(layer)?.field).toBe("name");
    expect(layer.card?.hidden).toContain("osmId");
    expect(layer.card?.facts?.map((f) => f.key)).not.toContain("osmId");
    // Named places come first, so the top labels name real places, not "Boat ramp".
    const r = await layer.query(ctx(routedStub()), { days: 30 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features[0].properties?.name).not.toBe("Boat ramp");
  });

  it("merges all four sources and always notes that stocking reports are not included", async () => {
    const stub = routedStub();
    const r = await layer.query(ctx(stub), { days: 30 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const kinds = new Set(r.data.features.map((f) => f.properties?.kind));
    expect(kinds).toEqual(new Set(["ramp", "access", "sighting"]));
    expect(r.coverageNote).toMatch(/stocking reports are not included/i);
    expect(stub).toHaveBeenCalledTimes(4);
    const keys = (stub.mock.calls as unknown as [string, { cacheKey?: string }][]).map((c) => c[1].cacheKey);
    expect(keys).toContain("fishing:k:inat-fish");
    expect(keys).toContain("fishing:k:usgs-temp");
  });

  it("keeps working when some sources fail, and errors only when all do", async () => {
    const r = await layer.query(ctx(routedStub(["osm", "usgs"])), { days: 30 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features.some((f) => f.properties?.kind === "sighting")).toBe(true);
    expect(r.coverageNote).toMatch(/OpenStreetMap/);
    expect(r.coverageNote).toMatch(/USGS water temperature/);
    expect(await layer.query(ctx(routedStub(["osm", "usfs", "inat", "usgs"])), { days: 30 })).toMatchObject({
      hint: "upstream",
    });
  });

  it("notes when the iNaturalist (200) or Overpass (2,000) caps are hit, and that BLM is omitted", async () => {
    const r0 = await layer.query(ctx(routedStub()), { days: 30 });
    expect((r0 as { coverageNote?: string }).coverageNote).toMatch(/BLM fishing sites are not included/);
    expect((r0 as { coverageNote?: string }).coverageNote).not.toMatch(/capped|most recent of/);

    const manyOsm = {
      elements: Array.from({ length: 2000 }, (_, i) => ({ type: "node", id: i, lat: 39, lon: -120, tags: { leisure: "slipway" } })),
    };
    const busyInat = { ...inatFixture, total_results: 950 };
    const stub = vi.fn(async (url: string, init?: { body?: string }) => {
      if (init?.body?.startsWith("data=")) return json(manyOsm);
      if (url.includes("inaturalist")) return json(busyInat);
      return routedStub()(url, init);
    });
    const r = await layer.query(ctx(stub), { days: 30 });
    const note = (r as { coverageNote?: string }).coverageNote ?? "";
    expect(note).toMatch(/capped at 2,000/);
    expect(note).toMatch(/200 most recent of 950 fish sightings/);
  });

  it("skips the US-only sources abroad", async () => {
    const stub = routedStub();
    await layer.query(ctx(stub, [6.0, 46.0, 6.5, 46.4]), { days: 30 });
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("describes kinds, units, caveats and the user's words", () => {
    for (const word of ["fishing", "boat ramp", "stocking reports are NOT available", "waterTempC", "°C", "sighting", "BLM"]) {
      expect(layer.description).toContain(word);
    }
    expect(layer.style).toMatchObject({ geometry: "point", cluster: true });
    expect(layer.maxAreaKm2).toBe(50_000);
    expect(layer.hardMaxAreaKm2).toBe(1_500_000);
    expect(layer.wide).toEqual({ mode: "named", limit: 2000 });
  });

  it("rejects a box over 1,500,000 km2 and bad input through runLayer", async () => {
    expect((await runLayer("fishing", { bbox: [-130, 25, -65, 50] })).status).toBe(422);
    expect((await runLayer("fishing", { bbox: TAHOE, input: { days: 0 } })).status).toBe(400);
  });

  it("asks Overpass for named fishing places with counts in a wide box", () => {
    const q = buildWideFishingQuery([-124, 33, -110, 42], 2000);
    expect(q).toContain('nwr["leisure"="slipway"](33,-124,42,-110)');
    expect(q).toContain('nwr.all["name"]->.named;');
    expect(q).toContain(".all out count;");
    expect(q).toContain(".named out tags center 2000;");
  });

  it("bounds every source in wide mode, skips water temperature over four USGS strips and sets no total", async () => {
    const named = {
      elements: [
        { type: "count", id: 0, tags: { total: "9400" } },
        { type: "count", id: 0, tags: { total: "1200" } },
        { type: "node", id: 1, lat: 38, lon: -120, tags: { leisure: "slipway", name: "North Ramp" } },
      ],
    };
    const stub = vi.fn(async (url: string, init?: { body?: string }) => {
      if (init?.body?.startsWith("data=")) return json(named);
      if (url.includes("apps.fs.usda.gov")) return json({ ...usfsFixture, exceededTransferLimit: true });
      if (url.includes("inaturalist")) return json(inatFixture);
      return json(tempFixture);
    });
    // About 14 x 9 degrees: six USGS strips, so no water temperature.
    const r = await layer.query({ ...ctx(stub, [-124, 33, -110, 42]), wide: true, wideStrategy: layer.wide }, { days: 30 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const calls = stub.mock.calls as unknown as [string, { body?: string }][];
    expect(calls).toHaveLength(3);
    expect(calls.some(([u]) => u.includes("waterservices"))).toBe(false);
    const ql = decodeURIComponent(String(calls.find(([, i]) => i?.body?.startsWith("data="))?.[1].body));
    expect(ql).toContain(".named out tags center 2000;");
    const usfs = new URL(calls.find(([u]) => u.includes("apps.fs.usda.gov"))![0]);
    expect(usfs.searchParams.get("resultRecordCount")).toBe("2000");
    const inat = new URL(calls.find(([u]) => u.includes("inaturalist"))![0]);
    expect(inat.searchParams.get("per_page")).toBe("200");
    expect(inat.searchParams.get("order_by")).toBe("observed_on");
    expect(r.total).toBeUndefined();
    expect(r.coverageNote).toMatch(/OpenStreetMap: the first 1 of 1,200 named places \(9,400 in all; unnamed ones/);
    expect(r.coverageNote).toMatch(/USFS fishing areas stop at the first 2,000 activity rows/);
    expect(r.coverageNote).toMatch(/Water temperatures are left out/);
    expect(r.coverageNote).not.toMatch(/zoom in for all/);
  });

  it("keeps water temperature in a wide box of at most four strips", async () => {
    const stub = routedStub();
    // 9 x 6 degrees (about 500,000 km²): three strips.
    await layer.query({ ...ctx(stub, [-124, 36, -115, 42]), wide: true, wideStrategy: layer.wide }, { days: 30 });
    expect((stub.mock.calls as unknown as [string][]).filter(([u]) => u.includes("waterservices"))).toHaveLength(3);
  });
});

describe("fishing twins", () => {
  it("drops a place of the same name within 1 km (a ramp mapped as a node and a way), keeps sightings and far ones", async () => {
    const { dropNearTwins } = await import("./fishing");
    const pt = (name: string, lon: number, kind = "ramp") => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [lon, 45] }, properties: { name, kind } });
    const kept = dropNearTwins([pt("Boat ramp 9 km W of Law Park", -111.7), pt("Boat ramp 9 km W of Law Park", -111.701), pt("Boat ramp 9 km W of Law Park", -111.5), pt("Brown trout", -111.7, "sighting"), pt("Brown trout", -111.7, "sighting")]);
    expect(kept).toHaveLength(4);
  });
});
