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

  it("adds Mapbox's proximity parameter only when given", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) =>
      jsonResponse({
        features: [
          {
            properties: {
              name: "Emerald Bay",
              bbox: [-120.2, 38.9, -119.9, 39.3],
              coordinates: { longitude: -120.1, latitude: 38.95 },
            },
          },
        ],
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await geocode("Emerald Bay", { proximity: [-120.14, 39.17] });
    await geocode("Emerald Bay");

    const withProximity = new URL(String(fetchMock.mock.calls[0][0]));
    expect(withProximity.searchParams.get("proximity")).toBe("-120.14,39.17");
    expect(withProximity.toString()).toContain("proximity=-120.14%2C39.17");
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.has("proximity")).toBe(false);
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

  it("never echoes the Mapbox token in an error", async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      throw new TypeError(`fetch failed for ${String(url)}`);
    }) as typeof fetch;
    const result = await geocode("Lake Tahoe");
    expect(result).toHaveProperty("error");
    expect(JSON.stringify(result)).not.toContain("test-mapbox-token");
    expect(JSON.stringify(result)).toContain("[token]");
  });

  it("gives the Mapbox call a timeout", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse({ type: "FeatureCollection", features: [] }));
    globalThis.fetch = fetchMock as typeof fetch;
    await geocode("Lake Tahoe");
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
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

    it("remembers a failed regions download for 60 seconds, then tries again", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
        const calls = routed(ANDES_TOWN, { ne: "fail" });
        await geocode("Andes");
        await geocode("Andes");
        expect(calls.ne).toBe(1);

        vi.setSystemTime(new Date("2026-10-09T12:00:59Z"));
        await geocode("Andes");
        expect(calls.ne).toBe(1);

        vi.setSystemTime(new Date("2026-10-09T12:01:01Z"));
        const recovered = routed(ANDES_TOWN);
        await expect(geocode("Andes")).resolves.toMatchObject({ source: "natural-earth" });
        expect(recovered.ne).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("downloads the regions only once across several lookups", async () => {
      const calls = routed(ANDES_TOWN);
      await geocode("Andes");
      await geocode("the Andes");
      expect(calls.ne).toBe(1);
    });
  });

  describe("range-like names", () => {
    // Live 2026-10-11: v6 answered "Wind River Range" with a street in Jacksonville, Florida, and "Wind River Range,
    // Wyoming" with the town of Wind River; Search Box knows the range as a POI on Gannett Peak.
    const WIND_RIVER_TOWN = { name: "Wind River", full_address: "Wind River, Wyoming, United States", bbox: [-108.891, 42.981, -108.877, 42.991], coordinates: { longitude: -108.88, latitude: 42.98 } };
    const poi = (name: string, poi_category: string[], longitude: number, latitude: number, place_formatted: string) => ({
      properties: { name, feature_type: "poi", poi_category, place_formatted, coordinates: { longitude, latitude } },
    });

    function routed(v6: unknown[], searchBox: unknown[]) {
      const urls: URL[] = [];
      globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        urls.push(url);
        if (url.host === NE_HOST) return jsonResponse(regions);
        if (url.pathname.includes("searchbox")) return jsonResponse({ features: searchBox });
        return jsonResponse({ features: v6.map((properties) => ({ properties })) });
      }) as typeof fetch;
      return urls;
    }

    it("treats ranges, mountains and sierras as range-like, but not towns or lakes", async () => {
      const { isRangeLike } = await import("@/lib/agent/geocode");
      expect(["Wind River Range", "Bighorn Mountains", "Sierra Nevada", "the Alps"].every(isRangeLike)).toBe(true);
      expect(["Lake Tahoe", "Truckee", "Andes", "Mountain View"].some(isRangeLike)).toBe(false);
    });

    it("keeps a town whose name is exactly the range-like text (Beverly Hills)", async () => {
      const urls = routed([{ name: "Beverly Hills", bbox: [-118.43, 34.05, -118.38, 34.1], coordinates: { longitude: -118.4, latitude: 34.07 } }], []);
      expect(await geocode("Beverly Hills")).toMatchObject({ name: "Beverly Hills", source: "mapbox" });
      expect(urls.some((u) => u.pathname.includes("searchbox"))).toBe(false);
    });

    it("answers the Wind River Range with the range's own point, boxed under the glacier cap, not the town", async () => {
      const urls = routed(
        [WIND_RIVER_TOWN],
        [
          poi("Wind River Range", ["government"], -109.85, 42.87, "Pinedale, Wyoming 82941, United States"),
          poi("Wind River Range", [], -109.6526, 43.1835, "Dubois, Wyoming 82513, United States"),
        ],
      );
      const result = await geocode("Wind River Range, Wyoming", { proximity: [-110, 43] });
      if ("error" in result) throw new Error("expected a match");
      expect(result.center).toEqual([-109.6526, 43.1835]);
      expect(result.name).toBe("Wind River Range, Dubois, Wyoming 82513, United States");
      const { bboxAreaKm2 } = await import("@/layers/types");
      expect(bboxAreaKm2(result.bbox)).toBeGreaterThan(5_000);
      expect(bboxAreaKm2(result.bbox)).toBeLessThan(8_000);
      const v6 = urls.find((u) => u.pathname.includes("geocode/v6"));
      expect(v6?.searchParams.get("types")).toBe("region,district,place,locality");
      const searchBox = urls.find((u) => u.pathname.includes("searchbox"));
      expect(searchBox?.searchParams.get("types")).toBe("poi");
      expect(searchBox?.searchParams.get("proximity")).toBe("-110,43");
    });

    it("needs the exact name: Bighorn Mountain is not the Bighorn Mountains, so the town stays", async () => {
      routed([WIND_RIVER_TOWN], [poi("Bighorn Mountain", ["mountain"], -105.6, 40.4, "Estes Park, Colorado")]);
      expect(await geocode("Bighorn Mountains")).toMatchObject({ name: "Wind River, Wyoming, United States", source: "mapbox" });
    });

    it("finds the landform when the place geocoder has no match at all", async () => {
      routed([], [poi("Ruby Mountains", [], -115.475, 40.622, "Spring Creek, Nevada")]);
      expect(await geocode("Ruby Mountains")).toMatchObject({ center: [-115.475, 40.622], source: "mapbox" });
    });

    it("never asks Search Box for a name that is not range-like", async () => {
      const urls = routed([{ name: "Truckee", coordinates: { longitude: -120.18, latitude: 39.33 } }], []);
      await geocode("Truckee");
      expect(urls.some((u) => u.pathname.includes("searchbox"))).toBe(false);
      expect(urls[0].searchParams.has("types")).toBe(false);
    });
  });
});
