import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import layer, {
  MAX_NAME_LOOKUPS,
  bboxPolygon,
  densityTileUrl,
  monthsOf,
  monthsText,
  normalizeOccurrences,
  searchUrl,
  shortLicense,
  speciesToName,
  withCommonNames,
  yearRange,
} from "./gbif-occurrences";
import { cardContent } from "@/lib/render/card";
import { summarizeFeature } from "@/lib/render/inspect";
import { cardTitle, legendOf, labelsOf, timeShapeOf } from "./contract";
import page from "./__fixtures__/gbif-occurrences.puma-tahoe.json";
import boulder from "./__fixtures__/gbif-occurrences.puma-boulder.json";
import match from "./__fixtures__/gbif-occurrences.match-puma.json";
import pumaSpecies from "./__fixtures__/gbif-occurrences.species-puma.json";
import cranes from "./__fixtures__/gbif-occurrences.cranes-platte-march.json";
import antigone from "./__fixtures__/gbif-occurrences.match-antigone.json";

const TAHOE: [number, number, number, number] = [-120.4, 38.7, -119.8, 39.3];
const NOW = new Date("2026-10-09T12:00:00Z");
const DEFAULTS = { density: false };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function ctx(stub: ReturnType<typeof vi.fn>, bbox = TAHOE, cacheKey?: string) {
  return { bbox, zoom: 10, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

/** A full page of `n` identical-shaped records, to exercise paging. */
function fullPage(n: number, count: number, endOfRecords: boolean) {
  const results = Array.from({ length: n }, (_, i) => ({
    key: 1000 + i,
    species: "Puma concolor",
    decimalLatitude: 39,
    decimalLongitude: -120,
    eventDate: "2024-05-01",
    year: 2024,
    basisOfRecord: "HUMAN_OBSERVATION",
  }));
  return { count, endOfRecords, results };
}

describe("gbif-occurrences layer", () => {
  it("declares global coverage, a per-record license, no env and heat and cluster hints", () => {
    expect(layer.id).toBe("gbif-occurrences");
    expect(layer.coverage).toBe("global");
    expect(layer.license).toMatch(/GBIF/);
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(50_000);
    expect(layer.hardMaxAreaKm2).toBe(Number.POSITIVE_INFINITY);
    expect(layer.wide).toEqual({ mode: "tiles", limit: 0 });
    expect(layer.input.parse({})).toEqual(DEFAULTS);
    expect(layer.style).toMatchObject({ geometry: "point", heat: true, cluster: true });
  });

  it("builds a counter-clockwise polygon and the search URL with filters", () => {
    expect(bboxPolygon(TAHOE)).toBe("POLYGON((-120.4 38.7,-119.8 38.7,-119.8 39.3,-120.4 39.3,-120.4 38.7))");
    const url = new URL(searchUrl(TAHOE, { scientificName: "Puma concolor", yearFrom: 2015, yearTo: 2020 }, 300, NOW));
    expect(url.origin + url.pathname).toBe("https://api.gbif.org/v1/occurrence/search");
    expect(url.searchParams.get("geometry")).toBe(bboxPolygon(TAHOE));
    expect(url.searchParams.get("hasCoordinate")).toBe("true");
    expect(url.searchParams.get("hasGeospatialIssue")).toBe("false");
    expect(url.searchParams.get("scientificName")).toBe("Puma concolor");
    expect(url.searchParams.get("year")).toBe("2015,2020");
    expect(url.searchParams.get("limit")).toBe("300");
    expect(url.searchParams.get("offset")).toBe("300");
  });

  it("prefers taxonKey over scientificName and defaults to the last ten years", () => {
    const url = new URL(searchUrl(TAHOE, { scientificName: "Felidae", taxonKey: 2435099 }, 0, NOW));
    expect(url.searchParams.get("taxonKey")).toBe("2435099");
    expect(url.searchParams.has("scientificName")).toBe(false);
    expect(url.searchParams.get("year")).toBe("2016,2026");
    expect(yearRange({ yearTo: 2000 }, NOW)).toEqual({ from: 2000, to: 2000 });
    expect(yearRange({ yearFrom: 2030, yearTo: 2020 }, NOW)).toEqual({ from: 2020, to: 2020 });
  });

  it("normalizes records to points with species, year as v, t, dataset, basis and a short license", () => {
    const { data, vague } = normalizeOccurrences(page);
    // 14 records, one with 28 km of positional uncertainty is dropped as vague.
    expect(vague).toBe(1);
    expect(data.features).toHaveLength(13);
    const first = data.features[0];
    expect(first.geometry).toEqual({ type: "Point", coordinates: [-119.962988, 39.277358] });
    expect(first.properties).toEqual({
      species: "Puma concolor",
      year: 2025,
      v: 2025,
      month: 5,
      season: "spring",
      t: "2025-05-24T17:59:34.000Z",
      url: "https://www.inaturalist.org/observations/283853425",
      basisOfRecord: "human observation",
      dataset: "iNaturalist research-grade observations",
      publisher: "inaturalist",
      license: "CC BY-NC 4.0",
      uncertaintyM: 9,
    });
    // A date-only eventDate and a time without seconds both parse to ISO.
    expect(data.features.some((f) => f.properties?.t === "2025-10-09T00:00:00.000Z")).toBe(true);
    expect(data.features.some((f) => f.properties?.t === "2024-07-03T21:44:00.000Z")).toBe(true);
  });

  it("marks iNaturalist records apart from specimens and other publishers (west of Boulder fixture)", () => {
    const { data, vague } = normalizeOccurrences(boulder);
    expect(vague).toBe(1);
    expect(data.features.map((f) => [f.properties?.publisher, f.properties?.basisOfRecord])).toEqual([
      ["inaturalist", "human observation"],
      ["inaturalist", "human observation"],
      ["other", "preserved specimen"],
      ["other", "preserved specimen"],
    ]);
  });

  it("shows the date once (the chip), not again as a row or as the year, and says iNaturalist records repeat the species layer", () => {
    const { data } = normalizeOccurrences(boulder);
    const content = cardContent(data.features[0], { card: layer.card, fieldHelp: layer.fieldHelp });
    const rows = [...content.facts, ...content.details];
    expect(rows.map((r) => r.label)).not.toContain("Date");
    expect(rows.map((r) => r.key)).not.toContain("year");
    expect(rows.map((r) => r.key)).not.toContain("v");
    expect(content.facts.find((r) => r.key === "publisher")?.value).toBe("iNaturalist (the same sighting is in the species layer)");
    expect(summarizeFeature(data.features[0]).date).not.toBeNull();
  });

  it("declares continuous yearly time, a publisher legend, two encode colors and year labels on the newest five", () => {
    const { data } = normalizeOccurrences(boulder);
    expect(timeShapeOf(layer, data)).toMatchObject({ shape: "continuous", step: "year", span: { start: "2023-10-14", end: "2026-06-28" } });
    const legend = legendOf(layer, data);
    expect(legend).toMatchObject({ kind: "categories", field: "publisher" });
    expect(legend.items?.map((i) => i.value)).toEqual(["inaturalist", "other"]);
    expect(layer.style.encode).toEqual({ color: "publisher" });
    expect(labelsOf(layer)).toEqual({ field: "year", max: 5, rankBy: "year" });
  });

  it("falls back to year and month, uses a range's start, and skips rows with no position or date", () => {
    const base = { decimalLatitude: 1, decimalLongitude: 2, basisOfRecord: "PRESERVED_SPECIMEN" };
    const { data } = normalizeOccurrences({
      results: [
        { key: 1, ...base, year: 1950, month: 6 },
        { key: 2, ...base, eventDate: "1999-03-02/1999-03-09", year: 1999 },
        { key: 3, ...base },
        { key: 4, decimalLatitude: 1, year: 2000 },
        { key: 5, ...base, year: 2001, scientificName: "Quercus", datasetName: "Herbarium" },
      ],
    });
    expect(data.features.map((f) => f.properties?.t)).toEqual([
      "1950-06-01T00:00:00.000Z",
      "1999-03-02T00:00:00.000Z",
      "2001-01-01T00:00:00.000Z",
    ]);
    expect(data.features[0].properties).toMatchObject({ species: "Unidentified", url: "https://www.gbif.org/occurrence/1", basisOfRecord: "preserved specimen" });
    expect(data.features[2].properties).toMatchObject({ species: "Quercus", dataset: "Herbarium" });
  });

  it("shortens license URLs", () => {
    expect(shortLicense("http://creativecommons.org/licenses/by-nc/4.0/legalcode")).toBe("CC BY-NC 4.0");
    expect(shortLicense("http://creativecommons.org/licenses/by/4.0/legalcode")).toBe("CC BY 4.0");
    expect(shortLicense("http://creativecommons.org/publicdomain/zero/1.0/legalcode")).toBe("CC0");
    expect(shortLicense(undefined)).toBeUndefined();
  });

  it("titles records by the species' common name from GBIF, with the Latin name as a row once", async () => {
    // The Tahoe page with each record's species key, as the live search returns it.
    const keyed = { ...page, results: page.results.map((r) => ({ ...r, speciesKey: 2435099 })) };
    const stub = vi.fn(async (url: string) => json(url.includes("/v1/species/2435099") ? pumaSpecies : keyed));
    const r = await layer.query(ctx(stub, TAHOE, "gbif:k"), { ...DEFAULTS, scientificName: "Puma concolor" });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const calls = stub.mock.calls as unknown as [string, { cacheKey?: string }][];
    // One page, then one name lookup for the one species, cached without the bbox.
    expect(calls.map(([u]) => new URL(u).pathname)).toEqual(["/v1/occurrence/search", "/v1/species/2435099"]);
    expect(calls[1][1].cacheKey).toBe("gbif:species:2435099");
    const f = r.data.features[0];
    expect(f.properties).toMatchObject({ name: "Puma", species: "Puma concolor", scientificName: "Puma concolor", speciesKey: 2435099 });
    expect(cardTitle(layer, f)).toBe("Puma");
    const content = cardContent(f, { card: layer.card, fieldHelp: layer.fieldHelp });
    const rows = [...content.facts, ...content.details];
    expect(content.facts.find((x) => x.key === "scientificName")?.value).toBe("Puma concolor");
    expect(rows.filter((x) => x.value === "Puma concolor")).toHaveLength(1);
    expect(rows.map((x) => x.key)).not.toContain("speciesKey");
  });

  it("keeps the Latin title, with no repeat row, when GBIF has no common name or the lookup fails", async () => {
    const keyed = { ...page, results: page.results.map((r) => ({ ...r, speciesKey: 2435099 })) };
    const stub = vi.fn(async (url: string) => (url.includes("/v1/species/") ? new Response("busy", { status: 503 }) : json(keyed)));
    const r = await layer.query(ctx(stub), DEFAULTS);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const f = r.data.features[0];
    expect(f.properties).not.toHaveProperty("name");
    expect(cardTitle(layer, f)).toBe("Puma concolor");
    const rows = cardContent(f, { card: layer.card, fieldHelp: layer.fieldHelp }).facts;
    expect(rows.map((x) => x.key)).not.toContain("scientificName");
  });

  it("looks up at most the 20 most recorded species", () => {
    const { data } = normalizeOccurrences({
      results: Array.from({ length: 30 }, (_, i) => ({ key: i, species: `Sp ${i}`, speciesKey: i, decimalLatitude: 1, decimalLongitude: 2, year: 2020 })),
    });
    expect(speciesToName(data.features)).toHaveLength(MAX_NAME_LOOKUPS);
    withCommonNames(data.features, new Map([[3, "quaking aspen"]]));
    expect(data.features[3].properties).toMatchObject({ name: "Quaking aspen", scientificName: "Sp 3" });
    expect(data.features[4].properties).not.toHaveProperty("name");
  });

  it("declares Published by as a category, so the map colors it by kind", () => {
    expect(layer.attributes?.find((a) => a.key === "publisher")).toMatchObject({ type: "category", label: "Published by" });
    expect(layer.style.encode?.color).toBe("publisher");
  });

  it("returns points with a vague-record note when the result fits in one page", async () => {
    const stub = vi.fn(async () => json(page));
    const r = await layer.query(ctx(stub, TAHOE, "gbif:k"), { ...DEFAULTS, scientificName: "Puma concolor" });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(stub).toHaveBeenCalledTimes(1);
    const calls = stub.mock.calls as unknown as [string, RequestInit & { cacheKey?: string; ttlSeconds?: number }][];
    expect(calls[0][1].cacheKey).toBe("gbif:k:gbif-p1");
    expect(calls[0][1].ttlSeconds).toBe(6 * 3600);
    expect(new URL(calls[0][0]).searchParams.get("scientificName")).toBe("Puma concolor");
    expect(r.data.features).toHaveLength(13);
    expect(r.coverageNote).toMatch(/1 record with a position vaguer than 5 km was left out/);
    expect(r.citation.source).toContain("GBIF");
  });

  it("reads at most two pages and says how many records exist", async () => {
    const stub = vi.fn(async () => json(fullPage(300, 45_000, false)));
    const r = await layer.query(ctx(stub), DEFAULTS);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(stub).toHaveBeenCalledTimes(2);
    const offsets = (stub.mock.calls as unknown as [string][]).map(([u]) => new URL(u).searchParams.get("offset"));
    expect(offsets).toEqual(["0", "300"]);
    expect(r.data.features).toHaveLength(600);
    expect(r.coverageNote).toMatch(/first 600 of 45,000/);
  });

  it("keeps page one when page two fails", async () => {
    let n = 0;
    const stub = vi.fn(async () => (++n === 1 ? json(fullPage(300, 5000, false)) : new Response("busy", { status: 503 })));
    const r = await layer.query(ctx(stub), DEFAULTS);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(300);
    expect(r.coverageNote).toMatch(/page 2 failed/);
  });

  it("maps an HTTP error, a bad body and a network failure on page one to upstream errors", async () => {
    expect(await layer.query(ctx(vi.fn(async () => new Response("nope", { status: 500 }))), DEFAULTS)).toMatchObject({ hint: "upstream" });
    expect(await layer.query(ctx(vi.fn(async () => json({ nope: true }))), DEFAULTS)).toMatchObject({ hint: "upstream" });
    const down = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await layer.query(ctx(down), DEFAULTS)).toMatchObject({ hint: "upstream" });
  });

  it("answers points over 50,000 km² (wide) with the density tiles for the same name and years, and serves density there", async () => {
    const big: [number, number, number, number] = [-125, 30, -100, 50];
    const stub = vi.fn(async () => json(match));
    const wide = await layer.query({ ...ctx(stub, big), wide: true, wideStrategy: layer.wide }, { ...DEFAULTS, scientificName: "Puma concolor", yearFrom: 2010 });
    if (!("kind" in wide) || wide.kind !== "tiles") throw new Error("expected tiles");
    expect(wide.data.url).toMatch(/taxonKey=2435099&year=2010,\d{4}$/);
    // Only the name lookup, never the occurrence search.
    expect((stub.mock.calls as unknown as [string][]).every((c) => c[0].includes("/species/match"))).toBe(true);
    const plain = vi.fn();
    expect(await layer.query(ctx(plain, big), { density: true })).toMatchObject({ kind: "tiles" });
    expect(plain).not.toHaveBeenCalled();
  });

  it("reads a month, a range (wrapping past December) or a northern-hemisphere season as months", () => {
    expect(monthsOf({})).toBeUndefined();
    expect(monthsOf({ month: 3 })).toEqual([3]);
    expect(monthsOf({ month: "3-4" })).toEqual([3, 4]);
    expect(monthsOf({ month: "11-2" })).toEqual([11, 12, 1, 2]);
    expect(monthsOf({ season: "winter" })).toEqual([12, 1, 2]);
    expect(monthsOf({ season: "spring", month: 7 })).toEqual([7]);
    expect(monthsText({ month: 3 })).toBe("March");
    expect(monthsText({ season: "fall" })).toBe("fall (September to November, northern-hemisphere seasons)");
    expect(layer.input.safeParse({ month: "3-4" }).success).toBe(true);
    expect(layer.input.safeParse({ month: 13 }).success).toBe(false);
    expect(layer.input.safeParse({ month: "March" }).success).toBe(false);
  });

  it("asks the search for each month (GBIF ORs them; a wrapping range is a 400)", () => {
    const march = new URL(searchUrl(TAHOE, { month: 3 }, 0, NOW));
    expect(march.searchParams.getAll("month")).toEqual(["3"]);
    const winter = new URL(searchUrl(TAHOE, { season: "winter" }, 0, NOW));
    expect(winter.searchParams.getAll("month")).toEqual(["12", "1", "2"]);
    expect(new URL(searchUrl(TAHOE, {}, 0, NOW)).searchParams.has("month")).toBe(false);
  });

  it("draws a month on the ad-hoc map in web Mercator, since the density endpoint ignores month", () => {
    expect(densityTileUrl(2474953, { from: 2016, to: 2026 }, [3, 4])).toBe(
      "https://api.gbif.org/v2/map/occurrence/adhoc/{z}/{x}/{y}@1x.png?srs=EPSG:3857&style=purpleYellow.poly&bin=hex&hexPerTile=40&taxonKey=2474953&year=2016,2026&month=3&month=4",
    );
  });

  it("gives every record its month and season, so March is a filter (sandhill cranes on the Platte, March, recorded 2026-10-23)", () => {
    const { data } = normalizeOccurrences(cranes);
    expect(data.features.length).toBeGreaterThan(0);
    expect(data.features.every((f) => f.properties?.month === 3 && f.properties?.season === "spring")).toBe(true);
    const month = layer.attributes?.find((a) => a.key === "month");
    expect(month?.levels?.find((l) => l.value === 3)?.label).toBe("March");
    expect(layer.card?.hidden).toEqual(expect.arrayContaining(["month", "season"]));
  });

  it("reads a synonym as its accepted taxon and says the months in the note (Antigone canadensis is Grus canadensis)", async () => {
    const stub = vi.fn(async () => json(antigone));
    const r = await layer.query(ctx(stub, [-104.05, 40, -95.3, 43], "gbif:k"), { density: true, scientificName: "Antigone canadensis", month: 3 });
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.data.url).toContain("/adhoc/");
    expect(r.data.url).toContain("taxonKey=2474953");
    expect(r.data.url).toMatch(/&month=3$/);
    expect(r.coverageNote).toMatch(/^Records from March of every year, \d{4} to \d{4}$/);
  });

  it("notes the months on points too", async () => {
    const stub = vi.fn(async (url: string) => (url.includes("/occurrence/search") ? json(cranes) : json({})));
    const r = await layer.query(ctx(stub, [-100.5, 40.4, -97.5, 41.2]), { density: false, taxonKey: 2474953, month: 3 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected points");
    expect(String((stub.mock.calls[0] as unknown[])[0])).toContain("month=3");
    expect(r.coverageNote).toMatch(/^Records from March of every year/);
  });

  it("builds density tile URLs with the taxon and the year window", () => {
    expect(densityTileUrl(undefined, { from: 2016, to: 2026 })).toBe(
      "https://api.gbif.org/v2/map/occurrence/density/{z}/{x}/{y}@1x.png?style=purpleYellow.point&year=2016,2026",
    );
    expect(densityTileUrl(2435099, { from: 2010, to: 2020 })).toBe(
      "https://api.gbif.org/v2/map/occurrence/density/{z}/{x}/{y}@1x.png?style=purpleYellow.point&taxonKey=2435099&year=2010,2020",
    );
  });

  it("resolves a scientific name to a taxon key for density tiles", async () => {
    const stub = vi.fn(async () => json(match));
    const r = await layer.query(ctx(stub, TAHOE, "gbif:k"), { density: true, scientificName: "Puma concolor" });
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(stub).toHaveBeenCalledTimes(1);
    const calls = stub.mock.calls as unknown as [string, RequestInit & { cacheKey?: string }][];
    expect(calls[0][0]).toContain("https://api.gbif.org/v1/species/match?name=Puma+concolor");
    expect(calls[0][1].cacheKey).toBe("gbif:match:puma concolor");
    expect(r.data).toMatchObject({ format: "raster", minzoom: 0, maxzoom: 14, tileSize: 256 });
    expect(r.data.url).toContain("taxonKey=2435099");
    expect(r.data.url).toMatch(/year=\d{4},\d{4}$/);
    const { from, to } = yearRange({}, new Date());
    expect(r.data.url).toContain(`year=${from},${to}`);
  });

  it("uses a given taxonKey without a lookup and passes explicit years", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub), { density: true, taxonKey: 212, yearFrom: 2000 });
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(stub).not.toHaveBeenCalled();
    expect(r.data.url).toMatch(/taxonKey=212&year=2000,\d{4}$/);
  });

  it("rejects a name GBIF cannot match, with advice to use the Latin name", async () => {
    for (const body of [{ matchType: "NONE" }, { usageKey: 5, matchType: "HIGHERRANK" }]) {
      const stub = vi.fn(async () => json(body));
      const r = await layer.query(ctx(stub), { density: true, scientificName: "mountain lion" });
      expect(r).toMatchObject({ error: expect.stringContaining("Latin name") });
      expect(r).not.toHaveProperty("hint");
    }
    expect(await layer.query(ctx(vi.fn(async () => new Response("x", { status: 500 }))), { density: true, scientificName: "x" })).toMatchObject({ hint: "upstream" });
  });

  it("summarizes density tiles and points for the model", async () => {
    const tiles = await layer.query(ctx(vi.fn()), { density: true });
    expect(summarizeLayerResult(tiles)).toMatchObject({ kind: "tiles", format: "raster" });
    const points = await layer.query(ctx(vi.fn(async () => json(page))), DEFAULTS);
    expect(summarizeLayerResult(points)).toMatchObject({ kind: "geojson", featureCount: 13 });
  });

  it("is registered and validates input through runLayer", async () => {
    expect((await runLayer("gbif-occurrences", { bbox: TAHOE, input: { yearFrom: 1000 } })).status).toBe(400);
    const tiles = await runLayer("gbif-occurrences", { bbox: [-170, -60, 170, 70], input: { density: true } });
    expect(tiles.status).toBe(200);
    // Points for the whole world come back as the density map with a note, not a zoom_in error.
    expect(await runLayer("gbif-occurrences", { bbox: [-170, -60, 170, 70] })).toMatchObject({
      status: 200,
      body: { kind: "tiles", truncated: true, coverageNote: expect.stringMatching(/^Showing a density map at this scale/) },
    });
  });

  it("describes the layer in the words people use and warns about sampling bias", () => {
    expect(layer.description).toMatch(/Latin name/);
    expect(layer.description).toMatch(/density/);
    expect(layer.description).toMatch(/where people and institutions looked/);
  });
});
