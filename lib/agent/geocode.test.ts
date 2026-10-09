import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geocode } from "@/lib/agent/geocode";

const realFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("geocode", () => {
  beforeEach(() => {
    vi.stubEnv("MAPBOX_TOKEN", "test-mapbox-token");
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", "");
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
  });

  it("returns the first feature's bbox, center and name", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) =>
      jsonResponse({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {
              name: "Lake Tahoe",
              full_address: "Lake Tahoe, California, United States",
              bbox: [-120.2, 38.9, -119.9, 39.3],
              coordinates: { longitude: -120.04, latitude: 39.09 },
            },
          },
        ],
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await geocode("Lake Tahoe");

    expect(result).toEqual({
      bbox: [-120.2, 38.9, -119.9, 39.3],
      center: [-120.04, 39.09],
      name: "Lake Tahoe, California, United States",
    });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://api.mapbox.com/search/geocode/v6/forward");
    expect(url.searchParams.get("q")).toBe("Lake Tahoe");
    expect(url.searchParams.get("limit")).toBe("1");
    expect(url.searchParams.get("access_token")).toBe("test-mapbox-token");
  });

  it("builds a bbox around the center when the feature has none", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        features: [
          {
            properties: {
              name: "Truckee",
              coordinates: { longitude: -120.18, latitude: 39.33 },
            },
          },
        ],
      }),
    ) as typeof fetch;

    const result = await geocode("Truckee");

    expect(result).toMatchObject({ center: [-120.18, 39.33], name: "Truckee" });
    if ("error" in result) throw new Error("expected a match");
    const [w, s, e, n] = result.bbox;
    expect(w).toBeCloseTo(-120.28);
    expect(s).toBeCloseTo(39.23);
    expect(e).toBeCloseTo(-120.08);
    expect(n).toBeCloseTo(39.43);
  });

  it("returns an error when there are no features", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ features: [] })) as typeof fetch;
    expect(await geocode("Nowhere")).toEqual({ error: "No match for Nowhere" });
  });

  it("returns an error without calling Mapbox when no token is set", async () => {
    vi.stubEnv("MAPBOX_TOKEN", "");
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    expect(await geocode("Lake Tahoe")).toEqual({ error: "MAPBOX_TOKEN is not set" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to NEXT_PUBLIC_MAPBOX_TOKEN", async () => {
    vi.stubEnv("MAPBOX_TOKEN", "");
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", "public-token");
    const fetchMock = vi.fn(async (_url: string | URL | Request) => jsonResponse({ features: [] }));
    globalThis.fetch = fetchMock as typeof fetch;
    await geocode("Lake Tahoe");
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("access_token")).toBe("public-token");
  });

  it("returns an error instead of throwing when the request fails", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const result = await geocode("Lake Tahoe");
    expect(result).toHaveProperty("error");
  });
});
