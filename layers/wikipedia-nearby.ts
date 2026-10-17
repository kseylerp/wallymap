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
 * Wikimedia answers 429 (plain text, not JSON) to bursts and to requests without a descriptive User-Agent; requests go through
 * layers/_shared/wikimedia.ts (one User-Agent, one retry on 429 or 503). I hit it with a handful of
 * requests a few seconds apart, so the layer keeps its request count small (area cap 1,000 km2, at most 100 articles get an extract).
 * Smoke check 2026-10-09 (live, keyless, through runLayer): South Lake Tahoe box (-120.02,38.9,-119.94,38.97) returned 23 articles in 0.7 s
 *   with extracts and thumbnails (2 extract batches; in the recorded first batch all 20 had an extract and 17 a thumbnail); a 718 km2 Tahoe box
 *   (-120.2,38.85,-119.9,39.1: 4 cells, 5 extract batches, 9 requests) returned 92 articles in 4.2 s with no rate limiting.
 * Wide mode (over 1,000 km², up to the default hard cap of 4,000 km²): geosearch can only rank by distance, so step 1 becomes one
 * Wikidata query (https://query.wikidata.org/sparql): items with coordinates in the box that have an article in the chosen
 * language, ranked by how many Wikipedia language editions cover them (wikibase:sitelinks), the best-known 500. The optimizer is
 * told to start from the box (without the hint a London box ran 54 s); a 3,000 km² London box, about the densest there is, still
 * took 15 s. Step 2 asks for extracts by title for the best-known 100.
 * Smoke wide 2026-10-14 (through runLayer): Yosemite -120,37.5,-119.3,38.05 (about 3,700 km²) returned all 282 articles in 1.6 s,
 *   Yosemite National Park first (87 languages), 98 of the top 100 with an extract; London -0.6,51.3,0.4,51.7 (about 3,100 km²) returned
 *   the 499 best-known of a full list of 500 rows in 12.7 s, London first.
 */
import { z } from "zod";
import type { Feature, Point } from "geojson";
import { defineLayer, type BBox, type CardSpec, type FieldHelp, type LayerError, type LayerResult, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { rankedSparql, wikimediaFetch } from "./_shared/wikimedia";
import { bodyHash } from "@/lib/fetch/cache";
import { layerColor } from "@/lib/render/palette";

const GEO_LIMIT = 500;
const CELL_KM = 18;
/** Most map squares asked for; a view that needs more keeps the ones nearest its centre. */
const MAX_CELLS = 64;
const KM_PER_DEG_LAT = 110.57;
const KM_PER_DEG_LON_EQUATOR = 111.32;
/** Articles that get an extract and thumbnail: the ones nearest the middle of the view. */
const MAX_ARTICLES = 100;
const EXTRACT_BATCH = 20;
const CONCURRENCY = 2;
const EXTRACT_MAX_CHARS = 420;
const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
/** Most articles a wide result carries, the best-known. */
const WIDE_LIMIT = 500;

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

/** extracts and thumbnails for up to 20 article titles (wide mode, where Wikidata gives titles, not page ids). */
export function extractsByTitleUrl(titles: string[], lang = "en"): string {
  return (
    `${apiBase(lang)}?action=query&prop=extracts|pageimages&titles=${encodeURIComponent(titles.join("|"))}` +
    `&exintro=1&explaintext=1&exsentences=2&exlimit=max&piprop=thumbnail&pithumbsize=320&pilimit=max&format=json`
  );
}

/**
 * Wide-mode SPARQL: items with coordinates in the box that have an article in `lang`, the `limit` covered by the most
 * Wikipedia language editions. `lang` is a checked 2 or 3 letter code.
 */
export function wideArticlesQuery(bbox: BBox, lang: string, limit: number): string {
  const [west, south, east, north] = bbox;
  return rankedSparql(
    `SELECT ?item ?title ?coord ?links WHERE {
  hint:Query hint:optimizer "None" .
  SERVICE wikibase:box {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point(${west} ${south})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point(${east} ${north})"^^geo:wktLiteral .
  }
  ?item wikibase:sitelinks ?links .
  ?article schema:about ?item ; schema:isPartOf <https://${lang}.wikipedia.org/> ; schema:name ?title .
}`,
    limit,
    "links",
  );
}

const sparqlSchema = z.object({
  results: z.object({
    bindings: z.array(
      z.object({
        item: z.object({ value: z.string() }),
        title: z.object({ value: z.string() }),
        coord: z.object({ value: z.string() }),
        links: z.object({ value: z.string() }).optional(),
      }),
    ),
  }),
});

/** "Point(-0.12 51.5)" -> [-0.12, 51.5]. */
function parseWkt(wkt: string): [number, number] | null {
  const m = /^Point\(\s*(-?[\d.]+(?:e-?\d+)?)\s+(-?[\d.]+(?:e-?\d+)?)\s*\)$/i.exec(wkt.trim());
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
}

/**
 * Wide hits from a SPARQL answer, best-known first, one per article (an item with two coordinates comes back twice);
 * `pageid` is a stand-in (the rank) until extracts arrive. `rows` is the raw row count, to compare with the limit.
 */
export function wideHits(json: unknown): { hits: Array<Hit & { languages: number }>; rows: number } | null {
  const parsed = sparqlSchema.safeParse(json);
  if (!parsed.success) return null;
  const seen = new Set<string>();
  const hits: Array<Hit & { languages: number }> = [];
  for (const b of parsed.data.results.bindings) {
    const title = b.title.value.trim();
    const coords = parseWkt(b.coord.value);
    if (title === "" || coords === null || seen.has(title)) continue;
    seen.add(title);
    hits.push({ pageid: -(hits.length + 1), title, lon: coords[0], lat: coords[1], languages: Number(b.links?.value ?? 0) });
  }
  return { hits, rows: parsed.data.results.bindings.length };
}

/** Squared distance from the centre of `bbox`, with longitude scaled by cos(latitude) so degrees of longitude and latitude compare. */
function distanceToCentre(bbox: BBox, lon: number, lat: number): number {
  const cx = (bbox[0] + bbox[2]) / 2;
  const cy = (bbox[1] + bbox[3]) / 2;
  const k = Math.cos((cy * Math.PI) / 180);
  return ((lon - cx) * k) ** 2 + (lat - cy) ** 2;
}

/**
 * Splits `bbox` into cells no more than CELL_KM on a side. At most MAX_CELLS are kept, nearest the centre first;
 * `total` is how many the view needed.
 */
export function cellsOf(bbox: BBox, max: number = MAX_CELLS): { cells: BBox[]; total: number } {
  const [west, south, east, north] = bbox;
  const midLatRad = (((south + north) / 2) * Math.PI) / 180;
  const lonStep = CELL_KM / (KM_PER_DEG_LON_EQUATOR * Math.max(Math.cos(midLatRad), 0.1));
  const latStep = CELL_KM / KM_PER_DEG_LAT;
  const cols = Math.max(1, Math.ceil((east - west) / lonStep - 1e-9));
  const rows = Math.max(1, Math.ceil((north - south) / latStep - 1e-9));
  const width = (east - west) / cols;
  const height = (north - south) / rows;
  let cells: BBox[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push([west + c * width, south + r * height, west + (c + 1) * width, south + (r + 1) * height]);
    }
  }
  const total = cells.length;
  if (total > max) {
    const dist = (cell: BBox) => distanceToCentre(bbox, (cell[0] + cell[2]) / 2, (cell[1] + cell[3]) / 2);
    cells = [...cells].sort((a, b) => dist(a) - dist(b)).slice(0, max);
  }
  return { cells, total };
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
          title: z.string().optional(),
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
    const res = await wikimediaFetch(ctx.fetch, url, { cacheKey });
    if (res.status === 429 || res.status === 503) return { ok: false, error: "Wikipedia is rate-limiting requests" };
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
    const properties: Record<string, string> = { name: hit.title, title: hit.title, url: articleUrl(hit.title, lang) };
    const s = summaries.get(hit.pageid);
    if (s?.extract) properties.extract = s.extract;
    if (s?.thumbnail) properties.thumbnail = s.thumbnail;
    return { type: "Feature", geometry: { type: "Point", coordinates: [hit.lon, hit.lat] }, properties };
  });
}

const HELP: Record<string, FieldHelp> = {
  languages: {
    text:
      "How many Wikipedia language editions have an article on this place (Wikidata sitelinks), a rough measure of how well known it is; " +
      "a wide view ranks places by it.",
    source: "Wikidata",
    url: "https://www.wikidata.org/",
  },
  extract: { text: "The first two sentences of the article, as Wikipedia gives them; read the article for more." },
};

const CARD: CardSpec = {
  facts: [
    { key: "extract", label: "From the article" },
    { key: "languages", label: "Wikipedia languages", format: "int" },
  ],
  /** Title is the article title, already the card heading. */
  hidden: ["title"],
  links: [
    { key: "url", label: "Read on Wikipedia" },
    { key: "thumbnail", label: "Picture" },
  ],
};

const wikipediaNearby = defineLayer({
  id: "wikipedia-nearby",
  title: "Wikipedia nearby",
  description:
    "Wikipedia articles about places, landmarks and natural features inside the view, so you can tell the user the story of a place. " +
    "Each point is one article with name and title (both the article title), url (the article), extract (the first two sentences of the article, plain text) and thumbnail (a small picture URL, when the article has one). " +
    "Use it for 'history of this place', 'what is that lake / peak / ruin / pass', 'what is notable around here', 'tell me about this area', or 'points of interest'; quote the extract and link the url rather than adding facts from memory. " +
    "Input lang picks the Wikipedia language edition (default 'en'; for example 'es' or 'fr'). " +
    "Caveats: only articles that have coordinates appear, so coverage follows how well the area is documented (towns, parks, peaks and historic sites are well covered, backcountry features often are not); " +
    "the extract is the opening of the article, not a summary of history, and some articles (lists, disambiguation) have none; the order and choice of articles is by distance, not importance. " +
    "Wikipedia text is CC BY-SA 4.0: credit Wikipedia and link the article when you reuse it. " +
"Wikipedia limits request size and rate, so the view is cut into cells of about 18 km and only the 100 articles nearest the centre get an extract. " +
    "Works worldwide. Over 1,000 km² (about a 30 km square) it returns the 500 best-known articles.",
  coverage: "global",
  surface: "any",
  license: "CC BY-SA 4.0 (Wikipedia contributors)",
  requiredEnv: [],
  maxAreaKm2: 1_000,
  wide: { mode: "named", orderBy: "number of Wikipedia languages", limit: WIDE_LIMIT },
  input: inputSchema,
  style: { geometry: "point", color: layerColor("wikipedia-nearby"), cluster: true },
  fieldHelp: HELP,
  card: CARD,

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const { lang } = input;
    const base = ctx.cacheKey ?? "wikipedia-nearby";
    const notes: string[] = [];

    let hits: Hit[];
    let failures: { ok: false; error: string }[] = [];
    /** Wide only: the whole ranked list came back, so it is every article in the box. */
    let wideComplete = false;
    if (ctx.wide) {
      // Wide step 1: the best-known articles in the box from Wikidata, capped at the strategy's limit.
      const limit = Math.min(WIDE_LIMIT, ctx.wideStrategy?.limit ?? WIDE_LIMIT);
      let res: Response;
      try {
        res = await wikimediaFetch(ctx.fetch, SPARQL_ENDPOINT, {
          method: "POST",
          headers: { accept: "application/sparql-results+json", "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ query: wideArticlesQuery(ctx.bbox, lang, limit) }).toString(),
          cacheKey: `${base}:wikidata`,
        });
      } catch (err) {
        return {
          error: isTimeout(err) ? `Wikidata timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds; zoom in and try again` : "Wikidata returned no response",
          hint: "upstream",
        };
      }
      if (res.status === 429 || res.status === 503) return { error: "Wikidata is rate-limiting requests; try again in a minute", hint: "upstream" };
      if (!res.ok) return { error: `Wikidata returned ${res.status}`, hint: "upstream" };
      let ranked: ReturnType<typeof wideHits>;
      try {
        ranked = wideHits(await res.json());
      } catch {
        ranked = null;
      }
      if (ranked === null) return { error: "Wikidata returned an unexpected response", hint: "upstream" };
      hits = ranked.hits;
      wideComplete = ranked.rows < limit;
      if (hits.length > MAX_ARTICLES) notes.push(`only the ${MAX_ARTICLES} best-known have an extract`);
    } else {
      // Step 1: which articles lie in the view.
      const { cells, total: totalCells } = cellsOf(ctx.bbox);
      if (totalCells > cells.length) {
        notes.push(`Only the ${cells.length} of ${totalCells} map squares nearest the centre were searched; zoom in for the rest`);
      }
      const geo = await pool(cells, CONCURRENCY, async (cell): Promise<Outcome<Hit[]>> => {
        const r = await wikiJson(ctx, geosearchUrl(cell, lang), `${base}:geo:${cell.map((n) => n.toFixed(4)).join(",")}`);
        if (!r.ok) return r;
        const parsed = geoPageSchema.safeParse(r.value);
        if (!parsed.success) return { ok: false, error: "Wikipedia returned an unexpected response" };
        if (parsed.data.error) return { ok: false, error: `Wikipedia error: ${parsed.data.error.code ?? "unknown"}` };
        return { ok: true, value: parsed.data.query?.geosearch ?? [] };
      });

      failures = geo.filter((g): g is { ok: false; error: string } => !g.ok);
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
      hits = [...byId.values()];
      if (hits.length > MAX_ARTICLES) {
        hits = hits
          .sort((a, b) => distanceToCentre(ctx.bbox, a.lon, a.lat) - distanceToCentre(ctx.bbox, b.lon, b.lat))
          .slice(0, MAX_ARTICLES);
        notes.push(`Showing the ${MAX_ARTICLES} of ${byId.size} articles nearest the centre; zoom in for the rest`);
      }
    }

    // Step 2: extract and thumbnail, 20 pages per request.
    // Wide hits carry titles (their pageid is a stand-in), so they are asked for by title and matched back by title.
    const summaries = new Map<number, Summary>();
    const batches: Hit[][] = [];
    const described = hits.slice(0, MAX_ARTICLES);
    for (let i = 0; i < described.length; i += EXTRACT_BATCH) batches.push(described.slice(i, i + EXTRACT_BATCH));
    const extractRuns = await pool(batches, CONCURRENCY, async (batch): Promise<Outcome<null>> => {
      const keys = ctx.wide ? batch.map((h) => h.title) : batch.map((h) => h.pageid);
      const url = ctx.wide ? extractsByTitleUrl(keys as string[], lang) : extractsUrl(keys as number[], lang);
      const r = await wikiJson(ctx, url, `${base}:ex:${bodyHash(keys.join("|"))}`);
      if (!r.ok) return r;
      const parsed = extractPageSchema.safeParse(r.value);
      if (!parsed.success || parsed.data.error) return { ok: false, error: "Wikipedia returned an unexpected response" };
      const byTitle = new Map(batch.map((h) => [h.title, h.pageid]));
      for (const page of Object.values(parsed.data.query?.pages ?? {})) {
        const id = ctx.wide ? (page.title === undefined ? undefined : byTitle.get(page.title)) : page.pageid;
        if (id === undefined) continue;
        const summary: Summary = {};
        const extract = page.extract ? cleanExtract(page.extract) : "";
        if (extract) summary.extract = extract;
        if (page.thumbnail?.source) summary.thumbnail = page.thumbnail.source;
        summaries.set(id, summary);
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
    // Wide features say how many Wikipedia language editions cover them, the number they are ranked by.
    hits.forEach((hit, i) => {
      if ("languages" in hit && typeof hit.languages === "number" && features[i].properties) features[i].properties.languages = hit.languages;
    });
    if (features.length === 0 && failures.length === 0) notes.push("No Wikipedia articles with coordinates in this area");

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      // A ranked list shorter than its limit holds every article in the box, so run.ts can say "all".
      ...(wideComplete && { total: features.length }),
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
