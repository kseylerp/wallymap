/**
 * Photo density from Wikimedia Commons geotagged files and Mapillary street-level images.
 *
 * Commons: https://commons.wikimedia.org/w/api.php?action=query&list=geosearch&gsbbox=<north>|<west>|<south>|<east>
 *   &gsnamespace=6&gslimit=500&format=json&origin=*   (gsbbox order is top|left|bottom|right)
 *   Response: { query: { geosearch: [{ pageid, ns, title: "File:...", lat, lon, dist, primary }] }, continue?: { gscontinue, continue } }.
 *   Verified 2026-10-09: results carry no date; gslimit max is 500; HTTP 200 with { error: { code, info } } on
 *   failure ("toobig" when the box is larger than roughly 25 km across, "cirrussearch-too-busy-error" transiently);
 *   Wikimedia returns 429 to requests without a descriptive User-Agent or that arrive too fast; the API gave no
 *   `continue` even when gslimit=3 cut the list, so continuation is handled defensively (once per square).
 *
 * Mapillary: https://graph.mapillary.com/images?access_token=<t>&bbox=<west>,<south>,<east>,<north>&fields=id,captured_at,geometry&limit=2000
 *   Response: { data: [{ id, captured_at (ms since epoch), geometry: { type: "Point", coordinates: [lon, lat] } }] }.
 *   Verified 2026-10-09: bbox area must be under 0.01 square degrees (HTTP 500, code 100 otherwise), and in dense
 *   places a 0.0064 square degree box fails with 500 "Please reduce the amount of data you're asking for" whatever
 *   the limit; 0.0004 square degrees returned 1,939 images (limit 2000) in 4.7 s. So the view is cut into
 *   0.05 degree squares and only the 8 nearest the centre are asked for.
 *
 * Both APIs limit how big one request may be, so the bbox is cut into squares (Commons ~15 km, Mapillary 0.05 degrees).
 *
 * Wide mode (over 2,500 km², up to the default hard cap of 10,000 km²): geosearch has no popularity order and Mapillary only
 * answers tiny squares, so the layer asks Wikidata (https://query.wikidata.org/sparql) for the items in the box that have a
 * Commons photo (P18), ranked by how many Wikipedia language editions cover them (wikibase:sitelinks), the best-known 500,
 * box first (optimizer hint). Each point is that place's photo. This is a different picture from photo density, which the
 * note says; Mapillary is left out.
 * Smoke wide 2026-10-14 (through runLayer): Yosemite -120,37.5,-119.3,38.05 (about 3,700 km²) returned all 263 places in 5.4 s, Yosemite
 *   National Park first. A Paris box 1.8,48.4,3.2,49.2 (about 9,100 km², near the cap and as dense as Wikidata gets) took 6.5 s, 16.7 s
 *   and twice over 25 s (a timeout) on different tries that day, so dense capital-city boxes near the cap can fail on a cold cache.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { defineLayer, type Attribute, type BBox, type LayerError, type LayerResult, type QueryContext } from "./types";
import { nameAttribute, timeAttribute } from "./_shared/bands";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { rankedSparql, wikimediaFetch } from "./_shared/wikimedia";
import { layerColor } from "@/lib/render/palette";

const SOURCES = ["commons", "mapillary"] as const;
type Source = (typeof SOURCES)[number];

const inputSchema = z.object({
  sources: z
    .array(z.enum(SOURCES))
    .min(1)
    .default([...SOURCES]),
});

const COMMONS_ENDPOINT = "https://commons.wikimedia.org/w/api.php";
const COMMONS_USER_AGENT = "WildMap/0.1 (open-source outdoor map agent)";
const COMMONS_LIMIT = 500;
const COMMONS_CELL_KM = 15;
const COMMONS_MAX_CELLS = 30;

const MAPILLARY_ENDPOINT = "https://graph.mapillary.com/images";
const MAPILLARY_LIMIT = 2000;
/** A cell this full is treated as capped (a dense cell returned 1,939 for limit 2000). */
const MAPILLARY_CAPPED_AT = 1900;
export const MAPILLARY_CELL_DEG = 0.05;
export const MAPILLARY_MAX_CELLS = 8;
const MAPILLARY_TTL_SECONDS = 86_400;

const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
/** Most places a wide result carries, the best-known. */
const WIDE_LIMIT = 500;
const WIDE_NOTE = "over 2,500 km² this shows the best-known places that have a Commons photo, not where photos were taken";

/** Requests in flight at once; the layer's rate limiter queues anything beyond its burst. */
const CONCURRENCY = 4;
const MAX_POINTS = 5_000;

const KM_PER_DEG_LAT = 110.57;
const KM_PER_DEG_LON_EQUATOR = 111.32;

/** Splits `bbox` into squares no wider than `maxLon` and no taller than `maxLat` degrees. */
export function tileBBox(bbox: BBox, maxLon: number, maxLat: number): BBox[] {
  const [west, south, east, north] = bbox;
  const cols = Math.max(1, Math.ceil((east - west) / maxLon - 1e-9));
  const rows = Math.max(1, Math.ceil((north - south) / maxLat - 1e-9));
  const width = (east - west) / cols;
  const height = (north - south) / rows;
  const cells: BBox[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push([west + c * width, south + r * height, west + (c + 1) * width, south + (r + 1) * height]);
    }
  }
  return cells;
}

/** Keeps the `max` cells whose centres are nearest the middle of `bbox`. */
function nearestCells(cells: BBox[], bbox: BBox, max: number): BBox[] {
  if (cells.length <= max) return cells;
  const cx = (bbox[0] + bbox[2]) / 2;
  const cy = (bbox[1] + bbox[3]) / 2;
  const dist = (cell: BBox) => ((cell[0] + cell[2]) / 2 - cx) ** 2 + ((cell[1] + cell[3]) / 2 - cy) ** 2;
  return [...cells].sort((a, b) => dist(a) - dist(b)).slice(0, max);
}

function commonsCells(bbox: BBox): BBox[] {
  const midLatRad = (((bbox[1] + bbox[3]) / 2) * Math.PI) / 180;
  const lonStep = COMMONS_CELL_KM / (KM_PER_DEG_LON_EQUATOR * Math.max(Math.cos(midLatRad), 0.1));
  const latStep = COMMONS_CELL_KM / KM_PER_DEG_LAT;
  return tileBBox(bbox, lonStep, latStep);
}

function mapillaryCells(bbox: BBox): BBox[] {
  return tileBBox(bbox, MAPILLARY_CELL_DEG, MAPILLARY_CELL_DEG);
}

/** Commons geosearch URL; gsbbox order is north|west|south|east (top|left|bottom|right). */
export function commonsUrl(bbox: BBox, continuation?: { gscontinue: string; continue: string }): string {
  const [west, south, east, north] = bbox;
  let url =
    `${COMMONS_ENDPOINT}?action=query&list=geosearch&gsbbox=${north}|${west}|${south}|${east}` +
    `&gsnamespace=6&gslimit=${COMMONS_LIMIT}&format=json&origin=*`;
  if (continuation) {
    url += `&gscontinue=${encodeURIComponent(continuation.gscontinue)}&continue=${encodeURIComponent(continuation.continue)}`;
  }
  return url;
}

/** Mapillary images URL; bbox order is west,south,east,north. Contains the token, so never log or cache by it. */
export function mapillaryUrl(bbox: BBox, token: string): string {
  const [west, south, east, north] = bbox;
  return (
    `${MAPILLARY_ENDPOINT}?access_token=${encodeURIComponent(token)}&bbox=${west},${south},${east},${north}` +
    `&fields=id,captured_at,geometry&limit=${MAPILLARY_LIMIT}`
  );
}

const commonsPageSchema = z.object({
  query: z
    .object({
      geosearch: z.array(
        z.object({
          pageid: z.number(),
          title: z.string(),
          lat: z.number(),
          lon: z.number(),
        }),
      ),
    })
    .optional(),
  continue: z.object({ gscontinue: z.string(), continue: z.string() }).partial().optional(),
  error: z.object({ code: z.string().optional(), info: z.string().optional() }).optional(),
});

const mapillaryPageSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      captured_at: z.number().optional(),
      geometry: z.object({ type: z.literal("Point"), coordinates: z.tuple([z.number(), z.number()]) }).optional(),
    }),
  ),
});

type PhotoFeature = Feature<Point>;

/** Wide-mode SPARQL: items in the box with a Commons photo, the `limit` covered by the most Wikipedia language editions. */
export function widePhotosQuery(bbox: BBox, limit: number): string {
  const [west, south, east, north] = bbox;
  return rankedSparql(
    `SELECT ?item ?itemLabel ?links ?coord ?image WHERE {
  {
    SELECT ?item ?links (SAMPLE(?c) AS ?coord) (SAMPLE(?img) AS ?image) WHERE {
      hint:Query hint:optimizer "None" .
      SERVICE wikibase:box {
        ?item wdt:P625 ?c .
        bd:serviceParam wikibase:cornerSouthWest "Point(${west} ${south})"^^geo:wktLiteral .
        bd:serviceParam wikibase:cornerNorthEast "Point(${east} ${north})"^^geo:wktLiteral .
      }
      ?item wikibase:sitelinks ?links .
      ?item wdt:P18 ?img .
    }
    GROUP BY ?item ?links
    ORDER BY DESC(?links)
    LIMIT ${limit}
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
}`,
    limit,
    "links",
  );
}

const wideSchema = z.object({
  results: z.object({
    bindings: z.array(
      z.object({
        item: z.object({ value: z.string() }),
        itemLabel: z.object({ value: z.string() }).optional(),
        links: z.object({ value: z.string() }).optional(),
        coord: z.object({ value: z.string() }),
        image: z.object({ value: z.string() }),
      }),
    ),
  }),
});

/**
 * Wide points: one per place, at its coordinate, with source "commons", title (the photo's file name), name (the place),
 * url (the file page), languages (Wikipedia editions covering the place), wikidata and v 1. Null when the answer is malformed.
 */
export function widePhotoFeatures(json: unknown): PhotoFeature[] | null {
  const parsed = wideSchema.safeParse(json);
  if (!parsed.success) return null;
  const features: PhotoFeature[] = [];
  for (const b of parsed.data.results.bindings) {
    const m = /^Point\(\s*(-?[\d.]+(?:e-?\d+)?)\s+(-?[\d.]+(?:e-?\d+)?)\s*\)$/i.exec(b.coord.value.trim());
    if (!m) continue;
    let file: string;
    try {
      file = decodeURIComponent(b.image.value.split("/").pop() ?? "");
    } catch {
      continue;
    }
    if (file === "") continue;
    const id = b.item.value.split("/").pop() ?? b.item.value;
    const label = b.itemLabel?.value.trim();
    const properties: Record<string, string | number> = {
      source: "commons",
      title: file,
      v: 1,
      url: `https://commons.wikimedia.org/wiki/${encodeURIComponent(`File:${file}`.replace(/ /g, "_")).replace(/%3A/g, ":")}`,
      wikidata: id,
    };
    if (label && label !== id) properties.name = label;
    const links = Number(b.links?.value);
    if (Number.isFinite(links)) properties.languages = links;
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: [Number(m[1]), Number(m[2])] }, properties });
  }
  return features;
}

function commonsFeature(hit: { pageid: number; title: string; lat: number; lon: number }): PhotoFeature {
  const title = hit.title.replace(/^File:/, "");
  const wikiTitle = encodeURIComponent(hit.title.replace(/ /g, "_")).replace(/%3A/g, ":");
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [hit.lon, hit.lat] },
    properties: {
      source: "commons",
      title,
      v: 1,
      url: `https://commons.wikimedia.org/wiki/${wikiTitle}`,
    },
  };
}

function mapillaryFeature(image: z.infer<typeof mapillaryPageSchema>["data"][number]): PhotoFeature | null {
  if (!image.geometry) return null;
  const properties: Record<string, string | number> = {
    source: "mapillary",
    v: 1,
    url: `https://www.mapillary.com/app/?pKey=${image.id}`,
  };
  if (image.captured_at !== undefined) {
    const t = new Date(image.captured_at);
    if (!Number.isNaN(t.getTime())) properties.t = t.toISOString();
  }
  return { type: "Feature", geometry: { type: "Point", coordinates: image.geometry.coordinates }, properties };
}

type CellOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

function isTimeout(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
}

function failure(err: unknown, who: string): string {
  return isTimeout(err) ? `${who} timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds` : `${who} returned no response`;
}

/** Runs `worker` over `items` with at most `limit` in flight, keeping result order. */
async function pool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  async function lane(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

type CommonsCell = { features: Map<number, PhotoFeature>; capped: boolean };

async function fetchCommonsCell(ctx: QueryContext, cell: BBox): Promise<CellOutcome<CommonsCell>> {
  const features = new Map<number, PhotoFeature>();
  let capped = false;
  let continuation: { gscontinue: string; continue: string } | undefined;
  const base = `${ctx.cacheKey ?? "photos"}:commons:${cell.join(",")}`;

  // One request, plus at most one continuation.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await ctx.fetch(commonsUrl(cell, continuation), {
        cacheKey: attempt === 0 ? base : `${base}:more`,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        headers: { "user-agent": COMMONS_USER_AGENT },
      });
      if (!res.ok) return { ok: false, error: `Wikimedia Commons returned ${res.status}` };
      const parsed = commonsPageSchema.safeParse(await res.json());
      if (!parsed.success) return { ok: false, error: "Wikimedia Commons returned an unexpected response" };
      if (parsed.data.error) {
        return { ok: false, error: `Wikimedia Commons error: ${parsed.data.error.code ?? "unknown"}` };
      }
      const hits = parsed.data.query?.geosearch ?? [];
      for (const hit of hits) features.set(hit.pageid, commonsFeature(hit));
      if (hits.length >= COMMONS_LIMIT) capped = true;

      const more = parsed.data.continue;
      if (attempt === 0 && more?.gscontinue !== undefined && more.continue !== undefined) {
        continuation = { gscontinue: more.gscontinue, continue: more.continue };
        continue;
      }
      break;
    } catch (err) {
      // Keep what the first request returned when only the continuation failed.
      if (attempt === 1) break;
      return { ok: false, error: failure(err, "Wikimedia Commons") };
    }
  }
  return { ok: true, value: { features, capped } };
}

type MapillaryCell = { features: Map<string, PhotoFeature>; capped: boolean };

async function fetchMapillaryCell(ctx: QueryContext, cell: BBox, token: string): Promise<CellOutcome<MapillaryCell>> {
  try {
    const res = await ctx.fetch(mapillaryUrl(cell, token), {
      // An explicit key keeps the token (which is in the URL) out of the cache key.
      cacheKey: `${ctx.cacheKey ?? "photos"}:mapillary:${cell.join(",")}`,
      ttlSeconds: MAPILLARY_TTL_SECONDS,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    // Never include the URL (it carries the token) in an error message.
    if (!res.ok) return { ok: false, error: `Mapillary returned ${res.status}` };
    const parsed = mapillaryPageSchema.safeParse(await res.json());
    if (!parsed.success) return { ok: false, error: "Mapillary returned an unexpected response" };
    const features = new Map<string, PhotoFeature>();
    for (const image of parsed.data.data) {
      const feature = mapillaryFeature(image);
      if (feature) features.set(image.id, feature);
    }
    return { ok: true, value: { features, capped: parsed.data.data.length >= MAPILLARY_CAPPED_AT } };
  } catch (err) {
    return { ok: false, error: failure(err, "Mapillary") };
  }
}

/** Evenly spaced `keep` items, so thinning keeps the spatial pattern. */
function thin<T>(items: T[], keep: number): T[] {
  if (items.length <= keep) return items;
  return Array.from({ length: keep }, (_, i) => items[Math.floor((i * items.length) / keep)]);
}

const NO_TOKEN_NOTE = "Mapillary was skipped because no MAPILLARY_TOKEN is configured, so only Wikimedia Commons photos are shown";

const ATTRIBUTES: Attribute[] = [
  {
    key: "source",
    type: "category",
    label: "Source",
    levels: [
      { value: "commons", label: "Wikimedia Commons" },
      { value: "mapillary", label: "Mapillary" },
    ],
  },
  timeAttribute("Taken"),
  nameAttribute("Title", "title"),
];

const photos = defineLayer({
  id: "photos",
  title: "Photo density",
  description:
    "Where people have taken and shared geotagged photos: Wikimedia Commons files and Mapillary street-level images. Each point is one photo with source ('commons' or 'mapillary'), url (the photo page), v (always 1, so it draws as density), " +
    "title (Commons only, the file name) and t (when it was taken, Mapillary only; Commons files have no date here). " +
    "Use it to find scenic spots, popular viewpoints, trails and roads that have been photographed, or to judge how well-documented a place is. " +
    "Pick sources with sources: ['commons'], ['mapillary'] or both (default). Mapillary needs a free token; when it is not configured the layer still returns Commons photos and says Mapillary was skipped. " +
    "Caveats: this shows where people photograph, not what is there; roads and towns dominate Mapillary because it is mostly dashcam and phone capture, and remote trails often have none. " +
    "Photo licences differ (Commons files are free licences, Mapillary images are CC BY-SA 4.0); link the url rather than reusing the image. " +
    "The two services limit how much one request can cover, so large views are cut into squares: Commons is asked for every square (up to 500 photos each), but Mapillary only for the 8 small squares (about 5 km across) nearest the centre, " +
    "and very busy squares are capped (Mapillary at about 2,000 images), so counts in dense areas are lower bounds. " +
    "At most 5,000 points are returned (evenly thinned). For Mapillary, zoom in to a few square kilometres in a city. " +
    "Over 2,500 km² (about a 50 km square) it returns photos of the 500 best-known places, Commons only.",
  coverage: "global",
  surface: "any",
  license: "Wikimedia Commons (various free licenses); Mapillary (CC BY-SA 4.0)",
  requiredEnv: [],
  optionalEnv: ["MAPILLARY_TOKEN"],
  maxAreaKm2: 2_500,
  wide: { mode: "named", orderBy: "number of Wikipedia languages", limit: WIDE_LIMIT },
  input: inputSchema,
  style: { geometry: "point", color: layerColor("photos") },
  attributes: ATTRIBUTES,

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const wanted = new Set<Source>(input.sources);
    const token = ctx.env.MAPILLARY_TOKEN?.trim() ?? "";
    const useMapillary = wanted.has("mapillary") && token !== "";
    const useCommons = wanted.has("commons");
    const notes: string[] = [];

    if (wanted.has("mapillary") && token === "") {
      if (!useCommons) {
        return { error: "Mapillary needs MAPILLARY_TOKEN; ask for sources ['commons'] instead", hint: "unavailable" };
      }
      notes.push(NO_TOKEN_NOTE);
    }

    if (ctx.wide) {
      if (!useCommons) {
        return { error: "Mapillary images load only for small areas; zoom in under 2,500 km², or ask for sources ['commons']", hint: "zoom_in" };
      }
      return widePhotos(ctx, useMapillary ? [...notes, "Mapillary is left out at this scale"] : notes);
    }

    const errors: string[] = [];
    let commons: PhotoFeature[] = [];
    let mapillary: PhotoFeature[] = [];

    const [commonsRun, mapillaryRun] = await Promise.all([
      (async () => {
        if (!useCommons) return null;
        const all = commonsCells(ctx.bbox);
        const cells = nearestCells(all, ctx.bbox, COMMONS_MAX_CELLS);
        const outcomes = await pool(cells, CONCURRENCY, (cell) => fetchCommonsCell(ctx, cell));
        return { total: all.length, used: cells.length, outcomes };
      })(),
      (async () => {
        if (!useMapillary) return null;
        const all = mapillaryCells(ctx.bbox);
        const cells = nearestCells(all, ctx.bbox, MAPILLARY_MAX_CELLS);
        const outcomes = await pool(cells, CONCURRENCY, (cell) => fetchMapillaryCell(ctx, cell, token));
        return { total: all.length, used: cells.length, outcomes };
      })(),
    ]);

    if (commonsRun) {
      const merged = new Map<number, PhotoFeature>();
      let failed = 0;
      let capped = 0;
      for (const o of commonsRun.outcomes) {
        if (!o.ok) {
          failed += 1;
          errors.push(o.error);
          continue;
        }
        for (const [id, f] of o.value.features) merged.set(id, f);
        if (o.value.capped) capped += 1;
      }
      commons = [...merged.values()];
      if (failed > 0 && failed === commonsRun.outcomes.length) {
        // With no other source to fall back on the whole query fails below, so no note is needed.
        if (mapillaryRun) notes.push(`All ${failed} Wikimedia Commons requests failed; showing Mapillary photos only`);
      } else if (failed > 0) {
        notes.push(`${failed} of ${commonsRun.outcomes.length} Wikimedia Commons requests failed, so some areas may be missing photos`);
      }
      if (commonsRun.used < commonsRun.total) {
        notes.push(`Wikimedia Commons covers only the ${commonsRun.used} of ${commonsRun.total} map squares nearest the centre; zoom in for the rest`);
      }
      if (capped > 0) {
        notes.push("Wikimedia Commons stops at 500 photos per square of about 15 km, so busy squares have more than shown");
      }
    }

    if (mapillaryRun) {
      const merged = new Map<string, PhotoFeature>();
      let failed = 0;
      let capped = 0;
      for (const o of mapillaryRun.outcomes) {
        if (!o.ok) {
          failed += 1;
          errors.push(o.error);
          continue;
        }
        for (const [id, f] of o.value.features) merged.set(id, f);
        if (o.value.capped) capped += 1;
      }
      mapillary = [...merged.values()];
      if (failed > 0 && failed === mapillaryRun.outcomes.length) {
        if (commonsRun) notes.push(`All ${failed} Mapillary requests failed (very dense areas can exceed its limits); showing Commons photos only`);
      } else if (failed > 0) {
        notes.push(`${failed} of ${mapillaryRun.outcomes.length} Mapillary requests failed (very dense areas can exceed its limits), so some areas may be missing`);
      }
      if (mapillaryRun.used < mapillaryRun.total) {
        notes.push(
          `Mapillary covers only the ${mapillaryRun.used} of ${mapillaryRun.total} small map squares nearest the centre (its API limits each request to a small area); zoom in for the rest`,
        );
      }
      if (capped > 0) {
        notes.push(`Mapillary stops at about ${MAPILLARY_LIMIT.toLocaleString("en-US")} images per square, so ${capped === 1 ? "one dense square has" : `${capped} dense squares have`} more than shown`);
      }
    }

    // Only an error when every request that was made failed; otherwise partial results are returned with notes.
    const attempted = (commonsRun?.outcomes.length ?? 0) + (mapillaryRun?.outcomes.length ?? 0);
    if (attempted > 0 && errors.length === attempted) {
      if (commonsRun && mapillaryRun) {
        const first = [commonsRun, mapillaryRun].map((run) => {
          const failure = run.outcomes.find((o) => !o.ok);
          return failure && !failure.ok ? failure.error : "unknown error";
        });
        return { error: `Both photo sources failed: ${first.join("; ")}`, hint: "upstream" };
      }
      return { error: errors[0], hint: "upstream" };
    }

    const total = commons.length + mapillary.length;
    if (total > MAX_POINTS) {
      const keepCommons = Math.min(commons.length, Math.round((MAX_POINTS * commons.length) / total));
      commons = thin(commons, keepCommons);
      mapillary = thin(mapillary, MAX_POINTS - keepCommons);
      notes.push(`Showing an evenly thinned ${MAX_POINTS.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} photos`);
    }

    const data: FeatureCollection = { type: "FeatureCollection", features: [...commons, ...mapillary] };
    const sources: string[] = [];
    if (useCommons) sources.push("Wikimedia Commons");
    if (useMapillary) sources.push("Mapillary (CC BY-SA 4.0)");

    return {
      kind: "geojson",
      data,
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
      citation: {
        source: sources.join(" and "),
        url: useCommons ? "https://commons.wikimedia.org/" : "https://www.mapillary.com/",
        retrieved: new Date().toISOString(),
      },
    };
  },
});

/** Wide mode: the photos of the best-known places in the box, from Wikidata, capped at the strategy's limit. */
async function widePhotos(ctx: QueryContext, notes: string[]): Promise<LayerResult | LayerError> {
  const limit = Math.min(WIDE_LIMIT, ctx.wideStrategy?.limit ?? WIDE_LIMIT);
  let res: Response;
  try {
    res = await wikimediaFetch(ctx.fetch, SPARQL_ENDPOINT, {
      method: "POST",
      headers: { accept: "application/sparql-results+json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ query: widePhotosQuery(ctx.bbox, limit) }).toString(),
      cacheKey: `${ctx.cacheKey ?? "photos"}:wikidata`,
    });
  } catch (err) {
    return { error: isTimeout(err) ? `Wikidata timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds; zoom in and try again` : "Wikidata returned no response", hint: "upstream" };
  }
  if (res.status === 429 || res.status === 503) return { error: "Wikidata is rate-limiting requests; try again in a minute", hint: "upstream" };
  if (!res.ok) return { error: `Wikidata returned ${res.status}`, hint: "upstream" };
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { error: "Wikidata returned a response that is not JSON", hint: "upstream" };
  }
  const features = widePhotoFeatures(json);
  if (features === null) return { error: "Wikidata returned an unexpected response", hint: "upstream" };
  const rows = (json as { results: { bindings: unknown[] } }).results.bindings.length;
  return {
    kind: "geojson",
    data: { type: "FeatureCollection", features },
    // A ranked list shorter than its limit holds every such place in the box, so run.ts can say "all".
    ...(rows < limit && { total: features.length }),
    coverageNote: [WIDE_NOTE, ...notes].join("; "),
    citation: {
      source: "Wikidata (CC0) places with a Wikimedia Commons photo (P18), ranked by Wikipedia sitelinks; photos under their own free licences",
      url: "https://commons.wikimedia.org/",
      retrieved: new Date().toISOString(),
    },
  };
}

registerLayer(photos);

export default photos;
