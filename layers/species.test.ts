import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Feature, Point } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { legendOf, labelsOf, timeShapeOf } from "./contract";
import layer, {
  INAT_GBIF_DATASET,
  autocompleteUrl,
  countryOf,
  groupBySpecies,
  inatDensityUrl,
  lookupName,
  normalizeObservations,
  observationsUrl,
  pickTaxon,
  taxonWords,
} from "./species";
import raw from "./__fixtures__/species.tahoe.json";
import elkAutocomplete from "./__fixtures__/species.elk-autocomplete.json";
import elkPage from "./__fixtures__/species.elk-estes.json";
import estesPlaces from "./__fixtures__/species.estes-places.json";
import troutAutocomplete from "./__fixtures__/species.trout-autocomplete.json";
import salmoninaeAutocomplete from "./__fixtures__/species.salmoninae-autocomplete.json";

const TAHOE: [number, number, number, number] = [-120.2, 38.85, -120, 39];
const ESTES: [number, number, number, number] = [-105.7, 40.3, -105.4, 40.45];
const DEFAULTS = { days: 365, researchGradeOnly: true } as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string, bbox = TAHOE) {
  return { bbox, zoom: 12, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

function params(url: unknown): URLSearchParams {
  return new URL(String(url)).searchParams;
}

const isObservations = (url: string) => url.includes("/observations?");

/** Routes iNaturalist's three endpoints: the country lookup, the taxon lookup and the observation pages (`pages`). */
function routed(pages: (url: string) => Response | Promise<Response>, lookups: { places?: unknown; taxa?: unknown } = {}) {
  return vi.fn(async (url: string) => {
    if (url.includes("/places/nearby")) return json(lookups.places ?? estesPlaces);
    if (url.includes("/taxa/autocomplete")) return json(lookups.taxa ?? elkAutocomplete);
    return pages(url);
  });
}

function pageCalls(stub: ReturnType<typeof vi.fn>): string[] {
  return (stub.mock.calls as unknown as [string][]).map((c) => c[0]).filter(isObservations);
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
      taxon: { id: 116999, name: "Pandion haliaetus", rank: "species", preferred_common_name: "Osprey", min_species_taxon_id: 116999 },
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
async function run(stub: ReturnType<typeof vi.fn>, input: Parameters<typeof layer.query>[1] = DEFAULTS, bbox = TAHOE) {
  const promise = layer.query(ctx(stub, "species:k", bbox), input);
  await vi.runAllTimersAsync();
  return promise;
}

describe("observationsUrl", () => {
  it("maps the bbox to nelat/nelng/swlat/swlng and asks the slim v2 endpoint for 200 geotagged research-grade rows", () => {
    const url = observationsUrl(TAHOE, { days: 365, researchGradeOnly: true }, 1, new Date("2026-10-09T12:00:00Z"));
    const p = params(url);
    expect(url.startsWith("https://api.inaturalist.org/v2/observations?")).toBe(true);
    expect(p.get("nelat")).toBe("39");
    expect(p.get("nelng")).toBe("-120");
    expect(p.get("swlat")).toBe("38.85");
    expect(p.get("swlng")).toBe("-120.2");
    expect(p.get("per_page")).toBe("200");
    expect(p.get("page")).toBe("1");
    expect(p.get("geo")).toBe("true");
    expect(p.get("quality_grade")).toBe("research");
    expect(p.get("locale")).toBe("en");
    expect(p.get("fields")).toContain("taxon.min_species_taxon_id");
    expect(p.has("taxon_name")).toBe(false);
    expect(p.has("taxon_id")).toBe(false);
  });

  it("sets d1 to today minus days", () => {
    const now = new Date("2026-10-09T12:00:00Z");
    const d1 = (days: number) => params(observationsUrl(TAHOE, { days, researchGradeOnly: true }, 1, now)).get("d1");
    expect(d1(1)).toBe("2026-10-08");
    expect(d1(30)).toBe("2026-09-09");
    expect(d1(365)).toBe("2025-10-09");
    expect(d1(3650)).toBe("2016-10-11");
  });

  it("filters by the resolved taxon id and country, falls back to taxon_name, and drops quality_grade when research grade is off", () => {
    const now = new Date("2026-10-09T12:00:00Z");
    const byId = params(observationsUrl(TAHOE, { days: 30, taxon: "elk", researchGradeOnly: true }, 2, now, { taxonId: 204114, placeId: 1 }));
    expect(byId.get("taxon_id")).toBe("204114");
    expect(byId.has("taxon_name")).toBe(false);
    expect(byId.get("preferred_place_id")).toBe("1");
    expect(byId.get("page")).toBe("2");
    const byName = params(observationsUrl(TAHOE, { days: 30, taxon: "Aves", researchGradeOnly: false }, 1, now));
    expect(byName.get("taxon_name")).toBe("Aves");
    expect(byName.has("quality_grade")).toBe(false);
  });
});

describe("taxon lookup", () => {
  it("asks autocomplete in English for the country", () => {
    const p = params(autocompleteUrl("elk", 1));
    expect(p.get("q")).toBe("elk");
    expect(p.get("locale")).toBe("en");
    expect(p.get("preferred_place_id")).toBe("1");
  });

  it("finds the country (admin level 0) among the places under a box", () => {
    expect(countryOf(estesPlaces)).toBe(1);
    expect(countryOf({ results: { standard: [] } })).toBeUndefined();
    expect(countryOf("nope")).toBeUndefined();
  });

  it("reads elk in the US as Cervus canadensis, not moose or elk thistle", () => {
    expect(pickTaxon("elk", elkAutocomplete)).toEqual({ id: 204114, name: "Cervus canadensis", rank: "species", commonName: "Elk" });
  });

  it("prefers an exact scientific name, then an exact common name, then an exact matched term, then the first result", () => {
    const results = [
      { id: 1, name: "Bryophyta", rank: "phylum", preferred_common_name: "Mosses", matched_term: "Moose" },
      { id: 2, name: "Alces alces", rank: "species", preferred_common_name: "Moose", matched_term: "Moose" },
      { id: 3, name: "Quercus", rank: "genus", preferred_common_name: "oaks", matched_term: "Oak" },
    ];
    expect(pickTaxon("moose", { results })?.id).toBe(2);
    expect(pickTaxon("alces alces", { results })?.id).toBe(2);
    expect(pickTaxon("oak", { results })?.id).toBe(3);
    expect(pickTaxon("something", { results })?.id).toBe(1);
    expect(pickTaxon("x", { results: [] })).toBeNull();
  });

  it("reads trout as the salmons and trouts (Salmoninae), not fawn lilies (recorded 2026-10-23)", () => {
    // Autocomplete alone ranks Erythronium ("trout lilies") first and has no trout in its top ten.
    expect(pickTaxon("trout", troutAutocomplete)?.name).toBe("Erythronium");
    expect(lookupName("trout")).toBe("Salmoninae");
    expect(lookupName(" Trout ")).toBe("Salmoninae");
    expect(lookupName("elk")).toBe("elk");
    expect(pickTaxon(lookupName("trout"), salmoninaeAutocomplete)).toEqual({ id: 342904, name: "Salmoninae", rank: "subfamily", commonName: "Salmons and Trouts" });
  });

  it("with no exact match prefers a name that ends in the asked word over one that only describes something else", () => {
    const results = [
      { id: 1, name: "Erythronium", rank: "genus", preferred_common_name: "fawn lilies", matched_term: "trout lilies" },
      { id: 2, name: "Salvelinus namaycush", rank: "species", preferred_common_name: "Lake Trout", matched_term: "Lake Trout" },
    ];
    expect(pickTaxon("trout", { results })?.id).toBe(2);
  });

  it("asks for those months of every year in the window", () => {
    const u = new URL(observationsUrl(TAHOE, { days: 3650, researchGradeOnly: true, month: "3-4" }, 1, new Date("2026-10-23T12:00:00Z")));
    expect(u.searchParams.get("month")).toBe("3,4");
    expect(new URL(observationsUrl(TAHOE, { days: 30, researchGradeOnly: true, season: "winter" }, 1, new Date("2026-10-23T12:00:00Z"))).searchParams.get("month")).toBe("12,1,2");
    expect(new URL(observationsUrl(TAHOE, { days: 30, researchGradeOnly: true }, 1, new Date("2026-10-23T12:00:00Z"))).searchParams.has("month")).toBe(false);
  });

  it("says in words what the name was read as", () => {
    expect(taxonWords({ id: 204114, name: "Cervus canadensis", rank: "species", commonName: "Elk" })).toBe("Elk (Cervus canadensis) and its subspecies");
    expect(taxonWords({ id: 3, name: "Aves", rank: "class", commonName: "Birds" })).toBe("Birds (Aves), the whole class");
  });
});

describe("normalizeObservations", () => {
  it("turns the Tahoe fixture into points with species, scientificName, observedOn, t, v, url, license and taxonId", () => {
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
      month: 6,
      season: "summer",
      taxonId: 116999,
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
    expect(normalizeObservations({ results: [{ id: 1, geojson: { type: "Point", coordinates: [-120, 39] } }] }).data.features).toHaveLength(0);
    expect(normalizeObservations(null).data.features).toHaveLength(0);
    expect(normalizeObservations({ results: "x" }).data.features).toHaveLength(0);
  });
});

describe("groupBySpecies", () => {
  it("names the subspecies American Elk by its species, so Elk is one chip (Estes Park fixture)", () => {
    const { data } = normalizeObservations(elkPage);
    expect(new Set(data.features.map((f) => f.properties?.species))).toEqual(new Set(["American Elk", "Elk"]));
    groupBySpecies(data.features);
    expect(new Set(data.features.map((f) => f.properties?.species))).toEqual(new Set(["Elk"]));
    expect(new Set(data.features.map((f) => f.properties?.taxonId))).toEqual(new Set([204114]));
    expect(new Set(data.features.map((f) => f.properties?.scientificName))).toEqual(new Set(["Cervus canadensis"]));
    const sub = data.features.filter((f) => f.properties?.identifiedAs !== undefined);
    expect(sub).toHaveLength(4);
    expect(sub[0].properties?.identifiedAs).toBe("American Elk (Cervus canadensis canadensis)");
  });

  it("names a subspecies by the asked taxon, else by its first two Latin words, when no sighting is at species rank", () => {
    const point = (props: Record<string, unknown>): Feature<Point> => ({ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: props });
    const a = [point({ species: "American Elk", scientificName: "Cervus canadensis canadensis", taxonId: 204114, identifiedAs: "American Elk (Cervus canadensis canadensis)" })];
    groupBySpecies(a, { id: 204114, name: "Cervus canadensis", rank: "species", commonName: "Elk" });
    expect(a[0].properties).toMatchObject({ species: "Elk", scientificName: "Cervus canadensis" });
    const b = [point({ species: "Gray-headed Junco", scientificName: "Junco hyemalis caniceps", taxonId: 9, identifiedAs: "Gray-headed Junco (Junco hyemalis caniceps)" })];
    groupBySpecies(b);
    expect(b[0].properties).toMatchObject({ species: "Junco hyemalis", scientificName: "Junco hyemalis" });
  });
});

describe("species layer", () => {
  it("declares global coverage, no key, a 50,000 km2 cap and the point style", () => {
    expect(layer.coverage).toBe("global");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(50_000);
    // A state such as Nebraska (242,000 km²) answers: ten pages or a tile template cost the same at any size.
    expect(layer.hardMaxAreaKm2).toBe(1_500_000);
    expect(layer.wide).toEqual({ orderBy: "date observed", rank: "most recent", limit: 2000 });
    expect(layer.style).toEqual({ geometry: "point", color: "#3A3A3C" });
    expect(layer.license).toBe("CC BY-NC / CC0 per observation (iNaturalist)");
  });

  it("declares continuous time, a one-dot legend with a plain note, and labels for the newest five", () => {
    const { data } = normalizeObservations(elkPage);
    const time = timeShapeOf(layer, data);
    expect(time.shape).toBe("continuous");
    // t is UTC: an evening sighting in Colorado on the 16th is the 17th in UTC.
    expect(time.span).toEqual({ start: "2026-10-13", end: "2026-10-17" });
    const legend = legendOf(layer, data);
    expect(legend.kind).toBe("symbol");
    expect(legend.items?.[0].label).toBe("One sighting");
    expect(legend.note).toMatch(/where people look and post/);
    expect(labelsOf(layer)).toEqual({ field: "species", max: 5 });
  });

  it("resolves elk to one taxon id, asks by it in the country's names, and says so (Estes Park)", async () => {
    const stub = routed(() => json(elkPage));
    const r = await run(stub, { ...DEFAULTS, taxon: "elk" }, ESTES);
    const calls = (stub.mock.calls as unknown as [string, RequestInit & { cacheKey?: string }][]).map(([url, init]) => ({ url, key: init.cacheKey }));
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1/places/nearby", "/v1/taxa/autocomplete", "/v2/observations"]);
    expect(calls[1].key).toBe("inat:taxon:1:elk");
    expect(params(calls[2].url).get("taxon_id")).toBe("204114");
    expect(params(calls[2].url).get("preferred_place_id")).toBe("1");
    expect(params(calls[2].url).has("taxon_name")).toBe(false);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(8);
    expect(new Set(r.data.features.map((f) => f.properties?.species))).toEqual(new Set(["Elk"]));
    expect(r.coverageNote).toBe('Elk was read as Elk (Cervus canadensis) and its subspecies');
  });

  it("looks trout up as Salmoninae and asks by its id, so no fawn lily is drawn (Denver, UC11)", async () => {
    const stub = routed(() => json({ total_results: 0, results: [] }), { taxa: salmoninaeAutocomplete });
    const r = await run(stub, { ...DEFAULTS, taxon: "trout", month: 3 }, ESTES);
    const urls = (stub.mock.calls as unknown as [string][]).map((c) => c[0]);
    expect(params(urls.find((u) => u.includes("/taxa/autocomplete"))!).get("q")).toBe("Salmoninae");
    const obs = urls.find((u) => u.includes("/v2/observations"))!;
    expect(params(obs).get("taxon_id")).toBe("342904");
    expect(params(obs).get("month")).toBe("3");
    if (!("kind" in r)) throw new Error("expected a result");
    expect(r.coverageNote).toContain('Trout was read as Salmons and Trouts (Salmoninae), the whole subfamily');
    expect(r.coverageNote).toContain("sightings from March only");
  });

  it("errors when iNaturalist knows no such name, and matches the name as text when the lookup fails", async () => {
    const none = await run(routed(() => json(elkPage), { taxa: { total_results: 0, results: [] } }), { ...DEFAULTS, taxon: "zzzq" });
    expect(none).toMatchObject({ error: expect.stringContaining('no species or group called "zzzq"') });

    const down = vi.fn(async (url: string) => (url.includes("/taxa/") ? new Response("down", { status: 503 }) : url.includes("/places/") ? json(estesPlaces) : json(elkPage)));
    const r = await run(down, { ...DEFAULTS, taxon: "elk" });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(params(pageCalls(down)[0]).get("taxon_name")).toBe("elk");
    expect(r.coverageNote).toContain("matched as text");
  });

  it("fetches one page with a timeout, cache key and the requested filters", async () => {
    const stub = routed(() => json(raw));
    const r = await run(stub, { days: 30, taxon: "Aves", researchGradeOnly: true });
    const pages = pageCalls(stub);
    expect(pages).toHaveLength(1);
    const init = (stub.mock.calls as unknown as [string, RequestInit & { cacheKey?: string }][]).find(([u]) => isObservations(u))![1];
    expect(params(pages[0]).get("d1")).toBe("2026-09-09");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.cacheKey).toBe("species:k:inat-p1");
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(48);
    expect(r.coverageNote).toContain("2 observations with hidden (obscured) locations were left out");
    expect(r.citation.source).toContain("iNaturalist");
  });

  it("has no note when there is no taxon, nothing was skipped and the area is fully covered", async () => {
    const stub = routed(() => json(page(1, 5, 5)));
    const r = await run(stub);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(5);
    expect(r.coverageNote).toBeUndefined();
  });

  it("starts page requests 600 ms apart and stops after 10 pages (2,000 sightings)", async () => {
    const stub = routed((url) => {
      const n = Number(params(url).get("page"));
      return json(page(n * 1000, 200, 5000, n));
    });
    const promise = layer.query(ctx(stub), DEFAULTS);
    await vi.advanceTimersByTimeAsync(0);
    expect(pageCalls(stub)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(599);
    expect(pageCalls(stub)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pageCalls(stub)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(600 * 8);
    expect(pageCalls(stub)).toHaveLength(10);
    await vi.advanceTimersByTimeAsync(5000);
    expect(pageCalls(stub)).toHaveLength(10);

    const r = await promise;
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(2000);
    expect(r.coverageNote).toBe("Showing the 2,000 most recent of 5,000 observations; zoom in or narrow the dates for the rest");
  });

  it("stops after a short page without asking for more", async () => {
    const stub = routed(() => json(page(1, 150, 150)));
    await run(stub);
    expect(pageCalls(stub)).toHaveLength(1);
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
    const stub = routed((url) => (params(url).get("page") === "1" ? json(page(1, 200, 450)) : new Response("nope", { status: 500 })));
    const r = await run(stub);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(200);
    expect(r.coverageNote).toContain("page 2 failed");
  });

  it("returns 422 zoom_in from runLayer only over the hard cap (1,500,000 km²)", async () => {
    const res = await runLayer("species", { bbox: [-125, 25, -95, 49] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ hint: "zoom_in", error: expect.stringMatching(/zoom in to under 1500000 km²$/) });
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
    const stub = routed(
      (url) => {
        const n = Number(params(url).get("page"));
        return json(page(n * 1000, 200, 26626, n));
      },
      { taxa: { results: [{ id: 3, name: "Aves", rank: "class", preferred_common_name: "Birds", matched_term: "Birds" }] } },
    );
    const promise = layer.query({ ...ctx(stub, "species:w"), bbox: [-123, 37, -120, 40], wide: true, wideStrategy: layer.wide }, { ...DEFAULTS, taxon: "birds" });
    await vi.advanceTimersByTimeAsync(0);
    expect(pageCalls(stub)).toHaveLength(1);
    // The other nine start on the 600 ms beat without waiting for each answer.
    await vi.advanceTimersByTimeAsync(600 * 9);
    expect(pageCalls(stub)).toHaveLength(10);
    const r = await promise;
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const urls = pageCalls(stub).map((u) => new URL(u));
    expect(urls[0].origin + urls[0].pathname).toBe("https://api.inaturalist.org/v2/observations");
    expect(urls[0].searchParams.get("fields")).toContain("taxon.preferred_common_name");
    expect(urls[0].searchParams.get("order_by")).toBe("observed_on");
    expect(urls[0].searchParams.get("taxon_id")).toBe("3");
    expect(urls.map((u) => u.searchParams.get("page"))).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(r.data.features).toHaveLength(2000);
    expect(r.total).toBe(26626);
    expect(r.coverageNote).toBe('Birds was read as Birds (Aves), the whole class');
  });

  it("in wide mode quotes no total when every page was fetched", async () => {
    const stub = routed(() => json(page(1, 150, 150)));
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
