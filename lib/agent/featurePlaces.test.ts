import { describe, expect, it, vi } from "vitest";
import type { OsmPlace } from "@/lib/agent/nominatim";
import { isFeatureName, pickFeature, townWins } from "@/lib/agent/featurePlaces";

// Nominatim answers recorded 2026-10-23 (name, class, type, importance, bbox [w, s, e, n]).
const osm = (name: string, category: string, type: string, importance: number, bbox: [number, number, number, number], label = name): OsmPlace => ({
  name,
  label,
  category,
  type,
  importance,
  bbox,
  center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
});

const LAKE_POWELL = [
  osm("Lake Powell", "water", "reservoir", 0.435, [-111.567, 36.844, -110.287, 37.909], "Lake Powell, San Juan County, Utah, United States"),
  osm("Lake Powell", "boundary", "administrative", 0.16, [142.867, -34.781, 143.018, -34.648], "Lake Powell, Victoria, Australia"),
  osm("Lake Powell", "water", "lake", 0.133, [-105.662, 40.254, -105.659, 40.257], "Lake Powell, Grand County, Colorado, United States"),
];
const MOUNT_RAINIER = [
  osm("Mount Rainier", "natural", "volcano", 0.519, [-121.7576, 46.8521, -121.7575, 46.8523], "Mount Rainier, Pierce County, Washington, United States"),
  osm("Mount Rainier", "boundary", "administrative", 0.187, [-76.974, 38.932, -76.956, 38.954], "Mount Rainier, Prince George's County, Maryland"),
];
const HALF_MOON_BAY = [
  osm("Half Moon Bay", "boundary", "administrative", 0.485, [-122.477, 37.424, -122.416, 37.523]),
  osm("Half Moon Bay", "natural", "bay", 0.394, [-122.4720, 37.4832, -122.4719, 37.4833]),
];
const JACKSON_HOLE = [
  osm("Jackson Hole", "natural", "water", 0.107, [-88.6105, 37.5114, -88.6101, 37.5117], "Jackson Hole, Pope County, Illinois"),
  osm("Jackson Hole", "natural", "bay", 0.107, [-147.2137, 60.8961, -147.2136, 60.8962], "Jackson Hole, Alaska"),
];
const MOJAVE_ROAD = [
  osm("Mojave Road", "highway", "residential", 0.053, [-115.984, 34.12, -115.984, 34.123]),
  osm("Mojave Road", "highway", "track", 0.053, [-114.774, 35.073, -114.715, 35.115]),
  osm("Mojave Road", "highway", "track", 0.053, [-114.796, 35.112, -114.774, 35.115]),
  osm("Mojave Road", "highway", "track", 0.053, [-116.896, 34.865, -116.892, 34.865]),
  osm("Mojave Road", "highway", "track", 0.053, [-114.637, 35.045, -114.627, 35.053]),
];
const WONDERLAND_TRAIL = [
  osm("Wonderland Trail", "highway", "residential", 0.053, [-96.845, 32.896, -96.845, 32.902]),
  osm("Wonderland Trail", "highway", "residential", 0.053, [-104.671, 38.933, -104.67, 38.934]),
];

describe("pickFeature", () => {
  it("takes the reservoir over the town of the same name, and keeps its whole extent", () => {
    expect(pickFeature("Lake Powell", LAKE_POWELL)).toMatchObject({ bbox: [-111.567, 36.844, -110.287, 37.909] });
    // Words after the name that say where it is.
    expect(pickFeature("Lake Powell Utah", LAKE_POWELL)).toMatchObject({ bbox: [-111.567, 36.844, -110.287, 37.909] });
    // Near the view, the small Colorado lake of that name.
    expect(pickFeature("Lake Powell", LAKE_POWELL, [-105.7, 40.3])?.center[1]).toBeCloseTo(40.2554, 3);
  });

  it("boxes a volcano mapped as a point to its slopes, not Maryland's town", () => {
    const found = pickFeature("Mount Rainier", MOUNT_RAINIER);
    expect(found?.center[0]).toBeCloseTo(-121.7576, 3);
    expect(found!.bbox[2] - found!.bbox[0]).toBeGreaterThan(0.25);
  });

  it("leaves a town that outranks the feature of its name to the place geocoder", () => {
    expect(pickFeature("Half Moon Bay", HALF_MOON_BAY)).toBeNull();
    expect(townWins("Half Moon Bay", HALF_MOON_BAY)).toBe(true);
    expect(townWins("Lake Powell", LAKE_POWELL)).toBe(false);
  });

  it("does not take an obscure feature far from anywhere asked", () => {
    expect(pickFeature("Jackson Hole", JACKSON_HOLE)).toBeNull();
    expect(pickFeature("Jackson Hole", JACKSON_HOLE, [-88.6, 37.5])).not.toBeNull();
  });

  it("joins the tracks of a named route and leaves out streets", () => {
    const road = pickFeature("Mojave Road", MOJAVE_ROAD);
    expect(road?.bbox).toEqual([-116.896, 34.865, -114.627, 35.115]);
    expect(pickFeature("Wonderland Trail", WONDERLAND_TRAIL)).toBeNull();
  });
});

describe("isFeatureName", () => {
  it.each(["Tomales Bay", "Lake Powell", "Mount Rainier", "Wonderland Trail", "Mojave Road", "Madison River", "Jackson Hole", "Teton Pass", "Red Rock Canyon National Conservation Area"])(
    "%s is a feature",
    (name) => expect(isFeatureName(name)).toBe(true),
  );
  it.each(["Moab", "Boulder, CO", "Chamonix", "Medicine Bow", "Sedona, Arizona"])("%s is not", (name) => expect(isFeatureName(name)).toBe(false));
});

describe("featureLookup", () => {
  it("asks Nominatim with the app's User-Agent and falls back to Wikidata for a trail it knows only as streets", async () => {
    vi.resetModules();
    const { featureLookup } = await import("@/lib/agent/featurePlaces");
    const seen: { url: URL; agent: string | null }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({ url, agent: new Headers(init?.headers).get("user-agent") });
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.host === "nominatim.openstreetmap.org") {
        return json(WONDERLAND_TRAIL.map((p) => ({ name: p.name, display_name: p.label, category: p.category, type: p.type, importance: p.importance, lat: p.center[1], lon: p.center[0], boundingbox: [p.bbox[1], p.bbox[3], p.bbox[0], p.bbox[2]] })));
      }
      if (url.searchParams.get("action") === "wbsearchentities") return json({ search: [{ id: "Q3498361", label: "Wonderland Trail", description: "trail in Mount Rainier National Park" }] });
      return json({ entities: { Q3498361: { claims: { P625: [{ mainsnak: { datavalue: { value: { longitude: -121.659, latitude: 46.869 } } } }] } } } });
    }) as typeof fetch;
    try {
      const found = await featureLookup("Wonderland Trail");
      expect(found).toMatchObject({ source: "wikidata", center: [-121.659, 46.869] });
      expect(found!.bbox[2] - found!.bbox[0]).toBeGreaterThan(0.4);
      const nominatim = seen.find((s) => s.url.host === "nominatim.openstreetmap.org");
      expect(nominatim?.agent).toMatch(/^WallyMap\/1\.0 /);
      expect(nominatim?.url.searchParams.get("q")).toBe("Wonderland Trail");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
