import type { Position } from "geojson";
import type { Tool } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import fixture from "@/lib/agent/__fixtures__/directions-walking-tahoe.json";
import { fetchRoute, routeId, routeOutputForModel, runRouteTool, simplifyLine, type RouteToolOutput } from "@/lib/agent/route";
import { buildTools } from "@/lib/agent/tools";
import type { CachedFetch } from "@/lib/fetch";

const TAHOE_CITY: [number, number] = [-120.1449, 39.1719];
const EMERALD_BAY: [number, number] = [-120.1036, 38.9541];

type Call = { url: string; init?: Parameters<CachedFetch>[1] };

/** A fetch stub that answers every request with `body` and records the calls. */
function stubFetch(body: unknown, status = 200): { fetch: CachedFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: CachedFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

describe("fetchRoute", () => {
  beforeEach(() => {
    vi.stubEnv("MAPBOX_TOKEN", "sk.test-token");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("asks Directions v5 for a full GeoJSON route and reads the fixture", async () => {
    const { fetch, calls } = stubFetch(fixture);
    const result = await fetchRoute({ from: TAHOE_CITY, to: EMERALD_BAY, profile: "walking" }, fetch);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe(
      "https://api.mapbox.com/directions/v5/mapbox/walking/-120.1449,39.1719;-120.1036,38.9541",
    );
    expect(url.searchParams.get("geometries")).toBe("geojson");
    expect(url.searchParams.get("overview")).toBe("full");
    expect(url.searchParams.get("access_token")).toBe("sk.test-token");
    // Cached by the request without the token.
    expect(calls[0].init?.cacheKey).toBe(`route:${calls[0].url.replace("&access_token=sk.test-token", "")}`);
    expect(calls[0].init?.ttlSeconds).toBe(86_400);

    if ("error" in result) throw new Error(result.error);
    expect(result.distanceKm).toBe(27.34);
    expect(result.durationMin).toBe(328);
    expect(result.line.type).toBe("LineString");
    expect(result.line.coordinates[0]).toEqual([-120.14489, 39.17194]);
    expect(result.line.coordinates.at(-1)).toEqual([-120.10356, 38.95411]);
    expect(result.waypoints).toEqual([
      { lngLat: [-120.144886, 39.171944], type: "start", name: "North Lake Boulevard" },
      { lngLat: [-120.103562, 38.954107], type: "end", name: "Emerald Bay Road" },
    ]);
  });

  it("uses the public token when no server token is set", async () => {
    vi.stubEnv("MAPBOX_TOKEN", "");
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", "pk.public");
    const { fetch, calls } = stubFetch(fixture);
    await fetchRoute({ from: TAHOE_CITY, to: EMERALD_BAY, profile: "cycling" }, fetch);
    expect(calls[0].url).toContain("/mapbox/cycling/");
    expect(new URL(calls[0].url).searchParams.get("access_token")).toBe("pk.public");
  });

  it("returns errors as data: no token, no route, HTTP failure, network failure", async () => {
    const args = { from: TAHOE_CITY, to: EMERALD_BAY, profile: "driving" as const };
    vi.stubEnv("MAPBOX_TOKEN", "");
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", "");
    expect(await fetchRoute(args, stubFetch(fixture).fetch)).toEqual({ error: "MAPBOX_TOKEN is not set" });
    vi.stubEnv("MAPBOX_TOKEN", "sk.test-token");

    const noRoute = { code: "NoRoute", message: "No route found", routes: [], waypoints: [] };
    expect(await fetchRoute(args, stubFetch(noRoute).fetch)).toEqual({ error: "No route found" });

    const unauthorized = await fetchRoute(args, stubFetch({ message: "Not Authorized - Invalid Token" }, 401).fetch);
    expect(unauthorized).toEqual({ error: "Directions failed with HTTP 401: Not Authorized - Invalid Token" });

    const failing: CachedFetch = async () => {
      throw new TypeError("fetch failed");
    };
    const offline = await fetchRoute(args, failing);
    expect("error" in offline && offline.error).toMatch(/^Directions failed: TypeError: fetch failed/);

    const leaky: CachedFetch = async (url) => {
      throw new Error(`request to ${url} failed`);
    };
    const leaked = await fetchRoute(args, leaky);
    expect("error" in leaked && leaked.error).toContain("access_token=[token]");
    expect("error" in leaked && leaked.error).not.toContain("sk.test-token");

    expect(await fetchRoute(args, stubFetch({ nonsense: true }).fetch)).toEqual({
      error: "Directions returned an unexpected response",
    });
  });
});

describe("simplifyLine", () => {
  it("drops collinear points and keeps the ends", () => {
    const straight: Position[] = Array.from({ length: 100 }, (_, i) => [-120 + i * 0.0001, 39]);
    expect(simplifyLine(straight)).toEqual([[-120, 39], [-119.9901, 39]]);
  });

  it("loosens until the line fits the point budget", () => {
    const zigzag: Position[] = Array.from({ length: 1500 }, (_, i) => [-120 + i * 0.0005, 39 + (i % 2) * 0.001]);
    const simplified = simplifyLine(zigzag, 300);
    expect(simplified.length).toBeLessThanOrEqual(300);
    expect(simplified[0]).toEqual([-120, 39]);
    expect(simplified.at(-1)).toEqual(zigzag.at(-1)!.map((v) => Math.round(v * 1e5) / 1e5));
  });
});

describe("runRouteTool", () => {
  beforeEach(() => {
    vi.stubEnv("MAPBOX_TOKEN", "sk.test-token");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const geocode = vi.fn(async (place: string) =>
    place === "Tahoe City"
      ? { bbox: [-120.2, 39.1, -120.1, 39.2] as [number, number, number, number], center: TAHOE_CITY, name: "Tahoe City, California", source: "mapbox" as const }
      : place === "Emerald Bay"
        ? { bbox: [-120.15, 38.9, -120.05, 39.0] as [number, number, number, number], center: EMERALD_BAY, name: "Emerald Bay", source: "mapbox" as const }
        : { error: `No match for ${place}` },
  );

  it("geocodes place names, defaults to walking, and returns an id, name and bbox", async () => {
    const { fetch, calls } = stubFetch(fixture);
    const result = await runRouteTool({ from: "Tahoe City", to: "Emerald Bay" }, { geocode, fetch });
    if ("error" in result) throw new Error(result.error);
    expect(calls[0].url).toContain("/mapbox/walking/-120.1449,39.1719;-120.1036,38.9541");
    expect(result).toMatchObject({
      id: "walking-tahoe-city-to-emerald-bay",
      name: "Tahoe City to Emerald Bay",
      profile: "walking",
      distanceKm: 27.34,
    });
    expect(result.bbox).toEqual([-120.16307, 38.95411, -120.10356, 39.17194]);
    expect(result.resolved).toEqual({ from: "Tahoe City, California", to: "Emerald Bay" });
  });

  it("biases the end's lookup toward the resolved start, and looks the start up unbiased", async () => {
    const calls: [string, unknown][] = [];
    const spy = vi.fn(async (place: string, opts?: { proximity?: [number, number] }) => {
      calls.push([place, opts]);
      return geocode(place);
    });
    const { fetch } = stubFetch(fixture);
    await runRouteTool({ from: "Tahoe City", to: "Emerald Bay" }, { geocode: spy, fetch });
    expect(calls).toEqual([
      ["Tahoe City", undefined],
      ["Emerald Bay", { proximity: TAHOE_CITY }],
    ]);
    calls.length = 0;
    await runRouteTool({ from: TAHOE_CITY, to: "Emerald Bay" }, { geocode: spy, fetch });
    expect(calls).toEqual([["Emerald Bay", { proximity: TAHOE_CITY }]]);
  });

  it("stops at the start when it cannot be found, without looking up the end", async () => {
    const spy = vi.fn(geocode);
    const result = await runRouteTool({ from: "Atlantis", to: "Emerald Bay" }, { geocode: spy, fetch: stubFetch(fixture).fetch });
    expect(result).toEqual({ error: "Could not find Atlantis: No match for Atlantis" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("takes coordinates as they are and a given name", async () => {
    const { fetch } = stubFetch(fixture);
    const result = await runRouteTool(
      { from: TAHOE_CITY, to: EMERALD_BAY, profile: "cycling", name: "West shore ride" },
      { geocode, fetch },
    );
    expect(result).toMatchObject({
      name: "West shore ride",
      profile: "cycling",
      id: "cycling-39-1719-120-1449-to-38-9541-120-1036",
      resolved: { from: "39.1719, -120.1449", to: "38.9541, -120.1036" },
    });
  });

  it("reports a place it cannot find without calling Directions", async () => {
    const { fetch, calls } = stubFetch(fixture);
    const result = await runRouteTool({ from: "Atlantis", to: "Emerald Bay" }, { geocode, fetch });
    expect(result).toEqual({ error: "Could not find Atlantis: No match for Atlantis" });
    expect(calls).toHaveLength(0);
  });

  it("names the places it resolved when Directions finds no route", async () => {
    const noRoute = { code: "NoRoute", message: "No route found", routes: [], waypoints: [] };
    const result = await runRouteTool({ from: "Tahoe City", to: "Emerald Bay" }, { geocode, fetch: stubFetch(noRoute).fetch });
    expect(result).toEqual({
      error: "No route found (Tahoe City resolved to Tahoe City, California; Emerald Bay resolved to Emerald Bay)",
    });
  });

  it("gives the model everything but the coordinates", async () => {
    const result = (await runRouteTool({ from: "Tahoe City", to: "Emerald Bay" }, { geocode, fetch: stubFetch(fixture).fetch })) as RouteToolOutput;
    const forModel = routeOutputForModel(result) as Record<string, unknown>;
    expect(forModel.line).toBeUndefined();
    expect(forModel).toMatchObject({ distanceKm: 27.34, durationMin: 328, pointCount: result.line.coordinates.length });
    expect(routeOutputForModel({ error: "x" })).toEqual({ error: "x" });
  });
});

describe("routeId", () => {
  it("keeps short ids readable and gives long ids sharing a prefix distinct hashed tails", () => {
    expect(routeId("walking Tahoe City to Emerald Bay")).toBe("walking-tahoe-city-to-emerald-bay");
    const a = routeId("walking Tahoe City, California, United States to Emerald Bay State Park North");
    const b = routeId("walking Tahoe City, California, United States to Emerald Bay State Park South");
    expect(a).not.toBe(b);
    for (const id of [a, b]) {
      expect(id.length).toBeLessThanOrEqual(60);
      expect(id).toMatch(/^walking-tahoe-city-california-united-states-to-[a-z-]*-[0-9a-f]{8}$/);
    }
    expect(routeId("walking Tahoe City, California, United States to Emerald Bay State Park North")).toBe(a);
    expect(routeId("!!!")).toBe("route");
  });
});

describe("route tool schema", () => {
  const schema = buildTools().route.inputSchema as z.ZodType;

  it("accepts place names or [lon, lat] and defaults the profile to walking", () => {
    expect(schema.parse({ from: "Tahoe City", to: [-120.1, 38.95] })).toEqual({
      from: "Tahoe City",
      to: [-120.1, 38.95],
      profile: "walking",
    });
    expect(schema.safeParse({ from: "a", to: "b", profile: "cycling" }).success).toBe(true);
  });

  it("rejects an unknown profile, an empty place, and an out-of-range coordinate", () => {
    expect(schema.safeParse({ from: "a", to: "b", profile: "flying" }).success).toBe(false);
    expect(schema.safeParse({ from: "", to: "b" }).success).toBe(false);
    expect(schema.safeParse({ from: [200, 0], to: "b" }).success).toBe(false);
  });

  it("summarizes its output for the model", async () => {
    const route = buildTools().route as Tool;
    const output = { id: "r", line: { type: "LineString", coordinates: [[0, 0], [1, 1]] }, distanceKm: 1 };
    const modelOutput = await route.toModelOutput?.({ toolCallId: "t", input: {}, output } as never);
    expect(modelOutput).toEqual({ type: "json", value: { id: "r", distanceKm: 1, pointCount: 2 } });
  });
});
