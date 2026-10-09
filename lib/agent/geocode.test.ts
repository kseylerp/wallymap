import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import sample from "@/layers/__fixtures__/ne-regions.sample.json";

const realFetch = globalThis.fetch;
const regions = sample as unknown as FeatureCollection;
const NE_HOST = "raw.githubusercontent.com";

// geocode and the Natural Earth loader keep module-level caches, so every test gets fresh modules.
let geocode: typeof import("@/lib/agent/geocode").geocode;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("geocode", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ geocode } = await import("@/lib/agent/geocode"));
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
      source: "mapbox",
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

    expect(result).toMatchObject({ center: [-120.18, 39.33], name: "Truckee", source: "mapbox" });
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

  describe("Natural Earth fallback", () => {
    type Calls = { mapbox: number; ne: number };

    /** Answers Mapbox with one feature and the Natural Earth download with the sample regions (or a failure). */
    function routed(
      mapboxProps: Record<string, unknown>,
      opts: { ne?: "ok" | "fail" | "junk" } = {},
    ): Calls {
      const calls: Calls = { mapbox: 0, ne: 0 };
      globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes(NE_HOST)) {
          calls.ne += 1;
          if (opts.ne === "fail") throw new Error("github down");
          if (opts.ne === "junk") return jsonResponse({ hello: "world" });
          return jsonResponse(regions);
        }
        calls.mapbox += 1;
        return jsonResponse({ features: [{ type: "Feature", properties: mapboxProps }] });
      }) as typeof fetch;
      return calls;
    }

    const ANDES_TOWN = { name: "Andes", coordinates: { longitude: -75.88, latitude: 5.66 } };

    it("uses the region bbox and name when Mapbox gives no bbox and the place is a region", async () => {
      const calls = routed(ANDES_TOWN);
      const result = await geocode("the Andes");
      if ("error" in result) throw new Error("expected a match");
      expect(result.source).toBe("natural-earth");
      expect(result.name).toBe("Andes");
      const [w, s, e, n] = result.bbox;
      expect(w).toBeLessThan(-75);
      expect(e).toBeGreaterThan(-70);
      expect(s).toBeLessThan(-40);
      expect(n).toBeGreaterThan(5);
      expect(result.center[0]).toBeCloseTo((w + e) / 2);
      expect(result.center[1]).toBeCloseTo((s + n) / 2);
      expect(calls).toEqual({ mapbox: 1, ne: 1 });
    });

    it("uses the region when Mapbox's bbox is under 0.5 degrees in both axes", async () => {
      routed({ ...ANDES_TOWN, bbox: [-75.95, 5.6, -75.8, 5.7] });
      const result = await geocode("Andes");
      expect(result).toMatchObject({ source: "natural-earth", name: "Andes" });
    });

    it("matches the California Sierra Nevada, not the Spanish range of the same English name", async () => {
      routed({ name: "Sierra Nevada", coordinates: { longitude: -118.5, latitude: 37 }, bbox: [-118.6, 36.9, -118.4, 37.1] });
      const result = await geocode("Sierra Nevada");
      if ("error" in result) throw new Error("expected a match");
      expect(result.source).toBe("natural-earth");
      expect(result.bbox[0]).toBeLessThan(-118);
      expect(result.bbox[2]).toBeGreaterThan(-122);
    });

    it("keeps the Mapbox result when the bbox is small in only one axis", async () => {
      const calls = routed({ ...ANDES_TOWN, bbox: [-76, 5, -75.9, 7] });
      const result = await geocode("Andes");
      expect(result).toMatchObject({ source: "mapbox", bbox: [-76, 5, -75.9, 7] });
      expect(calls.ne).toBe(0);
    });

    it("keeps the Mapbox result when the bbox is large, without downloading regions", async () => {
      const calls = routed({ name: "Sierra Nevada", coordinates: { longitude: -119, latitude: 37 }, bbox: [-122, 35, -117, 40] });
      const result = await geocode("Sierra Nevada");
      expect(result).toMatchObject({ source: "mapbox", bbox: [-122, 35, -117, 40] });
      expect(calls.ne).toBe(0);
    });

    it("keeps the Mapbox result when the bbox is small but the place is not a region", async () => {
      const calls = routed({ name: "Truckee", coordinates: { longitude: -120.18, latitude: 39.33 } });
      const result = await geocode("Truckee");
      expect(result).toMatchObject({ source: "mapbox", name: "Truckee" });
      expect(calls.ne).toBe(1);
    });

    it("keeps the Mapbox result when the regions download fails or is not GeoJSON", async () => {
      for (const ne of ["fail", "junk"] as const) {
        vi.resetModules();
        ({ geocode } = await import("@/lib/agent/geocode"));
        routed(ANDES_TOWN, { ne });
        const result = await geocode("Andes");
        expect(result).toMatchObject({ source: "mapbox", name: "Andes" });
      }
    });

    it("downloads the regions only once across several lookups", async () => {
      const calls = routed(ANDES_TOWN);
      await geocode("Andes");
      await geocode("the Andes");
      expect(calls.ne).toBe(1);
    });
  });
});
