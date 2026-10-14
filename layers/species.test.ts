import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { INAT_GBIF_DATASET, inatDensityUrl, normalizeObservations, observationsUrl } from "./species";
import raw from "./__fixtures__/species.tahoe.json";

const TAHOE: [number, number, number, number] = [-120.2, 38.85, -120, 39];
const DEFAULTS = { days: 365, researchGradeOnly: true } as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string) {
  return { bbox: TAHOE, zoom: 12, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

function params(url: unknown): URLSearchParams {
  return new URL(String(url)).searchParams;
}

/** A page of `count` minimal observations with ids starting at `start`. */
function page(start: number, count: number, total: number, pageNo = 1) {
  return {
    total_results: total,
    page: pageNo,
    per_page: 200,
    results: Array.from({ length: count }, (_, i) => ({
      id: start + i,
      uri: `https://www.inaturalist.org/observations/${start + i}`,
      observed_on: "2026-06-16",
      time_observed_at: "2026-06-16T13:12:09-07:00",
      license_code: "cc0",
      obscured: false,
      geojson: { type: "Point", coordinates: [-120.1, 38.9] },
      taxon: { name: "Pandion haliaetus", preferred_common_name: "Osprey" },
    })),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
  vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

/** Runs a query to completion, advancing the fake clock through the spacing between pages. */
async function run(stub: ReturnType<typeof vi.fn>, input: Parameters<typeof layer.query>[1] = DEFAULTS) {
  const promise = layer.query(ctx(stub, "species:k"), input);
  await vi.runAllTimersAsync();
  return promise;
}

describe("observationsUrl", () => {
  it("maps the bbox to nelat/nelng/swlat/swlng and asks for 200 geotagged research-grade rows", () => {
    const p = params(observationsUrl(TAHOE, { days: 365, researchGradeOnly: true }, 1, new Date("2026-10-09T12:00:00Z")));
    expect(p.get("nelat")).toBe("39");
    expect(p.get("nelng")).toBe("-120");
    expect(p.get("swlat")).toBe("38.85");
    expect(p.get("swlng")).toBe("-120.2");
    expect(p.get("per_page")).toBe("200");
    expect(p.get("page")).toBe("1");
    expect(p.get("geo")).toBe("true");
    expect(p.get("quality_grade")).toBe("research");
    expect(p.has("taxon_name")).toBe(false);
  });

  it("sets d1 to today minus days", () => {
    const now = new Date("2026-10-09T12:00:00Z");
    const d1 = (days: number) =>
      params(observationsUrl(TAHOE, { days, researchGradeOnly: true }, 1, now)).get("d1");
    expect(d1(1)).toBe("2026-10-08");
    expect(d1(30)).toBe("2026-09-09");
    expect(d1(365)).toBe("2025-10-09");
    expect(d1(3650)).toBe("2016-10-11");
  });

  it("adds taxon_name only when a taxon is given, and drops quality_grade when research grade is off", () => {
    const now = new Date("2026-10-09T12:00:00Z");
    const url = observationsUrl(TAHOE, { days: 30, taxon: "Aves", researchGradeOnly: false }, 2, now);
    expect(params(url).get("taxon_name")).toBe("Aves");
    expect(params(url).get("page")).toBe("2");
    expect(params(url).has("quality_grade")).toBe(false);
    expect(url.startsWith("https://api.inaturalist.org/v1/observations?")).toBe(true);
  });
});

describe("normalizeObservations", () => {
  it("turns the Tahoe fixture into points with species, scientificName, observedOn, t, v, url and license", () => {
    const { data, skipped } = normalizeObservations(raw);
    expect(skipped).toBe(2);
    expect(data.features).toHaveLength(48);
    const first = data.features[0];
    expect(first.geometry).toEqual({ type: "Point", coordinates: [-120.1061083333, 38.951175] });
    expect(first.properties).toEqual({
      species: "Osprey",
      scientificName: "Pandion haliaetus",
      observedOn: "2026-06-16",
      t: "2026-06-16T20:12:09.000Z",
      v: 1,
      url: "https://www.inaturalist.org/observations/407038132",
      license: "cc-by-nc",
    });
    for (const f of data.features) {
      expect(f.properties?.v).toBe(1);
      expect(new Date(f.properties?.t).toISOString()).toBe(f.properties?.t);
    }
  });

  it("reports observations without a license as all rights reserved", () => {
    const { data } = normalizeObservations(raw);
    const licenses = new Set(data.features.map((f) => f.properties?.license));
    expect(licenses.has("all-rights-reserved")).toBe(true);
    expect(licenses.has(null)).toBe(false);
  });

  it("skips obscured observations and ones without a geojson point, and counts them", () => {
    const { data, skipped } = normalizeObservations({
      results: [
        { id: 1, obscured: true, geojson: { type: "Point", coordinates: [-120, 39] }, observed_on: "2026-06-01", taxon: { name: "A b" } },
        { id: 2, obscured: false, observed_on: "2026-06-01", taxon: { name: "A b" } },
        { id: 3, obscured: false, geojson: null, observed_on: "2026-06-01", taxon: { name: "A b" } },
        { id: 4, obscured: false, geojson: { type: "Point", coordinates: [-120, 39] }, observed_on: "2026-06-01", taxon: { name: "A b" } },
      ],
    });
    expect(skipped).toBe(3);
    expect(data.features).toHaveLength(1);
    expect(data.features[0].properties?.url).toBe("https://www.inaturalist.org/observations/4");
  });

  it("falls back from common name to scientific name to the species guess, and uses the date when there is no time", () => {
    const { data } = normalizeObservations({
      results: [
        { id: 1, geojson: { type: "Point", coordinates: [-120, 39] }, observed_on: "2026-06-01", taxon: { name: "Ursus americanus" } },
        { id: 2, geojson: { type: "Point", coordinates: [-120, 39] }, observed_on: "2026-06-02", species_guess: "Something small" },
      ],
    });
    expect(data.features[0].properties).toMatchObject({
      species: "Ursus americanus",
      scientificName: "Ursus americanus",
      t: "2026-06-01T00:00:00.000Z",
    });
    expect(data.features[1].properties).toMatchObject({ species: "Something small", observedOn: "2026-06-02" });
    expect(data.features[1].properties).not.toHaveProperty("scientificName");
  });

  it("drops rows with no usable date and tolerates a malformed body", () => {
    expect(
      normalizeObservations({ results: [{ id: 1, geojson: { type: "Point", coordinates: [-120, 39] } }] }).data.features,
    ).toHaveLength(0);
    expect(normalizeObservations(null).data.features).toHaveLength(0);
    expect(normalizeObservations({ results: "x" }).data.features).toHaveLength(0);
  });
});

describe("species layer", () => {
  it("declares global coverage, no key, a 50,000 km2 cap and the point style", () => {
    expect(layer.coverage).toBe("global");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(50_000);
    expect(layer.hardMaxAreaKm2).toBeUndefined();
    expect(layer.wide).toEqual({ orderBy: "date observed", rank: "most recent", limit: 2000 });
    expect(layer.style).toEqual({ geometry: "point", color: "#3A3A3C" });
    expect(layer.license).toBe("CC BY-NC / CC0 per observation (iNaturalist)");
  });

  it("fetches one page with a timeout, cache key and the requested filters", async () => {
    const stub = vi.fn(async () => json(raw));
    const r = await run(stub, { days: 30, taxon: "Aves", researchGradeOnly: true });
    expect(stub).toHaveBeenCalledTimes(1);
    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit & { cacheKey?: string }];
    expect(params(url).get("taxon_name")).toBe("Aves");
    expect(params(url).get("d1")).toBe("2026-09-09");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.cacheKey).toBe("species:k:inat-p1");
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(48);
    expect(r.coverageNote).toBe("2 observations with hidden (obscured) locations were left out");
    expect(r.citation.source).toContain("iNaturalist");
  });

  it("has no note when nothing was skipped and the area is fully covered", async () => {
    const stub = vi.fn(async () => json(page(1, 5, 5)));
    const r = await run(stub);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(5);
    expect(r.coverageNote).toBeUndefined();
  });

  it("spaces page requests 600 ms apart and stops after 3 pages", async () => {
    const stub = vi.fn(async (url: string) => {
      const n = Number(params(url).get("page"));
      return json(page(n * 1000, 200, 5000, n));
    });
    const promise = layer.query(ctx(stub), DEFAULTS);
    await vi.advanceTimersByTimeAsync(0);
    expect(stub).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(599);
    expect(stub).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(stub).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(600);
    expect(stub).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(stub).toHaveBeenCalledTimes(3);

    const r = await promise;
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(600);
    expect(r.coverageNote).toBe("Showing the 600 most recent of 5,000 observations; zoom in or narrow the dates for the rest");
  });

  it("stops after a short page without waiting for more", async () => {
    const stub = vi.fn(async () => json(page(1, 150, 150)));
    await run(stub);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("maps a first-page non-2xx response to an upstream error", async () => {
    const stub = vi.fn(async () => new Response("slow down", { status: 429 }));
    const r = await run(stub);
    expect(r).toEqual({ error: "iNaturalist returned 429", hint: "upstream" });
  });

  it("maps a thrown timeout to an upstream error", async () => {
    const stub = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const r = await run(stub);
    expect(r).toMatchObject({ hint: "upstream" });
    expect((r as { error: string }).error).toContain("timed out");
  });

  it("maps a body that is not an observation list to an upstream error", async () => {
    const stub = vi.fn(async () => json({ error: "bad" }));
    const r = await run(stub);
    expect(r).toEqual({ error: "iNaturalist returned an unexpected response", hint: "upstream" });
  });

  it("keeps the first page and says so when a later page fails", async () => {
    const stub = vi.fn(async (url: string) =>
      params(url).get("page") === "1" ? json(page(1, 200, 450)) : new Response("nope", { status: 500 }),
    );
    const r = await run(stub);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(200);
    expect(r.coverageNote).toContain("page 2 failed");
  });

  it("returns 422 zoom_in from runLayer only over the hard cap (4 x 50,000 km²)", async () => {
    const res = await runLayer("species", { bbox: [-124, 35, -118, 42] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ hint: "zoom_in", error: expect.stringMatching(/zoom in to under 200000 km²$/) });
  });

  it("answers a wide box with no taxon as GBIF density tiles of iNaturalist research-grade observations, without calling upstream", async () => {
    const stub = vi.fn();
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("species", { bbox: [-122, 37, -119, 41] });
      expect(stub).not.toHaveBeenCalled();
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        kind: "tiles",
        data: { url: inatDensityUrl(365, new Date()), format: "raster", tileSize: 256 },
        truncated: true,
        coverageNote: expect.stringContaining("density map"),
      });
      expect(inatDensityUrl(365, new Date())).toContain(`datasetKey=${INAT_GBIF_DATASET}&year=2025,2026`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("answers a wide box with a taxon with the 2,000 most recent from slim v2 pages started 600 ms apart, and total_results", async () => {
    const stub = vi.fn(async (url: string) => {
      const n = Number(params(url).get("page"));
      return json(page(n * 1000, 200, 26626, n));
    });
    const promise = layer.query(
      { ...ctx(stub, "species:w"), bbox: [-123, 37, -120, 40], wide: true, wideStrategy: layer.wide },
      { ...DEFAULTS, taxon: "birds" },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(stub).toHaveBeenCalledTimes(1);
    // The other nine start on the 600 ms beat without waiting for each answer.
    await vi.advanceTimersByTimeAsync(600 * 9);
    expect(stub).toHaveBeenCalledTimes(10);
    const r = await promise;
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const urls = (stub.mock.calls as unknown as [string][]).map((c) => new URL(c[0]));
    expect(urls[0].origin + urls[0].pathname).toBe("https://api.inaturalist.org/v2/observations");
    expect(urls[0].searchParams.get("fields")).toContain("taxon.preferred_common_name");
    expect(urls[0].searchParams.get("order_by")).toBe("observed_on");
    expect(urls.map((u) => u.searchParams.get("page"))).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(r.data.features).toHaveLength(2000);
    expect(r.total).toBe(26626);
    expect(r.coverageNote).toBeUndefined();
  });

  it("in wide mode quotes no total when every page was fetched", async () => {
    const stub = vi.fn(async () => json(page(1, 150, 150)));
    const r = await layer.query({ ...ctx(stub), wide: true, wideStrategy: layer.wide }, { ...DEFAULTS, taxon: "mule deer" });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(150);
    expect(r.total).toBeUndefined();
  });

  it("rejects out-of-range days through runLayer", async () => {
    expect((await runLayer("species", { bbox: TAHOE, input: { days: 0 } })).status).toBe(400);
    expect((await runLayer("species", { bbox: TAHOE, input: { days: 4000 } })).status).toBe(400);
  });
});

describe("input", () => {
  it("caps taxon at 120 characters", async () => {
    const { default: layer } = await import("./species");
    expect(layer.input.safeParse({ taxon: "a".repeat(120) }).success).toBe(true);
    expect(layer.input.safeParse({ taxon: "a".repeat(121) }).success).toBe(false);
  });
});
