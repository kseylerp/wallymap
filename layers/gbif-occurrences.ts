/**
 * Species occurrence records from GBIF, the Global Biodiversity Information Facility.
 * Endpoints (verified live 2026-10-09, keyless):
 *   Search:  https://api.gbif.org/v1/occurrence/search
 *     params used: geometry=POLYGON((w s,e s,e n,w n,w s)) (counter-clockwise, spaces inside, accepted URL-encoded),
 *     hasCoordinate=true, hasGeospatialIssue=false, occurrenceStatus=PRESENT, scientificName (any rank: "Felidae"
 *     matched 62 records near Tahoe, "Puma concolor" 16; unknown names return 0) or taxonKey, year=from,to (range),
 *     limit=300 (the maximum), offset. Response: { count, endOfRecords, results: [...] }, newest first in practice.
 *     Each record is large (about 8 KB with media extensions); fields read: key, species, scientificName,
 *     decimalLatitude, decimalLongitude, coordinateUncertaintyInMeters, eventDate (ISO without a zone, a date,
 *     "start/end" or partial), year, month, day, basisOfRecord ("HUMAN_OBSERVATION", "PRESERVED_SPECIMEN", ...),
 *     datasetName, references (source page), license (a creativecommons.org legalcode URL).
 *   Name lookup: https://api.gbif.org/v1/species/match?name=  -> { usageKey, canonicalName, matchType } where matchType
 *     is EXACT, FUZZY, HIGHERRANK or NONE. Density tiles need a taxonKey, so a name is resolved first.
 *   Density tiles: https://api.gbif.org/v2/map/occurrence/density/{z}/{x}/{y}@1x.png?style=purpleYellow.point
 *     &taxonKey=K&year=A,B (the layer always sends the same year window as points: explicit bounds, else the last 10 years; 256 px PNG; 200 at z0 to z14; the whole world, not limited to the bbox).
 * Notes: iNaturalist is the biggest GBIF publisher, so the species layer and this one overlap. Records with a
 * coordinate uncertainty over 5 km (usually a region centroid) are left out. GBIF limits offset+limit to 100,000;
 * this layer reads at most 2 pages (600 records), so dense places are a recent sample, and `density` gives the whole picture.
 * Smoke through runLayer (2026-10-09): Tahoe -120.4,38.7,-119.8,39.3, years 2020-2025: 572 points kept of the first 600
 * (28 vague ones dropped; 339,209 records match, so the cap note shows) in 3.5 s, 233 KB; scientificName "Puma concolor",
 * from 2000: 14 points in 0.8 s. Density with "Puma concolor" resolved to taxonKey 2435099 and returned the tile
 * template; "mountain lion" is rejected as not a scientific name.
 * Wide mode: points need a box under 50,000 km² (maxAreaKm2). Over it, with no hard cap, the layer answers with the
 * density tiles for the same name and years instead of an error: GBIF search has no sort order to rank by and records are
 * about 8 KB each, so 2,000 of them would be a 16 MB arbitrary sample. run.ts says the map is a density map.
 * Smoke wide 2026-10-14 (through runLayer): California -125,32,-114,42, scientificName "Puma concolor", points asked for, returned the
 * density tile template (taxonKey 2435099) in 0.5 s.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult, type CardSpec, type Attribute, type FieldHelp } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { jsonObjectBody } from "@/lib/fetch/validate";
import { layerColor } from "@/lib/render/palette";

const SEARCH_URL = "https://api.gbif.org/v1/occurrence/search";
const MATCH_URL = "https://api.gbif.org/v1/species/match";
const DENSITY_URL = "https://api.gbif.org/v2/map/occurrence/density/{z}/{x}/{y}@1x.png";
const DENSITY_STYLE = "purpleYellow.point";

const PAGE_SIZE = 300;
const MAX_PAGES = 2;
/** Points whose recorded position is vaguer than this are region centroids, not places. */
const MAX_UNCERTAINTY_M = 5_000;
/** Records change daily but slowly; six hours keeps repeat questions cheap. */
const CACHE_TTL_SECONDS = 6 * 3600;
/** Name matches almost never change. */
const MATCH_TTL_SECONDS = 7 * 86_400;
const DEFAULT_YEARS_BACK = 10;


const inputSchema = z.object({
  scientificName: z.string().trim().min(1).max(120).optional(),
  taxonKey: z.number().int().positive().optional(),
  yearFrom: z.number().int().min(1600).max(2100).optional(),
  yearTo: z.number().int().min(1600).max(2100).optional(),
  density: z.boolean().default(false),
});

type GbifInput = z.infer<typeof inputSchema>;

const recordSchema = z.object({
  key: z.number(),
  species: z.string().nullish(),
  scientificName: z.string().nullish(),
  decimalLatitude: z.number().nullish(),
  decimalLongitude: z.number().nullish(),
  coordinateUncertaintyInMeters: z.number().nullish(),
  eventDate: z.string().nullish(),
  year: z.number().nullish(),
  month: z.number().nullish(),
  day: z.number().nullish(),
  basisOfRecord: z.string().nullish(),
  datasetName: z.string().nullish(),
  references: z.string().nullish(),
  license: z.string().nullish(),
});

const pageSchema = z.object({
  count: z.number().optional(),
  endOfRecords: z.boolean().optional(),
  results: z.array(z.unknown()),
});

const matchSchema = z.object({
  usageKey: z.number().optional(),
  canonicalName: z.string().optional(),
  matchType: z.string().optional(),
});

function clean(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The year range to ask for: explicit bounds, else the last ten years. */
export function yearRange(input: Pick<GbifInput, "yearFrom" | "yearTo">, now: Date = new Date()): { from: number; to: number } {
  const to = input.yearTo ?? now.getUTCFullYear();
  const from = input.yearFrom ?? Math.min(to, now.getUTCFullYear() - DEFAULT_YEARS_BACK);
  return { from: Math.min(from, to), to };
}

/** GBIF counter-clockwise polygon for a bbox. */
export function bboxPolygon(bbox: BBox): string {
  const [w, s, e, n] = bbox;
  return `POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))`;
}

/** Search URL for one page of records inside a bbox. */
export function searchUrl(
  bbox: BBox,
  input: Pick<GbifInput, "scientificName" | "taxonKey" | "yearFrom" | "yearTo">,
  offset: number,
  now: Date = new Date(),
): string {
  const { from, to } = yearRange(input, now);
  const search = new URLSearchParams({
    geometry: bboxPolygon(bbox),
    hasCoordinate: "true",
    hasGeospatialIssue: "false",
    occurrenceStatus: "PRESENT",
    year: `${from},${to}`,
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (input.taxonKey !== undefined) search.set("taxonKey", String(input.taxonKey));
  else if (input.scientificName !== undefined) search.set("scientificName", input.scientificName);
  return `${SEARCH_URL}?${search.toString()}`;
}

/** Density tile template (`{z}/{x}/{y}` stay for the map to fill) for a taxon and a year range. */
export function densityTileUrl(taxonKey: number | undefined, years: { from: number; to: number }): string {
  const parts = [`style=${DENSITY_STYLE}`];
  if (taxonKey !== undefined) parts.push(`taxonKey=${taxonKey}`);
  parts.push(`year=${years.from},${years.to}`);
  return `${DENSITY_URL}?${parts.join("&")}`;
}

/** `t` from eventDate (zone-less times read as UTC, ranges use their start) or, failing that, year/month/day. */
function eventTime(eventDate: string | undefined, year: number | undefined, month: number | undefined, day: number | undefined): string | null {
  const start = eventDate?.split("/")[0];
  if (start !== undefined && /^\d{4}-\d{2}-\d{2}/.test(start)) {
    const iso = start.length === 10 ? `${start}T00:00:00Z` : /(Z|[+-]\d{2}:?\d{2})$/.test(start) ? start : `${start}Z`;
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (year !== undefined) {
    const parsed = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1));
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

/** "http://creativecommons.org/licenses/by-nc/4.0/legalcode" to "CC BY-NC 4.0"; other values pass through. */
export function shortLicense(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const cc = /creativecommons\.org\/licenses\/([a-z-]+)\/([\d.]+)/i.exec(raw);
  if (cc) return `CC ${cc[1].toUpperCase()} ${cc[2]}`;
  if (/publicdomain\/zero/i.test(raw)) return "CC0";
  return raw;
}

/**
 * Converts a search page into points with species, scientificName, basisOfRecord, dataset, year, `v` (the year),
 * `t`, url and license. Rows with no usable position or date, or an uncertainty over MAX_UNCERTAINTY_M, are left out
 * (`vague` counts the uncertain ones).
 */
export function normalizeOccurrences(json: unknown): { data: FeatureCollection<Point>; vague: number } {
  const features: Feature<Point>[] = [];
  let vague = 0;
  const page = pageSchema.safeParse(json);
  if (!page.success) return { data: { type: "FeatureCollection", features }, vague };

  for (const raw of page.data.results) {
    const parsed = recordSchema.safeParse(raw);
    if (!parsed.success) continue;
    const r = parsed.data;
    if (typeof r.decimalLatitude !== "number" || typeof r.decimalLongitude !== "number") continue;
    if (typeof r.coordinateUncertaintyInMeters === "number" && r.coordinateUncertaintyInMeters > MAX_UNCERTAINTY_M) {
      vague += 1;
      continue;
    }
    const t = eventTime(clean(r.eventDate), r.year ?? undefined, r.month ?? undefined, r.day ?? undefined);
    if (t === null) continue;

    const year = r.year ?? Number(t.slice(0, 4));
    const scientific = clean(r.species) ?? clean(r.scientificName);
    const properties: Record<string, string | number> = {
      species: scientific ?? "Unidentified",
      year,
      v: year,
      t,
      url: clean(r.references) ?? `https://www.gbif.org/occurrence/${r.key}`,
    };
    if (scientific !== undefined) properties.scientificName = scientific;
    const basis = clean(r.basisOfRecord);
    if (basis !== undefined) properties.basisOfRecord = basis.toLowerCase().replace(/_/g, " ");
    const dataset = clean(r.datasetName);
    if (dataset !== undefined) properties.dataset = dataset;
    const license = shortLicense(clean(r.license));
    if (license !== undefined) properties.license = license;
    if (typeof r.coordinateUncertaintyInMeters === "number") properties.uncertaintyM = Math.round(r.coordinateUncertaintyInMeters);

    features.push({ type: "Feature", geometry: { type: "Point", coordinates: [r.decimalLongitude, r.decimalLatitude] }, properties });
  }
  return { data: { type: "FeatureCollection", features }, vague };
}

function isTimeout(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
}

const BASIS_URL = "https://docs.gbif.org/course-data-use/en/basis-of-record.html";

/** GBIF's basisOfRecord values, as normalizeOccurrences writes them (lower case, spaces). */
const BASIS_VALUES = [
  "human observation",
  "machine observation",
  "preserved specimen",
  "living specimen",
  "fossil specimen",
  "material sample",
  "material citation",
  "observation",
  "occurrence",
];

const sentenceCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

const ATTRIBUTES: Attribute[] = [
  {
    key: "basisOfRecord",
    type: "category",
    label: "Record type",
    primary: true,
    levels: BASIS_VALUES.map((value) => ({ value, label: sentenceCase(value) })),
  },
  { key: "species", type: "category", label: "Species" },
  { key: "year", type: "time", label: "Year" },
];

const YEAR: FieldHelp = { text: "The year the organism was seen or collected, as the record gives it." };

const HELP: Record<string, FieldHelp> = {
  year: YEAR,
  v: YEAR,
  basisOfRecord: {
    text:
      "What kind of evidence the record is: a human observation (seen by a person), a machine observation (a photo, sound or camera-trap record), " +
      "a preserved specimen in a collection, a living specimen in a zoo or garden, a fossil specimen, or a citation in a publication.",
    source: "GBIF, Basis of record",
    url: BASIS_URL,
  },
  uncertaintyM: { text: "How far the true position may be from the point, as the record states (records vaguer than 5 km are left out).", unit: "m" },
  dataset: { text: "The dataset that published the record to GBIF (for example iNaturalist research-grade observations or a museum collection)." },
  license: { text: "The licence the record's publisher set; cite or link the record when showing it." },
};

const CARD: CardSpec = {
  facts: [
    // A record has no name: its species is the card's title (lib/render/inspect.ts), so neither it nor scientificName,
    // the same Latin name, is repeated as a row.
    { key: "t", label: "Date", format: "date" },
    { key: "basisOfRecord", label: "Record type", values: Object.fromEntries(BASIS_VALUES.map((v) => [v, sentenceCase(v)])) },
    { key: "dataset", label: "Dataset" },
    { key: "uncertaintyM", label: "Position uncertainty", format: "m" },
    { key: "license", label: "Licence" },
  ],
  /** ScientificName is the same Latin name as species. */
  hidden: ["scientificName", "species"],
  links: [{ key: "url", label: "Source record" }],
};

const gbifOccurrences = defineLayer({
  id: "gbif-occurrences",
  title: "GBIF occurrence records",
  description:
    "Records of where species have been seen or collected, from GBIF (the Global Biodiversity Information Facility), which pools iNaturalist, eBird, museum specimens and survey data from around the world. Each point is one record with species, scientificName, basisOfRecord (human observation, preserved specimen, machine observation...), dataset, year, v (the year), t (the date), url (the source record), license and uncertaintyM (how vague the position is, in metres). " +
    "Use it for where a species or group has been recorded, for example 'where have mountain lions been seen here', 'orchid records in this valley' or 'how has this species' range shown up over the years'. It works worldwide and goes back further than the species layer, so pick this one for older records, specimens, or places outside iNaturalist's reach; use species for recent photo sightings with common names. " +
    "Set scientificName to a Latin name at any level, such as 'Puma concolor', 'Pandion haliaetus' or a family like 'Felidae' (common names like 'mountain lion' do not work, so translate first), or taxonKey if you have a GBIF key. Leave both out for all species. " +
    "yearFrom and yearTo set the years (default: the last 10 years). " +
    "Set density to true to get a world-wide map of record density (map tiles, not countable points) instead of points; it works at any size of region, shows where the data is thickest, and respects scientificName, taxonKey and the year range (the same default of the last 10 years as points). " +
    "Caveats: records show where people and institutions looked, not where animals are: roads, trails, towns and parks look busy and remote land looks empty, and absence of points is not absence of the species. " +
    "The position of some records is deliberately blurred or vague; records vaguer than 5 km are left out, and threatened species are often generalised. " +
    "Points come back roughly newest first (GBIF's own order), at most 600 per request, and the result says when it trims, so narrow the years or name, zoom in, or switch to density for the full picture. Dense places can have tens of thousands of records. " +
    "Over 50,000 km² (about a 220 km square) points come back as the density map instead.",
  coverage: "global",
  surface: "any",
  license: "CC0 / CC BY / CC BY-NC per record (GBIF)",
  requiredEnv: [],
  maxAreaKm2: 50_000,
  // Density tiles cover the world, so there is no hard cap.
  hardMaxAreaKm2: Number.POSITIVE_INFINITY,
  wide: { mode: "tiles", limit: 0 },
  input: inputSchema,
  style: {
    geometry: "point",
    color: layerColor("gbif-occurrences"),
    heat: true,
    cluster: true,
  },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const now = new Date();
    const citation = {
      source: "GBIF.org occurrence records (CC0, CC BY or CC BY-NC per record)",
      url: "https://www.gbif.org/",
      retrieved: now.toISOString(),
    };

    // Over 50,000 km² points switch to the density map rather than erroring.
    if (input.density || ctx.wide) {
      let taxonKey = input.taxonKey;
      if (taxonKey === undefined && input.scientificName !== undefined) {
        const matched = await resolveTaxon(ctx, input.scientificName);
        if ("error" in matched) return matched;
        taxonKey = matched.key;
      }
      return {
        kind: "tiles",
        data: {
          url: densityTileUrl(taxonKey, yearRange(input, now)),
          minzoom: 0,
          maxzoom: 14,
          format: "raster",
          tileSize: 256,
        },
        citation,
      };
    }

    const features: Feature<Point>[] = [];
    let vague = 0;
    let total = 0;
    let more = false;
    let failedPage: number | null = null;

    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
      let body: unknown;
      try {
        const res = await ctx.fetch(searchUrl(ctx.bbox, input, (pageNo - 1) * PAGE_SIZE, now), {
          cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:gbif-p${pageNo}`,
          ttlSeconds: CACHE_TTL_SECONDS,
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        if (!res.ok) {
          if (pageNo === 1) return { error: `GBIF returned ${res.status}`, hint: "upstream" };
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
            ? `GBIF timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds`
            : "GBIF returned no response",
          hint: "upstream",
        };
      }

      const parsed = pageSchema.safeParse(body);
      if (!parsed.success) {
        if (pageNo === 1) return { error: "GBIF returned an unexpected response", hint: "upstream" };
        failedPage = pageNo;
        break;
      }
      const normalized = normalizeOccurrences(body);
      features.push(...normalized.data.features);
      vague += normalized.vague;
      total = parsed.data.count ?? total;

      if (parsed.data.endOfRecords === true || parsed.data.results.length < PAGE_SIZE) break;
      if (pageNo === MAX_PAGES) more = true;
    }

    const notes: string[] = [];
    if (vague > 0) {
      notes.push(`${vague} record${vague === 1 ? "" : "s"} with a position vaguer than 5 km ${vague === 1 ? "was" : "were"} left out`);
    }
    if (failedPage !== null) {
      notes.push(`GBIF page ${failedPage} failed; showing only the first ${(failedPage - 1) * PAGE_SIZE} records`);
    } else if (more) {
      notes.push(
        `Showing the first ${(MAX_PAGES * PAGE_SIZE).toLocaleString("en-US")} of ${total.toLocaleString("en-US")} records; narrow the years or name, zoom in, or use density for the rest`,
      );
    }

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
      citation,
    };
  },
});

/** GBIF taxon key for a name, or an error the model can act on. */
async function resolveTaxon(
  ctx: Parameters<typeof gbifOccurrences.query>[0],
  name: string,
): Promise<{ key: number } | LayerError> {
  try {
    const res = await ctx.fetch(`${MATCH_URL}?${new URLSearchParams({ name, verbose: "false" }).toString()}`, {
      // A name resolves the same way for every view, so the key leaves out the bbox.
      cacheKey: ctx.cacheKey === undefined ? undefined : `gbif:match:${name.toLowerCase()}`,
      ttlSeconds: MATCH_TTL_SECONDS,
      validate: jsonObjectBody(),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) return { error: `GBIF returned ${res.status}`, hint: "upstream" };
    const parsed = matchSchema.safeParse(await res.json());
    if (!parsed.success) return { error: "GBIF returned an unexpected response", hint: "upstream" };
    const { usageKey, matchType } = parsed.data;
    if (usageKey === undefined || (matchType !== "EXACT" && matchType !== "FUZZY")) {
      return { error: `GBIF does not recognise "${name}" as a scientific name; use the Latin name (for example Puma concolor)` };
    }
    return { key: usageKey };
  } catch (err) {
    return {
      error: isTimeout(err) ? `GBIF timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds` : "GBIF returned no response",
      hint: "upstream",
    };
  }
}

registerLayer(gbifOccurrences);

export default gbifOccurrences;
