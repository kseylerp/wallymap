import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import recorded from "@/lib/agent/__fixtures__/searchbox-forward.json";
import { geocodeWaypoint } from "@/lib/agent/geocode";
import { runRouteTool, type RouteToolOutput } from "@/lib/agent/route";
import type { MapView } from "@/lib/agent/view";
import type { CachedFetch } from "@/lib/fetch";

/** Search Box responses recorded live (lib/agent/__fixtures__/searchbox-forward.json), trimmed to the fields read. */
const fixtures = recorded as Record<string, unknown>;

const realFetch = globalThis.fetch;
const YOSEMITE_VALLEY: [number, number] = [-119.5578, 37.7313];
const LOS_ANGELES: [number, number] = [-118.2437, 34.0522];
const KENTUCKY: [number, number] = [-85.6, 38.1];
const NEW_HAMPSHIRE: [number, number] = [-71.4, 44.3];

const yosemiteView: MapView = { bbox: [-119.65, 37.68, -119.45, 37.78], zoom: 12, center: YOSEMITE_VALLEY };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** Which recorded response answers this lookup: by name, and by whether the bias point is near Yosemite. */
function fixtureFor(q: string, proximity: string | null): unknown {
  const [lng = 0, lat = 0] = (proximity ?? "").split(",").map(Number);
  const nearYosemite = proximity !== null && Math.abs(lng - YOSEMITE_VALLEY[0]) < 1 && Math.abs(lat - YOSEMITE_VALLEY[1]) < 1;
  const nearLosAngeles = proximity !== null && Math.abs(lng - LOS_ANGELES[0]) < 1 && Math.abs(lat - LOS_ANGELES[1]) < 1;
  switch (q.toLowerCase()) {
    case "nevada fall":
      return nearYosemite
        ? fixtures.nevadaFallNearYosemite
        : nearLosAngeles
          ? fixtures.nevadaFallNearLosAngeles
          : fixtures.nevadaFallNoProximity;
    case "happy isles":
      return nearYosemite ? fixtures.happyIslesNearYosemite : fixtures.happyIslesNoProximity;
    case "mist trail":
      return fixtures.mistTrailNearYosemite;
    case "mount washington":
      return fixtures.mountWashington;
    default:
      return { type: "FeatureCollection", features: [] };
  }
}

type Lookup = { q: string; proximity: string | null; bbox: string | null; types: string | null };

/** Stubs global fetch for Search Box; `emptyInBox` makes a bbox-limited lookup find nothing. */
function stubSearchBox(emptyInBox = false): Lookup[] {
  const lookups: Lookup[] = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (!url.pathname.includes("/searchbox/")) return json({ type: "FeatureCollection", features: [] });
    const lookup = {
      q: url.searchParams.get("q") ?? "",
      proximity: url.searchParams.get("proximity"),
      bbox: url.searchParams.get("bbox"),
      types: url.searchParams.get("types"),
    };
    lookups.push(lookup);
    if (emptyInBox && lookup.bbox) return json({ type: "FeatureCollection", features: [] });
    return json(fixtureFor(lookup.q, lookup.proximity));
  }) as typeof fetch;
  return lookups;
}

/** A Directions stub that echoes a straight line through the requested stops. */
function stubDirections(): { fetch: CachedFetch; urls: string[] } {
  const urls: string[] = [];
  const fetch: CachedFetch = async (url) => {
    urls.push(url);
    const path = new URL(url).pathname.split("/").at(-1) ?? "";
    const stops = path.split(";").map((pair) => pair.split(",").map(Number) as [number, number]);
    return json({
      code: "Ok",
      routes: [{ distance: 4200, duration: 3600, geometry: { type: "LineString", coordinates: stops } }],
      waypoints: stops.map((location) => ({ name: "", location })),
    });
  };
  return { fetch, urls };
}

beforeEach(() => {
  vi.stubEnv("MAPBOX_TOKEN", "sk.test-token");
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
});

describe("geocodeWaypoint", () => {
  it("searches points of interest and places with the bias point and the view box", async () => {
    const lookups = stubSearchBox();
    const bbox: [number, number, number, number] = [-119.65, 37.68, -119.45, 37.78];
    await geocodeWaypoint("Nevada Fall", { proximity: YOSEMITE_VALLEY, bbox });
    expect(lookups).toHaveLength(1);
    expect(lookups[0].types?.split(",")).toEqual(expect.arrayContaining(["poi", "place"]));
    expect(lookups[0].proximity).toBe("-119.5578,37.7313");
    expect(lookups[0].bbox).toBe("-119.65,37.68,-119.45,37.78");
  });

  it("picks the waterfall over a street of the same name that the geocoder listed first", async () => {
    stubSearchBox();
    // The recorded response lists "Nevada Fall", a street in Mariposa, ahead of the two POIs in Yosemite.
    const result = await geocodeWaypoint("Nevada Fall", { proximity: YOSEMITE_VALLEY });
    if ("error" in result) throw new Error(result.error);
    expect(result.center[0]).toBeCloseTo(-119.533, 2);
    expect(result.center[1]).toBeCloseTo(37.725, 2);
    expect(result.name).toContain("Yosemite National Park");
  });

  it("prefers the island in Yosemite to a bridal shop of the same name", async () => {
    stubSearchBox();
    const result = await geocodeWaypoint("Happy Isles");
    if ("error" in result) throw new Error(result.error);
    expect(result.center[0]).toBeCloseTo(-119.559, 2);
  });

  it("settles a city-versus-POI tie by distance to the bias point, then by kind", async () => {
    stubSearchBox();
    // "Mount Washington" is a town in Kentucky, a mountain in British Columbia, and the summit in New Hampshire.
    const nearNh = await geocodeWaypoint("Mount Washington", { proximity: NEW_HAMPSHIRE });
    if ("error" in nearNh) throw new Error(nearNh.error);
    expect(nearNh.center[0]).toBeCloseTo(-71.303, 2);
    const nearKentucky = await geocodeWaypoint("Mount Washington", { proximity: KENTUCKY });
    if ("error" in nearKentucky) throw new Error(nearKentucky.error);
    expect(nearKentucky.center[0]).toBeCloseTo(-85.543, 2);
    // With nothing to bias by, a natural feature beats the town.
    const unbiased = await geocodeWaypoint("Mount Washington");
    if ("error" in unbiased) throw new Error(unbiased.error);
    expect(unbiased.center[0]).not.toBeCloseTo(-85.543, 2);
  });

  it("finds a trail as the trailhead POI near the bias point, not the street of that name in South Carolina", async () => {
    stubSearchBox();
    // The recorded response has a street named Mist Trail (exact name) alongside the Yosemite trailheads (partial names).
    const result = await geocodeWaypoint("Mist Trail", { proximity: [-119.559, 37.73], trail: true });
    if ("error" in result) throw new Error(result.error);
    expect(result.center[0]).toBeCloseTo(-119.558, 2);
    expect(result.name).toContain("Yosemite National Park");
  });

  it("retries without the box when the box holds nothing", async () => {
    const lookups = stubSearchBox(true);
    const result = await geocodeWaypoint("Happy Isles", { proximity: YOSEMITE_VALLEY, bbox: [10, 10, 11, 11] });
    expect("error" in result).toBe(false);
    expect(lookups.map((l) => l.bbox)).toEqual(["10,10,11,11", null]);
  });
});

describe("runRouteTool waypoints", () => {
  it("routes Happy Isles to Nevada Fall via the Mist Trail inside Yosemite", async () => {
    const lookups = stubSearchBox();
    const { fetch, urls } = stubDirections();
    const result = await runRouteTool(
      { from: "Happy Isles", to: "Nevada Fall via the Mist Trail" },
      { fetch, view: yosemiteView },
    );
    if ("error" in result) throw new Error(result.error);

    // The start is looked up around the view; the trail and the end follow the waypoint before them.
    expect(lookups.map((l) => [l.q, l.proximity])).toEqual([
      ["Happy Isles", "-119.5578,37.7313"],
      ["Mist Trail", "-119.55905313,37.72992057"],
      ["Nevada Fall", expect.stringMatching(/^-119\.5/)],
    ]);
    expect(lookups[0].bbox).toBe("-119.65,37.68,-119.45,37.78");
    expect(lookups[1].bbox).toBeNull();

    // Three stops (start, trail, end), all in Yosemite, not a drive to Los Angeles.
    const stops = new URL(urls[0]).pathname.split("/").at(-1)!.split(";");
    expect(stops).toHaveLength(3);
    expect(result.bbox[0]).toBeGreaterThan(-119.7);
    expect(result.bbox[3]).toBeLessThan(37.8);
    expect(result.resolved.via).toHaveLength(1);
    expect(result.resolved.to).toContain("Nevada Fall");
    expect(result.name).toBe("Happy Isles to Nevada Fall via Mist Trail");
    expect(result.notes).toBeUndefined();
  });

  it("accepts the trail as its own via field", async () => {
    stubSearchBox();
    const { fetch, urls } = stubDirections();
    const result = await runRouteTool({ from: "Happy Isles", to: "Nevada Fall", via: ["Mist Trail"] }, { fetch, view: yosemiteView });
    expect("error" in result).toBe(false);
    expect(new URL(urls[0]).pathname.split("/").at(-1)!.split(";")).toHaveLength(3);
  });

  it("says so and routes without a trail the geocoder cannot place", async () => {
    stubSearchBox();
    const { fetch, urls } = stubDirections();
    const result = (await runRouteTool(
      { from: "Happy Isles", to: "Nevada Fall via the Imaginary Trail" },
      { fetch, view: yosemiteView },
    )) as RouteToolOutput;
    expect(new URL(urls[0]).pathname.split("/").at(-1)!.split(";")).toHaveLength(2);
    expect(result.notes?.[0]).toContain("Imaginary Trail");
    expect(result.notes?.[0]).toContain("does not follow it");
    expect(result.resolved.via).toBeUndefined();
  });

  it("skips a same-named trail that is far from the route", async () => {
    const { fetch, urls } = stubDirections();
    const geocode = vi.fn(async (place: string) =>
      place === "Mist Trail"
        ? { bbox: [0, 0, 0, 0] as [number, number, number, number], center: [-80, 40.6] as [number, number], name: "Blue Mist Trail, Pennsylvania", source: "mapbox" as const }
        : { bbox: [0, 0, 0, 0] as [number, number, number, number], center: place === "Happy Isles" ? [-119.559, 37.73] as [number, number] : [-119.533, 37.725] as [number, number], name: place, source: "mapbox" as const },
    );
    const result = (await runRouteTool({ from: "Happy Isles", to: "Nevada Fall", via: "Mist Trail" }, { geocode, fetch })) as RouteToolOutput;
    expect(new URL(urls[0]).pathname.split("/").at(-1)!.split(";")).toHaveLength(2);
    expect(result.notes).toHaveLength(1);
  });

  it("looks a far waypoint up again close to the one before it", async () => {
    const { fetch } = stubDirections();
    const calls: [string, unknown][] = [];
    const box = [0, 0, 0, 0] as [number, number, number, number];
    const geocode = vi.fn(async (place: string, opts?: { proximity?: [number, number]; bbox?: unknown }) => {
      calls.push([place, opts]);
      if (place === "Happy Isles") return { bbox: box, center: [-119.559, 37.73] as [number, number], name: "Happy Isles", source: "mapbox" as const };
      // First answer lands in Los Angeles; the answer with a box around the start is the right one.
      return opts?.bbox
        ? { bbox: box, center: [-119.533, 37.725] as [number, number], name: "Nevada Fall, Yosemite", source: "mapbox" as const }
        : { bbox: box, center: LOS_ANGELES, name: "Nevada Fall, Los Angeles", source: "mapbox" as const };
    });
    const result = await runRouteTool({ from: "Happy Isles", to: "Nevada Fall" }, { geocode, fetch, view: yosemiteView });
    if ("error" in result) throw new Error(result.error);
    expect(result.resolved.to).toBe("Nevada Fall, Yosemite");
    expect(calls).toHaveLength(3);
    expect(calls[2][1]).toMatchObject({ proximity: [-119.559, 37.73] });
  });

  it("names the ambiguous waypoint instead of routing across the state", async () => {
    // Searching around Los Angeles finds the waterfall in Yosemite, 380 km away; a box around LA finds nothing.
    stubSearchBox(true);
    const { fetch, urls } = stubDirections();
    const result = await runRouteTool({ from: LOS_ANGELES, to: "Nevada Fall" }, { fetch });
    expect(urls).toHaveLength(0);
    expect(result).toMatchObject({ error: expect.stringContaining('"Nevada Fall" is ambiguous') });
    const error = (result as { error: string }).error;
    expect(error).toContain("km from 34.0522, -118.2437");
    expect(error).toContain("Name it more fully");
  });

  it("allows the long hop when the profile is driving and no view limits it", async () => {
    stubSearchBox();
    const { fetch, urls } = stubDirections();
    const result = await runRouteTool({ from: LOS_ANGELES, to: "Nevada Fall", profile: "driving" }, { fetch });
    expect("error" in result).toBe(false);
    expect(urls).toHaveLength(1);
  });

  it("limits a hop to ten view spans, with the view's own span as the yardstick", async () => {
    stubSearchBox(true);
    const { fetch } = stubDirections();
    // A driving route is allowed 300+ km, but a zoomed-in view makes 380 km "far".
    const result = await runRouteTool(
      { from: LOS_ANGELES, to: "Nevada Fall", profile: "driving" },
      { fetch, view: { bbox: [-118.3, 34.0, -118.2, 34.1], zoom: 12, center: LOS_ANGELES } },
    );
    expect(result).toMatchObject({ error: expect.stringContaining("ambiguous") });
  });
});
