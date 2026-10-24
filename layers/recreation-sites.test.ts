import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { cardTitle, contractProblems, displayOf, labelsOf, legendOf, timeShapeOf } from "./contract";
import layer, {
  BLM_FACILITIES_URL,
  BLM_SHOWN_FACILITIES,
  BLM_SITES_URL,
  USFS_URL,
  addOpportunities,
  byKind,
  dedupe,
  interleave,
  kindFromName,
  normalizeBlmFacilities,
  normalizeBlmSites,
  normalizeUsfs,
  usfsAreaRows,
  usfsAreasUrl,
} from "./recreation-sites";
import usfsRaw from "./__fixtures__/recreation-sites.usfs.tahoe.json";
import facilitiesRaw from "./__fixtures__/recreation-sites.blm-facilities.moab.json";
import sitesRaw from "./__fixtures__/recreation-sites.blm-sites.moab.json";

const usfsFc = usfsRaw as unknown as FeatureCollection;
const facilitiesFc = facilitiesRaw as unknown as FeatureCollection;
const sitesFc = sitesRaw as unknown as FeatureCollection;

/** Fixtures were recorded for Lake Tahoe (USFS) and Moab (BLM); the stub answers each service with its own. */
const BBOX: [number, number, number, number] = [-120.2, 38.8, -119.8, 39.2];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string, bbox = BBOX) {
  return { bbox, zoom: 10, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

function routed(overrides: { usfs?: () => Response; facilities?: () => Response; sites?: () => Response } = {}) {
  return vi.fn(async (url: string) => {
    if (url.startsWith(`${USFS_URL}/query`)) return overrides.usfs ? overrides.usfs() : json(usfsFc);
    if (url.startsWith(`${BLM_FACILITIES_URL}/query`)) return overrides.facilities ? overrides.facilities() : json(facilitiesFc);
    if (url.startsWith(`${BLM_SITES_URL}/query`)) return overrides.sites ? overrides.sites() : json(sitesFc);
    throw new Error(`unexpected url ${url}`);
  });
}

function geojson(r: Awaited<ReturnType<typeof layer.query>>) {
  if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
  return r;
}

describe("kindFromName", () => {
  it.each([
    ["Grandstaff Campground", "campground"],
    ["Hunter Canyon Trailhead", "trailhead"],
    ["Take Out Boat Ramp", "water access"],
    ["Lone Mesa Viewpoint", "viewpoint"],
    ["Moonflower Canyon Day Use Area", "day use area"],
    ["Moab Visitor Center", "visitor center"],
    ["Moab Rim Trail", "trail"],
    ["Sand Flats Recreation Area", "recreation area"],
    ["Camp Creek Overlook", "viewpoint"],
    ["Campbell Scenic Overlook", "viewpoint"],
    ["Camp Richardson Trailhead", "trailhead"],
    ["Camp Creek Boat Ramp", "water access"],
    ["Lone Pine Camp", "campground"],
    ["Campbell Hot Springs", "recreation area"],
    ["Camp Sherman Store", "recreation area"],
  ])("%s is %s", (name, kind) => expect(kindFromName(name)).toBe(kind));
});

describe("normalizeUsfs", () => {
  const sites = normalizeUsfs(usfsFc);

  it("merges the one-row-per-activity view into one point per area", () => {
    expect(usfsFc.features.length).toBe(112);
    expect(sites).toHaveLength(12);
    const names = sites.map((s) => s.properties.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("reads the site type from the primary marker group, with trailhead and campground names winning", () => {
    const kindOf = (name: string) => sites.find((s) => s.properties.name === name)?.properties.kind;
    expect(kindOf("Nevada Beach Campground and Day Use Pavilion")).toBe("campground");
    expect(kindOf("Zephyr Cove Resort")).toBe("campground");
    expect(kindOf("Kingsbury South Trailhead")).toBe("trailhead");
    expect(kindOf("Baldwin Beach")).toBe("water access");
    expect(kindOf("Genoa Peak Road 14N32")).toBe("OHV area");
    expect(kindOf("Skunk Harbor")).toBe("trail");
    // A specific marker group is trusted over the name; a broad one defers to a strict name match.
    const classify = (name: string, group: string) =>
      normalizeUsfs({
        type: "FeatureCollection",
        features: [
          { type: "Feature", geometry: { type: "Point", coordinates: [-120, 39] }, properties: { recareaid: 1, recareaname: name, markeractivitygroup: group } },
        ],
      })[0].properties.kind;
    expect(classify("Camp Creek Overlook", "Nature Viewing")).toBe("viewpoint");
    expect(classify("Camp Creek Overlook", "Hiking")).toBe("viewpoint");
    expect(classify("Pine Day Use Area", "Camping & Cabins")).toBe("campground");
    expect(classify("Lost Lake", "Fishing")).toBe("water access");
    expect(kindOf("Zephyr Cove Stables")).toBe("recreation area");
    // The generic "Intermediate Parent Group" marker falls back to a plain recreation area.
    expect(kindOf("Lake Tahoe - East Shore")).toBe("recreation area");
  });

  it("keeps the forest, agency, link and merged activities", () => {
    const nevada = sites.find((s) => s.properties.name === "Nevada Beach Campground and Day Use Pavilion");
    expect(nevada?.properties).toMatchObject({ agency: "USFS", forest: "Lake Tahoe Basin Management Unit" });
    expect(String(nevada?.properties.activities)).toContain("Campground Camping");
    expect(String(nevada?.properties.activities).split(", ").length).toBeGreaterThan(3);
    expect(String(nevada?.properties.url)).toMatch(/^https:\/\/www\.fs\.usda\.gov\//);
  });

  it("keeps status only when it is open or closed and skips rows without a point", () => {
    for (const s of sites) expect(["open", "closed", undefined]).toContain(s.properties.status);
    const out = normalizeUsfs({
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: null as never, properties: { recareaid: 1, recareaname: "Ghost" } }],
    });
    expect(out).toEqual([]);
  });
});

describe("normalizeBlm", () => {
  it("drops permit, pass and kiosk rows and types the rest", () => {
    const facilities = normalizeBlmFacilities(facilitiesFc);
    const dropped = facilitiesFc.features.filter((f) =>
      ["Permit", "Kiosk", "Activity Pass", "Ticket Facility", "Timed Entry", "Venue Reservations"].includes(
        String(f.properties?.FacilityTypeDescription),
      ),
    ).length;
    expect(dropped).toBeGreaterThan(0);
    expect(facilities).toHaveLength(facilitiesFc.features.length - dropped);
    const grandstaff = facilities.find((s) => s.properties.name === "Grandstaff Campground");
    expect(grandstaff?.properties).toMatchObject({ kind: "campground", agency: "BLM", state: "UT" });
    expect(String(grandstaff?.properties.url)).toContain("blm.gov");
    expect(facilities.find((s) => s.properties.name === "Hunter Canyon Trailhead")?.properties.kind).toBe("trailhead");
  });

  it("types recreation sites by name and lower-cases their activities", () => {
    const sites = normalizeBlmSites(sitesFc);
    expect(sites).toHaveLength(sitesFc.features.length);
    expect(sites.find((s) => s.properties.name === "Portal Trail")?.properties).not.toHaveProperty("activities");
    const rim = sites.find((s) => s.properties.name === "Moab Rim Trail");
    expect(rim?.properties).toMatchObject({ kind: "trail", agency: "BLM", activities: "hiking, off highway vehicle" });
  });

  it("merges the same name at the same place and keeps the first", () => {
    const merged = dedupe([...normalizeBlmFacilities(facilitiesFc), ...normalizeBlmSites(sitesFc)]);
    const all = normalizeBlmFacilities(facilitiesFc).length + normalizeBlmSites(sitesFc).length;
    expect(merged.length).toBeLessThan(all);
    const names = merged.map((s) => `${s.properties.name}|${s.geometry.coordinates[0].toFixed(3)}`);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("recreation-sites layer", () => {
  it("declares US coverage, public domain license, no env, an empty input and the cluster hint", () => {
    expect(layer.id).toBe("recreation-sites");
    expect(layer.coverage).toBe("us");
    expect(layer.license).toContain("Public domain");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(10_000);
    expect(layer.hardMaxAreaKm2).toBe(1_500_000);
    expect(layer.wide).toEqual({ mode: "named", limit: 2000 });
    expect(layer.input.parse({})).toEqual({});
    expect(layer.style).toMatchObject({ geometry: "point", cluster: true });
  });

  it("queries the three services and merges them with distinct cache suffixes", async () => {
    const stub = routed();
    const r = geojson(await layer.query(ctx(stub, "recreation-sites:key"), {}));
    expect(stub).toHaveBeenCalledTimes(3);
    const keys = (stub.mock.calls as unknown as [string, { cacheKey?: string }][]).map((c) => c[1].cacheKey);
    expect(new Set(keys).size).toBe(3);
    expect(keys.every((k) => k?.startsWith("recreation-sites:key:"))).toBe(true);
    const agencies = new Set(r.data.features.map((f) => f.properties?.agency));
    expect(agencies).toEqual(new Set(["USFS", "BLM"]));
    expect(r.data.features.length).toBeGreaterThan(40);
    expect(r.coverageNote).toBe("Campgrounds: 28 in all, 1 open and 1 closed in the Forest Service's nightly feed (BLM lists no status)");
    expect(r.citation.source).toContain("Forest Service");
  });

  it("says when the services capped their reply", async () => {
    const stub = routed({ usfs: () => json({ ...usfsFc, exceededTransferLimit: true }) });
    const r = geojson(await layer.query(ctx(stub), {}));
    expect(r.coverageNote).toContain("2,000 records");
  });

  it("keeps the sites that did load when one service fails", async () => {
    const stub = routed({ usfs: () => new Response("down", { status: 500 }) });
    const r = geojson(await layer.query(ctx(stub), {}));
    expect(r.data.features.every((f) => f.properties?.agency === "BLM")).toBe(true);
    expect(r.coverageNote).toBe("Forest Service did not respond, so its sites are missing; Campgrounds: 26 (no open or closed status listed)");
  });

  it("returns a hinted error when every service fails", async () => {
    const stub = vi.fn(async () => new Response("down", { status: 503 }));
    expect(await layer.query(ctx(stub), {})).toEqual({
      error: "ArcGIS service returned 503",
      hint: "upstream",
    });
  });

  it("returns an empty result with a note outside the US without calling anything", async () => {
    const stub = routed();
    const r = geojson(await layer.query(ctx(stub, undefined, [10, 45, 10.2, 45.2]), {}));
    expect(r.data.features).toEqual([]);
    expect(r.coverageNote).toBe("No data outside the United States");
    expect(stub).not.toHaveBeenCalled();
  });

  it("says so when the area has no sites", async () => {
    const empty = { type: "FeatureCollection", features: [] };
    const stub = routed({ usfs: () => json(empty), facilities: () => json(empty), sites: () => json(empty) });
    const r = geojson(await layer.query(ctx(stub), {}));
    expect(r.coverageNote).toBe("No Forest Service or BLM recreation sites in this area");
  });

  it("rejects a view over the 1,500,000 km² hard cap through runLayer", async () => {
    const r = await runLayer("recreation-sites", { bbox: [-125, 30, -100, 49] });
    expect(r.status).toBe(422);
  });

  it("asks the Forest Service view for one distinct row per area in wide views, and counts areas the same way", () => {
    const rows = new URL(usfsAreasUrl([-114, 36, -105, 42], 2000));
    expect(rows.origin + rows.pathname).toBe(`${USFS_URL}/query`);
    expect(rows.searchParams.get("returnDistinctValues")).toBe("true");
    expect(rows.searchParams.get("outFields")).not.toContain("activityname");
    expect(rows.searchParams.get("outFields")).toContain("longitude");
    expect(rows.searchParams.get("resultRecordCount")).toBe("2000");
    expect(rows.searchParams.get("f")).toBe("json");
    const count = new URL(usfsAreasUrl([-114, 36, -105, 42], 2000, true));
    expect(count.searchParams.get("returnCountOnly")).toBe("true");
    expect(count.searchParams.get("outFields")).toBe("recareaid");
  });

  it("reads distinct area rows as points from their longitude and latitude columns", () => {
    const fc = usfsAreaRows({
      features: [
        { attributes: { recareaid: 5573, recareaname: "Baker's Hole Campground", markeractivitygroup: "Camping & Cabins", openstatus: "closed", longitude: "-111.100810", latitude: "44.706290" } },
        { attributes: { recareaid: 1, recareaname: "Nowhere", longitude: "", latitude: "" } },
        { nope: true },
      ],
    });
    expect(fc.features).toHaveLength(1);
    expect(normalizeUsfs(fc)[0]).toMatchObject({
      geometry: { coordinates: [-111.10081, 44.70629] },
      properties: { name: "Baker's Hole Campground", kind: "campground", agency: "USFS", status: "closed" },
    });
    expect(usfsAreaRows({ error: { code: 400 } }).features).toEqual([]);
  });

  it("takes from the two agencies in turn up to the limit", () => {
    expect(interleave<number | string>([1, 2, 3], ["a"], 10)).toEqual([1, "a", 2, 3]);
    expect(interleave<number | string>([1, 2, 3], ["a", "b", "c"], 4)).toEqual([1, "a", 2, "b"]);
    expect(interleave<string>([], ["a", "b"], 1)).toEqual(["a"]);
  });

  it("answers a wide box (about 520,000 km²) with one row per area, named BLM sites, and a count of everything", async () => {
    const areaRows = {
      features: usfsFc.features.map((f) => ({
        attributes: {
          ...f.properties,
          longitude: String((f.geometry as { coordinates: number[] }).coordinates[0]),
          latitude: String((f.geometry as { coordinates: number[] }).coordinates[1]),
        },
      })),
      exceededTransferLimit: true,
    };
    const stub = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const counting = url.searchParams.get("returnCountOnly") === "true";
      if (String(input).startsWith(USFS_URL)) return counting ? json({ count: 2652 }) : json(areaRows);
      if (String(input).startsWith(BLM_FACILITIES_URL)) return counting ? json({ count: 678 }) : json(facilitiesFc);
      return counting ? json({ count: 584 }) : json(sitesFc);
    });
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("recreation-sites", { bbox: [-114, 36, -105, 42], zoom: 6 });
      expect(res.status).toBe(200);
      const urls = stub.mock.calls.map((c) => new URL(String(c[0])));
      const facilities = urls.filter((u) => u.href.startsWith(BLM_FACILITIES_URL));
      expect(facilities.find((u) => !u.searchParams.has("returnCountOnly"))?.searchParams.get("where")).toBe(`${BLM_SHOWN_FACILITIES} AND FacilityName > ' '`);
      expect(facilities.find((u) => u.searchParams.has("returnCountOnly"))?.searchParams.get("where")).toBe(BLM_SHOWN_FACILITIES);
      expect(urls.find((u) => u.href.startsWith(BLM_SITES_URL) && !u.searchParams.has("returnCountOnly"))?.searchParams.get("where")).toBe("RecAreaName > ' '");
      expect(urls.find((u) => u.href.startsWith(USFS_URL) && !u.searchParams.has("returnCountOnly"))?.searchParams.get("returnDistinctValues")).toBe("true");
      if (!("data" in res.body) || res.body.kind !== "geojson") throw new Error("expected geojson");
      const shown = res.body.data.features.length;
      expect(res.body.data.features.filter((f) => f.properties?.agency === "USFS")).toHaveLength(12);
      expect(res.body.data.features.some((f) => f.properties?.agency === "BLM")).toBe(true);
      expect(res.body).toMatchObject({ total: 3914, truncated: true, coverageNote: `Showing the ${shown} named of 3,914; zoom in under 10,000 km² for all` });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("recreation-sites kinds and key", () => {
  it("declares kind as the primary chip set covering every kind the layer returns, with agency, status and reservable", () => {
    const kind = layer.attributes?.find((a) => a.key === "kind");
    expect(kind).toMatchObject({ type: "category", primary: true });
    expect(kind?.levels?.map((l) => l.label)).toEqual(
      expect.arrayContaining(["Campgrounds", "Trailheads", "Day use and picnic areas", "Water access", "Visitor centers", "Winter sports", "Off-highway vehicle areas"]),
    );
    const values = new Set(kind?.levels?.map((l) => l.value));
    for (const f of [...normalizeUsfs(usfsFc), ...normalizeBlmFacilities(facilitiesFc), ...normalizeBlmSites(sitesFc)]) {
      expect(values.has(f.properties.kind as string)).toBe(true);
    }
    expect(layer.attributes?.map((a) => a.key)).toEqual(expect.arrayContaining(["agency", "status", "reservable", "name"]));
    expect(legendOf(layer)).toMatchObject({ kind: "categories", field: "kind" });
    expect(legendOf(layer).items?.[0].label).toBe("Campgrounds");
    expect(timeShapeOf(layer).shape).toBe("none");
    expect(labelsOf(layer)).toEqual({ field: "name", max: 6 });
    expect(displayOf(layer).units).toBe("us");
    expect(contractProblems(layer)).toEqual([]);
  });

  it("lists campgrounds first and trailheads next so the labels name them, and every card has a real title", async () => {
    const r = geojson(await layer.query(ctx(routed()), {}));
    const kinds = r.data.features.map((f) => f.properties?.kind);
    const firstOther = kinds.findIndex((k) => k !== "campground");
    expect(firstOther).toBeGreaterThan(0);
    expect(kinds.slice(firstOther).includes("campground")).toBe(false);
    expect(kinds[firstOther]).toBe("trailhead");
    for (const f of r.data.features) expect(cardTitle(layer, f)).not.toMatch(/^feature$/i);
  });

  it("keeps the source order within a kind", () => {
    const pt = (name: string, kind: string) => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [0, 0] }, properties: { name, kind } });
    expect(byKind([pt("a", "trail"), pt("b", "campground"), pt("c", "trail"), pt("d", "campground")]).map((f) => f.properties.name)).toEqual(["b", "d", "a", "c"]);
  });

  it("ignores stray and empty keys in its input instead of failing (the Tahoe kayak run sent a \"\" key)", () => {
    expect(layer.input.safeParse({ "": "" })).toEqual({ success: true, data: {} });
    expect(layer.input.safeParse({ kind: "campground", "": 1 })).toEqual({ success: true, data: {} });
  });

  it("adds the Forest Service's season, fee and reservations to its campgrounds, by area id", () => {
    const site = (name: string, areaId: string) => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [-120, 39] }, properties: { name, kind: "campground", agency: "USFS", areaId } as Record<string, string | boolean> });
    const nevada = site("Nevada Beach Campground", "11757");
    const zephyr = site("Zephyr Cove Resort", "11759");
    const blm = { ...site("Goose Island", "x"), properties: { name: "Goose Island", kind: "campground", agency: "BLM" } as Record<string, string | boolean> };
    const n = addOpportunities([nevada, zephyr, blm], {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: null as never, properties: { recareaid: 11757, open_season_start: "May", open_season_end: "October", feedescription: "Parking&nbsp;Fee", reservation_info: '<a href="https://www.recreation.gov/camping/campgrounds/232768">Reserve</a>' } },
        { type: "Feature", geometry: null as never, properties: { recareaid: 11759, open_season_start: null, open_season_end: null, feedescription: null, reservation_info: null } },
      ],
    });
    expect(n).toBe(2);
    expect(nevada.properties).toMatchObject({ season: "May to October", fee: "Parking Fee", reservable: true });
    expect(zephyr.properties).toMatchObject({ reservable: "not listed" });
    expect(zephyr.properties.season).toBeUndefined();
    expect(blm.properties.reservable).toBeUndefined();
  });
});
