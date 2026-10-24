/**
 * Species sightings from iNaturalist. Endpoint: https://api.inaturalist.org/v1/observations
 * Query params used (verified live 2026-10-09): nelat, nelng, swlat, swlng (bbox), per_page=200 (the
 * maximum), page, d1 (observed on or after, YYYY-MM-DD), quality_grade=research, geo=true (has coordinates),
 * taxon_name (common or scientific name, includes descendants), order_by=observed_on&order=desc.
 * Response: { total_results, page, per_page, results: [...] }. Fields read per result: id, uri,
 * observed_on (YYYY-MM-DD), time_observed_at (ISO with offset, may be null), geojson ({ type: "Point",
 * coordinates: [lon, lat] }), obscured (true when the location was randomised within about 0.2 degrees to
 * protect a threatened species or by user choice), license_code ("cc-by-nc", "cc0", ... or null for all
 * rights reserved), species_guess, taxon.name (scientific) and taxon.preferred_common_name.
 * Fixture: layers/__fixtures__/species.tahoe.json (50 of 200 results, Lake Tahoe west shore, trimmed to the
 * fields above). iNaturalist asks for no more than about 1 request per second; pages are spaced 600 ms apart.
 * Wide mode (over 50,000 km², up to 1,500,000 km²; Nebraska, 242,000 km², was an error at the old 200,000 cap, and the
 * cost is the same ten pages or a tile template at any size):
 *   - with a taxon, the 2,000 most recent observations (10 pages, same 600 ms spacing) and total_results as the total, so a
 *     filtered question keeps its filter;
 *   - with no taxon, a density map instead of points: GBIF density tiles of the iNaturalist Research-grade Observations
 *     dataset (datasetKey 50c9509d-22c7-4a22-a47d-8c48425ef4a7, the copy iNaturalist shares with GBIF weekly), whole years
 *     covering `days`. Unconfirmed observations are not in that dataset, which the note says when researchGradeOnly is off.
 * Taxon (2026-10-18): a name is resolved to one iNaturalist taxon before the search, so "elk" means Cervus canadensis and
 *   not moose (Alces alces is "elk" in British English) or elk thistle, which `taxon_name` matched. The country under the
 *   box comes from https://api.inaturalist.org/v1/places/nearby (the standard place with admin_level 0) and is passed as
 *   `preferred_place_id` with `locale=en` to https://api.inaturalist.org/v1/taxa/autocomplete?q=, which then ranks and
 *   names taxa as people there do (in the US "elk" puts Cervus canadensis, common name Elk, first; without the place it
 *   came second to moose). pickTaxon takes an exact scientific name, then an exact common name, then an exact matched
 *   term, then the first result. Observations are asked for by `taxon_id` (descendants included) through the slim v2
 *   endpoint, and each one is grouped under its species (`taxon.min_species_taxon_id`), so the subspecies American Elk
 *   and the species Elk are one chip. Smoke 2026-10-18 near Estes Park (-105.7,40.3,-105.4,40.45), 365 days, "elk":
 *   683 sightings, all Cervus canadensis (158 at species rank, 42 of the first 200 as the subspecies American Elk).
 * Trout (2026-10-23): autocomplete for "trout" ranks fawn lilies (Erythronium, matched on "trout lilies") first, then
 *   yellow trout lily, Smallmouth Bass ("Trout Bass") and trout-perches: no result is a trout. Anglers' words the
 *   autocomplete misreads are sent as a Latin name instead (TAXON_ALIASES: "trout" is Salmoninae, the salmons and trouts,
 *   which holds Oncorhynchus, Salmo and Salvelinus), and with no exact match the first result whose name ends in the asked
 *   word ("Lake Trout", not "trout lily") is preferred to the first result.
 * Months (2026-10-23): `month` takes a comma list, ORed (Platte box, birds since 2016: all 6,398, month=3 1,064, 3,4
 *   1,801, 12,1,2 360), so a month, a range or a season (helpers shared with gbif-occurrences) is one parameter.
 * Smoke wide 2026-10-14 (through runLayer), box -123,37,-120,40 (about 88,000 km²), 365 days: taxon "birds" returned the 1,857 most recent
 *   of 26,626 in 14.4 s (591 KB; 143 obscured left out); "mule deer" all 1,655 in 7.1 s; no taxon the density tiles in 0.0 s. Before the
 *   v2 `fields` request and the overlapped pages, the "mule deer" fetch took 35.6 s (v1 pages were about 14 MB each).
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { defineLayer, type Attribute, type BBox, type LayerError, type LayerResult, type CardSpec, type FieldHelp } from "./types";
import { timeAttribute } from "./_shared/bands";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { layerColor } from "@/lib/render/palette";
import { MONTH_NAMES, monthsOf, monthsText, seasonOf } from "./gbif-occurrences";

/**
 * The v2 endpoint takes the v1 parameters plus `fields`, which cuts a 200-row page from about 14 MB to 85 KB, so every
 * fetch uses it.
 */
const ENDPOINT_V2 = "https://api.inaturalist.org/v2/observations";
const V2_FIELDS =
  "id,uri,observed_on,time_observed_at,obscured,license_code,species_guess,geojson,taxon.id,taxon.name,taxon.rank,taxon.preferred_common_name,taxon.min_species_taxon_id";
const AUTOCOMPLETE_URL = "https://api.inaturalist.org/v1/taxa/autocomplete";
const PLACES_URL = "https://api.inaturalist.org/v1/places/nearby";
const SPECIES_COUNTS_URL = "https://api.inaturalist.org/v1/observations/species_counts";
/** Taxon names and countries do not change; a week keeps repeat questions to one request. */
const LOOKUP_TTL_SECONDS = 7 * 86_400;
const PER_PAGE = 200;
/** Most observations a result carries, the most recent: 10 pages started 600 ms apart (a year of elk near Estes Park is 683). */
const MAX_PAGES = 10;
const WIDE_LIMIT = MAX_PAGES * PER_PAGE;
/** GBIF density tiles, used for a wide view with no taxon. */
const DENSITY_URL = "https://api.gbif.org/v2/map/occurrence/density/{z}/{x}/{y}@1x.png";
/** GBIF's copy of iNaturalist research-grade observations. */
export const INAT_GBIF_DATASET = "50c9509d-22c7-4a22-a47d-8c48425ef4a7";
const PAGE_SPACING_MS = 600;
const MS_PER_DAY = 86_400_000;
/** Search results change slowly; six hours keeps repeat questions cheap without hiding new sightings for long. */
const CACHE_TTL_SECONDS = 6 * 3600;

/** One month 1 to 12, or a range "3-4" (wrapping past December: "11-2"). */
const MONTH_RANGE = /^\s*(1[0-2]|0?[1-9])\s*(?:[-–,]|to)\s*(1[0-2]|0?[1-9])\s*$/;

const inputSchema = z.object({
  taxon: z.string().trim().min(1).max(120).optional(),
  days: z.number().int().min(1).max(3650).default(365),
  researchGradeOnly: z.boolean().default(true),
  month: z.union([z.number().int().min(1).max(12), z.string().regex(MONTH_RANGE)]).optional(),
  season: z.enum(["spring", "summer", "fall", "winter"]).optional(),
});

/**
 * Names the taxon autocomplete reads as something else, sent as the Latin name instead: "trout" ranked fawn lilies
 * (Erythronium, "trout lily") first and no trout in its top ten (2026-10-23).
 */
export const TAXON_ALIASES: Record<string, string> = {
  trout: "Salmoninae",
  trouts: "Salmoninae",
};

/** The name to look up: an alias's Latin name, else the name as asked. */
export function lookupName(name: string): string {
  return TAXON_ALIASES[name.trim().toLowerCase().replace(/\s+/g, " ")] ?? name;
}

type SpeciesInput = z.infer<typeof inputSchema>;

const observationSchema = z.object({
  id: z.number(),
  uri: z.string().nullish(),
  observed_on: z.string().nullish(),
  time_observed_at: z.string().nullish(),
  obscured: z.boolean().nullish(),
  license_code: z.string().nullish(),
  species_guess: z.string().nullish(),
  geojson: z
    .object({ type: z.literal("Point"), coordinates: z.tuple([z.number(), z.number()]) })
    .nullish(),
  taxon: z
    .object({
      id: z.number().nullish(),
      name: z.string().nullish(),
      rank: z.string().nullish(),
      preferred_common_name: z.string().nullish(),
      min_species_taxon_id: z.number().nullish(),
    })
    .nullish(),
});

const pageSchema = z.object({
  total_results: z.number().optional(),
  results: z.array(z.unknown()),
});

/** One taxon the asked name stands for: its iNaturalist id, scientific name, rank and common name. */
export type ResolvedTaxon = { id: number; name: string; rank?: string; commonName?: string };

/** What the page URLs filter by: a resolved taxon id, or the raw name when the lookup failed; the country for names. */
export type TaxonFilter = { taxonId?: number; placeId?: number };

/** Request URL for one page of the slim v2 endpoint; `now` is injected so the date maths is testable. */
export function observationsUrl(
  bbox: BBox,
  input: Pick<SpeciesInput, "days" | "taxon" | "researchGradeOnly"> & Partial<Pick<SpeciesInput, "month" | "season">>,
  pageNo: number,
  now: Date,
  filter: TaxonFilter = {},
): string {
  const [west, south, east, north] = bbox;
  const d1 = new Date(now.getTime() - input.days * MS_PER_DAY).toISOString().slice(0, 10);
  const search = new URLSearchParams({
    nelat: String(north),
    nelng: String(east),
    swlat: String(south),
    swlng: String(west),
    per_page: String(PER_PAGE),
    page: String(pageNo),
    d1,
    geo: "true",
    order_by: "observed_on",
    order: "desc",
  });
  if (input.researchGradeOnly) search.set("quality_grade", "research");
  // Those months of every year in the window (iNaturalist ORs a comma list).
  const months = monthsOf(input);
  if (months) search.set("month", months.join(","));
  if (filter.taxonId !== undefined) search.set("taxon_id", String(filter.taxonId));
  else if (input.taxon !== undefined) search.set("taxon_name", input.taxon);
  // Common names as people in the box's country say them ("Elk" in the US, "Wapiti" elsewhere).
  search.set("locale", "en");
  if (filter.placeId !== undefined) search.set("preferred_place_id", String(filter.placeId));
  search.set("fields", V2_FIELDS);
  return `${ENDPOINT_V2}?${search.toString()}`;
}

/** The standard places under a box (country, state, county...), for the country whose common names to use. */
export function placesUrl(bbox: BBox): string {
  const [west, south, east, north] = bbox;
  const r = (n: number) => n.toFixed(2);
  return `${PLACES_URL}?nelat=${r(north)}&nelng=${r(east)}&swlat=${r(south)}&swlng=${r(west)}&per_page=10`;
}

/** Taxon autocomplete for a name, ranked and named for a country when one is known. */
export function autocompleteUrl(q: string, placeId?: number): string {
  const search = new URLSearchParams({ q, per_page: "10", locale: "en", is_active: "true" });
  if (placeId !== undefined) search.set("preferred_place_id", String(placeId));
  return `${AUTOCOMPLETE_URL}?${search.toString()}`;
}

const placesSchema = z.object({
  results: z.object({ standard: z.array(z.object({ id: z.number(), admin_level: z.number().nullish() })).optional() }).optional(),
});

/** The country (admin level 0) among the standard places under a box, or undefined. */
export function countryOf(json: unknown): number | undefined {
  const parsed = placesSchema.safeParse(json);
  if (!parsed.success) return undefined;
  return parsed.data.results?.standard?.find((p) => p.admin_level === 0)?.id;
}

const autocompleteSchema = z.object({
  results: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      rank: z.string().nullish(),
      preferred_common_name: z.string().nullish(),
      matched_term: z.string().nullish(),
      is_active: z.boolean().nullish(),
    }),
  ),
});

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The one taxon a name stands for, from an autocomplete answer (already ranked for the country): an exact scientific
 * name, else an exact common name, else an exact matched term (another common name or synonym), else the first
 * result. Null when there is none.
 */
export function pickTaxon(q: string, json: unknown): ResolvedTaxon | null {
  const parsed = autocompleteSchema.safeParse(json);
  if (!parsed.success) return null;
  const results = parsed.data.results.filter((r) => r.is_active !== false);
  const want = norm(q);
  // "Lake Trout" ends in the asked word; "trout lily" only uses it to describe a lily.
  const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const endsInWant = new RegExp(`(^|[^a-z])${escaped}(e?s)?$`);
  const headNoun = (s: string | null | undefined) => endsInWant.test(norm(s));
  const hit =
    results.find((r) => norm(r.name) === want) ??
    results.find((r) => norm(r.preferred_common_name) === want) ??
    results.find((r) => norm(r.matched_term) === want) ??
    results.find((r) => headNoun(r.matched_term) || headNoun(r.preferred_common_name)) ??
    results[0];
  if (!hit) return null;
  return {
    id: hit.id,
    name: hit.name,
    ...(hit.rank && { rank: hit.rank }),
    ...(hit.preferred_common_name && { commonName: hit.preferred_common_name }),
  };
}

/**
 * Species whose common name or matched term ends in the asked word, when no result matches the name exactly: the
 * candidates a sighting count in the box picks between ("condor" lists Andean Condor before California Condor, "desert
 * tortoise" the whole genus Gopherus before the Mojave Desert Tortoise; 2026-10-23). Empty when a result is exact.
 */
export function speciesCandidates(q: string, json: unknown): ResolvedTaxon[] {
  const parsed = autocompleteSchema.safeParse(json);
  if (!parsed.success) return [];
  const results = parsed.data.results.filter((r) => r.is_active !== false);
  const want = norm(q);
  const exact = results.some((r) => norm(r.name) === want || norm(r.preferred_common_name) === want || norm(r.matched_term) === want);
  if (exact) return [];
  const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const endsInWant = new RegExp(`(^|[^a-z])${escaped}(e?s)?$`);
  return results
    .filter((r) => r.rank === "species" && (endsInWant.test(norm(r.preferred_common_name)) || endsInWant.test(norm(r.matched_term))))
    .slice(0, 5)
    .map((r) => ({ id: r.id, name: r.name, rank: "species", ...(r.preferred_common_name && { commonName: r.preferred_common_name }) }));
}

/** How many verifiable sightings of each of these species lie in the box (one request, iNaturalist species counts). */
export function speciesCountsUrl(ids: number[], bbox: BBox): string {
  const [west, south, east, north] = bbox;
  return `${SPECIES_COUNTS_URL}?taxon_id=${ids.join(",")}&nelat=${north}&nelng=${east}&swlat=${south}&swlng=${west}&verifiable=true`;
}

/** Sightings per species id from a species counts answer. */
export function readSpeciesCounts(json: unknown): Map<number, number> {
  const out = new Map<number, number>();
  const results = (json as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return out;
  for (const r of results) {
    const id = (r as { taxon?: { id?: unknown } })?.taxon?.id;
    const count = (r as { count?: unknown })?.count;
    if (typeof id === "number" && typeof count === "number") out.set(id, count);
  }
  return out;
}

/** "most in June (45), September (30) and May (25)": the busiest months of the sightings, when they span several. */
export function busiestMonths(features: Feature[], n = 3): string | undefined {
  const byMonth = new Map<number, number>();
  for (const f of features) {
    const m = f.properties?.month;
    if (typeof m === "number") byMonth.set(m, (byMonth.get(m) ?? 0) + 1);
  }
  if (byMonth.size < 2) return undefined;
  const top = [...byMonth.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, n);
  const parts = top.map(([m, c]) => `${MONTH_NAMES[m - 1]} (${c.toLocaleString("en-US")})`);
  return `most in ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]}`;
}

/** "American Bison 398, Pronghorn 188, …": the most-seen species, for a question with no taxon. */
export function topSpecies(features: Feature[], n = 5): { names: string; count: number } {
  const bySpecies = new Map<string, number>();
  for (const f of features) {
    const s = f.properties?.species;
    if (typeof s === "string") bySpecies.set(s, (bySpecies.get(s) ?? 0) + 1);
  }
  const top = [...bySpecies.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  return { names: top.map(([s, c]) => `${s} ${c.toLocaleString("en-US")}`).join(", "), count: bySpecies.size };
}

/** GBIF density tile template (`{z}/{x}/{y}` stay for the map) of iNaturalist research-grade observations, whole years covering `days`. */
export function inatDensityUrl(days: number, now: Date): string {
  const from = new Date(now.getTime() - days * MS_PER_DAY).getUTCFullYear();
  return `${DENSITY_URL}?style=purpleYellow.point&datasetKey=${INAT_GBIF_DATASET}&year=${from},${now.getUTCFullYear()}`;
}

function clean(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** `t` from the observation time (converted to UTC) or, failing that, midnight UTC on the observed date. */
function observedAt(time: string | undefined, date: string | undefined): string | null {
  if (time !== undefined) {
    const parsed = new Date(time);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const parsed = new Date(`${date}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

/**
 * Converts an observations page into points. Observations with obscured coordinates or no point are
 * left out (`skipped` counts them) because their position is wrong or missing; rows with no usable
 * date or id are dropped silently. Each point carries `taxonId`, the species it belongs to (iNaturalist's
 * `min_species_taxon_id`); one identified below species (a subspecies) also carries `identifiedAs` and is named by its
 * species in `groupBySpecies`.
 */
export function normalizeObservations(json: unknown): { data: FeatureCollection<Point>; skipped: number } {
  const features: Feature<Point>[] = [];
  let skipped = 0;
  const page = pageSchema.safeParse(json);
  if (!page.success) return { data: { type: "FeatureCollection", features }, skipped };

  for (const raw of page.data.results) {
    const parsed = observationSchema.safeParse(raw);
    if (!parsed.success) continue;
    const obs = parsed.data;
    if (obs.obscured === true || !obs.geojson) {
      skipped += 1;
      continue;
    }

    const date = clean(obs.observed_on);
    const t = observedAt(clean(obs.time_observed_at), date);
    if (t === null) continue;

    const scientific = clean(obs.taxon?.name);
    const common = clean(obs.taxon?.preferred_common_name);
    const species = common ?? scientific ?? clean(obs.species_guess) ?? "Unidentified";
    const properties: Record<string, string | number> = {
      species,
      observedOn: date ?? t.slice(0, 10),
      t,
      v: 1,
      url: clean(obs.uri) ?? `https://www.inaturalist.org/observations/${obs.id}`,
      // iNaturalist uses null for "all rights reserved".
      license: clean(obs.license_code) ?? "all-rights-reserved",
    };
    if (scientific !== undefined) properties.scientificName = scientific;
    const month = Number(properties.observedOn.toString().slice(5, 7));
    if (month >= 1 && month <= 12) {
      properties.month = month;
      properties.season = seasonOf(month);
    }
    const own = obs.taxon?.id ?? undefined;
    const speciesId = obs.taxon?.min_species_taxon_id ?? own;
    if (typeof speciesId === "number") properties.taxonId = speciesId;
    if (typeof own === "number" && typeof speciesId === "number" && own !== speciesId) {
      properties.identifiedAs = common && scientific ? `${common} (${scientific})` : species;
    }

    features.push({ type: "Feature", geometry: { type: "Point", coordinates: obs.geojson.coordinates }, properties });
  }
  return { data: { type: "FeatureCollection", features }, skipped };
}

/**
 * Names every point by its species (one name per `taxonId`), so the Species chips group by taxon: a sighting identified
 * as a subspecies (American Elk, Cervus canadensis canadensis) takes its species' name (Elk, Cervus canadensis), read
 * from a sighting identified at species rank, else from the asked taxon, else the subspecies' first two Latin words.
 */
export function groupBySpecies(features: Feature<Point>[], asked?: ResolvedTaxon | null): void {
  const names = new Map<number, { species: string; scientificName?: string }>();
  for (const f of features) {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    if (typeof p.taxonId === "number" && p.identifiedAs === undefined && typeof p.species === "string" && !names.has(p.taxonId)) {
      names.set(p.taxonId, { species: p.species, ...(typeof p.scientificName === "string" && { scientificName: p.scientificName }) });
    }
  }
  if (asked && !names.has(asked.id)) names.set(asked.id, { species: asked.commonName ?? asked.name, scientificName: asked.name });
  for (const f of features) {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    if (typeof p.taxonId !== "number" || p.identifiedAs === undefined) continue;
    let name = names.get(p.taxonId);
    if (!name) {
      const binomial = typeof p.scientificName === "string" ? p.scientificName.split(/\s+/).slice(0, 2).join(" ") : undefined;
      name = binomial ? { species: binomial, scientificName: binomial } : { species: String(p.species) };
      names.set(p.taxonId, name);
    }
    p.species = name.species;
    if (name.scientificName) p.scientificName = name.scientificName;
    else delete p.scientificName;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTimeout(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
}

/** iNaturalist licence codes as their licences are written. */
export const LICENSE_LABELS: Record<string, string> = {
  cc0: "CC0 (no rights reserved)",
  "cc-by": "CC BY",
  "cc-by-sa": "CC BY-SA",
  "cc-by-nd": "CC BY-ND",
  "cc-by-nc": "CC BY-NC",
  "cc-by-nc-sa": "CC BY-NC-SA",
  "cc-by-nc-nd": "CC BY-NC-ND",
  "all-rights-reserved": "All rights reserved",
};

const HELP: Record<string, FieldHelp> = {
  v: { text: "Always 1: each point is one sighting, so where points pile up is where people see and post things." },
  license: {
    text:
      "The licence the observer chose for the observation (for example CC BY-NC or CC0); all rights reserved when none; cite or link it when " +
      "showing it.",
    source: "iNaturalist",
    url: "https://www.inaturalist.org/",
  },
  observedOn: { text: "The date the organism was seen, as the observer entered it." },
  identifiedAs: {
    text: "The community identified this sighting more finely than species (a subspecies or variety); the map groups it under its species.",
    source: "iNaturalist",
    url: "https://www.inaturalist.org/",
  },
  species: { text: "The species the sighting belongs to, by its common name where people in this country have one; sightings of a subspecies count under their species." },
};

const CARD: CardSpec = {
  facts: [
    { key: "scientificName", label: "Scientific name" },
    { key: "identifiedAs", label: "Identified as" },
    { key: "observedOn", label: "Seen on", format: "date" },
    { key: "license", label: "Licence", values: LICENSE_LABELS },
  ],
  links: [{ key: "url", label: "Observation on iNaturalist" }],
  // The species is the card's title (lib/render/inspect.ts); taxonId is the grouping key, v is always 1.
  hidden: ["species", "taxonId", "v", "month", "season"],
};

const ATTRIBUTES: Attribute[] = [
  { key: "species", type: "category", label: "Species", primary: true },
  timeAttribute("Seen"),
  { key: "month", type: "category", label: "Month seen", levels: MONTH_NAMES.map((label, i) => ({ value: i + 1, label })) },
];

const species = defineLayer({
  id: "species",
  title: "Species sightings",
  description:
    "Wildlife and plant sightings that people logged on iNaturalist: each point is one observation with species (the species' common name as people in that country say it, or the scientific name if none), scientificName, taxonId (the iNaturalist species id), observedOn (date), t (when it was seen) and url (the observation page); " +
    "a sighting identified as a subspecies counts under its species and keeps identifiedAs (for example 'American Elk (Cervus canadensis canadensis)'). " +
    "v is always 1 (one sighting), so density shows where people see things. Each point also has license (the photographer's licence, such as cc-by-nc or cc0; cite or link the url when showing it). " +
    "Use it to answer what lives or flowers somewhere, or where to look for a kind of animal or plant. " +
    "Set taxon to a name to filter, for example 'elk', 'birds', 'mule deer' or 'Pandion haliaetus'. The name is resolved to one iNaturalist taxon by the country's common names ('elk' in the US is Cervus canadensis, 'trout' the salmons and trouts); a group such as 'birds' includes every bird. The coverage note names the taxon used. Leave it out for all species. " +
    "month (1-12 or '3-4') or season (spring, summer, fall, winter) keeps those months within days; for a month or season across many years ('cranes in March', 'where to see them in spring') use gbif-occurrences with month, which keeps that month of every year. " +
    "days (1 to 3650, default 365) sets how far back to look; researchGradeOnly (default true) keeps only community-confirmed observations; turn it off for unconfirmed ones. " +
    "Caveats: this reflects where people go and post, not where animals are, so trails, roads and towns look busy and remote areas look empty; absence of points is not absence of the species. " +
    "Sightings of threatened species and ones whose observer hid their location are left out (the result says how many), so rare animals are under-counted. " +
    "At most 2,000 of the most recent sightings are returned (10 pages of 200), and the result says when there are more. " +
    "Over 50,000 km² (about a 220 km square) it returns the 2,000 most recent with a taxon, or a density map without one.",
  coverage: "global",
  surface: "any",
  license: "CC BY-NC / CC0 per observation (iNaturalist)",
  requiredEnv: [],
  maxAreaKm2: 50_000,
  // Ten pages, or a tile template without a taxon, cost the same at any size; a state such as Nebraska (242,000 km²) fits.
  hardMaxAreaKm2: 1_500_000,
  wide: { orderBy: "date observed", rank: "most recent", limit: WIDE_LIMIT },
  input: inputSchema,
  style: { geometry: "point", color: layerColor("species") },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  // Sightings are events over the days asked for; the scrubber's step follows the data.
  time: { shape: "continuous" },
  legend: {
    kind: "symbol",
    items: [{ label: "One sighting", symbol: "point", color: layerColor("species") }],
    note: "Each dot is one iNaturalist sighting. Dots pile up where people look and post, not only where the species lives; the Species chips list what is in view.",
  },
  // The newest five sightings are named (the source order is newest first).
  labels: { field: "species", max: 5 },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const now = new Date();
    const citation = {
      source: "iNaturalist observations (CC BY-NC / CC0 per observation)",
      url: "https://www.inaturalist.org/",
      retrieved: now.toISOString(),
    };

    const when = monthsText(input);
    // Wide with no taxon: a density map of every sighting, since 2,000 unfiltered points would be a meaningless sample.
    if (ctx.wide && input.taxon === undefined) {
      const notes = [`iNaturalist research-grade observations as shared with GBIF, whole years from ${new Date(now.getTime() - input.days * MS_PER_DAY).getUTCFullYear()}`];
      if (when !== undefined) notes.push(`the density map is every month, not only ${when}; ask with a taxon for sightings in those months`);
      if (!input.researchGradeOnly) notes.push("unconfirmed observations are not in this map");
      return {
        kind: "tiles",
        data: { url: inatDensityUrl(input.days, now), minzoom: 0, maxzoom: 14, format: "raster", tileSize: 256 },
        citation: { ...citation, source: "iNaturalist Research-grade Observations via GBIF.org (density map)" },
        coverageNote: notes.join("; "),
      };
    }
    // The most recent sightings up to the limit (a wide view's strategy may ask for fewer).
    const maxPages = ctx.wide ? Math.ceil(Math.min(WIDE_LIMIT, ctx.wideStrategy?.limit ?? WIDE_LIMIT) / PER_PAGE) : MAX_PAGES;

    const notes: string[] = [];
    if (when !== undefined) notes.push(`sightings from ${when} only, in the last ${input.days.toLocaleString("en-US")} days`);
    // The country under the view names and ranks taxa as people there do; without it names fall back to iNaturalist's defaults.
    const placeId = await countryUnder(ctx);
    let asked: ResolvedTaxon | null = null;
    if (input.taxon !== undefined) {
      const resolved = await resolveTaxon(ctx, input.taxon, placeId);
      if ("error" in resolved) return resolved;
      if (resolved.taxon === null) {
        notes.push(`the iNaturalist name lookup failed, so "${input.taxon}" was matched as text and may include other species`);
      } else {
        asked = resolved.taxon;
        notes.push(`${input.taxon.charAt(0).toUpperCase()}${input.taxon.slice(1)} was read as ${taxonWords(asked)}${resolved.seenHere ? " (of the species the name can mean, the one seen most here)" : ""}`);
      }
    }
    const filter: TaxonFilter = { ...(asked && { taxonId: asked.id }), ...(placeId !== undefined && { placeId }) };

    type Page = { ok: true; body: unknown; results: number; total: number | undefined } | { ok: false; error: LayerError };
    const getPage = async (pageNo: number): Promise<Page> => {
      let body: unknown;
      try {
        const res = await ctx.fetch(observationsUrl(ctx.bbox, input, pageNo, now, filter), {
          cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:inat-p${pageNo}`,
          ttlSeconds: CACHE_TTL_SECONDS,
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        if (!res.ok) return { ok: false, error: { error: `iNaturalist returned ${res.status}`, hint: "upstream" } };
        body = await res.json();
      } catch (err) {
        return {
          ok: false,
          error: {
            error: isTimeout(err)
              ? `iNaturalist timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds`
              : "iNaturalist returned no response",
            hint: "upstream",
          },
        };
      }
      const parsed = pageSchema.safeParse(body);
      if (!parsed.success) return { ok: false, error: { error: "iNaturalist returned an unexpected response", hint: "upstream" } };
      return { ok: true, body, results: parsed.data.results.length, total: parsed.data.total_results };
    };

    const first = await getPage(1);
    if (!first.ok) return first.error;
    const total = first.total ?? 0;
    const pages: Page[] = [first];
    if (first.results >= PER_PAGE) {
      const needed = Math.min(maxPages, Math.ceil(total / PER_PAGE));
      // Ten sequential pages took 36 s, so the rest start 600 ms apart (the same request rate) without waiting for each answer.
      const rest = Array.from({ length: Math.max(0, needed - 1) }, (_, i) => sleep(PAGE_SPACING_MS * (i + 1)).then(() => getPage(i + 2)));
      pages.push(...(await Promise.all(rest)));
    }

    const features: Feature<Point>[] = [];
    let skipped = 0;
    let failedPage: number | null = null;
    let fetched = 0;
    for (const [i, page] of pages.entries()) {
      if (!page.ok) {
        failedPage = i + 1;
        break;
      }
      const normalized = normalizeObservations(page.body);
      features.push(...normalized.data.features);
      skipped += normalized.skipped;
      fetched += page.results;
      if (page.results < PER_PAGE) break;
    }
    const hitPageCap = failedPage === null && pages.length === maxPages && total > fetched;
    groupBySpecies(features, asked);

    // The count, first: how many sightings are drawn, of what, and when most were seen.
    const grade = input.researchGradeOnly ? " (research grade)" : "";
    const window = `in the last ${input.days.toLocaleString("en-US")} days`;
    const n = features.length;
    if (n === 0 && skipped > 0) {
      notes.unshift(
        `All ${skipped.toLocaleString("en-US")} sightings${asked ? ` of ${asked.commonName ?? asked.name}` : ""}${grade} here ${window} have hidden (obscured) locations, as iNaturalist does for threatened species and when observers ask, so none are drawn`,
      );
    } else if (n > 0) {
      const months = busiestMonths(features);
      const what = asked ? ` of ${asked.commonName ?? asked.name}` : "";
      const species = asked ? null : topSpecies(features);
      notes.unshift(
        `${n.toLocaleString("en-US")} sightings${what}${grade} drawn ${window}` +
          (species && species.count > 1 ? `, of ${species.count.toLocaleString("en-US")} species; most seen: ${species.names}` : "") +
          (months ? `; ${months}` : ""),
      );
      if (skipped > 0) {
        notes.push(`${skipped} observation${skipped === 1 ? "" : "s"} with hidden (obscured) locations ${skipped === 1 ? "was" : "were"} left out`);
      }
    }
    if (failedPage !== null) {
      notes.push(`iNaturalist page ${failedPage} failed; showing only the first ${(failedPage - 1) * PER_PAGE} observations`);
    } else if (hitPageCap && !ctx.wide) {
      // In wide mode run.ts writes the "showing the N most recent of M" note from `total`.
      notes.push(
        `Showing the ${(MAX_PAGES * PER_PAGE).toLocaleString("en-US")} most recent of ${total.toLocaleString("en-US")} observations; zoom in or narrow the dates for the rest`,
      );
    }

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      // Only when some were left unfetched: total_results also counts the obscured ones, which are never shown.
      ...(ctx.wide && (hitPageCap || failedPage !== null) && { total }),
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
      citation,
    };
  },
});

type Ctx = Parameters<typeof species.query>[0];

/** "Elk (Cervus canadensis, a species, with its subspecies)": the taxon a name was read as, in words. */
export function taxonWords(t: ResolvedTaxon): string {
  const latin = t.commonName && t.commonName.toLowerCase() !== t.name.toLowerCase() ? `${t.commonName} (${t.name})` : t.name;
  return t.rank === "species" ? `${latin} and its subspecies` : t.rank ? `${latin}, the whole ${t.rank}` : latin;
}

/** The iNaturalist id of the country under the view's centre, or undefined when the lookup fails or finds none. */
async function countryUnder(ctx: Ctx): Promise<number | undefined> {
  const cx = (ctx.bbox[0] + ctx.bbox[2]) / 2;
  const cy = (ctx.bbox[1] + ctx.bbox[3]) / 2;
  const at: BBox = [cx - 0.01, cy - 0.01, cx + 0.01, cy + 0.01];
  try {
    const res = await ctx.fetch(placesUrl(at), {
      cacheKey: ctx.cacheKey === undefined ? undefined : `inat:country:${cx.toFixed(1)},${cy.toFixed(1)}`,
      ttlSeconds: LOOKUP_TTL_SECONDS,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    return countryOf(await res.json());
  } catch {
    return undefined;
  }
}

/**
 * The one taxon `name` stands for (pickTaxon), or `taxon: null` when the lookup itself failed (the caller then matches
 * the name as text); an error the model can act on when iNaturalist knows no such name.
 */
async function resolveTaxon(ctx: Ctx, name: string, placeId: number | undefined): Promise<{ taxon: ResolvedTaxon | null; seenHere?: true } | LayerError> {
  let body: unknown;
  try {
    const res = await ctx.fetch(autocompleteUrl(lookupName(name), placeId), {
      // A name resolves the same way for every view in a country, so the key leaves out the bbox.
      cacheKey: ctx.cacheKey === undefined ? undefined : `inat:taxon:${placeId ?? "any"}:${name.toLowerCase()}`,
      ttlSeconds: LOOKUP_TTL_SECONDS,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) return { taxon: null };
    body = await res.json();
  } catch {
    return { taxon: null };
  }
  if (!autocompleteSchema.safeParse(body).success) return { taxon: null };
  const taxon = pickTaxon(lookupName(name), body);
  if (taxon === null) {
    return { error: `iNaturalist knows no species or group called "${name}"; try a common name (mule deer) or a Latin one (Odocoileus hemionus)` };
  }
  // No exact name: of the species the name could mean, the one seen most in this box ("condor" near Big Sur is the
  // California Condor, not the Andean one the autocomplete lists first).
  const candidates = speciesCandidates(lookupName(name), body);
  if (candidates.length > 1 || (candidates.length === 1 && candidates[0].id !== taxon.id)) {
    try {
      const res = await ctx.fetch(speciesCountsUrl(candidates.map((c) => c.id), ctx.bbox), {
        cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:inat-candidates:${name.toLowerCase()}`,
        ttlSeconds: LOOKUP_TTL_SECONDS,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (res.ok) {
        const counts = readSpeciesCounts(await res.json());
        const best = candidates.reduce<{ c: ResolvedTaxon; n: number } | null>((acc, c) => ((counts.get(c.id) ?? 0) > (acc?.n ?? 0) ? { c, n: counts.get(c.id) ?? 0 } : acc), null);
        if (best) return { taxon: best.c, seenHere: true };
      }
    } catch {
      // The count is a tie-breaker: without it the autocomplete's pick stands.
    }
  }
  return { taxon };
}

registerLayer(species);

export default species;
