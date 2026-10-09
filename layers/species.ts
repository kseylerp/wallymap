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
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";

const ENDPOINT = "https://api.inaturalist.org/v1/observations";
const PER_PAGE = 200;
const MAX_PAGES = 3;
const PAGE_SPACING_MS = 600;
const MS_PER_DAY = 86_400_000;
/** Search results change slowly; six hours keeps repeat questions cheap without hiding new sightings for long. */
const CACHE_TTL_SECONDS = 6 * 3600;

const inputSchema = z.object({
  taxon: z.string().trim().min(1).optional(),
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

/** Request URL for one page; `now` is injected so the date maths is testable. */
export function observationsUrl(
  bbox: BBox,
  input: Pick<SpeciesInput, "days" | "taxon" | "researchGradeOnly">,
  pageNo: number,
  now: Date,
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
  return `${ENDPOINT}?${search.toString()}`;
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
    "At most 600 of the most recent sightings are returned (3 pages of 200) and the result says so when it trims, so narrow the dates or taxon, or zoom in, for the rest. " +
    "Zoom in to a region under 50,000 km² (about a 220 km square) first.",
  coverage: "global",
  license: "CC BY-NC / CC0 per observation (iNaturalist)",
  requiredEnv: [],
  maxAreaKm2: 50_000,
  input: inputSchema,
  style: { geometry: "point", color: "#5E7D5A" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const area = bboxAreaKm2(ctx.bbox);
    if (area > species.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${species.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    const now = new Date();
    const features: Feature<Point>[] = [];
    let skipped = 0;
    let total = 0;
    let hitPageCap = false;
    let failedPage: number | null = null;

    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
      if (pageNo > 1) await sleep(PAGE_SPACING_MS);

      let body: unknown;
      try {
        const res = await ctx.fetch(observationsUrl(ctx.bbox, input, pageNo, now), {
          cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:inat-p${pageNo}`,
          ttlSeconds: CACHE_TTL_SECONDS,
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        if (!res.ok) {
          if (pageNo === 1) return { error: `iNaturalist returned ${res.status}`, hint: "upstream" };
          failedPage = pageNo;
          break;
        }
        body = await res.json();
      } catch (err) {
        if (pageNo > 1) {
          failedPage = pageNo;
          break;
        }
        return {
          error: isTimeout(err)
            ? `iNaturalist timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds`
            : "iNaturalist returned no response",
          hint: "upstream",
        };
      }

      const parsed = pageSchema.safeParse(body);
      if (!parsed.success) {
        if (pageNo === 1) return { error: "iNaturalist returned an unexpected response", hint: "upstream" };
        failedPage = pageNo;
        break;
      }
      const normalized = normalizeObservations(body);
      features.push(...normalized.data.features);
      skipped += normalized.skipped;
      total = parsed.data.total_results ?? total;

      const fetched = pageNo * PER_PAGE;
      if (parsed.data.results.length < PER_PAGE || fetched >= total) break;
      if (pageNo === MAX_PAGES) hitPageCap = true;
    }

    const notes: string[] = [];
    if (skipped > 0) {
      notes.push(
        `${skipped} observation${skipped === 1 ? "" : "s"} with hidden (obscured) locations ${skipped === 1 ? "was" : "were"} left out`,
      );
    }
    if (failedPage !== null) {
      notes.push(`iNaturalist page ${failedPage} failed; showing only the first ${(failedPage - 1) * PER_PAGE} observations`);
    } else if (hitPageCap) {
      notes.push(
        `Showing the ${(MAX_PAGES * PER_PAGE).toLocaleString("en-US")} most recent of ${total.toLocaleString("en-US")} observations; zoom in or narrow the dates for the rest`,
      );
    }

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
      citation: {
        source: "iNaturalist observations (CC BY-NC / CC0 per observation)",
        url: "https://www.inaturalist.org/",
        retrieved: now.toISOString(),
      },
    };
  },
});

registerLayer(species);

export default species;
