import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, {
  attachWaterTemps,
  buildFishingQuery,
  inatUrl,
  osmFeatures,
  sightingFeatures,
  usfsFeatures,
} from "./fishing";
import { parseIv } from "./_shared/usgs";
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

  it("attaches the nearest water temperature within 30 km to places, not sightings", () => {
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

describe("fishing layer", () => {
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
  });

  it("rejects an oversized bbox and bad input through runLayer", async () => {
    expect((await runLayer("fishing", { bbox: [-125, 35, -118, 42] })).status).toBe(422);
    expect((await runLayer("fishing", { bbox: TAHOE, input: { days: 0 } })).status).toBe(400);
  });
});
