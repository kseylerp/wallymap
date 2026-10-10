/**
 * Wikipedia articles about places inside the view, from the MediaWiki Action API (keyless, CC BY-SA 4.0).
 * Two steps, both on https://<lang>.wikipedia.org/w/api.php (default en):
 *   1. list=geosearch: action=query&list=geosearch&gsbbox=<north>|<west>|<south>|<east>&gsnamespace=0&gslimit=500&format=json
 *      Response: { query: { geosearch: [{ pageid, ns, title, lat, lon, dist, primary }] } }. gsbbox order is top|left|bottom|right.
 *      The API answers HTTP 200 with { error: { code: "toobig" } } when the box is more than about 20 km on a side (a 22 km box passed,
 *      a 24 km box failed), so the view is cut into cells of at most 18 km.
 *   2. prop=extracts|pageimages for those pageids: exintro=1&explaintext=1&exsentences=2&exlimit=max&piprop=thumbnail&pithumbsize=320&pilimit=max.
 *      Response: { query: { pages: { <id>: { pageid, title, extract?, thumbnail?: { source, width, height } } } }, limits: { extracts: 20, pageimages: 50 } }.
 *      `extracts` is capped at 20 pages per request, so pageids go in batches of 20.
 * Wikimedia answers 429 (plain text, not JSON) to bursts and to requests without a descriptive User-Agent; I hit it with a handful of
 * requests a few seconds apart, so the layer keeps its request count small (area cap 1,000 km2, at most 100 articles get an extract).
 * Smoke check 2026-10-09 (live, keyless, through runLayer): South Lake Tahoe box (-120.02,38.9,-119.94,38.97) returned 23 articles in 0.7 s
 *   with extracts and thumbnails (2 extract batches; in the recorded first batch all 20 had an extract and 17 a thumbnail); a 718 km2 Tahoe box
 *   (-120.2,38.85,-119.9,39.1: 4 cells, 5 extract batches, 9 requests) returned 92 articles in 4.2 s with no rate limiting.
 */
import { z } from "zod";
import type { Feature, Point } from "geojson";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { bodyHash } from "@/lib/fetch/cache";
import { layerColor } from "@/lib/render/palette";

const USER_AGENT = "WildMap/0.1 (open-source outdoor map agent)";
const GEO_LIMIT = 500;
const CELL_KM = 18;
const KM_PER_DEG_LAT = 110.57;
const KM_PER_DEG_LON_EQUATOR = 111.32;
/** Articles that get an extract and thumbnail: the ones nearest the middle of the view. */
const MAX_ARTICLES = 100;
const EXTRACT_BATCH = 20;
const CONCURRENCY = 2;
const EXTRACT_MAX_CHARS = 420;

const inputSchema = z.object({
  /** Wikipedia language edition, for example "es" or "fr"; defaults to English. */
  lang: z
    .string()
    .regex(/^[a-z]{2,3}$/, "lang must be a 2 or 3 letter Wikipedia language code such as en or fr")
    .default("en"),
});

function apiBase(lang: string): string {
  return `https://${lang}.wikipedia.org/w/api.php`;
}

/** geosearch URL; gsbbox order is north|west|south|east. */
export function geosearchUrl(bbox: BBox, lang = "en"): string {
  const [west, south, east, north] = bbox;
  return (
    `${apiBase(lang)}?action=query&list=geosearch&gsbbox=${north}|${west}|${south}|${east}` +
    `&gsnamespace=0&gslimit=${GEO_LIMIT}&format=json`
  );
}

/** extracts and thumbnails for up to 20 page ids. */
export function extractsUrl(pageIds: number[], lang = "en"): string {
  return (
    `${apiBase(lang)}?action=query&prop=extracts|pageimages&pageids=${pageIds.join("|")}` +
    `&exintro=1&explaintext=1&exsentences=2&exlimit=max&piprop=thumbnail&pithumbsize=320&pilimit=max&format=json`
  );
}

/** Splits `bbox` into cells no more than CELL_KM on a side. */
export function cellsOf(bbox: BBox): BBox[] {
  const [west, south, east, north] = bbox;
  const midLatRad = (((south + north) / 2) * Math.PI) / 180;
  const lonStep = CELL_KM / (KM_PER_DEG_LON_EQUATOR * Math.max(Math.cos(midLatRad), 0.1));
  const latStep = CELL_KM / KM_PER_DEG_LAT;
  const cols = Math.max(1, Math.ceil((east - west) / lonStep - 1e-9));
  const rows = Math.max(1, Math.ceil((north - south) / latStep - 1e-9));
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

const geoPageSchema = z.object({
  query: z
    .object({
      geosearch: z.array(z.object({ pageid: z.number(), title: z.string(), lat: z.number(), lon: z.number() })),
    })
    .optional(),
  error: z.object({ code: z.string().optional() }).optional(),
});

const extractPageSchema = z.object({
  query: z
    .object({
      pages: z.record(
        z.string(),
        z.object({
          pageid: z.number().optional(),
          extract: z.string().nullable().optional(),
          thumbnail: z.object({ source: z.string() }).optional(),
        }),
      ),
    })
    .optional(),
  error: z.object({ code: z.string().optional() }).optional(),
});

type Hit = { pageid: number; title: string; lat: number; lon: number };
type Summary = { extract?: string; thumbnail?: string };
type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

function isTimeout(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
}

/** Runs `worker` over `items` with at most `limit` in flight, keeping result order. */
async function pool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
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

/** Fetches one Wikipedia API URL and returns parsed JSON, or a short plain-words failure. */
async function wikiJson(ctx: QueryContext, url: string, cacheKey: string | undefined): Promise<Outcome<unknown>> {
  try {
    const res = await ctx.fetch(url, {
      cacheKey,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { "user-agent": USER_AGENT },
    });
    if (res.status === 429) return { ok: false, error: "Wikipedia is rate-limiting requests" };
    if (!res.ok) return { ok: false, error: `Wikipedia returned ${res.status}` };
    try {
      return { ok: true, value: await res.json() };
    } catch {
      return { ok: false, error: "Wikipedia returned a response that is not JSON" };
    }
  } catch (err) {
    return { ok: false, error: isTimeout(err) ? `Wikipedia timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds` : "Wikipedia returned no response" };
  }
}

/** Article text without the empty brackets that stripped pronunciations leave behind. */
export function cleanExtract(text: string): string {
  const t = text
    .replace(/\(\s*[,;\s]*\)/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
  return t.length > EXTRACT_MAX_CHARS ? `${t.slice(0, EXTRACT_MAX_CHARS - 1).trimEnd()}…` : t;
}

export function articleUrl(title: string, lang = "en"): string {
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_")).replace(/%2F/g, "/").replace(/%3A/g, ":")}`;
}

/** Points with title, url and, when known, extract and thumbnail. */
export function buildFeatures(hits: Hit[], summaries: Map<number, Summary>, lang = "en"): Feature<Point>[] {
  return hits.map((hit) => {
    const properties: Record<string, string> = { title: hit.title, url: articleUrl(hit.title, lang) };
    const s = summaries.get(hit.pageid);
    if (s?.extract) properties.extract = s.extract;
    if (s?.thumbnail) properties.thumbnail = s.thumbnail;
    return { type: "Feature", geometry: { type: "Point", coordinates: [hit.lon, hit.lat] }, properties };
  });
}

const wikipediaNearby = defineLayer({
  id: "wikipedia-nearby",
  title: "Wikipedia nearby",
  description:
    "Wikipedia articles about places, landmarks and natural features inside the view, so you can tell the user the story of a place. " +
    "Each point is one article with title, url (the article), extract (the first two sentences of the article, plain text) and thumbnail (a small picture URL, when the article has one). " +
    "Use it for 'history of this place', 'what is that lake / peak / ruin / pass', 'what is notable around here', 'tell me about this area', or 'points of interest'; quote the extract and link the url rather than adding facts from memory. " +
    "Input lang picks the Wikipedia language edition (default 'en'; for example 'es' or 'fr'). " +
    "Caveats: only articles that have coordinates appear, so coverage follows how well the area is documented (towns, parks, peaks and historic sites are well covered, backcountry features often are not); " +
    "the extract is the opening of the article, not a summary of history, and some articles (lists, disambiguation) have none; the order and choice of articles is by distance, not importance. " +
    "Wikipedia text is CC BY-SA 4.0: credit Wikipedia and link the article when you reuse it. " +
    "Wikipedia limits request size and rate, so the view is cut into cells of about 18 km and only the 100 articles nearest the centre get an extract; the result says when that applies. " +
    "Works worldwide. Zoom in to a region under 1,000 km² (about a 30 km square) first.",
  coverage: "global",
  license: "CC BY-SA 4.0 (Wikipedia contributors)",
  requiredEnv: [],
  maxAreaKm2: 1_000,
  input: inputSchema,
  style: { geometry: "point", color: layerColor("wikipedia-nearby"), cluster: true },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const area = bboxAreaKm2(ctx.bbox);
    if (area > wikipediaNearby.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${wikipediaNearby.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }
    const { lang } = input;
    const base = ctx.cacheKey ?? "wikipedia-nearby";
    const notes: string[] = [];

    // Step 1: which articles lie in the view.
    const cells = cellsOf(ctx.bbox);
    const geo = await pool(cells, CONCURRENCY, async (cell): Promise<Outcome<Hit[]>> => {
      const r = await wikiJson(ctx, geosearchUrl(cell, lang), `${base}:geo:${cell.map((n) => n.toFixed(4)).join(",")}`);
      if (!r.ok) return r;
      const parsed = geoPageSchema.safeParse(r.value);
      if (!parsed.success) return { ok: false, error: "Wikipedia returned an unexpected response" };
      if (parsed.data.error) return { ok: false, error: `Wikipedia error: ${parsed.data.error.code ?? "unknown"}` };
      return { ok: true, value: parsed.data.query?.geosearch ?? [] };
    });

    const failures = geo.filter((g): g is { ok: false; error: string } => !g.ok);
    if (failures.length === geo.length) return { error: failures[0].error, hint: "upstream" };
    if (failures.length > 0) {
      notes.push(`${failures.length} of ${geo.length} map squares could not be loaded (${failures[0].error}), so some articles may be missing`);
    }

    const byId = new Map<number, Hit>();
    let capped = false;
    for (const g of geo) {
      if (!g.ok) continue;
      if (g.value.length >= GEO_LIMIT) capped = true;
      for (const hit of g.value) byId.set(hit.pageid, hit);
    }
    if (capped) notes.push("Wikipedia stops at 500 articles per map square, so very dense squares have more than shown");

    // Keep the articles nearest the centre of the view when there are too many to fetch extracts for.
    const cx = (ctx.bbox[0] + ctx.bbox[2]) / 2;
    const cy = (ctx.bbox[1] + ctx.bbox[3]) / 2;
    let hits = [...byId.values()];
    if (hits.length > MAX_ARTICLES) {
      hits = hits
        .sort((a, b) => (a.lon - cx) ** 2 + (a.lat - cy) ** 2 - ((b.lon - cx) ** 2 + (b.lat - cy) ** 2))
        .slice(0, MAX_ARTICLES);
      notes.push(`Showing the ${MAX_ARTICLES} of ${byId.size} articles nearest the centre; zoom in for the rest`);
    }

    // Step 2: extract and thumbnail, 20 pages per request.
    const summaries = new Map<number, Summary>();
    const batches: Hit[][] = [];
    for (let i = 0; i < hits.length; i += EXTRACT_BATCH) batches.push(hits.slice(i, i + EXTRACT_BATCH));
    const extractRuns = await pool(batches, CONCURRENCY, async (batch): Promise<Outcome<null>> => {
      const ids = batch.map((h) => h.pageid);
      const r = await wikiJson(ctx, extractsUrl(ids, lang), `${base}:ex:${bodyHash(ids.join("|"))}`);
      if (!r.ok) return r;
      const parsed = extractPageSchema.safeParse(r.value);
      if (!parsed.success || parsed.data.error) return { ok: false, error: "Wikipedia returned an unexpected response" };
      for (const page of Object.values(parsed.data.query?.pages ?? {})) {
        if (page.pageid === undefined) continue;
        const summary: Summary = {};
        const extract = page.extract ? cleanExtract(page.extract) : "";
        if (extract) summary.extract = extract;
        if (page.thumbnail?.source) summary.thumbnail = page.thumbnail.source;
        summaries.set(page.pageid, summary);
      }
      return { ok: true, value: null };
    });
    const extractFailures = extractRuns.filter((e): e is { ok: false; error: string } => !e.ok);
    if (extractFailures.length > 0) {
      notes.push(
        `${extractFailures.length === batches.length ? "Article" : "Some article"} summaries could not be loaded (${extractFailures[0].error}), so those points have a title and link only`,
      );
    }

    const features = buildFeatures(hits, summaries, lang);
    if (features.length === 0 && failures.length === 0) notes.push("No Wikipedia articles with coordinates in this area");

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation: {
        source: `Wikipedia (${lang}), CC BY-SA 4.0, article openings by Wikipedia contributors`,
        url: `https://${lang}.wikipedia.org/`,
        retrieved: new Date().toISOString(),
      },
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(wikipediaNearby);

export default wikipediaNearby;
