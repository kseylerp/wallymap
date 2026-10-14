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
 * Wide mode (over 50,000 km², up to the default hard cap of 200,000 km²):
 *   - with a taxon, the 2,000 most recent observations (10 pages, same 600 ms spacing) and total_results as the total, so a
 *     filtered question keeps its filter;
 *   - with no taxon, a density map instead of points: GBIF density tiles of the iNaturalist Research-grade Observations
 *     dataset (datasetKey 50c9509d-22c7-4a22-a47d-8c48425ef4a7, the copy iNaturalist shares with GBIF weekly), whole years
 *     covering `days`. Unconfirmed observations are not in that dataset, which the note says when researchGradeOnly is off.
 * Smoke wide 2026-10-14 (through runLayer), box -123,37,-120,40 (about 88,000 km²), 365 days: taxon "birds" returned the 1,857 most recent
 *   of 26,626 in 14.4 s (591 KB; 143 obscured left out); "mule deer" all 1,655 in 7.1 s; no taxon the density tiles in 0.0 s. Before the
 *   v2 `fields` request and the overlapped pages, the "mule deer" fetch took 35.6 s (v1 pages were about 14 MB each).
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { layerColor } from "@/lib/render/palette";

const ENDPOINT = "https://api.inaturalist.org/v1/observations";
/**
 * The v2 endpoint takes the same parameters plus `fields`, which cuts a 200-row page from about 14 MB to 85 KB; a wide
 * fetch of ten pages uses it.
 */
const ENDPOINT_V2 = "https://api.inaturalist.org/v2/observations";
const V2_FIELDS = "id,uri,observed_on,time_observed_at,obscured,license_code,species_guess,geojson,taxon.name,taxon.preferred_common_name";
const PER_PAGE = 200;
const MAX_PAGES = 3;
/** Most observations a wide result with a taxon carries, the most recent: 10 pages. */
const WIDE_LIMIT = 2_000;
/** GBIF density tiles, used for a wide view with no taxon. */
const DENSITY_URL = "https://api.gbif.org/v2/map/occurrence/density/{z}/{x}/{y}@1x.png";
/** GBIF's copy of iNaturalist research-grade observations. */
export const INAT_GBIF_DATASET = "50c9509d-22c7-4a22-a47d-8c48425ef4a7";
const PAGE_SPACING_MS = 600;
const MS_PER_DAY = 86_400_000;
/** Search results change slowly; six hours keeps repeat questions cheap without hiding new sightings for long. */
const CACHE_TTL_SECONDS = 6 * 3600;

const inputSchema = z.object({
  taxon: z.string().trim().min(1).max(120).optional(),
  days: z.number().int().min(1).max(3650).default(365),
  researchGradeOnly: z.boolean().default(true),
});

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
      name: z.string().nullish(),
      preferred_common_name: z.string().nullish(),
    })
    .nullish(),
});

const pageSchema = z.object({
  total_results: z.number().optional(),
  results: z.array(z.unknown()),
});

/** Request URL for one page; `now` is injected so the date maths is testable. `slim` asks v2 for only the fields read. */
export function observationsUrl(
  bbox: BBox,
  input: Pick<SpeciesInput, "days" | "taxon" | "researchGradeOnly">,
  pageNo: number,
  now: Date,
  slim = false,
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
  if (input.taxon !== undefined) search.set("taxon_name", input.taxon);
  if (slim) search.set("fields", V2_FIELDS);
  return `${slim ? ENDPOINT_V2 : ENDPOINT}?${search.toString()}`;
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
 * date or id are dropped silently.
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
    const species = clean(obs.taxon?.preferred_common_name) ?? scientific ?? clean(obs.species_guess) ?? "Unidentified";
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

    features.push({ type: "Feature", geometry: { type: "Point", coordinates: obs.geojson.coordinates }, properties });
  }
  return { data: { type: "FeatureCollection", features }, skipped };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTimeout(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
}

const species = defineLayer({
  id: "species",
  title: "Species sightings",
  description:
    "Wildlife and plant sightings that people logged on iNaturalist: each point is one observation with species (common name, or scientific if none), scientificName, observedOn (date), t (when it was seen) and url (the observation page). " +
    "v is always 1 (one sighting), so density shows where people see things. Each point also has license (the photographer's licence, such as cc-by-nc or cc0; cite or link the url when showing it). " +
    "Use it to answer what lives or flowers somewhere, or where to look for a kind of animal or plant. " +
    "Set taxon to a name to filter, for example 'birds', 'mule deer' or 'Pandion haliaetus'; a group name such as 'birds' includes every bird in it, and plain common names work best (a bare class name like 'Aves' matched far fewer sightings when tested). Leave it out for all species. " +
    "days (1 to 3650, default 365) sets how far back to look; researchGradeOnly (default true) keeps only observations the community has confirmed to species level, so turn it off to include unconfirmed ones. " +
    "Caveats: this reflects where people go and post, not where animals are, so trails, roads and towns look busy and remote areas look empty; absence of points is not absence of the species. " +
    "Sightings of threatened species and ones whose observer hid their location are left out (the result says how many), so rare animals are under-counted. " +
    "At most 600 of the most recent sightings are returned (3 pages of 200). " +
    "Over 50,000 km² (about a 220 km square) it returns the 2,000 most recent with a taxon, or a density map without one.",
  coverage: "global",
  license: "CC BY-NC / CC0 per observation (iNaturalist)",
  requiredEnv: [],
  maxAreaKm2: 50_000,
  wide: { orderBy: "date observed", rank: "most recent", limit: WIDE_LIMIT },
  input: inputSchema,
  style: { geometry: "point", color: layerColor("species") },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const now = new Date();
    const citation = {
      source: "iNaturalist observations (CC BY-NC / CC0 per observation)",
      url: "https://www.inaturalist.org/",
      retrieved: now.toISOString(),
    };

    // Wide with no taxon: a density map of every sighting, since 2,000 unfiltered points would be a meaningless sample.
    if (ctx.wide && input.taxon === undefined) {
      const notes = [`iNaturalist research-grade observations as shared with GBIF, whole years from ${new Date(now.getTime() - input.days * MS_PER_DAY).getUTCFullYear()}`];
      if (!input.researchGradeOnly) notes.push("unconfirmed observations are not in this map");
      return {
        kind: "tiles",
        data: { url: inatDensityUrl(input.days, now), minzoom: 0, maxzoom: 14, format: "raster", tileSize: 256 },
        citation: { ...citation, source: "iNaturalist Research-grade Observations via GBIF.org (density map)" },
        coverageNote: notes.join("; "),
      };
    }
    // Wide with a taxon: the most recent sightings up to the strategy's limit.
    const maxPages = ctx.wide ? Math.ceil(Math.min(WIDE_LIMIT, ctx.wideStrategy?.limit ?? WIDE_LIMIT) / PER_PAGE) : MAX_PAGES;

    type Page = { ok: true; body: unknown; results: number; total: number | undefined } | { ok: false; error: LayerError };
    const getPage = async (pageNo: number): Promise<Page> => {
      let body: unknown;
      try {
        const res = await ctx.fetch(observationsUrl(ctx.bbox, input, pageNo, now, ctx.wide === true), {
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
      if (ctx.wide) {
        // Ten sequential pages took 36 s, so a wide fetch starts the rest 600 ms apart (the same request rate) without
        // waiting for each answer.
        const rest = Array.from({ length: Math.max(0, needed - 1) }, (_, i) =>
          sleep(PAGE_SPACING_MS * (i + 1)).then(() => getPage(i + 2)),
        );
        pages.push(...(await Promise.all(rest)));
      } else {
        for (let pageNo = 2; pageNo <= needed; pageNo++) {
          await sleep(PAGE_SPACING_MS);
          const page = await getPage(pageNo);
          pages.push(page);
          if (!page.ok || page.results < PER_PAGE) break;
        }
      }
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

    const notes: string[] = [];
    if (skipped > 0) {
      notes.push(
        `${skipped} observation${skipped === 1 ? "" : "s"} with hidden (obscured) locations ${skipped === 1 ? "was" : "were"} left out`,
      );
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

registerLayer(species);

export default species;
