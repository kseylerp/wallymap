/**
 * Fixture: layers/__fixtures__/ne-regions.sample.json holds 10 real features copied unmodified (geometry and
 * the identifying properties) from ne_10m_geography_regions_polys.geojson in nvkelso/natural-earth-vector,
 * fetched 2026-10-09. The real file spells its property keys in UPPER CASE (NAME, NAME_EN, NAMEALT, FEATURECLA).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Feature, FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import sample from "@/layers/__fixtures__/ne-regions.sample.json";
import {
  NATURAL_EARTH_REGIONS_URL,
  featureBBoxes,
  findRegion,
  loadNaturalEarthRegions,
  regionDisplayName,
  resetNaturalEarthCache,
} from "./naturalEarth";

const fc = sample as unknown as FeatureCollection;

function fetchReturning(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as ReturnType<typeof vi.fn> &
    CachedFetch;
}

const square = (props: Record<string, unknown>): Feature => ({
  type: "Feature",
  properties: props,
  geometry: { type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 1], [0, 0]]] },
});

describe("findRegion", () => {
  it("matches 'the Andes' by stripping a leading 'the ' and ignoring case", () => {
    for (const q of ["the Andes", "The Andes", "andes", "ANDES", "  the   andes "]) {
      expect(findRegion(q, fc)?.properties?.NAME_EN).toBe("Andes");
    }
  });

  it("prefers a match on the primary name over an English-name match (Sierra Nevada, California, not Spain)", () => {
    const hit = findRegion("Sierra Nevada", fc);
    expect(hit?.properties?.NAME).toBe("SIERRA NEVADA");
    expect(hit?.properties?.REGION).toBe("North America");
    // The Spanish range is catalogued as "S. Nevada" and reachable by that name.
    expect(findRegion("S. Nevada", fc)?.properties?.REGION).toBe("Europe");
  });

  it("returns undefined for a place that is not a region", () => {
    expect(findRegion("Truckee", fc)).toBeUndefined();
    expect(findRegion("the ", fc)).toBeUndefined();
    expect(findRegion("", fc)).toBeUndefined();
  });

  it("also matches name_en and name_alt, and lower-case property keys", () => {
    const synthetic: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        square({ name: "Lowercase Keys", name_en: "Plain English", name_alt: "Old Name", featurecla: "Plain" }),
      ],
    };
    expect(findRegion("plain english", synthetic)?.properties?.name).toBe("Lowercase Keys");
    expect(findRegion("the old name", synthetic)?.properties?.name).toBe("Lowercase Keys");
    expect(findRegion("lowercase keys", synthetic)).toBeDefined();
  });

  it("breaks ties inside one name tier by the more important (lower scalerank) feature", () => {
    const synthetic: FeatureCollection = {
      type: "FeatureCollection",
      features: [square({ NAME: "Twin", SCALERANK: 4, id: "minor" }), square({ NAME: "Twin", SCALERANK: 1, id: "major" })],
    };
    expect(findRegion("twin", synthetic)?.properties?.id).toBe("major");
  });
});

describe("regionDisplayName", () => {
  it("prefers the English name over the shouting upper-case primary name", () => {
    expect(regionDisplayName(findRegion("andes", fc) as Feature)).toBe("Andes");
    expect(regionDisplayName(findRegion("sahara", fc) as Feature)).toBe("Sahara");
  });
  it("title-cases an upper-case name when there is no English name", () => {
    expect(regionDisplayName(square({ NAME: "GREAT SALT PLAIN" }))).toBe("Great Salt Plain");
  });
});

describe("featureBBoxes", () => {
  it("computes one bbox per feature, once per collection", () => {
    const boxes = featureBBoxes(fc);
    expect(boxes).toHaveLength(fc.features.length);
    expect(featureBBoxes(fc)).toBe(boxes);
    const i = fc.features.findIndex((f) => f.properties?.NAME === "SIERRA NEVADA");
    const [w, s, e, n] = boxes[i];
    expect(w).toBeLessThan(-118);
    expect(e).toBeGreaterThan(-120);
    expect(s).toBeGreaterThan(34);
    expect(n).toBeLessThan(41);
  });
});

describe("loadNaturalEarthRegions", () => {
  beforeEach(() => {
    resetNaturalEarthCache();
  });

  it("fetches the verified URL once with the shared cache key and a 24 hour lifetime", async () => {
    const stub = fetchReturning(fc);
    const [a, b] = await Promise.all([loadNaturalEarthRegions(stub), loadNaturalEarthRegions(stub)]);
    const c = await loadNaturalEarthRegions(stub);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(a).toBe(c);
    const [url, init] = stub.mock.calls[0] as unknown as [string, { cacheKey?: string; ttlSeconds?: number }];
    expect(url).toBe(NATURAL_EARTH_REGIONS_URL);
    expect(url).toBe(
      "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_geography_regions_polys.geojson",
    );
    expect(init.cacheKey).toBe("ne:regions");
    expect(init.ttlSeconds).toBe(86400);
    expect(a.features).toHaveLength(10);
  });

  it("rejects on a non-2xx response and tries again on the next call", async () => {
    const bad = vi.fn(async () => new Response("nope", { status: 503 })) as unknown as CachedFetch;
    await expect(loadNaturalEarthRegions(bad)).rejects.toThrow(/503/);
    const good = fetchReturning(fc);
    await expect(loadNaturalEarthRegions(good)).resolves.toHaveProperty("features");
  });

  it("rejects on a body that is not a FeatureCollection", async () => {
    await expect(loadNaturalEarthRegions(fetchReturning({ hello: "world" }))).rejects.toThrow(/FeatureCollection/);
  });
});
